import { BadRequestException } from '@nestjs/common';
import type { CatalogFilterOperator, CatalogResolvedFilter } from './catalog.filters';
import type { CatalogObjectQuery, CatalogObjectTypeDef } from './catalog.types';

/**
 * Where the objects actually live.
 *
 * The registry knows what the types *are*; a store knows how to read and write
 * rows of them. Splitting the two is what lets the same catalog sit on top of
 * the application's own tables, a separate warehouse schema, or a column store,
 * without the screens above it changing.
 */

/**
 * Where a snapshot's rows have been copied to, outside the database.
 *
 * **Vocabulary only — this package writes none of these and reads none of them.**
 * It is declared here because it belongs on {@link SnapshotRef}, and a
 * `SnapshotRef` is what every screen and every caller already holds. The
 * machinery that produces an archive lives in
 * `@dudousxd/nestjs-catalog-pipeline`, which is the package already allowed to
 * know what a bucket is; the catalog itself stays unable to name one.
 *
 * ## What its presence means, and what it does not
 *
 * Present means *a verified copy of this snapshot exists at `path`*. It says
 * nothing about whether the rows are still in the database — those are two
 * independent facts and a caller that conflates them gets the dangerous reading
 * in both directions. Which is why "are the rows still there" is a *different*
 * field, {@link SnapshotRef.droppedAt}, and the two compose as a grid rather
 * than as one ladder:
 *
 * - **neither** — the snapshot is in the database and nowhere else.
 * - **`archive` only** — copied, not moved. Reads are unchanged and cost what
 *   they always did.
 * - **`droppedAt` only** — a tombstone. The record survives so run history
 *   stays resolvable; the data does not, and no read of it can succeed.
 * - **both** — the snapshot lives in object storage. Still identified, still
 *   recoverable, and **not** the same price as a read of a hot snapshot.
 *   {@link bytes} is here so a screen can say which it is about to do rather
 *   than presenting the two as one click.
 *
 * A snapshot with no `SnapshotRef` at all is the fifth state, and it is the
 * only one that means *gone*: nothing left to name it, and every
 * `catalog_connector_run` that produced it now points at nothing.
 */
export interface SnapshotArchiveRef {
  /** The only format written today. Named rather than assumed, so a second one can arrive. */
  format: 'parquet';
  /**
   * The disk the bytes went to, when a host named one.
   *
   * Absent means `path` is resolved by whatever wrote it — a filesystem path in
   * a test, a bucket a host configured. The disk is recorded rather than
   * inferred because a deployment may mount several and "which one" is not
   * recoverable from the path.
   */
  disk?: string;
  /** The directory holding this snapshot's parts and its manifest, without a trailing slash. */
  path: string;
  /** Rows in the archive. Compared against the snapshot's own count when it was written. */
  rowCount: number;
  /** Size on the far end, for a screen that has to say what a read will cost. */
  bytes: number;
  /**
   * SHA-256 over the row stream in `_row` order, as the manifest records it.
   *
   * A row count catches a truncated archive and nothing else: an archive with
   * every row present and one value corrupted has exactly the right count. This
   * is the check that fails for that, and it is only meaningful because the
   * stream is ordered — see the store's `streamSnapshot`.
   */
  checksum: string;
  writtenAt: string;
  /**
   * When the archive was last read back and found to match.
   *
   * Separate from {@link writtenAt} because they answer different questions and
   * a caller about to delete rows needs the second one. Absent means written but
   * not confirmed readable, which is exactly the state in which nothing may be
   * deleted.
   */
  verifiedAt?: string;
}

/** A point-in-time view of one object type. */
export interface SnapshotRef {
  /**
   * Opaque and caller-supplied. Callers are expected to pass something they
   * already have that identifies the load — for a durable pipeline, its run id.
   */
  id: string;
  createdAt: string;
  rowCount: number;
  /**
   * Which application loaded this. Required rather than optional: a shared
   * write path where a snapshot cannot name its author is one where a bad load
   * has no owner, and "who wrote this" is asked long after the logs have
   * rotated.
   */
  principalId: string;
  /** Free-form provenance: which base, which file, which workflow run. */
  labels?: Record<string, string>;
  /**
   * Where this snapshot's rows have been copied to, if anywhere.
   *
   * Optional, and absent is the answer for every snapshot in every deployment
   * that archives nothing — which is all of them until a host asks. See
   * {@link SnapshotArchiveRef} for the states it composes into.
   */
  archive?: SnapshotArchiveRef;
  /**
   * When this snapshot's rows were deleted, if they have been.
   *
   * Present makes this ref a **tombstone**: the record of the load survives —
   * who wrote it, when, under which labels, and how many rows it held — while
   * the rows themselves are gone. Absent is the answer for every snapshot that
   * still has its data, which is every snapshot until something drops one.
   *
   * ## Why the record is kept rather than deleted with the rows
   *
   * A snapshot is a whole version of an object type, and committing a new one
   * leaves the old rows in place beside the new ones. Nothing removed them, so
   * a type loaded daily holds every day it has ever been loaded; one deployment
   * reached 441 retained snapshots and 100 GB and the database then refused
   * connections. The obvious repair — drop old snapshots — was blocked by a
   * real objection, that `catalog_connector_run` records the snapshot each run
   * produced, so deleting the snapshot turns the run history into a list of
   * pointers to nothing.
   *
   * The objection is about the *record*, and the disk is held by the *rows*.
   * They are separable, and separating them is the whole of this field: the
   * bytes can go while the run that produced them stays answerable. It says
   * nothing about *when* anything should be dropped — there is no retention
   * policy anywhere in this package and this field does not imply one.
   *
   * ## What it obliges a reader to do
   *
   * Refuse, out loud. A read of a tombstoned snapshot must fail with a sentence
   * naming the drop and its date; it must never come back as zero rows, which
   * is indistinguishable from a load that collapsed and is the failure this
   * codebase refuses everywhere else. The store enforces the one invariant that
   * keeps ordinary reads free of the question: **the snapshot a type is serving
   * can never be tombstoned**, so only an explicit read of history can meet one.
   *
   * ISO-8601, like {@link createdAt}.
   */
  droppedAt?: string;
}

