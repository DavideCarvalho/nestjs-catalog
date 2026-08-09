import type {
  CatalogObjectTypeDef,
  CatalogSnapshotArchiveStore,
  CatalogWriteStore,
  SnapshotArchiveRef,
  SnapshotRef,
} from '@dudousxd/nestjs-catalog';
import {
  CATALOG_PROVENANCE_COLUMNS,
  supportsSnapshotArchiveRecords,
} from '@dudousxd/nestjs-catalog';
import {
  ARCHIVE_PART_NAME,
  type ArchiveStore,
  archiveColumns,
  readArchiveManifest,
  readArchivePart,
} from './snapshot-archive';

/**
 * Removing a snapshot's rows, once its archive has been proved readable again.
 *
 * ## The half that cannot be undone
 *
 * Three pieces make one design. A **tombstone** keeps a snapshot's record after
 * its rows go, so `catalog_connector_run.snapshotId` still resolves. An
 * **archive** writes those rows to object storage and proves the copy readable.
 * This is the third: it deletes the rows, and it is the only one of the three
 * that can lose anything permanently.
 *
 * So the ordering is not negotiable and it is the whole of the safety property:
 * **write, verify, then delete — never delete, then write.** Everything else
 * here can be re-run. A half-written archive beside deleted rows cannot be
 * repaired by anything.
 *
 * ## Why an old "verified" is not a verification
 *
 * {@link archiveSnapshot} already reads its own output back through this
 * package's parquet reader and hashes it, and stamps `verifiedAt` when it
 * matches. That check is what caught `hyparquet-writer` 0.16.5 dropping values
 * after a null in a nullable JSON column — an archive with the right row count
 * and the wrong data, which no count would have noticed.
 *
 * That is exactly why the stamp cannot be trusted here. An archive written last
 * week by a writer that was silently losing a column carries a `verifiedAt` from
 * a check that ran against the same broken assumption, or from before anybody
 * knew to look. A flag is a memory of a measurement; eviction needs the
 * measurement. So {@link evictSnapshot} re-reads the bytes, through the same
 * reader, and re-derives both numbers — and if anything at all stops it from
 * doing so, it **refuses**. Not warns, not proceeds with a note.
 *
 * ## What is checked that the writer could not check
 *
 * Three things, and they are the reason this is not merely `archiveSnapshot`'s
 * verification run twice. All three share a shape: the writer compares its
 * output against *its own input*, so anything wrong with the input is invisible
 * to it and stays invisible for as long as nobody outside the write asks.
 *
 * - **The archive covers the type.** An archiver handed a narrowed field list
 *   writes a file that is short of columns and passes every check it makes. The
 *   manifest records the catalog's own column names and types precisely so
 *   somebody else can ask this question, and eviction is the somebody: a
 *   property of the type that the manifest does not name means the archive
 *   cannot answer for it, and deleting on that basis loses a column for good.
 * - **The archive carries the provenance columns.** The same shape and the
 *   worst instance of it: a snapshot streamed without `{ provenance: true }`
 *   hands over rows with no `_principal_id` and no `_loaded_at`, and a missing
 *   key encodes as a null which reads back as a null — so the row count is
 *   right, the checksum is right, and the archive holds none of the two values a
 *   later merge copies forward. `archiveSnapshot` refuses that on the way in
 *   now; archives written before it did are in the bucket already, carrying a
 *   `verifiedAt` earned against a check that could not see it.
 * - **The archive is of this snapshot.** The manifest carries the object type
 *   and the snapshot id, and both are compared against what is being deleted. A
 *   caller holding the wrong ref — a path copied off another type's history — is
 *   otherwise a verified archive of the wrong data authorising a delete.
 *
 * ## Called by a host, never by a commit
 *
 * There is no timer here. The ClickHouse store's `pruneSnapshots` settled this
 * for the destructive case — "a store that quietly enforced a retention window
 * would be breaking that promise on a schedule nobody chose" — and object
 * storage in a commit's critical path is the shape that was rejected for sink
 * fan-out, because it has no honest failure answer: a commit that cannot reach a
 * bucket has already published.
 *
 * ## Restoring is not offered, and today it is not possible
 *
 * Worth stating plainly, because everything above is arranged so that a restore
 * *could* work and it would be easy to read that as a restore existing. It does
 * not, and the obstacle is not effort: `write` stamps `_principal_id` and
 * `_loaded_at` itself — one principal per call, `now` per call — so there is no
 * seam through which the archived per-row values could be written back, and it
 * refuses a negative batch by name so a carry-forward marker could not go back
 * either. The bytes are preserved and this operation proves them whole; putting
 * them back needs a write path that does not exist.
 *
 * So the `catalog` source's refusal of an evicted snapshot stays exactly as
 * true as it was — *reading an archived snapshot back is not something this
 * source can do, so the copy has to be restored before a graph can read it*.
 * What changes is that it can now name **where** the copy went, because
 * {@link CatalogSnapshotArchiveStore.recordSnapshotArchive} puts the ref on the
 * tombstone before the rows go; before this file, that branch could never run
 * and every tombstone said no copy existed.
 */

