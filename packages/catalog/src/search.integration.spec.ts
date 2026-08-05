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
import { CatalogModule } from './catalog.module';
import { InMemoryCatalogOverlayStore } from './catalog.overlay-store';
import type { CatalogPrincipal } from './catalog.principal';
import type { CatalogQueryRelation, CatalogQueryResult } from './catalog.query';
import { CatalogRegistry } from './catalog.registry.base';
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
  type SaveQueryInput,
  type SavedQuery,
} from './catalog.workspace';
import type { CatalogSearchHit, CatalogSearchResult } from './search.types';

/**
 * `GET /catalog/search`, through a real application, with a real guard putting a
 * real principal on the request.
 *
 * The unit spec beside this one proves the filter filters. This proves the
 * filter is *reached*: that the controller passes the principal its `@Req()`
 * carries, that the service hands it to `visibleToPrincipal` before it hands
 * anything to the matcher, and that both stores are read. Every one of those
 * links can be removed without breaking a single assertion in `search.spec.ts`
 * — the route would keep answering, in more detail, to everybody.
 *
 * That is the failure this file exists for. A search that leaks the NAME of a
 * type the caller may not read returns 200, logs nothing, and looks exactly like
 * a search that worked.
 */

// ---------------------------------------------------------------------------
// The host's half: a guard that resolves a principal and puts it on the request.
// ---------------------------------------------------------------------------

/**
 * Keyed by header, the way `StaticKeyPrincipalResolver` is, but written out here
 * because the shapes under test are the grants rather than the transport.
 *
 * `analyst` may read everything and holds `CUI`. `fleet` may read only `Mvr`.
 * `cleared-for-nothing` may read every type and holds no classification at all —
 * which is the default for a principal nobody has thought about, and the case
 * where a property NAME is the sensitive part.
 */
const PRINCIPALS: Record<string, CatalogPrincipal> = {
  analyst: { id: 'analyst', scopes: ['catalog:read'], classifications: ['CUI'] },
  fleet: { id: 'fleet', scopes: ['catalog:read'], readTypes: ['Mvr'], classifications: ['CUI'] },
  'cleared-for-nothing': { id: 'plain', scopes: ['catalog:read'] },
  // Holds the wrong scope entirely. Only reachable through the lax guard below.
  'embed-only': { id: 'embedder', scopes: ['catalog:embed'] },
};

/**
 * The normal host: resolve, attach, and let the route's declared scope decide.
 *
 * `request.principal` is assigned rather than returned, because that is the
 * contract the controller reads — see `actorOf` and the `@Req()` on `search`.
 */
@Injectable()
class ResolvingGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp().getRequest();
    const key = Reflect.get(Reflect.get(http, 'headers') ?? {}, 'x-catalog-key');
    const principal = typeof key === 'string' ? PRINCIPALS[key] : undefined;
    if (principal) Reflect.set(http, 'principal', principal);
    return true;
  }
}

// ---------------------------------------------------------------------------
// The catalog under test.
// ---------------------------------------------------------------------------

function property(overrides: Partial<CatalogPropertyDef> = {}): CatalogPropertyDef {
  return {
    name: 'id',
    displayName: 'Id',
    type: 'string',
    columnName: 'id',
    nullable: false,
    primary: true,
    hidden: false,
    order: 0,
    enriched: false,
    ...overrides,
  };
}

const MVR: CatalogObjectTypeDef = {
  name: 'Mvr',
  displayName: 'Vehicle',
  pluralDisplayName: 'Vehicles',
  tableName: 'mvr',
  group: 'Fleet',
  primaryKey: ['id'],
  enriched: true,
  properties: [
    property(),
    property({ name: 'tailNumber', displayName: 'Tail number', primary: false }),
  ],
  relations: [],
};

/**
 * A type `fleet` may not read at all, carrying a property `cleared-for-nothing`
 * may not see. Both names are the disclosure — `settlementAmount` on a table
 * called `Dispute` says what the dispute was about.
 */
const DISPUTE: CatalogObjectTypeDef = {
  name: 'Dispute',
  displayName: 'Dispute',
  pluralDisplayName: 'Disputes',
  tableName: 'dispute',
  group: 'Legal',
  primaryKey: ['id'],
  enriched: true,
  properties: [
    property({ primary: true }),
    property({
      name: 'settlementAmount',
      displayName: 'Settlement amount',
      type: 'number',
      primary: false,
      classification: 'CUI',
    }),
  ],
  relations: [],
};

