import {
  type CatalogObjectTypeDef,
  type CatalogOverlay,
  CatalogRegistry,
  type CatalogRelationDef,
  type CatalogSnapshot,
  type RelationKind,
  type ScalarType,
  curationActor,
  emitCatalog,
} from '@dudousxd/nestjs-catalog';
import type { MikroORM } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/mysql';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { CATALOG_STORE_ENTITY_MANAGER, CATALOG_STORE_MIKRO_ORM } from './context';
import { SnapshotRow } from './entities/governance';
import { ObjectTypeRow, PropertyRow, type StoredRelation, relationsOf } from './entities/model';
import { CATALOG_STORE_OPTIONS, type CatalogStoreModuleOptions } from './options';
import { ensureCatalogSchema } from './schema';

const SCALARS: ScalarType[] = ['string', 'number', 'boolean', 'date', 'json', 'uuid', 'unknown'];

function toScalar(value: string): ScalarType {
  const found = SCALARS.find((s) => s === value);
  return found ?? 'unknown';
}

/**
 * The `id` out of a raw driver row, or undefined if it is not there.
 *
 * A guard rather than a cast because the driver's return type is genuinely
 * unknown — `execute` hands back whatever the server sent — and the alternative
 * is asserting a shape that a renamed column would make a lie at runtime while
 * still compiling. `Reflect.get` rather than indexing, so narrowing `value` to
 * an object is enough and no index signature has to be invented for it.
 */
function idOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const id = Reflect.get(value, 'id');
  return typeof id === 'string' ? id : undefined;
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined;
}

/** See {@link CatalogStoreModuleOptions.staleAfterMs}. */
const DEFAULT_STALE_AFTER_MS = 1_000;

/**
 * How the model tables look right now, in five numbers.
 *
 * Counts *and* maxima, because neither alone is enough: a rename moves no count,
 * and a type deleted and another published inside one second can leave the
 * maximum where it was. `db_now` is the database's own clock rather than this
 * process's — see {@link settledAt}, and note that clock skew between a pod and
 * the database would otherwise decide correctness.
 *
 * Table and column names are written out rather than derived from metadata,
 * matching `servingSnapshots` below and `audit-recorder.service.ts`. All three
 * assume MikroORM's underscored naming strategy, which this package's entities
 * are declared against.
 */
const WATERMARK_SQL = `SELECT
       (SELECT COUNT(*)        FROM catalog_object_type) AS type_rows,
       (SELECT MAX(updated_at) FROM catalog_object_type) AS type_at,
       (SELECT COUNT(*)        FROM catalog_property)    AS property_rows,
       (SELECT MAX(updated_at) FROM catalog_property)    AS property_at,
       NOW() AS db_now`;

/**
 * The columns of {@link WATERMARK_SQL} that make up the watermark itself.
 *
 * `db_now` is deliberately not among them. It moves on its own, so folding it
 * into the key would make every single read look like a change and turn the
 * cheap check into an unconditional reload.
 */
const WATERMARK_COLUMNS = ['type_rows', 'type_at', 'property_rows', 'property_at'];

/** What one process knows about the state of the model in the database. */
interface Watermark {
  /** Equal to the last one means nothing has been written since. */
  readonly key: string;
  /**
   * Whether the key can still change without the model changing. See
   * {@link settledAt}.
   */
  readonly settled: boolean;
}

/**
 * One column of a raw driver row, normalised to a comparable string.
 *
 * `undefined` when the column is absent, which is a different answer from `''`:
 * absent means the statement did not return what this file asked for and no
 * watermark can be formed at all, whereas `''` is a perfectly ordinary `MAX()`
 * over a table with no rows in it.
 *
 * A guard rather than a cast, for the reason {@link idOf} gives — and with an
 * extra one here, since the shapes really do vary: `COUNT(*)` arrives as a
 * number or as a string depending on the driver's big-number settings, and a
 * `DATETIME` as a `Date` or as a string depending on `dateStrings`. Every one of
 * those is stable across reads of an unchanged table, which is all a watermark
 * needs.
 */