/** What one snapshot's eviction did. */
export interface EvictedSnapshot {
  snapshotId: string;
  /** Rows deleted, as the snapshot's record reported them. */
  rowCount: number;
  /**
   * The archive, with `verifiedAt` moved to the moment it was re-proved.
   *
   * The stamp on the returned ref is this eviction's, not the write's, and it is
   * the one recorded on the tombstone. What it means is narrow and worth being
   * exact about: *these bytes were read back and matched, immediately before the
   * rows were deleted.* It says nothing about tomorrow.
   */
  archive: SnapshotArchiveRef;
  /**
   * False when the snapshot was already evicted and this call re-confirmed it
   * rather than deleting anything.
   *
   * A durable step that replays reaches this. It is reported rather than hidden
   * because "we deleted 27 million rows" and "they were already gone" are two
   * different lines in a run log.
   */
  deleted: boolean;
}

/** What a sweep over one type did. */
export interface EvictionSweep {
  typeName: string;
  evicted: EvictedSnapshot[];
  /**
   * Snapshots the policy chose that could not be evicted, and why.
   *
   * A sweep reports rather than throws, because the ordinary reason a candidate
   * is skipped is that nobody has archived it yet — which is not an error, it is
   * a deployment that has archiving switched off for that type. A verification
   * that *failed*, on the other hand, is in here with the reader's own sentence
   * in it, and a host that treats this list as noise will not see it. See
   * {@link evictSnapshots} for why it is not an exception.
   */
  skipped: Array<{ snapshotId: string; reason: string }>;
}

/**
 * How many snapshots keep their rows.
 *
 * ## A count, and not an age or a size
 *
 * All three were on the table and only one of them answers the question
 * retention exists to answer, which is *can I roll this back*.
 *
 * **Size** makes retention depend on how wide a type is. A 60-column type at
 * 45,000 rows a load and a 4-column type at the same row count get very
 * different numbers of retained loads out of the same budget — and the wide one
 * is the one whose loads are expensive to re-run and whose rollback you most
 * want. Size retains fewest snapshots of exactly the type that needs them most.
 *
 * **Age** makes retention depend on load cadence. A window of 30 days gives a
 * type loaded hourly 720 snapshots and a type loaded monthly one, which is not a
 * rollback target at all — it is the load you are trying to roll *back*. Two
 * types under one policy get incomparable amounts of safety, and neither number
 * was chosen.
 *
 * **A count** is the only one where "how far back can I go" has a
 * cadence-independent, width-independent answer: `keep` loads. It is the number
 * an operator can actually reason about, because it is the number they would
 * have said if asked.
 *
 * What a count does not bound is disk, which is what started all of this. That
 * is the honest trade and it is the right way round: disk is bounded *well
 * enough* by a count — a type holds `keep` loads instead of every load it has
 * ever had, which took one deployment from 441 snapshots to a fixed handful —
 * while the rollback guarantee stays a guarantee. A policy that bounded disk
 * exactly would be one where the answer to "can I roll back" is "it depends what
 * else was loaded this week".
 *
 * ## No default
 *
 * `keep` is required, like ClickHouse's `pruneSnapshots(type, keep)`. A default
 * here would be this file choosing how much history a deployment gets, on the
 * one operation that cannot be undone, and inventing it would make the number
 * invisible in the place it most needs to be visible: the caller's own
 * configuration.
 */
export interface SnapshotRetention {
  /** Snapshots that keep their rows, newest first. At least 1. */
  keep: number;
}

