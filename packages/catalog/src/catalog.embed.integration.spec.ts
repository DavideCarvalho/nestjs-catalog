import type {
  CanActivate,
  DynamicModule,
  ExecutionContext,
  INestApplication,
} from '@nestjs/common';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CatalogModule } from './catalog.module';
import { InMemoryCatalogOverlayStore } from './catalog.overlay-store';
import {
  type CatalogPrincipal,
  type CatalogScope,
  StaticKeyPrincipalResolver,
  hasScope,
} from './catalog.principal';
import type {
  CatalogQueryRelation,
  CatalogQueryRequest,
  CatalogQueryResult,
} from './catalog.query';
import { CatalogRegistry } from './catalog.registry.base';
import { REQUIRED_SCOPES } from './catalog.route-auth';
import { CATALOG_STORE, type CatalogReadResult, type CatalogReadStore } from './catalog.store';
import type { CatalogGraph, CatalogObjectTypeDef, CatalogSnapshot } from './catalog.types';
import {
  CATALOG_WORKSPACE_STORE,
  type CatalogAuditEvent,
  type CatalogWorkspaceStore,
  type Dashboard,
  type DashboardCard,
  type SavedQuery,
} from './catalog.workspace';

/**
 * The embed surface, from the outside.
 *
 * This is the one part of the catalog another company's frontend talks to, so
 * every claim worth making about it is a claim about an HTTP response: which
 * scope is refused, what a discovery listing promises, what comes back when a
 * card points at a query that no longer exists. All of those compile perfectly
 * while being wrong, which is why these boot a real application and ask it
 * rather than calling `CatalogService` directly.
 *
 * The guard below is the host's half of the contract, written the way a host
 * would write it: read `REQUIRED_SCOPES` off the route, resolve the caller,
 * compare. The library declares and the host enforces — see the docblock on
 * `catalog.route-auth.ts`. Testing the declaration through a real guard rather
 * than by reading metadata back is deliberate: a `Reflect.getMetadata`
 * assertion passes on a decorator applied to a method nobody routes to.
 */

// ---------------------------------------------------------------------------
// The host's guard.
// ---------------------------------------------------------------------------

/**
 * Written as a total record rather than a list of strings so that a scope added
 * to `CatalogScope` stops this file compiling instead of silently becoming a
 * value the guard drops on the floor.
 */
const KNOWN_SCOPES: Record<CatalogScope, true> = {
  'catalog:read': true,
  'catalog:write': true,
  'catalog:curate': true,
  'catalog:embed': true,
  'catalog:admin': true,
};

function isScopeList(value: unknown): value is CatalogScope[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === 'string' && Object.hasOwn(KNOWN_SCOPES, entry))
  );
}

/**
 * Keys, not tokens, because this is a test — but the resolver is the library's
 * own `StaticKeyPrincipalResolver`, so the wiring under test is the wiring a
 * host would have rather than a lookalike written for the occasion.
 */
const RESOLVER = new StaticKeyPrincipalResolver([
  { key: 'reader', id: 'reader-app', scopes: ['catalog:read'] },
  { key: 'embedder', id: 'embed-app', scopes: ['catalog:embed'] },
  { key: 'both', id: 'both-app', scopes: ['catalog:read', 'catalog:embed'] },
  { key: 'admin', id: 'admin-app', scopes: ['catalog:admin'] },
  { key: 'curator', id: 'curator-app', scopes: ['catalog:curate'] },
]);

@Injectable()
class ScopeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const declared = this.reflector.getAllAndOverride<unknown>(REQUIRED_SCOPES, [
      context.getHandler(),
      context.getClass(),
    ]);
    // Absence means "authenticated is enough", which for this guard means
    // "let it through" — the same reading the library documents.
    const required = isScopeList(declared) ? declared : [];
    if (required.length === 0) return true;

    const principal: CatalogPrincipal | null = await RESOLVER.resolve(
      context.switchToHttp().getRequest(),
    );
    if (!principal) throw new UnauthorizedException('No principal presented.');
    return required.every((scope) => hasScope(principal, scope));
  }
}

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

