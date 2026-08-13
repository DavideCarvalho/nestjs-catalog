import type {
  CarryForwardResult,
  CatalogFilterOperator,
  CatalogMergeStore,
  CatalogObjectTypeDef,
  CatalogQueryRelation,
  CatalogQueryRequest,
  CatalogQueryResult,
  CatalogQueryStore,
  CatalogQueryStreamRequest,
  CatalogReadQuery,
  CatalogReadResult,
  CatalogReadStore,
  CatalogStoreCapabilities,
  CatalogWriteStore,
  SnapshotRef,
} from '@dudousxd/nestjs-catalog';
import {
  isCatalogStoreCapabilities,
  isQueryStore,
  isStreamingQueryStore,
  isWriteStore,
  supportsCarryForward,
  supportsObjectFilters,
} from '@dudousxd/nestjs-catalog';
import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { composeCapabilities, explainCapabilities } from './capabilities';
import { emitFanout } from './events';
import type { AssertNothingMissing, OptionalKeyOf } from './exhaustive';
import {
  type CatalogFanoutJournal,
  FANOUT_SCHEMA_SCOPE,
  type FanoutJournalEntry,
  type FanoutStage,
  fanoutEntryKey,
} from './journal';
import {
  CATALOG_FANOUT_FOLLOWERS,
  CATALOG_FANOUT_JOURNAL,
  CATALOG_FANOUT_PRIMARY,
  type FollowerStrictness,
} from './options';

/**
 * One store that writes to several, so a catalog can move between engines
 * without a big-bang cutover.
 *
 * ## The asymmetry, which is the whole design
 *
 * Writing to two stores cannot be symmetric. There is no distributed
 * transaction available across a MySQL schema and a ClickHouse cluster, so a
 * load that commits on one and fails on the other leaves two databases that
 * disagree — and if both are authoritative, nothing in the system is entitled to
 * say which of them is right. Two disagreeing databases with no arbiter are
 * strictly worse than one database, because the wrong answer now has a second
 * source to be confirmed by.
 *
 * So exactly one store is the **primary**. Its commit is what decides whether a
 * load happened, and every ordinary read comes from it. The rest are
 * **followers**: they are kept in step, their failures are written down, and
 * nothing routes a read to them. Reading from "whichever answers" is how a
 * system acquires results that change between requests and bug reports that
 * cannot be reproduced.
 *
 * The one deliberate exception is {@link readFrom}, which reads a *named*
 * follower. It is opt-in, explicit at the call site, and it exists because the
 * only responsible way to make a follower the primary is to have looked at what
 * it holds first.
 *
 * ## Why this is safer than a dual write usually is
 *
 * A row-level dual write has no recovery: the row that failed on one side is
 * gone unless the source is re-read, and by then the source has moved. Loads
 * here are snapshot-scoped and append-only — rows are written under a snapshot
 * id in numbered batches, a retried batch replaces itself rather than appending,
 * and a separate commit is what makes the snapshot visible. That means a
 * snapshot which failed on a follower is still sitting on the primary, addressed
 * by its id, complete and immutable. It can be replayed to the follower from the
 * primary, with no source involved and nothing recomputed. See
 * {@link import('./migration').CatalogFanoutMigration.replay}.
 *
 * ## The ordering rule, which explains every sequence below
 *
 * **At every intermediate point, the primary is ahead of or equal to the
 * followers.** Creation goes primary-first; deletion goes followers-first. Both
 * follow from the same rule, and the rule is chosen because "the follower is
 * behind" is the ordinary, expected, repairable state — it is what a replay
 * fixes — whereas "the follower holds something the primary never blessed" is a
 * state with no owner and no procedure.
 */

export interface FanoutPrimary {
  readonly name: string;
  readonly store: CatalogWriteStore;
}

export interface FanoutFollower {
  readonly name: string;
  readonly store: CatalogWriteStore;
  readonly strictness: FollowerStrictness;
}

/** One follower's failure of one step, as thrown. */
export interface FanoutFailure {
  follower: string;
  stage: FanoutStage;
  batch?: number;
  error: string;
}

/**
 * Thrown when a `required` follower could not be kept in step.
 *
 * Not an `HttpException`: the caller here is a loader, not a request handler,
 * and a 400 rendered into a durable workflow's error field says nothing useful.
 * Configuration mistakes — an unknown follower name, a store that cannot be
 * written to — still throw `BadRequestException`, because those genuinely are
 * the caller getting it wrong.
 */
export class CatalogFanoutError extends Error {
  constructor(
    message: string,
    readonly failures: FanoutFailure[],
  ) {
    super(message);
    this.name = 'CatalogFanoutError';
  }
}

@Injectable()
export class FanoutCatalogStore implements CatalogWriteStore {
  private readonly logger = new Logger(FanoutCatalogStore.name);

  readonly capabilities: CatalogStoreCapabilities;

