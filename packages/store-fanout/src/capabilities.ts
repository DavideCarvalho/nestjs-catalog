import type { CatalogStoreCapabilities } from '@dudousxd/nestjs-catalog';
import type { AssertNothingMissing, OptionalKeyOf } from './exhaustive';

/**
 * How the fan-out's capabilities are composed, and why it is the intersection.
 *
 * The tempting answer is "the primary's", since the primary answers every
 * ordinary read. It is wrong twice over.
 *
 * The first reason is local and immediate: this store offers a second read path.
 * `readFrom(name, ...)` reads a named follower, because verifying a follower
 * before trusting it is the only way anybody ever flips a primary with a
 * straight face. A capability object that advertises `timeTravel: true` while
 * `readFrom("clickhouse", { snapshot: X })` cannot honour it is a store lying
 * about its own API, and the caller finds out by getting current data labelled
 * as history — the worst possible way to find out.
 *
 * The second reason is the whole purpose of the configuration. A follower exists
 * here in order to become the primary. If the composed capabilities tracked the
 * primary, the flip would be the moment history silently disappears — and the
 * flip is precisely when the old store is about to be dropped and the fallback
 * about to be gone. Intersecting instead pays that cost up front, on the day the
 * follower is attached, while the old store is still there and the change can
 * still be reversed by removing one line of configuration. A capability that
 * degrades when you *add* a store is a surprise; a capability that degrades when
 * you flip to it is an outage.
 *
 * The engines really do differ, so this is not hypothetical. ClickHouse's
 * ReplacingMergeTree collapses old versions rather than keeping them, and DuckDB
 * has no time travel at all — both of them still *emulate* snapshots the way the
 * MikroORM store does, by tagging rows with a snapshot id, but an adapter that
 * declares otherwise is declaring what it can serve, and this is where that
 * declaration is taken at its word.
 *
 * The remedy for a degraded capability is never to weaken the report. It is
 * either to not attach a store that cannot hold what this catalog promises, or
 * to accept the promise being smaller. {@link explainCapabilities} exists so the
 * operator is told which follower cost them what, at boot, instead of
 * discovering that the snapshot picker vanished and having nothing to blame.
 *
 * ## The three atomicity fields, which are intersected for a nearer reason
 *
 * `atomicCutover`, `atomicBatchReplace` and `transactional` are optional on the
 * contract, and the core package is explicit that an absent one means *not
 * stated* and has to be read as false. They were dropped from this composition
 * once, which meant a fan-out over two adapters that both declare them reported
 * all three as absent — and since absent reads as false, a caller doing the
 * right thing got the pessimistic answer with no follower to blame for it.
 *
 * They are intersected, but not for the "the follower will become the primary"
 * reason above. That reason applies and it is the weaker one. The immediate one
 * is that a write through this store is *not one store's write*: `write()` lands
 * a batch on the primary and then on every follower, and `commit()` publishes on
 * the primary and then on every follower. So whether a re-sent batch has a
 * window in which neither copy is present is answered by the worst of them, and
 * whether a crash part-way through can leave a state no single statement
 * produced is answered by the worst of them plus the gap between the calls. A
 * caller writing recovery logic against this store is writing it against all of
 * them at once, today, before any flip.
 *
 * **Three values, not two.** The intersection has to keep *not stated* apart
 * from *stated false*, because turning one into the other is the exact mistake
 * the core package's docblock warns about: once "nobody measured this" is
 * written down as `false` it is indistinguishable from "measured, and it does
 * not hold", and the next person to compose these has no way back. So a field is
 * `true` only when every store says true; `false` when at least one store
 * measured a false, which is the strongest negative available; and otherwise
 * absent, which is what "one of these stores never said" honestly is. A caller
 * reading absent as false — which the contract requires — gets the same
 * behaviour from the last two, and gets to see the difference if it cares.
 */

/** Weakest to strongest. Nothing outside this list is a snapshot mode. */
const SNAPSHOT_RANK: Array<CatalogStoreCapabilities['snapshots']> = ['none', 'emulated', 'native'];

function rankOf(mode: CatalogStoreCapabilities['snapshots']): number {
  const index = SNAPSHOT_RANK.indexOf(mode);
  // An unrecognised value is treated as the weakest rather than the strongest.
  // An adapter from a newer version of the ecosystem declaring a mode this
  // package has never heard of must not thereby be credited with keeping
  // history it may not keep.
  return index === -1 ? 0 : index;
}

export interface NamedCapabilities {
  name: string;
  capabilities: CatalogStoreCapabilities;
}

/**
 * The optional capability fields, and what each one costs when it is lost.
 *
 * One list rather than three intersections written out by hand, so that a field
 * cannot be composed and left out of the explanation, or explained and left out
 * of the composition — which is the pair of mistakes that made all three of them
 * invisible in the first place. The sentence is the operator-facing half and
 * lives beside the field for the same reason.
 */
const ATOMICITY_FIELDS = [
  {
    key: 'atomicCutover',
    label: 'Atomic cutover',
    consequence:
      'A read issued while this catalog publishes a snapshot may fail outright rather than return the old snapshot or the new one.',
  },
  {
    key: 'atomicBatchReplace',
    label: 'Atomic batch replace',
    consequence:
      'A batch re-sent into a snapshot that is already live has a window in which neither the old rows nor the new ones are present — which is what a durable run retrying after a successful commit does.',
  },
  {
    key: 'transactional',
    label: 'Transactional operations',
    consequence:
      'A crash part-way through a load can leave a state no single statement produced, so the repair is to re-run the operation rather than to expect a rollback that never happened.',
  },
] as const satisfies ReadonlyArray<{
  key: OptionalKeyOf<CatalogStoreCapabilities>;
  label: string;
  consequence: string;
}>;

