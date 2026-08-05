import type { SealedSecret, SecretContext } from '@dudousxd/nestjs-catalog';
import { describe, expect, it } from 'vitest';
import { stubFetch, stubReplying, stubSequence } from '../test/fake-vault';
import { staticToken } from './auth';
import { VaultTransitError } from './errors';
import type { VaultFetch } from './http';
import type { VaultTransitSecretVaultOptions } from './options';
import { createVaultTransitSecretVault } from './vault.secrets';

/**
 * What this provider actually sends Vault.
 *
 * The assertions are on the **request** — path, body, headers — and not only on
 * what is done with the reply, because the reply is the half a fake controls.
 * A provider that posts to the wrong mount, forgets the token header, or sends
 * `context` to a key that cannot take one round trips perfectly against any
 * cooperative stub and fails against every real Vault. `../test/fake-vault.ts`
 * explains the boundary; `round-trip.spec.ts` is where the bytes are exercised.
 */

const CONTEXT: SecretContext = { kind: 'connection', id: 'conn-1', field: 'url' };
const base64 = (value: string): string => Buffer.from(value, 'utf8').toString('base64');

function vault(fetchImpl: VaultFetch, overrides: Partial<VaultTransitSecretVaultOptions> = {}) {
  return createVaultTransitSecretVault({
    address: 'https://vault.test',
    auth: staticToken('test-token'),
    fetch: fetchImpl,
    // Zero, so a retry test is a test of the retry decision rather than of how
    // long vitest is prepared to wait.
    retryBaseDelayMs: 0,
    ...overrides,
  });
}

/** A ciphertext-shaped string, for the tests that never reach the crypto. */
const CIPHERTEXT = `vault:v1:${base64('opaque')}`;

function sealed(overrides: Partial<SealedSecret> = {}): SealedSecret {
  return {
    vault: 'vault-transit',
    keyId: 'transit/catalog-secrets',
    ciphertext: CIPHERTEXT,
    ...overrides,
  };
}

/** Awaits a rejection and hands back the typed error, so a test can assert on
 *  `kind` without an assertion or an `any`. */
async function failure(promise: Promise<unknown>): Promise<VaultTransitError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof VaultTransitError) return error;
    throw error;
  }
  throw new Error('expected the call to fail, and it did not');
}

describe('seal', () => {
  it('posts the base64 plaintext to the configured mount and key', async () => {
    const { fetch, calls } = stubReplying({ body: { data: { ciphertext: CIPHERTEXT } } });

    await vault(fetch).seal('hunter2', CONTEXT);

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe('https://vault.test/v1/transit/encrypt/catalog-secrets');
    expect(call?.method).toBe('POST');
    expect(call?.body).toEqual({ plaintext: base64('hunter2') });
    expect(call?.headers['X-Vault-Token']).toBe('test-token');
    expect(call?.headers['Content-Type']).toBe('application/json');
    expect(call?.headers['X-Vault-Request']).toBe('true');
  });

  it('records the mount and key as keyId, and stores the ciphertext verbatim', async () => {
    // `vault:v7:` — not base64, colons and all. The contract's comment says the
    // field holds base64; Transit's format is what actually goes in. See
    // transit.ts, and the README's "what did not fit".
    const transitCiphertext = `vault:v7:${base64('whatever Vault produced')}`;
    const { fetch } = stubReplying({ body: { data: { ciphertext: transitCiphertext } } });

    const result = await vault(fetch, { mount: 'platform/transit', key: 'prod' }).seal(
      'p',
      CONTEXT,
    );

    expect(result).toEqual({
      vault: 'vault-transit',
      keyId: 'platform/transit/prod',
      ciphertext: transitCiphertext,
    });
  });

  it('sends no namespace header when none is configured', async () => {
    const { fetch, calls } = stubReplying({ body: { data: { ciphertext: CIPHERTEXT } } });

    await vault(fetch).seal('p', CONTEXT);

    // Absent, not empty: an empty X-Vault-Namespace is a namespace called "".
    expect('X-Vault-Namespace' in (calls[0]?.headers ?? {})).toBe(false);
  });

  it('sends the namespace header when one is configured', async () => {
    const { fetch, calls } = stubReplying({ body: { data: { ciphertext: CIPHERTEXT } } });

    await vault(fetch, { namespace: 'team-a' }).seal('p', CONTEXT);

    expect(calls[0]?.headers['X-Vault-Namespace']).toBe('team-a');
  });

  it('chooses the key with keyFor when one is given', async () => {
    const { fetch, calls } = stubReplying({ body: { data: { ciphertext: CIPHERTEXT } } });

    const result = await vault(fetch, {
      keyFor: (context) => `catalog-${context.kind}`,
    }).seal('p', CONTEXT);

    expect(calls[0]?.url).toBe('https://vault.test/v1/transit/encrypt/catalog-connection');
    expect(result.keyId).toBe('transit/catalog-connection');
  });

  it('refuses a keyFor that returns an unusable name, before calling Vault', async () => {
    const { fetch, calls } = stubReplying({ body: { data: { ciphertext: CIPHERTEXT } } });

    const error = await failure(vault(fetch, { keyFor: () => '' }).seal('p', CONTEXT));

    expect(error.kind).toBe('invalid-request');
    // The point of the check: an empty key would POST to `transit/encrypt/`,
    // which Vault answers 404 — read as a missing key rather than a bad callback.
    expect(calls).toHaveLength(0);
  });

  it('refuses to store a reply that is not a Transit ciphertext', async () => {
    // A proxy interstitial that parsed far enough to yield a string. Storing it
    // loses the secret silently; failing the save costs a retry.
    const { fetch } = stubReplying({ body: { data: { ciphertext: '<html>login</html>' } } });

    const error = await failure(vault(fetch).seal('p', CONTEXT));

    expect(error.kind).toBe('malformed-response');
  });

  it('refuses a reply with no ciphertext at all', async () => {
    const { fetch } = stubReplying({ body: { data: { key_version: 1 } } });

    expect((await failure(vault(fetch).seal('p', CONTEXT))).kind).toBe('malformed-response');
  });
});

