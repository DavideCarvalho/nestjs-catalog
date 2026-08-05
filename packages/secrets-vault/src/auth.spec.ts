import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stubFetch, stubReplying, stubSequence } from '../test/fake-vault';
import { VaultSession, appRoleAuth, kubernetesAuth, staticToken } from './auth';
import { VaultTransitError } from './errors';
import { VaultHttp } from './http';
import type { VaultFetch } from './http';

/**
 * Getting a token, keeping it, and noticing when it stopped working.
 *
 * Every assertion here is on what went to Vault. A login is the one request in
 * this package that carries a credential in its *body*, so "did we post the
 * secret_id to the right mount, and did we then stop posting it" is the whole
 * behaviour — and it is invisible from the outside, because a session that
 * re-logs-in on every single call works perfectly and merely burns an AppRole's
 * use count.
 */

const login = (token: string, leaseSeconds: number) => ({
  body: { auth: { client_token: token, lease_duration: leaseSeconds, renewable: true } },
});

function httpFor(fetchImpl: VaultFetch): VaultHttp {
  return new VaultHttp({ address: 'https://vault.test', fetch: fetchImpl, timeoutMs: 1_000 });
}

async function failure(promise: Promise<unknown>): Promise<VaultTransitError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof VaultTransitError) return error;
    throw error;
  }
  throw new Error('expected the call to fail, and it did not');
}

