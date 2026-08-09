import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StartedMySqlContainer } from '@testcontainers/mysql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contractRow, contractType } from '../../../test/catalog-store-contract';
import {
  type CatalogDatabase,
  openCatalogDatabase,
  startMySql,
} from '../../store-mikro-orm/test/mysql-harness';
import {
  ARCHIVE_PART_NAME,
  archivePathFor,
  archiveSnapshot,
  localArchiveStore,
} from './snapshot-archive';
import { parquetRecordsFrom } from './source-parquet';

/**
 * Archiving a snapshot out of a real warehouse, and reading it back.
 *
 * ## Why this is a `*.db.spec.ts`
 *
 * The unit spec beside this one feeds the archiver an array dressed as a stream,
 * which tests the encoder and proves nothing about the thing the feature is for.
 * What matters here is the join between two pieces neither of which this package
 * owns both ends of: the store's `streamSnapshot`, which decides **which rows**
 * and **in what order** and **in what shape** they arrive, and the parquet
 * encoder, which decides what survives being written down.
 *
 * Two properties can only be checked against a real engine:
 *
 * - **The archive holds one snapshot, not the table.** `obj_<type>` retains
 *   every committed load; an archiver that read the table instead of the
 *   snapshot would produce a file with every load in it and the right-looking
 *   size. So a second snapshot is committed first, and the count is the
 *   assertion.
 * - **The values survive the driver.** `normalise` turns a MySQL `DATETIME`
 *   into an ISO string and a `BIGINT` into a decimal string before the archiver
 *   ever sees them. Whether the archive round-trips *those* values is a question
 *   about mysql2's types, and a hand-built fixture answers it about the fixture.
 */

let container: StartedMySqlContainer;
let db: CatalogDatabase;
let root: string;

beforeAll(async () => {
  container = await startMySql();
  db = await openCatalogDatabase(container, 'catalog');
  root = await mkdtemp(join(tmpdir(), 'catalog-archive-db-'));
}, 300_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await db?.close();
  await container?.stop();
});

describe('archiving a snapshot out of a real warehouse', () => {
  it('archives one snapshot of a type that holds several, and reads every value back', async () => {
    const type = contractType('Archived');
    await db.publish(type);

    // The load that will be archived.
    const wanted = [
      contractRow('a', 'archived load', 1),
      contractRow('b', 'archived load', 2.5),
      contractRow('c', 'archived load', -3, false),
    ];
    await db.store.write(type, wanted, {
      snapshotId: 'load-1',
      principalId: 'spec',
      batch: 0,
    });
    const written = await db.store.commit(type, 'load-1');

    // A second, newer load, so the physical table holds both. Without this the
    // archiver could be reading the whole table and still produce the right
    // number.
    await db.store.write(type, [contractRow('a', 'later load', 99)], {
      snapshotId: 'load-2',
      principalId: 'spec',
      batch: 0,
    });
    await db.store.commit(type, 'load-2');

    const fields = type.properties.map((property) => property.name);
    // The rows exactly as the archiver will be given them — same store, same
    // method, same order — so what is asserted below is the archive's fidelity
    // and not a second opinion about what the snapshot contains.
    const expected: Array<Record<string, unknown>> = [];
    for await (const row of db.store.streamSnapshot(type, fields, 'load-1')) {
      expected.push({ ...row });
    }
    expect(expected).toHaveLength(3);

    const store = localArchiveStore(root);
    const path = archivePathFor('archive', type.name, 'load-1');
    const ref = await archiveSnapshot({
      type,
      snapshotId: 'load-1',
      rows: db.store.streamSnapshot(type, fields, 'load-1'),
      expectedRowCount: written.rowCount,
      store,
      path,
    });

    // Three rows, not four. The table holds both loads.
    expect(ref.rowCount).toBe(3);
    expect(ref.verifiedAt).toBeTruthy();

    const file = await store.read(`${path}/${ARCHIVE_PART_NAME}`);
    const back: unknown[] = [];
    for await (const record of parquetRecordsFrom(file, 'archived')) back.push(record);

    // Every value, including the `date` the driver handed over as an ISO string
    // and the `boolean` it handed over as a number.
    expect(back).toEqual(expected);
  });

  it('archives an empty snapshot, which is a real load and not a missing one', async () => {
    const type = contractType('ArchivedEmpty');
    await db.publish(type);

    // An empty batch creates the snapshot without rows — the shape a source that
    // legitimately returned nothing produces, and the one load somebody is most
    // likely to ask about later.
    await db.store.write(type, [], { snapshotId: 'empty-1', principalId: 'spec', batch: 0 });
    const written = await db.store.commit(type, 'empty-1');
    expect(written.rowCount).toBe(0);

    const store = localArchiveStore(root);
    const path = archivePathFor('archive', type.name, 'empty-1');
    const ref = await archiveSnapshot({
      type,
      snapshotId: 'empty-1',
      rows: db.store.streamSnapshot(
        type,
        type.properties.map((property) => property.name),
        'empty-1',
      ),
      expectedRowCount: 0,
      store,
      path,
    });

    expect(ref.rowCount).toBe(0);
    expect(ref.verifiedAt).toBeTruthy();
  });

  /**
   * The refusal that stands between a partial archive and a deletion.
   *
   * A snapshot whose stored count disagrees with what streams out of it is one
   * that moved under the read, and an archive of it is worthless whichever way
   * it moved. Nothing is written — not a short file, not a `.partial` — so there
   * is no artefact for a later step to mistake for a complete archive.
   */
  it('writes nothing when the snapshot streams fewer rows than it claims', async () => {
    const type = contractType('ArchivedShort');
    await db.publish(type);
    await db.store.write(type, [contractRow('a', 'one row', 1)], {
      snapshotId: 'short-1',
      principalId: 'spec',
      batch: 0,
    });
    await db.store.commit(type, 'short-1');

    const store = localArchiveStore(root);
    const path = archivePathFor('archive', type.name, 'short-1');
    await expect(
      archiveSnapshot({
        type,
        snapshotId: 'short-1',
        rows: db.store.streamSnapshot(
          type,
          type.properties.map((property) => property.name),
          'short-1',
        ),
        // A count nobody could satisfy, standing in for a snapshot that changed.
        expectedRowCount: 5,
        store,
        path,
      }),
    ).rejects.toThrow(/reports 5 rows and 1 were read/);

    await expect(store.read(`${path}/${ARCHIVE_PART_NAME}`)).rejects.toThrow();
  });
});