describe('open', () => {
  it('posts the stored ciphertext to the mount and key its keyId names', async () => {
    const { fetch, calls } = stubReplying({ body: { data: { plaintext: base64('hunter2') } } });

    const plaintext = await vault(fetch).open(sealed(), CONTEXT);

    expect(plaintext).toBe('hunter2');
    expect(calls[0]?.url).toBe('https://vault.test/v1/transit/decrypt/catalog-secrets');
    expect(calls[0]?.body).toEqual({ ciphertext: CIPHERTEXT });
  });

  it('reads the key from the row, not from the configuration', async () => {
    // The asymmetry that makes moving the mount or the key survivable: `seal`
    // uses the config, `open` uses whatever the row says.
    const { fetch, calls } = stubReplying({ body: { data: { plaintext: base64('old') } } });

    const plaintext = await vault(fetch, { mount: 'new-transit', key: 'new-key' }).open(
      sealed({ keyId: 'legacy/mount/retired-key' }),
      CONTEXT,
    );

    expect(plaintext).toBe('old');
    expect(calls[0]?.url).toBe('https://vault.test/v1/legacy/mount/decrypt/retired-key');
  });

  it('refuses a row sealed by a different vault, without calling Vault', async () => {
    const { fetch, calls } = stubReplying({ body: { data: { plaintext: base64('x') } } });

    const error = await failure(vault(fetch).open(sealed({ vault: 'aws-kms' }), CONTEXT));

    expect(error.kind).toBe('invalid-request');
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['not a ciphertext at all', 'plain-old-base64=='],
    ['a version of zero', 'vault:v0:AAAA'],
    ['no version', 'vault:AAAA'],
    ['base64 with a colon in it', 'vault:v1:AA:AA'],
  ])('refuses %s, without calling Vault', async (_label, ciphertext) => {
    const { fetch, calls } = stubReplying({ body: { data: { plaintext: base64('x') } } });

    const error = await failure(vault(fetch).open(sealed({ ciphertext }), CONTEXT));

    expect(error.kind).toBe('invalid-request');
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['a traversal segment', 'transit/../../sys/seal'],
    ['no mount', 'catalog-secrets'],
    ['a trailing slash', 'transit/'],
    ['an empty segment', 'transit//key'],
    // The three below are what the character class buys over rejecting `..`:
    // each one is a *valid* path segment that rewrites the request once it is
    // interpolated into a URL carrying the catalog's Vault token.
    ['a query string', 'transit/catalog-secrets?wrap_ttl=60s'],
    ['a fragment', 'transit/catalog-secrets#/sys/seal'],
    ['a percent-encoded traversal', 'transit/%2e%2e/sys'],
  ])('refuses a keyId with %s, without calling Vault', async (_label, keyId) => {
    // These come out of a database row and are interpolated into an API path
    // that carries the catalog's own Vault token. Defence in depth.
    const { fetch, calls } = stubReplying({ body: { data: { plaintext: base64('x') } } });

    const error = await failure(vault(fetch).open(sealed({ keyId }), CONTEXT));

    expect(error.kind).toBe('invalid-request');
    expect(calls).toHaveLength(0);
  });

  it('refuses a plaintext that is not valid base64', async () => {
    // Buffer.from(x, 'base64') never throws — it drops what it cannot read and
    // returns a shorter, wrong secret. That would surface as an auth failure
    // against the source system, in another repository.
    const { fetch } = stubReplying({ body: { data: { plaintext: 'not base64 at all!!' } } });

    expect((await failure(vault(fetch).open(sealed(), CONTEXT))).kind).toBe('malformed-response');
  });
});

