import { type SecretContext, isSealedSecret } from '@dudousxd/nestjs-catalog';
import { describe, expect, it } from 'vitest';
import { fakeTransitVault } from '../test/fake-vault';
import { staticToken } from './auth';
import { VaultTransitError } from './errors';
import type { VaultFetch } from './http';
import type { VaultTransitSecretVaultOptions } from './options';
import { ciphertextKeyVersion } from './transit';
import { createVaultTransitSecretVault } from './vault.secrets';

/**
 * A whole seal/open round trip through a Transit engine that really transforms
 * the bytes.
 *
 * The request-shape assertions live in `vault.secrets.spec.ts` and they cannot
 * catch an encoding bug: a provider that base64-encodes twice, or reads Vault's
 * `plaintext` as UTF-8 rather than base64, sends a perfectly well-shaped request
 * and round trips perfectly against a fake that echoes. So the fake here derives
 * a keystream from the key path, the version and the context, XORs the plaintext
 * under it and checks an embedded digest on the way back — which means a wrong
 * encoding comes back as a wrong secret or a rejected ciphertext, exactly as it
 * would against Vault. See `../test/fake-vault.ts`.
 *
 * The rotation tests are the reason this file is worth its length. "Does `open`
 * handle a rewrapped ciphertext" is not answerable by inspection — the version
 * is inside the ciphertext, so the claim is about Vault's behaviour and the only
 * honest way to check it is to rotate a key, rewrap a row, and open it.
 */

const KEY_PATH = 'transit/catalog-secrets';
const CONTEXT: SecretContext = { kind: 'connection', id: 'conn-1', field: 'url' };

function vault(fetchImpl: VaultFetch, overrides: Partial<VaultTransitSecretVaultOptions> = {}) {
  return createVaultTransitSecretVault({
    address: 'https://vault.test',
    auth: staticToken('test-token'),
    fetch: fetchImpl,
    retryBaseDelayMs: 0,
    ...overrides,
  });
}

describe('a round trip through a Transit engine that really encrypts', () => {
  it.each([
    ['an ASCII password', 'hunter2'],
    // Multibyte, because this is exactly what a double-encode or a UTF-16
    // assumption mangles while ASCII sails through.
    ['a password with accents and an emoji', 'sénha-🔐-münchen'],
    ['a connection URL', 'postgres://catalog:p%40ss w0rd@db.internal:5432/warehouse?ssl=true'],
    ['a PEM-ish blob with newlines', '-----BEGIN KEY-----\nabc\ndef==\n-----END KEY-----\n'],
    ['a single character', 'x'],
    ['a long secret', 'z'.repeat(4096)],
  ])('returns %s unchanged', async (_label, plaintext) => {
    const transit = fakeTransitVault();
    const subject = vault(transit.fetch);

    const opened = await subject.open(await subject.seal(plaintext, CONTEXT), CONTEXT);

    expect(opened).toBe(plaintext);
  });

  it('really encrypts — the ciphertext does not contain the plaintext', async () => {
    // Guards the fake as much as the provider: a fake that echoed would pass
    // every test above, and this is the one it would fail.
    const transit = fakeTransitVault();

    const result = await vault(transit.fetch).seal('hunter2', CONTEXT);

    expect(result.ciphertext).not.toContain('hunter2');
    expect(result.ciphertext).not.toContain(Buffer.from('hunter2').toString('base64'));
    expect(result.ciphertext).toMatch(/^vault:v1:/);
  });

  it('survives the json column, and the catalog recognises what comes back', async () => {
    // What the store actually does: `SealedSecret` goes into a `json` column,
    // comes back out as `unknown`, and `isSealedSecret` decides whether it is a
    // sealed value or an ordinary config string. Worth pinning from this side
    // because Transit's ciphertext is `vault:v1:...` rather than the base64 the
    // field's comment describes — if that guard ever tightened to validate
    // base64, every row this provider writes would stop being recognised and
    // would be served to callers as a config value instead. This is the test
    // that would go red.
    const transit = fakeTransitVault();
    const subject = vault(transit.fetch);

    const stored: unknown = JSON.parse(JSON.stringify(await subject.seal('hunter2', CONTEXT)));

    expect(isSealedSecret(stored)).toBe(true);
    if (!isSealedSecret(stored)) throw new Error('unreachable');
    expect(await subject.open(stored, CONTEXT)).toBe('hunter2');
  });
});

