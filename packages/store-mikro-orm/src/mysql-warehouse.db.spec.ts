import type { StartedMySqlContainer } from '@testcontainers/mysql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ContractStore,
  contractRow,
  contractType,
  describeCatalogStoreContract,
} from '../../../test/catalog-store-contract';
import { type CatalogDatabase, openCatalogDatabase, startMySql } from '../test/mysql-harness';

/**
 * The MikroORM warehouse store, against a real MySQL.
 *
 * Everything this adapter promises is a promise about statements: that a
 * `DELETE` + `INSERT` pair makes a re-sent batch replace itself, that an
 * anti-join copies exactly the rows a load did not supersede, that a view moves
 * under a metadata lock rather than being dropped and recreated. None of that is
 * observable without an engine, so the suite boots one.
 *
 * The bulk of the cases live in the shared contract, which is the point of
 * having one. What is left here is the handful of refusals that belong to this
 * adapter specifically — each of them guarding a load that would otherwise
 * succeed and leave the data wrong, which is the only class of bug worth this
 * much machinery.
 */

let container: StartedMySqlContainer;
let db: CatalogDatabase;

beforeAll(async () => {
  container = await startMySql();
  db = await openCatalogDatabase(container, 'catalog');
}, 300_000);

afterAll(async () => {
  await db?.close();
  await container?.stop();
});

