import {
  CATALOG_PIPELINE_STORE,
  CATALOG_STORE,
  type CatalogConnection,
  type CatalogConnector,
  type CatalogObjectTypeDef,
  type CatalogPrincipal,
} from '@dudousxd/nestjs-catalog';
import type { INestApplication } from '@nestjs/common';
import { type CanActivate, type ExecutionContext, Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CatalogPipelineModule } from './pipeline.module';
import {
  CATALOG_PIPELINE_EM,
  CATALOG_PIPELINE_REGISTRY,
  type CatalogPipelineRegistry,
} from './seams';

/** See the note in `pipeline.module.integration.spec.ts`: the package cannot load here. */
vi.mock('@dudousxd/nestjs-durable', () => ({
  WorkflowEngine: class WorkflowEngine {},
  Step: () => (_target: unknown, _key: unknown, descriptor: unknown) => descriptor,
  Workflow: () => (target: unknown) => target,
}));

/**
 * `POST connectors/:id/discover`, driven over HTTP.
 *
 * Over the wire rather than against the function, because everything worth
 * asserting about this route is something the route does *around* discovery:
 * the grant it checks before reading anything, the refusals it turns into a 400
 * instead of a 500, and — the one that would be a security bug — that it writes
 * nothing at all. `discoverConnectorSchema` is unit-tested next door; a unit
 * test of it passes whether or not the controller ever calls `assertMayCommit`.
 */

const MVR_ONLY: CatalogPrincipal = {
  id: 'app-a',
  scopes: ['catalog:write', 'catalog:read'],
  writeTypes: ['Mvr'],
};

const SUBWO_ONLY: CatalogPrincipal = {
  id: 'app-b',
  scopes: ['catalog:write', 'catalog:read'],
  writeTypes: ['Subwo'],
};

@Injectable()
class HeaderPrincipalGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req: { headers?: Record<string, unknown>; principal?: CatalogPrincipal } = context
      .switchToHttp()
      .getRequest();
    const who = req.headers?.['x-principal'];
    if (who === 'mvr-only') req.principal = MVR_ONLY;
    if (who === 'subwo-only') req.principal = SUBWO_ONLY;
    return true;
  }
}

const connectors = new Map<string, CatalogConnector>();
const connections = new Map<string, CatalogConnection>();

