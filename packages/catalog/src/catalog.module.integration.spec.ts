import type { CanActivate, INestApplication, Type } from '@nestjs/common';
import { Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { CatalogModule } from './catalog.module';
import { InMemoryCatalogOverlayStore } from './catalog.overlay-store';
import { CatalogRegistry } from './catalog.registry.base';
import { CatalogService } from './catalog.service';
import {
  CATALOG_STORE,
  type CatalogReadResult,
  type CatalogReadStore,
  type CatalogStoreCapabilities,
} from './catalog.store';
import type { CatalogGraph, CatalogObjectTypeDef, CatalogSnapshot } from './catalog.types';

/**
 * What `forRoot` promises is a routing table, and a routing table is not a type.
 *
 * `path`, `controller: false` and `guards` all describe what an application ends
 * up serving, and every one of them can be wrong while the package compiles and
 * the module logs itself as initialised. So these boot a real application and
 * ask it over HTTP rather than asserting on the `DynamicModule` literal, which
 * would only restate the code that produced it.
 */

const TYPE: CatalogObjectTypeDef = {
  name: 'Widget',
  displayName: 'Widget',
  pluralDisplayName: 'Widgets',
  group: 'default',
  tableName: 'widget',
  enriched: false,
  primaryKey: ['id'],
  properties: [
    {
      name: 'id',
      displayName: 'Id',
      type: 'string',
      columnName: 'id',
      nullable: false,
      primary: true,
      hidden: false,
      order: 0,
      enriched: false,
    },
  ],
  relations: [],
};

/**
 * A registry that answers from a literal.
 *
 * The default registry derives the model from MikroORM metadata, which would
 * make a test about route mounting need an ORM, a connection and a set of
 * entities — none of which participate in the thing under test. Subclassing the
 * abstract class rather than faking the token also keeps this honest: if the
 * contract the controller depends on grows a method, this stops compiling.
 */
@Injectable()
class StubRegistry extends CatalogRegistry {
  getSnapshot(): CatalogSnapshot {
    return {
      version: 1,
      generatedAt: new Date(0).toISOString(),
      stats: { types: 1, properties: 1, relations: 0, enrichedTypes: 0 },
      types: [TYPE],
    };
  }
  getType(name: string): CatalogObjectTypeDef | undefined {
    return name === TYPE.name ? TYPE : undefined;
  }
  getGraph(): CatalogGraph {
    return {
      nodes: [
        {
          id: TYPE.name,
          label: TYPE.displayName,
          group: 'default',
          propertyCount: TYPE.properties.length,
          relationCount: 0,
        },
      ],
      edges: [],
    };
  }
  patchType(): Promise<CatalogObjectTypeDef | undefined> {
    return Promise.resolve(TYPE);
  }
  patchProperty(): Promise<CatalogObjectTypeDef | undefined> {
    return Promise.resolve(TYPE);
  }
  resetOverlay(): Promise<void> {
    return Promise.resolve();
  }
}

@Injectable()
class StubStore implements CatalogReadStore {
  readonly capabilities: CatalogStoreCapabilities = {
    snapshots: 'none',
    writable: false,
    timeTravel: false,
  };
  read(): Promise<CatalogReadResult> {
    return Promise.resolve({ rows: [{ id: 'w-1' }], total: 1 });
  }
}

/**
 * Every case supplies both seams. Left to their defaults the module registers
 * the MikroORM-backed registry and read store, which cannot resolve without an
 * ORM — a boot failure that says nothing about the mounting behaviour under
 * test. `overlayStore` is in-memory for the same reason and one more: the
 * default writes a JSON file under `process.cwd()`, and a test suite has no
 * business leaving one behind.
 */
function catalogHost(options: {
  path?: string;
  controller?: boolean;
  guards?: Type<unknown>[];
}) {
  return CatalogModule.forRoot({
    ...(options.path !== undefined ? { path: options.path } : {}),
    ...(options.controller !== undefined ? { controller: options.controller } : {}),
    ...(options.guards !== undefined ? { guards: options.guards } : {}),
    registry: { provide: CatalogRegistry, useClass: StubRegistry },
    store: { provide: CATALOG_STORE, useClass: StubStore },
    overlayStore: new InMemoryCatalogOverlayStore(),
  });
}

async function boot(imports: Parameters<typeof Test.createTestingModule>[0]['imports']) {
  const moduleRef = await Test.createTestingModule({ imports: imports ?? [] }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

describe('CatalogModule.forRoot (integration)', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('serves the catalog under the configured path and nowhere else', async () => {
    app = await boot([catalogHost({ path: 'internal/ontology' })]);

    await request(app.getHttpServer())
      .get('/internal/ontology')
      .expect(200)
      .expect((response) => {
        expect(response.body.types).toHaveLength(1);
      });
    await request(app.getHttpServer()).get('/internal/ontology/graph').expect(200);
    await request(app.getHttpServer()).get('/internal/ontology/types/Widget').expect(200);
    // The default, which a configured path must NOT also answer on: a controller
    // that ignored `path` would still serve here and every positive assertion
    // above would have to be reached some other way to notice.
    await request(app.getHttpServer()).get('/api/catalog').expect(404);
  });

  it('defaults to api/catalog when no path is given', async () => {
    app = await boot([catalogHost({})]);

    await request(app.getHttpServer()).get('/api/catalog').expect(200);
  });

  it('mounts no routes at all with controller: false, and still exports the service', async () => {
    // The documented way to publish your own HTTP surface over the catalog. Both
    // halves matter: a leftover built-in route would double-publish an
    // introspection endpoint the host thought it had taken ownership of, and a
    // `CatalogService` that no longer resolves leaves the host with nothing to
    // build on.
    app = await boot([catalogHost({ controller: false })]);

    await request(app.getHttpServer()).get('/api/catalog').expect(404);
    expect(app.get(CatalogService)).toBeInstanceOf(CatalogService);
    expect(app.get(CatalogRegistry)).toBeInstanceOf(StubRegistry);
  });

  it('applies the host guards to every catalog route', async () => {
    // This library ships no guards for an endpoint that enumerates every table
    // in the database, so the host's guard is the only thing in front of it.
    // Asserted over HTTP because `UseGuards` on a generated class is exactly the
    // kind of thing that compiles whether or not it took effect.
    app = await boot([catalogHost({ path: 'api/catalog', guards: [DenyGuard] })]);

    await request(app.getHttpServer()).get('/api/catalog').expect(403);
    await request(app.getHttpServer()).get('/api/catalog/graph').expect(403);
  });

  it('resolves a host guard from the module the host handed in', async () => {
    // Nest instantiates a guard in the injector of the module that DECLARES the
    // controller, which for a generated controller is this library's module and
    // not the host's. `imports` is the seam that makes a guard with its own
    // dependencies resolvable at all; without it the failure is at boot, and
    // reads as though the guard were at fault.
    app = await boot([
      CatalogModule.forRoot({
        path: 'api/catalog',
        guards: [InjectingGuard],
        imports: [VerdictModule],
        registry: { provide: CatalogRegistry, useClass: StubRegistry },
        store: { provide: CATALOG_STORE, useClass: StubStore },
        overlayStore: new InMemoryCatalogOverlayStore(),
      }),
    ]);

    await request(app.getHttpServer()).get('/api/catalog').expect(403);
  });
});

@Injectable()
class DenyGuard implements CanActivate {
  canActivate(): boolean {
    return false;
  }
}

@Injectable()
class VerdictService {
  allow(): boolean {
    return false;
  }
}

@Injectable()
class InjectingGuard implements CanActivate {
  constructor(private readonly verdict: VerdictService) {}
  canActivate(): boolean {
    return this.verdict.allow();
  }
}

@Module({
  providers: [VerdictService],
  exports: [VerdictService],
})
class VerdictModule {}