/**
 * How a store holds history. One list, so nothing narrows a stored or
 * transmitted value against a second hand-maintained copy of these names.
 *
 * Ordered weakest to strongest, which is the order a composing store (a fan-out
 * over a primary and its followers) has to intersect them in.
 */
export const CATALOG_SNAPSHOT_MODES = ['none', 'emulated', 'native'] as const;

export type CatalogSnapshotMode = (typeof CATALOG_SNAPSHOT_MODES)[number];

/**
 * What a store can do. Declared rather than inferred from the engine's name,
 * because the capabilities do not travel together.
 *
 * In particular `snapshots: "native"` is rarer than it looks. Neither DuckDB nor
 * ClickHouse keeps history on its own — DuckDB has no time travel at all, and
 * ClickHouse's ReplacingMergeTree collapses old versions rather than preserving
 * them. What does give history for free is a *table format* (Iceberg, Delta),
 * which those engines can read. So a column store is chosen for read speed over
 * wide tables, not for versioning; it still emulates snapshots like MySQL does.
 *
 * **The three atomicity fields below are optional, and that is a decision.**
 * They arrived after the first adapters shipped, and making them required would
 * have done two bad things at once. The small one is that every existing
 * adapter — including ones outside this repository — stops compiling on a minor
 * version. The large one is that a required `boolean` has no way to say "this
 * adapter has not measured that", so the day it is added every adapter author
 * writes down a guess, and a guess about atomicity is indistinguishable from a
 * measurement once it is a literal in a capability object. `undefined` is a
 * third answer with a meaning: *not stated*. A caller must read it the
 * pessimistic way — an absent `transactional` means "assume a crash can leave
 * this half-done", an absent `atomicCutover` means "assume a reader can catch
 * the swap in progress" — because the cost of assuming the optimistic reading
 * and being wrong is a recovery routine that skips the repair it exists for.
 */
export interface CatalogStoreCapabilities {
  /**
   * - `native`   — the engine keeps history; reading an old snapshot is a query.
   * - `emulated` — the store tags rows with a snapshot id and filters on read.
   * - `none`     — only the current state exists.
   */
  snapshots: CatalogSnapshotMode;
  /** False for a read-through store over tables someone else owns. */
  writable: boolean;
  /** Whether `read` can be given a `snapshot` other than the latest. */
  timeTravel: boolean;

  /**
   * Whether each step of a commit lands whole, so no reader ever observes a
   * relation that is missing or half-swapped while the cutover happens.
   *
   * This is about each read path individually, not about all of them flipping
   * at the same instant — a store typically repoints an internal pointer and
   * replaces a SQL view in two statements, and whether *those* two can be torn
   * apart by a crash is what {@link transactional} answers. What this field
   * promises is narrower and more immediately useful: that a query issued
   * during the swap gets the old snapshot or the new one, and never an error.
   *
   * It is not a property of the engine, it is a property of the statement the
   * adapter chose. The ClickHouse adapter measured both: hammering a view with
   * 400 concurrent reads while replacing it 400 times with `CREATE OR REPLACE
   * VIEW` produced 18 `UNKNOWN_TABLE` errors, because that statement drops the
   * name and recreates it; `EXCHANGE TABLES` on an Atomic database did the same
   * 400 swaps with none. Same engine, same intent, different answer here.
   *
   * Absent means not stated; read it as false.
   */
  atomicCutover?: boolean;

  /**
   * Whether re-sending a batch replaces it with no window in which neither the
   * old rows nor the new ones are present.
   *
   * Every store in this ecosystem makes a re-sent batch *idempotent* — that is
   * required by {@link CatalogWriteStore.write} and is not what this asks. This
   * asks what a concurrent reader sees while the replacement happens. MySQL's
   * `DELETE` then `INSERT` are two statements and briefly show neither copy;
   * ClickHouse's `REPLACE PARTITION` from a staging table is one metadata
   * commit and shows one or the other.
   *
   * That difference is invisible for the ordinary case, because a snapshot
   * being written has not been committed and nobody is reading it. It matters
   * for exactly one case, which is also the one nobody plans for: a durable run
   * whose commit succeeded and which then retries from the top, re-sending
   * every batch into a snapshot that is live and being served.
   *
   * Absent means not stated; read it as false.
   */
  atomicBatchReplace?: boolean;

