import { CATALOG_PIPELINE_STORE, CATALOG_STORE } from '@dudousxd/nestjs-catalog';
import type { INestApplication } from '@nestjs/common';
import { type CanActivate, Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CatalogPipelineModule } from './pipeline.module';
import { CATALOG_PIPELINE_EM, CATALOG_PIPELINE_REGISTRY } from './seams';

/** See the note in `pipeline.module.integration.spec.ts`: the package cannot load here. */
vi.mock('@dudousxd/nestjs-durable', () => ({
  WorkflowEngine: class WorkflowEngine {},
  Step: () => (_target: unknown, _key: unknown, descriptor: unknown) => descriptor,
  Workflow: () => (target: unknown) => target,
}));

/**
 * That `GET pipeline/capabilities` says whether a run survives a crash.
 *
 * The console has always asked: `WorkflowCanvas` reads `capabilities.durable`
 * and prints whether a failed run resumes where it stopped, or restarts from
 * the beginning. The route never sent the field, so the screen fell through to
 * its "unknown" branch in every deployment there has ever been — and the answer
 * was available synchronously, in the same process, the whole time.
 *
 * The silence had a second victim. `CATALOG_PIPELINE_DURABILITY_DETAIL` is the
 * supported way a host states the two things the launcher deliberately cannot
 * work out from inside this package — whether this pod registered the workflow
 * handlers, and which environment its worker serves. Everything a host said
 * through that seam was composed correctly and then dropped on arrival, which
 * is the worst shape a seam can have: it looks wired from both ends.
 */

@Injectable()
class LetEverybodyIn implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

@Module({
  providers: [
    { provide: CATALOG_PIPELINE_STORE, useValue: { listConnectors: () => Promise.resolve([]) } },
    { provide: CATALOG_STORE, useValue: {} },
  ],
  exports: [CATALOG_PIPELINE_STORE, CATALOG_STORE],
})
class FakeStoreModule {}

describe('GET pipeline/capabilities', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        CatalogPipelineModule.forRoot({
          path: 'catalog',
          guards: [LetEverybodyIn],
          imports: [FakeStoreModule],
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
  });

  afterEach(async () => {
    await app.close();
  });

  it('still reports which languages this deployment can execute', async () => {
    // The two fields that were already there, so serving a third cannot quietly
    // have cost the console the two it depends on.
    const response = await request(app.getHttpServer()).get('/catalog/pipeline/capabilities');

    expect(Array.isArray(response.body.languages)).toBe(true);
    expect(Array.isArray(response.body.pythonPackages)).toBe(true);
  });

  it('says whether a run survives a crash', async () => {
    const response = await request(app.getHttpServer()).get('/catalog/pipeline/capabilities');

    expect(response.body.durable).toBeDefined();
    expect(typeof response.body.durable.available).toBe('boolean');
  });

  it('says WHY, because "not durable" without a reason is unactionable', async () => {
    // No engine is registered in this module, so the honest answer is that runs
    // restart — and the operator's next question is always "why is it off
    // here", which a bare `false` cannot answer.
    const response = await request(app.getHttpServer()).get('/catalog/pipeline/capabilities');

    expect(response.body.durable.available).toBe(false);
    expect(typeof response.body.durable.detail).toBe('string');
    expect(response.body.durable.detail.length).toBeGreaterThan(0);
  });
});
