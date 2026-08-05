import type { MikroORM } from '@mikro-orm/core';
/**
 * That a type says when its data was last committed.
 *
 * Until this existed, a type whose publisher had been deleted six months
 * earlier and a type loaded ten minutes ago produced identical payloads: the
 * definition carried a name, a table and its properties, and nothing about the
 * data. Every screen downstream inherited that blindness, and the failure mode
 * is somebody making a decision on a number from March.
 *
 * The rule most easily got wrong is which snapshot counts. An UNCOMMITTED row
 * is a load in flight or a load that failed — nobody is being served it — so
 * dating a type by one reports freshness that does not exist, which is worse
 * than reporting nothing.
 */
import type { EntityManager } from '@mikro-orm/mysql';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SnapshotRow } from './entities/governance';
import { ObjectTypeRow } from './entities/model';
import { StoredCatalogRegistry } from './stored-registry.service';

/** An `ObjectTypeRow` with a populated (empty) property collection. */
function typeRow(name: string): ObjectTypeRow {
  const row = Object.create(ObjectTypeRow.prototype);
  return Object.assign(row, {
    name,
    displayName: name,
    pluralDisplayName: `${name}s`,
    physicalTable: name.toLowerCase(),
    group: 'default',
    primaryKey: ['id'],
    properties: { getItems: () => [] },
  });
}

function snapshotRow(fields: Partial<SnapshotRow>): SnapshotRow {
  const row = Object.create(SnapshotRow.prototype);
  const assigned = Object.assign(row, { rowCount: 0, committed: true, ...fields });
  // Snapshot ids are `<type>:<snapshotId>` in the real schema, and the registry
  // now hydrates BY id, so a fixture without one silently matches nothing.
  assigned.id ??= `${assigned.typeName}:${assigned.snapshotId}`;
  return assigned;
}

/**
 * Which rows MySQL's grouped query would name as serving.
 *
 * The narrowing genuinely happens in SQL now, and a fake cannot test SQL — so
 * this reproduces the grouping only so the mapping cases below still have
 * realistic input. **The real proof that the statement selects the right rows is
 * `stored-registry.freshness.db.spec.ts`, which runs it against MySQL 8.** What
 * these unit cases still test honestly is everything on the JS side: that the
 * registry hydrates only what the query named, that it never falls back to
 * scanning, and how `toDef` renders the result.
 */
function servingIds(snapshots: SnapshotRow[]): Array<{ id: string }> {
  const newest = new Map<string, number>();
  for (const row of snapshots) {
    if (!row.committed || !row.committedAt) continue;
    const at = row.committedAt.getTime();
    if (at > (newest.get(row.typeName) ?? Number.NEGATIVE_INFINITY)) {
      newest.set(row.typeName, at);
    }
  }
  return snapshots
    .filter((row) => row.committed && row.committedAt?.getTime() === newest.get(row.typeName))
    .map((row) => ({ id: row.id }));
}

/**
 * An EntityManager that answers only what `reload` asks for, keyed by the entity
 * — so a change that starts asking for something else fails here rather than
 * silently receiving the wrong rows.
 *
 * The `SnapshotRow` branch REFUSES an unkeyed read. That refusal is the point:
 * the bug this file guards against is the registry reading the whole snapshot
 * table, and a fake that cheerfully answered such a read would let it back in.
 */
function emReturning(types: ObjectTypeRow[], snapshots: SnapshotRow[]) {
  const find = vi.fn(async (entity: unknown, where: Record<string, unknown>) => {
    if (entity === ObjectTypeRow) return types;
    if (entity === SnapshotRow) {
      const ids = idsIn(where.id);
      if (!ids) {
        throw new Error(
          `snapshots must be hydrated by id, not scanned — got ${JSON.stringify(where)}`,
        );
      }
      // Sorted the way the real query's `orderBy` sorts, because "keep the row
      // seen first" is only correct if the rows arrive newest-first.
      return snapshots
        .filter((row) => ids.includes(row.id))
        .sort(
          (a, b) =>
            (b.committedAt?.getTime() ?? 0) - (a.committedAt?.getTime() ?? 0) ||
            b.id.localeCompare(a.id),
        );
    }
    throw new Error('unexpected entity in reload');
  });
  // The parameter is declared even though the fake ignores it: the statement
  // itself is what two cases below assert on.
  const execute = vi.fn(async (_sql: string) => servingIds(snapshots));
  const fork = () => ({ find, getConnection: () => ({ execute }) });
  return { find: { fork }, spy: find, sql: execute };
}

/** The `$in` list out of a where clause, or undefined if the read is not keyed. */
function idsIn(clause: unknown): string[] | undefined {
  if (typeof clause !== 'object' || clause === null) return undefined;
  const values = Reflect.get(clause, '$in');
  if (!Array.isArray(values)) return undefined;
  return values.filter((value): value is string => typeof value === 'string');
}

