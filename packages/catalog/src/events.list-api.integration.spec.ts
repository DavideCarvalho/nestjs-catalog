import type { DynamicModule, INestApplication } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CatalogModule } from './catalog.module';
import { InMemoryCatalogOverlayStore } from './catalog.overlay-store';
import { CatalogRegistry } from './catalog.registry.base';
import { CATALOG_STORE, type CatalogReadStore } from './catalog.store';
import type { CatalogGraph, CatalogObjectTypeDef, CatalogSnapshot } from './catalog.types';
import {
  type AuditQuery,
  CATALOG_TRACE_STORE,
  CATALOG_WORKSPACE_STORE,
  type CatalogAuditEvent,
  type CatalogTraceList,
  type CatalogTraceStore,
  type TraceQuery,
} from './catalog.workspace';

/**
 * `GET events` and `GET events/traces` on the Aviary list wire, over real HTTP.
 *
 * The stores record what they were asked for: the assertion that matters is that
 * `filter[...]`, `page` and `size` reach the store as the SPI's own fields
 * (`since`, `limit`, `offset`), and that the answer is the list envelope.
 */

@Injectable()
class EmptyRegistry extends CatalogRegistry {
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

const EVENT: CatalogAuditEvent = {
  id: 'e-1',
  event: 'snapshot.committed',
  typeName: 'Mvr',
  principalId: 'ana',
  detail: {},
  occurredAt: '2026-03-04T00:00:00.000Z',
};

const listEvents = vi.fn((_query: AuditQuery) => Promise.resolve([EVENT]));
const listTraces = vi.fn(
  (query: TraceQuery): Promise<CatalogTraceList> =>
    Promise.resolve({
      traces: [],
      total: 60,
      limit: query.limit ?? 25,
      offset: query.offset ?? 0,
      unlinked: [EVENT],
      unlinkedTotal: 1,
      clockResolutionMs: 1,
    }),
);

function storesModule(): DynamicModule {
  const traces: Pick<CatalogTraceStore, 'listTraces' | 'getTrace'> = {
    listTraces,
    getTrace: () => Promise.resolve(undefined),
  };
  return {
    module: class StoresModule {},
    providers: [
      { provide: CATALOG_WORKSPACE_STORE, useValue: { listEvents } },
      { provide: CATALOG_TRACE_STORE, useValue: traces },
    ],
    exports: [CATALOG_WORKSPACE_STORE, CATALOG_TRACE_STORE],
  };
}

const READ_STORE: CatalogReadStore = {
  capabilities: { snapshots: 'none', writable: false, timeTravel: false },
  read: () => Promise.resolve({ rows: [], total: 0 }),
};

describe('the audit trail on the list API wire', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    listEvents.mockClear();
    listTraces.mockClear();
  });

  async function boot() {
    const moduleRef = await Test.createTestingModule({
      imports: [
        CatalogModule.forRoot({
          path: 'api/catalog',
          imports: [storesModule()],
          registry: { provide: CatalogRegistry, useClass: EmptyRegistry },
          store: { provide: CATALOG_STORE, useValue: READ_STORE },
          overlayStore: new InMemoryCatalogOverlayStore(),
        }),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    return app.getHttpServer();
  }

  it('answers events as { data }, filtered and sized through the list params', async () => {
    const server = await boot();

    const response = await request(server)
      .get(
        '/api/catalog/events?filter[event]=snapshot.committed&filter[type]=Mvr&filter[principal]=ana&filter[occurredAt][gte]=2026-03-01&size=10',
      )
      .expect(200);

    expect(response.body).toEqual({ data: [EVENT] });
    expect(listEvents).toHaveBeenLastCalledWith({
      event: 'snapshot.committed',
      typeName: 'Mvr',
      principalId: 'ana',
      since: '2026-03-01',
      limit: 10,
    });
  });

  it('refuses the removed params and filters it does not know', async () => {
    const server = await boot();

    await request(server).get('/api/catalog/events?filter[nope]=1').expect(400);
    await request(server).get('/api/catalog/events?filter[occurredAt][gte]=junk').expect(400);
    await request(server).get('/api/catalog/events?sort=occurredAt').expect(400);
    await request(server).get('/api/catalog/events?size=all').expect(400);
    expect(listEvents).not.toHaveBeenCalled();
  });

  it('pages traces with page/size and answers the offset envelope plus side data', async () => {
    const server = await boot();

    const response = await request(server)
      .get('/api/catalog/events/traces?filter[outcome]=failed,incomplete&page=2&size=20')
      .expect(200);

    expect(listTraces).toHaveBeenLastCalledWith({
      outcome: ['failed', 'incomplete'],
      limit: 20,
      offset: 20,
    });
    expect(response.body).toEqual({
      data: [],
      meta: { total: 60, perPage: 20, currentPage: 2, lastPage: 3, firstPage: 1 },
      unlinked: [EVENT],
      unlinkedTotal: 1,
      clockResolutionMs: 1,
    });
  });

  it('refuses an unknown trace filter rather than answering unfiltered', async () => {
    const server = await boot();

    await request(server).get('/api/catalog/events/traces?filter[status]=failed').expect(400);
    expect(listTraces).not.toHaveBeenCalled();
  });

  it.each([
    ['/api/catalog/events/traces?limit=5&offset=10', '"size"'],
    ['/api/catalog/events/traces?outcome=failed', 'filter[outcome]'],
    ['/api/catalog/events?event=type.curated', 'filter[event]'],
    ['/api/catalog/events?page=2', '"page"'],
  ])('refuses the removed or unknown param in %s, naming the replacement', async (path, hint) => {
    const server = await boot();

    const res = await request(server).get(path).expect(400);
    expect(res.body.message).toContain(hint);
    expect(listTraces).not.toHaveBeenCalled();
  });
});