  /**
   * Whether a multi-statement operation of this store is all-or-nothing.
   *
   * The one a caller must consult before writing recovery logic. False means a
   * crash part-way through `commit()` or `write()` can leave a state no single
   * statement produced — a snapshot marked committed whose view still points at
   * the previous one, say — and that the repair is to re-run the operation
   * rather than to expect a rollback that never happened. Adapters that report
   * false are expected to have ordered their statements so re-running *is* the
   * repair, but a caller that assumes it without asking is assuming something
   * only the adapter knows.
   *
   * ClickHouse reports false and cannot report anything else: it has no
   * transactions across statements. A store on a transactional engine still
   * only reports true if it actually wraps its steps in one, which is a
   * different claim from the engine being capable of it.
   *
   * Absent means not stated; read it as false.
   */
  transactional?: boolean;
}

/**
 * Narrow something that claims to be a capability object.
 *
 * Exported because a store arrives through an injection token, and a token can
 * be bound to anything: a fan-out composing three stores and a dashboard
 * rendering one both need to check the shape, and two hand-rolled checks that
 * disagree about what counts as a capability object is a store being accepted
 * by one and rejected by the other for reasons neither reports.
 *
 * The three optional fields are checked only when present. An adapter built
 * against a newer version of this package may carry fields this copy has never
 * heard of, and refusing it for that would turn a forward-compatible addition
 * into a boot failure.
 */
export function isCatalogStoreCapabilities(value: unknown): value is CatalogStoreCapabilities {
  if (typeof value !== 'object' || value === null) return false;
  const snapshots = Reflect.get(value, 'snapshots');
  if (!CATALOG_SNAPSHOT_MODES.some((mode) => mode === snapshots)) return false;
  if (typeof Reflect.get(value, 'writable') !== 'boolean') return false;
  if (typeof Reflect.get(value, 'timeTravel') !== 'boolean') return false;
  for (const optional of ['atomicCutover', 'atomicBatchReplace', 'transactional']) {
    const declared = Reflect.get(value, optional);
    if (declared !== undefined && typeof declared !== 'boolean') return false;
  }
  return true;
}

/**
 * What a store is asked for, once the service has vetted it.
 *
 * `Omit<..., 'filters'>` and not a plain extension, and the omission is the
 * point: `CatalogObjectQuery.filters` is the caller's raw
 * `property:operator:value` text, and a store must never be handed one. What
 * arrives here instead is {@link CatalogResolvedFilter}, whose property is the
 * type's own definition — so the column a predicate is built from came off the
 * type rather than off the request, and the type system says so rather than a
 * comment. `sort` is a bare string only because every store already re-matches it
 * against the type before using it; a filter carries more than a name, so
 * resolving it once in the service is both cheaper and harder to get wrong.
 */
export interface CatalogReadQuery extends Omit<CatalogObjectQuery, 'filters'> {
  /** Read as of a specific snapshot. Ignored when `timeTravel` is false. */
  snapshot?: string;
  /**
   * Every one of these must be applied. A store that cannot apply one must not
   * silently return the rows it would have returned anyway — declare the
   * operators it can honour (see {@link CatalogFilteringReadStore}) and the
   * service will refuse the read instead.
   */
  filters?: CatalogResolvedFilter[];
}

export interface CatalogReadResult {
  rows: Array<Record<string, unknown>>;
  total: number;
  /**
   * Which snapshot these rows came from, and whether it is the one being served.
   *
   * Answered by the store because the store is what resolved it: a read that was
   * given no snapshot falls back to the pointer, so only the store knows which id
   * the rows actually carry. Reporting it costs nothing — every store that keeps
   * history has already read both values by the time it builds the query — and it
   * is what lets a screen say "this is not the current load" on the strength of
   * what was read rather than of what it thinks it asked for.
   *
   * Absent from a store that keeps no history, which is the honest answer there:
   * the rows are the current state and there is no other state to be reading.
   */
  snapshot?: { id: string; current: boolean };
}

/**
 * A store that applies {@link CatalogReadQuery.filters}.
 *
 * Declared, never assumed, and the reason is the same one the capability object
 * one file up gives for every field on it: a store that ignores a filter answers
 * with more rows than were asked for, and there is nothing about that answer to
 * distinguish it from a filter that genuinely matched everything. So a store says
 * which operators it can push into its predicate, the service offers exactly
 * those to the screen, and a filter naming anything else is refused rather than
 * quietly dropped.
 *
 * A guard rather than a field on `CatalogStoreCapabilities`, deliberately: the
 * capability object is intersected by the fan-out through an exhaustiveness check
 * that fails to compile when a field is added and not composed, and this is not a
 * property that composes the way those do — a fan-out reads through its primary,
 * so what its primary can filter is what it can filter. Asking the object it
 * holds is the check that stays true when that changes.
 */
export interface CatalogFilteringReadStore extends CatalogReadStore {
  /** Which operators this store can apply. A subset of `CATALOG_FILTER_OPERATORS`. */
  readonly objectFilterOperators: readonly CatalogFilterOperator[];
}

export function supportsObjectFilters(store: unknown): store is CatalogFilteringReadStore {
  return (
    typeof store === 'object' &&
    store !== null &&
    Array.isArray(Reflect.get(store, 'objectFilterOperators'))
  );
}

