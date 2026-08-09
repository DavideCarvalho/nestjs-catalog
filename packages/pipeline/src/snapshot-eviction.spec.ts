import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CatalogObjectTypeDef,
  CatalogReadResult,
  CatalogSnapshotArchiveStore,
  CatalogStoreCapabilities,
  ScalarType,
  SnapshotArchiveRef,
  SnapshotRef,
} from '@dudousxd/nestjs-catalog';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ARCHIVE_MANIFEST_NAME,
  ARCHIVE_PART_NAME,
  type ArchiveStore,
  archivePathFor,
  archiveSnapshot,
  localArchiveStore,
} from './snapshot-archive';
import {
  evictSnapshot,
  evictSnapshots,
  selectSnapshotsToEvict,
  verifyArchiveForEviction,
} from './snapshot-eviction';

/**
 * The refusals, against real parquet bytes on a real filesystem.
 *
 * Every case here is about something *not* being deleted. That is the shape of
 * the feature: eviction is the one operation in this design that cannot be
 * undone, so what is worth testing is not that it deletes — a `DELETE` deletes —
 * but that each way of arriving at it with a bad archive ends in a refusal and a
 * table that still has its rows.
 *
 * The archive is written by the real writer and read by the real reader. Mocking
 * either would make "the archive verifies" a property of the mock, and the whole
 * point of re-verifying at eviction time is that the *bytes* are asked again.
 */

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'catalog-evict-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function typeOf(name: string, properties: Array<{ name: string; type: ScalarType }>) {
  const def: CatalogObjectTypeDef = {
    name,
    displayName: name,
    pluralDisplayName: `${name}s`,
    tableName: `obj_${name.toLowerCase()}`,
    group: 'ops',
    primaryKey: ['id'],
    enriched: true,
    relations: [],
    properties: properties.map((property, index) => ({
      name: property.name,
      displayName: property.name,
      type: property.type,
      columnName: property.name,
      nullable: true,
      primary: index === 0,
      hidden: false,
      order: index,
      enriched: false,
    })),
  };
  return def;
}

const SUBWO = typeOf('Subwo', [
  { name: 'id', type: 'string' },
  { name: 'hours', type: 'number' },
]);

/**
 * Rows as `streamSnapshot(..., { provenance: true })` hands them over.
 *
 * The two reserved columns are on every row because the archiver refuses a
 * stream without them — which is the point of that refusal: an absent key
 * encodes as a null and verifies against a null, so a fixture that omitted them
 * here would be building exactly the archive eviction has to refuse, and every
 * case below would be testing that refusal by accident.
 */
function rowsOf(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => ({
    id: `wo-${index}`,
    hours: index + 0.5,
    _principal_id: 'loader',
    _loaded_at: '2026-08-01T00:00:00.000Z',
  }));
}

async function* streamOf(
  rows: Array<Record<string, unknown>>,
): AsyncGenerator<Record<string, unknown>> {
  for (const row of rows) yield row;
}

/**
 * A store that holds snapshots in a map and nothing else.
 *
 * Real enough for what these cases ask of it — it records an archive, it
 * tombstones, it refuses to drop what it is serving, and it says what it did —
 * and deliberately not a database, because the cases about a *real* engine are
 * in the `.db.spec.ts` beside this one. What this fake is for is the branches
 * that are hard to reach against a real store: an archive that has been
 * corrupted on disk since it was written, a store that cannot record an archive
 * at all, a manifest for the wrong snapshot.
 */
class FakeStore implements CatalogSnapshotArchiveStore {
  readonly capabilities: CatalogStoreCapabilities = {
    snapshots: 'emulated',
    writable: true,
    timeTravel: true,
  };
  readonly snapshots = new Map<string, SnapshotRef>();
  /** Rows per snapshot, so a refusal can be checked to have left them alone. */
  readonly rows = new Map<string, Array<Record<string, unknown>>>();
  currentId: string | undefined;
  readonly recorded: SnapshotArchiveRef[] = [];

