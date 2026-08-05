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
  type WorkflowSourceNode,
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
 * A workflow's source nodes hold connector credentials, and `GET workflows`
 * served them.
 *
 * `redactConnector` and `redactConnection` were applied at four call sites and
 * this was the fifth that needed them. A `WorkflowSourceNode` "carries the same
 * vocabulary a connector does" by its own docblock — including `config.url`,
 * which for a SQL source *is* the password — so a graph with an inline source
 * was a connection row that nobody had thought to redact, readable by anyone
 * holding `catalog:read`.
 *
 * The case this file is really about is the **round trip**, and it is the one
 * that makes a redaction dangerous rather than merely absent: a console reads a
 * graph, drags a box, and posts the whole thing back. Whatever it was shown for
 * the URL is what it sends. Get that wrong and the fix writes the word REDACTED
 * into the database as the password — which is worse than the leak, because the
 * leak at least left the pipeline working.
 */

const SECRET_URL = 'postgres://svc:s3cr3t@db.internal:5432/warehouse';
const REDACTED_URL = 'postgres://svc:REDACTED@db.internal:5432/warehouse';

const PRINCIPAL: CatalogPrincipal = {
  id: 'console#ana@example.com',
  applicationId: 'console',
  actor: { id: 'ana@example.com' },
  scopes: ['catalog:read', 'catalog:write'],
  writeTypes: ['Mvr'],
};

/**
 * A plain reader: `catalog:read` and not one write grant.
 *
 * The audience the finding is about. This principal cannot save a workflow,
 * cannot run one, and could still read every password in every graph.
 */
const READER: CatalogPrincipal = {
  id: 'viewer',
  scopes: ['catalog:read'],
};

const PRINCIPALS: Record<string, CatalogPrincipal> = {
  ana: PRINCIPAL,
  reader: READER,
};

@Injectable()
class HeaderPrincipalGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request: { headers?: Record<string, unknown>; principal?: CatalogPrincipal } = context
      .switchToHttp()
      .getRequest();
    const who = request.headers?.['x-principal'];
    if (typeof who === 'string' && PRINCIPALS[who]) request.principal = PRINCIPALS[who];
    return true;
  }
}

function sourceNode(overrides: Partial<WorkflowSourceNode> = {}): WorkflowSourceNode {
  return {
    id: 'src',
    name: 'The warehouse',
    kind: 'source',
    sourceKind: 'sql',
    config: { url: SECRET_URL, query: 'select * from mvr' },
    position: { x: 12, y: 34 },
    ...overrides,
  };
}

function sinkNode(id = 'out', targetType = 'Mvr'): WorkflowNode {
  return { id, name: id, kind: 'sink', targetType };
}

/**
 * Holds what it is given and hands back exactly that.
 *
 * The assertions here are about what the *store* ends up holding, so a fake that
 * normalised or defaulted anything would be answering the question under test.
 */
class MemoryPipelineStore implements CatalogPipelineStore {
  readonly workflows = new Map<string, CatalogWorkflow>();

  seed(workflow: Pick<CatalogWorkflow, 'id' | 'name' | 'nodes' | 'edges'>): void {
    this.workflows.set(workflow.id, {
      ...workflow,
      version: 1,
      graphHash: 'hash',
      targetType: 'Mvr',
      createdBy: 'ana@example.com',
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
    });
  }

  /** The source node as it is actually stored, which is what a leak is about. */
  storedConfig(workflowId: string, nodeId: string): Record<string, unknown> | undefined {
    const node = this.workflows.get(workflowId)?.nodes.find((n) => n.id === nodeId);
    return node?.kind === 'source' ? node.config : undefined;
  }

