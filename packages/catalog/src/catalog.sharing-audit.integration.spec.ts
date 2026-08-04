import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import type {
  CanActivate,
  DynamicModule,
  ExecutionContext,
  INestApplication,
} from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { CATALOG_EVENTS, channelNameFor } from './catalog.events';
import { CatalogModule } from './catalog.module';
import { InMemoryCatalogOverlayStore } from './catalog.overlay-store';
import type { CatalogPrincipal } from './catalog.principal';
import type { CatalogQueryRelation, CatalogQueryResult } from './catalog.query';
import { CatalogRegistry } from './catalog.registry.base';
import { CATALOG_STORE, type CatalogReadResult, type CatalogReadStore } from './catalog.store';
import type { CatalogGraph, CatalogObjectTypeDef, CatalogSnapshot } from './catalog.types';
import {
  type AuditQuery,
  CATALOG_WORKSPACE_STORE,
  type CatalogAuditEvent,
  type CatalogWorkspaceStore,
  type Dashboard,
  type DashboardCard,
  type SaveQueryInput,
  type SavedQuery,
} from './catalog.workspace';

/**
 * That sharing something leaves a trace, and that the trace names who.
 *
 * `shared` is the entire embed boundary: it is the field that hands another
 * company's frontend rows out of this catalog, and for several releases the
 * docblock on it claimed the decision "shows up in the audit trail as one" while
 * `CATALOG_EVENTS` contained no such event and nothing emitted one. So these
 * assert the whole path rather than the emit call — a spy on `emitCatalog` would
 * have passed on an event name no recorder subscribes to, which is precisely the
 * gap that shipped.
 *
 * The recorder below is deliberately a re-implementation of the shipped one in
 * `@dudousxd/nestjs-catalog-store-mikro-orm`: it subscribes to `CATALOG_EVENTS`,
 * pulls `principalId` out of the payload, and writes through `recordEvent`. That
 * makes membership in `CATALOG_EVENTS` and the *name* of the actor field part of
 * what is under test, because both are contracts with a recorder this package
 * cannot import.
 */

// ---------------------------------------------------------------------------
// The host's half: a guard that resolves a principal onto the request.
//
// The library ships no such guard — see the enforcement note in
// `catalog.principal.ts` — so the actor only reaches the trail if the host put
// one there. This is that host, written the shortest way that is still honest.
// ---------------------------------------------------------------------------

const ANA: CatalogPrincipal = {
  id: 'catalog-console#ana@example.com',
  applicationId: 'catalog-console',
  actor: { id: 'ana@example.com', displayName: 'Ana' },
  scopes: ['catalog:curate'],
};

@Injectable()
class SignedInGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    Reflect.set(context.switchToHttp().getRequest(), 'principal', ANA);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Stubs.
// ---------------------------------------------------------------------------

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
    return Promise.resolve({
      columns: [],
      rows: [],
      rowCount: 0,
      truncated: false,
      elapsedMs: 0,
    });
  }
  queryRelations(): Promise<CatalogQueryRelation[]> {
    return Promise.resolve([]);
  }
}

let nextId = 0;

/**
 * A workspace that actually stores, because a transition is a comparison and a
 * store that answers from a frozen fixture has no before to compare against.
 */
class MemoryWorkspace implements CatalogWorkspaceStore {
  readonly queries = new Map<string, SavedQuery>();
  readonly dashboards = new Map<string, Dashboard>();
  readonly events: CatalogAuditEvent[] = [];

  seedQuery(overrides: Partial<SavedQuery> & Pick<SavedQuery, 'id'>): SavedQuery {
    const seeded: SavedQuery = {
      name: overrides.id,
      sql: 'select 1',
      createdBy: 'console',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      cacheTtlSeconds: 0,
      visualization: { kind: 'table' },
      shared: false,
      ...overrides,
    };
    this.queries.set(seeded.id, seeded);
    return seeded;
  }

  seedDashboard(overrides: Partial<Dashboard> & Pick<Dashboard, 'id'>): Dashboard {
    const seeded: Dashboard = {
      name: overrides.id,
      createdBy: 'console',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      cards: [],
      shared: false,
      ...overrides,
    };
    this.dashboards.set(seeded.id, seeded);
    return seeded;
  }

