import {
  CATALOG_PIPELINE_STORE,
  CATALOG_STORE,
  type CatalogPrincipal,
  type CatalogWorkflow,
  type CatalogWorkflowRelease,
} from '@dudousxd/nestjs-catalog';
import type { INestApplication } from '@nestjs/common';
import { type CanActivate, type ExecutionContext, Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CatalogPipelineModule } from './pipeline.module';
import { CATALOG_PIPELINE_EM, CATALOG_PIPELINE_REGISTRY } from './seams';

/** See the note in `pipeline.module.integration.spec.ts`: the package cannot load here. */
vi.mock('@dudousxd/nestjs-durable', () => ({
  WorkflowEngine: class WorkflowEngine {},
  Step: () => (_target: unknown, _key: unknown, descriptor: unknown) => descriptor,
  Workflow: () => (target: unknown) => target,
}));

/**
 * The three routes that separate editing from deploying, over HTTP.
 *
 * ## Why an application rather than a call on the controller
 *
 * Because two of the things worth asserting are properties of the wire and not
 * of the method. A release archives the graph **as stored** — sealed source
 * configs and all — so the list route has to redact node by node, and a
 * controller test that read the return value would pass on a response that leaks
 * a password through the history after the read of the live graph goes to some
 * trouble not to. And `PUT .../live` refuses a body with no `version` key, which
 * is a distinction between "sent nothing" and "sent null" that only survives a
 * real JSON round trip.
 *
 * ## What is deliberately NOT asserted here
 *
 * That releasing changes what runs — it must not, and the scheduler spec is
 * where that lives, because the scheduler is what decides.
 */

/**
 * A principal with a grant on everything, because what is under test here is the
 * release surface and not the grant check. That check is real on all three
 * routes — a caller may not deploy a graph committing a type they could not
 * commit to themselves — and it is `write-grants.spec.ts` that owns it.
 */
const WRITER: CatalogPrincipal = {
  id: 'bruno',
  scopes: ['catalog:read', 'catalog:write'],
  writeTypes: ['*'],
};

@Injectable()
class AllowWriter implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    Object.assign(context.switchToHttp().getRequest(), { principal: WRITER });
    return true;
  }
}

const WHEN = '2020-01-01T00:00:00.000Z';

const HEAD: CatalogWorkflow = {
  id: 'w1',
  name: 'Nightly Subwo',
  nodes: [
    {
      id: 'in',
      name: 'in',
      kind: 'source',
      sourceKind: 'sql',
      config: { url: 'postgres://svc:hunter2@warehouse/db' },
    },
    { id: 'out', name: 'out', kind: 'sink', targetType: 'Subwo' },
  ],
  edges: [{ from: 'in', to: 'out' }],
  status: 'ready',
  version: 9,
  graphHash: 'hash-of-v9',
  targetType: 'Subwo',
  enabled: true,
  createdBy: 'ana',
  createdAt: WHEN,
  updatedAt: WHEN,
};

const RELEASE: CatalogWorkflowRelease = {
  id: 'w1:6',
  workflowId: 'w1',
  version: 6,
  graphHash: 'hash-of-v6',
  nodes: HEAD.nodes,
  edges: HEAD.edges,
  targetType: 'Subwo',
  notes: 'the fix for SUBWO',
  releasedBy: 'ana',
  releasedAt: WHEN,
};

function storeModule(store: Record<string, unknown>) {
  @Module({
    providers: [
      { provide: CATALOG_PIPELINE_STORE, useValue: store },
      { provide: CATALOG_STORE, useValue: {} },
    ],
    exports: [CATALOG_PIPELINE_STORE, CATALOG_STORE],
  })
  class FakeStoreModule {}
  return FakeStoreModule;
}

function holdsReleases() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const store = {
    listConnectors: () => Promise.resolve([]),
    listWorkflows: () => Promise.resolve([HEAD]),
    getWorkflow: () => Promise.resolve(HEAD),
    saveWorkflow: () => Promise.reject(new Error('unused')),
    publishWorkflow: () => Promise.reject(new Error('unused')),
    saveWorkflowSchedule: () => Promise.reject(new Error('unused')),
    connectorsUsingWorkflow: () => Promise.resolve([]),
    // `WorkflowRunnerService.requireStore` asks for these by name, so a fake
    // without them fails as "this store cannot hold workflows" long before
    // reaching anything about releases. Nothing here stages a row.
    writeStage: () => Promise.resolve({ written: 0 }),
    readStage: () => Promise.resolve([]),
    listWorkflowReleases: (...args: unknown[]) => {
      calls.push({ method: 'listWorkflowReleases', args });
      return Promise.resolve([RELEASE]);
    },
    releaseWorkflow: (...args: unknown[]) => {
      calls.push({ method: 'releaseWorkflow', args });
      return Promise.resolve(RELEASE);
    },
    getWorkflowAt: (_id: string, version: number) =>
      Promise.resolve(version === 6 ? { ...HEAD, version: 6, graphHash: 'hash-of-v6' } : undefined),
    setLiveWorkflowVersion: (...args: unknown[]) => {
      calls.push({ method: 'setLiveWorkflowVersion', args });
      const version = args[1];
      return Promise.resolve(
        typeof version === 'number' ? { ...HEAD, liveVersion: version } : { ...HEAD },
      );
    },
  };
  return { store, calls };
}

