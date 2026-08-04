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
  return Object.assign(row, { rowCount: 0, committed: true, ...fields });
}

/**
 * An EntityManager that answers only the two finds `reload` makes, keyed by the
 * entity asked for — so a change that starts asking for something else fails
 * here rather than silently receiving the wrong rows.
 */
function emReturning(types: ObjectTypeRow[], snapshots: SnapshotRow[]) {
  const find = vi.fn(async (entity: unknown, where: Record<string, unknown>) => {
    if (entity === ObjectTypeRow) return types;
    if (entity === SnapshotRow) {
      return where.committed === true ? snapshots.filter((s) => s.committed) : snapshots;
    }
    throw new Error('unexpected entity in reload');
  });
  return { find: { fork: () => ({ find }) }, spy: find };
}

function registryOver(types: ObjectTypeRow[], snapshots: SnapshotRow[]) {
  const em = emReturning(types, snapshots);
  const registry = Object.create(StoredCatalogRegistry.prototype);
  Object.assign(registry, {
    em: em.find,
    orm: {} as MikroORM,
    options: {},
    snapshot: { version: 0, generatedAt: '', stats: {}, types: [] },
  });
  return { registry: registry as StoredCatalogRegistry, spy: em.spy };
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
    expect(spy).toHaveBeenCalledWith(SnapshotRow, { committed: true }, expect.anything());
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