function savedQuery(overrides: Partial<SavedQuery> & Pick<SavedQuery, 'id'>): SavedQuery {
  return {
    name: overrides.id,
    sql: `select * from ${overrides.id}`,
    createdBy: 'console',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    cacheTtlSeconds: 0,
    visualization: { kind: 'bar' },
    shared: true,
    ...overrides,
  };
}

function card(
  savedQueryId: string,
  position: number,
  width: DashboardCard['width'],
  overrides: Pick<Partial<DashboardCard>, 'id' | 'title' | 'library'> = {},
): DashboardCard {
  return { id: `card-${savedQueryId}`, savedQueryId, position, width, ...overrides };
}

const SHARED_CHART = savedQuery({
  id: 'q-sales',
  name: 'Sales by region',
  description: 'What sold where.',
  visualization: { kind: 'bar', labelColumn: 'label', valueColumns: ['value'] },
});
const CACHED_CHART = savedQuery({ id: 'q-cached', name: 'Cached', cacheTtlSeconds: 60 });
const PRIVATE_CHART = savedQuery({ id: 'q-private', name: 'Not shared', shared: false });
const CLASSIFIED_CHART = savedQuery({
  id: 'q-classified',
  name: 'Selects a classified column',
  sql: 'select ssn from person',
});
/** Has a name and a library of its own, so a card override has something to beat. */
const BRANDED_CHART = savedQuery({
  id: 'q-branded',
  name: 'Revenue',
  visualization: { kind: 'line', library: 'recharts', labelColumn: 'label' },
});

const SHARED_DASHBOARD: Dashboard = {
  id: 'd-ops',
  name: 'Operations',
  description: 'The wall display.',
  createdBy: 'console',
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  // Stored deliberately out of order: a payload that came back in this order
  // would be a dashboard drawn wrong, and storage order is not layout order.
  cards: [card('q-cached', 3, 1), card('q-sales', 1, 4), card('q-classified', 2, 2)],
  shared: true,
};

const PRIVATE_DASHBOARD: Dashboard = {
  ...SHARED_DASHBOARD,
  id: 'd-private',
  name: 'Draft',
  cards: [card('q-sales', 1, 4)],
  shared: false,
};

/** One good card, one pointing at a deleted query, one pointing at a private one. */
const HOLED_DASHBOARD: Dashboard = {
  ...SHARED_DASHBOARD,
  id: 'd-holes',
  name: 'Half gone',
  cards: [card('q-sales', 1, 4), card('q-was-deleted', 2, 2), card('q-private', 3, 1)],
  shared: true,
};

/** Cards that rename and re-skin their charts — the whole point of the two fields. */
const BRANDED_DASHBOARD: Dashboard = {
  ...SHARED_DASHBOARD,
  id: 'd-branded',
  name: 'Board with opinions',
  cards: [
    card('q-branded', 1, 4, { id: 'card-renamed', title: 'Q4 revenue', library: 'bklit' }),
    // A title cleared in the console: whitespace, not absence.
    card('q-sales', 2, 2, { id: 'card-blank-title', title: '   ' }),
    card('q-branded', 3, 1, { id: 'card-plain' }),
  ],
  shared: true,
};

const QUERIES = [SHARED_CHART, CACHED_CHART, PRIVATE_CHART, CLASSIFIED_CHART, BRANDED_CHART];
const DASHBOARDS = [SHARED_DASHBOARD, PRIVATE_DASHBOARD, HOLED_DASHBOARD, BRANDED_DASHBOARD];

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

/**
 * A store that can run SQL, and remembers every statement it was handed.
 *
 * `serial` climbs with each real execution and rides back inside the rows, so a
 * cached answer is distinguishable from a fresh one WITHOUT trusting the
 * `cached` flag the tests are here to check.
 */
class StubStore implements CatalogReadStore {
  readonly capabilities = { snapshots: 'none', writable: false, timeTravel: false } as const;
  readonly ran: string[] = [];

  read(): Promise<CatalogReadResult> {
    return Promise.resolve({ rows: [], total: 0 });
  }

