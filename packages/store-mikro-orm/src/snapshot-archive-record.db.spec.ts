import type {
  CatalogObjectTypeDef,
  CatalogPropertyDef,
  SnapshotArchiveRef,
} from '@dudousxd/nestjs-catalog';
import type { StartedMySqlContainer } from '@testcontainers/mysql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CatalogDatabase, openCatalogDatabase, startMySql } from '../test/mysql-harness';

/**
 * Where a snapshot's bytes went, kept on the snapshot's own record.
 *
 * ## Why the store had to grow a column for this
 *
 * `SnapshotArchiveRef` shipped as vocabulary with nothing writing it, and the
 * one thing that reads it is the `catalog` source's refusal of a dropped
 * snapshot: *a verified copy of it was written to …, so the data still exists*.
 * With nothing recording a ref, that branch could never run, and every tombstone
 * got the other sentence — *no copy of it was recorded anywhere, so those rows
 * are gone*. For a snapshot that has been archived and evicted, that is the most
 * misleading thing this system could show somebody who is trying to find their
 * data.
 *
 * ## And why the drop had to grow a lock
 *
 * The served snapshot may not be dropped, and it may not be the newest either:
 * rolling a bad load back means committing an *older* snapshot, which is exactly
 * the kind a retention sweep picks. The check and the delete used to be two
 * unlocked statements, so a commit landing between them left a type pointing at
 * rows that were being deleted underneath it — a state `currentSnapshot`
 * describes as unreachable through this adapter. It was, while dropping was
 * something a person did by hand.
 */

function property(name: string, index: number): CatalogPropertyDef {
  return {
    name,
    displayName: name,
    type: 'string',
    columnName: name,
    nullable: index > 0,
    primary: index === 0,
    hidden: false,
    order: index,
    enriched: false,
  };
}

function typeNamed(name: string): CatalogObjectTypeDef {
  return {
    name,
    displayName: name,
    pluralDisplayName: `${name}s`,
    group: 'Retention',
    tableName: name.toLowerCase(),
    primaryKey: ['workOrderNumber'],
    properties: ['workOrderNumber', 'baseCode'].map(property),
    relations: [],
    enriched: false,
  };
}

function rows(ids: string[]): Array<Record<string, unknown>> {
  return ids.map((id) => ({ workOrderNumber: id, baseCode: 'B-21' }));
}

const ARCHIVE: SnapshotArchiveRef = {
  format: 'parquet',
  disk: 'cold',
  path: 'catalog/archive/Type/older',
  rowCount: 3,
  bytes: 4096,
  checksum: 'a'.repeat(64),
  writtenAt: '2026-08-01T00:00:00.000Z',
  verifiedAt: '2026-08-01T00:00:05.000Z',
};

