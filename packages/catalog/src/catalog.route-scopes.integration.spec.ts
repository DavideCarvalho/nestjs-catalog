import type {
  CanActivate,
  DynamicModule,
  ExecutionContext,
  INestApplication,
} from '@nestjs/common';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createCatalogController } from './catalog.controller';
import { CatalogModule } from './catalog.module';
import { InMemoryCatalogOverlayStore } from './catalog.overlay-store';
import {
  type CatalogPrincipal,
  type CatalogScope,
  StaticKeyPrincipalResolver,
  hasScope,
} from './catalog.principal';
import type { CatalogQueryRelation, CatalogQueryResult } from './catalog.query';
import { CatalogRegistry } from './catalog.registry.base';
import { REQUIRED_SCOPES } from './catalog.route-auth';
import { CATALOG_STORE, type CatalogReadResult, type CatalogReadStore } from './catalog.store';
import type {
  CatalogGraph,
  CatalogObjectTypeDef,
  CatalogPropertyDef,
  CatalogSnapshot,
} from './catalog.types';
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
 * What every route on the catalog controller asks for.
 *
 * An *absent* declaration is a declaration: `catalog.route-auth.ts` states that
 * absence means "authenticated is enough", so a route nobody decorated tells a
 * host's guard to let anybody in. For several releases that was the answer this
 * controller gave for arbitrary SQL and for every curation edit, and nothing
 * here said so — which is why the interesting assertion is not "the decorator is
 * present" but "a principal holding the wrong thing is refused".
 *
 * Each route is checked from both sides, through a real guard on a real
 * application:
 *
 * - the declared scope **alone** gets in, so a route cannot quietly be tightened
 *   past what its normal caller holds;
 * - **every other scope, all at once**, is refused, so a route cannot quietly be
 *   loosened, re-pointed at a different scope, or stripped of its declaration.
 *
 * The second principal deliberately excludes `catalog:admin`, which expands to
 * every scope and would sail through anything.
 *
 * Together the pair is exact: changing a route's scope from A to B puts B in the
 * complement of A and the refusal test fails; widening it to `catalog:admin`
 * leaves the complement refused but locks out the single-scope principal and the
 * admission test fails; deleting the decorator fails the refusal test outright.
 */

// ---------------------------------------------------------------------------
// The host's guard, and the principals it resolves.
// ---------------------------------------------------------------------------

/**
 * A total record rather than a list, so a scope added to `CatalogScope` stops
 * this file compiling rather than silently becoming a value the guard drops.
 */
const KNOWN_SCOPES: Record<CatalogScope, true> = {
  'catalog:read': true,
  'catalog:write': true,
  'catalog:curate': true,
  'catalog:embed': true,
  'catalog:admin': true,
};

/** Everything except `catalog:admin`, which implies the rest. */
const NARROW_SCOPES: readonly CatalogScope[] = [
  'catalog:read',
  'catalog:write',
  'catalog:curate',
  'catalog:embed',
];

const ALL_SCOPES: readonly CatalogScope[] = [...NARROW_SCOPES, 'catalog:admin'];

function isScopeList(value: unknown): value is CatalogScope[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === 'string' && Object.hasOwn(KNOWN_SCOPES, entry))
  );
}

/** The key presented for "holds exactly this scope, and nothing else". */
function onlyKey(scope: CatalogScope): string {
  return `only:${scope}`;
}

/** The key presented for "holds every narrow scope except this one". */
function exceptKey(scope: CatalogScope): string {
  return `except:${scope}`;
}

const RESOLVER = new StaticKeyPrincipalResolver([
  ...ALL_SCOPES.map((scope) => ({
    key: onlyKey(scope),
    id: `only-${scope}`,
    scopes: [scope],
  })),
  ...ALL_SCOPES.map((scope) => ({
    key: exceptKey(scope),
    id: `except-${scope}`,
    // `catalog:admin` is never included: it expands to everything, so a
    // complement holding it would be admitted everywhere and would turn every
    // refusal below into a test that cannot fail.
    scopes: NARROW_SCOPES.filter((other) => other !== scope),
  })),
]);

/**
 * The host's half of the contract, written the way a host would write it: read
 * the metadata off the route, resolve the caller, compare.
 */
@Injectable()
class ScopeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const declared = this.reflector.getAllAndOverride<unknown>(REQUIRED_SCOPES, [
      context.getHandler(),
      context.getClass(),
    ]);
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
// Stubs, sized so every route reaches its handler rather than a 404.
// ---------------------------------------------------------------------------