@Injectable()
class StubRegistry extends CatalogRegistry {
  getSnapshot(): CatalogSnapshot {
    return {
      version: 1,
      generatedAt: new Date(0).toISOString(),
      stats: { types: 2, properties: 4, relations: 0, enrichedTypes: 2 },
      types: [MVR, DISPUTE],
    };
  }
  getType(name: string): CatalogObjectTypeDef | undefined {
    return [MVR, DISPUTE].find((type) => type.name === name);
  }
  getGraph(): CatalogGraph {
    return { nodes: [], edges: [] };
  }
  patchType(): Promise<CatalogObjectTypeDef | undefined> {
    return Promise.resolve(MVR);
  }
  patchProperty(): Promise<CatalogObjectTypeDef | undefined> {
    return Promise.resolve(MVR);
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
  name: 'Dispute settlements by quarter',
  description: 'Every settlement, bucketed.',
  folder: 'Legal',
  // The thing that must never reach a search result, whatever else changes.
  sql: 'select settlement_amount from dispute',
  createdBy: 'console',
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  cacheTtlSeconds: 0,
  visualization: { kind: 'table' },
  shared: false,
};

const DASHBOARD: Dashboard = {
  id: 'd-1',
  name: 'Dispute overview',
  createdBy: 'console',
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  cards: [],
  shared: false,
};

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
  updateSavedQuery(): Promise<SavedQuery | undefined> {
    return Promise.resolve(SAVED_QUERY);
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
  saveDashboard(): Promise<Dashboard> {
    return Promise.resolve(DASHBOARD);
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

function workspaceModule(): DynamicModule {
  return {
    module: class WorkspaceModule {},
    providers: [{ provide: CATALOG_WORKSPACE_STORE, useValue: new StubWorkspace() }],
    exports: [CATALOG_WORKSPACE_STORE],
  };
}

/** `kind:id`, which is what a row is, and what an assertion about leakage needs. */
function identify(hits: CatalogSearchHit[]): string[] {
  return hits.map((hit) => `${hit.kind}:${hit.typeName ? `${hit.typeName}.` : ''}${hit.id}`);
}

describe('GET /catalog/search (integration)', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function boot() {
    const moduleRef = await Test.createTestingModule({
      imports: [
        CatalogModule.forRoot({
          path: 'api/catalog',
          guards: [ResolvingGuard],
          imports: [workspaceModule()],
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

  async function search(
    server: unknown,
    key: string | undefined,
    query: Record<string, string>,
  ): Promise<CatalogSearchResult> {
    const call = request(server).get('/api/catalog/search').query(query);
    const response = await (key ? call.set('x-catalog-key', key) : call);
    expect(response.status).toBe(200);
    return response.body;
  }

  it('crosses all four kinds in one call', async () => {
    // The whole point of the route. Four kinds live on four screens today, and
    // the term is a word somebody half-remembers.
    const server = await boot();

    const result = await search(server, 'analyst', { q: 'dispute' });

    expect(new Set(result.hits.map((hit) => hit.kind))).toEqual(
      new Set(['objectType', 'savedQuery', 'dashboard']),
    );
  });

  it('reads both the registry and the workspace store, without a second request', async () => {
    const server = await boot();

    const result = await search(server, 'analyst', { q: 'settlement' });

    // A property from the in-memory snapshot AND a saved query from the store,
    // in one answer. If the fan-out were ever split, this is the assertion that
    // notices.
    expect(identify(result.hits)).toContain('property:Dispute.settlementAmount');
    expect(identify(result.hits)).toContain('savedQuery:q-1');
  });

  it('does not return the NAME of a type this caller may not read', async () => {
    // `fleet` has `readTypes: ["Mvr"]`. A hit saying "there is a type called
    // Dispute" is the disclosure, even though not one row came back with it.
    const server = await boot();

    const result = await search(server, 'fleet', { q: 'dispute' });

    expect(identify(result.hits)).toEqual(['savedQuery:q-1', 'dashboard:d-1']);
    // Asserted on `typeName` rather than on the serialised body: a saved query
    // legitimately CALLED "Dispute settlements by quarter" comes back, because
    // a saved query has no per-type grant to check and `GET saved-queries`
    // would return it to this same caller. What must not appear is the type.
    expect(result.hits.some((hit) => hit.typeName === 'Dispute')).toBe(false);
  });

  it('does not return the properties of a type this caller may not read either', async () => {
    // The follow-on failure: filtering types but ranking properties from the
    // unfiltered snapshot leaks `Dispute.settlementAmount` while the type row
    // itself is correctly absent — which looks MORE correct, not less.
    const server = await boot();

    const result = await search(server, 'fleet', { q: 'settlement' });

    expect(identify(result.hits)).toEqual(['savedQuery:q-1']);
  });

  it('does not surface a classified property to a caller without the classification', async () => {
    // `cleared-for-nothing` may read `Dispute` — so the type comes back — and
    // holds no classification, so the CUI property must not. The NAME is the
    // sensitive part here: "settlement amount" answers what the dispute was
    // about before any value is fetched.
    const server = await boot();

    const result = await search(server, 'cleared-for-nothing', { q: 'settlement' });

    expect(identify(result.hits)).toEqual(['savedQuery:q-1']);
    expect(JSON.stringify(result)).not.toContain('settlementAmount');
  });

  it('does surface it to a caller who holds the classification', async () => {
    // The other half. A filter that dropped everything would pass every test
    // above and make the feature useless.
    const server = await boot();

    const result = await search(server, 'analyst', { q: 'settlement' });

    expect(identify(result.hits)).toContain('property:Dispute.settlementAmount');
  });

  it('counts the total after the filter, not before it', async () => {
    // Otherwise the row count tells `fleet` exactly how many things it cannot
    // see, in a field nobody reads as sensitive.
    const server = await boot();

    const [everything, restricted] = await Promise.all([
      search(server, 'analyst', { q: 'dispute' }),
      search(server, 'fleet', { q: 'dispute' }),
    ]);

    expect(everything.total).toBe(everything.hits.length);
    expect(restricted.total).toBe(restricted.hits.length);
    expect(restricted.total).toBeLessThan(everything.total);
  });

  it('never returns the SQL behind a saved query', async () => {
    const server = await boot();

    const result = await search(server, 'analyst', { q: 'dispute settlements' });

    expect(JSON.stringify(result)).not.toContain('select');
  });

  it('does not match a saved query on the text of its statement', async () => {
    // `settlement_amount` appears only inside the SQL. A hit here would mean
    // the matcher is reading statements, which is the feature `SearchableSavedQuery`
    // argues against — and would put a fragment of one in a dropdown.
    const server = await boot();

    const result = await search(server, 'analyst', { q: 'settlement_amount' });

    expect(result.hits.filter((hit) => hit.kind === 'savedQuery')).toEqual([]);
  });

  it('honours the limit parameter off the query string', async () => {
    const server = await boot();

    const result = await search(server, 'analyst', { q: 'dispute', limit: '1' });

    expect(result.hits).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it('answers a missing term with an empty result rather than a 400', async () => {
    // A search screen mounts before anybody types.
    const server = await boot();

    const response = await request(server)
      .get('/api/catalog/search')
      .set('x-catalog-key', 'analyst');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ term: '', total: 0, truncated: false, hits: [] });
  });

  it('answers a caller the guard let through without the read scope with nothing', async () => {
    // `ResolvingGuard` is deliberately lax — it attaches and admits. A host's
    // guard should have refused this, and `maySearch` is what stops the
    // inconsistency if one does not: no types (mayRead checks the scope) but
    // every board name (nothing per-object to check) would otherwise come back.
    const server = await boot();

    const result = await search(server, 'embed-only', { q: 'dispute' });

    expect(result).toEqual({ term: 'dispute', total: 0, truncated: false, hits: [] });
  });

  it('filters nothing for a caller it could not resolve at all', async () => {
    // Not a fail-open: `GET /catalog` on this same lax deployment already hands
    // over the whole snapshot. Search being exactly as open as the route beside
    // it — and strictly narrower the moment a principal appears — is the promise
    // this library can honestly make. Pinned so that "tighten it" is a decision
    // rather than a drift.
    const server = await boot();

    const result = await search(server, undefined, { q: 'dispute' });

    expect(identify(result.hits)).toContain('objectType:Dispute.Dispute');
  });
});
