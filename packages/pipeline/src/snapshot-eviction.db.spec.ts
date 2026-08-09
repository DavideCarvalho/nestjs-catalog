import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tableFor } from '@dudousxd/nestjs-catalog-store-mikro-orm';
import type { StartedMySqlContainer } from '@testcontainers/mysql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contractRow, contractType } from '../../../test/catalog-store-contract';
import {
  type CatalogDatabase,
  openCatalogDatabase,
  startMySql,
} from '../../store-mikro-orm/test/mysql-harness';
import { archivePathFor, archiveSnapshot, localArchiveStore } from './snapshot-archive';
import { evictSnapshot, evictSnapshots } from './snapshot-eviction';
import { SOURCES } from './sources';

/**
 * Eviction against a real warehouse: the rows really go, and everything that
 * could have quietly answered "nothing here" says why instead.
 *
 * ## What only a real engine can settle
 *
 * The unit spec beside this one proves the refusals against a store that is a
 * `Map`. Three things are not askable of a `Map`:
 *
 * - **The rows leave `obj_<type>` and the other snapshots' rows do not.** The
 *   physical table holds every load ever committed, so an eviction that deleted
 *   by anything other than the snapshot predicate would take a neighbouring
 *   load with it and still report the right number.
 * - **The tombstone survives the round trip through the database.** The archive
 *   ref is a JSON column now; a ref that did not come back out of MySQL would
 *   make the `catalog` source's refusal say no copy exists — which is precisely
 *   the lie this feature is arranged to avoid.
 * - **The refusal a workflow gets names the archive.** That sentence is built by
 *   `sources.ts` from a `SnapshotRef`, and until something recorded an archive
 *   its archive branch had never once run against a real store.
 */

let container: StartedMySqlContainer;
let db: CatalogDatabase;
let root: string;

beforeAll(async () => {
  container = await startMySql();
  db = await openCatalogDatabase(container, 'catalog');
  root = await mkdtemp(join(tmpdir(), 'catalog-evict-db-'));
}, 300_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await db?.close();
  await container?.stop();
});

const FIELDS = ['id', 'label', 'score', 'active', 'seenAt'];

async function physicalRows(typeName: string, snapshotId: string): Promise<number> {
  const [{ n }] = await db.orm.em
    .getConnection()
    .execute<Array<{ n: number }>>(
      `SELECT COUNT(*) AS n FROM \`${tableFor(typeName)}\` WHERE \`_snapshot_id\` = ?`,
      [snapshotId],
    );
  return Number(n);
}

/** Archive one committed snapshot through the real writer, and hand back the ref. */
async function archive(typeName: string, snapshotId: string) {
  const type = contractType(typeName);
  const archives = localArchiveStore(root);
  const path = archivePathFor('archive', typeName, snapshotId);
  const known = await db.store.listSnapshots(type);
  const snapshot = known.find((each) => each.id === snapshotId);
  if (!snapshot) throw new Error(`fixture: no snapshot ${snapshotId}`);
  const ref = await archiveSnapshot({
    type,
    snapshotId,
    rows: db.store.streamSnapshot(type, FIELDS, snapshotId, { provenance: true }),
    expectedRowCount: snapshot.rowCount,
    store: archives,
    path,
    disk: 'archives',
  });
  return { archives, ref, type };
}

