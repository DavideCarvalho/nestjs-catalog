import {
  CATALOG_PIPELINE_STORE,
  CATALOG_STORE,
  type CatalogPrincipal,
} from '@dudousxd/nestjs-catalog';
import type { INestApplication } from '@nestjs/common';
import { type CanActivate, type ExecutionContext, Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CatalogPipelineModule } from './pipeline.module';
import { CATALOG_PIPELINE_EM, CATALOG_PIPELINE_REGISTRY } from './seams';
import { WorkflowLauncher } from './workflow-launcher.service';

/** See the note in `pipeline.module.integration.spec.ts`: the package cannot load here. */
vi.mock('@dudousxd/nestjs-durable', () => ({
  WorkflowEngine: class WorkflowEngine {},
  Step: () => (_target: unknown, _key: unknown, descriptor: unknown) => descriptor,
  Workflow: () => (target: unknown) => target,
}));

/**
 * That the bundled run route can carry an acknowledgement of a collapse.
 *
 * A snapshot that loses most of its rows does not commit — the bound is on by
 * default, because a load that collapses is fresh and wrong, which is the worst
 * pairing on a screen somebody decides from. `expectShrink` is the sentence an
 * operator attaches to the one run where the collapse is intended: a source
 * that really was emptied, a first load after a truncation.
 *
 * **It lives on the workflow run route now, and that move is the point of these
 * tests.** It used to be `POST connectors/:id/run`, which no longer exists — a
 * connector is not something anybody authors or runs directly. Had it simply
 * gone with that route, the only remaining way to get a refused load through
 * would have been raising the row-count bound in policy: standing the guard down
 * for every future load of that type rather than for the one snapshot somebody
 * looked at. That is the failure `EXPECT_SHRINK_LABEL` exists to prevent,
 * arrived at by deleting its only entrance, so these tests are what stop the
 * entrance being deleted again.
 *
 * **The scheduled path deliberately has no field for it, and that asymmetry is
 * the design.** A cron run is unattended; an acknowledgement supplied once and
 * honoured every night is the bound switched off wearing a reason. So the
 * operator's route is this one, by hand, per run.
 */

const WRITER: CatalogPrincipal = {
  id: 'app-a',
  scopes: ['catalog:write'],
  writeTypes: ['*'],
};

@Injectable()
class AllowWriter implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    Object.assign(context.switchToHttp().getRequest(), { principal: WRITER });
    return true;
  }
}

/** Records how it was called; runs nothing. */
class SpyLauncher {
  readonly calls: Array<Record<string, unknown>> = [];
  run(input: Record<string, unknown>) {
    this.calls.push(input);
    return Promise.resolve({ id: 'run-1', status: 'succeeded' });
  }
}

const WORKFLOW = {
  id: 'w1',
  name: 'Mvr nightly',
  nodes: [
    {
      id: 'source',
      kind: 'source',
      name: 'Nightly',
      sourceKind: 'sql',
      config: { url: 'postgres://x/y', query: 'select 1' },
    },
    { id: 'sink', kind: 'sink', name: 'Mvr', targetType: 'Mvr' },
  ],
  edges: [{ from: 'source', to: 'sink' }],
  status: 'ready',
  version: 1,
  graphHash: 'hash',
  targetType: 'Mvr',
  enabled: true,
  createdBy: 'ana',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const spy = new SpyLauncher();

/**
 * The store, sized to what this route touches before dispatching: it loads the
 * graph to check the grant against what its sinks commit, and nothing else.
 * Everything past that point belongs to the launcher, which is a spy here.
 */
const pipelineStore = {
  listConnectors: () => Promise.resolve([]),
  listWorkflows: () => Promise.resolve([WORKFLOW]),
  getWorkflow: (id: string) => Promise.resolve(id === WORKFLOW.id ? WORKFLOW : undefined),
  saveWorkflow: () => Promise.reject(new Error('nothing here saves')),
  publishWorkflow: () => Promise.reject(new Error('nothing here publishes')),
  saveWorkflowSchedule: () => Promise.reject(new Error('nothing here schedules')),
  connectorsUsingWorkflow: () => Promise.resolve([]),
  writeStage: () => Promise.reject(new Error('nothing here stages')),
  readStage: () => Promise.resolve([]),
  dropStages: () => Promise.resolve(0),
};

@Module({
  providers: [
    { provide: CATALOG_PIPELINE_STORE, useValue: pipelineStore },
    { provide: CATALOG_STORE, useValue: {} },
  ],
  exports: [CATALOG_PIPELINE_STORE, CATALOG_STORE],
})
class FakeStoreModule {}

describe('POST workflows/:id/run and a deliberate collapse', () => {
  let app: INestApplication;

  beforeEach(async () => {
    spy.calls.length = 0;
    const moduleRef = await Test.createTestingModule({
      imports: [
        CatalogPipelineModule.forRoot({
          path: 'catalog',
          guards: [AllowWriter],
          imports: [FakeStoreModule],
          em: {
            provide: CATALOG_PIPELINE_EM,
            useValue: () => {
              throw new Error('Nothing here publishes a type.');
            },
          },
          registry: {
            provide: CATALOG_PIPELINE_REGISTRY,
            useValue: { getType: () => undefined },
          },
          scheduler: false,
        }),
      ],
    })
      // The store is stubbed to the minimum the route touches before dispatching:
      // it loads the graph to check the grant, and nothing else.
      .overrideProvider(WorkflowLauncher)
      .useValue(spy)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('forwards the reason an operator gave for the collapse', async () => {
    await request(app.getHttpServer())
      .post('/catalog/pipeline/workflows/w1/run')
      .send({ snapshotId: 's1', expectShrink: 'the depot was decommissioned' });

    expect(spy.calls[0]?.expectShrink).toBe('the depot was decommissioned');
  });

  it('passes nothing at all when the operator said nothing', async () => {
    // `undefined` and "the field was sent empty" are different statements — the
    // sink refuses the second — and a route that flattened them would turn that
    // refusal into silence.
    await request(app.getHttpServer())
      .post('/catalog/pipeline/workflows/w1/run')
      .send({ snapshotId: 's1' });

    expect('expectShrink' in (spy.calls[0] ?? {})).toBe(false);
  });

  it('forwards an empty reason rather than dropping it, so the sink can refuse it', async () => {
    await request(app.getHttpServer())
      .post('/catalog/pipeline/workflows/w1/run')
      .send({ snapshotId: 's1', expectShrink: '' });

    expect(spy.calls[0]?.expectShrink).toBe('');
  });

  /**
   * The route that used to carry this is gone, and that has to stay asserted.
   *
   * If `POST connectors/:id/run` ever came back it would be a second way to run
   * a pipeline — which is the thing this whole change removed — and it would be
   * the one that bypasses the graph's own sink authorisation.
   */
  it('has no connector run route to give the acknowledgement to instead', async () => {
    await request(app.getHttpServer())
      .post('/catalog/pipeline/connectors/c1/run')
      .send({ expectShrink: 'the depot was decommissioned' })
      .expect(404);
  });
});
