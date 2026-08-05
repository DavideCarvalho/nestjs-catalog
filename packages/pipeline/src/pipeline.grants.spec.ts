import {
  CATALOG_PIPELINE_STORE,
  CATALOG_STORE,
  type CatalogConnection,
  type CatalogConnector,
  type CatalogObjectTypeDef,
  type CatalogPipelineStore,
  type CatalogPrincipal,
  type CatalogReadResult,
  type CatalogStoreCapabilities,
  type CatalogTransform,
  type CatalogWorkflow,
  type CatalogWriteStore,
  type ConnectorRun,
  type SnapshotRef,
  type WorkflowNode,
} from '@dudousxd/nestjs-catalog';
import { type CanActivate, type ExecutionContext, Injectable, Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REDACTED_SECRET } from './config-secrets';
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
 * The defect, driven the way it would actually have been exploited.
 *
 * These go over HTTP through the real controller rather than calling a helper,
 * because the bug was never in a predicate — `mayWrite` was correct all along.
 * It was that no route on this surface ever called one: every handler read
 * `request.principal` for `?.id ?? 'console'` and used it as a *name to write in
 * a log*. A unit test of the predicate passes on the unfixed code. Only asking
 * the route can tell.
 *
 * The scenario throughout is the one from `catalog.principal.ts`: a principal
 * holding `catalog:write` and `writeTypes: ["Mvr"]`, and a graph whose sink
 * commits `Subwo` — somebody else's type.
 */

const MVR_ONLY: CatalogPrincipal = {
  id: 'app-a',
  scopes: ['catalog:write', 'catalog:read'],
  writeTypes: ['Mvr'],
};

const BOTH: CatalogPrincipal = {
  id: 'app-b',
  scopes: ['catalog:write', 'catalog:read'],
  writeTypes: ['Mvr', 'Subwo'],
};

/** Whoever the request said it was. Stands in for the host's real guard. */
@Injectable()
class HeaderPrincipalGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request: { headers?: Record<string, unknown>; principal?: CatalogPrincipal } = context
      .switchToHttp()
      .getRequest();
    const who = request.headers?.['x-principal'];
    if (who === 'mvr-only') request.principal = MVR_ONLY;
    if (who === 'both') request.principal = BOTH;
    return true;
  }
}

function sink(id: string, targetType: string): WorkflowNode {
  return { id, name: id, kind: 'sink', targetType };
}

function source(id: string): WorkflowNode {
  return { id, name: id, kind: 'source', sourceKind: 'inline', config: { records: [] } };
}

/**
 * Enough of a store to answer the routes under test, holding its rows in
 * memory.
 *
 * Writes are recorded rather than discarded, because half of what these tests
 * assert is that a refused call wrote **nothing** — a 403 that still stored the
 * workflow would be worse than no check at all.
 */
class MemoryPipelineStore implements CatalogPipelineStore {
  readonly connectors = new Map<string, CatalogConnector>();
  readonly connections = new Map<string, CatalogConnection>();
  readonly workflows = new Map<string, CatalogWorkflow>();
  runs: ConnectorRun[] = [];