describe('the encryption context', () => {
  it('sends no context by default', async () => {
    // An ordinary Transit key answers 400 to a `context` it did not opt into,
    // so the default must not send one.
    const { fetch, calls } = stubReplying({ body: { data: { ciphertext: CIPHERTEXT } } });

    await vault(fetch).seal('p', CONTEXT);

    expect('context' in (calls[0]?.body ?? {})).toBe(false);
  });

  it('sends kind and field, base64, when bindContext is on', async () => {
    const { fetch, calls } = stubReplying({ body: { data: { ciphertext: CIPHERTEXT } } });

    await vault(fetch, { bindContext: true }).seal('p', CONTEXT);

    expect(calls[0]?.body.context).toBe(base64('["connection","url"]'));
  });

  it('binds the same context whether or not the row has an id yet', async () => {
    // The load-bearing one. `SecretContext.id` is absent on a first save and
    // present on every later open, so a binding that included it would seal
    // every secret unopenable — and the failure would arrive at the first
    // connector run, not at the save that caused it. Same trap for KMS.
    // Answers both shapes, because this exercises a seal and an open.
    const { fetch, calls } = stubReplying({
      body: { data: { ciphertext: CIPHERTEXT, plaintext: base64('p') } },
    });
    const bound = vault(fetch, { bindContext: true });

    await bound.seal('p', { kind: 'connection', field: 'url' });
    await bound.open(sealed(), { kind: 'connection', id: 'conn-1', field: 'url' });

    expect(calls[1]?.body.context).toBe(calls[0]?.body.context);
  });

  it('distinguishes contexts that would concatenate identically', async () => {
    // `kind:'a', field:'b:c'` and `kind:'a:b', field:'c'` must not derive the
    // same key. JSON of a fixed-length array, not string concatenation.
    const { fetch, calls } = stubReplying({ body: { data: { ciphertext: CIPHERTEXT } } });
    const bound = vault(fetch, { bindContext: true });

    await bound.seal('p', { kind: 'a', field: 'b:c' });
    await bound.seal('p', { kind: 'a:b', field: 'c' });

    expect(calls[0]?.body.context).not.toBe(calls[1]?.body.context);
  });
});

describe('retrying', () => {
  it('retries an open that Vault could not serve, and succeeds', async () => {
    const { fetch, calls } = stubSequence([
      { status: 503, body: { errors: ['Vault is sealed'] } },
      { body: { data: { plaintext: base64('hunter2') } } },
    ]);

    expect(await vault(fetch).open(sealed(), CONTEXT)).toBe('hunter2');
    expect(calls).toHaveLength(2);
  });

  it('gives up on an open after openAttempts', async () => {
    const { fetch, calls } = stubReplying({ status: 503, body: { errors: ['Vault is sealed'] } });

    const error = await failure(vault(fetch, { openAttempts: 3 }).open(sealed(), CONTEXT));

    expect(error.kind).toBe('unavailable');
    expect(error.retryable).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it('does not retry an open Vault refused outright', async () => {
    // A trimmed key version or an unparseable ciphertext will refuse identically
    // on the third attempt, and spending the budget replaces a fast accurate
    // error with a slow one.
    const { fetch, calls } = stubReplying({
      status: 400,
      body: { errors: ['ciphertext version is less than the minimum decryption version'] },
    });

    const error = await failure(vault(fetch, { openAttempts: 3 }).open(sealed(), CONTEXT));

    expect(error.kind).toBe('rejected');
    expect(error.retryable).toBe(false);
    expect(error.vaultErrors).toEqual([
      'ciphertext version is less than the minimum decryption version',
    ]);
    expect(calls).toHaveLength(1);
  });

  it('does not retry a seal', async () => {
    // A person is waiting and nothing was written, so the cheapest correct
    // recovery is to report it and let them press the button again.
    const { fetch, calls } = stubReplying({ status: 503, body: { errors: ['Vault is sealed'] } });

    await failure(vault(fetch).seal('p', CONTEXT));

    expect(calls).toHaveLength(1);
  });

  it('retries a seal when a host asks it to', async () => {
    // Proves the previous test pins the default rather than an inability.
    const { fetch, calls } = stubSequence([
      { status: 503, body: { errors: ['Vault is sealed'] } },
      { body: { data: { ciphertext: CIPHERTEXT } } },
    ]);

    await vault(fetch, { sealAttempts: 2 }).seal('p', CONTEXT);

    expect(calls).toHaveLength(2);
  });

  it('reports an unreachable Vault as retryable', async () => {
    const fetch: VaultFetch = () => Promise.reject(new TypeError('fetch failed'));

    const error = await failure(vault(fetch, { openAttempts: 2 }).open(sealed(), CONTEXT));

    expect(error.kind).toBe('unreachable');
    expect(error.retryable).toBe(true);
  });

  it('does not retry a rejected token when the strategy cannot mint another', async () => {
    // staticToken cannot re-login, so a 403 is terminal and says so at once
    // rather than after three round trips.
    const { fetch, calls } = stubFetch(() => ({
      status: 403,
      body: { errors: ['permission denied'] },
    }));

    const error = await failure(vault(fetch, { openAttempts: 3 }).open(sealed(), CONTEXT));

    expect(error.kind).toBe('forbidden');
    expect(error.retryable).toBe(false);
    expect(calls).toHaveLength(1);
  });
});