/**
 * Which snapshots a retention policy would evict, oldest first.
 *
 * Pure, and separate from {@link evictSnapshots}, so the policy can be asked
 * what it *would* do — by a screen, by a dry run, or by a test — without
 * anything being deleted to find out.
 *
 * ## Three rules, and each of them is a state somebody reached
 *
 * - **The served snapshot is never a candidate**, whatever its age, and it
 *   counts as one of the `keep`. It may not even be the newest: rolling a bad
 *   load back means committing an *older* snapshot, so the served one can be
 *   sitting deep in the list, and a policy that only spared the newest would
 *   pick it. The store refuses the drop anyway — that refusal is load-bearing
 *   and is the last word — but a sweep that queued it up would spend a full
 *   archive verification to be told no.
 * - **Tombstones do not consume a slot.** Their rows are already gone, so
 *   counting them would let `keep: 3` leave a type with one live snapshot and
 *   two records of loads that hold nothing — which reads on a screen exactly
 *   like three rollback targets.
 *
 * Between them those two make `keep` mean one thing in every state: *this many
 * snapshots still have their rows*. A policy where the served snapshot were
 * spared **in addition** to the `keep` newest — which is what ClickHouse's
 * `pruneSnapshots` does — gives `keep` in the ordinary case and `keep + 1` after
 * a rollback, and a number that changes meaning depending on whether somebody
 * rolled back last week is the same class of answer this policy rejected age and
 * size for.
 */
export function selectSnapshotsToEvict(input: {
  snapshots: readonly SnapshotRef[];
  /** From `CatalogWriteStore.currentSnapshot`. Absent means nothing is served. */
  currentSnapshotId?: string;
  retention: SnapshotRetention;
}): SnapshotRef[] {
  const { keep } = input.retention;
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error(
      `A retention of ${keep} snapshot(s) would leave the type with nothing to roll back to, and nothing to serve if the current load turns out to be bad. Keep at least 1.`,
    );
  }

  // Sorted here rather than taken as given. `listSnapshots` orders newest first
  // today, and a policy that silently depended on that would evict the newest
  // loads of any store that ordered differently — a failure with no symptom
  // until somebody needs a rollback.
  const ordered = [...input.snapshots].sort((left, right) => {
    const byTime = right.createdAt.localeCompare(left.createdAt);
    // Two loads in the same second are ordered by id, matching the tie-break
    // `carryForward` uses to pick a previous snapshot, so the two cannot
    // disagree about which of a pair is older.
    return byTime !== 0 ? byTime : right.id.localeCompare(left.id);
  });

  const evictable: SnapshotRef[] = [];
  // The served snapshot fills the first slot before the walk begins, wherever it
  // sits in the list. It keeps its rows by definition — the store will not let
  // anything take them — so a policy that did not count it would be promising
  // `keep` and delivering `keep + 1`.
  const served = ordered.find(
    (snapshot) => snapshot.id === input.currentSnapshotId && !snapshot.droppedAt,
  );
  let retained = served === undefined ? 0 : 1;
  for (const snapshot of ordered) {
    if (snapshot.id === input.currentSnapshotId) continue;
    if (snapshot.droppedAt) continue;
    if (retained < keep) {
      retained += 1;
      continue;
    }
    evictable.push(snapshot);
  }

  // Oldest first. A sweep that is interrupted — a pod rescheduled, a timeout —
  // has then done the oldest loads, which are the ones least likely to be wanted
  // back, and the ones it did not reach are the newest.
  return evictable.reverse();
}

/**
 * A store that has been found able to evict, and its snapshot list already bound
 * to the type.
 *
 * Two fields rather than one narrowed store, because the two capabilities are
 * reached differently and only one of them has a type guard. Archive recording
 * is an interface with a `supportsSnapshotArchiveRecords` guard, so the store
 * narrows; `listSnapshots` is an optional *method* on the base interface, and
 * checking it narrows the expression rather than the object. Carrying the bound
 * method beside the narrowed store is what avoids re-checking it at each call —
 * and avoids the assertion that would otherwise paper over the difference.
 */
interface EvictionAccess {
  store: CatalogSnapshotArchiveStore;
  listSnapshots(): Promise<SnapshotRef[]>;
}