/** The minimum a store must do: return rows of a catalogued type. */
export interface CatalogReadStore {
  readonly capabilities: CatalogStoreCapabilities;

  /**
   * `type` carries the visibility and classification decisions already applied,
   * and `fields` is the whitelist the caller vouched for — a store must never
   * return a column outside it, whatever the underlying table holds.
   */
  read(
    type: CatalogObjectTypeDef,
    fields: string[],
    query: CatalogReadQuery,
  ): Promise<CatalogReadResult>;

  listSnapshots?(type: CatalogObjectTypeDef): Promise<SnapshotRef[]>;
}

/**
 * A store that can hand over the whole of one snapshot, a row at a time.
 *
 * ## What this is for, and why `read` was not enough
 *
 * A workflow reading data the catalog already holds. Until this existed the only
 * route was a `sql` connector naming `obj_<type>` — the physical table, which
 * **retains every committed snapshot** — so a graph reading a type with two
 * loads behind it read both, reported success, and doubled every sum while
 * leaving the row count it wrote unchanged. See `CONNECTOR_KINDS`' `'catalog'`
 * entry for the measurement.
 *
 * {@link CatalogReadStore.read} resolves "current" correctly and could be paged.
 * It is not the right tool for a whole dataset, for two separate reasons:
 *
 * - **A page is `LIMIT`/`OFFSET`.** Reading seven million rows in pages makes the
 *   engine walk the offset each time, so the cost is quadratic in the size of
 *   the thing being read. That is not a tuning detail here — the row counts this
 *   feature exists for are exactly the ones that make it fatal.
 * - **Paging is only correct under a total order**, and `read` does not promise
 *   one: a store free to return "some page of the matching rows" would let a
 *   paged loop skip and duplicate rows silently, which is the same class of
 *   failure this whole feature is repairing.
 *
 * ## Optional, and the option is the store's to take
 *
 * Exactly as {@link CatalogQueryStore.streamQuery} is, and for the same reason: a
 * store fronting an API, or one on a driver that buffers a result set before
 * resolving, cannot do this honestly, and a shim that collected every row and
 * yielded them back would satisfy the type while doing the one thing the type
 * exists to avoid. So an absent `streamSnapshot` is a real answer, and the
 * caller refuses out loud rather than falling back to a paged read — a fallback
 * whose two hazards are listed above.
 *
 * The contract on an implementation is one sentence: **do not read ahead of the
 * consumer.** Whatever the driver offers must pause when the consumer stops
 * pulling, all the way to the socket, or the memory has only moved.
 */
export interface CatalogSnapshotStreamStore extends CatalogReadStore {
  /**
   * Every row of one snapshot, keyed by property name.
   *
   * `snapshotId` is required and never defaulted, which is the whole shape of
   * the fix: the caller resolves which snapshot is current — once, when its run
   * starts — and then reads *that one*, so a commit landing mid-read cannot have
   * the first half of a load come from one snapshot and the second half from
   * another. A store with no id to be given has nothing to stream.
   *
   * Keys are property names, matching what {@link CatalogReadStore.read} returns
   * and what the write path looks a field up by (`row[property.name]`), so rows
   * read out of one type can be written into another without a translation step
   * that could disagree with either side.
   *
   * Returned synchronously — an async generator, not a promise for one — so a
   * consumer's `for await` owns the resource from the first pull and an
   * abandoned iteration runs the generator's `finally`.
   */
  streamSnapshot(
    type: CatalogObjectTypeDef,
    fields: string[],
    snapshotId: string,
    options?: SnapshotStreamOptions,
  ): AsyncIterable<Record<string, unknown>>;
}

/** What a snapshot stream may be asked for beside the properties. */
export interface SnapshotStreamOptions {
  /**
   * Also key every row by {@link CATALOG_PROVENANCE_COLUMNS}.
   *
   * **A store that cannot supply them must throw rather than omit them.** The
   * caller this exists for is the snapshot archiver, and it cannot tell a store
   * that declined from a snapshot whose provenance happens to be absent: a
   * missing key encodes as a null, a null verifies against a null, and the
   * archive is complete, checksummed and silently stripped of the only columns a
   * restore could not reconstruct. Silence is the one answer that is not
   * available here.
   */
  provenance?: boolean;
}

/** A store that can stream a whole snapshot. See {@link CatalogSnapshotStreamStore}. */
export function supportsSnapshotStreams(store: unknown): store is CatalogSnapshotStreamStore {
  return (
    typeof store === 'object' &&
    store !== null &&
    typeof Reflect.get(store, 'streamSnapshot') === 'function'
  );
}

/** Where one snapshot id turned out to live. */
export interface CatalogSnapshotLocation {
  /** The object type the snapshot belongs to. */
  typeName: string;
  /** The snapshot itself, tombstone and archive included. */
  snapshot: SnapshotRef;
}