  /**
   * Declared, never defined on the prototype, and assigned in the constructor
   * only when the primary actually offers the method.
   *
   * This is load-bearing rather than tidy. The core package asks whether a store
   * can do these things by looking for the method — `supportsCarryForward` uses
   * `"carryForward" in store`, `isQueryStore` reads the property — so a fan-out
   * that always carried the methods would answer yes on behalf of a primary that
   * cannot, and the refusal that should have happened at the connector would
   * instead surface as an engine error somewhere underneath. `declare` emits no
   * field, so an unassigned one is genuinely absent rather than present and
   * undefined; a plain optional field would be an own property and `in` would
   * find it.
   *
   * **The list is the hazard.** Every entry here is a method some other package
   * probes structurally, and the failure of leaving one out is silent in exactly
   * the same way in both directions: a caller asks, gets no, and takes the
   * fallback path. `currentSnapshot` was missing from this list for as long as it
   * has existed, so a MySQL primary behind a fan-out reported that it could not
   * say which snapshot it was serving, and the replay fell back to guessing the
   * newest — the failure the core package spells out as "not survivable". So the
   * list is checked against the interfaces by {@link PROBED_STORE_METHODS} and
   * the assertions under it, and adding an optional member to `CatalogWriteStore`
   * now stops this package compiling until somebody has decided what to do.
   */
  declare readonly listSnapshots?: (type: CatalogObjectTypeDef) => Promise<SnapshotRef[]>;
  declare readonly listSnapshotsWithRows?: (
    type: CatalogObjectTypeDef,
    limit?: number,
  ) => Promise<SnapshotRef[]>;
  declare readonly findSnapshot?: (
    type: CatalogObjectTypeDef,
    snapshotId: string,
  ) => Promise<SnapshotRef | undefined>;
  declare readonly currentSnapshot?: (
    type: CatalogObjectTypeDef,
  ) => Promise<SnapshotRef | undefined>;
  declare readonly carryForward?: CatalogMergeStore['carryForward'];
  declare readonly runQuery?: (request: CatalogQueryRequest) => Promise<CatalogQueryResult>;
  declare readonly queryRelations?: () => Promise<CatalogQueryRelation[]>;
  declare readonly streamQuery?: (
    request: CatalogQueryStreamRequest,
  ) => AsyncIterable<Record<string, unknown>>;

  /**
   * Which operators the primary can push into its predicate — and therefore
   * which this store can, since {@link read} is the primary's `read`.
   *
   * `declare` for the same reason every field above it is: `supportsObjectFilters`
   * asks by looking for the property, so a fan-out that always carried it would
   * answer yes on behalf of a primary that cannot filter, and the service would
   * hand that primary a filter it silently ignores — a screen presenting the whole
   * table as though it were the matching rows. Absent when the primary declares
   * nothing, which makes the fan-out unfilterable in exactly the cases its primary
   * is.
   *
   * **Not intersected with the followers**, unlike the capability object one file
   * over, and the difference is not an inconsistency. Capabilities are intersected
   * because they are a single answer covering both read paths and there is no
   * per-store question to ask; filtering has one — the operators are read off
   * whichever store is in hand — so {@link readFrom} asks the follower it is about
   * to read instead of degrading the ordinary read path to protect a verification
   * path that can check for itself. Intersecting here would mean attaching a
   * follower that cannot filter silently removes the filter controls from a
   * catalog whose primary filters perfectly well, which is a capability lost for
   * nothing: no ordinary read ever reaches that follower.
   */
  declare readonly objectFilterOperators?: readonly CatalogFilterOperator[];

  constructor(
    @Inject(CATALOG_FANOUT_PRIMARY) readonly primary: FanoutPrimary,
    @Inject(CATALOG_FANOUT_FOLLOWERS) readonly followers: FanoutFollower[],
    @Inject(CATALOG_FANOUT_JOURNAL) readonly journal: CatalogFanoutJournal,
  ) {
    this.capabilities = composeCapabilities(
      { name: primary.name, capabilities: primary.store.capabilities },
      followers.map((follower) => ({
        name: follower.name,
        capabilities: follower.store.capabilities,
      })),
    );

    // At boot, not on first use. A snapshot picker that quietly stopped
    // appearing because somebody attached a follower without time travel is a
    // support ticket with no evidence attached to it; this is the evidence.
    for (const reason of explainCapabilities(
      { name: primary.name, capabilities: primary.store.capabilities },
      followers.map((follower) => ({
        name: follower.name,
        capabilities: follower.store.capabilities,
      })),
      this.capabilities,
    )) {
      this.logger.warn(reason);
    }

    if (primary.store.listSnapshots) {
      const listSnapshots = primary.store.listSnapshots.bind(primary.store);
      this.listSnapshots = listSnapshots;
    }
    // Bound to the primary for the same reason `listSnapshots` is: the primary's
    // commit is what decides a load happened, and its drop is what makes a
    // tombstone, so "which snapshots still hold rows" is its answer. Composing
    // it would report a follower's backlog as the catalog's, and the caller
    // asking this question is deciding what to DELETE — the one place where an
    // answer assembled from stores that disagree is worse than no answer.
    if (primary.store.listSnapshotsWithRows) {
      const listSnapshotsWithRows = primary.store.listSnapshotsWithRows.bind(primary.store);
      this.listSnapshotsWithRows = listSnapshotsWithRows;
    }
    if (primary.store.findSnapshot) {
      const findSnapshot = primary.store.findSnapshot.bind(primary.store);
      this.findSnapshot = findSnapshot;
    }
    if (primary.store.currentSnapshot) {
      // Bound to the primary and not composed, for the reason every read is: the
      // primary's commit is what decides that a load happened, so the snapshot it
      // is serving is *the* answer. A composed one — the newest snapshot every
      // store agrees on, say — would report a follower's staleness as the
      // catalog's, and a caller cannot act on that: the rows it is about to read
      // come from the primary either way.
      const currentSnapshot = primary.store.currentSnapshot.bind(primary.store);
      this.currentSnapshot = currentSnapshot;
    }
    if (supportsCarryForward(primary.store)) {
      this.carryForward = (type, snapshotId, options) =>
        this.mergeForward(type, snapshotId, options);
    }
    if (supportsObjectFilters(primary.store)) {
      // Copied rather than bound, because it is a value and not a method: what
      // the primary declares at construction is what it declares, and a fan-out
      // re-reading it per call would be reading a field nothing mutates.
      this.objectFilterOperators = primary.store.objectFilterOperators;
    }
    if (isQueryStore(primary.store)) {
      const store = primary.store;
      // Bound to the primary directly rather than fanned out. A read-only SQL
      // console is a read, and reads follow the primary; running the same
      // statement against both and picking one would be the nondeterminism this
      // package exists to avoid, in the one place where people paste the result
      // into a decision.
      this.runQuery = (request) => store.runQuery(request);
      this.queryRelations = () => store.queryRelations();
      // Probed separately from the other two, because it is optional ON a query
      // store rather than part of what makes one: a primary that answers
      // `runQuery` and not this is an ordinary configuration, and binding an
      // absent method would advertise streaming the primary cannot do — which
      // the export route would take at its word and stop capping.
      if (isStreamingQueryStore(store)) {
        const streaming = store;
        this.streamQuery = (request) => streaming.streamQuery(request);
      }
    }

    this.logger.log(
      followers.length === 0
        ? `Catalog fan-out: ${primary.name} only. No followers attached, so this behaves exactly like the store underneath it.`
        : `Catalog fan-out: ${primary.name} decides; ${followers
            .map((follower) => `${follower.name} (${follower.strictness})`)
            .join(', ')} follow.`,
    );
  }

