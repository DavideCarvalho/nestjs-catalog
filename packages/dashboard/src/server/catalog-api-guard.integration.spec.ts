import type { INestApplication } from '@nestjs/common';
/**
 * `CatalogApiSessionGuard`, applied by a host to its own API.
 *
 * The guard documented itself as gating `CatalogApiController` — a class that exists nowhere in
 * this repo — and was bound to nothing but a barrel re-export. That left two readings: dead code,
 * or a primitive a host is meant to apply. It is the second, because the API it guards is mounted
 * in the HOST's tree by `CatalogModule` and deliberately not proxied through this console; there
 * is no controller here for the module to stamp it on.
 *
 * A primitive nobody can apply is still dead, though, and that is what this file pins — from the
 * host's side, through a real injector and a real routing table, because none of it is visible to
 * `tsc`. Both ways of applying it are here, and they do not have the same requirements: the
 * decorator form resolves off the exported `DASHBOARD_AUTH` alone, while reaching an INSTANCE for
 * `useGlobalGuards` needs the class to be a provider this module exports. The second is how a host
 * guards a whole API surface instead of remembering every controller on it, and it threw until the
 * module started declaring the guard.
 *
 * Its own file, like the other guard specs: `UseGuards` appends to metadata on classes shared by
 * every app booted in a worker, and Vitest isolates files rather than tests. The controller here
 * is local to this file, so nothing leaks either way — but the fence is cheap and the alternative
 * is a debugging session.
 */
import { Controller, Get, Module, UseGuards } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { CatalogDashboardModule } from './catalog-dashboard.module.js';
import { CatalogApiSessionGuard } from './catalog-session.guard.js';

const SECRET = 'a-signing-key-long-enough-to-be-plausible-0123456789';

/** Stands in for the catalog's API: mounted by the host, guarded by the host, per controller. */
@Controller('api/catalog-service')
@UseGuards(CatalogApiSessionGuard)
class DecoratedApiController {
  @Get('catalog')
  snapshot() {
    return { types: [] };
  }
}

/**
 * The same API with no decorator on it at all — the host means to guard everything at once.
 *
 * A separate class, and it has to be: stamping `@UseGuards` anywhere registers the guard as an
 * injectable of the module that declared the controller, which then satisfies `app.get(...)` by
 * accident. The whole question this file answers about the module's `providers` is whether a host
 * that has NOT stamped it can still reach an instance.
 */
@Controller('api/catalog-service')
class UndecoratedApiController {
  @Get('catalog')
  snapshot() {
    return { types: [] };
  }
}

let app: INestApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

type Auth = Parameters<typeof CatalogDashboardModule.forRoot>[0]['auth'];

async function bootWith(
  controller: typeof DecoratedApiController | typeof UndecoratedApiController,
  auth: Auth,
  applyGlobally = false,
) {
  @Module({
    imports: [CatalogDashboardModule.forRoot({ path: '/catalog', ...(auth ? { auth } : {}) })],
    controllers: [controller],
  })
  class HostModule {}

  const moduleRef = await Test.createTestingModule({ imports: [HostModule] }).compile();
  app = moduleRef.createNestApplication();
  // The host pattern: pull the guard out of the container and put it in front of
  // everything. Before `init`, because a global guard registered afterwards is
  // not applied to routes already mapped.
  if (applyGlobally) app.useGlobalGuards(app.get(CatalogApiSessionGuard));
  await app.init();
  return app;
}

const boot = (auth?: Auth) => bootWith(DecoratedApiController, auth);

/** Mint the way the host frontend does: one authenticated POST, then keep the cookie. */
async function mint(booted: INestApplication): Promise<string> {
  const response = await request(booted.getHttpServer()).post('/catalog/session').expect(204);
  const cookies = response.headers['set-cookie'];
  expect(cookies, 'the mint must set a cookie').toBeTruthy();
  return (Array.isArray(cookies) ? cookies : [cookies]).map((c) => c.split(';')[0]).join('; ');
}

const AUTH = { secret: SECRET, session: () => ({ id: 'ana', name: 'Ana' }) };

describe('CatalogApiSessionGuard, applied by a host', () => {
  it('can be pulled out of the container, for a host that guards its API globally', async () => {
    // The narrower half of the claim, and the half that was actually broken.
    // `@UseGuards(CatalogApiSessionGuard)` already worked — Nest builds a class
    // enhancer from the declaring module's injector, and `DASHBOARD_AUTH` is
    // exported — but a host wanting the guard on its whole API surface reaches
    // for an INSTANCE, having stamped the decorator nowhere. `app.get` on a
    // class the module never declared throws "Nest could not find
    // CatalogApiSessionGuard element", against a class this package exports
    // from its barrel and documents as the answer to the API gap.
    const booted = await bootWith(UndecoratedApiController, AUTH, true);

    // And it guards: resolving it is only half of "a host can apply this".
    await request(booted.getHttpServer()).get('/api/catalog-service/catalog').expect(401);
  });

  it('answers 401 to a browser carrying no console session', async () => {
    const booted = await boot(AUTH);

    await request(booted.getHttpServer()).get('/api/catalog-service/catalog').expect(401);
  });

  it('lets the console SPA through on the cookie it already has', async () => {
    // The gap this closes: the SPA fetches the catalog API from a browser with
    // this cookie and no bearer token, so a host guard that understands only its
    // own tokens 401s every screen while the shell loads perfectly.
    const booted = await boot(AUTH);
    const cookie = await mint(booted);

    await request(booted.getHttpServer())
      .get('/api/catalog-service/catalog')
      .set('Cookie', cookie)
      .expect(200);
  });

  it('shuts a session the host revoked mid-flight, rather than letting it renew', async () => {
    // The sliding-renewal path, and the reason it is asserted on the API guard
    // rather than trusted from the UI guard's tests: this guard has its own
    // copy of the renew-then-decide sequence, and the failure mode of getting
    // it wrong is silent — a deactivated user keeps working, on a cookie that
    // re-issues itself every half-life, until the TTL nobody is enforcing runs
    // out. A 1s TTL puts the half-life 500ms out, which is what the wait is for.
    const booted = await boot({
      secret: SECRET,
      ttl: '1s',
      session: () => ({ id: 'ana', name: 'Ana' }),
      revalidate: () => false,
    });
    const cookie = await mint(booted);

    // Still inside the first half-life: no revalidation is due, so the session stands.
    await request(booted.getHttpServer())
      .get('/api/catalog-service/catalog')
      .set('Cookie', cookie)
      .expect(200);

    await new Promise((resolve) => setTimeout(resolve, 600));

    await request(booted.getHttpServer())
      .get('/api/catalog-service/catalog')
      .set('Cookie', cookie)
      .expect(401);
  });

  it('stays open when the host configured no `auth` at all', async () => {
    // Same contract as `CatalogUiSessionGuard`: a host that left the console
    // open has not asked for its API to be shut by this guard. Open must remain
    // something the host chose by omitting `auth`.
    const booted = await boot();

    await request(booted.getHttpServer()).get('/api/catalog-service/catalog').expect(200);
  });
});