/**
 * A store that can say what a snapshot id refers to, without being told the type.
 *
 * ## Why this is a question and not an inference
 *
 * Because a caller naming a snapshot has exactly one thing — a string — and
 * every wrong answer about it is silent. {@link CatalogReadStore.read} given an
 * id that does not exist returns `{ rows: [], total: 0 }`, which is the same
 * answer it gives for a snapshot that is genuinely empty, for a filter that
 * excluded everything, and for a load that collapsed. Existence cannot be
 * inferred from a count.
 *
 * {@link CatalogReadStore.listSnapshots} answers *most* of it: the snapshot is
 * in the type's list or it is not, and the ref carries {@link
 * SnapshotRef.droppedAt} and {@link SnapshotRef.archive}. What it cannot answer
 * is the third case, and the third case is the one somebody actually hits — an
 * id copied off the wrong type's history, or off a run that loaded something
 * else. "There is no such snapshot" and "that snapshot belongs to
 * AfFleetReplica" send a person to two different places, and only a lookup that
 * is not scoped to one type can tell them apart.
 *
 * A list rather than an option, because ids are caller-supplied: a run that
 * loads two types under one durable run id gives both snapshots the same id, and
 * reporting one of them would be reporting a coin toss.
 *
 * ## Optional, like every other capability here
 *
 * The caller degrades rather than refuses when it is absent — `listSnapshots`
 * still separates missing from tombstoned, and the refusal simply stops claiming
 * to have checked the other types. Adapters are free to skip it; today the only
 * store that implements {@link CatalogSnapshotStreamStore} is the only one that
 * can serve a `catalog` source at all, and it is the one that implements this.
 */
export interface CatalogSnapshotLookupStore extends CatalogReadStore {
  /**
   * Every snapshot in this store carrying `snapshotId`, whatever its type.
   *
   * Empty means no type has one. This is an **identity** question and not a
   * read: it must answer for a tombstoned snapshot exactly as it answers for a
   * live one, because a caller that cannot see the tombstone is a caller that
   * reports it as missing.
   */
  locateSnapshot(snapshotId: string): Promise<CatalogSnapshotLocation[]>;
}

/** A store that can resolve a snapshot id. See {@link CatalogSnapshotLookupStore}. */
export function supportsSnapshotLookup(store: unknown): store is CatalogSnapshotLookupStore {
  return (
    typeof store === 'object' &&
    store !== null &&
    typeof Reflect.get(store, 'locateSnapshot') === 'function'
  );
}

/** A store that owns its copy of the data and can be loaded into. */
export interface CatalogWriteStore extends CatalogReadStore {
  /**
   * Make the physical target match the object type. For a row store this is
   * DDL; for a file-backed format it may be a no-op.
   *
   * Separate from `write` on purpose: schema change and data load have very
   * different blast radii, and a caller may want the first reviewed and the
   * second automatic.
   */
  ensureType(type: CatalogObjectTypeDef): Promise<void>;

  /**
   * Write a batch belonging to `snapshotId`.
   *
   * Idempotent per `(type, snapshotId, batch)` — a re-sent batch replaces
   * itself rather than adding a second copy. This is not a nicety: a durable
   * step that retries restarts from the top and re-sends every batch, so an
   * append-only write silently doubles the load, and the only symptom is a row
   * count that looks plausible.
   *
   * **`written` is rows-accepted-by-this-call, never rows-in-the-snapshot.** It
   * counts how many of the `rows` handed in this call the store took under
   * `(snapshotId, batch)`. It does not include the batches that came before it,
   * the rows a `carryForward` copied in, or the rows a re-sent batch displaced.
   *
   * Written down because both readings look reasonable and they diverge exactly
   * where it hurts. Two things depend on this one:
   *
   * - A caller that sums `written` across the batches of a load gets the rows
   *   that load produced. Under the other reading it would get a running total
   *   summed again per batch, which grows quadratically and looks merely large.
   * - A fan-out that writes the same batch to a primary and a follower compares
   *   the two numbers and treats a difference as a follower that lost rows.
   *   That comparison is only meaningful because both sides are counting the
   *   same handful of rows they were just given; against snapshot totals it
   *   would report a false mismatch every time the two stores disagreed about
   *   anything earlier in the load, including a carry-forward.
   *
   * The snapshot's own total is a different question with its own answers:
   * {@link commit} returns it on the `SnapshotRef`, and {@link
   * CatalogMergeStore.carryForward} returns it as `total`.
   */
  write(
    type: CatalogObjectTypeDef,
    rows: Array<Record<string, unknown>>,
    options: {
      snapshotId: string;
      principalId: string;
      /** Batch index within this load. Defaults to 0, which is still stable. */
      batch?: number;
      labels?: Record<string, string>;
    },
  ): Promise<{ written: number }>;

  /**
   * Make a snapshot the one readers get by default. Until this is called, a
   * half-written load must stay invisible — otherwise a crash mid-load is
   * indistinguishable from a completed one that happened to lose rows.
   */
  commit(type: CatalogObjectTypeDef, snapshotId: string): Promise<SnapshotRef>;

  /**
   * Drop a snapshot's rows. Refuses the currently-committed one.
   *
   * **The rows, and not necessarily the record.** A store that keeps a snapshot
   * list should keep the entry and mark it {@link SnapshotRef.droppedAt} rather
   * than removing it, because the entry is what makes a connector run that
   * names this snapshot still answerable — see that field for the argument in
   * full. A store whose record and rows are the same object has nothing to
   * keep, and reports no `droppedAt` because it has none to report.
   *
   * Idempotent: dropping a snapshot whose rows are already gone is a no-op that
   * leaves the original drop time standing, so a retried step does not rewrite
   * history to the moment of its retry.
   *
   * Two refusals follow from a tombstone existing, and both belong to the store
   * because it is the only thing that can see the state: a tombstoned snapshot
   * may not be {@link commit}ted — that is exactly how a published type comes to
   * serve nothing — and a read of one must fail rather than return zero rows.
   */
  dropSnapshot(type: CatalogObjectTypeDef, snapshotId: string): Promise<void>;