  // ---------------------------------------------------------------------------
  // Reads. Always the primary, except when a caller names a follower on purpose.
  // ---------------------------------------------------------------------------

  async read(
    type: CatalogObjectTypeDef,
    fields: string[],
    query: CatalogReadQuery,
  ): Promise<CatalogReadResult> {
    return this.primary.store.read(type, fields, query);
  }

  /**
   * Read a named store rather than the primary.
   *
   * The verification path, and the only way a read ever leaves the primary. It
   * takes a name and not a preference — there is no "read from the fastest", no
   * failover, no round-robin — because every one of those turns a stale follower
   * into an answer somebody acts on. What this is for is looking at a follower
   * with your own eyes before making it the primary.
   *
   * Which is why the filter check is here rather than nowhere.
   * {@link objectFilterOperators} reports the *primary's* operators, and this
   * method is the one call that does not read the primary — so a follower that
   * declares no filtering would be handed the filters and return every row it
   * has, and the caller comparing it against the primary would be comparing a
   * filtered page to an unfiltered one and concluding the follower has extra
   * data. Refusing by name costs a verification run nothing: the filters were
   * hand-built by whoever is doing the comparing, and they can drop them.
   */
  async readFrom(
    name: string,
    type: CatalogObjectTypeDef,
    fields: string[],
    query: CatalogReadQuery,
  ): Promise<CatalogReadResult> {
    const store = this.storeNamed(name);
    const wanted = query.filters ?? [];
    if (wanted.length > 0) {
      const operators = supportsObjectFilters(store) ? store.objectFilterOperators : [];
      const unsupported = [
        ...new Set(wanted.map((filter) => filter.op).filter((op) => !operators.includes(op))),
      ];
      if (unsupported.length > 0) {
        throw new BadRequestException(
          operators.length === 0
            ? `"${name}" does not filter object reads, so it cannot answer this comparison — it would return every row it has and look like a follower holding more data than the primary. Read it without filters.`
            : `"${name}" cannot filter with ${unsupported.join(', ')}. It applies ${operators.join(', ')}.`,
        );
      }
    }
    return store.read(type, fields, query);
  }

  /** The store registered under a name, primary or follower. */
  storeNamed(name: string): CatalogReadStore {
    if (name === this.primary.name) return this.primary.store;
    const follower = this.followers.find((each) => each.name === name);
    if (follower) return follower.store;
    throw new BadRequestException(
      `No store named "${name}" is in this fan-out. It holds ${[
        this.primary.name,
        ...this.followers.map((each) => each.name),
      ].join(', ')}.`,
    );
  }

  /** The follower registered under a name. Refuses the primary by name. */
  followerNamed(name: string): FanoutFollower {
    const follower = this.followers.find((each) => each.name === name);
    if (follower) return follower;
    if (name === this.primary.name) {
      throw new BadRequestException(
        `"${name}" is the primary of this fan-out, not a follower. The primary is the store everything else is repaired from; it has nothing to be repaired against.`,
      );
    }
    throw new BadRequestException(
      `No follower named "${name}". This fan-out has ${
        this.followers.length === 0 ? 'none' : this.followers.map((each) => each.name).join(', ')
      }.`,
    );
  }

  // ---------------------------------------------------------------------------
  // Writes.
  // ---------------------------------------------------------------------------

  /**
   * Bring every store's physical shape in line with the type.
   *
   * Primary first. A DDL change the primary refuses must not have been applied
   * to a follower already, because that follower would then carry a column for a
   * type this catalog does not have — additive and harmless in isolation, and
   * exactly the kind of drift that makes a later comparison ambiguous.
   *
   * A follower that fails here is recorded under a schema-scoped snapshot id
   * rather than a real one, because `ensureType` belongs to no load. The commit
   * of every subsequent load looks at those entries too: a type whose columns
   * are missing on a follower will usually fail the writes as well and be caught
   * that way, but a load of zero rows writes nothing and would otherwise sail
   * through and commit a schema that is not there.
   */
  async ensureType(type: CatalogObjectTypeDef): Promise<void> {
    await this.primary.store.ensureType(type);
    if (this.followers.length === 0) return;

    const failures: FanoutFailure[] = [];
    for (const follower of this.followers) {
      const outcome = await this.attempt(
        follower,
        { type, snapshotId: FANOUT_SCHEMA_SCOPE, stage: 'ensureType' },
        () => follower.store.ensureType(type),
      );
      if (!outcome.ok) {
        failures.push({
          follower: follower.name,
          stage: 'ensureType',
          error: outcome.error,
        });
      }
    }
    this.refuseOnRequired(type, FANOUT_SCHEMA_SCOPE, failures);
  }

