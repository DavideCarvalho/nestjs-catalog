import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StartedMySqlContainer } from '@testcontainers/mysql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ContractStore,
  contractRow,
  contractType,
  describeCatalogStoreContract,
} from '../../../test/catalog-store-contract';
import {
  type CatalogDatabase,
  openCatalogDatabase,
  startMySql,
} from '../../store-mikro-orm/test/mysql-harness';
import { CatalogFanoutError, FanoutCatalogStore } from './fanout.store';
import { FileFanoutJournal, InMemoryFanoutJournal } from './journal';
import { CatalogFanoutMigration } from './migration';

/**
 * The fan-out, over two real catalogs.
 *
 * **Why two databases rather than two mocks.** The asymmetry this package
 * encodes — one primary whose commit decides, N followers kept in step — only
 * means anything if the two sides can genuinely disagree. A stubbed follower
 * disagrees exactly when the stub is told to, which tests the stub. Two schemas
 * on one MySQL server disagree the way a deployment's two engines disagree: one
 * of them has a table and the other does not, one has committed a snapshot and
 * the other has not, and every read of either is a real read.
 *
 * **How a follower is made to fail.** Its object table is dropped out from under
 * it. That is not a contrived failure — it is the first one the replay's own
 * docblock names ("the reason the rows never arrived is quite often that the
 * table never did") — and it is deterministic: the store caches which tables it
 * has already reconciled for the life of the process, so a table that vanishes
 * afterwards produces a genuine engine error on the next write rather than a
 * silent re-create.
 *
 * The shared contract runs against the fan-out itself, because a fan-out *is* a
 * `CatalogWriteStore` and every caller above it treats it as one. What is left
 * here is the asymmetry, which no other adapter has.
 */

const PRIMARY = 'mysql-primary';
const FOLLOWER = 'mysql-follower';
const STRICT_FOLLOWER = 'mysql-strict';

let container: StartedMySqlContainer;
let primaryDb: CatalogDatabase;
let followerDb: CatalogDatabase;
let strictDb: CatalogDatabase;

let journal: InMemoryFanoutJournal;
/** Primary + one `recorded` follower. The ordinary migration shape. */
let fanout: FanoutCatalogStore;
let migration: CatalogFanoutMigration;
/** Primary + one `required` follower. The last stretch before a flip. */
let strictFanout: FanoutCatalogStore;

beforeAll(async () => {
  container = await startMySql();
  primaryDb = await openCatalogDatabase(container, 'fanout_primary');
  followerDb = await openCatalogDatabase(container, 'fanout_follower');
  strictDb = await openCatalogDatabase(container, 'fanout_strict');

  journal = new InMemoryFanoutJournal();
  fanout = new FanoutCatalogStore(
    { name: PRIMARY, store: primaryDb.store },
    [{ name: FOLLOWER, store: followerDb.store, strictness: 'recorded' }],
    journal,
  );
  migration = new CatalogFanoutMigration(fanout);

  strictFanout = new FanoutCatalogStore(
    { name: PRIMARY, store: primaryDb.store },
    [{ name: STRICT_FOLLOWER, store: strictDb.store, strictness: 'required' }],
    new InMemoryFanoutJournal(),
  );
}, 300_000);

afterAll(async () => {
  await primaryDb?.close();
  await followerDb?.close();
  await strictDb?.close();
  await container?.stop();
});

/** Publish on both sides, then let the fan-out reconcile the schema itself. */
async function publishEverywhere(
  type: ReturnType<typeof contractType>,
  followerSide: () => CatalogDatabase,
  store: FanoutCatalogStore,
): Promise<void> {
  await primaryDb.publish(type);
  await followerSide().publish(type);
  await store.ensureType(type);
}