export interface EvictSnapshotInput {
  type: CatalogObjectTypeDef;
  snapshotId: string;
  /**
   * The store holding the rows.
   *
   * It must be able to list snapshots and to record an archive on one; both are
   * checked and both refuse rather than degrade. See
   * {@link assertCanEvict} for why recording is not optional.
   */
  store: CatalogWriteStore;
  /** Where the archives are, opened the same way the write opened them. */
  archives: ArchiveStore;
  /**
   * The archive to verify, when the caller is holding one.
   *
   * Usually absent: the ref is read off the snapshot's own record, which is
   * where a previous archive-and-record put it. Passing one is for the case
   * where the archive was just written and has not been recorded yet.
   */
  archive?: SnapshotArchiveRef;
}

/**
 * Verify a snapshot's archive and, only then, delete its rows.
 *
 * The sequence, and every step of it is a refusal waiting to happen:
 *
 * 1. The store must be able to record an archive. A store that cannot leaves a
 *    tombstone saying *no copy of it was recorded anywhere*, which for an
 *    evicted snapshot is a lie told by the one message somebody reads when they
 *    are trying to find their data.
 * 2. The snapshot must exist and must have an archive. No archive is not an
 *    error to route around — it means this is a `dropSnapshot`, and a caller who
 *    wants that should say so.
 * 3. The archive is **re-read and re-hashed**, and checked against the manifest,
 *    against the ref, and against the snapshot's own row count. See
 *    {@link verifyArchiveForEviction}.
 * 4. The ref, with a fresh `verifiedAt`, is recorded on the snapshot — *before*
 *    anything is deleted, so a crash here leaves an archived snapshot that still
 *    has its rows.
 * 5. `dropSnapshot` deletes them, and it is the store's own refusal that stands
 *    between this and the served snapshot. That refusal is reached rather than
 *    reimplemented: this method has no opinion about what is current, it asks
 *    for the drop and lets the store say no.
 *
 * ## Concurrency
 *
 * Three races, and the answers are not the same shape.
 *
 * **A run reading the snapshot while it is evicted.** Nothing is needed and
 * nothing is added. `streamSnapshot` opens a read-only transaction and iterates
 * inside it, so on InnoDB and on Postgres the reader holds a consistent view
 * from its first row: a `DELETE` committed underneath it removes nothing from
 * what it is reading, and the iteration finishes with every row. What the reader
 * does *not* get is a refusal, because `assertNotDropped` ran before the
 * tombstone existed — and that is correct, since the read it is completing is a
 * complete and correct one. The next read refuses. The cost is that the engine
 * must keep the deleted versions for as long as the reader runs, so a very long
 * read over a snapshot being evicted grows undo (MySQL) or delays vacuum
 * (Postgres). Slower, never wrong.
 *
 * **Two evictions racing.** Both verify — reads of object storage, which is
 * idempotent — both record the same ref, and `dropSnapshot` is idempotent by its
 * tombstone: the second finds `droppedAt` set and returns without re-dating it.
 * In a true tie the store's row lock makes them sequential and the second
 * becomes the no-op. The only observable difference is which `verifiedAt` is
 * recorded, and both are true.
 *
 * **An eviction racing a commit of the same snapshot.** This is the one that
 * could hurt, and it needed the store to change rather than this file. Rolling a
 * bad load back means committing an *older* snapshot, which is exactly what a
 * sweep is choosing to drop, so the interleaving is reachable rather than
 * theoretical — and its outcome is a type serving rows that are being deleted
 * underneath it. `dropSnapshot` and `commit` now take the same two row locks in
 * the same order, so one of them always sees the other's result: either the
 * commit lands first and the drop refuses because the pointer names the
 * snapshot, or the drop lands first and the commit refuses on the tombstone.
 */