/**
 * Fails to compile when the contract grows an optional capability field that is
 * not composed here — which is how all three of the current ones were lost.
 */
type _EveryOptionalCapabilityIsComposed = AssertNothingMissing<
  Exclude<OptionalKeyOf<CatalogStoreCapabilities>, (typeof ATOMICITY_FIELDS)[number]['key']>
>;

/**
 * The three-valued intersection described at the top of this file: true only if
 * everyone says true, false if anyone measured false, otherwise not stated.
 */
function intersectStated(values: Array<boolean | undefined>): boolean | undefined {
  if (values.some((value) => value === false)) return false;
  if (values.some((value) => value === undefined)) return undefined;
  return true;
}

export function composeCapabilities(
  primary: NamedCapabilities,
  followers: NamedCapabilities[],
): CatalogStoreCapabilities {
  let snapshots = primary.capabilities.snapshots;
  let timeTravel = primary.capabilities.timeTravel;

  for (const follower of followers) {
    if (rankOf(follower.capabilities.snapshots) < rankOf(snapshots)) {
      snapshots = follower.capabilities.snapshots;
    }
    timeTravel = timeTravel && follower.capabilities.timeTravel;
  }

  const composed: CatalogStoreCapabilities = {
    snapshots,
    // Not intersected, and the asymmetry is deliberate. `writable` says whether
    // this store accepts loads, and this store accepts loads exactly when the
    // primary does — a follower that could not be written to would have been
    // refused at construction, since a store that cannot receive the data is not
    // a migration target. So there is nothing here to weaken.
    writable: primary.capabilities.writable,
    timeTravel,
  };

  for (const field of ATOMICITY_FIELDS) {
    const stated = intersectStated(statedBy(primary, followers, field.key));
    // Assigned only when somebody stated it. Writing `undefined` into the key
    // would be a different claim from leaving it off under
    // `exactOptionalPropertyTypes`, and "the key is not there" is precisely the
    // shape the contract gives to "not stated".
    if (stated !== undefined) composed[field.key] = stated;
  }

  return composed;
}

/** What every store in this fan-out says about one optional field, primary first. */
function statedBy(
  primary: NamedCapabilities,
  followers: NamedCapabilities[],
  key: OptionalKeyOf<CatalogStoreCapabilities>,
): Array<boolean | undefined> {
  return [primary.capabilities[key], ...followers.map((follower) => follower.capabilities[key])];
}

/**
 * One sentence per capability the followers cost, for the boot log.
 *
 * Empty when nothing was lost, so the caller logs nothing on the happy path.
 */
export function explainCapabilities(
  primary: NamedCapabilities,
  followers: NamedCapabilities[],
  composed: CatalogStoreCapabilities,
): string[] {
  const reasons: string[] = [];

  if (composed.snapshots !== primary.capabilities.snapshots) {
    const blamed = followers
      .filter(
        (follower) =>
          rankOf(follower.capabilities.snapshots) < rankOf(primary.capabilities.snapshots),
      )
      .map((follower) => `${follower.name} (${follower.capabilities.snapshots})`);
    reasons.push(
      `Snapshots report as "${composed.snapshots}" rather than the primary's "${primary.capabilities.snapshots}" because ${blamed.join(', ')} cannot hold history the way ${primary.name} does. Reads still come from ${primary.name}; the report is what this configuration can promise once ${blamed.length === 1 ? 'that store becomes' : 'those stores become'} the primary.`,
    );
  }

  if (!composed.timeTravel && primary.capabilities.timeTravel) {
    const blamed = followers
      .filter((follower) => !follower.capabilities.timeTravel)
      .map((follower) => follower.name);
    reasons.push(
      `Time travel reports as unavailable even though ${primary.name} supports it, because ${blamed.join(', ')} cannot read an old snapshot. A snapshot picker offered here would work today and stop working the moment the primary is flipped, and it cannot be used to verify ${blamed.join(', ')} in the meantime.`,
    );
  }

  for (const field of ATOMICITY_FIELDS) {
    // Only when the primary claimed it and the fan-out cannot. A field the
    // primary never stated is not something a follower took away, and reporting
    // it here would fill the boot log of every deployment whose adapters predate
    // these fields with warnings about nothing.
    if (primary.capabilities[field.key] !== true) continue;
    if (composed[field.key] === true) continue;

    const blamed = followers
      .filter((follower) => follower.capabilities[field.key] !== true)
      .map((follower) =>
        follower.capabilities[field.key] === false
          ? `${follower.name} (declares it does not)`
          : `${follower.name} (does not say)`,
      );
    reasons.push(
      `${field.label} reports as ${composed[field.key] === false ? 'unavailable' : 'not stated'} even though ${primary.name} declares it, because a load here lands on ${blamed.join(', ')} as well. ${field.consequence} The composed answer is what a caller writing recovery logic against this catalog has to read, and it is about the fan-out as it stands today rather than about the store it may become.`,
    );
  }

  return reasons;
}