  async read(): Promise<CatalogReadResult> {
    return { rows: [], total: 0 };
  }

  async listSnapshots(): Promise<SnapshotRef[]> {
    return [...this.snapshots.values()].sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    );
  }

  async currentSnapshot(): Promise<SnapshotRef | undefined> {
    return this.currentId === undefined ? undefined : this.snapshots.get(this.currentId);
  }

  async ensureType(): Promise<void> {}

  async write(): Promise<{ written: number }> {
    return { written: 0 };
  }

  async commit(_type: CatalogObjectTypeDef, snapshotId: string): Promise<SnapshotRef> {
    this.currentId = snapshotId;
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot) throw new Error(`no snapshot ${snapshotId}`);
    return snapshot;
  }

  async dropSnapshot(_type: CatalogObjectTypeDef, snapshotId: string): Promise<void> {
    if (this.currentId === snapshotId) {
      throw new Error(`Snapshot ${snapshotId} is the one being served. Commit another one first.`);
    }
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot || snapshot.droppedAt) return;
    this.rows.delete(snapshotId);
    this.snapshots.set(snapshotId, { ...snapshot, droppedAt: new Date().toISOString() });
  }

  async recordSnapshotArchive(
    _type: CatalogObjectTypeDef,
    snapshotId: string,
    archive: SnapshotArchiveRef,
  ): Promise<void> {
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot) throw new Error(`no snapshot ${snapshotId}`);
    this.recorded.push(archive);
    this.snapshots.set(snapshotId, { ...snapshot, archive });
  }

  seed(id: string, rows: Array<Record<string, unknown>>, createdAt: string): void {
    this.snapshots.set(id, {
      id,
      createdAt,
      rowCount: rows.length,
      principalId: 'spec',
    });
    this.rows.set(id, rows);
  }
}

/** Archive `rows` under `snapshotId`, through the real writer. */
async function archiveInto(
  archives: ArchiveStore,
  type: CatalogObjectTypeDef,
  snapshotId: string,
  rows: Array<Record<string, unknown>>,
): Promise<{ ref: SnapshotArchiveRef; path: string }> {
  const path = archivePathFor(`prefix-${snapshotId}`, type.name, snapshotId);
  const ref = await archiveSnapshot({
    type,
    snapshotId,
    rows: streamOf(rows),
    expectedRowCount: rows.length,
    store: archives,
    path,
    disk: 'archives',
  });
  return { ref, path };
}

