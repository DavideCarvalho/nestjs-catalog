import { type ClickHouseClient, createClient } from '@clickhouse/client';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ContractStore,
  contractRow,
  contractType,
  describeCatalogStoreContract,
} from '../../../test/catalog-store-contract';
import { ClickHouseWarehouseStore } from './clickhouse-warehouse.store';
import { RESERVED_COLUMNS } from './identifiers';
import { ensureCatalogClickHouseSchema } from './snapshots';

/**
 * The ClickHouse warehouse store, against a real ClickHouse.
 *
 * This adapter's whole idempotence story is physical — a batch is a partition,
 * a re-sent batch is built in a staging table and swapped in by `REPLACE
 * PARTITION`, and not one mutation is issued anywhere in the file. None of that
 * can be checked without a server: against a fake, `REPLACE PARTITION` and an
 * append are indistinguishable, and the bug the adapter was written to avoid —
 * `insert_deduplication_token` silently letting a late retry append — is exactly
 * the bug a fake would hide.
 *
 * The shared contract carries the behaviour this adapter has in common with
 * every other. What is left here is the layout guard, which is specific to this
 * engine and guards the failure with no other symptom.
 */

/**
 * Pinned. `EXCHANGE TABLES` needs an Atomic database engine and `REPLACE
 * PARTITION` needs a plain `MergeTree`; both are properties of a version, and a
 * floating tag would turn "ClickHouse changed" into "this adapter broke".
 */
const CLICKHOUSE_IMAGE = 'clickhouse/clickhouse-server:24.8-alpine';

let container: StartedTestContainer;
let client: ClickHouseClient;
let store: ClickHouseWarehouseStore;

beforeAll(async () => {
  container = await new GenericContainer(CLICKHOUSE_IMAGE)
    .withExposedPorts(8123)
    .withEnvironment({
      CLICKHOUSE_DB: 'catalog',
      CLICKHOUSE_USER: 'catalog',
      CLICKHOUSE_PASSWORD: 'catalog',
      CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: '1',
    })
    // ClickHouse logs a warning and runs degraded on the default container file
    // limit; raising it keeps the server out of the failure report when a case
    // does fail.
    .withUlimits({ nofile: { soft: 262144, hard: 262144 } })
    .withWaitStrategy(Wait.forHttp('/ping', 8123).forStatusCode(200))
    .withStartupTimeout(240_000)
    .start();

  client = createClient({
    url: `http://${container.getHost()}:${container.getMappedPort(8123)}`,
    username: 'catalog',
    password: 'catalog',
    database: 'catalog',
    clickhouse_settings: {
      // The same two the module's own client factory sets. Without the first,
      // every date column of every load fails to parse and the error names the
      // value rather than the setting, so it reads as bad data.
      date_time_input_format: 'best_effort',
      input_format_skip_unknown_fields: 1,
    },
  });

  await ensureCatalogClickHouseSchema(client);
  // One client for both roles, which is what a deployment without a separate
  // read-only credential gets. The console's safety does not come from the
  // credential — every statement is sent with `readonly = 1` — so this is the
  // configuration the adapter is expected to work under.
  store = new ClickHouseWarehouseStore(client, client, { verifyEngine: true });
}, 300_000);

afterAll(async () => {
  await client?.close();
  await container?.stop();
});

