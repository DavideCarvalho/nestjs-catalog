import type { DynamicModule, INestApplication } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { CatalogModule } from './catalog.module';
import { InMemoryCatalogOverlayStore } from './catalog.overlay-store';
import type { CatalogQueryRelation, CatalogQueryResult } from './catalog.query';
import { CatalogRegistry } from './catalog.registry.base';
import { CATALOG_STORE, type CatalogReadResult, type CatalogReadStore } from './catalog.store';
import type { CatalogGraph, CatalogObjectTypeDef, CatalogSnapshot } from './catalog.types';
import {
  type AuditQuery,
  CATALOG_WORKSPACE_STORE,
  type CatalogAuditEvent,
  type CatalogRevision,
  type CatalogWorkspaceStore,
  type Dashboard,
  type SaveQueryInput,
  type SavedQuery,
} from './catalog.workspace';

/**
 * That `GET saved-queries/:id/revisions` is served, and that a workspace store
 * which keeps no history says so rather than answering `[]`.
 *
 * A saved query's `sql` was overwritten in place with nothing recorded anywhere
 * — not even the version counter a transform had — so a report that started
 * answering differently left no way to ask what it used to say. This is the read
 * side of the fix.
 *
 * The refusal is the half worth booting an application for. An empty list and an
 * absent feature draw identically, and they mean opposite things: one says this
 * statement has never changed, the other says this deployment cannot tell you
 * whether it has.
 */

@Injectable()
class StubRegistry extends CatalogRegistry {
  getSnapshot(): CatalogSnapshot {
    return {
      version: 1,
      generatedAt: new Date(0).toISOString(),
      stats: { types: 0, properties: 0, relations: 0, enrichedTypes: 0 },
      types: [],
    };
  }
  getType(): CatalogObjectTypeDef | undefined {
    return undefined;
  }
  getGraph(): CatalogGraph {
    return { nodes: [], edges: [] };
  }
  patchType(): Promise<CatalogObjectTypeDef | undefined> {
    return Promise.resolve(undefined);
  }
  patchProperty(): Promise<CatalogObjectTypeDef | undefined> {
    return Promise.resolve(undefined);
  }
  resetOverlay(): Promise<void> {
    return Promise.resolve();
  }
}

class StubStore implements CatalogReadStore {
  readonly capabilities = { snapshots: 'none', writable: false, timeTravel: false } as const;

  read(): Promise<CatalogReadResult> {
    return Promise.resolve({ rows: [], total: 0 });
  }
  runQuery(): Promise<CatalogQueryResult> {
    return Promise.resolve({ columns: [], rows: [], rowCount: 0, truncated: false, elapsedMs: 0 });
  }
  queryRelations(): Promise<CatalogQueryRelation[]> {
    return Promise.resolve([]);
  }
}

const SAVED_QUERY: SavedQuery = {
  id: 'q-1',
  name: 'Sales',
  sql: 'select region, sum(total) from sales group by region',
  createdBy: 'ana',
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  cacheTtlSeconds: 0,
  visualization: { kind: 'table' },
  shared: false,
};

const REVISIONS: CatalogRevision[] = [
  {
    id: 'saved-query:q-1:2',
    subjectId: 'q-1',
    version: 2,
    body: 'select region, sum(total) from sales group by region',
    authoredBy: 'ana',
    authoredAt: new Date('2021-06-01T09:30:00.000Z').toISOString(),
  },
  {
    id: 'saved-query:q-1:1',
    subjectId: 'q-1',
    version: 1,
    body: 'select sum(total) from sales',
    authoredBy: 'ana',
    authoredAt: new Date('2021-01-01T09:30:00.000Z').toISOString(),
  },
];

/** Everything the interface requires, and nothing this file does not exercise. */
class StubWorkspace implements CatalogWorkspaceStore {
  listSavedQueries(): Promise<SavedQuery[]> {
    return Promise.resolve([]);
  }
  getSavedQuery(): Promise<SavedQuery | undefined> {
    return Promise.resolve(SAVED_QUERY);
  }
  saveQuery(input: SaveQueryInput, createdBy: string): Promise<SavedQuery> {
    return Promise.resolve({
      id: 'q-1',
      name: input.name,
      sql: input.sql,
      createdBy,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      cacheTtlSeconds: 0,
      visualization: { kind: 'table' },
      shared: false,
    });
  }
  updateSavedQuery(): Promise<SavedQuery | undefined> {
    return Promise.resolve(undefined);
  }
  deleteSavedQuery(): Promise<boolean> {
    return Promise.resolve(true);
  }
  listDashboards(): Promise<Dashboard[]> {
    return Promise.resolve([]);
  }
  getDashboard(): Promise<Dashboard | undefined> {
    return Promise.resolve(undefined);
  }
  saveDashboard(): Promise<Dashboard> {
    return Promise.reject(new Error('Nothing here saves a dashboard.'));
  }
  updateDashboard(): Promise<Dashboard | undefined> {
    return Promise.resolve(undefined);
  }
  deleteDashboard(): Promise<boolean> {
    return Promise.resolve(true);
  }
  recordEvent(): Promise<void> {
    return Promise.resolve();
  }
  listEvents(_query: AuditQuery): Promise<CatalogAuditEvent[]> {
    return Promise.resolve([]);
  }
}

/**
 * The store that keeps history. One method's difference from the one above, and
 * that difference is the whole of what `supportsSavedQueryRevisions` asks.
 */
class RevisioningWorkspace extends StubWorkspace {
  listSavedQueryRevisions(id: string): Promise<CatalogRevision[]> {
    return Promise.resolve(REVISIONS.map((revision) => ({ ...revision, subjectId: id })));
  }
}

describe('GET catalog/saved-queries/:id/revisions', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  function workspaceModule(workspace: CatalogWorkspaceStore): DynamicModule {
    return {
      module: class WorkspaceModule {},
      providers: [{ provide: CATALOG_WORKSPACE_STORE, useValue: workspace }],
      exports: [CATALOG_WORKSPACE_STORE],
    };
  }

  async function boot(workspace: CatalogWorkspaceStore) {
    const moduleRef = await Test.createTestingModule({
      imports: [
        CatalogModule.forRoot({
          path: 'api/catalog',
          imports: [workspaceModule(workspace)],
          registry: { provide: CatalogRegistry, useClass: StubRegistry },
          store: { provide: CATALOG_STORE, useValue: new StubStore() },
          overlayStore: new InMemoryCatalogOverlayStore(),
        }),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    return app.getHttpServer();
  }

  it('serves every statement the query has been, newest first', async () => {
    const server = await boot(new RevisioningWorkspace());

    const response = await request(server).get('/api/catalog/saved-queries/q-1/revisions');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(REVISIONS);
  });

  it('refuses, with a reason, on a workspace store that keeps none', async () => {
    const server = await boot(new StubWorkspace());

    const response = await request(server).get('/api/catalog/saved-queries/q-1/revisions');

    expect(response.status).toBe(400);
    expect(response.body.message).toContain('keeps no revisions');
  });

  it('does not shadow the route that reads the query itself', async () => {
    // `saved-queries/:id` is declared above this one and both are GETs. Nest
    // resolves in declaration order, so a revisions route that had been written
    // with one segment fewer would have swallowed every read of a saved query
    // and answered it with a history.
    const server = await boot(new RevisioningWorkspace());

    const response = await request(server).get('/api/catalog/saved-queries/q-1');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(SAVED_QUERY);
  });
});