function cell(row: unknown, column: string): string | undefined {
  if (typeof row !== 'object' || row === null) return undefined;
  const value = Reflect.get(row, column);
  if (value === undefined) return undefined;
  if (value === null) return '';
  if (value instanceof Date) return String(value.getTime());
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  return undefined;
}

/**
 * One column of a raw driver row as an instant, or undefined if it cannot be
 * read as one.
 *
 * Only ever used to subtract two columns of the SAME row from each other, which
 * is what makes the sloppiness of `Date.parse` on a MySQL `DATETIME` literal
 * (`2026-08-05 09:00:00`, which V8 reads as local time) harmless: both operands
 * are misread by the same offset and the difference survives it.
 */
function instant(row: unknown, column: string): number | undefined {
  if (typeof row !== 'object' || row === null) return undefined;
  const value = Reflect.get(row, column);
  if (value instanceof Date) return value.getTime();
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value.replace(' ', 'T'));
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Whether a watermark can be trusted not to change again without the model
 * changing.
 *
 * `updated_at` is a `DATETIME`, which MySQL stores to the second. Two writes
 * inside one second therefore share a maximum, and if a process reads the
 * watermark between them it records a key that the second write will not move —
 * so that write would stay invisible to it forever. This is the same
 * second-resolution trap the `committedAt` tie-breaking note on
 * {@link StoredCatalogRegistry.servingSnapshots} describes, in its other form.
 *
 * The fix is to notice, not to widen the column: a watermark whose newest write
 * is in the second the database is still *in* is provisional, and the caller
 * records nothing rather than recording something it may have to disbelieve.
 * The cost is bounded and small — at most one extra rebuild per write, because
 * the following check happens at least `staleAfterMs` later and the second has
 * closed by then.
 *
 * Unreadable clocks answer `true`, deliberately. This is a refinement over the
 * count-and-maximum comparison, and a driver that hands back a shape these
 * helpers cannot parse should degrade to that comparison rather than to a
 * process that rebuilds its whole model on every check forever.
 */
function settledAt(row: unknown): boolean {
  const now = instant(row, 'db_now');
  if (now === undefined) return true;
  const written = [instant(row, 'type_at'), instant(row, 'property_at')].filter(isPresent);
  if (written.length === 0) return true;
  return now - Math.max(...written) >= 1_000;
}

const RELATION_KINDS: RelationKind[] = ['1:1', '1:m', 'm:1', 'm:n'];

/**
 * Narrow a stored kind, the same way {@link toScalar} narrows a stored type.
 *
 * `m:1` is the fallback rather than a throw, because the alternative to a
 * best-guess kind is a catalog that refuses to load over one bad row written by
 * a publisher nobody can reach right now. The kind decides an arrowhead; the
 * link itself is still true.
 */
function toRelationKind(value: string): RelationKind {
  const found = RELATION_KINDS.find((kind) => kind === value);
  return found ?? 'm:1';
}