  listConnectors(): Promise<CatalogConnector[]> {
    return Promise.resolve([...this.connectors.values()]);
  }
  getConnector(id: string): Promise<CatalogConnector | undefined> {
    return Promise.resolve(this.connectors.get(id));
  }
  saveConnector(
    input: Omit<CatalogConnector, 'id' | 'createdAt' | 'updatedAt' | 'createdBy'> & { id?: string },
    createdBy: string,
  ): Promise<CatalogConnector> {
    const id = input.id ?? 'generated';
    const saved: CatalogConnector = {
      ...input,
      id,
      config: input.config ?? {},
      state: input.state ?? {},
      mode: input.mode ?? 'full',
      enabled: input.enabled ?? true,
      createdBy,
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
    };
    this.connectors.set(id, saved);
    return Promise.resolve(saved);
  }
  deleteConnector(): Promise<boolean> {
    return Promise.resolve(false);
  }
  saveConnectorState(): Promise<void> {
    return Promise.resolve();
  }
  listConnections(): Promise<CatalogConnection[]> {
    return Promise.resolve([...this.connections.values()]);
  }
  getConnection(id: string): Promise<CatalogConnection | undefined> {
    return Promise.resolve(this.connections.get(id));
  }
  saveConnection(
    input: Omit<CatalogConnection, 'id' | 'createdAt' | 'updatedAt' | 'createdBy'> & {
      id?: string;
    },
    createdBy: string,
  ): Promise<CatalogConnection> {
    const id = input.id ?? 'generated';
    const saved: CatalogConnection = {
      ...input,
      id,
      config: input.config ?? {},
      createdBy,
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
    };
    this.connections.set(id, saved);
    return Promise.resolve(saved);
  }
  deleteConnection(): Promise<boolean> {
    return Promise.resolve(false);
  }
  recordConnectionCheck(): Promise<void> {
    return Promise.resolve();
  }
  connectorsUsingConnection(id: string): Promise<CatalogConnector[]> {
    return Promise.resolve(
      [...this.connectors.values()].filter((connector) => connector.connectionId === id),
    );
  }
  listTransforms(): Promise<CatalogTransform[]> {
    return Promise.resolve([]);
  }
  getTransform(): Promise<CatalogTransform | undefined> {
    return Promise.resolve(undefined);
  }
  saveTransform(): Promise<CatalogTransform> {
    throw new Error('Not exercised here.');
  }
  deleteTransform(): Promise<boolean> {
    return Promise.resolve(false);
  }
  listWorkflows(): Promise<CatalogWorkflow[]> {
    return Promise.resolve([...this.workflows.values()]);
  }
  getWorkflow(id: string): Promise<CatalogWorkflow | undefined> {
    return Promise.resolve(this.workflows.get(id));
  }
  saveWorkflow(
    input: Pick<CatalogWorkflow, 'name' | 'nodes' | 'edges'> & { id?: string },
    createdBy: string,
  ): Promise<CatalogWorkflow> {
    const first = input.nodes.find((node) => node.kind === 'sink');
    const saved: CatalogWorkflow = {
      ...input,
      id: input.id ?? 'generated',
      version: 1,
      graphHash: 'hash',
      targetType: first && first.kind === 'sink' ? first.targetType : '',
      createdBy,
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
    };
    this.workflows.set(saved.id, saved);
    return Promise.resolve(saved);
  }
  deleteWorkflow(): Promise<boolean> {
    return Promise.resolve(false);
  }
  connectorsUsingWorkflow(id: string): Promise<CatalogConnector[]> {
    return Promise.resolve(
      [...this.connectors.values()].filter((connector) => connector.workflowId === id),
    );
  }
  writeStage(): Promise<{ written: number }> {
    return Promise.resolve({ written: 0 });
  }
  readStage(): Promise<Array<Record<string, unknown>>> {
    return Promise.resolve([]);
  }
  dropStages(): Promise<number> {
    return Promise.resolve(0);
  }
  startRun(input: {
    connectorId: string;
    snapshotId: string;
    principalId: string;
  }): Promise<ConnectorRun> {
    const run: ConnectorRun = {
      id: `run-${this.runs.length + 1}`,
      connectorId: input.connectorId,
      snapshotId: input.snapshotId,
      principalId: input.principalId,
      status: 'running',
      fetched: 0,
      written: 0,
      logs: [],
      startedAt: '2020-01-01T00:00:00.000Z',
    };
    this.runs.push(run);
    return Promise.resolve(run);
  }
  finishRun(id: string, outcome: Partial<ConnectorRun>): Promise<ConnectorRun | undefined> {
    const run = this.runs.find((candidate) => candidate.id === id);
    if (!run) return Promise.resolve(undefined);
    Object.assign(run, outcome);
    return Promise.resolve(run);
  }
  listRuns(): Promise<ConnectorRun[]> {
    return Promise.resolve(this.runs);
  }
}