describe('the login backends', () => {
  it('posts role_id and secret_id to the AppRole mount', async () => {
    const { fetch, calls } = stubReplying(login('s.approle', 3_600));

    const grant = await appRoleAuth({ roleId: 'r-1', secretId: 's-1' }).login(httpFor(fetch));

    expect(calls[0]?.url).toBe('https://vault.test/v1/auth/approle/login');
    expect(calls[0]?.body).toEqual({ role_id: 'r-1', secret_id: 's-1' });
    // The login itself carries no token — it is the request that has none yet.
    expect('X-Vault-Token' in (calls[0]?.headers ?? {})).toBe(false);
    expect(grant).toEqual({ token: 's.approle', leaseDurationSeconds: 3_600 });
  });

  it('honours a non-default AppRole mount', async () => {
    const { fetch, calls } = stubReplying(login('s.approle', 60));

    await appRoleAuth({ roleId: 'r', secretId: 's', mount: 'approle-prod' }).login(httpFor(fetch));

    expect(calls[0]?.url).toBe('https://vault.test/v1/auth/approle-prod/login');
  });

  it('posts the role and the projected JWT to the Kubernetes mount', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vault-k8s-'));
    const jwtPath = join(directory, 'token');
    await writeFile(jwtPath, 'eyJhbGc.first\n', 'utf8');
    const { fetch, calls } = stubReplying(login('s.k8s', 900));

    await kubernetesAuth({ role: 'catalog', jwtPath }).login(httpFor(fetch));

    expect(calls[0]?.url).toBe('https://vault.test/v1/auth/kubernetes/login');
    // Trimmed: the file ends with a newline and Vault rejects the JWT with it.
    expect(calls[0]?.body).toEqual({ role: 'catalog', jwt: 'eyJhbGc.first' });
  });

  it('re-reads the projected JWT on every login', async () => {
    // The kubelet rewrites this file in place as the token nears expiry. A JWT
    // read once at construction is refused hours later, with nothing having
    // changed and no deploy to blame.
    const directory = await mkdtemp(join(tmpdir(), 'vault-k8s-'));
    const jwtPath = join(directory, 'token');
    await writeFile(jwtPath, 'first', 'utf8');
    const { fetch, calls } = stubReplying(login('s.k8s', 900));
    const auth = kubernetesAuth({ role: 'catalog', jwtPath });

    await auth.login(httpFor(fetch));
    await writeFile(jwtPath, 'second', 'utf8');
    await auth.login(httpFor(fetch));

    expect(calls[0]?.body.jwt).toBe('first');
    expect(calls[1]?.body.jwt).toBe('second');
  });

  it('reports a missing projected token as permanent, not as a network failure', async () => {
    const { fetch, calls } = stubReplying(login('s.k8s', 900));

    const error = await failure(
      kubernetesAuth({ role: 'catalog', jwtPath: '/nonexistent/token' }).login(httpFor(fetch)),
    );

    // Retrying will not make a pod spec correct.
    expect(error.kind).toBe('invalid-request');
    expect(error.retryable).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('refuses a login reply with no client token', async () => {
    const { fetch } = stubReplying({ body: { auth: { lease_duration: 60 } } });

    expect(
      (await failure(appRoleAuth({ roleId: 'r', secretId: 's' }).login(httpFor(fetch)))).kind,
    ).toBe('malformed-response');
  });

  it('says plainly that a static token cannot be renewed', () => {
    expect(staticToken('s.static').canRelogin).toBe(false);
    expect(appRoleAuth({ roleId: 'r', secretId: 's' }).canRelogin).toBe(true);
    expect(kubernetesAuth({ role: 'r' }).canRelogin).toBe(true);
  });

  it('refuses an empty static token at construction', () => {
    expect(() => staticToken('')).toThrowError(TypeError);
  });
});

describe('the cached session', () => {
  it('logs in once and reuses the token', async () => {
    const { fetch, calls } = stubReplying(login('s.first', 3_600));
    const session = new VaultSession({
      auth: appRoleAuth({ roleId: 'r', secretId: 's' }),
      http: httpFor(fetch),
    });

    expect(await session.token()).toBe('s.first');
    expect(await session.token()).toBe('s.first');

    expect(calls).toHaveLength(1);
  });

  it('logs in once for concurrent callers', async () => {
    // A cold start opening forty connectors at once must not open forty logins:
    // that is how an AppRole with secret_id_num_uses burns out in a second.
    const { fetch, calls } = stubReplying(login('s.first', 3_600));
    const session = new VaultSession({
      auth: appRoleAuth({ roleId: 'r', secretId: 's' }),
      http: httpFor(fetch),
    });

    const tokens = await Promise.all(Array.from({ length: 20 }, () => session.token()));

    expect(new Set(tokens)).toEqual(new Set(['s.first']));
    expect(calls).toHaveLength(1);
  });

  it('does not cache a failed login', async () => {
    // A rejected promise left in the single-flight slot would make one failed
    // login the permanent answer for the life of the process.
    const { fetch, calls } = stubSequence([
      { status: 503, body: { errors: ['Vault is sealed'] } },
      login('s.later', 3_600),
    ]);
    const session = new VaultSession({
      auth: appRoleAuth({ roleId: 'r', secretId: 's' }),
      http: httpFor(fetch),
    });

    await failure(session.token());

    expect(await session.token()).toBe('s.later');
    expect(calls).toHaveLength(2);
  });

  it('refreshes before the lease runs out rather than after', async () => {
    let now = 1_000_000;
    const { fetch, calls } = stubSequence([login('s.first', 100), login('s.second', 100)]);
    const session = new VaultSession({
      auth: appRoleAuth({ roleId: 'r', secretId: 's' }),
      http: httpFor(fetch),
      now: () => now,
    });

    expect(await session.token()).toBe('s.first');
    // 80s in: 20s left of a 100s lease, and the floor is 10s, so still good.
    now += 80_000;
    expect(await session.token()).toBe('s.first');
    // 95s in: 5s left, inside the 10s floor. Handing this out would mean
    // presenting a token that expires mid-flight.
    now += 15_000;
    expect(await session.token()).toBe('s.second');
    expect(calls).toHaveLength(2);
  });

  it('keeps a floor under the refresh window, so a short lease is not cut too fine', async () => {
    // A fraction alone is wrong at the short end: a tenth of a 20-second lease
    // is two seconds, which is less than one round trip to Vault plus the work
    // the token was fetched for. The floor is what stops a token being handed
    // out that expires in flight.
    let now = 1_000_000;
    const { fetch, calls } = stubSequence([login('s.first', 20), login('s.second', 20)]);
    const session = new VaultSession({
      auth: appRoleAuth({ roleId: 'r', secretId: 's' }),
      http: httpFor(fetch),
      now: () => now,
    });

    expect(await session.token()).toBe('s.first');
    // 12s into a 20s lease: 8s left, past the 10s floor though well inside the
    // 2s the fraction would allow.
    now += 12_000;

    expect(await session.token()).toBe('s.second');
    expect(calls).toHaveLength(2);
  });

  it('keeps a token Vault gave no lease for', async () => {
    // lease_duration 0 means "Vault told us nothing", never "expires now".
    let now = 1_000_000;
    const { fetch, calls } = stubReplying(login('s.root', 0));
    const session = new VaultSession({
      auth: appRoleAuth({ roleId: 'r', secretId: 's' }),
      http: httpFor(fetch),
      now: () => now,
    });

    await session.token();
    now += 86_400_000;

    expect(await session.token()).toBe('s.root');
    expect(calls).toHaveLength(1);
  });

  it('re-logs-in once when Vault rejects the cached token', async () => {
    // A revoked token, or a lease shorter than Vault reported. The caller must
    // not have to know tokens exist.
    let attempt = 0;
    const { fetch, calls } = stubFetch((call) => {
      if (call.url.endsWith('/login')) return login(`s.${attempt}`, 3_600);
      if (call.headers['X-Vault-Token'] === 's.0') {
        return { status: 403, body: { errors: ['permission denied'] } };
      }
      return { body: { data: { plaintext: 'b2s=' } } };
    });
    const session = new VaultSession({
      auth: {
        method: 'test',
        canRelogin: true,
        login: async (http) => {
          const grant = await appRoleAuth({ roleId: 'r', secretId: 's' }).login(http);
          attempt += 1;
          return grant;
        },
      },
      http: httpFor(fetch),
    });

    const result = await session.withToken((token) =>
      httpFor(fetch).post('transit/decrypt/k', { ciphertext: 'vault:v1:AA==' }, token),
    );

    expect(result).toEqual({ data: { plaintext: 'b2s=' } });
    expect(calls.map((call) => call.url.endsWith('/login'))).toEqual([true, false, true, false]);
  });

  it('re-logs-in exactly once, never twice', async () => {
    // A second 403 with a token minted seconds ago is a policy problem, and
    // repeating it turns a clear "permission denied" into a slow one.
    const { fetch, calls } = stubFetch((call) =>
      call.url.endsWith('/login')
        ? login('s.always', 3_600)
        : { status: 403, body: { errors: ['permission denied'] } },
    );
    const session = new VaultSession({
      auth: appRoleAuth({ roleId: 'r', secretId: 's' }),
      http: httpFor(fetch),
    });

    const error = await failure(
      session.withToken((token) => httpFor(fetch).post('transit/decrypt/k', {}, token)),
    );

    expect(error.kind).toBe('forbidden');
    expect(calls.filter((call) => call.url.endsWith('/login'))).toHaveLength(2);
  });

  it('does not re-login for a strategy that cannot mint a token', async () => {
    const { fetch, calls } = stubReplying({ status: 403, body: { errors: ['permission denied'] } });
    const session = new VaultSession({ auth: staticToken('s.static'), http: httpFor(fetch) });

    await failure(
      session.withToken((token) => httpFor(fetch).post('transit/decrypt/k', {}, token)),
    );

    expect(calls).toHaveLength(1);
  });

  it('does not re-login for a failure that is not about the token', async () => {
    const { fetch, calls } = stubFetch((call) =>
      call.url.endsWith('/login')
        ? login('s.first', 3_600)
        : { status: 503, body: { errors: ['Vault is sealed'] } },
    );
    const session = new VaultSession({
      auth: appRoleAuth({ roleId: 'r', secretId: 's' }),
      http: httpFor(fetch),
    });

    await failure(
      session.withToken((token) => httpFor(fetch).post('transit/decrypt/k', {}, token)),
    );

    expect(calls.filter((call) => call.url.endsWith('/login'))).toHaveLength(1);
  });
});