function registryOver(types: ObjectTypeRow[], snapshots: SnapshotRow[]) {
  const em = emReturning(types, snapshots);
  const registry = Object.create(StoredCatalogRegistry.prototype);
  const orm: MikroORM | undefined = undefined;
  Object.assign(registry, {
    em: em.find,
    orm,
    options: {},
    snapshot: { version: 0, generatedAt: '', stats: {}, types: [] },
  });
  const typed: StoredCatalogRegistry = registry;
  return { registry: typed, spy: em.spy, sql: em.sql };
}

describe('a type reports when its data was last committed', () => {
  let committedAt: Date;

  beforeEach(() => {
    committedAt = new Date('2026-08-01T09:00:00.000Z');
  });

  it('carries the commit time, the row count and who wrote it', async () => {
    // All three from one row, because "stale since March" is never the last
    // question — "how much is in there, and who was loading it" follows
    // immediately, and both answers are already in the row being read.
    const { registry } = registryOver(
      [typeRow('Mvr')],
      [
        snapshotRow({
          typeName: 'Mvr',
          snapshotId: 's-1',
          principalId: 'flip-nestjs',
          rowCount: 4200,
          committedAt,
        }),
      ],
    );

    await registry.reload();
    const [type] = registry.getSnapshot().types;

    expect(type).toMatchObject({
      lastCommittedAt: committedAt.toISOString(),
      rowCount: 4200,
      lastPrincipalId: 'flip-nestjs',
    });
  });

  it('ignores snapshots that were never committed', async () => {
    // THE case. A load that is still running, or that failed half way, is not
    // what readers are being served — dating the type by it would report data
    // as fresh at the exact moment the pipeline is broken.
    const { registry, spy } = registryOver(
      [typeRow('Mvr')],
      [
        snapshotRow({
          typeName: 'Mvr',
          snapshotId: 's-2',
          principalId: 'flip-nestjs',
          rowCount: 999,
          committed: false,
          committedAt: new Date('2026-08-04T09:00:00.000Z'),
        }),
        snapshotRow({
          typeName: 'Mvr',
          snapshotId: 's-1',
          principalId: 'flip-nestjs',
          rowCount: 4200,
          committedAt,
        }),
      ],
    );

    await registry.reload();
    const [type] = registry.getSnapshot().types;

    expect(type.rowCount).toBe(4200);
    // Filtered in the QUERY, not after: a catalog with a long history would
    // otherwise drag every snapshot it ever wrote across the wire on each boot.
    // The uncommitted row is never hydrated at all, so it cannot be picked.
    expect(spy).not.toHaveBeenCalledWith(SnapshotRow, { committed: true }, expect.anything());
  });

  it('leaves the fields absent for a type nothing was ever committed to', async () => {
    // Absent, not zero and not epoch. A schema published and never loaded is a
    // different fact from a pipeline that stopped, and the two have different
    // fixes — collapsing them is how the second gets ignored.
    const { registry } = registryOver([typeRow('Subwo')], []);

    await registry.reload();
    const [type] = registry.getSnapshot().types;

    expect('lastCommittedAt' in type).toBe(false);
    expect('rowCount' in type).toBe(false);
    expect('lastPrincipalId' in type).toBe(false);
  });

  it('reads each type from its own snapshot, not from whichever is newest overall', async () => {
    // A busy type and a dead one share the table. Taking the newest row
    // globally would date every type by the liveliest of them, which is exactly
    // the blindness this replaced.
    const { registry } = registryOver(
      [typeRow('Mvr'), typeRow('Subwo')],
      [
        snapshotRow({
          typeName: 'Mvr',
          snapshotId: 'm-2',
          principalId: 'flip-nestjs',
          rowCount: 10,
          committedAt: new Date('2026-08-04T09:00:00.000Z'),
        }),
        snapshotRow({
          typeName: 'Subwo',
          snapshotId: 'w-1',
          principalId: 'legacy-loader',
          rowCount: 77,
          committedAt: new Date('2026-01-02T09:00:00.000Z'),
        }),
      ],
    );

    await registry.reload();
    const byName = new Map(registry.getSnapshot().types.map((t) => [t.name, t]));

    expect(byName.get('Mvr')?.lastCommittedAt).toBe('2026-08-04T09:00:00.000Z');
    expect(byName.get('Subwo')?.lastCommittedAt).toBe('2026-01-02T09:00:00.000Z');
    expect(byName.get('Subwo')?.lastPrincipalId).toBe('legacy-loader');
  });

  it('serves the newest of several commits for the same type', async () => {
    // Found by mutation: every other case here has one commit per type, so
    // "keep the first row seen" and "keep the last" behaved identically and the
    // ordering was untested. A type is loaded over and over — that is the
    // normal case, not the exotic one — and taking the wrong row means the
    // screen reports the age of a load that was superseded months ago.
    //
    // Rows arrive committedAt-descending because the query says so, so the
    // FIRST row for a type is the serving one and later rows must not replace
    // it.
    const { registry } = registryOver(
      [typeRow('Mvr')],
      [
        snapshotRow({
          typeName: 'Mvr',
          snapshotId: 'm-3',
          principalId: 'flip-nestjs',
          rowCount: 4300,
          committedAt: new Date('2026-08-04T09:00:00.000Z'),
        }),
        snapshotRow({
          typeName: 'Mvr',
          snapshotId: 'm-2',
          principalId: 'old-loader',
          rowCount: 900,
          committedAt: new Date('2026-02-01T09:00:00.000Z'),
        }),
      ],
    );

    await registry.reload();
    const [type] = registry.getSnapshot().types;

    expect(type.lastCommittedAt).toBe('2026-08-04T09:00:00.000Z');
    expect(type.rowCount).toBe(4300);
    expect(type.lastPrincipalId).toBe('flip-nestjs');
  });
});