  /**
   * Write one batch to every store.
   *
   * Primary first, and its result is what the caller gets back. A follower that
   * accepted a different number of rows is a comparison finding, not an answer —
   * reporting the larger of the two, or the follower's, would mean the number a
   * pipeline logs depends on which store happened to be more generous.
   *
   * The primary's refusals are also the fan-out's refusals, for free: it
   * validates first, so a load whose fields match nothing, or whose batch number
   * is reserved, is rejected before a single follower has been touched.
   *
   * **A crash between the primary's write and a follower's** leaves the primary
   * holding a batch under an uncommitted snapshot and the follower holding
   * nothing. Neither is visible to any reader, because neither has committed.
   * The caller's retry re-sends the batch to both, and both replace rather than
   * append, so the state converges with no cleanup.
   */
  async write(
    type: CatalogObjectTypeDef,
    rows: Array<Record<string, unknown>>,
    options: {
      snapshotId: string;
      principalId: string;
      batch?: number;
      labels?: Record<string, string>;
    },
  ): Promise<{ written: number }> {
    const result = await this.primary.store.write(type, rows, options);
    if (this.followers.length === 0) return result;

    // Resolved here rather than left undefined, because the journal key has to
    // name the same batch the store defaulted it to — otherwise an unnumbered
    // batch and batch 0 are two different debts for one write.
    const batch = Number.isFinite(options.batch) ? Number(options.batch) : 0;

    const failures: FanoutFailure[] = [];
    for (const follower of this.followers) {
      const outcome = await this.attempt(
        follower,
        { type, snapshotId: options.snapshotId, stage: 'write', batch },
        async () => {
          const mirrored = await follower.store.write(type, rows, options);
          if (mirrored.written !== result.written) {
            throw new Error(
              `took ${mirrored.written} of the ${result.written} rows ${this.primary.name} took. A batch that lands short is a snapshot that is short, and nothing later in the load would notice.`,
            );
          }
          return mirrored;
        },
      );
      if (!outcome.ok) {
        failures.push({
          follower: follower.name,
          stage: 'write',
          batch,
          error: outcome.error,
        });
      }
    }
    this.refuseOnRequired(type, options.snapshotId, failures);
    return result;
  }

  /**
   * Merge the previous snapshot forward on every store.
   *
   * Present only when the primary can merge; see the `declare` block above.
   *
   * The interesting check is not that the call succeeded but that it merged from
   * the *same base*. Each store decides what to carry forward by looking at its
   * own last committed snapshot, so a follower that missed the previous load
   * merges from the load before it — and the result is a snapshot that is
   * complete, plausible, internally consistent, and not the same dataset the
   * primary is about to publish. Comparing `from` catches that at the moment it
   * happens, which is the only cheap moment.
   *
   * **A crash between the primary's merge and a follower's** leaves an
   * uncommitted snapshot on both sides, one merged and one not. Nothing is
   * visible. Re-running the carry-forward is idempotent on every store the core
   * interface admits, so the retry converges.
   */
  private async mergeForward(
    type: CatalogObjectTypeDef,
    snapshotId: string,
    options: { principalId: string; labels?: Record<string, string> },
  ): Promise<CarryForwardResult> {
    const primary = this.primary.store;
    if (!supportsCarryForward(primary)) {
      // Unreachable through the assigned method, which is only bound when the
      // primary supports it. Kept because the alternative is a cast, and a cast
      // is a promise the compiler stops checking the moment the wiring changes.
      throw new BadRequestException(
        `${this.primary.name} cannot merge a load forward, so this catalog cannot take an incremental load.`,
      );
    }

    const result = await primary.carryForward(type, snapshotId, options);
    if (this.followers.length === 0) return result;

    const failures: FanoutFailure[] = [];
    for (const follower of this.followers) {
      const outcome = await this.attempt(
        follower,
        { type, snapshotId, stage: 'carryForward' },
        async () => {
          const store = follower.store;
          if (!supportsCarryForward(store)) {
            throw new Error(
              `cannot merge a load forward, so it cannot receive an incremental snapshot at all. Run this connector in full mode while ${follower.name} is attached, or let this load complete and replay the finished snapshot — a replay copies the primary's merged result and needs no merge of its own.`,
            );
          }
          const mirrored = await store.carryForward(type, snapshotId, options);
          if (mirrored.from !== result.from) {
            throw new Error(
              `merged forward from ${describeBase(mirrored.from)} where ${this.primary.name} merged from ${describeBase(result.from)}. The two snapshots are built on different bases, so they are not the same dataset however similar the row counts look. This is what a follower that missed an earlier load looks like.`,
            );
          }
          if (mirrored.total !== result.total) {
            throw new Error(
              `finished the merge holding ${mirrored.total} rows where ${this.primary.name} holds ${result.total}.`,
            );
          }
          return mirrored;
        },
      );
      if (!outcome.ok) {
        failures.push({
          follower: follower.name,
          stage: 'carryForward',
          error: outcome.error,
        });
      }
    }
    this.refuseOnRequired(type, snapshotId, failures);
    return result;
  }

