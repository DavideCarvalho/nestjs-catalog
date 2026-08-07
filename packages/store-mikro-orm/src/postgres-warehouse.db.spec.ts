import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ContractStore,
  contractRow,
  contractType,
  describeCatalogStoreContract,
} from '../../../test/catalog-store-contract';
import {
  type PostgresCatalogDatabase,
  openPostgresCatalogDatabase,
  startPostgres,
} from '../test/postgres-harness';

/**
 * The MikroORM warehouse store, against a real PostgreSQL.
 *
 * **The whole point of this file is the four lines that call
 * `describeCatalogStoreContract`.** The library's seam is the store interface;
 * a second adapter is worth having only if it can be trusted, and the only thing
 * that makes it trustworthy is passing the same cases the first one passes.
 * Writing a parallel suite here would have produced a Postgres store that is
 * correct about whatever its author happened to think of — which is precisely
 * the set of things it already gets right — and silent about every place the two
 * engines quietly disagree.
 *
 * Three of those disagreements were found by running this suite rather than by
 * reading the code, and each of them returns *plausible wrong data* rather than
 * an error:
 *
 * - MySQL's default collation is case-insensitive, so `LIKE '%a%'` matches `A`
 *   there and matches nothing on Postgres. The search box and the `contains`
 *   filter would have returned fewer rows on Postgres, with nothing logged.
 * - `TIMESTAMPTZ` renders as `2026-01-02 03:04:05+00` and `DATETIME` as
 *   `2026-01-02 03:04:05`, so the two adapters behind one interface would have
 *   handed out two date formats — the exact thing the contract's scalar case
 *   says it exists to prevent.
 * - `CREATE OR REPLACE VIEW` refuses a column inserted anywhere but the end, so
 *   every type that ever gained a property would have failed on the *commit*.
 *
 * What is left below the contract is the handful of behaviours that belong to
 * this dialect specifically, each of them a place where Postgres and MySQL
 * genuinely differ and the difference has to be pinned rather than assumed.
 */

let container: StartedPostgreSqlContainer;
let db: PostgresCatalogDatabase;

beforeAll(async () => {
  container = await startPostgres();
  db = await openPostgresCatalogDatabase(container, 'catalog_contract');
}, 300_000);

afterAll(async () => {
  await db?.close();
  await container?.stop();
});