  runQuery(request: CatalogQueryRequest): Promise<CatalogQueryResult> {
    this.ran.push(request.sql);
    return Promise.resolve({
      columns: ['label', 'value'],
      rows: [{ label: request.sql, value: this.ran.length }],
      rowCount: 1,
      truncated: false,
      elapsedMs: 1,
    });
  }

  queryRelations(): Promise<CatalogQueryRelation[]> {
    return Promise.resolve([]);
  }
}

class StubWorkspace implements CatalogWorkspaceStore {
  constructor(
    private readonly queries: SavedQuery[],
    private readonly dashboards: Dashboard[],
  ) {}

  listSavedQueries(): Promise<SavedQuery[]> {
    return Promise.resolve(this.queries);
  }
  getSavedQuery(id: string): Promise<SavedQuery | undefined> {
    return Promise.resolve(this.queries.find((query) => query.id === id));
  }
  listDashboards(): Promise<Dashboard[]> {
    return Promise.resolve(this.dashboards);
  }
  getDashboard(id: string): Promise<Dashboard | undefined> {
    return Promise.resolve(this.dashboards.find((dashboard) => dashboard.id === id));
  }
  listEvents(): Promise<CatalogAuditEvent[]> {
    return Promise.resolve([]);
  }

  /**
   * Every write that reached the store, as the store saw it.
   *
   * Recorded rather than asserted on a mock's arguments because the claim under
   * test is about a field SURVIVING the controller's body type, and "what the
   * store was handed" is the only place that is observable.
   */
  readonly writes: Array<{ method: string; input: Record<string, unknown> }> = [];

  saveDashboard(input: Record<string, unknown>): Promise<Dashboard> {
    this.writes.push({ method: 'saveDashboard', input });
    return Promise.resolve({
      ...SHARED_DASHBOARD,
      id: 'd-new',
      ...input,
      shared: hasShared(input),
    });
  }
  updateDashboard(id: string, input: Record<string, unknown>): Promise<Dashboard | undefined> {
    this.writes.push({ method: 'updateDashboard', input });
    return Promise.resolve({ ...SHARED_DASHBOARD, id, ...input, shared: hasShared(input) });
  }

  // Nothing the embed surface does may write. These exist to satisfy the
  // interface and to fail loudly rather than quietly if one is ever reached.
  saveQuery(): Promise<SavedQuery> {
    return this.forbidden('saveQuery');
  }
  updateSavedQuery(): Promise<SavedQuery | undefined> {
    return this.forbidden('updateSavedQuery');
  }
  deleteSavedQuery(): Promise<boolean> {
    return this.forbidden('deleteSavedQuery');
  }
  deleteDashboard(): Promise<boolean> {
    return this.forbidden('deleteDashboard');
  }
  recordEvent(): Promise<void> {
    return this.forbidden('recordEvent');
  }

  private forbidden(method: string): never {
    throw new Error(`The embed surface reached ${method}, which it must never do.`);
  }
}

/** What the shipped store does with an absent flag: `input.shared ?? false`. */
function hasShared(input: Record<string, unknown>): boolean {
  return input.shared === true;
}

// ---------------------------------------------------------------------------
// Booting.
// ---------------------------------------------------------------------------

function workspaceModule(workspace: CatalogWorkspaceStore): DynamicModule {
  // Through `imports`, not as a provider on the test's root module: Nest
  // resolves the generated controller's dependencies from the injector of the
  // module that DECLARES it, which is the library's.
  return {
    module: class WorkspaceModule {},
    providers: [{ provide: CATALOG_WORKSPACE_STORE, useValue: workspace }],
    exports: [CATALOG_WORKSPACE_STORE],
  };
}