const SUBWO: CatalogObjectTypeDef = {
  name: 'Subwo',
  displayName: 'Subwo',
  pluralDisplayName: 'Subwos',
  tableName: 'catalog_subwo',
  group: 'Ungrouped',
  primaryKey: ['id'],
  enriched: false,
  properties: [],
  relations: [],
};

class FakeWriteStore implements CatalogWriteStore {
  readonly capabilities: CatalogStoreCapabilities = {
    snapshots: 'emulated',
    writable: true,
    timeTravel: false,
  };
  committed: string[] = [];
  read(): Promise<CatalogReadResult> {
    return Promise.resolve({ rows: [], total: 0 });
  }
  ensureType(): Promise<void> {
    return Promise.resolve();
  }
  write(): Promise<{ written: number }> {
    return Promise.resolve({ written: 0 });
  }
  commit(def: CatalogObjectTypeDef, snapshotId: string): Promise<SnapshotRef> {
    this.committed.push(def.name);
    // The real `SnapshotRef`, not an approximation of it. The old literal named
    // fields the type does not have and omitted the two it requires, which the
    // spec typecheck now catches — it compiled before only because nothing ever
    // checked these files.
    return Promise.resolve({
      id: snapshotId,
      createdAt: '2026-01-01T00:00:00.000Z',
      rowCount: 0,
      principalId: 'ingest',
    });
  }
  dropSnapshot(): Promise<void> {
    return Promise.resolve();
  }
}

const store = new MemoryPipelineStore();
const writeStore = new FakeWriteStore();

const registryStub: CatalogPipelineRegistry = {
  reload: () => Promise.resolve(),
  getType: (name: string): CatalogObjectTypeDef | undefined =>
    name === 'Subwo' ? SUBWO : undefined,
};

@Module({
  providers: [
    { provide: CATALOG_PIPELINE_STORE, useValue: store },
    { provide: CATALOG_STORE, useValue: writeStore },
  ],
  exports: [CATALOG_PIPELINE_STORE, CATALOG_STORE],
})
class FakeStoreModule {}

const BASE = '/catalog/pipeline';