describe('rotation', () => {
  it('opens a ciphertext sealed before the key was rotated', async () => {
    // Nothing has to happen for this to work: Transit keeps old versions
    // decryptable and reads the version out of the ciphertext itself.
    const transit = fakeTransitVault();
    const subject = vault(transit.fetch);
    const before = await subject.seal('hunter2', CONTEXT);

    transit.rotate(KEY_PATH);

    expect(await subject.open(before, CONTEXT)).toBe('hunter2');
  });

  it('seals under the new version after a rotation, with the same keyId', async () => {
    const transit = fakeTransitVault();
    const subject = vault(transit.fetch);

    transit.rotate(KEY_PATH);
    const after = await subject.seal('hunter2', CONTEXT);

    expect(ciphertextKeyVersion(after.ciphertext)).toBe(2);
    // The version is in the ciphertext and NOT in keyId — deliberately, so a
    // rewrap cannot leave the column disagreeing with the value it describes.
    expect(after.keyId).toBe(KEY_PATH);
  });

  it('opens a ciphertext that was rewrapped to a newer version', async () => {
    // The question the brief asked outright. `open` needs no change: the
    // rewrapped ciphertext says v2, Vault picks v2, and keyId is untouched.
    const transit = fakeTransitVault();
    const subject = vault(transit.fetch);
    const original = await subject.seal('hunter2', CONTEXT);
    transit.rotate(KEY_PATH);

    const rewrapped = await subject.rewrap(original, CONTEXT);

    expect(ciphertextKeyVersion(original.ciphertext)).toBe(1);
    expect(ciphertextKeyVersion(rewrapped.ciphertext)).toBe(2);
    expect(rewrapped.keyId).toBe(original.keyId);
    expect(rewrapped.vault).toBe(original.vault);
    expect(await subject.open(rewrapped, CONTEXT)).toBe('hunter2');
  });

  it('rewraps without the plaintext ever appearing in a request or a reply', async () => {
    // The capability `CatalogSecretVault` has no verb for. If a rotation had to
    // go through open+seal, the plaintext would be in this list.
    const transit = fakeTransitVault();
    const subject = vault(transit.fetch);
    const original = await subject.seal('hunter2', CONTEXT);
    transit.rotate(KEY_PATH);
    const callsBefore = transit.calls.length;

    await subject.rewrap(original, CONTEXT);

    const rewrapCalls = transit.calls.slice(callsBefore);
    expect(rewrapCalls).toHaveLength(1);
    expect(rewrapCalls[0]?.url).toBe('https://vault.test/v1/transit/rewrap/catalog-secrets');
    expect(JSON.stringify(rewrapCalls)).not.toContain(Buffer.from('hunter2').toString('base64'));
  });

  it('cannot open a row left behind when min_decryption_version is raised', async () => {
    // The one thing rotation does NOT make free, and the reason the README says
    // rewrap before you trim. Vault cannot warn: it does not know the rows exist.
    const transit = fakeTransitVault();
    const subject = vault(transit.fetch);
    const stale = await subject.seal('hunter2', CONTEXT);
    transit.rotate(KEY_PATH);
    transit.setMinDecryptionVersion(KEY_PATH, 2);

    await expect(subject.open(stale, CONTEXT)).rejects.toThrowError(VaultTransitError);
    // A row that WAS rewrapped before the trim survives it.
    transit.setMinDecryptionVersion(KEY_PATH, 1);
    const rewrapped = await subject.rewrap(stale, CONTEXT);
    transit.setMinDecryptionVersion(KEY_PATH, 2);
    expect(await subject.open(rewrapped, CONTEXT)).toBe('hunter2');
  });
});

describe('the encryption context, against a key that derives from it', () => {
  it('round trips when the context matches', async () => {
    const transit = fakeTransitVault();
    const subject = vault(transit.fetch, { bindContext: true });

    const result = await subject.seal('hunter2', { kind: 'connection', field: 'url' });

    expect(await subject.open(result, { kind: 'connection', id: 'c1', field: 'url' })).toBe(
      'hunter2',
    );
  });

  it('refuses a ciphertext replayed under a different field', async () => {
    // The property the contract's docblock offers as the motivation for passing
    // SecretContext to both halves. It holds — for kind and field.
    const transit = fakeTransitVault();
    const subject = vault(transit.fetch, { bindContext: true });
    const forUrl = await subject.seal('hunter2', { kind: 'connection', field: 'url' });

    await expect(
      subject.open(forUrl, { kind: 'connection', field: 'password' }),
    ).rejects.toThrowError(VaultTransitError);
  });

  it('does NOT distinguish two rows of the same kind and field', async () => {
    // Recorded as a limitation rather than asserted as a feature: `id` cannot be
    // bound, because it is absent on a first save. So a ciphertext lifted from
    // one connection's `url` column opens perfectly in another's. Every provider
    // against this contract has this property; the README says so.
    const transit = fakeTransitVault();
    const subject = vault(transit.fetch, { bindContext: true });
    const rowOne = await subject.seal('hunter2', { kind: 'connection', id: 'c1', field: 'url' });

    const openedAsRowTwo = await subject.open(rowOne, {
      kind: 'connection',
      id: 'c2',
      field: 'url',
    });

    expect(openedAsRowTwo).toBe('hunter2');
  });
});