  /**
   * Publish the snapshot: on the primary first, then on every follower that is
   * known to hold all of it.
   *
   * The sequence, and what a crash between each pair of steps leaves behind:
   *
   * 1. **Ask the journal what is outstanding for this snapshot.** If any
   *    `required` follower owes anything, throw here — before the primary has
   *    committed. The load is then published nowhere: the primary's rows stay
   *    invisible under an uncommitted snapshot, and the caller's retry replays
   *    the whole thing. This is what gives `required` real teeth, since every
   *    failure except a follower's own commit is discovered before this point.
   *    *A crash here* leaves an uncommitted snapshot on every store and no
   *    reader affected.
   * 2. **Commit on the primary.** From this instant the load has happened;
   *    readers see the new snapshot. *A crash between 2 and 3* leaves the
   *    primary serving the new snapshot with no record that it did — the
   *    followers still serve the previous one, which is stale but coherent, and
   *    a replay will still work because it can be told the snapshot id
   *    explicitly.
   * 3. **Write the commit mark.** The journal now knows which snapshot is
   *    current, which is what lets a later replay decide whether to commit on
   *    the follower or merely stage the rows.
   * 4. **For each follower: record the attempt, then commit it.** The record is
   *    written *before* the call, never after. That ordering is the only reason
   *    a crash is recoverable: an entry that survives says "this follower may
   *    not have this snapshot", which is exactly true whether the process died
   *    before, during, or after the follower's commit. Recording afterwards
   *    would lose precisely the failures nobody was around to see. *A crash
   *    between 4 and 5* leaves a `pending` entry, which reads as a debt and is
   *    cleared by a replay; committing twice on a store is a no-op.
   * 5. **Return the primary's `SnapshotRef`**, always. A follower's row count is
   *    never what a caller is told, because the caller is entitled to one answer
   *    about what it just loaded.
   *
   * A `recorded` follower that already owes something for this snapshot is not
   * committed at all — it is held back, and the reason is written down. The
   * alternative is publishing a snapshot on the follower that is known to be one
   * batch short, and a follower serving a short snapshot is worse than a
   * follower serving yesterday's: one is stale and obviously so, the other is
   * current and wrong. A `required` follower can never reach this branch,
   * because step 1 refused.
   */
  async commit(type: CatalogObjectTypeDef, snapshotId: string): Promise<SnapshotRef> {
    if (this.followers.length === 0) {
      return this.primary.store.commit(type, snapshotId);
    }

    const outstanding = await this.outstandingFor(type.name, snapshotId);

    const blocked = this.followers.filter(
      (follower) =>
        follower.strictness === 'required' &&
        outstanding.some((entry) => entry.follower === follower.name),
    );
    if (blocked.length > 0) {
      const failures: FanoutFailure[] = outstanding
        .filter((entry) => blocked.some((f) => f.name === entry.follower))
        .map((entry) => ({
          follower: entry.follower,
          stage: entry.stage,
          batch: entry.batch,
          error: entry.error ?? `${entry.status} since ${entry.firstSeenAt}`,
        }));
      throw new CatalogFanoutError(
        `Snapshot ${snapshotId} of ${type.name} was not committed anywhere. ${blocked
          .map((follower) => follower.name)
          .join(
            ', ',
          )} is a required follower and does not hold all of this load (${failures.length} outstanding step(s)). Nothing has been published, so retry the load: the primary still holds every batch under this snapshot id and re-sending them replaces rather than duplicates.`,
        failures,
      );
    }

    const ref = await this.primary.store.commit(type, snapshotId);
    await this.journal.markCommitted({
      typeName: type.name,
      snapshotId,
      at: new Date().toISOString(),
      principalId: ref.principalId,
    });

    const committed: string[] = [];
    const heldBack: string[] = [];
    const failures: FanoutFailure[] = [];

    for (const follower of this.followers) {
      const owed = outstanding.filter((entry) => entry.follower === follower.name);
      if (owed.length > 0) {
        await this.holdBack(type, snapshotId, follower, owed);
        heldBack.push(follower.name);
        continue;
      }
      const outcome = await this.attempt(follower, { type, snapshotId, stage: 'commit' }, () =>
        follower.store.commit(type, snapshotId),
      );
      if (outcome.ok) {
        committed.push(follower.name);
        await this.supersede(type, snapshotId, follower);
      } else {
        failures.push({
          follower: follower.name,
          stage: 'commit',
          error: outcome.error,
        });
      }
    }

    emitFanout('snapshot.fanned-out', {
      typeName: type.name,
      snapshotId,
      primary: this.primary.name,
      committed,
      failed: failures.map((failure) => failure.follower),
      heldBack,
    });

    this.refuseOnRequired(type, snapshotId, failures);
    return ref;
  }

  /**
   * Drop a snapshot everywhere. Followers first, primary last.
   *
   * The reverse of the write order, from the same rule: the primary must never
   * be behind. *A crash between a follower's drop and the primary's* leaves the
   * snapshot present on the primary and gone from a follower, which is the
   * ordinary "follower is behind" state and needs no special handling — running
   * the drop again finishes the job. The other order would leave a snapshot that
   * exists only on a follower, belonging to a load the primary has no record of,
   * with nothing in the system responsible for it.
   *
   * Entries for the dropped snapshot are forgotten afterwards, except the drop's
   * own: a debt about a snapshot that no longer exists is noise, but a follower
   * that still holds it is a real divergence and stays on the ledger.
   */
  async dropSnapshot(type: CatalogObjectTypeDef, snapshotId: string): Promise<void> {
    const failures: FanoutFailure[] = [];
    for (const follower of this.followers) {
      const outcome = await this.attempt(follower, { type, snapshotId, stage: 'drop' }, () =>
        follower.store.dropSnapshot(type, snapshotId),
      );
      if (!outcome.ok) {
        failures.push({
          follower: follower.name,
          stage: 'drop',
          error: outcome.error,
        });
      }
    }

    await this.primary.store.dropSnapshot(type, snapshotId);

    if (this.followers.length > 0) {
      const stale = await this.journal.outstanding({
        typeName: type.name,
        snapshotId,
      });
      for (const entry of stale) {
        if (entry.stage === 'drop') continue;
        await this.journal.resolve(entry.key);
      }
    }

    this.refuseOnRequired(type, snapshotId, failures);
  }

  // ---------------------------------------------------------------------------
  // The journal side of it.
  // ---------------------------------------------------------------------------

  /**
   * Everything a follower still owes for one snapshot of one type.
   *
   * Schema-scoped entries are folded in, because a follower whose table is a
   * column short holds a snapshot that is missing a column, and that is not a
   * snapshot of this type however many rows it has.
   */
  async outstandingFor(typeName: string, snapshotId: string): Promise<FanoutJournalEntry[]> {
    const all = await this.journal.outstanding({ typeName });
    return all.filter(
      (entry) => entry.snapshotId === snapshotId || entry.snapshotId === FANOUT_SCHEMA_SCOPE,
    );
  }