describe('the pipeline surface enforces per-type write grants', () => {
  let app: INestApplication;

  beforeEach(async () => {
    store.connectors.clear();
    store.connections.clear();
    store.workflows.clear();
    store.runs = [];
    writeStore.committed = [];

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

  const post = (path: string, who: string) =>
    request(app.getHttpServer()).post(`${BASE}${path}`).set('x-principal', who);

  const subwoGraph = {
    name: 'Steal Subwo',
    nodes: [source('in'), sink('out', 'Subwo')],
    edges: [{ from: 'in', to: 'out' }],
  };

  describe('saving a workflow', () => {
    it('refuses a graph whose sink commits a type this principal may not write', async () => {
      await post('/workflows', 'mvr-only').send(subwoGraph).expect(403);
      // Nothing stored. A refusal that still wrote the graph would leave it for
      // a schedule to run later, with nobody left to ask.
      expect(store.workflows.size).toBe(0);
    });

    it('says which type it refused', async () => {
      const response = await post('/workflows', 'mvr-only').send(subwoGraph).expect(403);
      expect(JSON.stringify(response.body)).toContain('Subwo');
    });

    it('saves the same graph for a principal granted that type', async () => {
      await post('/workflows', 'both').send(subwoGraph).expect(201);
      expect(store.workflows.size).toBe(1);
    });

    it('still refuses when only the second of two sinks is out of reach', async () => {
      // `WorkflowRow.targetType` records the first sink only, so a check that
      // read the row's field would have cleared this graph on its `Mvr` sink.
      await post('/workflows', 'mvr-only')
        .send({
          name: 'Two sinks',
          nodes: [source('in'), sink('a', 'Mvr'), sink('b', 'Subwo')],
          edges: [
            { from: 'in', to: 'a' },
            { from: 'in', to: 'b' },
          ],
        })
        .expect(403);
      expect(store.workflows.size).toBe(0);
    });
  });

  describe('saving a connector', () => {
    const connector = {
      name: 'Nightly',
      kind: 'inline',
      targetType: 'Subwo',
      config: { records: [] },
    };

    it('refuses one that publishes a type this principal may not write', async () => {
      await post('/connectors', 'mvr-only').send(connector).expect(403);
      expect(store.connectors.size).toBe(0);
    });

    it('accepts it from a principal that may', async () => {
      await post('/connectors', 'both').send(connector).expect(201);
      expect(store.connectors.size).toBe(1);
    });

    it('refuses one attached to a graph that commits out of reach', async () => {
      // The connector's own `targetType` is fine. What it would actually cause
      // to be committed is the graph's sinks, which are not.
      await post('/workflows', 'both')
        .send({ ...subwoGraph, id: 'wf-1' })
        .expect(201);

      await post('/connectors', 'mvr-only')
        .send({ name: 'Attached', kind: 'inline', targetType: 'Mvr', workflowId: 'wf-1' })
        .expect(403);
      expect(store.connectors.size).toBe(0);
    });
  });

  describe('running', () => {
    it('refuses a workflow run by a principal weaker than the one who saved it', async () => {
      // The case save time cannot see, and the reason the check is in both
      // places: the graph is legitimate, the run is not.
      await post('/workflows', 'both')
        .send({ ...subwoGraph, id: 'wf-1' })
        .expect(201);

      await post('/workflows/wf-1/run', 'mvr-only').send({}).expect(403);
      expect(writeStore.committed).toEqual([]);
    });

    it('refuses a connector run for a type out of reach', async () => {
      await post('/connectors', 'both')
        .send({ id: 'c1', name: 'Nightly', kind: 'inline', targetType: 'Subwo', config: {} })
        .expect(201);

      await post('/connectors/c1/run', 'mvr-only').send({}).expect(403);
      // `commitAsSystem` checks nothing by design, so reaching it at all is the
      // whole breach.
      expect(writeStore.committed).toEqual([]);
    });

    it('runs and commits for the principal that holds the grant', async () => {
      await post('/connectors', 'both')
        .send({ id: 'c1', name: 'Nightly', kind: 'inline', targetType: 'Subwo', config: {} })
        .expect(201);

      await post('/connectors/c1/run', 'both').send({}).expect(201);
      expect(writeStore.committed).toEqual(['Subwo']);
    });

    it('attributes the run to the principal, not to a hardcoded name', async () => {
      await post('/connectors', 'both')
        .send({ id: 'c1', name: 'Nightly', kind: 'inline', targetType: 'Subwo', config: {} })
        .expect(201);
      await post('/connectors/c1/run', 'both').send({}).expect(201);

      expect(store.runs[0]?.principalId).toBe('app-b');
    });
  });

  describe('when no guard put a principal on the request', () => {
    // These routes used to fall back to `'console'`, which meant an
    // unauthenticated caller was handed a name and no grants to check it
    // against. Failing loudly is the only safe reading.
    it('refuses to write rather than inventing an identity', async () => {
      await post('/workflows', 'nobody').send(subwoGraph).expect(500);
      expect(store.workflows.size).toBe(0);
    });
  });
});

describe('connector and connection configuration is not served in the clear', () => {
  let app: INestApplication;

  beforeEach(async () => {
    store.connectors.clear();
    store.connections.clear();
    store.workflows.clear();

    const moduleRef = await Test.createTestingModule({
      imports: [
        CatalogPipelineModule.forRoot({
          path: 'catalog',
          guards: [HeaderPrincipalGuard],
          imports: [FakeStoreModule],
          em: {
            provide: CATALOG_PIPELINE_EM,
            useValue: () => {
              throw new Error('No EntityManager here.');
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

  const URL_WITH_PASSWORD = 'postgres://ana:s3cr3t@db.internal:5432/app';

  async function seedConnection() {
    await store.saveConnection(
      { id: 'conn-1', name: 'Warehouse', kind: 'sql', config: { url: URL_WITH_PASSWORD } },
      'app-b',
    );
  }

  it('redacts the password out of GET /connections', async () => {
    await seedConnection();
    const response = await request(app.getHttpServer())
      .get(`${BASE}/connections`)
      .set('x-principal', 'mvr-only')
      .expect(200);

    expect(JSON.stringify(response.body)).not.toContain('s3cr3t');
    expect(response.body[0].config.url).toContain(REDACTED_SECRET);
  });

  it('redacts it out of GET /connectors too', async () => {
    await store.saveConnector(
      {
        id: 'c1',
        name: 'Nightly',
        kind: 'sql',
        enabled: true,
        targetType: 'Subwo',
        config: { url: URL_WITH_PASSWORD },
      },
      'app-b',
    );
    const response = await request(app.getHttpServer())
      .get(`${BASE}/connectors`)
      .set('x-principal', 'mvr-only')
      .expect(200);

    expect(JSON.stringify(response.body)).not.toContain('s3cr3t');
  });

  it('redacts it out of the connectors listed against a connection', async () => {
    await seedConnection();
    await store.saveConnector(
      {
        id: 'c1',
        name: 'Nightly',
        kind: 'sql',
        enabled: true,
        targetType: 'Subwo',
        connectionId: 'conn-1',
        config: { url: URL_WITH_PASSWORD },
      },
      'app-b',
    );
    const response = await request(app.getHttpServer())
      .get(`${BASE}/connections/conn-1/connectors`)
      .set('x-principal', 'mvr-only')
      .expect(200);

    expect(JSON.stringify(response.body)).not.toContain('s3cr3t');
  });

  it('leaves the store telling the truth, so the runner can still connect', async () => {
    await seedConnection();
    await request(app.getHttpServer())
      .get(`${BASE}/connections`)
      .set('x-principal', 'mvr-only')
      .expect(200);

    // Redacting inside the store would have handed the runner a URL that cannot
    // connect — and would have promoted the placeholder into the next
    // environment as though it were the password.
    const stored = await store.getConnection('conn-1');
    expect(stored?.config.url).toBe(URL_WITH_PASSWORD);
  });

  it('does not write the placeholder back when a console round-trips the object', async () => {
    await seedConnection();
    const listed = await request(app.getHttpServer())
      .get(`${BASE}/connections`)
      .set('x-principal', 'both')
      .expect(200);

    // Exactly what a console does: take what it was shown, change one field,
    // post the whole thing back.
    await request(app.getHttpServer())
      .post(`${BASE}/connections`)
      .set('x-principal', 'both')
      .send({ ...listed.body[0], name: 'Warehouse (EU)' })
      .expect(201);

    const stored = await store.getConnection('conn-1');
    expect(stored?.name).toBe('Warehouse (EU)');
    expect(stored?.config.url).toBe(URL_WITH_PASSWORD);
  });

  // The same round trip on the other half of the surface. A connector may carry
  // its own `config.url`, which `applyConnection` lets override the
  // connection's, so the corruption is available on this path too.
  it('does not write the placeholder back when a console round-trips a connector', async () => {
    await store.saveConnector(
      {
        id: 'c1',
        name: 'Nightly',
        kind: 'sql',
        enabled: true,
        targetType: 'Subwo',
        config: { url: URL_WITH_PASSWORD, query: 'SELECT 1' },
      },
      'app-b',
    );
    const listed = await request(app.getHttpServer())
      .get(`${BASE}/connectors`)
      .set('x-principal', 'both')
      .expect(200);

    await request(app.getHttpServer())
      .post(`${BASE}/connectors`)
      .set('x-principal', 'both')
      .send({ ...listed.body[0], name: 'Nightly (EU)' })
      .expect(201);

    const stored = await store.getConnector('c1');
    expect(stored?.name).toBe('Nightly (EU)');
    expect(stored?.config.url).toBe(URL_WITH_PASSWORD);
  });
});
