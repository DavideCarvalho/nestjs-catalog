import {
  CATALOG_PIPELINE_STORE,
  CATALOG_STORE,
  type CatalogConnection,
  type CatalogConnector,
  type CatalogObjectTypeDef,
  type CatalogPipelineStore,
  type CatalogReadResult,
  type CatalogStoreCapabilities,
  type CatalogTransform,
  type CatalogWriteStore,
  type ConnectionCheck,
  type ConnectorRun,
  type SnapshotRef,
  SubprocessTransformRunner,
} from '@dudousxd/nestjs-catalog';
import type { CanActivate, INestApplication } from '@nestjs/common';
import { Controller, Get, Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CatalogPipelineModule } from './pipeline.module';
import {
  CATALOG_PIPELINE_EM,
  CATALOG_PIPELINE_REGISTRY,
  type CatalogPipelineRegistry,
} from './seams';

/**
 * `@dudousxd/nestjs-durable` cannot be loaded in this workspace: it imports
 * `@dudousxd/durable-worker` at module scope while declaring it an OPTIONAL peer,
 * so pnpm never installs it and the import throws before a single test runs. The
 * three symbols stubbed here are the whole of this package's use of it — a
 * `WorkflowEngine` type that is only ever an `@Optional()` injection (no engine
 * is bound in any case below) and two decorators that attach discovery metadata
 * nothing here reads. Nothing under test is faked: the routes, the providers and
 * the exports are the real ones.
 */
vi.mock('@dudousxd/nestjs-durable', () => ({
  WorkflowEngine: class WorkflowEngine {},
  Step: () => (_target: unknown, _key: unknown, descriptor: unknown) => descriptor,
  Workflow: () => (target: unknown) => target,
}));

/**
 * Booting the module is the assertion.
 *
 * Every failure this file exists to catch — a controller mounted at the wrong
 * prefix, a provider the declaring module never exported, a mount that happens
 * when the host asked for none — is invisible to `tsc` and to the build. It only
 * appears when Nest actually wires the graph and Express actually owns a routing
 * table, so these tests boot a real application and ask it over HTTP.
 */

/**
 * The store the pipeline reads and writes through, stubbed.
 *
 * A fake rather than the MikroORM store because none of the behaviour under test
 * reaches a database: these are wiring tests, and the real store would make every
 * one of them need a container to prove something about a routing table. Methods
 * the tests do not exercise throw rather than return a plausible-looking empty
 * value — a wiring test that silently starts asserting against invented data is
 * worse than one that stops.
 */
class FakePipelineStore implements CatalogPipelineStore {
  listConnectors(): Promise<CatalogConnector[]> {
    return Promise.resolve([]);
  }
  getConnector(): Promise<CatalogConnector | undefined> {
    return Promise.resolve(undefined);
  }
  saveConnector(): Promise<CatalogConnector> {
    throw new Error('FakePipelineStore.saveConnector is not exercised by the wiring tests.');
  }
  deleteConnector(): Promise<boolean> {
    return Promise.resolve(false);
  }
  saveConnectorState(): Promise<void> {
    return Promise.resolve();
  }
  listConnections(): Promise<CatalogConnection[]> {
    return Promise.resolve([]);
  }
  getConnection(): Promise<CatalogConnection | undefined> {
    return Promise.resolve(undefined);
  }
  saveConnection(): Promise<CatalogConnection> {
    throw new Error('FakePipelineStore.saveConnection is not exercised by the wiring tests.');
  }
  deleteConnection(): Promise<boolean> {
    return Promise.resolve(false);
  }
  recordConnectionCheck(_id: string, _check: ConnectionCheck): Promise<void> {
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
    throw new Error('FakePipelineStore.saveTransform is not exercised by the wiring tests.');
  }
  deleteTransform(): Promise<boolean> {
    return Promise.resolve(false);
  }
  startRun(): Promise<ConnectorRun> {
    throw new Error('FakePipelineStore.startRun is not exercised by the wiring tests.');
  }
  finishRun(): Promise<ConnectorRun | undefined> {
    return Promise.resolve(undefined);
  }
  listRuns(): Promise<ConnectorRun[]> {
    return Promise.resolve([]);
  }
}