describe('selectSnapshotsToEvict', () => {
  function ref(id: string, createdAt: string, extra: Partial<SnapshotRef> = {}): SnapshotRef {
    return { id, createdAt, rowCount: 10, principalId: 'spec', ...extra };
  }

  it('keeps the newest `keep` and offers the rest oldest first', () => {
    const snapshots = [
      ref('e', '2026-08-05T00:00:00.000Z'),
      ref('d', '2026-08-04T00:00:00.000Z'),
      ref('c', '2026-08-03T00:00:00.000Z'),
      ref('b', '2026-08-02T00:00:00.000Z'),
      ref('a', '2026-08-01T00:00:00.000Z'),
    ];
    const chosen = selectSnapshotsToEvict({
      snapshots,
      currentSnapshotId: 'e',
      retention: { keep: 3 },
    });
    // Oldest first, so an interrupted sweep has done the ones least likely to
    // be wanted back.
    expect(chosen.map((each) => each.id)).toEqual(['a', 'b']);
  });

  /**
   * The rolled-back type, which is the state this rule exists for.
   *
   * A bad load is undone by committing an *older* snapshot, so the served one
   * can be sitting deep in the list — and a policy that only spared the newest
   * would queue up the snapshot the type is answering every read from.
   */
  it('never offers the served snapshot, even when it is not the newest', () => {
    const snapshots = [
      ref('d', '2026-08-04T00:00:00.000Z'),
      ref('c', '2026-08-03T00:00:00.000Z'),
      ref('b', '2026-08-02T00:00:00.000Z'),
      ref('a', '2026-08-01T00:00:00.000Z'),
    ];
    const chosen = selectSnapshotsToEvict({
      snapshots,
      currentSnapshotId: 'a',
      retention: { keep: 2 },
    });
    // `a` is served and takes the first slot wherever it sits; `d` takes the
    // second; `c` and `b` go. Two snapshots keep their rows, which is what
    // `keep: 2` says in every state rather than only in the un-rolled-back one.
    expect(chosen.map((each) => each.id)).toEqual(['b', 'c']);
  });

  /**
   * A tombstone holds no rows, so counting it against `keep` would leave a type
   * with fewer rollback targets than the number says — and a screen listing
   * three snapshots, two of which hold nothing, looks exactly like three.
   */
  it('does not let a tombstone consume a retention slot', () => {
    const snapshots = [
      ref('d', '2026-08-04T00:00:00.000Z'),
      ref('c', '2026-08-03T00:00:00.000Z', { droppedAt: '2026-08-06T00:00:00.000Z' }),
      ref('b', '2026-08-02T00:00:00.000Z'),
      ref('a', '2026-08-01T00:00:00.000Z'),
    ];
    const chosen = selectSnapshotsToEvict({
      snapshots,
      currentSnapshotId: 'd',
      retention: { keep: 2 },
    });
    // `d` (served) and `b` are the two live snapshots kept; `c` is already a
    // tombstone and is neither kept nor re-evicted. Counting it would have left
    // `d` and `c` — one real rollback target where the number says two.
    expect(chosen.map((each) => each.id)).toEqual(['a']);
  });

  it('sorts rather than trusting the order it was handed', () => {
    const snapshots = [
      ref('a', '2026-08-01T00:00:00.000Z'),
      ref('c', '2026-08-03T00:00:00.000Z'),
      ref('b', '2026-08-02T00:00:00.000Z'),
    ];
    // Oldest-first input. A policy that took the order as given would keep `a`
    // and evict the newest load of the type.
    const chosen = selectSnapshotsToEvict({ snapshots, retention: { keep: 1 } });
    expect(chosen.map((each) => each.id)).toEqual(['a', 'b']);
  });

  it('refuses a retention of zero, which leaves nothing to serve', () => {
    expect(() => selectSnapshotsToEvict({ snapshots: [], retention: { keep: 0 } })).toThrow(
      /nothing to roll back to/i,
    );
  });
});