  listSavedQueries(): Promise<SavedQuery[]> {
    return Promise.resolve([...this.queries.values()]);
  }
  getSavedQuery(id: string): Promise<SavedQuery | undefined> {
    return Promise.resolve(this.queries.get(id));
  }
  saveQuery(input: SaveQueryInput, createdBy: string): Promise<SavedQuery> {
    nextId += 1;
    return Promise.resolve(
      this.seedQuery({
        id: `q-${nextId}`,
        ...input,
        createdBy,
        visualization: input.visualization ?? { kind: 'table' },
        cacheTtlSeconds: input.cacheTtlSeconds ?? 0,
        // What the shipped store does with an absent flag.
        shared: input.shared === true,
      }),
    );
  }
  updateSavedQuery(id: string, input: Partial<SaveQueryInput>): Promise<SavedQuery | undefined> {
    const existing = this.queries.get(id);
    if (!existing) return Promise.resolve(undefined);
    const updated: SavedQuery = { ...existing, ...input };
    this.queries.set(id, updated);
    return Promise.resolve(updated);
  }
  /**
   * Set to make every delete a no-op that still answers.
   *
   * A store that keeps the row and reports `false` is what "against what the
   * store returned, never against what the caller asked for" is about, and it is
   * not reachable by asking this one nicely — a caller cannot tell a store to
   * refuse.
   */
  refuseDeletes = false;

  deleteSavedQuery(id: string): Promise<boolean> {
    if (this.refuseDeletes) return Promise.resolve(false);
    return Promise.resolve(this.queries.delete(id));
  }

  listDashboards(): Promise<Dashboard[]> {
    return Promise.resolve([...this.dashboards.values()]);
  }
  getDashboard(id: string): Promise<Dashboard | undefined> {
    return Promise.resolve(this.dashboards.get(id));
  }
  saveDashboard(
    input: { name: string; description?: string; cards?: DashboardCard[]; shared?: boolean },
    createdBy: string,
  ): Promise<Dashboard> {
    nextId += 1;
    return Promise.resolve(
      this.seedDashboard({
        id: `d-${nextId}`,
        ...input,
        createdBy,
        cards: input.cards ?? [],
        shared: input.shared === true,
      }),
    );
  }
  updateDashboard(
    id: string,
    input: Partial<{
      name: string;
      description: string;
      cards: DashboardCard[];
      shared: boolean;
    }>,
  ): Promise<Dashboard | undefined> {
    const existing = this.dashboards.get(id);
    if (!existing) return Promise.resolve(undefined);
    const updated: Dashboard = { ...existing, ...input };
    this.dashboards.set(id, updated);
    return Promise.resolve(updated);
  }
  deleteDashboard(id: string): Promise<boolean> {
    if (this.refuseDeletes) return Promise.resolve(false);
    return Promise.resolve(this.dashboards.delete(id));
  }

  recordEvent(event: Omit<CatalogAuditEvent, 'id'>): Promise<void> {
    this.events.push({ id: `e-${this.events.length + 1}`, ...event });
    return Promise.resolve();
  }
  listEvents(query: AuditQuery): Promise<CatalogAuditEvent[]> {
    return Promise.resolve(
      this.events.filter((event) => !query.event || event.event === query.event),
    );
  }
}

/**
 * The shipped recorder's contract, restated: subscribe to every name in
 * `CATALOG_EVENTS`, lift `principalId` out of the payload, write the row.
 *
 * An event this package emits under a name absent from `CATALOG_EVENTS` reaches
 * nothing here, exactly as it would reach nothing in production.
 */
class TestAuditRecorder {
  private readonly handlers = new Map<string, (message: unknown) => void>();

  constructor(private readonly workspace: MemoryWorkspace) {
    for (const event of CATALOG_EVENTS) {
      const channel = channelNameFor(event);
      const handler = (message: unknown): void => {
        const envelope = message && typeof message === 'object' ? message : {};
        const raw = Reflect.get(envelope, 'payload');
        const payload = raw && typeof raw === 'object' ? raw : {};
        const principalId = Reflect.get(payload, 'principalId');
        void this.workspace.recordEvent({
          event,
          principalId: typeof principalId === 'string' ? principalId : undefined,
          detail: { ...payload },
          occurredAt: new Date().toISOString(),
        });
      };
      subscribe(channel, handler);
      this.handlers.set(channel, handler);
    }
  }

  stop(): void {
    for (const [channel, handler] of this.handlers) unsubscribe(channel, handler);
    this.handlers.clear();
  }
}

// ---------------------------------------------------------------------------
// Booting.
// ---------------------------------------------------------------------------