describe('MySqlWarehouseStore', () => {
  describeCatalogStoreContract(
    (): ContractStore => ({
      name: 'mysql',
      store: db.store,
      publish: (type) => db.publish(type),
      readBackType: async (name) => db.registry.getType(name),
    }),
  );

  it('reports emulated snapshots rather than native ones', () => {
    // Worth pinning because the label is a promise to a caller composing stores:
    // the fan-out intersects these, and an adapter that overstated itself would
    // let a configuration advertise history it cannot serve. MySQL keeps none of
    // its own — history here is a column — and the capability object says so.
    expect(db.store.capabilities.snapshots).toBe('emulated');
    expect(db.store.capabilities.timeTravel).toBe(true);
    // Both false, and both deliberately: `write` is a DELETE and an INSERT with
    // a moment in between showing neither copy, and no operation here wraps its
    // statements in one transaction. A caller writing recovery logic has to know
    // that re-running is the repair rather than expecting a rollback.
    expect(db.store.capabilities.atomicBatchReplace).toBe(false);
    expect(db.store.capabilities.transactional).toBe(false);
  });

  it('refuses a batch numbered below zero, which the store keeps for itself', async () => {
    // Carried rows are written under a negative batch so they stay separable
    // from a load's own by a predicate rather than by convention. A caller who
    // numbered a batch -1 would have it silently deleted by the next merge, and
    // the symptom is one chunk of a load that keeps disappearing.
    const type = contractType('MySqlNegativeBatch');
    await db.publish(type);

    await expect(
      db.store.write(type, [contractRow('a', 'alpha', 1)], {
        snapshotId: 'neg',
        principalId: 'contract',
        batch: -1,
      }),
    ).rejects.toThrow(/negative/i);
  });

  it('refuses a load whose fields match nothing in the type', async () => {
    // Every field is looked up by property name, so records that share no name
    // with the type produce rows of pure NULL — and the load then reports a row
    // count, commits, and repoints the view at data that says nothing. Losing
    // sight of a real dataset because a CSV had different headers is what this
    // guard is for.
    const type = contractType('MySqlUnmatchedFields');
    await db.publish(type);

    await expect(
      db.store.write(type, [{ totally: 'different', headers: 'here' }], {
        snapshotId: 'mismatch',
        principalId: 'contract',
        batch: 0,
      }),
    ).rejects.toThrow(/None of the incoming fields match/i);
  });

  it('refuses to merge rows whose primary key is NULL', async () => {
    // A declared key is not a populated one. With `=` semantics a NULL-keyed row
    // matches nothing on either side of the anti-join: it is carried forward on
    // this run, carried again on the next, and duplicates itself once per run
    // forever. The counts stay plausible for a while, which is what makes it
    // expensive to find later.
    const type = contractType('MySqlUnkeyedMerge');
    await db.publish(type);

    await db.store.write(type, [contractRow('a', 'alpha', 1)], {
      snapshotId: 'base',
      principalId: 'contract',
      batch: 0,
    });
    await db.store.commit(type, 'base');

    await db.store.write(type, [{ id: null, label: 'no key at all', score: 2, active: true }], {
      snapshotId: 'unkeyed',
      principalId: 'contract',
      batch: 0,
    });

    await expect(
      db.store.carryForward(type, 'unkeyed', { principalId: 'contract' }),
    ).rejects.toThrow(/primary key/i);
  });

  it('refuses to merge a type that declares no primary key at all', async () => {
    // Refused rather than worked around, because both workarounds are worse than
    // an error: appending without a key duplicates the dataset every run, and
    // quietly promoting the load to a full reload commits whatever partial slice
    // the source handed over as the complete state.
    const keyless = contractType('MySqlKeylessType');
    keyless.primaryKey = [];
    for (const property of keyless.properties) property.primary = false;
    await db.publish(keyless);

    await db.store.write(keyless, [contractRow('a', 'alpha', 1)], {
      snapshotId: 'keyless',
      principalId: 'contract',
      batch: 0,
    });

    await expect(
      db.store.carryForward(keyless, 'keyless', { principalId: 'contract' }),
    ).rejects.toThrow(/no primary key/i);
  });

  it('hands a date back in MySQL’s own rendering rather than as ISO — a known divergence', async () => {
    // Recorded rather than asserted-around, because it is a real gap and this is
    // where an adapter author will meet it.
    //
    // `normalise` converts a `Date` to an ISO string, and for a date column that
    // arm never runs: MikroORM's MySQL connection sets `dateStrings = true`
    // unconditionally, so `DATETIME` always arrives as `YYYY-MM-DD hh:mm:ss`
    // text and is handed straight through. The ClickHouse adapter has an
    // explicit branch for exactly this wire format and turns it into ISO,
    // documenting that it exists so two adapters cannot return two date formats
    // — so today they do, and the string this one returns has no zone in it,
    // which `new Date()` reads as local.
    //
    // Not repaired here: appending `Z` on the way out is only correct when the
    // rows were stored in UTC, and whether they were is a host decision
    // (`forceUtcTimezone`) the adapter cannot see. A fix has to take the
    // connection's timezone into account, which is a change to the adapter's
    // configuration surface rather than to one branch. When it lands, this case
    // fails and the comment above says why.
    const type = contractType('MySqlDateRendering');
    await db.publish(type);
    await db.store.write(
      type,
      [{ id: 'a', label: 'l', score: 1, active: true, seenAt: '2026-01-02T03:04:05.000Z' }],
      { snapshotId: 'dates', principalId: 'contract', batch: 0 },
    );
    await db.store.commit(type, 'dates');

    const [row] = (await db.store.read(type, ['id', 'seenAt'], { page: 1, size: 5 })).rows;
    expect(row?.seenAt).toBe('2026-01-02 03:04:05');
  });

  it('adds a reserved column to a table created before that column existed', async () => {
    // `_batch` only appears in CREATE TABLE, so a table created by an older
    // version of this package is one column short — and the failure lands at
    // write time, on a table that looks fine, hours or releases away from the
    // change that caused it.
    const type = contractType('MySqlOldTable');
    await db.publish(type);
    await db.execute('ALTER TABLE `obj_mysqloldtable` DROP COLUMN `_batch`');

    // `ensureType` is what a republish runs, and it has to reconcile the
    // reserved columns as well as the declared ones.
    await db.store.ensureType(type);
    await db.store.write(type, [contractRow('a', 'alpha', 1)], {
      snapshotId: 'evolved',
      principalId: 'contract',
      batch: 3,
    });
    await db.store.commit(type, 'evolved');

    const rows = await db.store.read(type, ['id', 'label'], { page: 1, size: 10 });
    expect(rows.total).toBe(1);
  });
  // -------------------------------------------------------------------------
  // Streaming a query, which is what the CSV export runs on.
  // -------------------------------------------------------------------------

  it('hands rows over as the engine produces them, not after it has produced them all', async () => {
    // The claim `streamQuery` makes to the export route is that nothing between
    // the engine and the consumer holds the whole result. That is a claim about
    // what the driver does, so it cannot be checked against a fake — and it
    // cannot be checked by looking at the rows either, since a buffered read
    // returns exactly the same ones.
    //
    // So it is timed, against an engine made deliberately slow to produce: a
    // per-row `SLEEP` of 10ms over 400 rows means the last row cannot exist
    // before four seconds have passed. Reading three rows and stopping is fast
    // only if the first ones crossed the wire while the rest were still being
    // computed.
    //
    // **The rows have to be wide, and that is the part that is easy to get
    // wrong.** MySQL writes result rows into a network buffer and flushes it
    // when it fills (`net_buffer_length`, 16KB by default), so 400 narrow rows
    // go out in a single packet at the END of the statement and a probe built on
    // them measures the server's buffering rather than the driver's. Measured:
    // with a 4-byte column, the first row arrives at 4.1 seconds through
    // MikroORM AND through raw mysql2 — the shape that looks exactly like a
    // driver that does not stream, on a driver that does. At 30KB a row the
    // first arrives in ~22ms both ways.
    //
    // No `ORDER BY`, for the neighbouring reason: a sort is entitled to read the
    // whole result before emitting anything.
    const type = contractType('MySqlStreamedQuery');
    await db.publish(type);
    const rows = Array.from({ length: 400 }, (_, index) =>
      contractRow(`id-${index}`, `label-${index}`, index),
    );
    await db.store.write(type, rows, { snapshotId: 'streamed', principalId: 'contract', batch: 0 });
    await db.store.commit(type, 'streamed');

    const slow =
      "SELECT id, REPEAT('x', 30000) AS payload, SLEEP(0.01) AS slept FROM mysqlstreamedquery";
    const started = Date.now();
    let elapsed = 0;
    const seen: Array<Record<string, unknown>> = [];
    for await (const row of db.store.streamQuery({ sql: slow })) {
      seen.push(row);
      if (seen.length === 3) {
        // Measured HERE rather than after the loop. Leaving the loop unwinds the
        // generator, and that teardown waits for the engine to finish the
        // statement it is still running — around four more seconds here, which
        // would swamp the number this case is about.
        elapsed = Date.now() - started;
        break;
      }
    }

    expect(seen).toHaveLength(3);
    expect(typeof seen[0].id).toBe('string');
    // Three rows at 10ms each is 30ms; the whole result is four seconds. A
    // second of headroom keeps this from being a benchmark while leaving the two
    // outcomes four times apart.
    expect(elapsed).toBeLessThan(1_000);

    // Leaving the loop ran the generator's `finally`, which rolled the read-only
    // transaction back and released the connection. If it had not, the pool
    // would be one connection short and this next read would eventually hang
    // rather than answer.
    const after = await db.store.read(type, ['id'], { page: 1, size: 1 });
    expect(after.total).toBe(400);
  });

  it('streams every row when nothing stops it, with no cap of its own', async () => {
    // The buffered read caps at `maxRows` and reports `truncated`; this one is
    // asked for a file and must not invent a bound the caller did not ask for.
    const type = contractType('MySqlStreamedWhole');
    await db.publish(type);
    await db.store.write(
      type,
      Array.from({ length: 2_500 }, (_, index) => contractRow(`id-${index}`, 'l', index)),
      { snapshotId: 'whole', principalId: 'contract', batch: 0 },
    );
    await db.store.commit(type, 'whole');

    let counted = 0;
    for await (const _row of db.store.streamQuery({
      sql: 'SELECT id FROM mysqlstreamedwhole',
    })) {
      counted += 1;
    }

    // Past `runReadOnlyQuery`'s 1,000-row default, which is the number this
    // would stop at if the export had gone through the buffered read.
    expect(counted).toBe(2_500);
  });

  it('refuses a write inside the transaction it streams in', async () => {
    // Same guarantee the buffered read makes, obtained differently: that one
    // issues `START TRANSACTION READ ONLY` as a statement, this one takes a real
    // transaction handle and passes it to the stream, because a stream executed
    // on some other pooled connection would be protected by nothing.
    const type = contractType('MySqlStreamedReadOnly');
    await db.publish(type);
    await db.store.write(type, [contractRow('a', 'alpha', 1)], {
      snapshotId: 'ro',
      principalId: 'contract',
      batch: 0,
    });
    await db.store.commit(type, 'ro');

    const attempt = async () => {
      for await (const _row of db.store.streamQuery({
        sql: "INSERT INTO `obj_mysqlstreamedreadonly` (`id`) VALUES ('sneaky')",
      })) {
        // Never reached: the engine refuses the statement.
      }
    };

    await expect(attempt()).rejects.toThrow(/READ ONLY/i);
  });

  it('normalises the scalars a CSV cell cannot carry, exactly as the buffered read does', async () => {
    const type = contractType('MySqlStreamedScalars');
    await db.publish(type);
    await db.store.write(type, [contractRow('a', 'alpha', 7)], {
      snapshotId: 'scalars',
      principalId: 'contract',
      batch: 0,
    });
    await db.store.commit(type, 'scalars');

    const streamed: Array<Record<string, unknown>> = [];
    for await (const row of db.store.streamQuery({
      sql: 'SELECT id, score, CAST(1 AS UNSIGNED) AS big FROM mysqlstreamedscalars',
    })) {
      streamed.push(row);
    }
    const buffered = await db.store.runQuery({
      sql: 'SELECT id, score, CAST(1 AS UNSIGNED) AS big FROM mysqlstreamedscalars',
    });

    expect(streamed).toEqual(buffered.rows);
  });
});