  listWorkflows(): Promise<CatalogWorkflow[]> {
    return Promise.resolve([...this.workflows.values()]);
  }
  getWorkflow(id: string): Promise<CatalogWorkflow | undefined> {
    return Promise.resolve(this.workflows.get(id));
  }
  /**
   * Asked for by name by `supportsWorkflows`, so a stub without it stops being
   * a workflow store — which is how this spec began failing when drafts landed,
   * rather than through anything it asserts.
   */
  publishWorkflow(id: string): Promise<CatalogWorkflow | undefined> {
    return Promise.resolve(this.workflows.get(id));
  }
  saveWorkflow(
    input: Pick<CatalogWorkflow, 'name' | 'nodes' | 'edges'> & { id?: string },
    createdBy: string,
  ): Promise<CatalogWorkflow> {
    const id = input.id ?? 'generated';
    const saved: CatalogWorkflow = {
      ...input,
      id,
      version: 2,
      graphHash: 'hash',
      targetType: 'Mvr',
      createdBy,
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-02T00:00:00.000Z',
    };
    this.workflows.set(id, saved);
    return Promise.resolve(saved);
  }
  deleteWorkflow(): Promise<boolean> {
    return Promise.resolve(false);
  }
  connectorsUsingWorkflow(): Promise<CatalogConnector[]> {
    return Promise.resolve([]);
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

  private unused(method: string): never {
    throw new Error(`MemoryPipelineStore.${method} is not exercised here.`);
  }
  readonly connectors = new Map<string, CatalogConnector>();
  readonly connections = new Map<string, CatalogConnection>();

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
    const saved: CatalogConnector = {
      ...input,
      id: input.id ?? 'generated',
      config: input.config ?? {},
      state: input.state ?? {},
      mode: input.mode ?? 'full',
      enabled: input.enabled ?? true,
      createdBy,
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
    };
    this.connectors.set(saved.id, saved);
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
    const saved: CatalogConnection = {
      ...input,
      id: input.id ?? 'generated',
      config: input.config ?? {},
      createdBy,
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
    };
    this.connections.set(saved.id, saved);
    return Promise.resolve(saved);
  }
  deleteConnection(): Promise<boolean> {
    return Promise.resolve(false);
  }
  recordConnectionCheck(): Promise<void> {
    return Promise.resolve();
  }
  connectorsUsingConnection(): Promise<CatalogConnector[]> {
    return Promise.resolve([]);
  }
  listTransforms(): Promise<CatalogTransform[]> {
    return Promise.resolve([]);
  }
  getTransform(): Promise<CatalogTransform | undefined> {
    return Promise.resolve(undefined);
  }
  saveTransform(): Promise<CatalogTransform> {
    return this.unused('saveTransform');
  }
  deleteTransform(): Promise<boolean> {
    return Promise.resolve(false);
  }
  startRun(): Promise<ConnectorRun> {
    return this.unused('startRun');
  }
  finishRun(): Promise<ConnectorRun | undefined> {
    return Promise.resolve(undefined);
  }
  listRuns(): Promise<ConnectorRun[]> {
    return Promise.resolve([]);
  }
}

class UnusedWriteStore implements CatalogWriteStore {
  readonly capabilities: CatalogStoreCapabilities = {
    snapshots: 'emulated',
    writable: true,
    timeTravel: false,
  };
  read(): Promise<CatalogReadResult> {
    return Promise.resolve({ rows: [], total: 0 });
  }
  ensureType(): Promise<void> {
    return Promise.resolve();
  }
  write(): Promise<{ written: number }> {
    throw new Error('Nothing here writes.');
  }
  commit(): Promise<SnapshotRef> {
    throw new Error('Nothing here commits.');
  }
  dropSnapshot(): Promise<void> {
    return Promise.resolve();
  }
}

const store = new MemoryPipelineStore();

const registryStub: CatalogPipelineRegistry = {
  reload: () => Promise.resolve(),
  getType: (): CatalogObjectTypeDef | undefined => undefined,
};

@Module({
  providers: [
    { provide: CATALOG_PIPELINE_STORE, useValue: store },
    { provide: CATALOG_STORE, useClass: UnusedWriteStore },
  ],
  exports: [CATALOG_PIPELINE_STORE, CATALOG_STORE],
})
class FakeStoreModule {}

const BASE = '/catalog/pipeline';