describe('PostgresWarehouseStore', () => {
  describeCatalogStoreContract(
    (): ContractStore => ({
      name: 'postgres',
      store: db.store,
      publish: (type) => db.publish(type),
      readBackType: async (name) => db.registry.getType(name),
      // Double quotes, not backticks. See the hook's docblock: the contract used
      // to hard-code MySQL's spelling, and this adapter is what found it.
      quoteIdentifier: (value) => `"${value}"`,
    }),
  );

  it('declares the same capabilities MySQL does, including the atomic cutover', () => {
    // Identical to the MySQL adapter's, and worth pinning precisely because one
    // of the four is obtained by a completely different mechanism. `write` is
    // still a DELETE and an INSERT with a moment showing neither, and no
    // operation wraps its statements in one transaction — so both of those stay
    // false and a caller's recovery logic is unchanged.
    expect(db.store.capabilities.snapshots).toBe('emulated');
    expect(db.store.capabilities.timeTravel).toBe(true);
    expect(db.store.capabilities.atomicBatchReplace).toBe(false);
    expect(db.store.capabilities.transactional).toBe(false);
    // The interesting one. MySQL earns this from `CREATE OR REPLACE VIEW` taking
    // an exclusive metadata lock; Postgres cannot use that statement at all and
    // earns it from DDL being transactional. Same claim, different mechanism —
    // which is exactly the sort of thing a capability flag is for.
    expect(db.store.capabilities.atomicCutover).toBe(true);
  });

  it('moves the view when a committed type gains a property', async () => {
    // **The case that would have taken the deployment down.** Postgres's
    // `CREATE OR REPLACE VIEW` may only append columns at the *end* of a view's
    // column list — verified directly, it answers `cannot change name of view
    // column "_snapshot" to "score"`. `refreshView` pins `_snapshot` last and
    // puts the type's properties before it, so a type that gains a property
    // always inserts a column mid-list.
    //
    // Nothing about that is visible at publish time. It fails on the *commit* of
    // the next load, after the run has read the whole source and written every
    // row of it — which is the failure mode this codebase repeatedly refuses to
    // ship. So the store drops and recreates instead, inside a transaction.
    const def = contractType('PgViewWidening');
    await db.publish(def);
    await db.store.write(def, [contractRow('a', 'first', 1)], {
      snapshotId: 'v1',
      principalId: 'contract',
      batch: 0,
    });
    await db.store.commit(def, 'v1');

    const widened = {
      ...def,
      properties: [
        ...def.properties,
        {
          name: 'addedLater',
          displayName: 'Added Later',
          type: 'string' as const,
          columnName: 'addedLater',
          nullable: true,
          primary: false,
          hidden: false,
          order: def.properties.length,
          enriched: true,
        },
      ],
    };
    await db.publish(widened);
    await db.store.write(widened, [{ ...contractRow('b', 'second', 2), addedLater: 'x' }], {
      snapshotId: 'v2',
      principalId: 'contract',
      batch: 0,
    });

    // The assertion is simply that this does not throw. Before the dialect drew
    // the distinction it threw here, every time, for every widened type.
    await expect(db.store.commit(widened, 'v2')).resolves.toBeDefined();

    const columns = await db.execute(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'pgviewwidening' ORDER BY ordinal_position`,
    );
    expect(JSON.stringify(columns)).toContain('addedLater');
    // And `_snapshot` is still there rather than having been dropped along the
    // way — the recreate has to produce the whole view, not the new part of it.
    expect(JSON.stringify(columns)).toContain('_snapshot');
  });

  it('matches a search regardless of case, the way the MySQL adapter does', async () => {
    // MySQL's `utf8mb4_0900_ai_ci` makes `LIKE` case-insensitive; Postgres's
    // `LIKE` is case-sensitive and would have returned nothing here. That is a
    // difference with no error attached to it — a screen showing fewer rows —
    // so the dialect uses `ILIKE` and this pins the behaviour rather than the
    // operator.
    const def = await ready('PgSearchCase');
    await db.store.write(def, [contractRow('a', 'Ammunition', 1), contractRow('b', 'fuel', 2)], {
      snapshotId: 'search',
      principalId: 'contract',
      batch: 0,
    });
    await db.store.commit(def, 'search');

    const lower = await db.store.read(def, ['id', 'label'], { page: 1, size: 20, search: 'ammu' });
    const upper = await db.store.read(def, ['id', 'label'], { page: 1, size: 20, search: 'AMMU' });
    expect(lower.rows.map((row) => row.id)).toEqual(['a']);
    expect(upper.rows.map((row) => row.id)).toEqual(['a']);
  });

  it('keeps two properties whose names differ only in case, which MySQL cannot', async () => {
    // The asymmetry named in `dialect.foldsColumnCase`, asserted rather than
    // described. Postgres quotes identifiers, so `assetId` and `AssetID` are two
    // columns; MySQL folds, so the same type is refused there with a collision.
    //
    // This is the one place the two deployments genuinely differ in what they
    // accept, and it runs in the direction people do not expect: the *Postgres*
    // catalog is the permissive one. A model built here can fail to publish on
    // MySQL, which is worth a test so that nobody discovers it during a migration.
    const def = {
      ...contractType('PgCaseColumns'),
      properties: [
        ...contractType('PgCaseColumns').properties,
        {
          name: 'assetid',
          displayName: 'assetid',
          type: 'string' as const,
          columnName: 'assetid',
          nullable: true,
          primary: false,
          hidden: false,
          order: 5,
          enriched: true,
        },
        {
          name: 'assetId',
          displayName: 'assetId',
          type: 'string' as const,
          columnName: 'assetId',
          nullable: true,
          primary: false,
          hidden: false,
          order: 6,
          enriched: true,
        },
      ],
    };

    await expect(db.publish(def)).resolves.toBeUndefined();
    await db.store.write(
      def,
      [{ ...contractRow('a', 'l', 1), assetid: 'lower', assetId: 'mixed' }],
      {
        snapshotId: 'case',
        principalId: 'contract',
        batch: 0,
      },
    );
    await db.store.commit(def, 'case');

    const read = await db.store.read(def, ['id', 'assetid', 'assetId'], { page: 1, size: 20 });
    // Two columns, two values. Folding them would have made one overwrite the other.
    expect(read.rows[0]?.assetid).toBe('lower');
    expect(read.rows[0]?.assetId).toBe('mixed');
  });

  it('adds the snapshot/batch index to a table that predates it, and warns rather than failing', async () => {
    // Both halves of `ensureSnapshotBatchIndex`, which is the method whose
    // *failure* behaviour is deliberate: a missing index makes the next INSERT
    // slow, not wrong, so refusing the load would convert a performance problem
    // into an outage on a deployment whose database user may simply not hold the
    // privilege. Postgres needs `CREATE INDEX IF NOT EXISTS` rather than MySQL's
    // `ALTER TABLE ... ADD INDEX`, and unlike MySQL it is not idempotent without
    // the guard — a second call answers `relation "ix_snapshot_batch" already
    // exists`, which would have surfaced as a failed publish on the second pod.
    const def = contractType('PgOldTable');
    await db.publish(def);
    await db.execute('DROP INDEX IF EXISTS ix_snapshot_batch');

    await expect(db.store.ensureType(def)).resolves.toBeUndefined();
    const indexes = await db.execute(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'obj_pgoldtable'`,
    );
    expect(JSON.stringify(indexes)).toContain('ix_snapshot_batch');

    // And again, which is what a second pod booting does. The `IF NOT EXISTS`
    // is what keeps this from throwing.
    await expect(db.store.ensureType(def)).resolves.toBeUndefined();
  });

  it('refuses a write inside the read-only query path, and leaves no timeout behind', async () => {
    // Two claims in one case, because they are the two halves of one promise.
    //
    // The refusal goes through `streamQuery` rather than `runQuery`, and that is
    // forced rather than chosen: the buffered read wraps the caller's text in
    // `SELECT * FROM (...) AS "q"`, so an `INSERT` there is a *parse* error
    // before the engine ever reaches the access-mode check, and a case asserting
    // on it would be asserting that Postgres can read. The stream path attaches
    // no wrapper when there is neither budget nor cap, so the statement reaches
    // the server as written and the read-only transaction is what turns it away
    // — which is the guarantee being pinned. The MySQL suite tests it the same
    // way, for the same reason.
    const attempt = async () => {
      for await (const _row of db.store.streamQuery({
        sql: `INSERT INTO "obj_pgoldtable" ("_snapshot_id") VALUES ('sneaky')`,
      })) {
        // Never reached: the engine refuses the statement.
      }
    };
    await expect(attempt()).rejects.toThrow(/read-only/i);

    // The residue is the subtler half. MySQL's budget rides an optimizer hint
    // rather than a session variable precisely because a session variable
    // poisons the pooled connection for whoever borrows it next — measured, and
    // documented in `query.ts`. Postgres has no such hint, so it uses
    // `SET LOCAL statement_timeout`, and `LOCAL` is the whole reason that is
    // equivalent rather than a regression: it is unset when the transaction
    // ends. Asserted, because the failure it prevents is invisible — an
    // unrelated query on the same pooled connection dying at fifteen seconds.
    await db.store.runQuery({ sql: 'SELECT 1 AS one', timeoutMs: 1000 });
    const after = await db.execute('SHOW statement_timeout');
    expect(JSON.stringify(after)).toContain('"0"');
  });
});

/** Publish and hand back the def, matching the contract's own helper. */
async function ready(name: string) {
  const def = contractType(name);
  await db.publish(def);
  return def;
}
