import type { StartedMySqlContainer } from '@testcontainers/mysql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CatalogDatabase, openCatalogDatabase, startMySql } from '../test/mysql-harness';
import { MySqlWorkspaceStore } from './workspace.store';

/**
 * What search reads of the workspace, against a real MySQL: the ranked fields
 * of each saved query and dashboard, and none of the SQL, visualization JSON or
 * cards the full rows carry.
 */
describe('workspace summaries', () => {
  let container: StartedMySqlContainer;
  let db: CatalogDatabase;
  let workspace: MySqlWorkspaceStore;
  const log: string[] = [];

  beforeAll(async () => {
    container = await startMySql();
    db = await openCatalogDatabase(container, 'summaries', (sql) => log.push(sql));
    workspace = new MySqlWorkspaceStore(db.em);

    await workspace.saveQuery(
      {
        name: 'Vehicles by base',
        folder: 'Fleet',
        description: 'Counts.',
        sql: 'select base, count(*) from obj_mvr group by base',
        visualization: { kind: 'bar', labelColumn: 'base' },
      },
      'console',
    );
    await workspace.saveQuery({ name: 'Overdue', sql: 'select 1' }, 'console');
    await workspace.saveQuery({ name: 'Age', folder: 'Fleet', sql: 'select 2' }, 'console');
    await workspace.saveDashboard(
      { name: 'Wall', description: 'On the wall.', cards: [] },
      'console',
    );
    await workspace.saveDashboard({ name: 'Board' }, 'console');
  }, 300_000);

  afterAll(async () => {
    await db?.close();
    await container?.stop();
  });

  it('lists saved queries without their SQL, in the same order and with the same fields', async () => {
    log.length = 0;
    const summaries = await workspace.listSavedQuerySummaries();
    const selects = log.filter((sql) => /select/i.test(sql) && /catalog_saved_query/i.test(sql));

    const full = await workspace.listSavedQueries();
    expect(summaries).toEqual(
      full.map(({ id, name, description, folder }) => ({ id, name, description, folder })),
    );
    expect(selects).toHaveLength(1);
    expect(selects[0]).not.toContain('.*');
    expect(selects[0]).not.toMatch(/`sql`|`visualization`/);
  });

  it('lists dashboards without their cards, in the same order and with the same fields', async () => {
    log.length = 0;
    const summaries = await workspace.listDashboardSummaries();
    const selects = log.filter((sql) => /select/i.test(sql) && /catalog_dashboard/i.test(sql));

    const full = await workspace.listDashboards();
    expect(summaries).toEqual(full.map(({ id, name, description }) => ({ id, name, description })));
    expect(selects).toHaveLength(1);
    expect(selects[0]).not.toContain('.*');
    expect(selects[0]).not.toMatch(/`cards`/);
  });
});