  /**
   * Which snapshot this store is serving for `type`, or `undefined` when it has
   * never committed one.
   *
   * **Why this and not a `committed` flag on `SnapshotRef`.** The flag was the
   * other candidate and it answers a different question. `committed` is true of
   * every snapshot that was ever blessed, not of the one being served, and the
   * two come apart precisely when somebody is relying on the difference: rolling
   * a bad load back means committing an *older* snapshot, after which the newest
   * committed snapshot and the current one are not the same row. A caller
   * reconstructing "current" from a list of committed refs would order by
   * `createdAt` and confidently name the load that was just rolled back. So the
   * store is asked for the pointer it actually reads, because it is the only
   * thing that has it.
   *
   * **Optional, and the fallback is bad enough to be worth stating.** Making it
   * required would break every adapter compiled against an earlier version of
   * this interface, including ones this repository does not own. A caller that
   * finds it absent has only `listSnapshots`, which reports what has been
   * written and does not distinguish committed from half-written — so the
   * fallback is "newest snapshot in the list", and that is a guess. Guessing is
   * survivable for a status screen and is not survivable for the thing this
   * method was asked for, which is a replay deciding whether to commit a
   * repaired snapshot on a follower: guess wrong and the follower is pointed at
   * last week's data, silently, with a full set of plausible rows in it. A
   * caller that cannot get a real answer should refuse and say so rather than
   * commit on a guess.
   */
  currentSnapshot?(type: CatalogObjectTypeDef): Promise<SnapshotRef | undefined>;
}

/** What a carry-forward did. */
export interface CarryForwardResult {
  /**
   * The snapshot the rows were copied out of. Absent when the type had nothing
   * committed yet, which makes this load the whole of the state rather than an
   * addition to it.
   */
  from?: string;
  /** Rows copied out of `from` because nothing in this load replaced them. */
  carried: number;
  /** What the snapshot holds now: the carried rows plus the load's own. */
  total: number;
}

/**
 * A store that can finish a partial load into a complete snapshot.
 *
 * **The decision this interface encodes.** An incremental load — one that reads
 * only what changed since the last run — forks the snapshot model, and the fork
 * has to be picked once and lived with:
 *
 * - **A snapshot stays the complete state.** The run writes only the rows that
 *   changed, then copies the previous snapshot's surviving rows in beside them.
 *   Reading is still `WHERE _snapshot_id = X`, time travel is still picking a
 *   different X, and the view a query selects from is still one predicate over
 *   one table. The cost is the copy.
 * - **A snapshot becomes a delta.** The write is cheap, and everything else gets
 *   harder: every read has to union snapshots back to the last full one, the
 *   view stops being a filter and becomes a recursive assembly, and time travel
 *   turns into a replay whose answer depends on how far back the chain is
 *   intact.
 *
 * This library takes the first. Reads and time travel staying trivial is worth
 * a copy that happens once per run, and the second choice would push the merge
 * into every reader — including the ad-hoc SQL people type into the query
 * screen, which is exactly the place a subtle wrong answer never gets caught.
 *
 * The merge key is the object type's primary key. A type without one cannot be
 * merged at all, and implementations must say so rather than fall back to a
 * full reload or append blindly: a load that appears to succeed while making
 * the data meaningless is the worst outcome available here.
 */
export interface CatalogMergeStore extends CatalogWriteStore {
  /**
   * Copy the previously committed snapshot's rows into `snapshotId`, letting
   * the rows already written there replace the ones they match on the primary
   * key.
   *
   * **Order matters, and there is only one order.** For an incremental load:
   *
   * 1. `write()` every batch of the run, numbered as usual;
   * 2. `carryForward()` exactly once, *after* the last batch;
   * 3. `commit()`.
   *
   * Step 2 is last because the merge is decided against the batches that exist
   * when it runs — a row written afterwards has nothing to displace, so the old
   * version of it stays and the snapshot ends up holding both. Implementations
   * are expected to notice that case and refuse the commit rather than serve
   * it, because two versions of one object under one primary key is precisely
   * the state the snapshot model promises cannot happen.
   *
   * Safe to call twice with the same arguments: a second call throws away what
   * the first copied and recomputes it. That is not a nicety either — the same
   * durable retry that re-sends every batch re-runs this too.
   */
  carryForward(
    type: CatalogObjectTypeDef,
    snapshotId: string,
    options: {
      /** Attribution for the snapshot, when this call is what creates it. */
      principalId: string;
      labels?: Record<string, string>;
    },
  ): Promise<CarryForwardResult>;
}