/**
 * The write store `PublishService` lands rows in, stubbed for the same reason as
 * the pipeline store: it is a constructor dependency of a provider these tests
 * have to instantiate, not a thing they assert about.
 */
class FakeWriteStore implements CatalogWriteStore {
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
    throw new Error('FakeWriteStore.write is not exercised by the wiring tests.');
  }
  commit(): Promise<SnapshotRef> {
    throw new Error('FakeWriteStore.commit is not exercised by the wiring tests.');
  }
  dropSnapshot(): Promise<void> {
    return Promise.resolve();
  }
}

/** The registry seam, stubbed: the engine only ever calls these two. */
const registryStub: CatalogPipelineRegistry = {
  reload: () => Promise.resolve(),
  getType: (): CatalogObjectTypeDef | undefined => undefined,
};

/**
 * The host module every case here mounts the pipeline inside.
 *
 * `scheduler: false` on purpose: the scheduler's `onApplicationBootstrap` starts
 * a deliberately un-`unref`'d 30s interval, so a suite that left it on would hold
 * the vitest worker open and read as a hung test rather than as a leaked timer.
 */
function pipelineHost(options: {
  path?: string;
  guards?: Parameters<typeof CatalogPipelineModule.forRoot>[0]['guards'];
}) {
  return CatalogPipelineModule.forRoot({
    ...(options.path !== undefined ? { path: options.path } : {}),
    ...(options.guards !== undefined ? { guards: options.guards } : {}),
    imports: [FakeStoreModule],
    em: {
      provide: CATALOG_PIPELINE_EM,
      useValue: () => {
        throw new Error('No EntityManager in the wiring tests; no case here writes.');
      },
    },
    registry: { provide: CATALOG_PIPELINE_REGISTRY, useValue: registryStub },
    scheduler: false,
  });
}

@Module({
  providers: [
    { provide: CATALOG_PIPELINE_STORE, useClass: FakePipelineStore },
    { provide: CATALOG_STORE, useClass: FakeWriteStore },
  ],
  exports: [CATALOG_PIPELINE_STORE, CATALOG_STORE],
})
class FakeStoreModule {}

/**
 * Every `path` + `method` Express ended up serving.
 *
 * Read off the adapter rather than counted through probe requests, because the
 * claim under test is about the routing table itself: a controller that mounted
 * under the wrong prefix still answers *somewhere*, and only the table shows
 * where.
 */
function routeTable(app: INestApplication): string[] {
  // Both the Express application and its router are FUNCTIONS carrying
  // properties, not plain objects, and the router moved from `_router` (v4) to
  // `router` (v5) — hence `prop` rather than a property access, and a throw
  // rather than an empty list, which would turn every assertion below into a
  // false pass.
  const server: unknown = app.getHttpAdapter().getInstance();
  const router = prop(server, 'router') ?? prop(server, '_router');
  const stack = prop(router, 'stack');
  if (!Array.isArray(stack)) throw new Error('Could not read the Express routing table.');
  const routes: string[] = [];
  for (const layer of stack) {
    const route = prop(layer, 'route');
    const path = prop(route, 'path');
    const methods = prop(route, 'methods');
    if (typeof path !== 'string' || !isRecord(methods)) continue;
    for (const [method, enabled] of Object.entries(methods)) {
      if (enabled) routes.push(`${method.toUpperCase()} ${path}`);
    }
  }
  return routes;
}

