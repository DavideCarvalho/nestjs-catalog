import { describe, expect, it } from 'vitest';
import { stubReplying } from '../test/fake-vault';
import { staticToken } from './auth';
import { VaultTransitError, classifyStatus } from './errors';
import { type VaultFetch, VaultHttp } from './http';
import { resolveOptions } from './options';

/**
 * The boundary itself: what a request looks like, and what each answer means.
 *
 * Classification is tested against the status alone, because that is what the
 * classifier reads. Vault's `errors[]` strings are prose that changes between
 * minor versions, and a classifier that read them would silently reclassify on
 * upgrade — so the test that matters is that the strings are *preserved* and
 * not *consulted*.
 */

function httpFor(fetchImpl: VaultFetch, namespace?: string): VaultHttp {
  return new VaultHttp({
    address: 'https://vault.test',
    namespace,
    fetch: fetchImpl,
    timeoutMs: 1_000,
  });
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

describe('the request', () => {
  it('adds the /v1 prefix so no caller can forget it', async () => {
    // A forgotten prefix is a 404, which reads as "the key does not exist".
    const { fetch, calls } = stubReplying({ body: { data: {} } });

    await httpFor(fetch).post('transit/encrypt/k', { plaintext: 'AA==' }, 's.token');

    expect(calls[0]?.url).toBe('https://vault.test/v1/transit/encrypt/k');
  });

  it('tolerates a trailing slash on the address', async () => {
    const { fetch, calls } = stubReplying({ body: { data: {} } });

    await new VaultHttp({
      address: 'https://vault.test///',
      fetch,
      timeoutMs: 1_000,
    }).post('transit/encrypt/k', {}, 's.token');

    expect(calls[0]?.url).toBe('https://vault.test/v1/transit/encrypt/k');
  });

  it('sends a timeout signal, so a hung Vault does not hold a worker', async () => {
    let seen: AbortSignal | undefined;
    const fetch: VaultFetch = (_url, init) => {
      seen = init.signal;
      return Promise.resolve({ status: 200, ok: true, text: () => Promise.resolve('{}') });
    };

    await httpFor(fetch).post('transit/encrypt/k', {}, 's.token');

    expect(seen).toBeInstanceOf(AbortSignal);
  });
});

describe('what an answer means', () => {
  it.each([
    [400, 'rejected', false],
    [403, 'forbidden', false],
    [404, 'not-found', false],
    [412, 'not-yet-consistent', true],
    [429, 'throttled', true],
    [500, 'unavailable', true],
    [503, 'unavailable', true],
  ])('reads %i as %s', async (status, kind, retryable) => {
    const { fetch } = stubReplying({ status, body: { errors: ['something'] } });

    const error = await failure(httpFor(fetch).post('transit/encrypt/k', {}, 's.token'));

    expect(error.kind).toBe(kind);
    expect(error.retryable).toBe(retryable);
    expect(error.status).toBe(status);
  });

  it("preserves Vault's own error strings without acting on them", async () => {
    const { fetch } = stubReplying({
      status: 400,
      body: { errors: ['ciphertext version is less than the minimum decryption version'] },
    });

    const error = await failure(httpFor(fetch).post('transit/decrypt/k', {}, 's.token'));

    expect(error.vaultErrors).toEqual([
      'ciphertext version is less than the minimum decryption version',
    ]);
    expect(error.message).toContain('minimum decryption version');
    expect(error.path).toBe('transit/decrypt/k');
  });

  it('survives an error body that is not JSON at all', async () => {
    // A load balancer's HTML error page must not replace the status the caller
    // needs with a SyntaxError thrown by the error handler.
    const { fetch } = stubReplying({ status: 502, body: '<html><body>Bad Gateway</body></html>' });

    const error = await failure(httpFor(fetch).post('transit/encrypt/k', {}, 's.token'));

    expect(error.kind).toBe('unavailable');
    expect(error.vaultErrors).toEqual([]);
  });

  it('refuses a success whose body is not a JSON object', async () => {
    const { fetch } = stubReplying({ body: '<html>login page</html>' });

    expect((await failure(httpFor(fetch).post('transit/encrypt/k', {}, 's.token'))).kind).toBe(
      'malformed-response',
    );
  });

  it('reports a fetch that threw as unreachable, keeping the cause', async () => {
    const cause = new TypeError('fetch failed');
    const fetch: VaultFetch = () => Promise.reject(cause);

    const error = await failure(httpFor(fetch).post('transit/encrypt/k', {}, 's.token'));

    expect(error.kind).toBe('unreachable');
    expect(error.retryable).toBe(true);
    // The real reason — ECONNREFUSED, a bad CA — is only ever in the cause.
    expect(error.cause).toBe(cause);
  });

  it('answers an empty 204 body as an empty object', async () => {
    const { fetch } = stubReplying({ status: 204, body: '' });

    expect(await httpFor(fetch).post('transit/encrypt/k', {}, 's.token')).toEqual({});
  });

  it('classifies an implausible status as a malformed response', () => {
    // 1xx/3xx cannot reach here through `ok`, but the classifier is exported and
    // must not answer `unavailable` to something it does not recognise.
    expect(classifyStatus(302)).toBe('malformed-response');
    expect(classifyStatus(501)).toBe('rejected');
  });
});

describe('configuration', () => {
  it('refuses an empty address at boot rather than at the first save', () => {
    expect(() => resolveOptions({ address: '', auth: staticToken('s.token') })).toThrowError(
      TypeError,
    );
  });

  it("fills in Vault's own defaults", () => {
    const resolved = resolveOptions({ address: 'https://vault.test', auth: staticToken('s.t') });

    expect(resolved.mount).toBe('transit');
    expect(resolved.key).toBe('catalog-secrets');
    expect(resolved.name).toBe('vault-transit');
    // Off by default: an ordinary Transit key answers 400 to a context.
    expect(resolved.bindContext).toBe(false);
    // Opens retry, seals do not. See options.ts for the argument.
    expect(resolved.openAttempts).toBeGreaterThan(1);
    expect(resolved.sealAttempts).toBe(1);
  });
});