export async function evictSnapshot(input: EvictSnapshotInput): Promise<EvictedSnapshot> {
  const { type, snapshotId } = input;
  const { store, listSnapshots } = assertCanEvict(input.store, type, snapshotId);

  const known = await listSnapshots();
  const snapshot = known.find((each) => each.id === snapshotId);
  if (!snapshot) {
    throw new Error(
      `There is no snapshot ${snapshotId} of "${type.name}" to evict. Its record would still be here if it had been dropped — a tombstone survives — so an id that resolves to nothing was never a load of this type, and nothing is deleted on the strength of one.`,
    );
  }

  const archive = input.archive ?? snapshot.archive;
  if (!archive) {
    throw new Error(
      `Snapshot ${snapshotId} of "${type.name}" holds ${snapshot.rowCount} row(s) and no archive of it is recorded, so evicting it would delete data that exists in exactly one place. Archive it first. If deleting it unrecoverably is what you mean, that is dropSnapshot, and asking for it by name is the point.`,
    );
  }

  if (snapshot.droppedAt) {
    // Already evicted. Re-verified anyway, and that is not ceremony: this is
    // the path a durable replay takes, and it is the cheapest moment anybody
    // will ever again ask whether the copy that replaced 27 million rows is
    // still readable. A failure here is not a failed eviction — the rows are
    // already gone — but it is the alarm that a restore is not going to work,
    // raised while somebody is still looking at the run.
    const reverified = await verifyArchiveForEviction({
      type,
      snapshotId,
      archives: input.archives,
      archive,
      expectedRowCount: snapshot.rowCount,
    });
    await store.recordSnapshotArchive(type, snapshotId, reverified);
    return { snapshotId, rowCount: snapshot.rowCount, archive: reverified, deleted: false };
  }

  // The store's refusal, reached rather than repeated. Asking `currentSnapshot`
  // first is only a shortcut past a full re-read of the archive for a snapshot
  // that cannot be dropped anyway; the sentence a caller gets is the store's,
  // thrown by the store, and it is thrown again below for any store that cannot
  // answer this question.
  if (typeof store.currentSnapshot === 'function') {
    const current = await store.currentSnapshot(type);
    if (current?.id === snapshotId) await store.dropSnapshot(type, snapshotId);
  }

  const verified = await verifyArchiveForEviction({
    type,
    snapshotId,
    archives: input.archives,
    archive,
    expectedRowCount: snapshot.rowCount,
  });

  // Before the delete, always. A crash between these two lines leaves a snapshot
  // that has an archive and still has its rows — a state the design names and
  // allows ("copied, not moved"), and one a re-run walks straight through. The
  // other order leaves rows deleted with nothing saying where they went.
  await store.recordSnapshotArchive(type, snapshotId, verified);
  await store.dropSnapshot(type, snapshotId);

  return { snapshotId, rowCount: snapshot.rowCount, archive: verified, deleted: true };
}

/**
 * Evict everything a retention policy no longer keeps, oldest first.
 *
 * ## Why a sweep collects failures instead of throwing on the first
 *
 * The candidates are independent: snapshot #7 being unarchived says nothing
 * about #8, and stopping at #7 would leave a type permanently stuck behind its
 * oldest un-evictable load while it kept accumulating new ones. The failure
 * this whole feature exists to prevent is a database filling up quietly, and a
 * sweep that gives up on the first obstacle is a sweep that stops running while
 * continuing to report that it ran.
 *
 * What that owes the caller is a list it cannot ignore by accident, which is why
 * {@link EvictionSweep.skipped} carries the reader's own sentence for each
 * failure rather than a count. A verification that failed and a snapshot nobody
 * archived are both in there, and they are different problems: the second is a
 * deployment that has not switched archiving on, the first is an archive that
 * has gone bad and a restore that will not work.
 */
