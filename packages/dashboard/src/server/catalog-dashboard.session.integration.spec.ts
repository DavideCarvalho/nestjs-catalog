import type { INestApplication } from '@nestjs/common';
/**
 * The console is CLOSED when a host configures `auth`.
 *
 * This exists because it was not. `auth` describes how a session is minted and
 * validated, the option's docblock calls it the thing that closes an otherwise
 * open console, and `CatalogUiSessionGuard` was written to enforce it — but
 * nothing ever stamped the guard on the controller. A host that configured
 * `auth` correctly still served the console shell to anyone who could reach the
 * URL, and no test, typecheck or build said otherwise.
 *
 * Quarantined in its own file on purpose: `UseGuards` appends to metadata on
 * module-level controller classes, so guards registered by one app leak into the
 * next app booted in the same worker. Vitest isolates files, not tests.
 */
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { CatalogDashboardModule } from './catalog-dashboard.module.js';

const SECRET = 'a-signing-key-long-enough-to-be-plausible-0123456789';

let app: INestApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function boot(
  auth?: NonNullable<Parameters<typeof CatalogDashboardModule.forRoot>[0]>['auth'],
) {
  const moduleRef = await Test.createTestingModule({
    imports: [CatalogDashboardModule.forRoot({ path: '/catalog', ...(auth ? { auth } : {}) })],
  }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

describe('the console shell, once `auth` is configured', () => {
  it('refuses an anonymous visitor', async () => {
    // Mode A: the host mints the session itself, so there is no login page to
    // redirect to — the guard renders the instruction page instead. Either way
    // what must not happen is a 200 carrying the console.
    const booted = await boot({ secret: SECRET, session: () => null });

    const response = await request(booted.getHttpServer()).get('/catalog');

    expect(response.status).not.toBe(200);
  });

  it('serves a visitor who has minted a session', async () => {
    // The guard reads the COOKIE, not the `session` hook — that hook is how a
    // session is minted, not how each request is authorised. So the real flow is
    // mint, then navigate carrying what the mint set, and a test that skipped
    // the mint would be asserting the wrong thing about a guard that is working.
    const booted = await boot({ secret: SECRET, session: () => ({ id: 'ana', name: 'Ana' }) });
    const server = booted.getHttpServer();

    // 204: the mint's whole output is the Set-Cookie header, so there is no body
    // to return. Asserted as a range rather than the exact code, because which
    // 2xx it is belongs to the mint's own tests, not to this one.
    const minted = await request(server).post('/catalog/session');
    expect(minted.status).toBeGreaterThanOrEqual(200);
    expect(minted.status).toBeLessThan(300);
    const cookie = minted.headers['set-cookie'];
    expect(cookie).toBeDefined();

    // Reaching the controller is the assertion. It answers 404 because the SPA
    // bundle is not built in a test run, and that is the point: a 404 from the
    // controller means the guard let the request through, where the anonymous
    // case never got that far.
    const response = await request(server).get('/catalog').set('Cookie', cookie);

    expect(response.status).not.toBe(401);
    expect(response.status).not.toBe(302);
  });

  it('stays open when the host omitted `auth` entirely', async () => {
    // Open must remain a decision the HOST made by omitting `auth`, not one the
    // module makes by forgetting to enforce it. The guard is a documented no-op
    // in this case, and this pins that it did not become a blanket deny.
    const booted = await boot();

    const response = await request(booted.getHttpServer()).get('/catalog');

    expect(response.status).not.toBe(401);
    expect(response.status).not.toBe(302);
  });
});
