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
import { ConnectorRunnerService } from './connector-runner.service';
import { CatalogPipelineModule } from './pipeline.module';
import { CATALOG_PIPELINE_EM, CATALOG_PIPELINE_REGISTRY } from './seams';

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
 * The runner accepted it before this route forwarded it, which meant the
 * acknowledgement existed and could not be given by anybody using the shipped
 * API — reachable only from a host's own controller.
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
class SpyRunner {
  readonly calls: unknown[][] = [];
  run(...args: unknown[]) {
    this.calls.push(args);
    return Promise.resolve({ id: 'run-1', status: 'succeeded' });
  }
}

const CONNECTOR = {
  id: 'c1',
  name: 'Mvr nightly',
  kind: 'sql',
  targetType: 'Mvr',
  config: {},
  mode: 'full',
  enabled: true,
};

const spy = new SpyRunner();

/**
 * The two stores, sized to what this route touches before dispatching: it looks
 * the connector up to check the grant against its target type, and nothing
 * else. Everything past that point belongs to the runner, which is a spy here.
 */
const pipelineStore = {
  getConnector: (id: string) => Promise.resolve(id === CONNECTOR.id ? CONNECTOR : undefined),
  listConnectors: () => Promise.resolve([CONNECTOR]),
};

@Module({
  providers: [
    { provide: CATALOG_PIPELINE_STORE, useValue: pipelineStore },
    { provide: CATALOG_STORE, useValue: {} },
  ],
  exports: [CATALOG_PIPELINE_STORE, CATALOG_STORE],
})
class FakeStoreModule {}

describe('POST connectors/:id/run and a deliberate collapse', () => {
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
      // it looks the connector up to check the grant, and nothing else.
      .overrideProvider(ConnectorRunnerService)
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
      .post('/catalog/pipeline/connectors/c1/run')
      .send({ snapshotId: 's1', expectShrink: 'the depot was decommissioned' });

    expect(spy.calls[0]?.[3]).toEqual({ expectShrink: 'the depot was decommissioned' });
  });

  it('passes nothing at all when the operator said nothing', async () => {
    // `undefined` and "the field was sent empty" are different statements — the
    // runner refuses the second — and a route that flattened them would turn
    // that refusal into silence.
    await request(app.getHttpServer())
      .post('/catalog/pipeline/connectors/c1/run')
      .send({ snapshotId: 's1' });

    expect(spy.calls[0]?.[3]).toBeUndefined();
  });

  it('forwards an empty reason rather than dropping it, so the runner can refuse it', async () => {
    await request(app.getHttpServer())
      .post('/catalog/pipeline/connectors/c1/run')
      .send({ snapshotId: 's1', expectShrink: '' });

    expect(spy.calls[0]?.[3]).toEqual({ expectShrink: '' });
  });
});