export async function evictSnapshots(input: {
  type: CatalogObjectTypeDef;
  store: CatalogWriteStore;
  archives: ArchiveStore;
  retention: SnapshotRetention;
}): Promise<EvictionSweep> {
  const { type } = input;
  const { store, listSnapshots } = assertCanEvict(input.store, type);

  const snapshots = await listSnapshots();
  const current =
    typeof store.currentSnapshot === 'function' ? await store.currentSnapshot(type) : undefined;

  const candidates = selectSnapshotsToEvict({
    snapshots,
    ...(current === undefined ? {} : { currentSnapshotId: current.id }),
    retention: input.retention,
  });

  const evicted: EvictedSnapshot[] = [];
  const skipped: Array<{ snapshotId: string; reason: string }> = [];
  for (const candidate of candidates) {
    try {
      evicted.push(
        await evictSnapshot({
          type,
          snapshotId: candidate.id,
          store: input.store,
          archives: input.archives,
        }),
      );
    } catch (error) {
      skipped.push({
        snapshotId: candidate.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { typeName: type.name, evicted, skipped };
}

/**
 * Read the archive back and prove it is this snapshot, whole, before anything
 * is deleted.
 *
 * Six checks. Each one exists because it catches something the others cannot:
 *
 * - **The manifest parses and is version 1.** A manifest that cannot be read is
 *   an archive whose own description is gone, and the rest of the checks would
 *   be comparing numbers against `undefined`.
 * - **It names this type and this snapshot.** Catches the ref that points at
 *   another load's archive — which is otherwise a verified copy of the wrong
 *   data authorising a delete of the right data.
 * - **It covers every property the type has.** Catches an archive written from a
 *   narrowed field list, and an archive written before the type gained a column.
 *   Neither is visible to the writer's own verification, which compares its
 *   output against its own input, and both mean the archive cannot answer for a
 *   column the snapshot had.
 * - **It carries `CATALOG_PROVENANCE_COLUMNS`.** This is the class of defect the
 *   archiver's three checks structurally cannot see, and it is the reason this
 *   check is here rather than assumed: a snapshot streamed *without*
 *   `{ provenance: true }` hands over rows with no `_principal_id` and no
 *   `_loaded_at`, the absent key encodes as a null, the null reads back as a
 *   null, and the archive is complete, correctly counted and correctly
 *   checksummed while holding none of the two values a restore cannot
 *   reconstruct. `archiveSnapshot` now refuses that on the way in, per row —
 *   but an archive written by an earlier build sits in the bucket with a
 *   `verifiedAt` on it and no such refusal in its history. That is exactly the
 *   archive this operation must not delete rows on the strength of, and the
 *   manifest's column list is what tells the two apart.
 * - **The row count agrees three ways** — the file, the manifest, and the
 *   snapshot's own record. The third is the one that matters most here and only
 *   this side can ask it: an archive taken before the last batch landed is
 *   internally consistent and short of the snapshot.
 * - **The checksum agrees with the manifest and with the ref.** The count
 *   catches a truncated archive; only the hash catches a complete one with a
 *   value changed, which is the shape `hyparquet-writer` 0.16.5 produced from a
 *   nullable JSON column and the reason the read-back check exists at all.
 *
 * ## What none of this promises
 *
 * That the archive can be put back. It cannot, today, and this operation must
 * not imply otherwise: the write path stamps `_principal_id` and `_loaded_at`
 * itself — one principal per call, `now` per call — so there is no seam through
 * which per-row provenance can be written back, and `write` refuses a negative
 * batch by name. The bytes are preserved and complete; restoring them is a
 * capability that does not exist yet. What is being checked here is that the
 * copy is whole and readable, which is the most that can be true before there
 * is a restore, and the least that may be true before rows are deleted.
 *
 * Every failure throws, and the message says that nothing was deleted, because
 * a caller reading it needs to know whether they are looking at a bad archive or
 * at lost data.
 */
export async function verifyArchiveForEviction(input: {
  type: CatalogObjectTypeDef;
  snapshotId: string;
  archives: ArchiveStore;
  archive: SnapshotArchiveRef;
  /** The snapshot's own count, from its record. */
  expectedRowCount: number;
}): Promise<SnapshotArchiveRef> {
  const { type, snapshotId, archive } = input;
  const where = `${archive.path}${archive.disk ? ` on the "${archive.disk}" disk` : ''}`;
  const nothingWasDeleted = `Nothing has been deleted: snapshot ${snapshotId} of "${type.name}" still has its rows.`;

  const manifest = await readArchiveManifest(input.archives, archive.path).catch(
    (error: unknown) => {
      throw new Error(
        `The archive of snapshot ${snapshotId} of "${type.name}" at ${where} cannot be described: ${describe(error)} ${nothingWasDeleted}`,
        { cause: error },
      );
    },
  );

  if (manifest.objectType !== type.name || manifest.snapshotId !== snapshotId) {
    throw new Error(
      `The archive at ${where} is of snapshot ${manifest.snapshotId} of "${manifest.objectType}", and it was offered as the archive of snapshot ${snapshotId} of "${type.name}". Those are different loads and the copy is of the wrong one. ${nothingWasDeleted}`,
    );
  }

  const archived = new Set(manifest.columns.map((column) => column.name));
  const missing = type.properties
    .filter((property) => !archived.has(property.name))
    .map((property) => property.name);
  if (missing.length > 0) {
    throw new Error(
      `The archive at ${where} holds ${manifest.columns.length} column(s) and "${type.name}" has ${type.properties.length}: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not in it. An archive that does not cover the type cannot answer for the rows it would replace, whether the writer was given a narrowed field list or the type gained a column afterwards. Archive it again. ${nothingWasDeleted}`,
    );
  }

  // Separately, and with its own sentence, because it is a different mistake
  // with a different repair — and because it is the one an archive can carry a
  // `verifiedAt` for while being wrong. A stream taken without
  // `{ provenance: true }` produces a file that is complete, counted and hashed
  // and holds a null in both of these columns for every row; the archiver
  // refuses that now, on the way in, but an archive written before it did is
  // sitting in the bucket looking verified.
  const withoutProvenance = CATALOG_PROVENANCE_COLUMNS.filter((column) => !archived.has(column));
  if (withoutProvenance.length > 0) {
    throw new Error(
      `The archive at ${where} does not carry ${withoutProvenance.join(' or ')}. An incremental load copies ${CATALOG_PROVENANCE_COLUMNS.join(' and ')} off the snapshot it merges against, so a copy without them makes every future carried row claim it was loaded whenever a restore ran — and every later snapshot inherits that. This is refused rather than warned about, because the archive is otherwise complete and its checksum is correct: nothing later would notice. Archive the snapshot again, streaming it with { provenance: true }. ${nothingWasDeleted}`,
    );
  }

  const columns = archiveColumns(type);
  const tally = await readArchivePart(
    input.archives,
    `${archive.path}/${ARCHIVE_PART_NAME}`,
    columns,
  ).catch((error: unknown) => {
    throw new Error(
      `The archive of snapshot ${snapshotId} of "${type.name}" at ${where} cannot be read back: ${describe(error)} A copy that cannot be read is not a copy. ${nothingWasDeleted}`,
      { cause: error },
    );
  });

  // All three, and named separately, because which pair disagrees says which
  // thing went wrong: file-against-manifest is a damaged archive,
  // manifest-against-snapshot is an archive taken of a different moment.
  const counts: Array<[what: string, value: number]> = [
    ['the file', tally.rowCount],
    ['its manifest', manifest.rowCount],
    ['the snapshot record', input.expectedRowCount],
  ];
  const disagreement = counts.find(([, value]) => value !== tally.rowCount);
  if (disagreement !== undefined) {
    throw new Error(
      `The archive at ${where} does not have the number of rows it should: ${counts.map(([what, value]) => `${what} says ${value}`).join(', ')}. ${nothingWasDeleted}`,
    );
  }

  if (tally.checksum !== manifest.checksum || tally.checksum !== archive.checksum) {
    throw new Error(
      `The archive at ${where} holds ${tally.rowCount} rows, which is the right number, and they hash to ${tally.checksum} where the manifest says ${manifest.checksum} and the record says ${archive.checksum}. The count is right and at least one value is not, which is what a row count cannot see. ${nothingWasDeleted}`,
    );
  }

  return { ...archive, rowCount: tally.rowCount, verifiedAt: new Date().toISOString() };
}

/**
 * The store, narrowed to what an eviction needs, or a refusal naming what is
 * missing.
 *
 * Both capabilities are hard requirements and neither degrades. `listSnapshots`
 * is how the snapshot's own row count and its archive are read, and there is no
 * weaker substitute — `read` given an unknown id answers zero rows, which is
 * also what a genuinely empty load answers. `recordSnapshotArchive` is what puts
 * the path on the tombstone, and a store without it can only produce a tombstone
 * that says no copy was recorded, which is the single most misleading sentence
 * this system could show somebody hunting for their data.
 */
function assertCanEvict(
  store: CatalogWriteStore,
  type: CatalogObjectTypeDef,
  snapshotId?: string,
): EvictionAccess {
  const what = snapshotId ? `snapshot ${snapshotId} of "${type.name}"` : `"${type.name}"`;
  const list = store.listSnapshots?.bind(store);
  if (list === undefined) {
    throw new Error(
      `This store cannot list snapshots, so it cannot say how many rows ${what} holds or where its archive is — and both are what an eviction checks before it deletes anything. Nothing has been deleted.`,
    );
  }
  if (!supportsSnapshotArchiveRecords(store)) {
    throw new Error(
      `This store cannot record an archive against a snapshot, so evicting ${what} would leave a tombstone reporting that no copy of it exists anywhere — which is exactly the sentence somebody looking for the data would read. Eviction is refused rather than performed with the record missing. Nothing has been deleted.`,
    );
  }
  return { store, listSnapshots: () => list(type) };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