async function boot(options: { store: StubStore; workspace?: CatalogWorkspaceStore }) {
  const moduleRef = await Test.createTestingModule({
    imports: [
      CatalogModule.forRoot({
        path: 'api/catalog',
        guards: [ScopeGuard],
        ...(options.workspace ? { imports: [workspaceModule(options.workspace)] } : {}),
        registry: { provide: CatalogRegistry, useClass: StubRegistry },
        store: { provide: CATALOG_STORE, useValue: options.store },
        overlayStore: new InMemoryCatalogOverlayStore(),
      }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

const EMBED_ROUTES = [
  '/api/catalog/embed',
  '/api/catalog/embed/dashboards/d-ops',
  '/api/catalog/embed/charts/q-sales',
];

describe('Embed endpoints (integration)', () => {
  let app: INestApplication | undefined;
  let store: StubStore;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function embedApp(
    workspace: CatalogWorkspaceStore = new StubWorkspace(QUERIES, DASHBOARDS),
  ) {
    store = new StubStore();
    app = await boot({ store, workspace });
    return app;
  }

  // -------------------------------------------------------------------------
  // 1. The scope.
  // -------------------------------------------------------------------------

  describe('catalog:embed', () => {
    it('refuses a principal that holds catalog:read but not catalog:embed', async () => {
      // The reason the scope exists at all. `catalog:read` is the whole
      // catalog; an application that renders one chart should not need it, and
      // holding it must not be a way to reach the embed API either — otherwise
      // "separate scope" is a comment rather than a boundary.
      const server = (await embedApp()).getHttpServer();

      for (const route of EMBED_ROUTES) {
        await request(server).get(route).set('x-catalog-key', 'reader').expect(403);
      }
    });

    it('lets a principal that holds only catalog:embed through', async () => {
      // The other half, and the half that makes the refusal above meaningful:
      // a guard that denied everything would satisfy the first test alone.
      const server = (await embedApp()).getHttpServer();

      for (const route of EMBED_ROUTES) {
        await request(server).get(route).set('x-catalog-key', 'embedder').expect(200);
      }
    });

    it('does not additionally require catalog:read, so the narrow grant is usable', async () => {
      // `embedChart` runs a query and `listEmbeddable` reads saved queries —
      // either could plausibly have been gated on read as well, which would
      // quietly make `catalog:embed` alone useless and every embed consumer a
      // full-catalog reader.
      const server = (await embedApp()).getHttpServer();

      const listed = await request(server)
        .get('/api/catalog/embed')
        .set('x-catalog-key', 'embedder')
        .expect(200);
      expect(listed.body.charts.length).toBeGreaterThan(0);
    });

    it('admits catalog:admin, which expands to every scope', async () => {
      const server = (await embedApp()).getHttpServer();

      for (const route of EMBED_ROUTES) {
        await request(server).get(route).set('x-catalog-key', 'admin').expect(200);
      }
    });

    it('refuses an unrelated scope and an unrecognised caller alike', async () => {
      const server = (await embedApp()).getHttpServer();

      await request(server).get('/api/catalog/embed').set('x-catalog-key', 'curator').expect(403);
      // No key at all: the guard has nobody to check, which is a 401 and not a
      // 200. Worth pinning because "resolver returned null" is exactly the path
      // a permissive guard falls through.
      await request(server).get('/api/catalog/embed').expect(401);
    });

    it('leaves the routes that declare no scope alone', async () => {
      // The control. The guard is metadata-driven, so a test suite where
      // everything 403s for a `catalog:read` principal would prove nothing
      // about the embed routes in particular — this shows the same principal
      // sailing through a route that declares nothing.
      const server = (await embedApp()).getHttpServer();

      await request(server).get('/api/catalog').set('x-catalog-key', 'reader').expect(200);
      await request(server).get('/api/catalog/graph').set('x-catalog-key', 'reader').expect(200);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Discovery.
  // -------------------------------------------------------------------------

  describe('GET embed', () => {
    it('lists exactly the shared things, and every id it lists then fetches', async () => {
      // A discovery endpoint that advertises a 403 is worse than one that lists
      // nothing: the consumer builds a tile for it, ships, and finds out in
      // production. So both directions are asserted — what is listed is
      // fetchable, and what is withheld is genuinely refused.
      const server = (await embedApp()).getHttpServer();

      const response = await request(server)
        .get('/api/catalog/embed')
        .set('x-catalog-key', 'embedder')
        .expect(200);

      expect(response.body.dashboards.map((entry: { id: string }) => entry.id)).toEqual([
        'd-ops',
        'd-holes',
        'd-branded',
      ]);
      expect(response.body.charts.map((entry: { id: string }) => entry.id)).toEqual([
        'q-sales',
        'q-cached',
        'q-classified',
        'q-branded',
      ]);

      for (const entry of response.body.dashboards) {
        await request(server)
          .get(`/api/catalog/embed/dashboards/${entry.id}`)
          .set('x-catalog-key', 'embedder')
          .expect(200);
      }
      for (const entry of response.body.charts) {
        await request(server)
          .get(`/api/catalog/embed/charts/${entry.id}`)
          .set('x-catalog-key', 'embedder')
          .expect(200);
      }

      // And the withheld ones really are withheld, so the listing above is a
      // filter rather than a coincidence of ordering.
      await request(server)
        .get('/api/catalog/embed/charts/q-private')
        .set('x-catalog-key', 'embedder')
        .expect(403);
      await request(server)
        .get('/api/catalog/embed/dashboards/d-private')
        .set('x-catalog-key', 'embedder')
        .expect(403);
    });

    it('carries the name, description and chart kind a consumer builds its menu from', async () => {
      const server = (await embedApp()).getHttpServer();

      const response = await request(server)
        .get('/api/catalog/embed')
        .set('x-catalog-key', 'embedder')
        .expect(200);

      expect(response.body.charts[0]).toEqual({
        id: 'q-sales',
        name: 'Sales by region',
        description: 'What sold where.',
        kind: 'bar',
      });
      // No `sql` anywhere in the listing. The point of the embed API is that a
      // consumer never sees this catalog's query language, and a discovery
      // payload leaking it would hand out the schema for free.
      expect(JSON.stringify(response.body)).not.toContain('select');
    });

    it("reports a dashboard's card count, which is NOT how many charts will embed", async () => {
      // A known divergence, pinned rather than endorsed. `charts` here is
      // `cards.length`; `embedDashboard` skips cards whose query is deleted or
      // unshared. So a consumer sizing a grid from this number reserves space
      // for tiles that never arrive.
      const server = (await embedApp()).getHttpServer();

      const listed = await request(server)
        .get('/api/catalog/embed')
        .set('x-catalog-key', 'embedder')
        .expect(200);
      const advertised = listed.body.dashboards.find(
        (entry: { id: string }) => entry.id === 'd-holes',
      );
      expect(advertised.charts).toBe(3);

      const embedded = await request(server)
        .get('/api/catalog/embed/dashboards/d-holes')
        .set('x-catalog-key', 'embedder')
        .expect(200);
      expect(embedded.body.charts).toHaveLength(1);
    });

    it('lists nothing rather than failing when no workspace store is mounted', async () => {
      // A catalog without a workspace is a legitimate configuration. Discovery
      // degrades to empty; a fetch is a 400 that names what is unwired, which
      // is the honest answer to "embed this" from a catalog that keeps no
      // dashboards.
      store = new StubStore();
      app = await boot({ store });
      const server = app.getHttpServer();

      await request(server)
        .get('/api/catalog/embed')
        .set('x-catalog-key', 'embedder')
        .expect(200)
        .expect((response) => {
          expect(response.body).toEqual({ dashboards: [], charts: [] });
        });

      const refused = await request(server)
        .get('/api/catalog/embed/charts/q-sales')
        .set('x-catalog-key', 'embedder')
        .expect(400);
      expect(refused.body.message).toContain('workspace store');
    });
  });

  // -------------------------------------------------------------------------
  // 3. What the `shared` flag does and does not gate.
  // -------------------------------------------------------------------------

  describe('the sharing gate', () => {
    it('is the whole data-level gate: no type or classification filtering happens here', async () => {
      // Stated as it IS, not as one might hope. The embed payload comes from
      // ad-hoc SQL, so there is no property definition to consult and neither
      // `mayRead` nor `maySeeClassification` is invoked anywhere on this path —
      // or, as it turns out, anywhere else in the library. A saved query that
      // selects a column the console hides is embeddable by any holder of
      // `catalog:embed` the moment a person marks it shared.
      //
      // That is the documented model — access is what somebody explicitly
      // shared, never derived by parsing SQL — and it means `shared` is a
      // security decision, not a convenience toggle.
      const server = (await embedApp()).getHttpServer();

      const response = await request(server)
        .get('/api/catalog/embed/charts/q-classified')
        .set('x-catalog-key', 'embedder')
        .expect(200);
      expect(response.body.rows[0].label).toBe('select ssn from person');
    });

    it('refuses an unshared chart with a message that says how to share it', async () => {
      const server = (await embedApp()).getHttpServer();

      const response = await request(server)
        .get('/api/catalog/embed/charts/q-private')
        .set('x-catalog-key', 'embedder')
        .expect(403);
      expect(response.body.message).toContain('has not been shared');
      // Refused before the query runs. A 403 that has already executed the
      // statement has leaked the load, and on a poll loop it leaks it forever.
      expect(store.ran).toEqual([]);
    });

    it('never becomes shared as a side effect of reading', async () => {
      // The gate is only a gate if reading through it cannot move it. Asserting
      // the store saw no write at all is what separates "embed does not share
      // things" from "embed happens not to have shared this one".
      const workspace = new StubWorkspace(QUERIES, DASHBOARDS);
      const server = (await embedApp(workspace)).getHttpServer();

      for (const route of EMBED_ROUTES) {
        await request(server).get(route).set('x-catalog-key', 'embedder').expect(200);
      }
      expect(workspace.writes).toEqual([]);
    });

    it('carries `shared` from the request body to the store, in both directions', async () => {
      // The mechanism the whole model rests on. `shared` is set by a person and
      // is the entire access boundary, so a body type that does not declare it
      // is a field a host's whitelisting `ValidationPipe` deletes — and the
      // symptom is a toggle that appears to save while the embed API keeps
      // answering 403 for a board somebody just shared.
      const workspace = new StubWorkspace(QUERIES, DASHBOARDS);
      const server = (await embedApp(workspace)).getHttpServer();

      await request(server)
        .post('/api/catalog/dashboards')
        .send({ name: 'New board', shared: true })
        .expect(201)
        .expect((response) => {
          expect(response.body.shared).toBe(true);
        });
      expect(workspace.writes.at(-1)?.input).toMatchObject({ name: 'New board', shared: true });

      await request(server)
        .patch('/api/catalog/dashboards/d-ops')
        .send({ shared: false })
        .expect(200);
      expect(workspace.writes.at(-1)?.input).toEqual({ shared: false });
    });

    it('does not invent `shared` when the caller said nothing', async () => {
      // Absent must stay absent all the way to the store, which is where the
      // `?? false` default lives. A service that filled in a value here would
      // be deciding sharing on the caller's behalf — in whichever direction its
      // default happened to point.
      const workspace = new StubWorkspace(QUERIES, DASHBOARDS);
      const server = (await embedApp(workspace)).getHttpServer();

      await request(server).post('/api/catalog/dashboards').send({ name: 'Quiet' }).expect(201);

      const written = workspace.writes.at(-1)?.input ?? {};
      expect('shared' in written).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Layout.
  // -------------------------------------------------------------------------

  describe('layout', () => {
    it('embeds a dashboard in position order, whatever order the cards were stored in', async () => {
      const server = (await embedApp()).getHttpServer();

      const response = await request(server)
        .get('/api/catalog/embed/dashboards/d-ops')
        .set('x-catalog-key', 'embedder')
        .expect(200);

      expect(response.body.charts.map((chart: { id: string }) => chart.id)).toEqual([
        'q-sales',
        'q-classified',
        'q-cached',
      ]);
      expect(response.body.charts.map((chart: { layout: unknown }) => chart.layout)).toEqual([
        { width: 4, position: 1 },
        { width: 2, position: 2 },
        { width: 1, position: 3 },
      ]);
    });

    it('gives a standalone chart no layout, because there is no board to take one from', async () => {
      // Not an omission. `layout` is the dashboard's hint about where the chart
      // sits on THAT board; a chart fetched on its own is being placed by the
      // consumer, and inventing a width here would be this library guessing at
      // someone else's grid.
      const server = (await embedApp()).getHttpServer();

      const response = await request(server)
        .get('/api/catalog/embed/charts/q-sales')
        .set('x-catalog-key', 'embedder')
        .expect(200);
      expect(response.body.layout).toBeUndefined();
    });

    it("honours the card's title and library overrides, which is what they are for", async () => {
      // The console draws this board with the card's title and the card's
      // chart library. An embed that fell back to the saved query would show a
      // different heading and a different chart for the same dashboard —
      // silently, with nothing thrown and nothing logged, which is the worst
      // shape a disagreement can have.
      const server = (await embedApp()).getHttpServer();

      const response = await request(server)
        .get('/api/catalog/embed/dashboards/d-branded')
        .set('x-catalog-key', 'embedder')
        .expect(200);

      const [renamed, blankTitled, plain] = response.body.charts;

      expect(renamed.title).toBe('Q4 revenue');
      // The card's library replaces the query's, and nothing else about the
      // visualization moves: `kind` and `labelColumn` still come from the query.
      expect(renamed.visualization).toEqual({
        kind: 'line',
        library: 'bklit',
        labelColumn: 'label',
      });

      // A title cleared in the console is whitespace, not absence, and a board
      // with a blank heading is worse than one showing the query's own name.
      expect(blankTitled.title).toBe('Sales by region');

      // No override: the query's own name and its own library, unchanged.
      expect(plain.title).toBe('Revenue');
      expect(plain.visualization).toEqual({
        kind: 'line',
        library: 'recharts',
        labelColumn: 'label',
      });
    });

    it('leaves the library key absent when neither the card nor the query chose', async () => {
      // Absent, not `undefined`. This payload is serialised to another
      // application, and "the key is there and empty" is a different statement
      // from "nobody chose" to anything downstream that inspects it.
      const server = (await embedApp()).getHttpServer();

      const response = await request(server)
        .get('/api/catalog/embed/charts/q-sales')
        .set('x-catalog-key', 'embedder')
        .expect(200);

      expect('library' in response.body.visualization).toBe(false);
    });

    it('passes the visualization through so the consumer knows how to draw it', async () => {
      const server = (await embedApp()).getHttpServer();

      const response = await request(server)
        .get('/api/catalog/embed/charts/q-sales')
        .set('x-catalog-key', 'embedder')
        .expect(200);

      expect(response.body.visualization).toEqual({
        kind: 'bar',
        labelColumn: 'label',
        valueColumns: ['value'],
      });
      expect(response.body.columns).toEqual(['label', 'value']);
      expect(response.body.rowCount).toBe(1);
      expect(response.body.title).toBe('Sales by region');
    });
  });

  // -------------------------------------------------------------------------
  // 5. Ids that do not resolve.
  // -------------------------------------------------------------------------

  describe('missing things', () => {
    it('answers 404 for an unknown chart and an unknown dashboard', async () => {
      const server = (await embedApp()).getHttpServer();

      await request(server)
        .get('/api/catalog/embed/charts/q-nope')
        .set('x-catalog-key', 'embedder')
        .expect(404);
      await request(server)
        .get('/api/catalog/embed/dashboards/d-nope')
        .set('x-catalog-key', 'embedder')
        .expect(404);
    });

    it('serves a dashboard whose cards point at deleted and unshared queries, minus those cards', async () => {
      // The failure mode this guards against is a 500 or a half-built payload:
      // one deleted saved query must not blank a page that is on a wall
      // somewhere. The surviving card keeps its own layout — a skipped card
      // does not renumber the ones around it, because the consumer's grid is
      // keyed on `position`.
      const server = (await embedApp()).getHttpServer();

      const response = await request(server)
        .get('/api/catalog/embed/dashboards/d-holes')
        .set('x-catalog-key', 'embedder')
        .expect(200);

      expect(response.body.id).toBe('d-holes');
      expect(response.body.name).toBe('Half gone');
      expect(response.body.charts).toHaveLength(1);
      expect(response.body.charts[0].id).toBe('q-sales');
      expect(response.body.charts[0].layout).toEqual({ width: 4, position: 1 });
      expect(typeof response.body.generatedAt).toBe('string');
    });
  });

  // -------------------------------------------------------------------------
  // 6. Freshness.
  // -------------------------------------------------------------------------

  describe('cached and generatedAt', () => {
    it('reports cached:false and re-runs the query when the saved query caches nothing', async () => {
      // `cacheTtlSeconds: 0` means never cache, and a consumer polling this
      // must be able to trust that. The serial riding in the rows is what makes
      // the claim independent of the flag: a stale row would show `1` twice.
      const server = (await embedApp()).getHttpServer();

      const first = await request(server)
        .get('/api/catalog/embed/charts/q-sales')
        .set('x-catalog-key', 'embedder')
        .expect(200);
      const second = await request(server)
        .get('/api/catalog/embed/charts/q-sales')
        .set('x-catalog-key', 'embedder')
        .expect(200);

      expect(first.body.cached).toBe(false);
      expect(second.body.cached).toBe(false);
      expect(first.body.rows[0].value).toBe(1);
      expect(second.body.rows[0].value).toBe(2);
      expect(store.ran).toHaveLength(2);
    });

    it('reports cached:true and does not re-run when the saved query has a TTL', async () => {
      const server = (await embedApp()).getHttpServer();

      const first = await request(server)
        .get('/api/catalog/embed/charts/q-cached')
        .set('x-catalog-key', 'embedder')
        .expect(200);
      const second = await request(server)
        .get('/api/catalog/embed/charts/q-cached')
        .set('x-catalog-key', 'embedder')
        .expect(200);

      expect(first.body.cached).toBe(false);
      expect(second.body.cached).toBe(true);
      // Same rows, one execution: `cached` is describing something real rather
      // than being set beside a second trip to the database.
      expect(second.body.rows).toEqual(first.body.rows);
      expect(store.ran).toEqual(['select * from q-cached']);
    });

    it('moves generatedAt on a cache hit, so it is the response time and not the row time', async () => {
      // A divergence worth knowing about rather than a bug to fix here.
      // `generatedAt` is stamped when the payload is assembled, so on a hit it
      // says "now" over rows computed up to the TTL ago. `cached` is the field
      // that warns you; nothing in the payload recovers when the rows were
      // actually computed.
      //
      // Only `Date` is faked. Faking the timer queue as well would stall the
      // HTTP server these requests go through.
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
        const server = (await embedApp()).getHttpServer();

        const first = await request(server)
          .get('/api/catalog/embed/charts/q-cached')
          .set('x-catalog-key', 'embedder')
          .expect(200);

        vi.setSystemTime(new Date('2026-01-01T00:00:30.000Z'));
        const second = await request(server)
          .get('/api/catalog/embed/charts/q-cached')
          .set('x-catalog-key', 'embedder')
          .expect(200);

        expect(first.body.generatedAt).toBe('2026-01-01T00:00:00.000Z');
        expect(second.body.generatedAt).toBe('2026-01-01T00:00:30.000Z');
        expect(second.body.cached).toBe(true);
        expect(second.body.rows).toEqual(first.body.rows);
      } finally {
        vi.useRealTimers();
      }
    });

    it('stamps generatedAt on the dashboard as well as on each of its charts', async () => {
      const server = (await embedApp()).getHttpServer();

      const response = await request(server)
        .get('/api/catalog/embed/dashboards/d-ops')
        .set('x-catalog-key', 'embedder')
        .expect(200);

      expect(new Date(response.body.generatedAt).toISOString()).toBe(response.body.generatedAt);
      for (const chart of response.body.charts) {
        expect(new Date(chart.generatedAt).toISOString()).toBe(chart.generatedAt);
        // The board is assembled after its cards, never before them.
        expect(Date.parse(response.body.generatedAt)).toBeGreaterThanOrEqual(
          Date.parse(chart.generatedAt),
        );
      }
    });
  });
});