/**
 * The columns a snapshot-emulating store adds to every object table.
 *
 * Every store in this ecosystem that keeps history in a column keeps it in
 * these, and they are named here rather than in each adapter for one reason:
 * they are part of what the catalog promises a *reader*. The SQL console
 * documents `_snapshot_id` and `_batch` in its relation list, ad-hoc queries
 * filter on them, and a type whose own properties landed in them would make
 * every one of those queries wrong. A publisher deciding whether a property
 * name is safe should be able to read the answer out of the contract instead of
 * out of whichever adapter happens to be mounted.
 *
 * A store that lays its bookkeeping out differently is free to ignore this
 * list; it is the ecosystem's convention, not a requirement on the interface.
 */
export const CATALOG_RESERVED_COLUMNS = [
  '_snapshot_id',
  '_principal_id',
  '_loaded_at',
  '_batch',
  '_row',
] as const;

export type CatalogReservedColumn = (typeof CATALOG_RESERVED_COLUMNS)[number];

export function isReservedColumn(column: string): boolean {
  return CATALOG_RESERVED_COLUMNS.some((reserved) => reserved === column.toLowerCase());
}

/**
 * The two reserved columns that outlive the load that wrote them.
 *
 * ## The question this answers, and it was asked of all five
 *
 * Which of {@link CATALOG_RESERVED_COLUMNS} does something *read* off a snapshot
 * that is already committed? A copy of a snapshot — an archive, a replica, a
 * restore — has to carry exactly those and nothing else, and the answer is not
 * the one the names suggest.
 *
 * - **`_principal_id` and `_loaded_at` are read, by the merge, off the snapshot
 *   it is merging against.** {@link CatalogMergeStore.carryForward} copies both
 *   across untouched onto every row it carries, deliberately: a carried row is
 *   not a new load of that row, so restamping them would erase the one thing
 *   they are good for, which is saying when a value last actually moved and who
 *   moved it. They are therefore the only two whose loss *propagates* — every
 *   later incremental snapshot inherits whatever a restore put there, and it
 *   inherits it forever.
 * - **`_batch` is not.** It is read constantly *during* a load — a re-sent batch
 *   replaces itself by `WHERE _snapshot_id = ? AND _batch = ?`, and a merge
 *   excludes its own output by it — and once the snapshot commits nothing reads
 *   it again. In particular `carryForward` does *not* read the previous
 *   snapshot's `_batch`: it joins on the primary key and copies the properties,
 *   and its own `_batch` predicate applies only to the snapshot being built. The
 *   marker it leaves (`-1`, "carried forward") is a record that a merge happened,
 *   never an input to the next one. A copy that drops it loses a line of
 *   provenance in the SQL console and loses nothing a later load consults —
 *   and the write path could not accept it back regardless, since
 *   {@link CatalogWriteStore.write} refuses a negative batch by name.
 * - **`_snapshot_id` is one value for the whole snapshot**, so a per-row copy of
 *   it is N copies of a string the copy is already named after.
 * - **`_row` is the order**, not a value. A copy that preserves the order
 *   preserves everything the column carries; the numbers themselves are an
 *   engine's auto-increment and are not stable across a rewrite anyway.
 *
 * Kept here rather than in the archiver that needed it, because it is a fact
 * about the store interface — about which columns {@link
 * CatalogMergeStore.carryForward} reads — and anything else that copies a
 * snapshot needs the same answer.
 */
export const CATALOG_PROVENANCE_COLUMNS = ['_principal_id', '_loaded_at'] as const;

export type CatalogProvenanceColumn = (typeof CATALOG_PROVENANCE_COLUMNS)[number];

/**
 * The whole naming rule, which used to be written out here.
 *
 * `isSafeIdentifier` and friends, the {@link physicalColumn} cleaning and the
 * {@link outputAlias} it feeds all moved to `catalog.identifiers.ts` — a file
 * that imports nothing — and are re-exported here so that every caller that
 * reached them from this module still does.
 *
 * The move was not tidying. This file imports `BadRequestException` at module
 * scope, so a browser importing a *value* from it would pull NestJS into its
 * bundle, and a console proposing to replicate a table has to be able to ask,
 * before it draws anything, whether the source's column spellings could be
 * published as property names. The question a publisher is refused on is
 * `isSafeIdentifier(physicalColumn(name))`, so both halves had to become
 * reachable from `/client`, answered by the same two functions the DDL runs
 * rather than by a copy of either. See the docblock on `catalog.identifiers.ts`.
 *
 * A bare `export … from` and not `import` + `export`, which is safe here for a
 * reason worth writing down: nothing left in this file *calls* any of them.
 * A re-export forwards a name without binding it locally, and while `outputAlias`
 * still lived here — one line, calling `isSafeIdentifier` — that difference was
 * a `ReferenceError` at the first read of any type, compiled and shipped by a
 * rebase that had nothing to conflict on. Adding a caller here means turning
 * this back into an import.
 */
export {
  assertSafeIdentifier,
  isSafeIdentifier,
  outputAlias,
  physicalColumn,
  UnsafeIdentifierError,
} from './catalog.identifiers';

/** One property, and the column it cannot have. */
export interface CatalogColumnCollision {
  /** `reserved` — it lands on a store column. `shared` — two properties collide. */
  kind: 'reserved' | 'shared';
  /** The physical column both sides want. */
  column: string;
  /** The property names involved, in declaration order. */
  properties: string[];
}