  /**
   * Bring one named follower's physical shape in line with the type, journalled
   * like any other step.
   *
   * The head of a replay, and public for the same reason {@link commitFollower}
   * is its tail: a repair that touches a follower outside this class's
   * announce-before-attempt path is a repair whose failure nobody writes down,
   * and — worse here — whose *success* discharges nothing.
   *
   * **The bug this exists to close.** A follower that failed `ensureType` owes an
   * entry under {@link FANOUT_SCHEMA_SCOPE}, and {@link outstandingFor} folds the
   * schema scope into every snapshot, so that follower is held back from every
   * commit from then on and `verify()` is red for good. The documented repair is
   * a replay — which used to call `follower.store.ensureType` directly, so the
   * one thing that could discharge the entry was the one call that bypassed the
   * journal. The operator ran the repair, was told how many debts it cleared, and
   * the follower was still held back on the next load, with nothing in the output
   * of either step to suggest why.
   *
   * It is not enough to sweep the schema scope in {@link clearDebt} instead. That
   * entry says a column is missing, and copying rows in does not make a column
   * appear — `supersede` says the same thing about why committing loads never
   * discharges it. The only evidence that the schema debt is paid is an
   * `ensureType` that succeeded, so the repair has to be that call, made where it
   * can be seen.
   *
   * Returns whether a debt was actually discharged, so a caller reporting a count
   * reports what happened rather than that the call returned.
   */
  async ensureTypeOn(
    type: CatalogObjectTypeDef,
    followerName: string,
  ): Promise<{ recovered: boolean }> {
    const follower = this.followerNamed(followerName);
    const outcome = await this.attempt(
      follower,
      { type, snapshotId: FANOUT_SCHEMA_SCOPE, stage: 'ensureType' },
      () => follower.store.ensureType(type),
    );
    if (!outcome.ok) {
      throw new CatalogFanoutError(
        `${followerName} would not take the schema for ${type.name}: ${outcome.error}. Until it does, every commit holds this follower back, because a follower whose table is a column short is not holding a snapshot of this type however many rows it has.`,
        [{ follower: followerName, stage: 'ensureType', error: outcome.error }],
      );
    }
    return { recovered: outcome.recovered };
  }

  /**
   * Commit a snapshot on one named follower, journalled like any other step.
   *
   * The tail of a replay, and public for exactly that reason: once the rows have
   * been copied from the primary the follower is holding the snapshot, and
   * publishing it there has to go through the same announce-before-attempt path
   * as an ordinary commit or a crash during the repair would go unrecorded.
   *
   * **This discharges journal entries, and says so only to the journal.** A
   * follower held back from a load owes a `commit` entry, which the attempt below
   * resolves; committing also supersedes every entry about a snapshot this
   * follower has now moved past. Neither shows up in the return value, which is
   * the `SnapshotRef` a caller asked for and nothing else — so a repair reporting
   * how much it fixed cannot assemble that number out of what its steps hand
   * back, and {@link import('./migration').CatalogFanoutMigration.replay} reads
   * the ledger before and after instead. Widening this signature would fix one caller's arithmetic and
   * leave the next step somebody adds to the repair with the same trap.
   */
  async commitFollower(
    type: CatalogObjectTypeDef,
    snapshotId: string,
    followerName: string,
  ): Promise<SnapshotRef> {
    const follower = this.followerNamed(followerName);
    const outcome = await this.attempt(follower, { type, snapshotId, stage: 'commit' }, () =>
      follower.store.commit(type, snapshotId),
    );
    if (!outcome.ok) {
      throw new CatalogFanoutError(
        `${followerName} would not commit ${type.name} snapshot ${snapshotId}: ${outcome.error}`,
        [{ follower: followerName, stage: 'commit', error: outcome.error }],
      );
    }
    await this.supersede(type, snapshotId, follower);
    return outcome.value;
  }

  /**
   * Discharge a follower's debts about *other* snapshots of a type, because it
   * has just committed one.
   *
   * The reasoning is the core library's own: a snapshot is the complete state of
   * a type, not a delta — that is the decision `CatalogMergeStore` documents at
   * length, and it is why an incremental load copies the previous snapshot
   * forward instead of chaining. So a follower serving snapshot S is serving
   * everything the type has, and an entry saying it once missed S-3 no longer
   * describes anything a reader of that follower can encounter.
   *
   * Left alone, those entries accumulate for the lifetime of the deployment and
   * `verify()` is permanently red. A cutover gate that is always red is a gate
   * everybody learns to walk past, which is a far more expensive failure than
   * losing a line about a snapshot nothing serves.
   *
   * The one thing it does not touch is the schema scope. A failed `ensureType`
   * is about the table, not about a load, and no amount of committing loads
   * makes a missing column appear. Those are discharged by `ensureType`
   * succeeding, and until then they hold this follower back from every commit.
   *
   * What is genuinely lost is the follower's copy of the *older* snapshot, and
   * that is a hole in its history rather than in its current state. The composed
   * capabilities are the place that is accounted for; see `composeCapabilities`.
   */
  private async supersede(
    type: CatalogObjectTypeDef,
    snapshotId: string,
    follower: FanoutFollower,
  ): Promise<void> {
    const owed = await this.journal.outstanding({
      typeName: type.name,
      follower: follower.name,
    });
    const stale = owed.filter(
      (entry) => entry.snapshotId !== snapshotId && entry.snapshotId !== FANOUT_SCHEMA_SCOPE,
    );
    if (stale.length === 0) return;

    for (const entry of stale) await this.journal.resolve(entry.key);
    this.logger.warn(
      `${follower.name} now serves ${type.name} snapshot ${snapshotId}, so ${stale.length} entr${
        stale.length === 1 ? 'y' : 'ies'
      } about ${Array.from(new Set(stale.map((entry) => entry.snapshotId))).join(
        ', ',
      )} no longer describe what it serves and have been closed. Those snapshots are missing from its history; its current state is complete.`,
    );
  }