const PROPERTY: CatalogPropertyDef = {
  name: 'id',
  displayName: 'Id',
  type: 'string',
  columnName: 'id',
  nullable: false,
  primary: true,
  hidden: false,
  order: 0,
  enriched: false,
};

const TYPE: CatalogObjectTypeDef = {
  name: 'vehicle',
  displayName: 'Vehicle',
  pluralDisplayName: 'Vehicles',
  tableName: 'vehicle',
  group: 'default',
  primaryKey: ['id'],
  enriched: false,
  properties: [PROPERTY],
  relations: [],
};

@Injectable()
class StubRegistry extends CatalogRegistry {
  getSnapshot(): CatalogSnapshot {
    return {
      version: 1,
      generatedAt: new Date(0).toISOString(),
      stats: { types: 1, properties: 1, relations: 0, enrichedTypes: 0 },
      types: [TYPE],
    };
  }
  getType(name: string): CatalogObjectTypeDef | undefined {
    return name === TYPE.name ? TYPE : undefined;
  }
  getGraph(): CatalogGraph {
    return { nodes: [], edges: [] };
  }
  patchType(): Promise<CatalogObjectTypeDef | undefined> {
    return Promise.resolve(TYPE);
  }
  patchProperty(): Promise<CatalogObjectTypeDef | undefined> {
    return Promise.resolve(TYPE);
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

/**
 * Both fixtures are shared, and that is load-bearing rather than incidental:
 * the embed routes answer **403** for something unshared, which is the same
 * status the guard uses. An unshared fixture would let a route pass the refusal
 * test below for a reason that has nothing to do with its declaration, and would
 * fail the admission test while the declaration was perfectly correct.
 */
const SAVED_QUERY: SavedQuery = {
  id: 'q-1',
  name: 'Sales',
  sql: 'select 1',
  createdBy: 'console',
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  cacheTtlSeconds: 0,
  visualization: { kind: 'table' },
  shared: true,
};

const DASHBOARD: Dashboard = {
  id: 'd-1',
  name: 'Operations',
  createdBy: 'console',
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  cards: [],
  shared: true,
};

/** Answers everything, so a status here is never a missing fixture. */
class StubWorkspace implements CatalogWorkspaceStore {
  listSavedQueries(): Promise<SavedQuery[]> {
    return Promise.resolve([SAVED_QUERY]);
  }
  getSavedQuery(): Promise<SavedQuery | undefined> {
    return Promise.resolve(SAVED_QUERY);
  }
  saveQuery(input: SaveQueryInput, createdBy: string): Promise<SavedQuery> {
    return Promise.resolve({ ...SAVED_QUERY, ...input, createdBy });
  }
  updateSavedQuery(_id: string, input: Partial<SaveQueryInput>): Promise<SavedQuery | undefined> {
    return Promise.resolve({ ...SAVED_QUERY, ...input });
  }
  deleteSavedQuery(): Promise<boolean> {
    return Promise.resolve(true);
  }
  listDashboards(): Promise<Dashboard[]> {
    return Promise.resolve([DASHBOARD]);
  }
  getDashboard(): Promise<Dashboard | undefined> {
    return Promise.resolve(DASHBOARD);
  }
  saveDashboard(
    input: { name: string; description?: string; cards?: DashboardCard[]; shared?: boolean },
    createdBy: string,
  ): Promise<Dashboard> {
    return Promise.resolve({ ...DASHBOARD, ...input, cards: input.cards ?? [], createdBy });
  }
  updateDashboard(): Promise<Dashboard | undefined> {
    return Promise.resolve(DASHBOARD);
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

// ---------------------------------------------------------------------------
// The routes, and what each one asks for.
// ---------------------------------------------------------------------------

type Method = 'get' | 'post' | 'patch' | 'delete';

interface Route {
  method: Method;
  path: string;
  scope: CatalogScope;
  body?: Record<string, unknown>;
}

const ROUTES: Route[] = [
  // The model, and the rows under it.
  { method: 'get', path: '/api/catalog', scope: 'catalog:read' },
  { method: 'get', path: '/api/catalog/graph', scope: 'catalog:read' },
  // Search is a shortcut to the four `catalog:read` routes below it, so it is
  // the same scope. What it filters BEYOND the scope — the types and classified
  // properties this principal may not see — is asserted in search.integration.
  { method: 'get', path: '/api/catalog/search?q=vehicle', scope: 'catalog:read' },
  { method: 'get', path: '/api/catalog/types/vehicle', scope: 'catalog:read' },
  { method: 'get', path: '/api/catalog/objects/vehicle', scope: 'catalog:read' },
  { method: 'get', path: '/api/catalog/objects/vehicle/snapshots', scope: 'catalog:read' },

  // Curation: the presentation layer, and the button that discards all of it.
  {
    method: 'patch',
    path: '/api/catalog/types/vehicle',
    scope: 'catalog:curate',
    body: { displayName: 'Vehicles' },
  },
  {
    method: 'patch',
    path: '/api/catalog/types/vehicle/properties/id',
    scope: 'catalog:curate',
    body: { displayName: 'Identifier' },
  },
  { method: 'post', path: '/api/catalog/reset', scope: 'catalog:curate' },

  // SQL. The relations panel describes the model; running a statement does not.
  { method: 'get', path: '/api/catalog/query/relations', scope: 'catalog:read' },
  {
    method: 'post',
    path: '/api/catalog/query',
    scope: 'catalog:admin',
    body: { sql: 'select 1' },
  },

  // Saved queries: authoring carries the SQL scope, running does not.
  { method: 'get', path: '/api/catalog/workspace/capabilities', scope: 'catalog:read' },
  { method: 'get', path: '/api/catalog/saved-queries', scope: 'catalog:read' },
  { method: 'get', path: '/api/catalog/saved-queries/q-1', scope: 'catalog:read' },
  {
    method: 'post',
    path: '/api/catalog/saved-queries',
    scope: 'catalog:admin',
    body: { name: 'Sales', sql: 'select 1' },
  },
  {
    method: 'patch',
    path: '/api/catalog/saved-queries/q-1',
    scope: 'catalog:admin',
    body: { name: 'Sales by region' },
  },
  { method: 'delete', path: '/api/catalog/saved-queries/q-1', scope: 'catalog:curate' },
  { method: 'post', path: '/api/catalog/saved-queries/q-1/run', scope: 'catalog:read' },
  { method: 'get', path: '/api/catalog/saved-queries/q-1/export.csv', scope: 'catalog:read' },

  // Dashboards carry no SQL of their own.
  { method: 'get', path: '/api/catalog/dashboards', scope: 'catalog:read' },
  { method: 'get', path: '/api/catalog/dashboards/d-1', scope: 'catalog:read' },
  {
    method: 'post',
    path: '/api/catalog/dashboards',
    scope: 'catalog:curate',
    body: { name: 'Operations' },
  },
  {
    method: 'patch',
    path: '/api/catalog/dashboards/d-1',
    scope: 'catalog:curate',
    body: { name: 'Ops' },
  },
  { method: 'delete', path: '/api/catalog/dashboards/d-1', scope: 'catalog:curate' },

  // Embed, unchanged and asserted at length in catalog.embed.integration.spec.
  { method: 'get', path: '/api/catalog/embed', scope: 'catalog:embed' },
  { method: 'get', path: '/api/catalog/embed/dashboards/d-1', scope: 'catalog:embed' },
  { method: 'get', path: '/api/catalog/embed/charts/q-1', scope: 'catalog:embed' },

  // The trail.
  { method: 'get', path: '/api/catalog/events', scope: 'catalog:read' },
  { method: 'get', path: '/api/catalog/events/traces', scope: 'catalog:read' },
  { method: 'get', path: '/api/catalog/events/traces/t-1', scope: 'catalog:read' },
];

function describeRoute(route: Route): string {
  return `${route.method.toUpperCase()} ${route.path}`;
}

// ---------------------------------------------------------------------------

describe('Every catalog route declares what it needs (integration)', () => {
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

  async function boot() {
    const moduleRef = await Test.createTestingModule({
      imports: [
        CatalogModule.forRoot({
          path: 'api/catalog',
          guards: [ScopeGuard],
          imports: [workspaceModule(new StubWorkspace())],
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

  // Typed from supertest itself rather than `unknown`: `getHttpServer()` returns
  // `any`, and widening it to `unknown` here meant the call below could not be
  // checked at all — which the spec typecheck now says out loud.
  function send(server: Parameters<typeof request>[0], route: Route, key: string) {
    const call = request(server)[route.method](route.path).set('x-catalog-key', key);
    return route.body ? call.send(route.body) : call;
  }

  // -------------------------------------------------------------------------
  // 1. The declared scope, alone, is enough.
  // -------------------------------------------------------------------------

  it('admits a principal holding exactly the declared scope and nothing else', async () => {
    // The half that stops a route being tightened past its normal caller. The
    // exact status is not asserted — what each route answers is the business of
    // the specs that cover its behaviour — only that the guard was not what
    // stopped it.
    const server = await boot();

    for (const route of ROUTES) {
      const response = await send(server, route, onlyKey(route.scope));
      expect(
        [401, 403].includes(response.status)
          ? `${describeRoute(route)} -> ${response.status}`
          : 'ok',
      ).toBe('ok');
    }
  });

  // -------------------------------------------------------------------------
  // 2. Everything else, all at once, is not.
  // -------------------------------------------------------------------------

  it('refuses a principal holding every other scope but the declared one', async () => {
    // The half that does the work. A route whose declaration was dropped,
    // widened, or re-pointed at a different scope admits this principal.
    const server = await boot();

    for (const route of ROUTES) {
      const response = await send(server, route, exceptKey(route.scope));
      expect(`${describeRoute(route)} -> ${response.status}`).toBe(
        `${describeRoute(route)} -> 403`,
      );
    }
  });

  it('refuses a caller it cannot resolve at all, on every route', async () => {
    // The path a permissive guard falls through: no principal is a 401, never a
    // 200. Pinned per route rather than once, because a route that declares
    // nothing never reaches the resolver.
    const server = await boot();

    for (const route of ROUTES) {
      const response = await send(server, route, 'nobody-has-this-key');
      expect(`${describeRoute(route)} -> ${response.status}`).toBe(
        `${describeRoute(route)} -> 401`,
      );
    }
  });

  // -------------------------------------------------------------------------
  // 3. Nothing is missing from the table above.
  // -------------------------------------------------------------------------

  it('leaves no handler on the controller undeclared, and none out of the table', async () => {
    // Metadata rather than HTTP, deliberately, and only for this one question.
    // Asking it through requests cannot work: the routes a request can reach are
    // exactly the routes somebody remembered to list, so a new undeclared route
    // would be invisible to every test above. Counting them here is what makes
    // adding one without a scope — or with a scope nobody asserted — fail.
    const controller = createCatalogController('api/catalog', []);
    const prototype = controller.prototype;

    const handlers = Object.getOwnPropertyNames(prototype).filter((name) => {
      if (name === 'constructor') return false;
      const method = Reflect.get(prototype, name);
      return (
        typeof method === 'function' && Reflect.getMetadata(PATH_METADATA, method) !== undefined
      );
    });

    const undeclared = handlers.filter(
      (name) => Reflect.getMetadata(REQUIRED_SCOPES, Reflect.get(prototype, name)) === undefined,
    );
    expect(undeclared).toEqual([]);
    expect(handlers).toHaveLength(ROUTES.length);
  });

  it('leaves no handler on the ACCESS controller undeclared either', async () => {
    // A second factory, and the reason this test exists rather than being
    // folded into the one above: the sweep knew about `createCatalogController`
    // and nothing else, so all three access routes sat unscoped — `authenticated
    // is enough` for the endpoint that enumerates every application's scopes and
    // grants, and for the one that mints an administrator — while a sweep named
    // "leaves no handler undeclared" passed. A completeness check that knows
    // about some of the controllers is not a completeness check; it is a
    // statement that the ones it forgot are fine.
    //
    // Whoever adds a third factory must add it here. There is no way to
    // enumerate them from the module without booting it, and booting it needs
    // the stores these routes are declared independently of.
    const { createAccessController } = await import('./access.controller');
    const prototype = createAccessController('api/catalog/access', []).prototype;

    const handlers = Object.getOwnPropertyNames(prototype).filter((name) => {
      if (name === 'constructor') return false;
      const method = Reflect.get(prototype, name);
      return (
        typeof method === 'function' && Reflect.getMetadata(PATH_METADATA, method) !== undefined
      );
    });

    expect(handlers.length).toBeGreaterThan(0);
    // Every one of them, and every one of them `catalog:admin` — the whole
    // surface is the governance screen, so a route here that asked for less
    // would be a route that lets a curator read what a stolen key is worth.
    for (const name of handlers) {
      const scopes = Reflect.getMetadata(REQUIRED_SCOPES, Reflect.get(prototype, name));
      expect(`${name} -> ${JSON.stringify(scopes)}`).toBe(`${name} -> ["catalog:admin"]`);
    }
  });
});
