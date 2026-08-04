import type { INestApplication } from '@nestjs/common';
import { Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { Response } from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { DashboardAuthOptions } from './auth/dashboard-auth-config.js';
import type { DashboardSessionUser } from './auth/session-cookie.js';
import { CatalogDashboardModule, catalogDashboardMountPaths } from './catalog-dashboard.module.js';

/**
 * Where the console ANSWERS is the whole subject of this file.
 *
 * Every mounting failure this console has actually had was invisible to `tsc`,
 * to the build and to the module's own log line: the module reported itself
 * initialised while its controllers answered under the host's global prefix and
 * 404'd at the configured path. Nothing short of a booted application with a
 * real routing table can tell those two states apart, so every assertion below
 * is a request.
 */

/**
 * Did this path reach the console's controller, or did nothing match it?
 *
 * Both look like a 404 from the outside, and telling them apart is the entire
 * point. `CatalogUiController.index()` throws
 * `NotFoundException('Dashboard is not built...')` when the Vite output is
 * absent — which it always is here, because these tests run against TypeScript
 * sources rather than a package build — whereas an unmatched path gets Express'
 * own `Cannot GET /...`. So the MESSAGE, not the status, is the evidence.
 */
function reachedTheConsole(response: Response): boolean {
  if (response.status !== 404) return true;
  const message: unknown = response.body?.message;
  return typeof message === 'string' && !message.startsWith('Cannot ');
}

function expectMounted(response: Response): void {
  expect(
    reachedTheConsole(response),
    `expected the console to answer, got ${response.status} ${JSON.stringify(response.body)}`,
  ).toBe(true);
}

function expectNotMounted(response: Response): void {
  expect(
    reachedTheConsole(response),
    `expected nothing mounted here, got ${response.status} ${JSON.stringify(response.body)}`,
  ).toBe(false);
}

const USER: DashboardSessionUser = { id: 'someone', name: 'Someone' };

/** Mode B, the built-in login page. `login` is what puts `'login'` in `modes`. */
const loginAuth: DashboardAuthOptions = {
  secret: 'a-test-signing-secret-of-adequate-length',
  login: (username, password) => (username === 'ok' && password === 'ok' ? USER : null),
};

/** Mode A, the host mints the session itself by POSTing to `<base>/session`. */
const sessionAuth: DashboardAuthOptions = {
  secret: 'a-test-signing-secret-of-adequate-length',
  session: (raw) => (headerOf(raw, 'x-host-user') === 'someone' ? USER : null),
};

/** Node hands `set-cookie` back as an array; supertest's types say `string`. */
function setCookies(response: Response): string {
  const raw: unknown = response.headers['set-cookie'];
  if (Array.isArray(raw)) return raw.join('; ');
  return typeof raw === 'string' ? raw : '';
}

function headerOf(raw: unknown, name: string): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const headers: unknown = Reflect.get(raw, 'headers');
  if (typeof headers !== 'object' || headers === null) return undefined;
  const value: unknown = Reflect.get(headers, name);
  return typeof value === 'string' ? value : undefined;
}

async function boot(
  imports: Parameters<typeof Test.createTestingModule>[0]['imports'],
  configure?: (app: INestApplication) => void,
): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: imports ?? [] }).compile();
  const app = moduleRef.createNestApplication();
  configure?.(app);
  await app.init();
  return app;
}