describe('FanoutCatalogStore', () => {
  describeCatalogStoreContract(
    (): ContractStore => ({
      name: 'fan-out (mysql primary, mysql follower)',
      store: fanout,
      publish: (type) => publishEverywhere(type, () => followerDb, fanout),
      // Answered from the primary, because the primary is where the model lives
      // and reads never leave it. A follower's model is kept in step by the same
      // publish and is not what anybody is served from.
      readBackType: async (name) => primaryDb.registry.getType(name),
    }),
  );

  it('journals a recorded follower failure and publishes the load anyway', async () => {
    // The whole point of `recorded`. Nothing reads from a follower, so a
    // follower that is behind cannot give anybody a wrong answer — it can only
    // be incomplete, visibly, on the journal. Defaulting to `required` would
    // give an unproven mirror a veto over loads into the store that actually
    // serves traffic, which is the trade that makes teams turn the mirror off.
    const type = contractType('FanoutRecordedFailure');
    await publishEverywhere(type, () => followerDb, fanout);
    await followerDb.execute('DROP TABLE `obj_fanoutrecordedfailure`');

    const written = await fanout.write(
      type,
      [contractRow('a', 'alpha', 1), contractRow('b', 'bravo', 2)],
      { snapshotId: 'recorded-1', principalId: 'contract', batch: 0 },
    );
    // The primary's number, not the follower's and not the larger of the two: a
    // caller is entitled to one answer about what it just loaded.
    expect(written.written).toBe(2);

    const afterWrite = await journal.outstanding({ typeName: type.name });
    expect(afterWrite.map((entry) => entry.stage)).toContain('write');
    expect(afterWrite.every((entry) => entry.follower === FOLLOWER)).toBe(true);
    expect(afterWrite.some((entry) => entry.status === 'failed')).toBe(true);

    // The primary's commit is what decides that the load happened.
    const ref = await fanout.commit(type, 'recorded-1');
    expect(ref.id).toBe('recorded-1');
    expect(ref.rowCount).toBe(2);

    const served = await fanout.read(type, ['id', 'label'], { page: 1, size: 10, sort: 'id' });
    expect(served.rows.map((row) => row.id)).toEqual(['a', 'b']);

    // And the follower was held back rather than committed. A follower serving a
    // snapshot that is known to be short is worse than one serving yesterday's:
    // the first is current and wrong, the second is stale and obviously so.
    const held = await journal.outstanding({ typeName: type.name });
    expect(held.some((entry) => entry.stage === 'commit' && entry.status === 'heldBack')).toBe(
      true,
    );
    const onFollower = await fanout.readFrom(FOLLOWER, type, ['id'], { page: 1, size: 10 });
    expect(onFollower.total).toBe(0);
  });

  it('fails the load when a required follower cannot keep up, and publishes nothing anywhere', async () => {
    // `required` is the correct setting in the last stretch before the flip,
    // when divergence should stop the line. Every failure except the follower's
    // own commit is discovered before the primary has committed, so the load is
    // published nowhere and the caller's retry replays the whole thing — which
    // is what gives the setting teeth. It is not a rollback and this package
    // does not pretend to have one.
    const type = contractType('FanoutRequiredFailure');
    await publishEverywhere(type, () => strictDb, strictFanout);
    await strictDb.execute('DROP TABLE `obj_fanoutrequiredfailure`');

    await expect(
      strictFanout.write(type, [contractRow('a', 'alpha', 1)], {
        snapshotId: 'strict-1',
        principalId: 'contract',
        batch: 0,
      }),
    ).rejects.toThrow(CatalogFanoutError);

    // The primary took the batch — it always does, it goes first — but nothing
    // has been published, because nothing committed.
    expect((await strictFanout.read(type, ['id'], { page: 1, size: 10 })).total).toBe(0);

    // And the commit refuses too, before touching the primary, on the strength
    // of the journal alone.
    await expect(strictFanout.commit(type, 'strict-1')).rejects.toThrow(CatalogFanoutError);
    expect((await strictFanout.read(type, ['id'], { page: 1, size: 10 })).total).toBe(0);
  });

  it('replays a failed snapshot from the primary, with no source involved', async () => {
    // The property that makes this package defensible where a row-level dual
    // write would not be. A snapshot on the primary is complete, immutable and
    // addressed by id, so a follower that missed it can be repaired by copying
    // — nothing is re-fetched, nothing is recomputed, and the source is not
    // consulted. There is no source anywhere in this test, which is the point.
    const type = contractType('FanoutReplay');
    await publishEverywhere(type, () => followerDb, fanout);
    await followerDb.execute('DROP TABLE `obj_fanoutreplay`');

    await fanout.write(type, [contractRow('a', 'alpha', 1), contractRow('b', 'bravo', 2)], {
      snapshotId: 'replayed',
      principalId: 'the-original-loader',
      batch: 0,
    });
    await fanout.write(type, [contractRow('c', 'charlie', 3)], {
      snapshotId: 'replayed',
      principalId: 'the-original-loader',
      batch: 1,
    });
    await fanout.commit(type, 'replayed');
    expect((await journal.outstanding({ typeName: type.name })).length).toBeGreaterThan(0);

    const result = await migration.replay(type, 'replayed', FOLLOWER);

    expect(result.rows).toBe(3);
    // Committed on the follower, because this is the snapshot the primary is
    // serving. Backfilling an older one must not repoint a follower at last
    // week, and the journal's commit mark is what lets the replay tell the
    // difference.
    expect(result.committed).toBe(true);
    expect(result.cleared).toBeGreaterThan(0);
    expect(result.comparison.matches).toBe(true);
    expect(result.comparison.reasons).toEqual([]);

    const onFollower = await fanout.readFrom(FOLLOWER, type, ['id', 'label', 'score'], {
      page: 1,
      size: 10,
      sort: 'id',
      dir: 'asc',
    });
    expect(onFollower.rows.map((row) => row.id)).toEqual(['a', 'b', 'c']);
    expect(onFollower.rows.map((row) => row.label)).toEqual(['alpha', 'bravo', 'charlie']);

    // The debt is discharged, so the cutover gate is green for this type again.
    expect(await journal.outstanding({ typeName: type.name })).toEqual([]);

    // The repaired snapshot is still attributed to whoever loaded it. A snapshot
    // that changes owner when it is repaired loses the one thing its provenance
    // is for, and it is also the evidence that these rows came from the primary
    // rather than from a fresh load.
    const refs = await followerDb.store.listSnapshots(type);
    expect(refs.find((ref) => ref.id === 'replayed')?.principalId).toBe('the-original-loader');
  });

  it('verifies a type only once every follower agrees with the primary', async () => {
    // The cutover gate, and it is deliberately strict: "mostly caught up" is the
    // state every failed migration was in the day before it was discovered.
    //
    // Its own fan-out and its own journal, because `verify` consults the journal
    // *whole* even when it is handed one type — which is right, since flipping a
    // primary is a decision about the whole catalog and a debt on any type is a
    // reason not to. Sharing the suite's journal would mean this case reading
    // the debts the earlier ones deliberately left behind.
    const gated = new FanoutCatalogStore(
      { name: PRIMARY, store: primaryDb.store },
      [{ name: FOLLOWER, store: followerDb.store, strictness: 'recorded' }],
      new InMemoryFanoutJournal(),
    );
    const gate = new CatalogFanoutMigration(gated);

    const type = contractType('FanoutVerify');
    await publishEverywhere(type, () => followerDb, gated);
    await followerDb.execute('DROP TABLE `obj_fanoutverify`');

    await gated.write(type, [contractRow('a', 'alpha', 1)], {
      snapshotId: 'verify-1',
      principalId: 'contract',
      batch: 0,
    });
    await gated.commit(type, 'verify-1');

    const behind = await gate.verify({ types: [type] });
    expect(behind.ready).toBe(false);
    expect(behind.reasons.join(' ')).toMatch(/owes|never landed/i);

    await gate.replay(type, 'verify-1', FOLLOWER);

    const caughtUp = await gate.verify({ types: [type] });
    expect(caughtUp.reasons).toEqual([]);
    expect(caughtUp.ready).toBe(true);
  });

  it('writes a follower failure down somewhere that outlives the process', async () => {
    // The in-memory journal is fine for a test and is explicitly not the
    // default, because the failure this whole design exists to prevent is a
    // follower failure that nobody sees — and a record that disappears on the
    // next deploy is a record nobody sees. The file journal is checked by
    // reading it back through a second instance, which is what the next process
    // does.
    const directory = await mkdtemp(join(tmpdir(), 'catalog-fanout-'));
    const path = join(directory, 'journal.jsonl');
    const durable = new FanoutCatalogStore(
      { name: PRIMARY, store: primaryDb.store },
      [{ name: FOLLOWER, store: followerDb.store, strictness: 'recorded' }],
      new FileFanoutJournal(path),
    );

    const type = contractType('FanoutDurableJournal');
    await publishEverywhere(type, () => followerDb, durable);
    await followerDb.execute('DROP TABLE `obj_fanoutdurablejournal`');

    await durable.write(type, [contractRow('a', 'alpha', 1)], {
      snapshotId: 'durable-1',
      principalId: 'contract',
      batch: 0,
    });
    await durable.commit(type, 'durable-1');

    const reopened = new FileFanoutJournal(path);
    const outstanding = await reopened.outstanding({ typeName: type.name });
    expect(outstanding.length).toBeGreaterThan(0);
    expect(outstanding.every((entry) => entry.follower === FOLLOWER)).toBe(true);
    // And the commit mark, which is what a later replay consults to decide
    // whether the snapshot it is repairing is the live one.
    expect((await reopened.lastCommitted(type.name))?.snapshotId).toBe('durable-1');
  });
});
