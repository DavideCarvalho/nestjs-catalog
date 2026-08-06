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

  /** Drop a snapshot. Refuses the currently-committed one. */
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
 * The identifier rule, which used to be written out here.
 *
 * It moved to `catalog.identifiers.ts` — a file that imports nothing — and is
 * re-exported here so that every caller that reached it from this module still
 * does. The move was not tidying: this file imports `BadRequestException` at
 * module scope, so a browser importing a *value* from it would pull NestJS into
 * its bundle, and the canvas now has to be able to ask whether a source's column
 * names can be property names before it draws a graph that would commit nulls.
 * That question has to be answered by the same function the DDL asks, not by a
 * copy of the pattern. See the docblock on `catalog.identifiers.ts` for the
 * whole argument.
 */
export {
  assertSafeIdentifier,
  isSafeIdentifier,
  UnsafeIdentifierError,
} from './catalog.identifiers';

/**
 * A property's name, cleaned into the column a store can create for it.
 *
 * Here rather than in each adapter for the reason {@link assertSafeIdentifier}
 * is: this is no longer only an adapter's private repair. It decides the column
 * a load's values are written to, the column a filter is applied to, the name a
 * committed view exposes the field under, and — since it does all of that — it
 * decides whether a published name can work at all. The pipeline package refuses
 * a name at publish time by asking whether *this* produces an identifier, so the
 * refusal and the DDL have to be running the same cleaning rather than two
 * copies of it. `store-mikro-orm` and `store-clickhouse` each carried a
 * byte-identical private copy, and `store-mikro-orm` carried two of its own —
 * one in `query.ts` for the view, one in `mysql-warehouse.store.ts` for
 * everything else. Three copies of the function that decides where a column's
 * data lives is three chances for a view to point at a column no load ever
 * wrote.
 *
 * Lossy on purpose, and lossy in a way callers must handle rather than assume
 * away: `Asset Id` and `Asset/Id` both clean to `Asset_Id`, which is what
 * {@link assertNoColumnCollisions} exists to catch.
 *
 * 60 characters, not the 63 the identifier rule allows, and the three characters
 * of headroom are not decorative — a store that needs to derive a second name
 * from a column has room inside MySQL's 64-character ceiling to do it. Widening
 * this would silently rename the column of every property whose name is 61 to 63
 * characters long, so it stays where it is.
 *
 * Not every output is an identifier: `1 2 3` cleans to `1_2_3`, which no store
 * will quote. That is not this function's business to fix — a suggestion is
 * `toPhysicalName` in an adapter, and a refusal is `assertSafeIdentifier` on the
 * result.
 */
export function physicalColumn(propertyName: string): string {
  return propertyName
    .replace(/[^A-Za-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 60);
}

/**
 * The column name a store exposes a property under, in the committed view and
 * in the SELECT list of a read.
 *
 * **Why this is not simply the property's name.** It used to be. Every store
 * wrote `\`Asset_Id\` AS \`Asset Id\`` — the physical column reached by cleaning,
 * the alias taken verbatim — and the alias went through `ident`, which refuses
 * rather than escapes. So a property could only be named something that was
 * already a SQL identifier, which meant a source column genuinely called `Asset
 * Id` could not be published under its own spelling.
 *
 * That mattered far more than it looks. A load matches a source's record to a
 * property by property NAME — the store reads `row[property.name]` — so a
 * publisher forced to rename the property to `Asset_Id`, keeping `Asset Id` in
 * `columnName`, was publishing a type whose every read of that field returned
 * `undefined`. `columnName` is lineage; nothing consults it on the write path.
 * The loads committed, the row counts were right, and the column was NULL in
 * every row. Thirteen types were loaded that way and six of them came out with
 * most of their columns empty — 73 of 84 on the largest, across 313,833 rows.
 * The verbatim alias is what forced the rename, so the alias is what changed.
 *
 * **Why the name is still kept when it is already an identifier.** The obvious
 * fix — always alias to {@link physicalColumn} — would rename the output column
 * of every existing view whose property name is not equal to its own cleaned
 * form: a property called `Asset__Id` (two underscores collapse to one) or one
 * 61 characters long (cut to 60). Those views work today and somebody is
 * selecting from them by name. Renaming a column under a working consumer to
 * tidy up an inconsistency is not a trade worth making, so the rule is the
 * narrower one: **a name that SQL can take as it stands is kept exactly; only a
 * name SQL cannot take is cleaned.** Every view that resolves today keeps every
 * column name it has today.
 *
 * **This introduces no new way for two properties to collide.** If two distinct
 * names produce one alias then they also produce one {@link physicalColumn}, so
 * {@link assertNoColumnCollisions} already refuses the pair. Both unsafe: equal
 * aliases *are* equal physical columns. Both safe: equal aliases are equal
 * names, and there is only one property per name. One of each — a safe `x` and
 * an unsafe `y` with `physicalColumn(y) === x` — means `x` contains no run of
 * underscores and is at most 60 characters, so `physicalColumn(x) === x ===
 * physicalColumn(y)` and the columns collide too.
 */
export function outputAlias(propertyName: string): string {
  return isSafeIdentifier(propertyName) ? propertyName : physicalColumn(propertyName);
}

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