describe('evicting a snapshot', () => {
  it('verifies the archive again and only then drops the rows', async () => {
    const archives = localArchiveStore(root);
    const store = new FakeStore();
    const rows = rowsOf(40);
    store.seed('old', rows, '2026-08-01T00:00:00.000Z');
    store.seed('new', rowsOf(41), '2026-08-02T00:00:00.000Z');
    store.currentId = 'new';

    const { ref } = await archiveInto(archives, SUBWO, 'old', rows);
    const written = ref.verifiedAt;

    const evicted = await evictSnapshot({
      type: SUBWO,
      snapshotId: 'old',
      store,
      archives,
      archive: ref,
    });

    expect(evicted.deleted).toBe(true);
    expect(evicted.rowCount).toBe(40);
    expect(store.rows.has('old')).toBe(false);
    expect(store.snapshots.get('old')?.droppedAt).toBeDefined();

    // A fresh stamp, not the writer's. The whole point of this operation is that
    // it re-measured rather than reading a flag, and the stamp is what says so.
    expect(evicted.archive.verifiedAt).not.toBe(written);

    // The tombstone carries the archive, so a reader of it can be told where the
    // bytes went instead of "no copy of it was recorded anywhere".
    expect(store.snapshots.get('old')?.archive?.path).toBe(ref.path);
  });

  /**
   * The failure the whole design is arranged around: an archive that was
   * verified when it was written and has since gone bad.
   *
   * The corruption is a truncation, which is what a partial upload, a lifecycle
   * rule, or a storage-full incident leaves behind. It is applied *after* the
   * write verified, which is exactly the situation a stored `verifiedAt: true`
   * would sail past.
   */
  it('refuses when the archive has been damaged since it was written', async () => {
    const archives = localArchiveStore(root);
    const store = new FakeStore();
    const rows = rowsOf(30);
    store.seed('damaged', rows, '2026-08-01T00:00:00.000Z');
    store.seed('live', rowsOf(1), '2026-08-02T00:00:00.000Z');
    store.currentId = 'live';

    const { ref, path } = await archiveInto(archives, SUBWO, 'damaged', rows);
    expect(ref.verifiedAt).toBeTruthy();

    // Truncated on disk, at the path the ref names.
    await writeFile(join(root, `${path}/${ARCHIVE_PART_NAME}`), Buffer.from('PAR1'));

    await expect(
      evictSnapshot({ type: SUBWO, snapshotId: 'damaged', store, archives, archive: ref }),
    ).rejects.toThrow(/cannot be read back|Nothing has been deleted/i);

    // The rows are where they were. This is the assertion that matters: a
    // refusal that had already deleted would be the failure this exists to stop.
    expect(store.rows.get('damaged')).toHaveLength(30);
    expect(store.snapshots.get('damaged')?.droppedAt).toBeUndefined();
  });

  /**
   * The corruption a row count cannot see: every row present, one value wrong.
   *
   * This is the shape `hyparquet-writer` 0.16.5 produced from a nullable JSON
   * column — the reason the read-back check exists at all — and the only thing
   * that catches it is re-deriving the hash.
   */
  it('refuses when the rows read back complete and changed', async () => {
    const archives = localArchiveStore(root);
    const store = new FakeStore();
    const rows = rowsOf(20);
    store.seed('altered', rows, '2026-08-01T00:00:00.000Z');
    store.seed('live', rowsOf(1), '2026-08-02T00:00:00.000Z');
    store.currentId = 'live';

    const { ref, path } = await archiveInto(archives, SUBWO, 'altered', rows);

    // Rewritten with the right number of rows and one value different, through
    // the same writer — so the file is a valid archive of the wrong data.
    const changed = rowsOf(20);
    changed[7] = {
      id: 'wo-7',
      hours: 999,
      _principal_id: 'loader',
      _loaded_at: '2026-08-01T00:00:00.000Z',
    };
    await archiveSnapshot({
      type: SUBWO,
      snapshotId: 'altered',
      rows: streamOf(changed),
      expectedRowCount: 20,
      store: archives,
      path,
    });

    await expect(
      evictSnapshot({ type: SUBWO, snapshotId: 'altered', store, archives, archive: ref }),
    ).rejects.toThrow(/which is the right number, and they hash to/i);

    expect(store.rows.get('altered')).toHaveLength(20);
  });

  /**
   * An archive short of a column passes every check its own writer makes,
   * because that writer compares its output against its own input. Only
   * something outside the write can ask whether the archive covers the type.
   */
  it('refuses when the archive does not cover every property of the type', async () => {
    const archives = localArchiveStore(root);
    const store = new FakeStore();
    const rows = rowsOf(10);
    store.seed('narrow', rows, '2026-08-01T00:00:00.000Z');
    store.seed('live', rowsOf(1), '2026-08-02T00:00:00.000Z');
    store.currentId = 'live';

    // Archived against a narrower view of the type — a caller that passed a
    // trimmed field list, or a type that has since gained a column.
    const narrow = typeOf('Subwo', [{ name: 'id', type: 'string' }]);
    const { ref } = await archiveInto(archives, narrow, 'narrow', rows);

    await expect(
      evictSnapshot({ type: SUBWO, snapshotId: 'narrow', store, archives, archive: ref }),
    ).rejects.toThrow(/hours (is|are) not in it/i);

    expect(store.rows.get('narrow')).toHaveLength(10);
  });

  /**
   * The defect the archiver's three checks structurally cannot see.
   *
   * A snapshot streamed without `{ provenance: true }` hands over rows with no
   * `_principal_id` and no `_loaded_at`. The absent key encodes as a null, the
   * null reads back as a null, and the row count and the checksum are both
   * correct — so the archive is complete, verified, and holds none of the two
   * values a later merge copies forward. `archiveSnapshot` refuses that on the
   * way in now, per row; an archive written before it did is in the bucket with
   * a `verifiedAt` on it and nothing in its history that could have noticed.
   *
   * The manifest is the only thing that tells the two apart, which is why the
   * fixture rewrites the manifest rather than the data: an older writer's
   * manifest listed the type's properties and nothing else, and that list is
   * exactly what eviction has to refuse to delete rows on the strength of.
   */
  it('refuses an archive whose manifest does not carry the provenance columns', async () => {
    const archives = localArchiveStore(root);
    const store = new FakeStore();
    const rows = rowsOf(8);
    store.seed('preprovenance', rows, '2026-08-01T00:00:00.000Z');
    store.seed('live', rowsOf(1), '2026-08-02T00:00:00.000Z');
    store.currentId = 'live';

    const { ref, path } = await archiveInto(archives, SUBWO, 'preprovenance', rows);

    // The manifest an older writer produced: the type's properties, and no
    // `_principal_id` or `_loaded_at` beside them.
    const manifest = JSON.parse(
      new TextDecoder().decode(
        await (await archives.read(`${path}/${ARCHIVE_MANIFEST_NAME}`)).slice(0),
      ),
    );
    manifest.columns = SUBWO.properties.map((property) => ({
      name: property.name,
      type: property.type,
      parquetType: 'STRING',
    }));
    await archives.put(
      `${path}/${ARCHIVE_MANIFEST_NAME}`,
      new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
    );

    await expect(
      evictSnapshot({ type: SUBWO, snapshotId: 'preprovenance', store, archives, archive: ref }),
    ).rejects.toThrow(/does not carry _principal_id or _loaded_at/i);

    expect(store.rows.get('preprovenance')).toHaveLength(8);
    expect(store.snapshots.get('preprovenance')?.droppedAt).toBeUndefined();
  });

  /** A verified archive of the wrong load is still an authorisation to delete. */
  it('refuses an archive that names a different snapshot', async () => {
    const archives = localArchiveStore(root);
    const store = new FakeStore();
    store.seed('wanted', rowsOf(5), '2026-08-01T00:00:00.000Z');
    store.seed('live', rowsOf(1), '2026-08-02T00:00:00.000Z');
    store.currentId = 'live';

    const { ref } = await archiveInto(archives, SUBWO, 'somethingelse', rowsOf(5));

    await expect(
      evictSnapshot({ type: SUBWO, snapshotId: 'wanted', store, archives, archive: ref }),
    ).rejects.toThrow(/is of snapshot somethingelse/i);

    expect(store.rows.get('wanted')).toHaveLength(5);
  });

  /**
   * The archive is internally consistent and was taken before the last batch
   * landed. Only the snapshot's own record can tell you.
   */
  it('refuses an archive that is short of the snapshot it is a copy of', async () => {
    const archives = localArchiveStore(root);
    const store = new FakeStore();
    store.seed('grew', rowsOf(12), '2026-08-01T00:00:00.000Z');
    store.seed('live', rowsOf(1), '2026-08-02T00:00:00.000Z');
    store.currentId = 'live';

    const { ref } = await archiveInto(archives, SUBWO, 'grew', rowsOf(9));

    await expect(
      evictSnapshot({ type: SUBWO, snapshotId: 'grew', store, archives, archive: ref }),
    ).rejects.toThrow(/the snapshot record says 12/i);

    expect(store.rows.get('grew')).toHaveLength(12);
  });

  it('refuses a snapshot with no archive rather than treating it as a drop', async () => {
    const archives = localArchiveStore(root);
    const store = new FakeStore();
    store.seed('bare', rowsOf(3), '2026-08-01T00:00:00.000Z');
    store.seed('live', rowsOf(1), '2026-08-02T00:00:00.000Z');
    store.currentId = 'live';

    await expect(
      evictSnapshot({ type: SUBWO, snapshotId: 'bare', store, archives }),
    ).rejects.toThrow(/that is dropSnapshot, and asking for it by name is the point/i);
    expect(store.rows.get('bare')).toHaveLength(3);
  });

  /**
   * A store that cannot hold the ref would leave a tombstone saying no copy
   * exists — which is the sentence somebody hunting for their data reads.
   */
  it('refuses a store that cannot record where the bytes went', async () => {
    const archives = localArchiveStore(root);
    const store = new FakeStore();
    const rows = rowsOf(4);
    store.seed('unrecordable', rows, '2026-08-01T00:00:00.000Z');
    const { ref } = await archiveInto(archives, SUBWO, 'unrecordable', rows);

    // The same store with the one method taken off, which is what an adapter
    // compiled against an earlier version of the interface looks like.
    const older = {
      capabilities: store.capabilities,
      read: store.read.bind(store),
      listSnapshots: store.listSnapshots.bind(store),
      ensureType: store.ensureType.bind(store),
      write: store.write.bind(store),
      commit: store.commit.bind(store),
      dropSnapshot: store.dropSnapshot.bind(store),
    };

    await expect(
      evictSnapshot({
        type: SUBWO,
        snapshotId: 'unrecordable',
        store: older,
        archives,
        archive: ref,
      }),
    ).rejects.toThrow(/no copy of it exists anywhere/i);
    expect(store.rows.get('unrecordable')).toHaveLength(4);
  });

  it('lets the store refuse the snapshot it is serving', async () => {
    const archives = localArchiveStore(root);
    const store = new FakeStore();
    const rows = rowsOf(6);
    store.seed('served', rows, '2026-08-01T00:00:00.000Z');
    store.currentId = 'served';

    const { ref } = await archiveInto(archives, SUBWO, 'served', rows);

    await expect(
      evictSnapshot({ type: SUBWO, snapshotId: 'served', store, archives, archive: ref }),
    ).rejects.toThrow(/being served/i);
    expect(store.rows.get('served')).toHaveLength(6);
  });

  /**
   * The replay path. A durable step that retries reaches an already-evicted
   * snapshot, and the right answer is not "error" and not "deleted 27 million
   * rows" — it is that the copy was checked again and is still readable.
   */
  it('re-verifies an already-evicted snapshot instead of reporting a second deletion', async () => {
    const archives = localArchiveStore(root);
    const store = new FakeStore();
    const rows = rowsOf(15);
    store.seed('replayed', rows, '2026-08-01T00:00:00.000Z');
    store.seed('live', rowsOf(1), '2026-08-02T00:00:00.000Z');
    store.currentId = 'live';

    const { ref } = await archiveInto(archives, SUBWO, 'replayed', rows);
    const first = await evictSnapshot({
      type: SUBWO,
      snapshotId: 'replayed',
      store,
      archives,
      archive: ref,
    });
    expect(first.deleted).toBe(true);

    // No archive passed this time: it comes off the tombstone, which is the
    // whole reason it was recorded there.
    const second = await evictSnapshot({ type: SUBWO, snapshotId: 'replayed', store, archives });
    expect(second.deleted).toBe(false);
    expect(second.rowCount).toBe(15);
    expect(second.archive.verifiedAt).toBeTruthy();
  });

  it('refuses an id no snapshot of this type carries', async () => {
    const archives = localArchiveStore(root);
    const store = new FakeStore();
    store.seed('real', rowsOf(1), '2026-08-01T00:00:00.000Z');
    await expect(
      evictSnapshot({ type: SUBWO, snapshotId: 'ghost', store, archives }),
    ).rejects.toThrow(/never a load of this type/i);
  });
});