/**
 * The model, read from our own tables rather than reflected off entity classes.
 *
 * Held in memory and rebuilt on write. The whole model is a few hundred rows
 * and every read of every object type consults it, so paying a query per
 * request to re-read something that changes a handful of times a day would be
 * the wrong trade.
 *
 * **Which makes "on write" the interesting word, once there are two replicas.**
 * A write rebuilds the model of the one process that handled the request. Its
 * siblings keep serving what they loaded at boot, so a published type exists for
 * part of the traffic and does not exist for the rest, and which a caller gets
 * is load-balancer luck. That is not a race with a small window: it lasts until
 * the stale process happens to serve a write itself, or restarts.
 *
 * So the model is also **self-healing**, and the mechanism deliberately involves
 * no writer at all. Writers are the wrong place: an invalidation every write
 * path has to remember is correct exactly until somebody adds one that forgets,
 * and a model that is quietly a day out of date reports no error. Instead each
 * process re-reads a cheap {@link Watermark} over the two model tables —
 * something every replica already reaches, and which the rows themselves move —
 * and rebuilds when it has moved. A process that never writes anything converges
 * on its own; so does one whose sibling was updated by a code path this file has
 * never heard of. See {@link StoredCatalogRegistry.refreshIfDue} for the cost
 * and `CatalogStoreModuleOptions.staleAfterMs` for the knob.
 *
 * Presentation edits land in the same rows the publisher wrote. There is no
 * separate overlay here, unlike the in-app library: the publisher's values
 * arrive over HTTP and are already just data, so a curator editing them is
 * editing the same column. What keeps a re-publish from stomping a curator's
 * work is that `upsertType` only fills in labels it has not seen before.
 *
 * Nothing about a link is derivable here and nothing ever will be: there are no
 * entity classes and no foreign keys — every published type lands as a flat
 * snapshot — so what a `@ManyToOne` says in the owning application has to arrive
 * over the wire or be asserted by a curator. The one thing this must not do is
 * guess. A `base_id` column beside a type called `Base` is a strong hint and a
 * bad edge: an ontology that invents joins is worse than one with none, because
 * the invented ones are indistinguishable from the real ones. Once the links are
 * in the snapshot, though, drawing them is the same job everywhere — which is
 * why the graph is built by the base class rather than here.
 */
@Injectable()
export class StoredCatalogRegistry extends CatalogRegistry implements OnModuleInit {
  private readonly logger = new Logger(StoredCatalogRegistry.name);
  private snapshot: CatalogSnapshot = emptySnapshot();
  /**
   * The watermark the current {@link snapshot} was built from, when it is one
   * that can be compared against later. Undefined means "cannot claim to be
   * current" — at boot, after a read that failed, and after a read taken inside
   * the second of its own newest write ({@link settledAt}) — and the next check
   * rebuilds rather than assuming.
   */
  private watermark?: string;
  /** When the database was last asked whether {@link watermark} still holds. */
  private lastCheckedAt = 0;
  /** Whether a check is in flight. See {@link refreshIfStale}. */
  private refreshing = false;
  /** So an unreadable watermark is reported once, not once per window. */
  private warnedAboutWatermark = false;

  constructor(
    // Both by token rather than positionally. `this.orm` is the one that really
    // must not be the host's: `ensureCatalogSchema` runs `schema.update()` on
    // it, so resolving the wrong connection would point this package's schema
    // management at somebody else's tables.
    @Inject(CATALOG_STORE_ENTITY_MANAGER)
    private readonly em: EntityManager,
    @Inject(CATALOG_STORE_MIKRO_ORM)
    private readonly orm: MikroORM,
    @Inject(CATALOG_STORE_OPTIONS)
    private readonly options: CatalogStoreModuleOptions,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    // Here rather than in a module hook: this is the first thing that reads the
    // tables, and Nest does not promise that a module's own onModuleInit runs
    // before its providers'. Making the reader responsible for the schema it
    // reads removes the ordering question entirely.
    if (this.options.autoSchema !== false) {
      await ensureCatalogSchema(this.orm);
    }
    await this.reload();
    // Relations in the boot line for the same reason the in-app registry prints
    // them: a wire that stopped carrying links shows up here as a zero, and
    // nowhere else until somebody opens the graph and finds it bare.
    this.logger.log(
      `Catalog loaded: ${this.snapshot.stats.types} object types, ${this.snapshot.stats.properties} properties, ${this.snapshot.stats.relations} relations`,
    );
  }