  /**
   * Forget what a follower owed for a snapshot, because the rows have just been
   * supplied wholesale from the primary.
   *
   * Only ever called after a replay has finished copying, never speculatively.
   * A journal that can be cleared without the data having moved is a journal
   * whose entries mean nothing.
   *
   * **Schema-scoped entries are out of reach here, deliberately.** The query is
   * by snapshot id and a failed `ensureType` is recorded under
   * {@link FANOUT_SCHEMA_SCOPE}, so no `stages` argument naming `ensureType` can
   * ever match one. That is not an oversight to be repaired by widening the
   * query: copying rows in is evidence about rows and about nothing else, and a
   * schema debt discharged on the strength of a successful copy would be exactly
   * the cleared-without-the-data-having-moved case above — the follower's table
   * can still be a column short, and the next load would write into it happily.
   * {@link ensureTypeOn} is where that debt is paid, by the call that is evidence
   * for it.
   *
   * The returned count is entries this call actually resolved: it skips stages
   * it was not asked for, and skips entries `resolve` reported nothing owed for.
   */
  async clearDebt(
    typeName: string,
    snapshotId: string,
    followerName: string,
    stages: FanoutStage[],
  ): Promise<number> {
    const owed = await this.journal.outstanding({
      typeName,
      snapshotId,
      follower: followerName,
    });
    let cleared = 0;
    for (const entry of owed) {
      if (!stages.includes(entry.stage)) continue;
      if (!(await this.journal.resolve(entry.key))) continue;
      cleared += 1;
      // One event per debt discharged, carrying the stage it was actually for.
      // A single summary event would have to invent a stage, and an observer
      // reconciling these against the failures would then be reconciling
      // against something that never happened.
      emitFanout('follower.recovered', {
        follower: followerName,
        typeName,
        snapshotId,
        stage: entry.stage,
        batch: entry.batch,
      });
    }
    return cleared;
  }

  /**
   * Announce a step, run it, and settle the announcement.
   *
   * Announce-before-attempt is uniform across every stage, including the ones
   * where a crash would be caught by the load failing anyway. The uniformity is
   * the point: "every interaction with a follower is written down before it is
   * tried" is an invariant somebody can hold in their head, whereas "written
   * down beforehand except during writes, because a crash there means the load
   * never committed" is a case analysis that will be wrong the first time
   * somebody adds a stage.
   */
  private async attempt<T>(
    follower: FanoutFollower,
    scope: {
      type: CatalogObjectTypeDef;
      snapshotId: string;
      stage: FanoutStage;
      batch?: number;
    },
    run: () => Promise<T>,
  ): Promise<{ ok: true; value: T; recovered: boolean } | { ok: false; error: string }> {
    const key = fanoutEntryKey({
      typeName: scope.type.name,
      snapshotId: scope.snapshotId,
      follower: follower.name,
      stage: scope.stage,
      batch: scope.batch,
    });
    const at = new Date().toISOString();
    // Whether this step was already owed before the announcement. Without it,
    // the announcement itself is what `resolve` finds, so every ordinary success
    // would be reported as a recovery — and a recovery that fires on the happy
    // path is a signal nobody can act on.
    const wasOwed = await this.journal.record({
      key,
      typeName: scope.type.name,
      snapshotId: scope.snapshotId,
      follower: follower.name,
      stage: scope.stage,
      batch: scope.batch,
      status: 'pending',
      attempts: 1,
      firstSeenAt: at,
      lastSeenAt: at,
    });

    try {
      const value = await run();
      const cleared = await this.journal.resolve(key);
      // Reported to the caller as well as announced, because a repair has to be
      // able to say how many debts it actually discharged. Deriving that from
      // "the repair ran and did not throw" is how a count comes to overstate
      // itself, and an overstated count is worse than none: it is the number the
      // operator reads before deciding the follower is fixed.
      const recovered = wasOwed && cleared;
      if (recovered) {
        emitFanout('follower.recovered', {
          follower: follower.name,
          typeName: scope.type.name,
          snapshotId: scope.snapshotId,
          stage: scope.stage,
          batch: scope.batch,
        });
        this.logger.log(
          `${follower.name} caught up on ${scope.stage} of ${scope.type.name} snapshot ${scope.snapshotId}.`,
        );
      }
      return { ok: true, value, recovered };
    } catch (cause) {
      const error = messageOf(cause);
      await this.journal.record({
        key,
        typeName: scope.type.name,
        snapshotId: scope.snapshotId,
        follower: follower.name,
        stage: scope.stage,
        batch: scope.batch,
        status: 'failed',
        error,
        // Zero, because the announcement above already counted this attempt.
        attempts: 0,
        firstSeenAt: at,
        lastSeenAt: new Date().toISOString(),
      });
      emitFanout('follower.failed', {
        follower: follower.name,
        typeName: scope.type.name,
        snapshotId: scope.snapshotId,
        stage: scope.stage,
        batch: scope.batch,
        strictness: follower.strictness,
        error,
      });
      this.logger.error(
        `${follower.name} failed ${scope.stage} of ${scope.type.name} snapshot ${scope.snapshotId}${
          scope.batch === undefined ? '' : ` batch ${scope.batch}`
        }: ${error}`,
      );
      return { ok: false, error };
    }
  }