function prop(target: unknown, key: string): unknown {
  if (target === null || (typeof target !== 'object' && typeof target !== 'function')) {
    return undefined;
  }
  return Reflect.get(target, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function boot(imports: Parameters<typeof Test.createTestingModule>[0]['imports']) {
  const moduleRef = await Test.createTestingModule({ imports: imports ?? [] }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

describe('CatalogPipelineModule.forRoot (integration)', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('mounts the pipeline and publish surfaces under the configured path', async () => {
    app = await boot([pipelineHost({ path: 'api/catalog-service' })]);

    const routes = routeTable(app);
    const pipeline = routes.filter((route) => route.includes('/api/catalog-service/pipeline'));
    const publish = routes.filter((route) => route.includes('/api/catalog-service/publish'));

    // 20 + 4. Pinned as a total rather than route-by-route so that a route which
    // moves prefix — the failure mode this whole file is about — cannot be
    // mistaken for a route that was merely renamed.
    expect(pipeline).toHaveLength(20);
    expect(publish).toHaveLength(4);

    // The five workflow routes named explicitly, because they are the ones that
    // went missing. The console asked for `/pipeline/workflows`, the package
    // served everything else, and the screen reported only that it could not
    // read the workflows — which reads as a broken deployment rather than an
    // endpoint that was never ported.
    expect(pipeline).toEqual(
      expect.arrayContaining([
        'GET /api/catalog-service/pipeline/workflows',
        'POST /api/catalog-service/pipeline/workflows',
        'DELETE /api/catalog-service/pipeline/workflows/:id',
        'POST /api/catalog-service/pipeline/workflows/:id/run',
        'GET /api/catalog-service/pipeline/workflows/:id/connectors',
      ]),
    );
    expect(routes.filter((route) => route.startsWith('GET /api/catalog-service'))).toContain(
      'GET /api/catalog-service/pipeline/connections',
    );

    await request(app.getHttpServer()).get('/api/catalog-service/pipeline/connections').expect(200);
  });

  it('honours a path with no leading slash exactly as written', async () => {
    // The option is documented as a prefix, and both controller factories
    // interpolate it into `@Controller()` raw. A host that writes `catalog` and a
    // host that writes `/catalog` must land in the same place, and the only way
    // to know is to ask the router.
    app = await boot([pipelineHost({ path: 'catalog' })]);

    await request(app.getHttpServer()).get('/catalog/pipeline/connectors').expect(200);
  });

  it('mounts no controllers at all when no path is given', async () => {
    // A worker-only host runs the engine and the scheduler and serves nothing.
    // The engine still has to be there, so this asserts both halves: no routes,
    // and the services still resolve.
    app = await boot([pipelineHost({})]);

    expect(routeTable(app).filter((route) => route.includes('pipeline'))).toHaveLength(0);
    expect(app.get(SubprocessTransformRunner)).toBeInstanceOf(SubprocessTransformRunner);
  });

  it('applies the host guards to the mounted routes', async () => {
    // The library ships no guards for routes that can rewrite a catalog's
    // schema, so the host's are the only thing between the internet and a
    // `PUT .../publish/:type/schema`. A guard silently not applied looks
    // identical to a working deployment until someone tries it.
    app = await boot([pipelineHost({ path: 'api/catalog-service', guards: [DenyGuard] })]);

    await request(app.getHttpServer()).get('/api/catalog-service/pipeline/connectors').expect(403);
    await request(app.getHttpServer())
      .get('/api/catalog-service/publish/Foo/snapshots')
      .expect(403);
  });

  it('exports SubprocessTransformRunner so a host controller can inject it', async () => {
    // Nest resolves a controller's dependencies from the module that DECLARES
    // it, so a host controller asking for `SubprocessTransformRunner` gets it
    // only if `CatalogPipelineModule` exports the instance it configured. Without
    // the export this does not fail at the request — it fails at boot, with
    // "SubprocessTransformRunner is not available", which is why the assertion
    // is that the app comes up at all.
    app = await boot([HostWithOwnTransformController]);

    await request(app.getHttpServer()).get('/host/languages').expect(200);
  });
});

@Injectable()
class DenyGuard implements CanActivate {
  canActivate(): boolean {
    return false;
  }
}

/**
 * A host that publishes its own route over the pipeline's transform runner — the
 * shape that broke at boot before the export was added.
 */
@Controller('host')
class HostTransformController {
  constructor(private readonly transforms: SubprocessTransformRunner) {}

  @Get('languages')
  languages(): { ok: boolean } {
    return { ok: this.transforms instanceof SubprocessTransformRunner };
  }
}

@Module({
  imports: [pipelineHost({})],
  controllers: [HostTransformController],
})
class HostWithOwnTransformController {}