  async reload(): Promise<void> {
    const em = this.em.fork();
    // The watermark BEFORE the rows it will label, and the order is the whole
    // safety argument. Read afterwards, it could describe a write that landed
    // *during* the reads below — the model would then be one write behind a
    // watermark claiming to cover it, and nothing would ever look again. Read
    // first, the error can only go the other way: a write that slips in between
    // is not covered by the recorded key, so the next check sees a difference
    // and rebuilds once more. One redundant rebuild is a cost; a permanently
    // stale replica is the bug this exists to end.
    const mark = await this.readWatermark(em);
    const rows = await em.find(
      ObjectTypeRow,
      {},
      { populate: ['properties'], orderBy: { group: 'asc', displayName: 'asc' } },
    );

    const serving = await this.servingSnapshots(em);
    // Every published name, before any type is built. Whether a link's other end
    // exists is a fact about the catalog rather than about the type holding the
    // link, so it cannot be answered while the catalog is half-assembled.
    const published = new Set(rows.map((row) => row.name));
    const types = rows.map((row) => this.toDef(row, published, serving.get(row.name)));
    this.snapshot = {
      version: this.snapshot.version + 1,
      generatedAt: new Date().toISOString(),
      stats: {
        types: types.length,
        properties: types.reduce((n, t) => n + t.properties.length, 0),
        relations: types.reduce((n, t) => n + t.relations.length, 0),
        enrichedTypes: types.filter((t) => t.enriched).length,
      },
      types,
    };
    this.watermark = mark?.settled === true ? mark.key : undefined;
    // Stamped here too, not only in `refreshIfDue`: this process has just read
    // the model, so a check a millisecond later would be asking a question it
    // already has the answer to. Without this, every write — which ends in a
    // `reload()` and then a `getType()` — would be followed by a pointless
    // round trip.
    this.lastCheckedAt = Date.now();
  }

  getSnapshot(): CatalogSnapshot {
    this.refreshIfDue();
    return this.snapshot;
  }

  getType(name: string): CatalogObjectTypeDef | undefined {
    this.refreshIfDue();
    return this.snapshot.types.find((t) => t.name.toLowerCase() === name.toLowerCase());
  }

  /**
   * Start a staleness check if one is due, and **serve the current snapshot
   * either way**.
   *
   * Both halves of that sentence are load-bearing.
   *
   * *Serve either way*, because these two methods are the hot path — every
   * browse, every publish, every connector preflight goes through them — and
   * their signatures are synchronous in `CatalogRegistry`, so there is no
   * version of this that awaits anything. Nor should there be: a database round
   * trip per call would trade a correctness bug for a performance one, on a
   * package whose whole premise is that it must not degrade the application it
   * is mounted inside. The check runs on its own; the caller is handed the
   * snapshot that was already in memory.
   *
   * *If one is due*, because the rate has to be bounded by time rather than by
   * traffic. What a call costs is one subtraction and one comparison. What the
   * database sees is at most one small statement per `staleAfterMs` per process
   * — the same under ten requests a second as under ten thousand.
   *
   * The window is stamped **before** the check runs rather than after it
   * finishes, so a slow or failing database cannot turn every arriving request
   * into another attempt. A check that takes three seconds is one check, not a
   * queue of them.
   */
  private refreshIfDue(): void {
    const staleAfterMs = this.options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    if (staleAfterMs <= 0) return;
    const now = Date.now();
    if (now - this.lastCheckedAt < staleAfterMs) return;
    this.lastCheckedAt = now;
    void this.refreshIfStale();
  }