describe('a workflow does not serve its source credentials', () => {
  let app: INestApplication;

  beforeEach(async () => {
    store.workflows.clear();
    store.seed({
      id: 'wf-1',
      name: 'Nightly MVR',
      nodes: [sourceNode(), sinkNode()],
      edges: [{ from: 'src', to: 'out' }],
    });

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

  const list = (who = 'ana') =>
    request(app.getHttpServer()).get(`${BASE}/workflows`).set('x-principal', who);
  const save = (body: object, who = 'ana') =>
    request(app.getHttpServer()).post(`${BASE}/workflows`).set('x-principal', who).send(body);

  describe('reading', () => {
    it('does not serve the password in a source node config', async () => {
      const response = await list().expect(200);
      const serialised = JSON.stringify(response.body);
      expect(serialised).not.toContain('s3cr3t');
      expect(serialised).toContain(REDACTED_SECRET);
    });

    it('hides it from a plain reader, who is the audience that matters', async () => {
      // `catalog:read` and no grant: cannot save a graph, cannot run one, and
      // could read every credential in every one of them.
      const response = await list('reader').expect(200);
      expect(JSON.stringify(response.body)).not.toContain('s3cr3t');
    });

    it('keeps the address, so the screen still shows which database it is', async () => {
      // Redaction, not removal. A source whose config vanished would be a source
      // the canvas draws as unconfigured.
      const [workflow] = (await list().expect(200)).body;
      expect(workflow.nodes[0].config.url).toBe(REDACTED_URL);
    });

    it('leaves everything else about the node exactly as stored', async () => {
      // The property the old comment was right to insist on: a view that
      // flattened or renamed fields is what this route was recovering from, and
      // redacting must not reintroduce it.
      const [workflow] = (await list().expect(200)).body;
      expect(workflow.nodes[0]).toMatchObject({
        id: 'src',
        name: 'The warehouse',
        kind: 'source',
        sourceKind: 'sql',
        position: { x: 12, y: 34 },
      });
      expect(workflow.nodes[0].config.query).toBe('select * from mvr');
      expect(workflow.nodes[1]).toEqual({
        id: 'out',
        name: 'out',
        kind: 'sink',
        targetType: 'Mvr',
      });
      expect(workflow.edges).toEqual([{ from: 'src', to: 'out' }]);
      expect(workflow.version).toBe(1);
    });

    it('leaves a URL that carries no password alone', async () => {
      store.workflows.clear();
      store.seed({
        id: 'wf-2',
        name: 'Public',
        nodes: [sourceNode({ config: { url: 'https://api.example.com/v1/things' } }), sinkNode()],
        edges: [],
      });
      const [workflow] = (await list().expect(200)).body;
      expect(workflow.nodes[0].config.url).toBe('https://api.example.com/v1/things');
    });

    it('does not reach inside a nested config, and that boundary is deliberate', async () => {
      // The limit `config-secrets.ts` states out loud: top-level strings only.
      // Asserted rather than left implicit so that the day somebody makes the
      // redaction recursive, the round-trip restore is a named thing they have
      // to fix at the same time rather than a silent corruption.
      store.workflows.clear();
      store.seed({
        id: 'wf-3',
        name: 'Headers',
        nodes: [
          sourceNode({
            sourceKind: 'http',
            config: { url: 'https://api.example.com', headers: { authorization: 'Bearer nested' } },
          }),
          sinkNode(),
        ],
        edges: [],
      });
      const [workflow] = (await list().expect(200)).body;
      expect(workflow.nodes[0].config.headers.authorization).toBe('Bearer nested');
    });
  });

  describe('the round trip', () => {
    it('still holds the real credential after the graph is read and posted back', async () => {
      // THE test. A console reads a workflow and posts it back unchanged, which
      // is what every save from the canvas is. Without the restore this writes
      // the placeholder in as the password and the pipeline stops working — the
      // classic way a redaction corrupts what it was protecting.
      const [asShown] = (await list().expect(200)).body;
      expect(JSON.stringify(asShown)).not.toContain('s3cr3t');

      await save(asShown).expect(201);

      expect(store.storedConfig('wf-1', 'src')?.url).toBe(SECRET_URL);
    });

    it('survives the edit a person actually made on the way through', async () => {
      // A rename and a drag, which is what the canvas posts. Neither touches the
      // URL, and both are what a naive index- or name-based match would break.
      const [asShown] = (await list().expect(200)).body;
      const edited = {
        ...asShown,
        name: 'Nightly MVR (EU)',
        nodes: [
          { ...asShown.nodes[0], name: 'The EU warehouse', position: { x: 99, y: 5 } },
          asShown.nodes[1],
        ],
      };

      await save(edited).expect(201);

      expect(store.storedConfig('wf-1', 'src')?.url).toBe(SECRET_URL);
      expect(store.workflows.get('wf-1')?.name).toBe('Nightly MVR (EU)');
    });

    it('matches nodes by id, not by their place in the array', async () => {
      // A canvas re-orders freely, and position in the array is not identity.
      const [asShown] = (await list().expect(200)).body;
      await save({ ...asShown, nodes: [asShown.nodes[1], asShown.nodes[0]] }).expect(201);
      expect(store.storedConfig('wf-1', 'src')?.url).toBe(SECRET_URL);
    });

    it('does not answer the save with the credential it just restored', async () => {
      // Otherwise the redaction on the read is undone in one request: post back
      // what you were shown, read the response.
      const [asShown] = (await list().expect(200)).body;
      const response = await save(asShown).expect(201);
      expect(JSON.stringify(response.body)).not.toContain('s3cr3t');
    });

    it('writes a genuine change to the URL through rather than restoring it', async () => {
      // The restore keys on equality with `redact(stored)`. Anything else is a
      // real edit and has to reach the store, which is what decides whether a
      // fresh plaintext password may be written down.
      const [asShown] = (await list().expect(200)).body;
      const moved = {
        ...asShown,
        nodes: [
          {
            ...asShown.nodes[0],
            config: { ...asShown.nodes[0].config, url: 'postgres://svc:other@elsewhere:5432/w' },
          },
          asShown.nodes[1],
        ],
      };

      await save(moved).expect(201);

      expect(store.storedConfig('wf-1', 'src')?.url).toBe('postgres://svc:other@elsewhere:5432/w');
    });

    it('passes a brand new node through untouched, placeholder and all', async () => {
      // Nothing stored for that id, so there is no placeholder it could be
      // standing for. What arrived is what was meant, and the store's own
      // refusal is what judges it.
      const [asShown] = (await list().expect(200)).body;
      const added = {
        ...asShown,
        nodes: [
          ...asShown.nodes,
          {
            id: 'src2',
            name: 'Second',
            kind: 'source',
            sourceKind: 'sql',
            config: { url: 'postgres://new:fresh@other:5432/db' },
          },
        ],
      };

      await save(added).expect(201);

      expect(store.storedConfig('wf-1', 'src2')?.url).toBe('postgres://new:fresh@other:5432/db');
      expect(store.storedConfig('wf-1', 'src')?.url).toBe(SECRET_URL);
    });

    it('does not restore into a node whose id now belongs to something else', async () => {
      // An id reused for a different kind of node has no config on the other
      // side to have shown anybody.
      const [asShown] = (await list().expect(200)).body;
      await save({
        ...asShown,
        nodes: [{ id: 'src', name: 'src', kind: 'sink', targetType: 'Mvr' }, asShown.nodes[1]],
      }).expect(201);
      expect(store.storedConfig('wf-1', 'src')).toBeUndefined();
    });
  });

  /**
   * A save answers with the row it just wrote, and that row holds what
   * `restoreRedactedSecrets` put back.
   *
   * So an unredacted save response is the redaction on the read undone in one
   * request: post back the object you were shown, and read the credential out of
   * the reply. It applies to all three pairs, and the two connector ones were
   * already there before workflows had the problem at all — the redaction went
   * on the `GET` and stopped.
   */
  describe('a save answers with a redaction, because a save response is a read', () => {
    it('does not return the connection credential it just restored', async () => {
      store.connections.set('c1', {
        id: 'c1',
        name: 'Warehouse',
        kind: 'sql',
        config: { url: SECRET_URL },
        createdBy: 'ana@example.com',
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z',
      });

      const shown = (
        await request(app.getHttpServer())
          .get(`${BASE}/connections`)
          .set('x-principal', 'ana')
          .expect(200)
      ).body[0];
      expect(JSON.stringify(shown)).not.toContain('s3cr3t');

      const response = await request(app.getHttpServer())
        .post(`${BASE}/connections`)
        .set('x-principal', 'ana')
        .send({ ...shown, name: 'Warehouse (renamed)' })
        .expect(201);

      expect(JSON.stringify(response.body)).not.toContain('s3cr3t');
      // And the store still holds the real one, which is the round trip.
      expect(store.connections.get('c1')?.config.url).toBe(SECRET_URL);
    });

    it('does not return the connector credential it just restored', async () => {
      store.connectors.set('k1', {
        id: 'k1',
        name: 'Nightly',
        kind: 'sql',
        targetType: 'Mvr',
        config: { url: SECRET_URL },
        state: {},
        mode: 'full',
        enabled: true,
        createdBy: 'ana@example.com',
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z',
      });

      const shown = (
        await request(app.getHttpServer())
          .get(`${BASE}/connectors`)
          .set('x-principal', 'ana')
          .expect(200)
      ).body[0];
      expect(JSON.stringify(shown)).not.toContain('s3cr3t');

      const response = await request(app.getHttpServer())
        .post(`${BASE}/connectors`)
        .set('x-principal', 'ana')
        .send({ ...shown, name: 'Nightly (renamed)' })
        .expect(201);

      expect(JSON.stringify(response.body)).not.toContain('s3cr3t');
      expect(store.connectors.get('k1')?.config.url).toBe(SECRET_URL);
    });
  });
});