describe('an archive recorded against a snapshot', () => {
  let container: StartedMySqlContainer;
  let db: CatalogDatabase;

  beforeAll(async () => {
    container = await startMySql();
    db = await openCatalogDatabase(container, 'archiverefs');
  }, 300_000);

  afterAll(async () => {
    await db?.close();
    await container?.stop();
  });

  async function twoLoads(
    name: string,
  ): Promise<{ type: CatalogObjectTypeDef; older: string; newer: string }> {
    const type = typeNamed(name);
    await db.publish(type);
    await db.store.write(type, rows(['a', 'b', 'c']), {
      snapshotId: 'older',
      principalId: 'loader',
    });
    await db.store.commit(type, 'older');
    await db.store.write(type, rows(['a', 'b']), { snapshotId: 'newer', principalId: 'loader' });
    await db.store.commit(type, 'newer');
    return { type, older: 'older', newer: 'newer' };
  }

  it('comes back out of the database whole, on every way of asking for the snapshot', async () => {
    const { type, older } = await twoLoads('ArchiveRefRoundTrip');
    await db.store.recordSnapshotArchive(type, older, ARCHIVE);

    const listed = (await db.store.listSnapshots(type)).find((each) => each.id === older);
    expect(listed?.archive).toEqual(ARCHIVE);

    // `locateSnapshot` is the unscoped lookup a workflow uses when all it has is
    // an id, and it is the path that decides what the refusal says.
    const located = await db.store.locateSnapshot(older);
    expect(located.find((each) => each.typeName === type.name)?.snapshot.archive).toEqual(ARCHIVE);
  });

  /**
   * The four-square grid `SnapshotArchiveRef` sets out: an archive can exist
   * while the rows are still here. That is the state an eviction passes through
   * on its way to deleting, and it is the one a crash must be able to leave.
   */
  it('is independent of the tombstone, so a copied-not-moved snapshot is expressible', async () => {
    const { type, older } = await twoLoads('ArchiveRefCopiedOnly');
    await db.store.recordSnapshotArchive(type, older, ARCHIVE);

    const before = (await db.store.listSnapshots(type)).find((each) => each.id === older);
    expect(before?.archive?.path).toBe(ARCHIVE.path);
    expect(before?.droppedAt).toBeUndefined();
    // Still readable — an archive on its own changes nothing about the rows.
    const read = await db.store.read(type, ['workOrderNumber'], {
      page: 1,
      size: 25,
      snapshot: older,
    });
    expect(read.total).toBe(3);

    await db.store.dropSnapshot(type, older);
    const after = (await db.store.listSnapshots(type)).find((each) => each.id === older);
    expect(after?.droppedAt).toBeDefined();
    // And the ref survives the drop, which is the whole reason it is recorded
    // first.
    expect(after?.archive?.path).toBe(ARCHIVE.path);
  });

  it('refuses a snapshot it has no record of, rather than inventing the load', async () => {
    const { type } = await twoLoads('ArchiveRefUnknown');
    await expect(db.store.recordSnapshotArchive(type, 'never-written', ARCHIVE)).rejects.toThrow(
      /no snapshot never-written/i,
    );
  });

  it('replaces a previous ref rather than keeping two', async () => {
    const { type, older } = await twoLoads('ArchiveRefReplaced');
    await db.store.recordSnapshotArchive(type, older, ARCHIVE);
    const reverified: SnapshotArchiveRef = { ...ARCHIVE, verifiedAt: '2026-08-09T00:00:00.000Z' };
    await db.store.recordSnapshotArchive(type, older, reverified);

    const listed = (await db.store.listSnapshots(type)).find((each) => each.id === older);
    expect(listed?.archive?.verifiedAt).toBe('2026-08-09T00:00:00.000Z');
  });
});

describe('dropping a snapshot takes the type row', () => {
  let container: StartedMySqlContainer;
  let db: CatalogDatabase;

  beforeAll(async () => {
    container = await startMySql();
    db = await openCatalogDatabase(container, 'droplocks');
  }, 300_000);

  afterAll(async () => {
    await db?.close();
    await container?.stop();
  });

  /**
   * The lock, made visible without a race.
   *
   * A separate transaction holds `catalog_object_type` for this type. If the
   * drop's served-snapshot check is a plain read — which it was — nothing makes
   * it wait, and it deletes rows while somebody else is deciding what the type
   * serves. If it takes the row for update, it waits, which is what this
   * observes: the promise is still pending after a second, and completes as soon
   * as the holder lets go.
   *
   * Deterministic rather than a repeated race: the interleaving is *arranged*,
   * so a run that passes here proves the ordering rather than failing to
   * reproduce it.
   */
  it('waits for a transaction holding the type row instead of deleting past it', async () => {
    const type = typeNamed('DropLockWaits');
    await db.publish(type);
    await db.store.write(type, rows(['a', 'b', 'c']), { snapshotId: 'old', principalId: 'loader' });
    await db.store.commit(type, 'old');
    await db.store.write(type, rows(['a']), { snapshotId: 'new', principalId: 'loader' });
    await db.store.commit(type, 'new');

    const connection = db.orm.em.getConnection();
    const holder = await connection.begin();
    let settled = false;
    let drop: Promise<void> | undefined;
    try {
      await connection.execute(
        'SELECT * FROM `catalog_object_type` WHERE `name` = ? FOR UPDATE',
        [type.name],
        'all',
        holder,
      );

      drop = db.store.dropSnapshot(type, 'old').then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

      await new Promise((resolve) => setTimeout(resolve, 1_500));
      // The assertion that fails without the lock: without it the drop takes a
      // handful of milliseconds and has long since finished by here.
      expect(settled).toBe(false);
    } finally {
      await connection.rollback(holder);
    }

    await drop;
    expect(settled).toBe(true);

    const [{ n }] = await db.orm.em
      .getConnection()
      .execute<Array<{ n: number }>>(
        'SELECT COUNT(*) AS n FROM `obj_droplockwaits` WHERE `_snapshot_id` = ?',
        ['old'],
      );
    expect(Number(n)).toBe(0);
  }, 60_000);
});
