import {
  CATALOG_PIPELINE_STORE,
  CATALOG_STORE,
  type CatalogPrincipal,
  type CatalogScope,
  REQUIRED_SCOPES,
  hasScope,
} from '@dudousxd/nestjs-catalog';
import type { INestApplication } from '@nestjs/common';
import { type CanActivate, type ExecutionContext, Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { redactConfigSecrets } from './config-secrets';
import { ConnectionChecker } from './connection-checker.service';
import { CatalogPipelineModule } from './pipeline.module';
import { CATALOG_PIPELINE_EM, CATALOG_PIPELINE_REGISTRY } from './seams';

/** See the note in `pipeline.module.integration.spec.ts`: the package cannot load here. */
vi.mock('@dudousxd/nestjs-durable', () => ({
  WorkflowEngine: class WorkflowEngine {},
  Step: () => (_target: unknown, _key: unknown, descriptor: unknown) => descriptor,
  Workflow: () => (target: unknown) => target,
}));

/**
 * Reaching a connection before it has been saved.
 *
 * The field most likely to be wrong on this form is the env var's NAME, and
 * without this the way you found out was a connector run failing hours later —
 * so the form said "save it, then test it from its card", and a connection
 * saved to discover a typo is a row somebody has to remember to delete.
 *
 * Two things here are not obvious and both would fail silently.
 *
 * The ROUTE ORDER: `connections/check` must be declared before
 * `connections/:id/check`, because Nest matches in declaration order and `:id`
 * captures the literal "check" happily. Getting it wrong turns this into a
 * lookup for a connection named "check" — a 404 that reads like a missing
 * feature.
 *
 * The SCOPE: its saved sibling asks for `catalog:read`, because it reaches an
 * address somebody with `catalog:write` already chose and wrote down. This one
 * reaches an address supplied in the request. Under `catalog:read` that is the
 * server connecting wherever any reader of the catalog points it.
 */

const WRITER: CatalogPrincipal = { id: 'app-a', scopes: ['catalog:write'], writeTypes: ['*'] };
const READER: CatalogPrincipal = { id: 'app-b', scopes: ['catalog:read'], writeTypes: [] };

let principal: CatalogPrincipal = WRITER;

/**
 * The host's half, written the way a host writes it: read the scopes the route
 * declared, resolve the caller, compare.
 *
 * A guard that only attached the principal would admit everybody, and the
 * refusal test below would pass on any scope at all — which is the shape of
 * test that reports an access control working when there is none.
 */
@Injectable()
class PresentPrincipal implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    Object.assign(context.switchToHttp().getRequest(), { principal });
    // `Reflect.getMetadata` rather than Nest's `Reflector`: that lives in
    // `@nestjs/core`, which this package does not depend on — the library ships
    // the metadata and leaves reading it to the host, which is the whole
    // declare-versus-enforce split.
    const declared: unknown = Reflect.getMetadata(REQUIRED_SCOPES, context.getHandler());
    const required: CatalogScope[] = Array.isArray(declared) ? declared : [];
    return required.every((scope) => hasScope(principal, scope));
  }
}

const SAVED = {
  id: 'c-saved',
  name: 'Fleet warehouse',
  kind: 'sql',
  config: { url: 'mysql://real:secret@host/db' },
};

const store = {
  getConnection: (id: string) => Promise.resolve(id === SAVED.id ? SAVED : undefined),
  listConnectors: () => Promise.resolve([]),
};

const checked: unknown[] = [];
class SpyChecker {
  check(connection: unknown) {
    checked.push(connection);
    return Promise.resolve({ ok: true, detail: 'Reached it.', elapsedMs: 3 });
  }
}

@Module({
  providers: [
    { provide: CATALOG_PIPELINE_STORE, useValue: store },
    { provide: CATALOG_STORE, useValue: {} },
  ],
  exports: [CATALOG_PIPELINE_STORE, CATALOG_STORE],
})
class FakeStoreModule {}

describe('POST connections/check', () => {
  let app: INestApplication;

  beforeEach(async () => {
    principal = WRITER;
    checked.length = 0;
    const moduleRef = await Test.createTestingModule({
      imports: [
        CatalogPipelineModule.forRoot({
          path: 'catalog',
          guards: [PresentPrincipal],
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
    })
      .overrideProvider(ConnectionChecker)
      .useValue(new SpyChecker())
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  function check(body: Record<string, unknown>) {
    return request(app.getHttpServer()).post('/catalog/pipeline/connections/check').send(body);
  }

  it('reaches a connection that was never saved', async () => {
    const response = await check({
      name: 'Fleet warehouse',
      kind: 'sql',
      config: { secretEnvVar: 'FLEET_DATABASE_URL' },
    });

    expect(response.status).toBe(201);
    expect(response.body.ok).toBe(true);
    expect(checked).toHaveLength(1);
  });

  it('is not swallowed by the by-id route', async () => {
    // THE ordering case. If `connections/:id/check` is declared first, "check"
    // is read as an id, the store has no such connection, and this answers 404
    // — which looks exactly like the route not existing.
    const response = await check({ name: 'x', kind: 'sql', config: {} });

    expect(response.status).not.toBe(404);
  });

  it('refuses a caller who may only read', async () => {
    // The whole scope argument. A body-supplied address means the server
    // connects where the request says; under `catalog:read` that is a port
    // scanner for anybody allowed to look at the catalog.
    principal = READER;

    const response = await check({ name: 'x', kind: 'sql', config: {} });

    expect(response.status).toBe(403);
    expect(checked).toHaveLength(0);
  });

  it('refuses a kind it does not know, before reaching anything', async () => {
    const response = await check({ name: 'x', kind: 'carrier-pigeon', config: {} });

    expect(response.status).toBe(400);
    expect(checked).toHaveLength(0);
  });

  it('puts the stored credential back when testing an edit of a saved one', async () => {
    // The redaction round trip. A console reads a saved connection, sees a
    // placeholder where the password was, changes the name and posts it back to
    // test — and without this the test reaches for the placeholder and reports
    // a working connection as unreachable.
    // Derived, not invented: this is byte-for-byte what the read routes hand a
    // console, so the test does the round trip rather than a guess at it. An
    // earlier version sent a bare placeholder, which the restore correctly
    // ignored — and the test would then have been asserting that a value it
    // made up does not survive, which proves nothing about the real path.
    const asShown = redactConfigSecrets(SAVED.config);

    await check({
      id: SAVED.id,
      name: 'Fleet warehouse (renamed)',
      kind: 'sql',
      config: asShown,
    });

    expect(checked).toHaveLength(1);
    expect(Reflect.get(Object(checked[0]), 'config')).toMatchObject({
      url: 'mysql://real:secret@host/db',
    });
  });
});