describe('a manifest that is not one', () => {
  it('refuses a manifest from a writer this reader does not know', async () => {
    const archives = localArchiveStore(root);
    const path = archivePathFor('future', SUBWO.name, 'v2');
    await archives.put(
      `${path}/${ARCHIVE_MANIFEST_NAME}`,
      new TextEncoder().encode(JSON.stringify({ version: 2, objectType: 'Subwo' })),
    );

    await expect(
      verifyArchiveForEviction({
        type: SUBWO,
        snapshotId: 'v2',
        archives,
        archive: {
          format: 'parquet',
          path,
          rowCount: 1,
          bytes: 1,
          checksum: 'x',
          writtenAt: '2026-08-01T00:00:00.000Z',
        },
        expectedRowCount: 1,
      }),
    ).rejects.toThrow(/manifest version 2/i);
  });

  it('refuses when there is no manifest at all', async () => {
    const archives = localArchiveStore(root);
    await expect(
      verifyArchiveForEviction({
        type: SUBWO,
        snapshotId: 'nowhere',
        archives,
        archive: {
          format: 'parquet',
          path: 'no/such/place',
          rowCount: 1,
          bytes: 1,
          checksum: 'x',
          writtenAt: '2026-08-01T00:00:00.000Z',
        },
        expectedRowCount: 1,
      }),
    ).rejects.toThrow(/cannot be described/i);
  });
});

