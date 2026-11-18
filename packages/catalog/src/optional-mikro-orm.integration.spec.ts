import 'reflect-metadata';
import { type INestApplication, Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * That a host without MikroORM can import the package and boot the module.
 *
 * `@mikro-orm/core` is an optional peer, and only the two MikroORM defaults use
 * it. Before 0.37 the registry and read store imported it at the top of their
 * files, and both the module and the barrel reference those classes, so a
 * Drizzle host crashed on import, before it could pass its own `registry` and
 * `store`. Here the package fails to load the way it does when it is not
 * installed, and everything else still has to work.
 */
vi.mock('@mikro-orm/core', () => {
  throw new Error("Cannot find module '@mikro-orm/core'");
});

describe('without @mikro-orm/core installed', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('serves a host-bound registry and store', async () => {
    const catalog = await import('./index');

    @Injectable()
    class HostRegistry extends catalog.CatalogRegistry {
      getSnapshot() {
        return {
          version: 1,
          generatedAt: new Date(0).toISOString(),
          stats: { types: 0, properties: 0, relations: 0, enrichedTypes: 0 },
          types: [],
        };
      }
      getType() {
        return undefined;
      }
      patchType() {
        return Promise.resolve(undefined);
      }
      patchProperty() {
        return Promise.resolve(undefined);
      }
      resetOverlay() {
        return Promise.resolve();
      }
    }

    @Module({
      imports: [
        catalog.CatalogModule.forRoot({
          path: 'admin/ontology',
          registry: { provide: catalog.CatalogRegistry, useClass: HostRegistry },
          store: { provide: catalog.CATALOG_STORE, useValue: {} },
          overlayStore: {
            load: () => Promise.resolve({ types: {} }),
            save: () => Promise.resolve(),
          },
        }),
      ],
    })
    class HostModule {}

    const moduleRef = await Test.createTestingModule({ imports: [HostModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();

    await request(app.getHttpServer())
      .get('/admin/ontology/graph')
      .expect(200)
      .expect((response) => expect(response.body).toEqual({ nodes: [], edges: [] }));
    // Importing the whole barrel through the transformer is slow on a cold run.
  }, 60_000);
});
