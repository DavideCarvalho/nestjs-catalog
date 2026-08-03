import type { CatalogStoreCapabilities } from '@dudousxd/nestjs-catalog';

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

  return {
    snapshots,
    // Not intersected, and the asymmetry is deliberate. `writable` says whether
    // this store accepts loads, and this store accepts loads exactly when the
    // primary does — a follower that could not be written to would have been
    // refused at construction, since a store that cannot receive the data is not
    // a migration target. So there is nothing here to weaken.
    writable: primary.capabilities.writable,
    timeTravel,
  };
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

  return reasons;
}
