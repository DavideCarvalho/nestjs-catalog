// First, and a side-effect import on purpose — see the note in `mysql-harness.ts`.
import 'reflect-metadata';
import { SnapshotRow } from '@dudousxd/nestjs-catalog-store-mikro-orm';
import type { StartedMySqlContainer } from '@testcontainers/mysql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CatalogDatabase, openCatalogDatabase, startMySql } from '../test/mysql-harness';

/**
 * Which snapshot dates a type — against the engine that decides it.
 *
 * `stored-registry.freshness.spec.ts` covers the JS side with a fake: that the
 * registry hydrates only the ids it was given, never scans, and renders the
 * three fields correctly. What a fake cannot cover is the statement itself, and
 * since the read stopped being `em.find` and became a grouped join written by
 * hand, the statement is now the part that can be wrong. A `GROUP BY` that
 * picked the oldest row, or a join that multiplied rows, would pass every unit
 * case in this package and put a date from March on a type loaded last night.
 *
 * So this file asserts the same freshness rules against real MySQL 8, and one
 * rule the unit suite cannot express at all: that the work does not grow with
 * the number of loads.
 */

let container: StartedMySqlContainer;
let db: CatalogDatabase;

/** A committed load of `typeName`, dated `committedAt`. */
async function commitLoad(
  fields: { typeName: string; snapshotId: string; principalId: string; rowCount: number },
  committedAt: Date,
  committed = true,
): Promise<void> {
  const em = db.orm.em.fork();
  const row = em.create(SnapshotRow, {
    id: `${fields.typeName}:${fields.snapshotId}`,
    ...fields,
    committed,
    createdAt: committedAt,
    committedAt,
  });
  em.persist(row);
  await em.flush();
}

async function publishType(name: string): Promise<void> {
  await db.publish({
    name,
    displayName: name,
    pluralDisplayName: `${name}s`,
    description: undefined,
    tableName: name.toLowerCase(),
    icon: undefined,
    group: 'default',
    titleProperty: undefined,
    primaryKey: ['id'],
    enriched: false,
    properties: [
      {
        name: 'id',
        displayName: 'Id',
        description: undefined,
        type: 'string',
        columnName: 'id',
        nullable: false,
        primary: true,
        hidden: false,
        order: 0,
        classification: undefined,
        unit: undefined,
        enriched: false,
      },
    ],
    relations: [],
  });
}