describe('a sweep', () => {
  /**
   * One bad candidate must not stop the rest. A sweep that gave up on the first
   * obstacle would leave a type wedged behind its oldest un-evictable load while
   * it kept accumulating new ones — which is the disk problem this feature
   * exists for, arrived at through the feature.
   */
  it('evicts what it can and reports what it could not, with the reason', async () => {
    const archives = localArchiveStore(root);
    const store = new FakeStore();
    const rows = rowsOf(7);
    store.seed('s1', rows, '2026-08-01T00:00:00.000Z');
    store.seed('s2', rowsOf(7), '2026-08-02T00:00:00.000Z');
    store.seed('s3', rowsOf(7), '2026-08-03T00:00:00.000Z');
    store.currentId = 's3';

    // `s1` is archived. `s2` is not, so the sweep has one it can do and one it
    // cannot.
    const { ref } = await archiveInto(archives, SUBWO, 's1', rows);
    await store.recordSnapshotArchive(SUBWO, 's1', ref);

    const sweep = await evictSnapshots({
      type: SUBWO,
      store,
      archives,
      retention: { keep: 1 },
    });

    expect(sweep.evicted.map((each) => each.snapshotId)).toEqual(['s1']);
    expect(sweep.skipped).toHaveLength(1);
    expect(sweep.skipped[0]?.snapshotId).toBe('s2');
    expect(sweep.skipped[0]?.reason).toMatch(/no archive of it is recorded/i);
    // And the one it could not do still has its rows.
    expect(store.rows.get('s2')).toHaveLength(7);
  });

  it('leaves a type alone when nothing is past the retention', async () => {
    const archives = localArchiveStore(root);
    const store = new FakeStore();
    store.seed('only', rowsOf(2), '2026-08-01T00:00:00.000Z');
    store.currentId = 'only';

    const sweep = await evictSnapshots({ type: SUBWO, store, archives, retention: { keep: 5 } });
    expect(sweep.evicted).toEqual([]);
    expect(sweep.skipped).toEqual([]);
  });
});
