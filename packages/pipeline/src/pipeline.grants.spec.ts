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

function source(id: string, records: unknown[] = []): WorkflowNode {
  return { id, name: id, kind: 'source', sourceKind: 'inline', config: { records } };
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
      // Enabled, as a freshly saved graph is. `enabled` is half the test the
      // scheduler applies now that a schedule lives on the workflow, so a
      // double defaulting it false would model a store that quietly refuses to
      // run anything.
      enabled: true,
      // Drafted, as the real store drafts it. These tests are about write
      // grants, and every one of them asserts against the save itself, so the
      // status only has to be the one a save actually produces.
      status: 'draft',
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
  publishWorkflow(id: string): Promise<CatalogWorkflow> {
    const stored = this.workflows.get(id);
    if (!stored) throw new Error(`No workflow ${id} to publish.`);
    const published: CatalogWorkflow = { ...stored, status: 'ready' };
    this.workflows.set(id, published);
    return Promise.resolve(published);
  }
  unpublishWorkflow(id: string): Promise<CatalogWorkflow> {
    const stored = this.workflows.get(id);
    if (!stored) throw new Error(`No workflow ${id} to unpublish.`);
    const drafted: CatalogWorkflow = { ...stored, status: 'draft' };
    this.workflows.set(id, drafted);
    return Promise.resolve(drafted);
  }
  deleteWorkflow(): Promise<boolean> {
    return Promise.resolve(false);
  }
  // Present because `supportsWorkflows` asks for it by name now: a schedule
  // authored on a graph is worthless if the store cannot hold one, so a double
  // that omitted it would make this whole fake read as "cannot hold workflows".
  saveWorkflowSchedule(
    id: string,
    input: { schedule?: string; enabled?: boolean },
  ): Promise<CatalogWorkflow> {
    const stored = this.workflows.get(id);
    if (!stored) throw new Error(`No workflow ${id} to schedule.`);
    const saved: CatalogWorkflow = {
      ...stored,
      schedule: input.schedule ?? stored.schedule,
      enabled: input.enabled ?? stored.enabled,
    };
    this.workflows.set(id, saved);
    return Promise.resolve(saved);
  }
  connectorsUsingWorkflow(id: string): Promise<CatalogConnector[]> {
    return Promise.resolve(
      [...this.connectors.values()].filter((connector) => connector.workflowId === id),
    );
  }
  /**
   * Real staging, keyed the way the store's is: `(runId, nodeId, batch)`.
   *
   * It used to answer `{ written: 0 }` and `[]`, which was enough while the only
   * runs these tests made were refusals. It is not enough now that the positive
   * case runs a graph end to end: a stage store that swallows rows makes every
   * sink report "nothing reached the sink", so a test asserting a commit would
   * fail for a reason that has nothing to do with the grant it is about.
   */
  readonly stages = new Map<string, Array<Record<string, unknown>>>();
  writeStage(input: {
    runId: string;
    nodeId: string;
    batch: number;
    rows: Array<Record<string, unknown>>;
  }): Promise<{ written: number }> {
    this.stages.set(`${input.runId}:${input.nodeId}:${input.batch}`, input.rows);
    return Promise.resolve({ written: input.rows.length });
  }
  readStage(ref: {
    runId: string;
    nodeId: string;
    batch: number;
  }): Promise<Array<Record<string, unknown>>> {
    return Promise.resolve(this.stages.get(`${ref.runId}:${ref.nodeId}:${ref.batch}`) ?? []);
  }
  dropStages(runId: string): Promise<number> {
    let dropped = 0;
    for (const key of [...this.stages.keys()]) {
      if (key.startsWith(`${runId}:`)) {
        this.stages.delete(key);
        dropped += 1;
      }
    }
    return Promise.resolve(dropped);
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
  /**
   * Reports what it was handed, rather than a flat zero.
   *
   * Zero was harmless while every run in this file was a refusal. It is not
   * harmless now: a workflow's sink refuses to commit when **nothing** reached
   * it — a full load that produced no rows would otherwise repoint the live view
   * at an empty snapshot — so a write store that always answers zero makes every
   * successful graph look like an empty one, and a commit test would fail for a
   * reason unrelated to the grant it is about.
   *
   * Worth noting that this is a real difference between the two run paths, not a
   * fixture artefact: the single-transform connector runner writes an empty
   * batch for a full load and commits it, while the workflow sink refuses. Only
   * the second is reachable now.
   */
  /** Every label every batch carried, so a test can see what the snapshot got. */
  labels: Array<Record<string, string> | undefined> = [];
  write(
    _def: CatalogObjectTypeDef,
    rows: unknown[],
    options?: { labels?: Record<string, string> },
  ): Promise<{ written: number }> {
    this.labels.push(options?.labels);
    return Promise.resolve({ written: rows.length });
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
    // Reset alongside `committed`, or an assertion on the first write reads a
    // label left by whichever test happened to run before this one.
    writeStore.labels = [];

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

  describe('authoring a connector', () => {
    /**
     * There is no longer a route that does it, and that is what is asserted.
     *
     * These tests used to check that saving a connector required a grant on its
     * target type, and on the graph's sinks when it named one. Both checks are
     * still made — on `POST workflows`, above, which is now the only way a
     * pipeline comes into existence. What has to stay true is that no second way
     * reappears: a `POST connectors` that came back would be a way to cause a
     * load whose authorisation lives on a different object from the one that
     * decides what gets written.
     */
    it('has no route that creates one', async () => {
      await post('/connectors', 'both')
        .send({ name: 'Nightly', kind: 'inline', targetType: 'Subwo', config: { records: [] } })
        .expect(404);
      expect(store.connectors.size).toBe(0);
    });

    it('has no route that deletes one', async () => {
      await request(app.getHttpServer())
        .delete(`${BASE}/connectors/c1`)
        .set('x-principal', 'both')
        .expect(404);
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

    /**
     * The source carries a record, unlike the graphs the refusal tests use, and
     * it has to: a **full** load that produces nothing does not commit — the
     * sink refuses rather than repointing the live view at an empty snapshot.
     * A graph with an empty inline source would therefore pass this test's
     * authorisation and still commit nothing, which would make it green for the
     * wrong reason.
     */
    const loadingGraph = {
      name: 'Load Subwo',
      nodes: [source('in', [{ id: 1 }]), sink('out', 'Subwo')],
      edges: [{ from: 'in', to: 'out' }],
    };

    it('runs and commits for the principal that holds the grant', async () => {
      await post('/workflows', 'both')
        .send({ ...loadingGraph, id: 'wf-1' })
        .expect(201);

      await post('/workflows/wf-1/run', 'both').send({}).expect(201);
      expect(writeStore.committed).toEqual(['Subwo']);
    });

    it('attributes the run to the principal, not to a hardcoded name', async () => {
      await post('/workflows', 'both')
        .send({ ...loadingGraph, id: 'wf-1' })
        .expect(201);
      await post('/workflows/wf-1/run', 'both').send({}).expect(201);

      expect(store.runs[0]?.principalId).toBe('app-b');
    });

    /**
     * The acknowledgement has to reach the **snapshot's labels**, not merely the
     * launcher, because that is where the row-count bound reads it from.
     *
     * Asserted end to end for that reason: `EXPECT_SHRINK_LABEL` stands the
     * bound down for one snapshot, and a reason that stopped at any hop between
     * the route and the write would leave an operator unable to re-drive a
     * refused load at all — which pushes them to raise the bound in policy and
     * switch the guard off for every future load of the type.
     */
    it('carries the operator reason all the way onto the snapshot labels', async () => {
      await post('/workflows', 'both')
        .send({ ...loadingGraph, id: 'wf-1' })
        .expect(201);

      await post('/workflows/wf-1/run', 'both')
        .send({ expectShrink: 'the depot was decommissioned' })
        .expect(201);

      expect(writeStore.labels[0]).toMatchObject({
        _expectShrink: 'the depot was decommissioned',
      });
    });

    it('refuses an acknowledgement with no reason behind it', async () => {
      await post('/workflows', 'both')
        .send({ ...loadingGraph, id: 'wf-1' })
        .expect(201);

      // The reason is the whole value of the acknowledgement: it is the only
      // answer anybody has in six months to "why was this allowed to collapse?".
      const response = await post('/workflows/wf-1/run', 'both')
        .send({ expectShrink: '   ' })
        .expect(201);

      expect(response.body.status).toBe('failed');
      expect(JSON.stringify(response.body)).toMatch(/given no reason/);
      expect(writeStore.committed).toEqual([]);
    });

    /**
     * The run route the connector surface had is gone too.
     *
     * `commitAsSystem` checks nothing by design — it takes a principal id as
     * attribution rather than as an authorisation — so the route that reaches it
     * is the last place there are grants to consult. Leaving a second one
     * standing would leave one of the two unchecked the next time either is
     * edited.
     */
    it('has no connector run route beside it', async () => {
      await post('/connectors/c1/run', 'both').send({}).expect(404);
      expect(writeStore.committed).toEqual([]);
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

  /**
   * The route is `connections/:id/workflows` now, and it answers a different
   * question — which is why it cannot leak this at all rather than having to
   * redact it.
   *
   * "Which connectors read through this connection" was never the question an
   * operator was asking before deleting one; "what breaks" was, and what breaks
   * is a list of pipelines. Answering with workflow identity — id, name, status,
   * and which node reaches it — means no source config passes through the
   * handler, so the credential cannot be forgotten on the way out the way it was
   * on `GET connections` and `GET connectors` before `config-secrets.ts` existed.
   */
  it('names the workflows that read through a connection, and carries no config at all', async () => {
    await seedConnection();
    await store.saveWorkflow(
      {
        id: 'wf-1',
        name: 'Nightly',
        nodes: [
          {
            id: 'in',
            name: 'in',
            kind: 'source',
            sourceKind: 'sql',
            connectionId: 'conn-1',
            config: { url: URL_WITH_PASSWORD },
          },
          sink('out', 'Subwo'),
        ],
        edges: [{ from: 'in', to: 'out' }],
      },
      'app-b',
    );

    const response = await request(app.getHttpServer())
      .get(`${BASE}/connections/conn-1/workflows`)
      .set('x-principal', 'mvr-only')
      .expect(200);

    expect(JSON.stringify(response.body)).not.toContain('s3cr3t');
    expect(response.body).toEqual([
      { id: 'wf-1', name: 'Nightly', status: 'draft', through: '"in"' },
    ]);
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
  /**
   * The round trip this covered is gone with the route that made it possible.
   *
   * What it protected — that a console posting back the placeholder it was shown
   * does not overwrite the real credential — is still protected on the two
   * things a console can still post: a connection (`saveConnection`, through
   * `restoreRedactedSecrets`) and a workflow's source nodes
   * (`restoreWorkflowSecrets`, asserted at length in
   * `pipeline.workflow-secrets.spec.ts`). A connector is minted by publishing a
   * graph, from fields the caller never sends, so there is no request that could
   * write a placeholder into one.
   */
  it('has no connector write for a placeholder to round-trip through', async () => {
    await request(app.getHttpServer())
      .post(`${BASE}/connectors`)
      .set('x-principal', 'both')
      .send({ name: 'Nightly', kind: 'sql', targetType: 'Subwo', config: { url: 'REDACTED' } })
      .expect(404);
  });
});