/** A store from before releases: every member absent, nothing narrows. */
const HOLDS_NONE = {
  listConnectors: () => Promise.resolve([]),
  listWorkflows: () => Promise.resolve([HEAD]),
  getWorkflow: () => Promise.resolve(HEAD),
  saveWorkflow: () => Promise.reject(new Error('unused')),
  publishWorkflow: () => Promise.reject(new Error('unused')),
  saveWorkflowSchedule: () => Promise.reject(new Error('unused')),
  connectorsUsingWorkflow: () => Promise.resolve([]),
  writeStage: () => Promise.resolve({ written: 0 }),
  readStage: () => Promise.resolve([]),
};

describe('the routes that separate editing from deploying', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function boot(store: Record<string, unknown>) {
    const moduleRef = await Test.createTestingModule({
      imports: [
        CatalogPipelineModule.forRoot({
          path: 'catalog',
          guards: [AllowWriter],
          imports: [storeModule(store)],
          em: {
            provide: CATALOG_PIPELINE_EM,
            useValue: () => {
              throw new Error('Nothing here publishes a type.');
            },
          },
          registry: { provide: CATALOG_PIPELINE_REGISTRY, useValue: { getType: () => undefined } },
          scheduler: false,
        }),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    return app.getHttpServer();
  }

  it('mints a release, attributed to the caller, with the notes they gave', async () => {
    const { store, calls } = holdsReleases();
    const server = await boot(store);

    const response = await request(server)
      .post('/catalog/pipeline/workflows/w1/releases')
      .send({ notes: 'the fix for SUBWO' });

    expect(response.status).toBe(201);
    expect(response.body.version).toBe(6);
    expect(calls[0].method).toBe('releaseWorkflow');
    expect(calls[0].args[2]).toEqual({ notes: 'the fix for SUBWO' });
  });

  /**
   * A release holds the graph as it was *stored*, sealed configs included, so
   * the history route is a second way to read a credential unless it redacts.
   * This is the assertion that fails if `redactRelease` is dropped.
   */
  it('redacts a source node’s credential out of the history, as the live read does', async () => {
    const { store } = holdsReleases();
    const server = await boot(store);

    const response = await request(server).get('/catalog/pipeline/workflows/w1/releases');

    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain('hunter2');
  });

  it('sets the live version, and answers with the graph carrying it', async () => {
    const { store, calls } = holdsReleases();
    const server = await boot(store);

    const response = await request(server)
      .put('/catalog/pipeline/workflows/w1/live')
      .send({ version: 6 });

    expect(response.status).toBe(200);
    expect(response.body.liveVersion).toBe(6);
    expect(calls.at(-1)).toMatchObject({ method: 'setLiveWorkflowVersion' });
    expect(calls.at(-1)?.args[1]).toBe(6);
  });

  /**
   * `null` is the un-pin and it is honoured; an **absent** key is refused. The
   * two must not collapse into each other, because reading an omitted field as
   * the un-pin would perform the most dangerous of the three operations on an
   * empty body.
   */
  it('honours an explicit null as going back to following the latest save', async () => {
    const { store, calls } = holdsReleases();
    const server = await boot(store);

    const response = await request(server)
      .put('/catalog/pipeline/workflows/w1/live')
      .send({ version: null });

    expect(response.status).toBe(200);
    expect(calls.at(-1)?.args[1]).toBeUndefined();
  });

  it('refuses a body with no version key rather than reading it as an un-pin', async () => {
    const { store, calls } = holdsReleases();
    const server = await boot(store);

    const response = await request(server).put('/catalog/pipeline/workflows/w1/live').send({});

    expect(response.status).toBe(400);
    expect(calls.some((call) => call.method === 'setLiveWorkflowVersion')).toBe(false);
  });

  it('refuses a version that arrived as a string, before it can fail a load', async () => {
    const { store } = holdsReleases();
    const server = await boot(store);

    const response = await request(server)
      .put('/catalog/pipeline/workflows/w1/live')
      .send({ version: '6' });

    expect(response.status).toBe(400);
    expect(response.body.message).toContain('whole number');
  });

  /**
   * Not a 500, and not a silent success. A deployment whose store predates this
   * feature has to be told that in a sentence — the alternative is a console
   * whose release button appears to work and whose pipelines keep running the
   * latest save.
   */
  it('says so in a sentence when the store cannot hold releases', async () => {
    const server = await boot(HOLDS_NONE);

    const list = await request(server).get('/catalog/pipeline/workflows/w1/releases');
    const live = await request(server)
      .put('/catalog/pipeline/workflows/w1/live')
      .send({ version: 6 });

    expect(list.status).toBe(400);
    expect(list.body.message).toContain('cannot hold workflow releases');
    expect(live.status).toBe(400);
  });
});