describe('evicting a snapshot out of a real warehouse', () => {
  it('deletes exactly that snapshot and leaves a tombstone that says where the bytes went', async () => {
    const type = contractType('Evicted');
    await db.publish(type);

    await db.store.write(type, [contractRow('a', 'old', 1), contractRow('b', 'old', 2)], {
      snapshotId: 'load-1',
      principalId: 'spec',
    });
    await db.store.commit(type, 'load-1');
    await db.store.write(type, [contractRow('a', 'new', 3)], {
      snapshotId: 'load-2',
      principalId: 'spec',
    });
    await db.store.commit(type, 'load-2');

    expect(await physicalRows(type.name, 'load-1')).toBe(2);
    const { archives, ref } = await archive(type.name, 'load-1');

    const evicted = await evictSnapshot({
      type,
      snapshotId: 'load-1',
      store: db.store,
      archives,
      archive: ref,
    });

    expect(evicted.deleted).toBe(true);
    expect(evicted.rowCount).toBe(2);
    // Gone, and the neighbouring load is untouched — the two live in the same
    // physical table.
    expect(await physicalRows(type.name, 'load-1')).toBe(0);
    expect(await physicalRows(type.name, 'load-2')).toBe(1);

    const tombstone = (await db.store.listSnapshots(type)).find((each) => each.id === 'load-1');
    expect(tombstone?.droppedAt).toBeDefined();
    // The count taken before the delete, not a fresh zero.
    expect(tombstone?.rowCount).toBe(2);
    // The half this PR adds: the tombstone knows where the copy is, out of the
    // database and back.
    expect(tombstone?.archive?.path).toBe(ref.path);
    expect(tombstone?.archive?.disk).toBe('archives');
    expect(tombstone?.archive?.checksum).toBe(ref.checksum);
    expect(tombstone?.archive?.verifiedAt).toBeTruthy();

    // And the served load still reads, which is the thing an eviction must
    // never be able to disturb.
    const current = await db.store.read(type, FIELDS, { page: 1, size: 25 });
    expect(current.total).toBe(1);
  });

  /**
   * The sentence somebody actually reads when they go looking for the data.
   *
   * `sources.ts` builds two versions of this refusal — one for a tombstone with
   * an archive and one for a tombstone without — and until an eviction recorded
   * an archive the first branch had never been reachable against a real store.
   * Getting it wrong is not a cosmetic failure: it is the difference between
   * restoring a copy and re-running a load that did not need re-running.
   */
  it('makes the workflow refusal name the archive instead of saying no copy exists', async () => {
    const type = contractType('EvictedSource');
    await db.publish(type);
    await db.store.write(type, [contractRow('a', 'old', 1)], {
      snapshotId: 'src-1',
      principalId: 'spec',
    });
    await db.store.commit(type, 'src-1');
    await db.store.write(type, [contractRow('a', 'new', 2)], {
      snapshotId: 'src-2',
      principalId: 'spec',
    });
    await db.store.commit(type, 'src-2');

    const { archives, ref } = await archive(type.name, 'src-1');
    await evictSnapshot({ type, snapshotId: 'src-1', store: db.store, archives, archive: ref });

    const readEvicted = async (): Promise<unknown> =>
      SOURCES.catalog({
        connector: {
          id: 'src',
          name: 'Read the evicted snapshot',
          kind: 'catalog',
          targetType: '',
          config: { objectType: type.name, objectSnapshot: 'src-1' },
          enabled: true,
          createdBy: 'spec',
          createdAt: 'now',
          updatedAt: 'now',
        },
        state: {},
        mode: 'full',
        catalog: { getType: (name) => (name === type.name ? type : undefined), store: db.store },
      });

    await expect(readEvicted()).rejects.toThrow(`written to ${ref.path}`);
    await expect(readEvicted()).rejects.toThrow(/on the "archives" disk/);
    // And not the branch that would have run before an eviction recorded
    // anything, which is the one that sends somebody to re-run a load.
    await expect(readEvicted()).rejects.not.toThrow(/No copy of it was recorded anywhere/);
  });

  it('will not evict the snapshot the type is serving, and the store is what says so', async () => {
    const type = contractType('EvictedServed');
    await db.publish(type);
    await db.store.write(type, [contractRow('a', 'only', 1)], {
      snapshotId: 'served-1',
      principalId: 'spec',
    });
    await db.store.commit(type, 'served-1');

    const { archives, ref } = await archive(type.name, 'served-1');
    await expect(
      evictSnapshot({ type, snapshotId: 'served-1', store: db.store, archives, archive: ref }),
    ).rejects.toThrow(/being served/i);

    expect(await physicalRows(type.name, 'served-1')).toBe(1);
  });

  /**
   * A commit of a snapshot that has been evicted would point the type at no
   * rows. `commit` refuses on the tombstone, and it now re-asks that question
   * under the same lock `dropSnapshot` takes — so the two cannot interleave into
   * a served snapshot with no data.
   */
  it('leaves an evicted snapshot uncommittable, so a rollback to it refuses', async () => {
    const type = contractType('EvictedRollback');
    await db.publish(type);
    await db.store.write(type, [contractRow('a', 'old', 1)], {
      snapshotId: 'roll-1',
      principalId: 'spec',
    });
    await db.store.commit(type, 'roll-1');
    await db.store.write(type, [contractRow('a', 'new', 2)], {
      snapshotId: 'roll-2',
      principalId: 'spec',
    });
    await db.store.commit(type, 'roll-2');

    const { archives, ref } = await archive(type.name, 'roll-1');
    await evictSnapshot({ type, snapshotId: 'roll-1', store: db.store, archives, archive: ref });

    await expect(db.store.commit(type, 'roll-1')).rejects.toThrow(/dropped on/i);
    expect((await db.store.currentSnapshot(type))?.id).toBe('roll-2');
  });

  /**
   * The sweep, end to end, against the state a deployment is actually in: more
   * loads than anybody wants to keep, and only some of them archived.
   */
  it('sweeps a type down to its retention and reports what it could not take', async () => {
    const type = contractType('EvictedSweep');
    await db.publish(type);
    for (const id of ['s1', 's2', 's3', 's4']) {
      await db.store.write(type, [contractRow('a', id, 1), contractRow('b', id, 2)], {
        snapshotId: id,
        principalId: 'spec',
      });
      await db.store.commit(type, id);
    }

    // s1 and s2 are archived and recorded; s3 is not. With `keep: 2` the
    // candidates are s1 and s2 (s4 is served and takes a slot, s3 takes the
    // other), so everything archived is evictable and nothing else is offered.
    const archives = localArchiveStore(root);
    for (const id of ['s1', 's2']) {
      const { ref } = await archive(type.name, id);
      await db.store.recordSnapshotArchive(type, id, ref);
    }

    const sweep = await evictSnapshots({ type, store: db.store, archives, retention: { keep: 2 } });
    expect(sweep.evicted.map((each) => each.snapshotId)).toEqual(['s1', 's2']);
    expect(sweep.skipped).toEqual([]);

    expect(await physicalRows(type.name, 's1')).toBe(0);
    expect(await physicalRows(type.name, 's2')).toBe(0);
    expect(await physicalRows(type.name, 's3')).toBe(2);
    expect(await physicalRows(type.name, 's4')).toBe(2);

    // Run it again, tighter. The two tombstones do not consume retention slots,
    // so with `keep: 1` the served s4 fills the only one and s3 becomes a
    // candidate — and it has no archive, so it is reported rather than deleted.
    const again = await evictSnapshots({ type, store: db.store, archives, retention: { keep: 1 } });
    expect(again.evicted).toEqual([]);
    expect(again.skipped.map((each) => each.snapshotId)).toEqual(['s3']);
    expect(again.skipped[0]?.reason).toMatch(/no archive of it is recorded/i);
    expect(await physicalRows(type.name, 's3')).toBe(2);
  });
});
