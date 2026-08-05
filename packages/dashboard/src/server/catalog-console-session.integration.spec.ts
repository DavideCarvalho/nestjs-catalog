import type { CanActivate, INestApplication } from '@nestjs/common';
import { Controller, ExecutionContext, Get, Inject, Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { CatalogDashboardModule } from './catalog-dashboard.module';
import { DASHBOARD_AUTH, type ResolvedDashboardAuth, readCatalogConsoleSession } from './index';

/**
 * The console's session, read by somebody else's guard.
 *
 * This package serves the console and mints its session, and deliberately does
 * NOT proxy the catalog's API — that surface belongs to `CatalogModule`, behind
 * whatever the host put in front of it. Which creates a gap no host can close
 * alone, and it is the gap this file exists for:
 *
 * The SPA fetches that API **from a browser**. It carries this cookie and no
 * bearer token. A host whose API guard understands only its own tokens
 * therefore answers 401 to every single screen while the console shell itself
 * loads perfectly — which reads as a broken API rather than as two auth systems
 * that were never introduced to each other. It is exactly what happened when
 * this console was first embedded in an application.
 *
 * `readCatalogConsoleSession` is the introduction. The cases below are written
 * from the host's side, because that is who has the problem.
 */

const SECRET = 'a-secret-long-enough-to-sign-with';

/** A host API guard that trusts its own token OR a console session — the real shape. */
@Injectable()
class HostApiGuard implements CanActivate {
  constructor(
    @Inject(DASHBOARD_AUTH)
    private readonly auth: ResolvedDashboardAuth | null,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp().getRequest();
    if (http.headers['x-host-token'] === 'good') return true;
    return this.auth !== null && readCatalogConsoleSession(this.auth, http) !== null;
  }
}

@Controller('api/catalog-service')
class HostApiController {
  @Get('catalog')
  snapshot() {
    return { types: [] };
  }
}

function boot(auth: NonNullable<Parameters<typeof CatalogDashboardModule.forRoot>[0]>['auth']) {
  @Module({
    imports: [CatalogDashboardModule.forRoot({ path: '/catalog', ...(auth ? { auth } : {}) })],
    controllers: [HostApiController],
    providers: [HostApiGuard],
  })
  class HostModule {}

  return Test.createTestingModule({ imports: [HostModule] })
    .compile()
    .then(async (moduleRef) => {
      const app = moduleRef.createNestApplication();
      // Applied here rather than with `@UseGuards`, so the guard resolves from
      // the module that imported the dashboard — which is the arrangement a
      // host actually has.
      app.useGlobalGuards(moduleRef.get(HostApiGuard));
      await app.init();
      return app;
    });
}

const HOST_AUTH = {
  secret: SECRET,
  session: (raw: unknown) => {
    const headers = (raw as { headers?: Record<string, unknown> }).headers ?? {};
    return headers['x-host-token'] === 'good' ? { id: 'u-1', name: 'Ana', roles: ['admin'] } : null;
  },
};

/** Mint the way the host frontend does: one authenticated POST, then keep the cookie. */
async function mint(app: INestApplication): Promise<string> {
  const response = await request(app.getHttpServer())
    .post('/catalog/session')
    .set('x-host-token', 'good')
    .expect(204);
  const cookies = response.headers['set-cookie'];
  expect(cookies, 'the mint must set a cookie').toBeTruthy();
  return (Array.isArray(cookies) ? cookies : [cookies]).map((c) => c.split(';')[0]).join('; ');
}

describe('the console session, read by the host API guard', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('lets a browser holding only the console cookie reach the host API', async () => {
    // THE case. Before `readCatalogConsoleSession` was exported there was no way
    // to write this guard at all, so every console screen 401'd against an
    // embedded catalog while the shell loaded — and the console reported it as
    // "the catalog did not load", pointing at the API.
    app = await boot(HOST_AUTH);
    const cookie = await mint(app);

    await request(app.getHttpServer())
      .get('/api/catalog-service/catalog')
      .set('Cookie', cookie)
      .expect(200);
  });

  it('refuses a request carrying neither the host token nor a session', async () => {
    app = await boot(HOST_AUTH);

    await request(app.getHttpServer()).get('/api/catalog-service/catalog').expect(403);
  });

  it('refuses a forged cookie signed with the wrong secret', async () => {
    // The whole reason to read the cookie through this function rather than to
    // parse it: it is signed, and a host that trusted its contents unverified
    // would have built an auth bypass out of a `document.cookie` assignment.
    app = await boot(HOST_AUTH);
    const other = await boot({ ...HOST_AUTH, secret: 'a-different-secret-of-good-length' });
    const foreignCookie = await mint(other);
    await other.close();

    await request(app.getHttpServer())
      .get('/api/catalog-service/catalog')
      .set('Cookie', foreignCookie)
      .expect(403);
  });

  it('reads nothing when the host configured no auth at all', async () => {
    // `DASHBOARD_AUTH` is null on an intentionally open console. A host guard
    // must not treat "no auth configured" as "everyone has a session" — the
    // console being open is not a statement about the host's API.
    app = await boot(undefined);

    await request(app.getHttpServer()).get('/api/catalog-service/catalog').expect(403);
    await request(app.getHttpServer())
      .get('/api/catalog-service/catalog')
      .set('x-host-token', 'good')
      .expect(200);
  });
});
