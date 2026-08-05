import {
  CATALOG_PIPELINE_STORE,
  CATALOG_STORE,
  type CatalogRevision,
} from '@dudousxd/nestjs-catalog';
import type { INestApplication } from '@nestjs/common';
import { type CanActivate, Injectable, Module } from '@nestjs/common';
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
 * That `GET pipeline/transforms/:id/revisions` is served, and that a store which
 * keeps no history says so instead of answering `[]`.
 *
 * The second half is the one worth booting an application for. Both cases end up
 * as an empty array on a screen otherwise, and they are different facts: "this
 * transform has never been edited" and "this deployment does not keep old code"
 * lead to completely different next steps for whoever is looking at a load that
 * came out wrong.
 */

@Injectable()
class LetEverybodyIn implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

const REVISIONS: CatalogRevision[] = [
  {
    id: 'transform:t1:2',
    subjectId: 't1',
    version: 2,
    body: 'rows => rows.filter(Boolean)',
    authoredBy: 'ana',
    authoredAt: new Date('2021-06-01T09:30:00.000Z').toISOString(),
  },
  {
    id: 'transform:t1:1',
    subjectId: 't1',
    version: 1,
    body: 'rows => rows',
    authoredBy: 'ana',
    authoredAt: new Date('2021-01-01T09:30:00.000Z').toISOString(),
  },
];

/**
 * The two stores that matter here, and the difference between them is one
 * method: `supportsTransformRevisions` asks for it by name rather than trusting
 * a flag, so this is the whole of the distinction the route draws.
 */
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

const KEEPS_HISTORY = {
  listConnectors: () => Promise.resolve([]),
  listTransformRevisions: (id: string) =>
    Promise.resolve(REVISIONS.map((revision) => ({ ...revision, subjectId: id }))),
};

const KEEPS_NONE = { listConnectors: () => Promise.resolve([]) };

describe('GET pipeline/transforms/:id/revisions', () => {
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
          guards: [LetEverybodyIn],
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

  it('serves every version of the code, newest first', async () => {
    const server = await boot(KEEPS_HISTORY);

    const response = await request(server).get('/catalog/pipeline/transforms/t1/revisions');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(REVISIONS);
  });

  it('hands back the body a run at that version executed', async () => {
    // The reason the route exists: `ConnectorRun.transformVersion` is a number
    // in a runs list, and this is what turns it into something openable.
    const server = await boot(KEEPS_HISTORY);

    const response = await request(server).get('/catalog/pipeline/transforms/t1/revisions');
    const forTheRun = response.body.find((revision: CatalogRevision) => revision.version === 2);

    expect(forTheRun.body).toBe('rows => rows.filter(Boolean)');
  });

  it('refuses, with a reason, on a store that keeps no revisions', async () => {
    // Not `[]`. A screen cannot tell an empty history from an absent feature,
    // and the two mean opposite things about whether the code is recoverable.
    const server = await boot(KEEPS_NONE);

    const response = await request(server).get('/catalog/pipeline/transforms/t1/revisions');

    expect(response.status).toBe(400);
    expect(response.body.message).toContain('keeps no revisions');
  });
});
