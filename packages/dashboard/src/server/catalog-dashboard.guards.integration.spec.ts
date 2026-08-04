import type { CanActivate, INestApplication } from '@nestjs/common';
import { Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { CatalogDashboardModule } from './catalog-dashboard.module.js';

/**
 * The `guards` option, in a file of its own — and it has to be.
 *
 * `CatalogDashboardModule` applies them by calling `UseGuards(guard)` on
 * `CatalogUiController` and `CatalogAuthController` at module-DEFINITION time.
 * Those are two module-level classes shared by every mount in the process, and
 * Nest's `UseGuards` APPENDS to their metadata — so a denying guard registered
 * by one test stays stamped on the controller for every application booted
 * afterwards in the same worker. Vitest isolates test FILES, not tests, which
 * makes the file boundary the only reliable fence. Keep every denying case here,
 * and keep everything that expects the console to answer somewhere else.
 */

@Injectable()
class DenyEveryone implements CanActivate {
  canActivate(): boolean {
    return false;
  }
}

@Injectable()
class Doorman {
  admit(): boolean {
    return false;
  }
}

@Injectable()
class InjectingGuard implements CanActivate {
  constructor(private readonly doorman: Doorman) {}
  canActivate(): boolean {
    return this.doorman.admit();
  }
}

@Module({ providers: [Doorman], exports: [Doorman] })
class DoormanModule {}

async function boot(
  imports: Parameters<typeof Test.createTestingModule>[0]['imports'],
): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: imports ?? [] }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

describe('CatalogDashboardModule guards (integration)', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('shuts the console with no auth configured at all', async () => {
    // The reason `guards` is separate from `auth`: `auth` describes how a session
    // is VALIDATED, so a host that has not configured it yet has an open console
    // that can rewrite a catalog's model. A denying guard needs no secret, no DI
    // and no session — it is the fail-closed switch a host can reach for on the
    // way to configuring the real thing.
    app = await boot([
      CatalogDashboardModule.forRoot({ path: '/catalog', guards: [DenyEveryone] }),
    ]);

    await request(app.getHttpServer()).get('/catalog').expect(403);
  });

  it('shuts the session endpoints too, not just the SPA', async () => {
    // The auth controller is deliberately a SEPARATE controller so it never sits
    // behind the session guard — it is what MINTS the session. That makes it the
    // one a host-supplied guard could plausibly be forgotten on, and a console
    // whose shell is shut but whose `POST /session` still answers is not shut.
    app = await boot([
      CatalogDashboardModule.forRoot({
        path: '/catalog',
        guards: [DenyEveryone],
        auth: {
          secret: 'a-test-signing-secret-of-adequate-length',
          session: () => ({ id: 'someone' }),
          login: () => ({ id: 'someone' }),
        },
      }),
    ]);

    await request(app.getHttpServer()).post('/catalog/session').send({}).expect(403);
    await request(app.getHttpServer()).get('/catalog/login').expect(403);
    await request(app.getHttpServer())
      .post('/catalog/login')
      .send({ username: 'ok', password: 'ok' })
      .expect(403);
  });

  it('instantiates a guard from the host imports, on forRootAsync too', async () => {
    // Nest builds a guard in the injector of the module that DECLARES the
    // controller — this library's module, not the host's. `guards` is bound at
    // definition time and cannot come from DI, but what a guard INJECTS still
    // has to be resolvable from here, which is what `imports` is for. Without
    // it this fails at boot rather than at the request.
    app = await boot([
      CatalogDashboardModule.forRootAsync({
        path: '/catalog',
        guards: [InjectingGuard],
        imports: [DoormanModule],
        useDashboardAuth: () => undefined,
      }),
    ]);

    const response = await request(app.getHttpServer()).get('/catalog');
    expect(response.status).toBe(403);
  });
});