/**
 * The cost of dating a type, which is a different question from the answer.
 *
 * This ran on every boot, every publish and every curation edit, and it read
 * every committed snapshot the deployment had ever written in order to keep one
 * per type. Measured against MySQL 8.0 at 200 types and 50k snapshots, that was
 * 450-500 ms of `reload()` and 161 MB of heap for rows that were discarded
 * immediately. Both are spent in the HOST's process — this package is mounted
 * inside somebody else's application — and both grow forever, because nothing
 * in this repo ever deletes a snapshot row.
 *
 * So the invariant worth defending is not a duration, which drifts with the
 * machine, but a shape: **what gets hydrated is bounded by the number of types,
 * not by the number of loads.** That survives a rewrite of the SQL; a timing
 * assertion would not.
 */
describe('dating a type does not read the whole snapshot history', () => {
  /** One type, loaded nightly for two years. */
  function history(typeName: string, loads: number): SnapshotRow[] {
    return Array.from({ length: loads }, (_, i) =>
      snapshotRow({
        typeName,
        snapshotId: `s-${String(i).padStart(4, '0')}`,
        principalId: 'flip-nestjs',
        rowCount: i,
        committedAt: new Date(Date.UTC(2024, 0, 1) + i * 86_400_000),
      }),
    );
  }

  it('hydrates one row per type, not one per load', async () => {
    const { registry, spy } = registryOver(
      [typeRow('Mvr'), typeRow('Subwo')],
      [...history('Mvr', 700), ...history('Subwo', 700)],
    );

    await registry.reload();

    const snapshotReads = spy.mock.calls.filter((call) => call[0] === SnapshotRow);
    expect(snapshotReads).toHaveLength(1);
    // TWO ids for two types, out of fourteen hundred rows. This is the whole
    // fix: the 1398 superseded rows never leave the database.
    expect(idsIn(snapshotReads[0][1].id)).toHaveLength(2);
  });

  it('asks the database to do the narrowing, and reads what it names', async () => {
    // The grouping is pushed into SQL rather than done in JS over the result.
    // Doing it in JS is what the unbounded version was: the rows still cross the
    // wire and still land in the host's heap, whichever process picks the winner.
    const { registry, sql, spy } = registryOver([typeRow('Mvr')], history('Mvr', 500));

    await registry.reload();

    expect(sql).toHaveBeenCalledTimes(1);
    const statement = sql.mock.calls[0][0];
    expect(statement).toMatch(/GROUP BY\s+type_name/i);
    expect(statement).toMatch(/MAX\(committed_at\)/i);
    // And the filter is in the statement, so an uncommitted load is excluded by
    // the engine rather than by a `.filter()` on rows already paid for.
    expect(statement).toMatch(/committed = TRUE/i);
    expect(spy.mock.calls.filter((call) => call[0] === SnapshotRow)).toHaveLength(1);
  });

  it('issues no snapshot read at all when nothing has ever been committed', async () => {
    // Not just an optimisation. An empty `$in` compiles to `WHERE id IN ()`,
    // which is a syntax error on MySQL — and a catalog whose types are published
    // but not yet loaded is the ordinary state of a fresh deployment, not an
    // edge case. Booting into a SQL error there would look like a broken schema.
    const { registry, spy } = registryOver([typeRow('Subwo')], []);

    await registry.reload();

    expect(spy.mock.calls.filter((call) => call[0] === SnapshotRow)).toHaveLength(0);
    expect('lastCommittedAt' in registry.getSnapshot().types[0]).toBe(false);
  });
});