describe('CatalogDashboardModule mounting (integration)', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('answers at the configured path', async () => {
    // The controllers carry `@Controller()` with no path of their own, so the
    // configured `path` reaches them only through the module's own
    // `RouterModule.register`. Drop that registration and this is the exact
    // symptom: an initialised module whose console is not at its own address.
    app = await boot([CatalogDashboardModule.forRoot({ path: '/console', auth: loginAuth })]);

    expectMounted(await request(app.getHttpServer()).get('/console'));
    await request(app.getHttpServer())
      .get('/console/login')
      .expect(200)
      .expect('content-type', /text\/html/);
  });

  it('does not answer at the default path when another one was configured', async () => {
    // The counterpart to the case above: a console that answers everywhere is
    // not evidence that `path` works. `/catalog` is the default, so it is the
    // address a mount that ignored the option would land on.
    app = await boot([CatalogDashboardModule.forRoot({ path: '/console', auth: loginAuth })]);

    expectNotMounted(await request(app.getHttpServer()).get('/catalog'));
    await request(app.getHttpServer()).get('/catalog/login').expect(404);
  });

  it('stays outside the host global prefix when excluded with catalogDashboardMountPaths()', async () => {
    // The helper's whole contract, asserted the only way that means anything:
    // by handing what it returns to `setGlobalPrefix` and asking the app where
    // the console is. A shape `exclude` accepts but never MATCHES — the
    // `{path, method}` objects this used to return — type-checks, boots, logs
    // nothing, and leaves the console reachable only under `/api`.
    app = await boot([CatalogDashboardModule.forRoot({ auth: loginAuth })], (created) => {
      created.setGlobalPrefix('api', { exclude: catalogDashboardMountPaths() });
    });

    // The base path, which the first entry covers.
    expectMounted(await request(app.getHttpServer()).get('/catalog'));
    // A path BELOW the base, which only the `{*splat}` entry covers — the SPA
    // asks for `<base>/assets/...`, so an exclusion that stops at the base
    // serves a page whose every asset 404s.
    await request(app.getHttpServer()).get('/catalog/login').expect(200);
    // And it is not ALSO under the prefix, which is what an exclusion means.
    await request(app.getHttpServer()).get('/api/catalog/login').expect(404);
  });

  it('honours a custom path in catalogDashboardMountPaths()', async () => {
    // The helper defaults `path` the same way `forRoot` does, so the two cannot
    // drift; a host that configures one and excludes the other has a console it
    // cannot reach.
    app = await boot(
      [CatalogDashboardModule.forRoot({ path: 'ops/console', auth: loginAuth })],
      (created) => {
        created.setGlobalPrefix('api', {
          exclude: catalogDashboardMountPaths({ path: 'ops/console' }),
        });
      },
    );

    expectMounted(await request(app.getHttpServer()).get('/ops/console'));
    await request(app.getHttpServer()).get('/ops/console/login').expect(200);
  });

  it('lands under the global prefix when the host forgets to exclude it', async () => {
    // Not a recommendation — the counterfactual that gives the helper its
    // reason to exist. If this ever stops being true, `catalogDashboardMountPaths`
    // is solving a problem Nest no longer has, and a host reading its docblock
    // deserves to find that out from a failing test rather than from a console
    // that mysteriously works either way.
    app = await boot([CatalogDashboardModule.forRoot({ auth: loginAuth })], (created) => {
      created.setGlobalPrefix('api');
    });

    expectNotMounted(await request(app.getHttpServer()).get('/catalog'));
    await request(app.getHttpServer()).get('/api/catalog/login').expect(200);
  });
});

describe('CatalogDashboardModule session endpoint (integration)', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('refuses an unauthenticated session mint with 401, never 500', async () => {
    // The failure this pins down: passing the RAW auth options through to the
    // endpoints instead of `resolveDashboardAuth` leaves `modes` undefined, and
    // `auth.modes.includes('session')` throws `Cannot read properties of
    // undefined (reading 'includes')`. The status is the whole point — a 500
    // here says the console is broken when what actually happened is that
    // somebody was correctly turned away.
    app = await boot([CatalogDashboardModule.forRoot({ path: '/catalog', auth: sessionAuth })]);

    const response = await request(app.getHttpServer()).post('/catalog/session').send({});

    expect(response.status).toBe(401);
    expect(JSON.stringify(response.body)).not.toMatch(/Cannot read properties/);
  });

  it('mints a session cookie when the host hook accepts', async () => {
    // The other half of the same fix: `modes` has to say `session` for the
    // endpoint to exist at all, so a resolved config is what makes the happy
    // path reachable rather than a 404.
    app = await boot([CatalogDashboardModule.forRoot({ path: '/catalog', auth: sessionAuth })]);

    const response = await request(app.getHttpServer())
      .post('/catalog/session')
      .set('x-host-user', 'someone')
      .send({});

    expect(response.status).toBe(204);
    expect(setCookies(response)).toMatch(/catalog_dashboard_session=[^;]+/);
  });

  it('404s the session endpoint for a login-only console', async () => {
    // `modes` is derived from which hooks are present, so a Mode-B-only host
    // must not expose a mint endpoint nothing can satisfy. Also the sharpest
    // proof the endpoints read a RESOLVED config: with the raw options this
    // 500s instead.
    app = await boot([CatalogDashboardModule.forRoot({ path: '/catalog', auth: loginAuth })]);

    await request(app.getHttpServer()).post('/catalog/session').send({}).expect(404);
  });

  it('rejects bad credentials with 401 and accepts good ones', async () => {
    app = await boot([CatalogDashboardModule.forRoot({ path: '/catalog', auth: loginAuth })]);

    await request(app.getHttpServer())
      .post('/catalog/login')
      .send({ username: 'ok', password: 'nope' })
      .expect(401);

    const accepted = await request(app.getHttpServer())
      .post('/catalog/login')
      .send({ username: 'ok', password: 'ok' });

    expect(accepted.status).toBe(200);
    expect(accepted.body).toEqual({ redirectTo: '/catalog' });
  });
});