function workspaceModule(workspace: CatalogWorkspaceStore): DynamicModule {
  return {
    module: class WorkspaceModule {},
    providers: [{ provide: CATALOG_WORKSPACE_STORE, useValue: workspace }],
    exports: [CATALOG_WORKSPACE_STORE],
  };
}

describe('Sharing leaves an audit trail (integration)', () => {
  let app: INestApplication | undefined;
  let recorder: TestAuditRecorder | undefined;

  afterEach(async () => {
    recorder?.stop();
    recorder = undefined;
    await app?.close();
    app = undefined;
  });

  async function boot(options: { guarded?: boolean } = {}) {
    const workspace = new MemoryWorkspace();
    recorder = new TestAuditRecorder(workspace);
    const moduleRef = await Test.createTestingModule({
      imports: [
        CatalogModule.forRoot({
          path: 'api/catalog',
          guards: options.guarded === false ? [] : [SignedInGuard],
          imports: [workspaceModule(workspace)],
          registry: { provide: CatalogRegistry, useClass: StubRegistry },
          store: { provide: CATALOG_STORE, useValue: new StubStore() },
          overlayStore: new InMemoryCatalogOverlayStore(),
        }),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    return { server: app.getHttpServer(), workspace };
  }

  /** Only the sharing decisions, so an unrelated event cannot pad a count. */
  function sharingEvents(workspace: MemoryWorkspace) {
    return workspace.events.filter(
      (event) => event.event === 'query.shared' || event.event === 'dashboard.shared',
    );
  }

  // -------------------------------------------------------------------------
  // 1. The trail records the act.
  // -------------------------------------------------------------------------

  it('records sharing a saved query, through the trail rather than the channel', async () => {
    const { server, workspace } = await boot();
    const created = await request(server)
      .post('/api/catalog/saved-queries')
      .send({ name: 'Sales', sql: 'select 1' })
      .expect(201);

    await request(server)
      .patch(`/api/catalog/saved-queries/${created.body.id}`)
      .send({ shared: true })
      .expect(200);

    // Read back through the endpoint a governance screen actually calls: the
    // claim is "it shows up in the audit trail", and the trail is what `/events`
    // answers with, not what a spy saw.
    const listed = await request(server).get('/api/catalog/events?event=query.shared').expect(200);

    expect(listed.body).toHaveLength(1);
    expect(listed.body[0].detail).toMatchObject({
      savedQueryId: created.body.id,
      name: 'Sales',
      shared: true,
    });
    expect(sharingEvents(workspace)).toHaveLength(1);
  });

  it('records sharing a dashboard', async () => {
    const { server, workspace } = await boot();
    const created = await request(server)
      .post('/api/catalog/dashboards')
      .send({ name: 'Operations' })
      .expect(201);

    await request(server)
      .patch(`/api/catalog/dashboards/${created.body.id}`)
      .send({ shared: true })
      .expect(200);

    expect(sharingEvents(workspace)).toHaveLength(1);
    expect(sharingEvents(workspace)[0]).toMatchObject({
      event: 'dashboard.shared',
      detail: { dashboardId: created.body.id, name: 'Operations', shared: true },
    });
  });

  it('records a board created already shared, which grants access just as much', async () => {
    const { server, workspace } = await boot();

    await request(server)
      .post('/api/catalog/dashboards')
      .send({ name: 'Born public', shared: true })
      .expect(201);

    expect(sharingEvents(workspace)).toHaveLength(1);
    expect(sharingEvents(workspace)[0].detail).toMatchObject({ shared: true });
  });

  // -------------------------------------------------------------------------
  // 2. The transition, not the write.
  // -------------------------------------------------------------------------

  it('says nothing when a save leaves `shared` untouched', async () => {
    // The rule that keeps the trail readable. A rename is not a sharing
    // decision, and a trail that logged one would teach people to skip the ones
    // that are.
    const { server, workspace } = await boot();
    const created = await request(server)
      .post('/api/catalog/saved-queries')
      .send({ name: 'Sales', sql: 'select 1' })
      .expect(201);

    await request(server)
      .patch(`/api/catalog/saved-queries/${created.body.id}`)
      .send({ name: 'Sales by region' })
      .expect(200);

    expect(sharingEvents(workspace)).toEqual([]);
  });

  it('says nothing when the toggle is set to the value it already had', async () => {
    // `shared` is present in the body here, so only a real before/after
    // comparison can tell this apart from the case above.
    const { server, workspace } = await boot();
    const created = await request(server)
      .post('/api/catalog/saved-queries')
      .send({ name: 'Sales', sql: 'select 1', shared: true })
      .expect(201);
    expect(sharingEvents(workspace)).toHaveLength(1);

    await request(server)
      .patch(`/api/catalog/saved-queries/${created.body.id}`)
      .send({ shared: true })
      .expect(200);

    expect(sharingEvents(workspace)).toHaveLength(1);
  });

  it('records un-sharing, distinguishably from sharing', async () => {
    // A trail that recorded only grants cannot answer "was this still shared
    // last Tuesday", which is the question an incident actually asks.
    const { server, workspace } = await boot();
    const created = await request(server)
      .post('/api/catalog/saved-queries')
      .send({ name: 'Sales', sql: 'select 1', shared: true })
      .expect(201);

    await request(server)
      .patch(`/api/catalog/saved-queries/${created.body.id}`)
      .send({ shared: false })
      .expect(200);

    expect(sharingEvents(workspace).map((event) => event.detail.shared)).toEqual([true, false]);
  });

  // -------------------------------------------------------------------------
  // 2b. Deleting is a transition too.
  //
  // Revoking access with the delete button is how it actually gets revoked, and
  // for a release it left nothing at all: the only way to date the revocation
  // was to notice a thing had stopped appearing, which is the absence this whole
  // event exists to remove.
  // -------------------------------------------------------------------------

  it('records deleting a shared saved query as a revocation, under the same event name', async () => {
    // The same name specifically. "When did this stop being reachable from
    // outside" is answered by filtering `query.shared` and reading the last
    // entry, so a deletion recorded under a name of its own would leave that
    // filter saying `shared: true` forever for something nobody can fetch.
    const { server, workspace } = await boot();
    const created = await request(server)
      .post('/api/catalog/saved-queries')
      .send({ name: 'Sales', sql: 'select 1', shared: true })
      .expect(201);

    await request(server).delete(`/api/catalog/saved-queries/${created.body.id}`).expect(200);

    const listed = await request(server).get('/api/catalog/events?event=query.shared').expect(200);
    expect(listed.body.map((event: CatalogAuditEvent) => event.detail.shared)).toEqual([
      true,
      false,
    ]);
    expect(sharingEvents(workspace).at(-1)?.detail).toMatchObject({
      savedQueryId: created.body.id,
      // The name as it last read: after this there is nothing left to look up.
      name: 'Sales',
      shared: false,
      deleted: true,
    });
  });

  it('records deleting a shared dashboard', async () => {
    const { server, workspace } = await boot();
    const created = await request(server)
      .post('/api/catalog/dashboards')
      .send({ name: 'Operations', shared: true })
      .expect(201);

    await request(server).delete(`/api/catalog/dashboards/${created.body.id}`).expect(200);

    expect(sharingEvents(workspace).at(-1)).toMatchObject({
      event: 'dashboard.shared',
      detail: { dashboardId: created.body.id, name: 'Operations', shared: false, deleted: true },
    });
  });

  it('marks the revocation as a deletion, distinguishably from un-sharing', async () => {
    // Both entries say `shared: false`. Without the flag a reader cannot tell
    // "revoked, still there" from "gone", and would go looking for a row that no
    // longer exists — an empty result that reads as a broken trail rather than
    // as the answer.
    const { server, workspace } = await boot();
    const kept = await request(server)
      .post('/api/catalog/saved-queries')
      .send({ name: 'Kept', sql: 'select 1', shared: true })
      .expect(201);
    const gone = await request(server)
      .post('/api/catalog/saved-queries')
      .send({ name: 'Gone', sql: 'select 1', shared: true })
      .expect(201);

    await request(server)
      .patch(`/api/catalog/saved-queries/${kept.body.id}`)
      .send({ shared: false })
      .expect(200);
    await request(server).delete(`/api/catalog/saved-queries/${gone.body.id}`).expect(200);

    const revocations = sharingEvents(workspace).filter((event) => event.detail.shared === false);
    expect(revocations.map((event) => event.detail.deleted)).toEqual([undefined, true]);
  });

  it('says nothing when an unshared query or dashboard is deleted', async () => {
    // The transition rule, not an exception to it: something that was not
    // reachable from outside before is not reachable after, so no access
    // changed. Recording it would put entries carrying neither a grant nor a
    // revocation on the one channel whose entries all carry one.
    const { server, workspace } = await boot();
    const query = await request(server)
      .post('/api/catalog/saved-queries')
      .send({ name: 'Private', sql: 'select 1' })
      .expect(201);
    const dashboard = await request(server)
      .post('/api/catalog/dashboards')
      .send({ name: 'Private board' })
      .expect(201);

    await request(server).delete(`/api/catalog/saved-queries/${query.body.id}`).expect(200);
    await request(server).delete(`/api/catalog/dashboards/${dashboard.body.id}`).expect(200);

    expect(sharingEvents(workspace)).toEqual([]);
  });

  it('says nothing when the delete removed nothing', async () => {
    // Against what the store returned, never against what the caller asked for
    // — the same rule the writes follow. A 200 saying `deleted: false` must not
    // produce an entry claiming access was taken back.
    const { server, workspace } = await boot();

    await request(server)
      .delete('/api/catalog/saved-queries/never-existed')
      .expect(200)
      .expect((response) => {
        expect(response.body.deleted).toBe(false);
      });

    expect(sharingEvents(workspace)).toEqual([]);
  });

  it('says nothing when the row was shared and the store refused to delete it', async () => {
    // The case the id above cannot reach, and the one the rule is actually
    // about: the row exists, it is shared, and the store declines. Deciding from
    // the row alone would file a revocation for something still fetchable
    // through the embed API.
    const { server, workspace } = await boot();
    const created = await request(server)
      .post('/api/catalog/saved-queries')
      .send({ name: 'Sales', sql: 'select 1', shared: true })
      .expect(201);
    const shares = sharingEvents(workspace).length;

    workspace.refuseDeletes = true;
    await request(server)
      .delete(`/api/catalog/saved-queries/${created.body.id}`)
      .expect(200)
      .expect((response) => {
        expect(response.body.deleted).toBe(false);
      });

    expect(sharingEvents(workspace)).toHaveLength(shares);
  });

  it('names the host-resolved principal on a deletion, as on every other entry', async () => {
    const { server, workspace } = await boot();
    const created = await request(server)
      .post('/api/catalog/dashboards')
      .send({ name: 'Born public', shared: true })
      .expect(201);

    await request(server).delete(`/api/catalog/dashboards/${created.body.id}`).expect(200);

    const revocation = sharingEvents(workspace).at(-1);
    expect(revocation?.principalId).toBe('catalog-console#ana@example.com');
    expect(revocation?.detail.principalId).toBe('catalog-console#ana@example.com');
  });

  it('says nothing when a query is created unshared', async () => {
    const { server, workspace } = await boot();

    await request(server)
      .post('/api/catalog/saved-queries')
      .send({ name: 'Private', sql: 'select 1' })
      .expect(201);

    expect(sharingEvents(workspace)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 3. Who.
  // -------------------------------------------------------------------------

  it('names the host-resolved principal, in the indexed column and not only the payload', async () => {
    // `principalId` is the column the Activity screen filters on. An entry that
    // carried the actor only inside `detail` would be invisible to every query
    // anybody actually runs against the trail.
    const { server, workspace } = await boot();

    await request(server)
      .post('/api/catalog/dashboards')
      .send({ name: 'Born public', shared: true })
      .expect(201);

    const [recorded] = sharingEvents(workspace);
    expect(recorded.principalId).toBe('catalog-console#ana@example.com');
    expect(recorded.detail.principalId).toBe('catalog-console#ana@example.com');
  });

  it('prefers the resolved principal over a `createdBy` the body claimed', async () => {
    // Otherwise the actor column is a free-text field: any caller could file its
    // sharing decisions under somebody else's name.
    const { server, workspace } = await boot();

    await request(server)
      .post('/api/catalog/dashboards')
      .send({ name: 'Born public', shared: true, createdBy: 'somebody-else' })
      .expect(201);

    expect(sharingEvents(workspace)[0].principalId).toBe('catalog-console#ana@example.com');
  });

  it('falls back to the console when no guard resolved anybody', async () => {
    // The honest answer for a host that has not wired a guard yet — this library
    // resolves no principal of its own. "console" is not a person, and it is
    // still better than an entry attributed to nobody.
    const { server, workspace } = await boot({ guarded: false });

    await request(server)
      .post('/api/catalog/dashboards')
      .send({ name: 'Born public', shared: true })
      .expect(201);

    expect(sharingEvents(workspace)[0].principalId).toBe('console');
  });
});
