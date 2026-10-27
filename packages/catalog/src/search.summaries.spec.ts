import { describe, expect, it, vi } from 'vitest';
import type { CatalogModuleOptions } from './catalog.options';
import type { CatalogRegistry } from './catalog.registry.base';
import { CatalogService } from './catalog.service';
import type { CatalogReadStore } from './catalog.store';
import type {
  CatalogWorkspaceStore,
  Dashboard,
  DashboardSummary,
  SavedQuery,
  SavedQuerySummary,
} from './catalog.workspace';

/**
 * Search reads saved queries and dashboards as the few fields it ranks, when
 * the store can hand them over that way, instead of every row in full — SQL,
 * visualization JSON and dashboard cards included — on every keystroke.
 *
 * The answer must not change, so each case runs the same search twice: once
 * against a store that offers the summaries and once against the same data in
 * a store that does not, which takes the path that lists the full rows.
 */

const QUERIES: SavedQuery[] = [
  query('q1', 'Vehicles by base', 'Fleet', 'Counts per base.'),
  query('q2', 'Overdue work orders', 'Maintenance'),
  query('q3', 'Base readiness', undefined, 'select from base'),
  query('q4', 'Fleet age', 'Fleet', 'How old the base fleet is.'),
];

const DASHBOARDS: Dashboard[] = [
  dashboard('d1', 'Base overview', 'Everything at a base.'),
  dashboard('d2', 'Fleet wall'),
];

function query(id: string, name: string, folder?: string, description?: string): SavedQuery {
  return {
    id,
    name,
    folder,
    description,
    sql: `select * from base where id = '${id}'`,
    createdBy: 'console',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    shared: false,
    cacheTtlSeconds: 0,
    visualization: { kind: 'table' },
  };
}

function dashboard(id: string, name: string, description?: string): Dashboard {
  return {
    id,
    name,
    description,
    createdBy: 'console',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    shared: false,
    cards: [{ id: 'c', savedQueryId: 'q1', width: 2, position: 0 }],
  };
}

function workspace(withSummaries: boolean) {
  const store = {
    listSavedQueries: vi.fn(async () => QUERIES),
    listDashboards: vi.fn(async () => DASHBOARDS),
    ...(withSummaries
      ? {
          listSavedQuerySummaries: vi.fn(
            async (): Promise<SavedQuerySummary[]> =>
              QUERIES.map(({ id, name, description, folder }) => ({
                id,
                name,
                description,
                folder,
              })),
          ),
          listDashboardSummaries: vi.fn(
            async (): Promise<DashboardSummary[]> =>
              DASHBOARDS.map(({ id, name, description }) => ({ id, name, description })),
          ),
        }
      : {}),
  };
  return store;
}

function service(store: ReturnType<typeof workspace>): CatalogService {
  const registry = { getSnapshot: () => ({ types: [] }) } as unknown as CatalogRegistry;
  return new CatalogService(
    registry,
    {} as CatalogReadStore,
    {} as CatalogModuleOptions,
    store as unknown as CatalogWorkspaceStore,
  );
}

describe('search over saved queries and dashboards', () => {
  for (const term of ['base', 'fleet', 'overdue', 'select', 'zzz']) {
    it(`answers "${term}" from the summaries exactly as from the full rows`, async () => {
      const summaries = workspace(true);
      const full = workspace(false);

      const fromSummaries = await service(summaries).search(term);
      const fromFull = await service(full).search(term);

      expect(fromSummaries).toEqual(fromFull);
      expect(summaries.listSavedQueries).not.toHaveBeenCalled();
      expect(summaries.listDashboards).not.toHaveBeenCalled();
      expect(summaries.listSavedQuerySummaries).toHaveBeenCalledTimes(1);
      expect(summaries.listDashboardSummaries).toHaveBeenCalledTimes(1);
      expect(full.listSavedQueries).toHaveBeenCalledTimes(1);
    });
  }

  it('finds something, so the comparison above is not between two empty answers', async () => {
    const result = await service(workspace(true)).search('base');
    expect(result.hits.map((hit) => hit.id)).toEqual(expect.arrayContaining(['q1', 'q3', 'd1']));
  });
});