export interface ColumnCollisionOptions {
  /**
   * Whether the engine considers two column names differing only in case to be
   * the same column. MySQL does; ClickHouse does not.
   *
   * Defaults to false, the narrower reading, so a store on a case-sensitive
   * engine is never handed a refusal for a pair of columns it could genuinely
   * have kept apart. A store that folds case passes true and gets the wider
   * check it needs.
   */
  foldsColumnCase?: boolean;
  /** Named in the message, so a fan-out's refusal says which store refused. */
  store?: string;
}

/**
 * Every way a type's properties would fight over a physical column.
 *
 * Both kinds come from the same place: the property name a publisher chose is
 * not a column name, so every store maps it — stripping the characters a column
 * cannot have, and cutting it to whatever the engine's identifier limit is. The
 * mapping is therefore lossy, and two things fall out of that.
 *
 * `Asset NSN` and `Asset/NSN` are different properties and one column. So are a
 * pair of generated names that agree for their first sixty characters, which
 * sounds unlikely until a publisher emits `metrics_by_installation_and_...`.
 *
 * And a property genuinely called `_batch`, or one called `_ batch` that cleans
 * to the same thing, lands on a column the store keeps its own bookkeeping in.
 */
export function findColumnCollisions(
  type: CatalogObjectTypeDef,
  toColumn: (propertyName: string) => string,
  options?: ColumnCollisionOptions,
): CatalogColumnCollision[] {
  const fold = (column: string): string =>
    options?.foldsColumnCase === true ? column.toLowerCase() : column;

  const byColumn = new Map<string, { column: string; properties: string[] }>();
  for (const property of type.properties) {
    const column = toColumn(property.name);
    const key = fold(column);
    const entry = byColumn.get(key) ?? { column, properties: [] };
    entry.properties.push(property.name);
    byColumn.set(key, entry);
  }

  const collisions: CatalogColumnCollision[] = [];
  for (const [key, entry] of byColumn) {
    // Reserved first, and reported instead of the shared case rather than
    // beside it: two properties that both land on `_batch` have a worse problem
    // than each other, and naming that one twice would bury it.
    if (isReservedColumn(key)) {
      collisions.push({
        kind: 'reserved',
        column: entry.column,
        properties: entry.properties,
      });
      continue;
    }
    if (entry.properties.length > 1) {
      collisions.push({
        kind: 'shared',
        column: entry.column,
        properties: entry.properties,
      });
    }
  }
  return collisions;
}

/** What {@link assertNoColumnCollisions} throws, so a caller can catch it by type. */
export class CatalogColumnCollisionError extends BadRequestException {
  constructor(
    readonly typeName: string,
    readonly collisions: CatalogColumnCollision[],
    message: string,
  ) {
    super(message);
  }
}

/**
 * Refuse a type whose properties cannot each have a column of their own.
 *
 * Called by a store before it emits DDL. Every engine this has been tried on
 * *does* fail on its own — MySQL raises "Duplicate column name" on the CREATE
 * TABLE and "Column specified twice" on an INSERT into an existing table — so
 * this is not preventing silent corruption in those cases, with one exception:
 * a property that lands on a reserved column of a store that adds that column
 * separately from the declared ones would be written to happily, and every
 * retry and every incremental merge from then on would replace the wrong rows.
 *
 * What it buys for the loud cases is the only thing they are missing, which is
 * a name. A driver error names the column — and the column is the *derived*
 * name, so the person reading it has to work backwards through a mapping they
 * have never seen to find which two of their forty properties produced it. This
 * says which properties, what they collided over, and what to do, at the moment
 * the type is published rather than on the first load.
 */
export function assertNoColumnCollisions(
  type: CatalogObjectTypeDef,
  toColumn: (propertyName: string) => string,
  options?: ColumnCollisionOptions,
): void {
  const collisions = findColumnCollisions(type, toColumn, options);
  if (collisions.length === 0) return;

  const where = options?.store ? ` in ${options.store}` : '';
  const described = collisions.map((collision) =>
    collision.kind === 'reserved'
      ? `${collision.properties.join(' and ')} would be stored in ${collision.column}, which the store keeps for itself`
      : `${collision.properties.join(' and ')} would both be stored in ${collision.column}`,
  );

  throw new CatalogColumnCollisionError(
    type.name,
    collisions,
    `${type.name} cannot be stored${where} as declared: ${described.join('; ')}. Property names are mapped to columns by replacing anything that is not a letter, digit or underscore and cutting the result to the engine's identifier limit, so two different names can arrive at one column. Rename the ${
      collisions.some((collision) => collision.properties.length > 1)
        ? 'properties so they differ in more than punctuation or length'
        : 'property'
    }. The reserved columns are ${CATALOG_RESERVED_COLUMNS.join(', ')}.`,
  );
}

export function isWriteStore(store: CatalogReadStore): store is CatalogWriteStore {
  return store.capabilities.writable && 'write' in store;
}

/**
 * Asked rather than assumed, so a store that cannot merge produces a refusal at
 * the point of the incremental load instead of a snapshot that quietly contains
 * only the rows that happened to change.
 */
export function supportsCarryForward(store: CatalogWriteStore): store is CatalogMergeStore {
  return 'carryForward' in store;
}

export const CATALOG_STORE = Symbol('CATALOG_STORE');