describe('the serving snapshot, decided by MySQL', () => {
  beforeAll(async () => {
    container = await startMySql();
    db = await openCatalogDatabase(container, 'freshness');
  }, 600_000);

  afterAll(async () => {
    await db?.close();
    await container?.stop();
  });

  it('serves the newest committed load of each type, independently', async () => {
    await publishType('Mvr');
    await publishType('Subwo');

    await commitLoad(
      { typeName: 'Mvr', snapshotId: 'm-1', principalId: 'old-loader', rowCount: 900 },
      new Date('2024-02-01T09:00:00Z'),
    );
    await commitLoad(
      { typeName: 'Mvr', snapshotId: 'm-2', principalId: 'flip-nestjs', rowCount: 4300 },
      new Date('2026-08-04T09:00:00Z'),
    );
    // A dead type beside a busy one. Dating every type by the liveliest is the
    // exact blindness the feature replaced, and a `MAX` without the partition
    // would reintroduce it while still looking like a grouped query.
    await commitLoad(
      { typeName: 'Subwo', snapshotId: 'w-1', principalId: 'legacy-loader', rowCount: 77 },
      new Date('2026-01-02T09:00:00Z'),
    );

    await db.registry.reload();
    const byName = new Map(db.registry.getSnapshot().types.map((t) => [t.name, t]));

    expect(byName.get('Mvr')).toMatchObject({
      lastCommittedAt: '2026-08-04T09:00:00.000Z',
      rowCount: 4300,
      lastPrincipalId: 'flip-nestjs',
    });
    expect(byName.get('Subwo')).toMatchObject({
      lastCommittedAt: '2026-01-02T09:00:00.000Z',
      rowCount: 77,
      lastPrincipalId: 'legacy-loader',
    });
  });

  it('ignores a load that is still in flight, however recent', async () => {
    await publishType('Mel');
    await commitLoad(
      { typeName: 'Mel', snapshotId: 'e-1', principalId: 'flip-nestjs', rowCount: 500 },
      new Date('2026-03-01T09:00:00Z'),
    );
    // Newer, and uncommitted: nobody is being served it. Dating the type by it
    // reports data as fresh at the precise moment the pipeline is broken.
    await commitLoad(
      { typeName: 'Mel', snapshotId: 'e-2', principalId: 'flip-nestjs', rowCount: 99_999 },
      new Date('2026-08-04T09:00:00Z'),
      false,
    );

    await db.registry.reload();
    const mel = db.registry.getSnapshot().types.find((t) => t.name === 'Mel');

    expect(mel?.lastCommittedAt).toBe('2026-03-01T09:00:00.000Z');
    expect(mel?.rowCount).toBe(500);
  });

  it('leaves the fields absent for a type nothing was ever committed to', async () => {
    await publishType('Manning');

    await db.registry.reload();
    const manning = db.registry.getSnapshot().types.find((t) => t.name === 'Manning');

    expect('lastCommittedAt' in (manning ?? {})).toBe(false);
  });

  it('yields one row per type when two loads commit in the same second', async () => {
    // `committed_at` is a DATETIME with no fractional seconds, so two loads of
    // one type committing inside the same second share the maximum and the join
    // returns BOTH. Unhandled that is a duplicated type in the reload; handled
    // badly it is a coin flip over which one dates the type. The `orderBy` in
    // `servingSnapshots` makes the highest id win, deterministically.
    await publishType('Fleet');
    const sameSecond = new Date('2026-05-05T12:00:00Z');
    await commitLoad(
      { typeName: 'Fleet', snapshotId: 'a', principalId: 'first', rowCount: 1 },
      sameSecond,
    );
    await commitLoad(
      { typeName: 'Fleet', snapshotId: 'b', principalId: 'second', rowCount: 2 },
      sameSecond,
    );

    await db.registry.reload();
    const fleets = db.registry.getSnapshot().types.filter((t) => t.name === 'Fleet');

    expect(fleets).toHaveLength(1);
    expect(fleets[0].lastPrincipalId).toBe('second');
    expect(fleets[0].rowCount).toBe(2);

    // Twice, because "deterministic" is the claim and one run cannot show it.
    await db.registry.reload();
    expect(db.registry.getSnapshot().types.find((t) => t.name === 'Fleet')?.lastPrincipalId).toBe(
      'second',
    );
  });

  it('hydrates a number of rows bounded by the types, not by the loads', async () => {
    // THE case, and the one only a real database can answer: the previous
    // implementation read every committed row ever written. So the assertion is
    // not a threshold — a magic number here would just encode today's fixture —
    // but a DERIVATIVE. Load the same type six hundred more times and the number
    // of rows the reload pulls back must not move at all. Under the old query it
    // moved by exactly six hundred.
    await publishType('Utilization');

    async function addLoads(from: number, count: number): Promise<void> {
      const rows: string[] = [];
      for (let i = from; i < from + count; i++) {
        rows.push(
          `('Utilization:u-${i}','Utilization','u-${i}','bulk',${i},TRUE,` +
            `DATE_ADD('2024-01-01', INTERVAL ${i} DAY),DATE_ADD('2024-01-01', INTERVAL ${i} DAY))`,
        );
      }
      await db.orm.em
        .getConnection()
        .execute(
          `INSERT INTO catalog_snapshot (id, type_name, snapshot_id, principal_id, row_count, committed, created_at, committed_at) VALUES ${rows.join(',')}`,
        );
    }

    /**
     * How many snapshot rows one reload asks the database to hand back.
     *
     * Read off the hydration statement's `IN (…)` list rather than off the
     * results, because the list IS the bound — it is exactly the set of ids the
     * grouped query named, and counting it needs no assumption about what came
     * back. The grouped statement itself is excluded: it does the narrowing, and
     * what is being measured is how much survives it.
     */
    async function rowsPulledByReload(): Promise<{ hydrated: number; grouped: boolean }> {
      const connection = db.orm.em.getConnection();
      const real = connection.execute.bind(connection);
      const statements: string[] = [];
      connection.execute = (query, params, method, ctx, loggerContext) => {
        statements.push(typeof query === 'string' ? query : '');
        return real(query, params, method, ctx, loggerContext);
      };
      try {
        await db.registry.reload();
      } finally {
        connection.execute = real;
      }

      const grouped = statements.some((sql) => /GROUP BY\s+type_name/i.test(sql));
      const hydration = statements.find(
        (sql) => /from\s+`?catalog_snapshot`?/i.test(sql) && /\bin\s*\(/i.test(sql),
      );
      const list = hydration?.match(/\bin\s*\(([^)]*)\)/i)?.[1] ?? '';
      const hydrated = list.length === 0 ? 0 : list.split(',').length;
      return { hydrated, grouped };
    }

    await addLoads(0, 600);
    const first = await rowsPulledByReload();

    await addLoads(600, 600);
    const [{ total }] = await db.orm.em
      .getConnection()
      .execute<Array<{ total: number }>>('SELECT COUNT(*) AS total FROM catalog_snapshot');
    expect(Number(total)).toBeGreaterThan(1_200);

    const second = await rowsPulledByReload();

    // First: the read is keyed at all. A reload that went back to scanning
    // would issue no `IN (…)` list, and "no list" must not read as "a bound of
    // zero" — without this the two assertions below pass trivially on the very
    // regression they exist to catch.
    expect(first.hydrated).toBeGreaterThan(0);
    // Twelve hundred committed loads in the table, and the second reload
    // hydrates not one row more than the first.
    expect(second.hydrated).toBe(first.hydrated);
    // And it is genuinely bounded by the types, not merely stable: far fewer
    // rows than the 1,200 sitting in the table.
    expect(first.hydrated).toBeLessThan(50);
    expect(first.grouped && second.grouped).toBe(true);

    // The newest load still wins, so the bound did not cost correctness.
    expect(db.registry.getSnapshot().types.find((t) => t.name === 'Utilization')?.rowCount).toBe(
      1_199,
    );
  });
});