function connector(overrides: Partial<CatalogConnector> = {}): CatalogConnector {
  return {
    id: 'c1',
    name: 'Nightly pull',
    kind: 'inline',
    targetType: 'Mvr',
    config: { records: [{ plate: 'AB-1', miles: 12 }] },
    enabled: true,
    createdBy: 'ana',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const MVR: CatalogObjectTypeDef = {
  name: 'Mvr',
  displayName: 'Vehicle',
  pluralDisplayName: 'Vehicles',
  tableName: 'obj_mvr',
  group: 'Fleet',
  primaryKey: [],
  enriched: false,
  properties: [
    {
      name: 'plate',
      displayName: 'Plate',
      type: 'string',
      columnName: 'plate',
      nullable: true,
      primary: false,
      hidden: false,
      order: 0,
      enriched: false,
    },
  ],
  relations: [],
};

/** Which types exist, per test. Empty is the "this connector's type is new" case. */
const published = new Map<string, CatalogObjectTypeDef>();

const registryStub: CatalogPipelineRegistry = {
  reload: () => Promise.resolve(),
  getType: (name) => published.get(name),
};

/**
 * Enough store to serve this route, and a record of every write attempted.
 *
 * `useValue` takes a plain object, so this is only the handful of methods the
 * route reaches — and the counters exist because "discovery creates nothing" is
 * an assertion about calls that must never happen, not about a response body.
 */
const writes: string[] = [];
const pipelineStore = {
  getConnector: (id: string) => Promise.resolve(connectors.get(id)),
  getConnection: (id: string) => Promise.resolve(connections.get(id)),
  listConnectors: () => Promise.resolve([...connectors.values()]),
  listConnections: () => Promise.resolve([...connections.values()]),
  saveConnector: () => Promise.reject(new Error('nothing here saves a connector')),
  listRuns: () => Promise.resolve([]),
};

const writeStore = {
  capabilities: { snapshots: 'emulated', writable: true, timeTravel: false },
  ensureType: (type: CatalogObjectTypeDef) => {
    writes.push(`ensureType:${type.name}`);
    return Promise.resolve();
  },
  write: () => {
    writes.push('write');
    return Promise.resolve({ written: 0 });
  },
  commit: () => Promise.reject(new Error('nothing here commits')),
  read: () => Promise.resolve({ rows: [], total: 0 }),
  dropSnapshot: () => Promise.resolve(),
};

@Module({
  providers: [
    { provide: CATALOG_PIPELINE_STORE, useValue: pipelineStore },
    { provide: CATALOG_STORE, useValue: writeStore },
  ],
  exports: [CATALOG_PIPELINE_STORE, CATALOG_STORE],
})
class FakeStoreModule {}

const BASE = '/catalog/pipeline';

describe('discovering the schema behind a connector', () => {
  let app: INestApplication;

  beforeEach(async () => {
    connectors.clear();
    connections.clear();
    published.clear();
    writes.length = 0;
    connectors.set('c1', connector());

    const moduleRef = await Test.createTestingModule({
      imports: [
        CatalogPipelineModule.forRoot({
          path: 'catalog',
          guards: [HeaderPrincipalGuard],
          imports: [FakeStoreModule],
          em: {
            provide: CATALOG_PIPELINE_EM,
            useValue: () => {
              throw new Error('No EntityManager here; nothing in this file publishes a type.');
            },
          },
          registry: { provide: CATALOG_PIPELINE_REGISTRY, useValue: registryStub },
          scheduler: false,
        }),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const discover = (id: string, who: string) =>
    request(app.getHttpServer())
      .post(`${BASE}/connectors/${id}/discover`)
      .send({})
      .set('x-principal', who);

  it('reports the columns the source returned', async () => {
    const response = await discover('c1', 'mvr-only').expect(201);
    expect(response.body.columns.map((column: { name: string }) => column.name)).toEqual([
      'plate',
      'miles',
    ]);
  });

  it('answers 404 for a connector that is not there', async () => {
    await discover('nope', 'mvr-only').expect(404);
  });

  /**
   * The check that closes an information disclosure.
   *
   * Saving a connector and running one both require a grant on its target type,
   * so without this a principal holding `catalog:write` and no grants could not
   * cause the server to read any source at all. Discovery would be the first
   * route that could — press it against somebody else's connector and the
   * answer is the column names of a database this caller was never allowed near.
   */
  it('refuses a principal that may not write the type this connector loads', async () => {
    await discover('c1', 'subwo-only').expect(403);
  });

  it('refuses before it reads, so the refusal cannot be a probe', async () => {
    // A SQL connector with nothing configured fails loudly the moment discovery
    // touches it. A 403 rather than a 400 is what proves the grant was checked
    // first — the source was never opened at all.
    connectors.set('c2', connector({ id: 'c2', kind: 'sql', config: {} }));
    await discover('c2', 'subwo-only').expect(403);
    await discover('c2', 'mvr-only').expect(400);
  });

  // Nothing is created. Not the type, not its table — the confirmation is a
  // separate act against `PUT /publish/:type/schema`, by a person.
  it('creates nothing', async () => {
    const response = await discover('c1', 'mvr-only').expect(201);
    expect(response.body.typeExists).toBe(false);
    expect(writes).toEqual([]);
    expect(published.size).toBe(0);
  });

  it('measures drift against the type the engine actually reads', async () => {
    published.set('Mvr', MVR);
    const response = await discover('c1', 'mvr-only').expect(201);
    expect(response.body.typeExists).toBe(true);
    expect(response.body.drift).toEqual({ added: ['miles'], removed: [], retyped: [] });
  });

  // Resolved at read time, exactly as a run resolves it. A discovery that
  // described the connector's own half-configured address would describe a
  // source the load never touches — and here that is the difference between
  // reaching for a Postgres driver and refusing for want of a URL.
  it('reads through the connection that supplies the address', async () => {
    connections.set('conn-1', {
      id: 'conn-1',
      name: 'Warehouse',
      kind: 'sql',
      config: { url: 'postgres://warehouse/db' },
      createdBy: 'ana',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    connectors.set(
      'c5',
      connector({
        id: 'c5',
        kind: 'sql',
        config: { query: 'SELECT * FROM vehicles' },
        connectionId: 'conn-1',
      }),
    );
    const response = await discover('c5', 'mvr-only').expect(400);
    // It got as far as needing a driver, which it only can with the URL the
    // connection supplied. Without it the refusal is "this connector has no
    // connection URL", and this repo installs no `pg`.
    expect(JSON.stringify(response.body)).toMatch(/postgres driver/);
  });

  it('names the connection a connector reads through when it has gone', async () => {
    connectors.set('c3', connector({ id: 'c3', connectionId: 'gone' }));
    const response = await discover('c3', 'mvr-only').expect(400);
    expect(JSON.stringify(response.body)).toContain('gone');
  });

  // A source that refuses, a query that does not parse, a missing credential:
  // all of them are this connector's configuration. A 500 would hide the one
  // sentence that says which.
  it('answers a misconfigured source as a 400 that explains itself', async () => {
    connectors.set('c4', connector({ id: 'c4', kind: 'sql', config: { url: '', query: '' } }));
    const response = await discover('c4', 'mvr-only').expect(400);
    expect(JSON.stringify(response.body)).toMatch(/connection URL/);
  });
});