  private async holdBack(
    type: CatalogObjectTypeDef,
    snapshotId: string,
    follower: FanoutFollower,
    owed: FanoutJournalEntry[],
  ): Promise<void> {
    const at = new Date().toISOString();
    const summary = owed
      .map((entry) => `${entry.stage}${entry.batch === undefined ? '' : ` batch ${entry.batch}`}`)
      .join(', ');
    await this.journal.record({
      key: fanoutEntryKey({
        typeName: type.name,
        snapshotId,
        follower: follower.name,
        stage: 'commit',
      }),
      typeName: type.name,
      snapshotId,
      follower: follower.name,
      stage: 'commit',
      status: 'heldBack',
      error: `not committed: ${owed.length} earlier step(s) of this snapshot are still owed (${summary}). Replay the snapshot to ${follower.name}.`,
      attempts: 1,
      firstSeenAt: at,
      lastSeenAt: at,
    });
    emitFanout('follower.held-back', {
      follower: follower.name,
      typeName: type.name,
      snapshotId,
      outstanding: owed.length,
    });
    this.logger.warn(
      `${follower.name} was not committed for ${type.name} snapshot ${snapshotId}: it is missing ${summary}. It keeps serving whatever it last committed until the snapshot is replayed to it.`,
    );
  }

  /**
   * Turn the failures of `required` followers into a thrown error.
   *
   * Every follower is attempted before this runs, deliberately. Throwing at the
   * first failure would leave the later followers untouched *and* unrecorded, so
   * the journal would report one problem where there were three, and the
   * operator would fix them one deploy at a time.
   */
  private refuseOnRequired(
    type: CatalogObjectTypeDef,
    snapshotId: string,
    failures: FanoutFailure[],
  ): void {
    const required = failures.filter((failure) => {
      const follower = this.followers.find((each) => each.name === failure.follower);
      return follower?.strictness === 'required';
    });
    if (required.length === 0) return;

    throw new CatalogFanoutError(
      `${required
        .map((failure) => `${failure.follower} (${failure.stage}): ${failure.error}`)
        .join('; ')} — and ${
        required.length === 1 ? 'that follower is' : 'those followers are'
      } required for ${type.name}${
        snapshotId === FANOUT_SCHEMA_SCOPE ? '' : ` snapshot ${snapshotId}`
      }. The failure is on the journal; retrying the load re-sends every batch and replaces rather than duplicates.`,
      required,
    );
  }
}

/**
 * Every optional store method this class probes the primary for and forwards.
 *
 * A runtime list as well as a type, because the two halves of "the fan-out
 * offers what its primary offers" fail differently and only one of them is a
 * type error. Leaving a method out of the `declare` block is caught below at
 * compile time; declaring it and forgetting the line in the constructor that
 * binds it is not a type error at all — the field is optional, so an unassigned
 * one is a legal absence — and it produces the identical silent no. This list is
 * what the suite walks to check the bindings, so a method added to the block
 * enters that check without anybody remembering to add it there too.
 *
 * Exported for the tests and not from the package's entry point: it is a fact
 * about this class's wiring, not something a host has any use for.
 */
export const PROBED_STORE_METHODS = [
  'listSnapshots',
  'listSnapshotsWithRows',
  'findSnapshot',
  'currentSnapshot',
  'carryForward',
  'runQuery',
  'queryRelations',
  'streamQuery',
] as const;

/**
 * Every method the rest of the ecosystem discovers by looking for it.
 *
 * Three sources, because there are three ways a store says it can do something
 * extra: an optional member of the write interface, the one member that makes a
 * store a merge store, and the members that make it a query store. All three are
 * probed structurally by the core package, and all three grow.
 */
type ProbedStoreMethod =
  | OptionalKeyOf<CatalogWriteStore>
  | Exclude<keyof CatalogMergeStore, keyof CatalogWriteStore>
  | keyof CatalogQueryStore;

/** A method the interfaces have and this class does not declare. */
type _EveryProbedMethodIsDeclared = AssertNothingMissing<
  Exclude<ProbedStoreMethod, keyof FanoutCatalogStore>
>;

/** A method this class declares that the tests would never look for. */
type _EveryProbedMethodIsListed = AssertNothingMissing<
  Exclude<ProbedStoreMethod, (typeof PROBED_STORE_METHODS)[number]>
>;

/** A name in the list that no interface has, i.e. a check for something gone. */
type _EveryListedMethodIsProbed = AssertNothingMissing<
  Exclude<(typeof PROBED_STORE_METHODS)[number], ProbedStoreMethod>
>;

/**
 * Narrow an injected token to a store that can be loaded into.
 *
 * A runtime check rather than a type argument on the module options, because
 * what the injector hands back is genuinely unknown until it hands it back —
 * a token can be bound to anything, and a misbound one would otherwise surface
 * as `store.write is not a function` in the middle of a load rather than as a
 * refusal at boot.
 */
export function asWriteStore(name: string, value: unknown): CatalogWriteStore {
  if (!isCatalogReadStore(value)) {
    throw new BadRequestException(
      `The token registered for "${name}" did not resolve to a catalog store — it has no \`read\` or declares no capabilities. Check that the module providing it is in this fan-out's \`imports\`.`,
    );
  }
  // The core package's own predicate, deliberately, so the fan-out agrees with
  // the rest of the ecosystem about what "writable" means instead of keeping a
  // second opinion that can drift from it.
  if (!isWriteStore(value)) {
    throw new BadRequestException(
      `The store registered for "${name}" is not writable, so it cannot take part in a fan-out. A follower that cannot receive the data is not a migration target, and a read-through view of somebody else's tables has no load to mirror.`,
    );
  }
  return value;
}

/**
 * The capability half is the core package's own predicate, not a local copy.
 *
 * There was a local copy, and it had already drifted: it knew nothing about the
 * three optional atomicity fields, so a store declaring `transactional: "yes"`
 * was refused by the core package and accepted here. The core exports its
 * predicate for exactly this — a fan-out composing three stores and a dashboard
 * rendering one have to agree about what counts as a capability object, or a
 * store is admitted by one and rejected by the other for reasons neither reports.
 */
function isCatalogReadStore(value: unknown): value is CatalogReadStore {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'read') === 'function' &&
    isCatalogStoreCapabilities(Reflect.get(value, 'capabilities'))
  );
}

function describeBase(from: string | undefined): string {
  return from === undefined ? 'nothing (it had no committed snapshot)' : from;
}

function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