  /**
   * Read the watermark, and rebuild only if it moved.
   *
   * Single-flight: `refreshing` keeps a second caller from opening a second fork
   * while one is already in flight. Two *processes* checking at once need no
   * coordination at all and get none — both are reads, they arrive at the same
   * answer, and each rebuilds its own memory. Locking replicas against each
   * other here would be inventing a distributed problem to solve.
   *
   * **A failure leaves the old snapshot serving.** Nothing is cleared before the
   * new model is in hand: `reload()` assigns `this.snapshot` in one statement
   * after every read has succeeded, so a database that goes away mid-check
   * leaves a registry serving a model that is merely old — which is what it was
   * doing before this method existed, and is very much better than a registry
   * that answers "no such type" for everything. The window is retried on the
   * next call.
   */
  private async refreshIfStale(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const mark = await this.readWatermark(this.em.fork());
      if (mark !== undefined && mark.key === this.watermark) return;
      await this.reload();
    } catch (error) {
      this.logger.warn(
        `Could not check whether the catalog model has changed: ${
          error instanceof Error ? error.message : String(error)
        }. Still serving ${this.snapshot.stats.types} object types loaded at ${
          this.snapshot.generatedAt
        }.`,
      );
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * What the model tables look like right now, cheaply enough to ask often.
   *
   * One statement, four aggregates, over the two tables the snapshot is built
   * from — a few hundred types and their columns. Note what is NOT in it:
   * `catalog_snapshot`, the one table here that grows without bound, and whose
   * cost `servingSnapshots` below goes to some length to avoid. It does not need
   * to be: committing a load sets `ObjectTypeRow.currentSnapshotId`, so a commit
   * moves `catalog_object_type.updated_at` and the watermark already sees it.
   *
   * Neither aggregate is indexed, so both are scans. At this size that is
   * microseconds and the right trade — and the reason no `@Index` is declared is
   * the one `servingSnapshots` gives for the index it also wants: `fingerprintOf`
   * in `schema.ts` hashes column names, types and nullability, so an added index
   * would not move the fingerprint and would never reach an already-booted
   * database at all. A deployment whose model has grown to tens of thousands of
   * properties can add `(updated_at)` on `catalog_property` by hand; nothing
   * here needs to change for it to be used.
   *
   * Undefined when the statement answers a shape this cannot read. The caller
   * treats that as "cannot claim to be current" and rebuilds, which is the safe
   * direction: the alternative is a process that believes a watermark it did not
   * actually parse.
   */
  private async readWatermark(em: EntityManager): Promise<Watermark | undefined> {
    const [row] = await em.getConnection().execute<unknown[]>(WATERMARK_SQL);
    const parts = WATERMARK_COLUMNS.map((column) => cell(row, column)).filter(isPresent);
    if (parts.length !== WATERMARK_COLUMNS.length) {
      if (!this.warnedAboutWatermark) {
        this.warnedAboutWatermark = true;
        this.logger.warn(
          `The catalog model watermark came back without ${WATERMARK_COLUMNS.join(', ')}. This process will rebuild its model on every check rather than assume it is current.`,
        );
      }
      return undefined;
    }
    return { key: parts.join('|'), settled: settledAt(row) };
  }

  // `getGraph` is deliberately absent: the base class draws the ontology from
  // the snapshot above, and it is the same drawing the library registry gets.
  // See `buildCatalogGraph` in `@dudousxd/nestjs-catalog` — this file used to
  // hold a second copy of the edge rule, under a comment asking whoever changed
  // one to change both.

  /** @param curatedBy the acting principal's id, recorded on `type.curated`. */
  async patchType(
    typeName: string,
    patch: Partial<CatalogOverlay['types'][string]>,
    curatedBy: string,
  ): Promise<CatalogObjectTypeDef | undefined> {
    const em = this.em.fork();
    const row = await em.findOne(ObjectTypeRow, { name: typeName });
    if (!row) return undefined;

    if (patch.displayName !== undefined) row.displayName = patch.displayName;
    if (patch.pluralDisplayName !== undefined) {
      row.pluralDisplayName = patch.pluralDisplayName;
    }
    if (patch.description !== undefined) row.description = patch.description;
    if (patch.icon !== undefined) row.icon = patch.icon;
    if (patch.group !== undefined) row.group = patch.group;
    if (patch.titleProperty !== undefined) {
      row.titleProperty = patch.titleProperty;
    }
    await em.flush();
    await this.reload();
    emitCatalog('type.curated', {
      typeName,
      changed: Object.keys(patch),
      // Through `curationActor` for the reason its own docblock gives, and with
      // one more edge here: this registry is reachable through
      // `RoutingCatalogRegistry`, a hand-written proxy in this same package. A
      // forwarder that drops the argument would leave the actor empty in exactly
      // the multi-environment deployments where the trail is consulted most.
      principalId: curationActor(curatedBy),
    });
    return this.getType(typeName);
  }

  /**
   * Curate one field — and a relation is a field to whoever is looking.
   *
   * The same route, the same patch shape, and the fallback below is why no new
   * endpoint was needed to name a link: the console sends `PATCH
   * .../properties/base` whether `base` turns out to be a column or a link, and
   * a caller that had to know which in advance would have to read the type first
   * just to pick a URL. The library registry already behaved this way — its
   * overlay is keyed by property name and a relation's name is in the same
   * namespace — so this is the persisted path catching up rather than a new
   * idea.
   *
   * @param curatedBy the acting principal's id, recorded on `type.curated`. The
   * same argument whichever of the two the patch lands on: a reader asking who
   * renamed `base` is not asking whether `base` turned out to be a column.
   */
  async patchProperty(
    typeName: string,
    propertyName: string,
    patch: NonNullable<CatalogOverlay['types'][string]['properties']>[string],
    curatedBy: string,
  ): Promise<CatalogObjectTypeDef | undefined> {
    const em = this.em.fork();
    const row = await em.findOne(PropertyRow, {
      id: `${typeName}.${propertyName}`,
    });

    if (row) {
      if (patch.displayName !== undefined) row.displayName = patch.displayName;
      if (patch.description !== undefined) row.description = patch.description;
      if (patch.hidden !== undefined) row.hidden = patch.hidden;
      if (patch.order !== undefined) row.position = patch.order;
      if (patch.classification !== undefined) {
        row.classification = patch.classification;
      }
      if (patch.unit !== undefined) row.unit = patch.unit;
    } else if (!(await this.patchRelation(em, typeName, propertyName, patch))) {
      return undefined;
    }

    await em.flush();
    await this.reload();
    emitCatalog('type.curated', {
      typeName,
      property: propertyName,
      changed: Object.keys(patch),
      principalId: curationActor(curatedBy),
    });
    return this.getType(typeName);
  }

  /**
   * Apply a field patch to a link instead of a column. False when there is no
   * such link, which is what makes the caller answer 404 rather than 200.
   *
   * `unit` and `classification` are ignored rather than rejected. They are
   * meaningless on a link — it has no value to carry a unit — and the console
   * sends whichever fields its editor changed, so refusing the whole patch over
   * a field nobody typed would break the editable label this exists to serve.
   */
  private async patchRelation(
    em: EntityManager,
    typeName: string,
    relationName: string,
    patch: NonNullable<CatalogOverlay['types'][string]['properties']>[string],
  ): Promise<boolean> {
    const row = await em.findOne(ObjectTypeRow, { name: typeName });
    if (!row) return false;
    const relations = relationsOf(row);
    const existing = relations.find((relation) => relation.name === relationName);
    if (!existing) return false;

    const patched: StoredRelation = {
      ...existing,
      ...(patch.displayName === undefined ? {} : { displayName: patch.displayName }),
      ...(patch.description === undefined ? {} : { description: patch.description }),
      ...(patch.hidden === undefined ? {} : { hidden: patch.hidden }),
      ...(patch.order === undefined ? {} : { position: patch.order }),
    };
    // Replaced, never mutated in place: MikroORM diffs a JSON property against
    // the snapshot it took at load, and editing the object it already holds can
    // leave the flush with nothing to write.
    row.relations = relations.map((relation) =>
      relation.name === relationName ? patched : relation,
    );
    return true;
  }

  /**
   * Not supported here, and the reason is worth stating: in the library the
   * overlay is a separate layer over derived truth, so dropping it restores
   * what the ORM says. Here the published values *are* the stored values —
   * there is nothing underneath to fall back to, and a reset would mean
   * discarding whatever a curator wrote with no way to recover it. Re-publish
   * from the owning application instead.
   *
   * **And so this emits no `overlay.reset`.** The library registry emits one
   * because it destroys the curated values, and that event is the only record
   * of what they were; here nothing is destroyed, so an event would be a row in
   * the audit table saying a reset happened when the caller got an exception and
   * every stored label is still exactly where it was. The refusal is the honest
   * answer, and it reaches the caller rather than the trail.
   *
   * **And so it declares no actor**, where the base class and the two patches
   * above take one. An override may take fewer parameters than it was promised,
   * and accepting a `resetBy` here would advertise a record this method never
   * writes — the next reader would go looking in the audit table for the reset
   * this signature implies, and find the exception instead.
   */
  async resetOverlay(): Promise<void> {
    throw new Error(
      'The catalog service has no overlay to reset. Re-publish the type from the application that owns it.',
    );
  }

  /**
   * The newest COMMITTED snapshot per type — bounded by the number of TYPES,
   * never by the number of snapshots ever written.
   *
   * `committed: true` is the filter that makes this mean anything: an
   * uncommitted snapshot is a load in flight or a load that failed, and neither
   * is what readers are being served.
   *
   * **Why this is two statements and not one `find`.** It used to be
   * `em.find(SnapshotRow, { committed: true }, { orderBy: { committedAt: 'desc' } })`
   * — every committed snapshot ever written, dragged over the wire and hydrated
   * into managed entities, to keep one row per type and drop the rest. That is
   * the wrong shape for a table nothing ever deletes from. Measured on MySQL 8.0
   * at 200 types / 50k committed snapshots: `reload()` took 450-500 ms and the
   * hydrated rows added **161 MB** to the heap. Both of those land on the host
   * this package is mounted inside — its event loop does the hydration and its
   * pod holds the heap — and both grow forever, because a snapshot row is
   * written per load per type and nothing prunes them (see the retention note on
   * {@link SnapshotRow}). The old cost was not "a slow catalog screen"; at a
   * year of nightly loads it is a memory spike in somebody else's process.
   *
   * So: ask the database which rows are the serving ones and hydrate only
   * those. The first statement is a grouped join returning ~one id per type; the
   * second is a primary-key `IN` over that handful. Two small round trips beat
   * one enormous one, and doing the narrowing in SQL rather than in JS is the
   * whole point — the rejected rows never cross the wire.
   *
   * **What this costs elsewhere.** The grouped query still SCANS the table: the
   * only declared index is `(type_name, created_at)`, which covers neither the
   * `committed` filter nor the `committed_at` ordering, so MySQL reads every row
   * to compute the per-type maximum. That is now the database server's work
   * instead of the host's, which is the trade being made deliberately — but it
   * does not vanish. An index on `(committed, type_name, committed_at)` takes the
   * grouped query from ~85 ms to ~14 ms at 50k rows. It is not added here
   * because it is a deployment decision, not a defect: `fingerprintOf` in
   * `schema.ts` hashes only column names, types and nullability, so an added
   * `@Index` would not move the fingerprint and would never be applied to an
   * already-booted database at all.
   *
   * **Ties.** `committed_at` is a `DATETIME` with no fractional seconds, so two
   * loads of one type committing in the same second share a maximum and both ids
   * come back. The `orderBy` below makes the winner the highest id rather than
   * whichever row the engine happened to return first — the previous code broke
   * such ties arbitrarily, so this is strictly more determinism, not less.
   *
   * Table and column names are written out rather than derived from metadata,
   * matching `audit-recorder.service.ts`. Both assume MikroORM's underscored
   * naming strategy, which this package's entities are declared against.
   */
  private async servingSnapshots(em: EntityManager): Promise<Map<string, SnapshotRow>> {
    const newest = await em.getConnection().execute<unknown[]>(
      `SELECT s.id
         FROM catalog_snapshot s
         JOIN (
                SELECT type_name, MAX(committed_at) AS newest
                  FROM catalog_snapshot
                 WHERE committed = TRUE
              GROUP BY type_name
              ) latest
           ON latest.type_name = s.type_name
          AND latest.newest = s.committed_at
        WHERE s.committed = TRUE`,
    );

    const ids = newest.map(idOf).filter(isPresent);
    // Guarded rather than left to the query builder: an empty `$in` is a
    // `WHERE id IN ()`, which is a syntax error on MySQL, and a catalog with no
    // committed loads yet is the ordinary state on a fresh deployment.
    if (ids.length === 0) return new Map();

    const rows = await em.find(
      SnapshotRow,
      { id: { $in: ids } },
      { orderBy: { committedAt: 'desc', id: 'desc' } },
    );

    const serving = new Map<string, SnapshotRow>();
    for (const row of rows) {
      if (!serving.has(row.typeName)) serving.set(row.typeName, row);
    }
    return serving;
  }

  private toDef(
    row: ObjectTypeRow,
    published: Set<string>,
    serving?: SnapshotRow,
  ): CatalogObjectTypeDef {
    const relations: CatalogRelationDef[] = [...relationsOf(row)]
      .sort((a, b) => a.position - b.position)
      .map((relation) => ({
        name: relation.name,
        displayName: relation.displayName,
        kind: toRelationKind(relation.kind),
        targetType: relation.targetType,
        nullable: relation.nullable,
        hidden: relation.hidden,
        order: relation.position,
        owner: relation.owner,
        // Computed here rather than stored, because it is not a fact about this
        // link: the application that owns `Base` can publish it tomorrow or be
        // switched off tonight, and a persisted answer would keep insisting on
        // whichever was true when the row was written.
        targetPublished: published.has(relation.targetType),
        // Same limit the properties above have, for the same reason: there is no
        // derived layer underneath here, so a display name that arrived from a
        // publisher is indistinguishable from one a curator typed. A description
        // is the one field nothing writes by default.
        enriched: Boolean(relation.description),
        ...(relation.description === undefined ? {} : { description: relation.description }),
        ...(relation.localKey === undefined ? {} : { localKey: relation.localKey }),
        ...(relation.inverseName === undefined ? {} : { inverseName: relation.inverseName }),
      }));

    const properties = row.properties
      .getItems()
      .sort((a, b) => a.position - b.position)
      .map((p) => ({
        name: p.name,
        displayName: p.displayName,
        description: p.description,
        type: toScalar(p.type),
        columnName: p.sourceColumn,
        nullable: p.nullable,
        primary: p.primary,
        hidden: p.hidden,
        order: p.position,
        classification: p.classification,
        unit: p.unit,
        enriched: Boolean(p.description || p.unit || p.classification),
      }));

    return {
      name: row.name,
      displayName: row.displayName,
      pluralDisplayName: row.pluralDisplayName,
      description: row.description,
      tableName: row.physicalTable,
      icon: row.icon,
      group: row.group,
      titleProperty: row.titleProperty,
      primaryKey: row.primaryKey ?? [],
      enriched:
        Boolean(row.description) ||
        properties.some((p) => p.enriched) ||
        relations.some((r) => r.enriched),
      // Spread so a type with no committed snapshot carries no key at all
      // rather than three explicit `undefined`s. The absence is the statement —
      // "never loaded" and "loaded long ago" have to stay distinguishable, and
      // a key present-and-empty muddies that the moment anything serialises it.
      ...(serving?.committedAt
        ? {
            lastCommittedAt: serving.committedAt.toISOString(),
            rowCount: serving.rowCount,
            lastPrincipalId: serving.principalId,
          }
        : {}),
      properties,
      relations,
    };
  }
}

function emptySnapshot(): CatalogSnapshot {
  return {
    version: 0,
    generatedAt: new Date().toISOString(),
    stats: { types: 0, properties: 0, relations: 0, enrichedTypes: 0 },
    types: [],
  };
}
