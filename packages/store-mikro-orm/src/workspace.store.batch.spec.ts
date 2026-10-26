import type { CatalogWorkspaceStore, SavedQuery } from '@dudousxd/nestjs-catalog';
import type { EntityManager } from '@mikro-orm/sql';
import { describe, expect, it, vi } from 'vitest';
import { SavedQueryRow } from './entities/workspace';
import { CatalogEnvironmentBundle } from './environment.bundle';
import { RoutingWorkspaceStore, runInEnvironment } from './environment.routing';
import { MySqlWorkspaceStore } from './workspace.store';

/**
 * Reading several saved queries at once, which is what an embedded dashboard
 * does with its cards: one statement for all of them rather than one per card.
 */

function row(id: string): SavedQueryRow {
  return Object.assign(new SavedQueryRow(), {
    id,
    name: `Query ${id}`,
    sql: 'select 1',
    createdBy: 'console',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    shared: true,
  });
}

function workspaceOver(rows: SavedQueryRow[]) {
  const find = vi.fn(async (_entity: unknown, where: { id: { $in: string[] } }) =>
    rows.filter((each) => where.id.$in.includes(each.id)),
  );
  const findOne = vi.fn();
  const em: EntityManager = Object.create(null);
  Object.assign(em, { fork: () => em, find, findOne });
  return { store: new MySqlWorkspaceStore(em), find, findOne };
}

describe('MySqlWorkspaceStore.getSavedQueries', () => {
  it('reads every id in one statement', async () => {
    const { store, find, findOne } = workspaceOver([row('a'), row('b'), row('c')]);

    const found = await store.getSavedQueries(['a', 'c', 'gone']);

    expect(found.map((query) => query.id).sort()).toEqual(['a', 'c']);
    expect(find).toHaveBeenCalledTimes(1);
    expect(find.mock.calls[0]?.[0]).toBe(SavedQueryRow);
    expect(find.mock.calls[0]?.[1]).toEqual({ id: { $in: ['a', 'c', 'gone'] } });
    expect(findOne).not.toHaveBeenCalled();
  });

  it('issues nothing for no ids', async () => {
    const { store, find } = workspaceOver([row('a')]);

    expect(await store.getSavedQueries([])).toEqual([]);
    expect(find).not.toHaveBeenCalled();
  });
});

function bundleWith(workspace: unknown): CatalogEnvironmentBundle {
  const bundle: CatalogEnvironmentBundle = Object.create(CatalogEnvironmentBundle.prototype);
  return Object.assign(bundle, { workspace });
}

const query = (id: string): SavedQuery =>
  ({ id, name: id, sql: 'select 1', shared: true }) as SavedQuery;

describe('RoutingWorkspaceStore.getSavedQueries', () => {
  it("forwards to the environment's batch read", async () => {
    const getSavedQueries = vi.fn(async (ids: readonly string[]) => ids.map(query));
    const getSavedQuery = vi.fn();
    const inner = { getSavedQueries, getSavedQuery } as unknown as CatalogWorkspaceStore;

    const found = await runInEnvironment(bundleWith(inner), () =>
      new RoutingWorkspaceStore().getSavedQueries(['a', 'b']),
    );

    expect(found.map((each) => each.id)).toEqual(['a', 'b']);
    expect(getSavedQueries).toHaveBeenCalledTimes(1);
    expect(getSavedQuery).not.toHaveBeenCalled();
  });
});

describe('RoutingWorkspaceStore summaries', () => {
  it("forwards both to the environment's store", async () => {
    const listSavedQuerySummaries = vi.fn(async () => [{ id: 'q', name: 'Q' }]);
    const listDashboardSummaries = vi.fn(async () => [{ id: 'd', name: 'D' }]);
    const inner = {
      listSavedQuerySummaries,
      listDashboardSummaries,
    } as unknown as CatalogWorkspaceStore;
    const routing = new RoutingWorkspaceStore();

    const [queries, dashboards] = await runInEnvironment(bundleWith(inner), () =>
      Promise.all([routing.listSavedQuerySummaries(), routing.listDashboardSummaries()]),
    );

    expect(queries).toEqual([{ id: 'q', name: 'Q' }]);
    expect(dashboards).toEqual([{ id: 'd', name: 'D' }]);
  });
});