describe('ClickHouseWarehouseStore', () => {
  describeCatalogStoreContract(
    (): ContractStore => ({
      name: 'clickhouse',
      store,
      // Nothing to register: this adapter derives every table and column from
      // the def it is handed and resolves the served snapshot from its own
      // pointer table, so shaping the storage is the whole of publishing here.
      publish: (type) => store.ensureType(type),
      noModelReason:
        'This adapter stores rows, not the model. Saved queries, connector definitions and the type model are small, mutable, read-modify-write data, and a column store is the wrong home for them — a full deployment mounts this for the rows and a transactional store for the model.',
    }),
  );

  it('reports emulated snapshots, and an atomic batch replace the row store cannot offer', () => {
    // The three the core interface declares come out identical to the MySQL
    // store's, which is honest and unhelpful; the difference that decides
    // whether this adapter is safe for a deployment is the batch replace. It is
    // true here because the batch is staged and swapped under one metadata
    // commit, and false on MySQL because a DELETE and an INSERT briefly show
    // neither copy.
    expect(store.capabilities.snapshots).toBe('emulated');
    expect(store.capabilities.timeTravel).toBe(true);
    expect(store.capabilities.atomicBatchReplace).toBe(true);
    expect(store.capabilities.atomicCutover).toBe(true);
    // False, and there is no way to make it true: ClickHouse has no transactions
    // across statements, so every operation here is written to be re-runnable.
    expect(store.capabilities.transactional).toBe(false);
  });

  it('refuses an object table it did not shape', async () => {
    // The class of mistake with no other symptom. Pointed at a
    // `ReplacingMergeTree` the writes succeed and background merges quietly
    // erase old snapshots; pointed at a table repartitioned by month, a batch
    // retry drops a month. Both look like working loads right up until somebody
    // asks for last month's data and gets this month's.
    const type = contractType('ClickHouseWrongLayout');
    await client.command({
      query: `CREATE TABLE IF NOT EXISTS \`obj_clickhousewronglayout\` (
                \`_snapshot_id\` String,
                \`_principal_id\` String,
                \`_loaded_at\` DateTime64(3, 'UTC'),
                \`_batch\` Int32,
                \`_row\` UInt64,
                \`id\` Nullable(String)
              ) ENGINE = ReplacingMergeTree
                ORDER BY (\`_snapshot_id\`, \`_row\`)`,
    });

    await expect(store.ensureType(type)).rejects.toThrow(/not shaped the way this store writes/i);
  });

  it('replaces a batch of a snapshot that is already live and being served', async () => {
    // The case nobody plans for, and the one `atomicBatchReplace` is about: a
    // durable run whose commit already succeeded, retrying from the top and
    // re-sending its batches into a snapshot readers are on. The replacement has
    // to leave the served row count where it was — an append here doubles a
    // live dataset with no failure anywhere.
    const type = contractType('ClickHouseLiveRetry');
    await store.ensureType(type);

    await store.write(type, [contractRow('a', 'alpha', 1), contractRow('b', 'bravo', 2)], {
      snapshotId: 'live',
      principalId: 'contract',
      batch: 0,
    });
    await store.commit(type, 'live');
    expect((await store.read(type, ['id'], { page: 1, size: 50 })).total).toBe(2);

    await store.write(type, [contractRow('a', 'alpha', 1), contractRow('b', 'bravo', 2)], {
      snapshotId: 'live',
      principalId: 'contract',
      batch: 0,
    });

    const served = await store.read(type, ['id', 'label'], {
      page: 1,
      size: 50,
      sort: 'id',
      dir: 'asc',
    });
    expect(served.total).toBe(2);
    expect(served.rows.map((row) => row.id)).toEqual(['a', 'b']);
  });

  it('reserves exactly the columns the core package names, in the tables it creates', async () => {
    // The list is taken from the core package now rather than assembled from
    // this file's own constants, and this is the half of that move a re-export
    // cannot guarantee: that the columns actually in the DDL are the columns a
    // publisher's property name is checked against. Read off `system.columns`
    // rather than off the constants, because the failure being guarded is a
    // bookkeeping column that exists in the table and not in the list — which is
    // a property this store writes into its own metadata with no collision
    // reported and no error raised.
    const type = contractType('ClickHouseReservedLayout');
    await store.ensureType(type);

    const columns = await client.query({
      query: `SELECT \`name\` FROM system.columns
              WHERE \`database\` = currentDatabase() AND \`table\` = {t:String}`,
      query_params: { t: 'obj_clickhousereservedlayout' },
      format: 'JSONEachRow',
    });
    const names = (await columns.json<{ name: string }>()).map((row) => row.name);
    const declared = type.properties.map((property) => property.name);

    expect(names.filter((name) => !declared.includes(name)).sort()).toEqual(
      [...RESERVED_COLUMNS].sort(),
    );
  });

  it('filters case-insensitively on contains, the way the search box already does', async () => {
    // The one place this adapter deliberately does not transliterate MySQL, and
    // the one worth a real server. ClickHouse's `LIKE` is case-sensitive where
    // MySQL's is case-insensitive under the usual collations, so `contains` is
    // `ILIKE` here — the same choice `read()` makes for the search term, for the
    // same reason: a control that behaved differently depending on which adapter
    // was mounted would be read as a bug in the data.
    //
    // `eq` is asserted right beside it as the counter-case, because it is NOT
    // given that treatment and a reader should be able to see that it was a
    // decision. Matching MySQL there would mean lowering both sides of every
    // comparison — forfeiting the sparse index that is the reason to be on this
    // engine — and would still not match, MySQL's default collation being
    // accent-insensitive as well.
    const type = contractType('ClickHouseFilterCase');
    await store.ensureType(type);
    await store.write(type, [contractRow('a', 'Alpha', 1), contractRow('b', 'bravo', 2)], {
      snapshotId: 'case',
      principalId: 'contract',
      batch: 0,
    });
    await store.commit(type, 'case');

    const label = type.properties.find((property) => property.name === 'label');
    if (!label) throw new Error('the contract fixture lost its label property');

    const contains = await store.read(type, ['id', 'label'], {
      page: 1,
      size: 50,
      sort: 'id',
      dir: 'asc',
      filters: [{ property: label, op: 'contains', value: 'alp' }],
    });
    expect(contains.rows.map((row) => row.id)).toEqual(['a']);
    expect(contains.total).toBe(1);

    const exact = await store.read(type, ['id', 'label'], {
      page: 1,
      size: 50,
      sort: 'id',
      dir: 'asc',
      filters: [{ property: label, op: 'eq', value: 'alpha' }],
    });
    expect(exact.rows).toEqual([]);
    expect(exact.total).toBe(0);
  });
});