describe('CatalogDashboardModule.forRootAsync (integration)', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('builds the auth from DI and mounts at the configured path', async () => {
    // The reason this form exists: validating a session means asking something
    // the host owns. Asserted through a mint that only succeeds if the injected
    // service was actually consulted.
    app = await boot([
      CatalogDashboardModule.forRootAsync({
        path: '/catalog',
        imports: [HostAuthModule],
        inject: [HostUserDirectory],
        useDashboardAuth: (directory: HostUserDirectory) => ({
          secret: 'a-test-signing-secret-of-adequate-length',
          session: (raw: unknown) => directory.find(headerOf(raw, 'x-host-user')),
        }),
      }),
    ]);

    // `forRootAsync` appends the host's `imports` to the RouterModule
    // registration `build()` put there; replacing them would leave the console
    // unrouted, which this request is what notices.
    expectMounted(await request(app.getHttpServer()).get('/catalog'));

    await request(app.getHttpServer())
      .post('/catalog/session')
      .set('x-host-user', 'someone')
      .send({})
      .expect(204);
    await request(app.getHttpServer())
      .post('/catalog/session')
      .set('x-host-user', 'nobody')
      .send({})
      .expect(401);
  });

  it('boots when the factory returns undefined', async () => {
    // A host whose signing secret is unset has no way to mint a session, and
    // "no auth mechanism" is the honest answer. Forcing a return would push it
    // to invent an auth object around an absent secret — a cookie signed with
    // nothing. So the console must still BOOT, and the endpoints must say they
    // are not there rather than fail.
    app = await boot([
      CatalogDashboardModule.forRootAsync({
        path: '/catalog',
        useDashboardAuth: () => undefined,
      }),
    ]);

    expectMounted(await request(app.getHttpServer()).get('/catalog'));
    const session = await request(app.getHttpServer()).post('/catalog/session').send({});
    expect(session.status).toBe(404);
    expect(session.status).not.toBe(500);
  });

  it('boots when an async factory resolves to undefined', async () => {
    // Same case, one await further along — the `await factory(...)` inside the
    // provider is where an unguarded `resolveDashboardAuth` would throw.
    app = await boot([
      CatalogDashboardModule.forRootAsync({
        path: '/catalog',
        useDashboardAuth: () => Promise.resolve(undefined),
      }),
    ]);

    expectMounted(await request(app.getHttpServer()).get('/catalog'));
  });

  it('fails the boot when the auth it resolves cannot mint anything', async () => {
    // `resolveDashboardAuth` fails closed on a config with neither hook, and the
    // async path must not be a way around it — a gate that can never be opened
    // is a console nobody can reach, discovered in production.
    await expect(
      boot([
        CatalogDashboardModule.forRootAsync({
          path: '/catalog',
          useDashboardAuth: () => ({ secret: 'a-test-signing-secret-of-adequate-length' }),
        }),
      ]),
    ).rejects.toThrow(/at least one of/);
  });
});

@Injectable()
class HostUserDirectory {
  find(name: string | undefined): DashboardSessionUser | null {
    return name === 'someone' ? USER : null;
  }
}

@Module({ providers: [HostUserDirectory], exports: [HostUserDirectory] })
class HostAuthModule {}
