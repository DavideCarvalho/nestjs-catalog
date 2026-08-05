import { describe, expect, it } from 'vitest';
import {
  CATALOG_SECRET_VAULT,
  RefusingSecretVault,
  SecretOpenFailedError,
  SecretVaultNotConfiguredError,
  UNCONFIGURED_VAULT,
  isSealedSecret,
} from './catalog.secrets';
import * as barrel from './index';

/**
 * The seam a host plugs a vault into, and the two things about it that are not
 * a matter of taste: the default must refuse, and a guard must be able to tell
 * a sealed value from the plaintext that used to sit in the same column.
 *
 * Both are about the same failure. This column held passwords in plaintext for
 * every release up to now, so a deployment turning encryption on has a table
 * with both forms in it — and a library that could not distinguish them, or
 * that quietly wrote plaintext when no vault was bound, would leave a host
 * believing a column was sealed that was not.
 */

const SEALED = { vault: 'kms', keyId: 'arn:aws:kms:…:key/abc', ciphertext: 'Y2lwaGVy' };

describe('telling a sealed value from a plaintext one', () => {
  it('recognises what a vault hands back', () => {
    expect(isSealedSecret(SEALED)).toBe(true);
  });

  it('does not mistake the plaintext this column used to hold', () => {
    // The defect, stated as a value: this is exactly what was in `config.url`,
    // and a guard that said yes to it would send a connection URL to a vault to
    // be decrypted.
    expect(isSealedSecret('postgres://ana:s3cr3t@db/app')).toBe(false);
  });

  it('refuses an empty ciphertext rather than sending it to a vault', () => {
    // A `{vault, keyId, ciphertext: ''}` is not a sealed secret. Treating it as
    // one gets a decrypt failure attributed to the vault, and the operator is
    // told their vault is broken when the row is.
    expect(isSealedSecret({ ...SEALED, ciphertext: '' })).toBe(false);
    expect(isSealedSecret({ ...SEALED, vault: '' })).toBe(false);
  });

  it('refuses the shapes a JSON column can otherwise return', () => {
    // MikroORM hands back whatever is in the column, so `null`, an array and a
    // half-written object all have to be answers this can give.
    expect(isSealedSecret(null)).toBe(false);
    expect(isSealedSecret([SEALED])).toBe(false);
    expect(isSealedSecret({ vault: 'kms', keyId: 'k' })).toBe(false);
    expect(isSealedSecret({})).toBe(false);
  });

  it('accepts a ciphertext that is not base64, because one vault does not emit base64', () => {
    // HashiCorp Transit returns `vault:v1:<base64>` — two colons, not decodable
    // as base64 — and the provider stores it verbatim because the `v1` is the
    // row's only record of which key version sealed it. This field said
    // "base64" first, and a guard tightened to match would have started
    // refusing every Transit row while reporting them as "not encrypted".
    expect(isSealedSecret({ ...SEALED, ciphertext: 'vault:v1:abc+/=zzz' })).toBe(true);
    // And a KMS-shaped one, so neither vault's format is privileged.
    expect(isSealedSecret({ ...SEALED, ciphertext: 'AQICAHhwm9c=' })).toBe(true);
  });

  it('refuses an array even when it carries the three fields', () => {
    // The case the plain `[SEALED]` above does NOT reach: that one is rejected
    // because an array has no `.vault`, so it never exercises the array check
    // at all. This one does — and an array that passed would be opened, handed
    // to a vault as a ciphertext, and reported as the vault's fault.
    expect(isSealedSecret(Object.assign([], SEALED))).toBe(false);
  });
});

describe('the default vault', () => {
  it('refuses to seal, and names the token to bind', async () => {
    // THE decision in this file. A default that stored plaintext would make
    // `encryptCredentials: true` a no-op with a reassuring name — a host would
    // turn it on, watch saves succeed, and have the same column contents as
    // before. The message has to carry the token because that is the only thing
    // whoever hits this can act on.
    const vault = new RefusingSecretVault();

    await expect(
      vault.seal('postgres://ana:s3cr3t@db/app', { kind: 'connection', field: 'url' }),
    ).rejects.toThrow(/CATALOG_SECRET_VAULT/);
  });

  it('reports that refusal as one no retry can fix', async () => {
    // `retryable` is the only field the durable dispatch boundary carries
    // across, and its predicate is `error?.retryable !== false`. A missing
    // binding will be exactly as missing on the third attempt fifteen minutes
    // later, so this must not look transient.
    const error = await new RefusingSecretVault()
      .seal('x', { kind: 'connection', field: 'url' })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SecretVaultNotConfiguredError);
    expect(error).toMatchObject({ retryable: false });
  });

  it('cannot have sealed anything, so no row can name it', async () => {
    // The name is only safe to hardcode because `seal` never returns: nothing
    // can be sealed under it, so it can never be the name a stored row asks for.
    expect(new RefusingSecretVault().name).toBe(UNCONFIGURED_VAULT);
    await expect(
      new RefusingSecretVault().seal('x', { kind: 'connection', field: 'url' }),
    ).rejects.toBeInstanceOf(SecretVaultNotConfiguredError);
  });
});

describe('how an open failure reports itself', () => {
  it('is retryable unless it says otherwise', () => {
    // A vault that timed out is the same failure as a source that timed out,
    // and the connector step retries three times over fifteen minutes for
    // exactly that. Defaulting the other way turns a five-second blip into a
    // load that never ran.
    const transient = new SecretOpenFailedError('timed out', { retryable: true });

    expect(transient.retryable).toBe(true);
  });

  it('carries the cause, so the vault error is not lost behind the wrapper', () => {
    const cause = new Error('kms: ThrottlingException');
    const wrapped = new SecretOpenFailedError('could not open', { retryable: true, cause });

    expect(wrapped.cause).toBe(cause);
  });
});

describe('the barrel', () => {
  it('carries every name a vault provider has to import', () => {
    // Two provider packages are being written against this seam, and they are
    // the first consumers in this repo to compile against the published barrel.
    // A missing re-export here is invisible to every spec in this package —
    // they all import from source paths — and shows up only in somebody else's
    // build. That is the exact gap `index.barrel.spec.ts` was written after.
    for (const name of [
      'CATALOG_SECRET_VAULT',
      'isSealedSecret',
      'RefusingSecretVault',
      'SecretOpenFailedError',
      'SecretSealFailedError',
      'SecretVaultNotConfiguredError',
      'UNCONFIGURED_VAULT',
    ]) {
      expect(name in barrel).toBe(true);
    }
    expect(barrel.CATALOG_SECRET_VAULT).toBe(CATALOG_SECRET_VAULT);
  });
});
