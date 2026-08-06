import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  DecryptCommand,
  type DecryptCommandInput,
  GenerateDataKeyCommand,
  type GenerateDataKeyCommandInput,
} from '@aws-sdk/client-kms';
import type { SealedSecret, SecretContext } from '@dudousxd/nestjs-catalog';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { unpackEnvelope } from './envelope';
import { CatalogKmsVaultError } from './errors';
import type { CatalogKmsClient } from './kms.client';
import { KmsCatalogSecretVault } from './kms.vault';
import { DEFAULT_DATA_KEY_CACHE_TTL_MS } from './options';

/**
 * No network, and no mocked crypto either.
 *
 * The two failure modes this file is built against pull in opposite directions.
 * Mock the SDK and you can assert precisely what was sent — the encryption
 * context, the key id, the blob — but the cipher is never exercised, so
 * "encrypts" is a claim nothing checks. Fake nothing and there is no way to
 * assert what was sent at all, only what came back, and **an encryption context
 * that is never asserted is an encryption context that can silently become
 * empty**: every round trip in this file would pass with the context dropped.
 *
 * So {@link FakeKms} is a real KMS-shaped implementation. It wraps data keys
 * under a master key with AES-256-GCM, binds the encryption context as AAD the
 * way KMS does, and refuses an unwrap whose context differs — while recording
 * every input for the assertions. Round trips here go through the actual
 * `createCipheriv` path in the vault; the only thing that is not real is the
 * network and the HSM behind it.
 *
 * It deliberately does **not** import `additionalAuthenticatedData` from the
 * source to serialise its own context. Sharing that function would make the two
 * sides of the binding move together, and a mutation that emptied it would round
 * trip perfectly. See {@link contextBytes}.
 */

const GOV_KEY_ARN =
  'arn:aws-us-gov:kms:us-gov-west-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab';
const KEY_ALIAS = 'alias/catalog-secrets';

/** The fake's own serialisation of an encryption context. Independent of the source's, on purpose. */
function contextBytes(context: Record<string, string> | undefined): Buffer {
  const entries = Object.entries(context ?? {}).sort((left, right) =>
    left[0].localeCompare(right[0]),
  );
  return Buffer.from(entries.map(([key, value]) => `${key}=${value}`).join('|'), 'utf8');
}

function named(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

class FakeKms implements CatalogKmsClient {
  readonly generateCalls: GenerateDataKeyCommandInput[] = [];
  readonly decryptCalls: DecryptCommandInput[] = [];
  /**
   * The exact buffer last handed out as `Plaintext`, kept so a test can look at
   * it afterwards. This stands in for the SDK's own response object — the point
   * being that the vault must *view* it rather than copy it, so that zeroing
   * reaches these bytes and not only a copy of them.
   */
  lastIssuedDataKey: Buffer | undefined;

  /** Queued failures, one per call, so a test can make the next call fail. */
  private readonly failures: Error[] = [];
  private readonly master = randomBytes(32);

  constructor(
    private readonly keyArn: string = GOV_KEY_ARN,
    /**
     * Whether the unwrap enforces the encryption context, as KMS does.
     *
     * Turned off by one test, which is the only way to see the *second* binding:
     * with KMS refusing a mismatched context there is no way to tell whether the
     * GCM AAD is doing anything, because the call never gets that far.
     */
    private readonly enforceContext: boolean = true,
  ) {}

  failNext(error: Error): void {
    this.failures.push(error);
  }

  async send(command: GenerateDataKeyCommand | DecryptCommand): Promise<unknown> {
    const failure = this.failures.shift();
    if (failure !== undefined) throw failure;

    if (command instanceof GenerateDataKeyCommand) {
      this.generateCalls.push(command.input);
      if (command.input.KeySpec !== 'AES_256') {
        throw named('ValidationException', `Unsupported KeySpec ${String(command.input.KeySpec)}`);
      }
      const dataKey = randomBytes(32);
      const wrapped = this.wrap(dataKey, command.input.EncryptionContext);
      this.lastIssuedDataKey = dataKey;
      return { KeyId: this.keyArn, Plaintext: dataKey, CiphertextBlob: wrapped };
    }

    this.decryptCalls.push(command.input);
    if (command.input.KeyId !== undefined && command.input.KeyId !== this.keyArn) {
      throw named('IncorrectKeyException', 'The key you specified did not encrypt this ciphertext');
    }
    const blob = command.input.CiphertextBlob;
    if (!(blob instanceof Uint8Array)) {
      throw named('ValidationException', 'CiphertextBlob is required');
    }
    const dataKey = this.unwrap(Buffer.from(blob), command.input.EncryptionContext);
    this.lastIssuedDataKey = dataKey;
    return { KeyId: this.keyArn, Plaintext: dataKey };
  }

  private wrap(dataKey: Buffer, context: Record<string, string> | undefined): Uint8Array {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.master, iv);
    cipher.setAAD(contextBytes(this.enforceContext ? context : {}));
    const body = Buffer.concat([cipher.update(dataKey), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  }

  private unwrap(blob: Buffer, context: Record<string, string> | undefined): Buffer {
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.master, blob.subarray(0, 12));
      decipher.setAAD(contextBytes(this.enforceContext ? context : {}));
      decipher.setAuthTag(blob.subarray(12, 28));
      return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]);
    } catch {
      throw named(
        'InvalidCiphertextException',
        'The ciphertext refers to a customer master key that does not exist, or the encryption context does not match',
      );
    }
  }
}

function vault(kms: CatalogKmsClient, overrides: Partial<{ ttl: number; name: string }> = {}) {
  return new KmsCatalogSecretVault({
    client: kms,
    key: KEY_ALIAS,
    name: overrides.name,
    dataKeyCacheTtlMs: overrides.ttl,
  });
}

const CONNECTION_URL: SecretContext = { kind: 'connection', field: 'url' };
const CONNECTION_URL_SAVED: SecretContext = { kind: 'connection', id: 'conn-1', field: 'url' };

/** A connection URL, which is the shape this vault exists to keep out of a column. */
const SECRET = 'postgres://user:pw@db.internal:5432/catalog';
const CONNECTION_PASSWORD: SecretContext = { kind: 'connection', field: 'password' };
const CONNECTOR_URL: SecretContext = { kind: 'connector', id: 'conn-1', field: 'url' };

const EXPECTED_CONTEXT = { 'catalog:kind': 'connection', 'catalog:field': 'url' };

/** Flip one bit of the byte at `offset` inside the framed ciphertext. */
function tamper(sealed: SealedSecret, offset: number): SealedSecret {
  const raw = Buffer.from(sealed.ciphertext, 'base64');
  raw[offset] = raw[offset] ^ 0x01;
  return { ...sealed, ciphertext: raw.toString('base64') };
}

describe('what the vault sends to KMS', () => {
  it('asks for a 256-bit data key under the configured key, bound to kind and field', async () => {
    const kms = new FakeKms();
    await vault(kms).seal('postgres://u:p@host/db', CONNECTION_URL);

    expect(kms.generateCalls).toHaveLength(1);
    expect(kms.generateCalls[0].KeyId).toBe(KEY_ALIAS);
    expect(kms.generateCalls[0].KeySpec).toBe('AES_256');
    expect(kms.generateCalls[0].EncryptionContext).toEqual(EXPECTED_CONTEXT);
  });

  it('never puts the row id in the encryption context, even when it has one', async () => {
    // The whole reason `id` is excluded: it is absent on a first save and
    // present on every read after. Asserting on the sent map rather than on a
    // round trip, because a round trip cannot see the difference until the day
    // a row is saved without one.
    const kms = new FakeKms();
    await vault(kms).seal('secret', CONNECTION_URL_SAVED);

    expect(kms.generateCalls[0].EncryptionContext).toEqual(EXPECTED_CONTEXT);
    expect(JSON.stringify(kms.generateCalls[0].EncryptionContext)).not.toContain('conn-1');
  });

  it('decrypts with the same context, the key the row names, and only the wrapped key', async () => {
    const kms = new FakeKms();
    const subject = vault(kms);
    const sealed = await subject.seal('postgres://u:p@host/db', CONNECTION_URL);
    await subject.open(sealed, CONNECTION_URL_SAVED);

    expect(kms.decryptCalls).toHaveLength(1);
    expect(kms.decryptCalls[0].EncryptionContext).toEqual(EXPECTED_CONTEXT);
    expect(kms.decryptCalls[0].KeyId).toBe(sealed.keyId);

    // Not the whole payload. Sending the framed envelope to KMS would be the
    // "direct encryption in disguise" bug, and it would still round trip if the
    // frame happened to be under 4 KB.
    const blob = kms.decryptCalls[0].CiphertextBlob;
    const envelope = unpackEnvelope(sealed.ciphertext);
    expect(blob).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(blob instanceof Uint8Array ? blob : []).equals(envelope.wrappedKey)).toBe(
      true,
    );
    expect(envelope.wrappedKey.byteLength).toBeLessThan(
      Buffer.from(sealed.ciphertext, 'base64').byteLength,
    );
  });

  it('refuses a context with a blank field before spending a KMS call', async () => {
    const kms = new FakeKms();
    await expect(vault(kms).seal('x', { kind: 'connection', field: '  ' })).rejects.toThrow(
      /empty `field`/,
    );
    expect(kms.generateCalls).toHaveLength(0);
  });
});

describe('which key the sealed record names', () => {
  it('records the ARN KMS resolved, not the alias it was configured with', async () => {
    const kms = new FakeKms();
    const sealed = await vault(kms).seal('secret', CONNECTION_URL);

    expect(sealed.keyId).toBe(GOV_KEY_ARN);
    expect(sealed.keyId).not.toBe(KEY_ALIAS);
  });

  it('records a GovCloud ARN verbatim, parsing no part of it', async () => {
    // `aws-us-gov` is a different partition to `aws`. Nothing in this package
    // reads an ARN, and this is the test that keeps it that way.
    const kms = new FakeKms(GOV_KEY_ARN);
    const sealed = await vault(kms).seal('secret', CONNECTION_URL);

    expect(sealed.keyId).toBe(GOV_KEY_ARN);
    expect(sealed.keyId.startsWith('arn:aws-us-gov:')).toBe(true);
  });

  it('names itself as the vault', async () => {
    const kms = new FakeKms();
    expect((await vault(kms).seal('s', CONNECTION_URL)).vault).toBe('aws-kms');
    expect((await vault(kms, { name: 'aws-kms-next' }).seal('s', CONNECTION_URL)).vault).toBe(
      'aws-kms-next',
    );
  });
});

describe('the round trip, through real AES', () => {
  it('opens what it sealed', async () => {
    const subject = vault(new FakeKms());
    const sealed = await subject.seal(SECRET, CONNECTION_URL);

    // Decoded, not as base64, and against the WHOLE secret rather than a
    // fragment of it.
    //
    // This assertion used to read `expect(sealed.ciphertext).not.toContain('pw')`,
    // and it failed roughly two runs in five — because `p` and `w` are both in
    // the base64 alphabet, so the pair turns up in random ciphertext by chance.
    // A test that fails on a coin flip teaches people that red means nothing,
    // which costs more than the assertion was ever worth.
    //
    // What it was reaching for is real and worth keeping: that the plaintext is
    // not sitting inside what gets stored. Searching the decoded BYTES for the
    // whole URL says exactly that, is deterministic, and would still fail if a
    // future vault ever wrote the secret through unencrypted — which is the
    // only bug this line can catch.
    expect(Buffer.from(sealed.ciphertext, 'base64').includes(SECRET)).toBe(false);
    await expect(subject.open(sealed, CONNECTION_URL)).resolves.toBe(SECRET);
  });

  it('opens a secret sealed before the row had an id', async () => {
    // The regression this design exists around. `SecretContext.id` is absent on
    // a first save and present on every read afterwards, so a vault that bound
    // it would seal every secret unopenable — and would pass every other test in
    // this file.
    const subject = vault(new FakeKms());
    const sealed = await subject.seal('first-save-secret', CONNECTION_URL);

    await expect(subject.open(sealed, CONNECTION_URL_SAVED)).resolves.toBe('first-save-secret');
  });

  it('carries a payload larger than KMS would encrypt directly', async () => {
    // 8 KB — twice the 4096-byte limit on `kms:Encrypt`. A vault built on direct
    // encryption fails here; this one does not notice.
    const big = 'k'.repeat(8192);
    const subject = vault(new FakeKms());
    const sealed = await subject.seal(big, CONNECTION_URL);

    await expect(subject.open(sealed, CONNECTION_URL)).resolves.toBe(big);
  });

  it('round-trips an empty string and non-ASCII text', async () => {
    const subject = vault(new FakeKms());
    for (const value of ['', 'sénha-café-🔐', 'p@ss:w/ord?x=1']) {
      const sealed = await subject.seal(value, CONNECTION_PASSWORD);
      await expect(subject.open(sealed, CONNECTION_PASSWORD)).resolves.toBe(value);
    }
  });

  it('uses a fresh nonce for every seal', async () => {
    // Belt and braces around one-data-key-per-seal. A fixed nonce is survivable
    // only for as long as no data key is ever reused, so it is exactly the
    // assumption that would turn a later decision to cache seal-side materials
    // into a catastrophic one, silently and with every test still green.
    const subject = vault(new FakeKms());
    const first = unpackEnvelope((await subject.seal('same', CONNECTION_URL)).ciphertext);
    const second = unpackEnvelope((await subject.seal('same', CONNECTION_URL)).ciphertext);

    expect(first.nonce.equals(second.nonce)).toBe(false);
  });

  it('produces a different ciphertext each time, for the same plaintext', async () => {
    // One data key per seal, one nonce per seal. Equal ciphertexts would mean
    // one of the two is being reused, which is how a database dump becomes a
    // list of which connections share a password.
    const subject = vault(new FakeKms());
    const first = await subject.seal('same', CONNECTION_URL);
    const second = await subject.seal('same', CONNECTION_URL);

    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(
      unpackEnvelope(first.ciphertext).wrappedKey.equals(
        unpackEnvelope(second.ciphertext).wrappedKey,
      ),
    ).toBe(false);
  });
});

describe('what is left in memory afterwards', () => {
  it('zeroes the data key it sealed with, in the buffer KMS handed over', async () => {
    // The vault views `response.Plaintext` rather than copying it, precisely so
    // that this is true. A `Buffer.from(view)` copy would leave the real key
    // material sitting in a live object with nothing referencing it from the
    // vault — and this assertion is the only thing that can tell the difference.
    const kms = new FakeKms();
    await vault(kms).seal('secret', CONNECTION_URL);

    expect(kms.lastIssuedDataKey).toBeDefined();
    expect(kms.lastIssuedDataKey?.equals(Buffer.alloc(32))).toBe(true);
  });

  it('zeroes an unwrapped data key too, when there is no cache to hand it to', async () => {
    const kms = new FakeKms();
    const subject = vault(kms, { ttl: 0 });
    const sealed = await subject.seal('secret', CONNECTION_URL);
    await subject.open(sealed, CONNECTION_URL);

    expect(kms.lastIssuedDataKey?.equals(Buffer.alloc(32))).toBe(true);
  });
});

describe('a ciphertext moved somewhere it does not belong', () => {
  it('cannot be opened as another field', async () => {
    const subject = vault(new FakeKms());
    const sealed = await subject.seal('the-url', CONNECTION_URL);

    await expect(subject.open(sealed, CONNECTION_PASSWORD)).rejects.toThrow(CatalogKmsVaultError);
  });

  it('cannot be opened as another kind', async () => {
    const subject = vault(new FakeKms());
    const sealed = await subject.seal('the-url', CONNECTION_URL);

    await expect(subject.open(sealed, CONNECTOR_URL)).rejects.toThrow(CatalogKmsVaultError);
  });

  it('is still refused when KMS itself does not check the context', async () => {
    // The second binding, isolated. With KMS enforcing, the unwrap fails first
    // and the GCM AAD is never reached — so with KMS permissive, this is the
    // only thing standing between a stolen or cached data key and a ciphertext
    // opened in the wrong field.
    const permissive = new FakeKms(GOV_KEY_ARN, false);
    const subject = vault(permissive);
    const sealed = await subject.seal('the-url', CONNECTION_URL);

    await expect(subject.open(sealed, CONNECTION_PASSWORD)).rejects.toThrow(/did not authenticate/);
  });

  it('is refused by name when it is addressed to another vault, without calling KMS', async () => {
    const kms = new FakeKms();
    const subject = vault(kms, { name: 'aws-kms-next' });
    const sealed: SealedSecret = { vault: 'hashicorp', keyId: 'k', ciphertext: 'AAAA' };

    await expect(subject.open(sealed, CONNECTION_URL)).rejects.toThrow(/"hashicorp"/);
    expect(kms.decryptCalls).toHaveLength(0);
  });
});

describe('a ciphertext that has been altered', () => {
  it('refuses a flipped bit in the body', async () => {
    const subject = vault(new FakeKms());
    const sealed = await subject.seal('postgres://u:p@host/db', CONNECTION_URL);
    const last = Buffer.from(sealed.ciphertext, 'base64').byteLength - 1;

    await expect(subject.open(tamper(sealed, last), CONNECTION_URL)).rejects.toThrow(
      /did not authenticate/,
    );
  });

  it('refuses a flipped bit in the wrapped data key', async () => {
    const subject = vault(new FakeKms());
    const sealed = await subject.seal('postgres://u:p@host/db', CONNECTION_URL);

    // Offset 6 is the first byte of the wrapped key: 4 bytes of magic, 2 of length.
    await expect(subject.open(tamper(sealed, 6), CONNECTION_URL)).rejects.toThrow(
      /InvalidCiphertextException/,
    );
  });

  it('refuses a value that is not a frame at all, before calling KMS', async () => {
    const kms = new FakeKms();
    const subject = vault(kms);

    await expect(
      subject.open(
        {
          vault: 'aws-kms',
          keyId: GOV_KEY_ARN,
          ciphertext: Buffer.from('nope').toString('base64'),
        },
        CONNECTION_URL,
      ),
    ).rejects.toThrow(/does not begin with "CKV1"/);
    expect(kms.decryptCalls).toHaveLength(0);
  });
});

describe('the data key cache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens the same secret twice with one Decrypt', async () => {
    const kms = new FakeKms();
    const subject = vault(kms);
    const sealed = await subject.seal('secret', CONNECTION_URL);

    await expect(subject.open(sealed, CONNECTION_URL)).resolves.toBe('secret');
    await expect(subject.open(sealed, CONNECTION_URL)).resolves.toBe('secret');

    expect(kms.decryptCalls).toHaveLength(1);
  });

  it('calls KMS again once the TTL has passed', async () => {
    const kms = new FakeKms();
    const subject = vault(kms);
    const sealed = await subject.seal('secret', CONNECTION_URL);

    await subject.open(sealed, CONNECTION_URL);
    vi.advanceTimersByTime(DEFAULT_DATA_KEY_CACHE_TTL_MS + 1);
    await expect(subject.open(sealed, CONNECTION_URL)).resolves.toBe('secret');

    expect(kms.decryptCalls).toHaveLength(2);
  });

  it('does not let constant use hold a key past its TTL', async () => {
    // The bound is "at most `ttlMs` after you revoke", which a cache that
    // re-armed on every hit would not keep — and would break for exactly the
    // most-used secret.
    const kms = new FakeKms();
    const subject = vault(kms);
    const sealed = await subject.seal('secret', CONNECTION_URL);

    for (let elapsed = 0; elapsed <= DEFAULT_DATA_KEY_CACHE_TTL_MS; elapsed += 60_000) {
      await subject.open(sealed, CONNECTION_URL);
      vi.advanceTimersByTime(60_000);
    }

    expect(kms.decryptCalls).toHaveLength(2);
  });

  it('calls KMS on every open when caching is switched off', async () => {
    const kms = new FakeKms();
    const subject = vault(kms, { ttl: 0 });
    const sealed = await subject.seal('secret', CONNECTION_URL);

    await subject.open(sealed, CONNECTION_URL);
    await subject.open(sealed, CONNECTION_URL);
    await expect(subject.open(sealed, CONNECTION_URL)).resolves.toBe('secret');

    expect(kms.decryptCalls).toHaveLength(3);
  });

  it('holds one entry per secret', async () => {
    const kms = new FakeKms();
    const subject = vault(kms);
    const first = await subject.seal('one', CONNECTION_URL);
    const second = await subject.seal('two', CONNECTION_URL);

    await subject.open(first, CONNECTION_URL);
    await subject.open(second, CONNECTION_URL);
    await expect(subject.open(first, CONNECTION_URL)).resolves.toBe('one');

    expect(kms.decryptCalls).toHaveLength(2);
  });

  it('does not let a cache hit stand in for the context check', async () => {
    // The cache is keyed by the wrapped blob *and* the context. Drop the context
    // from that key and a secret already opened under `url` would be served out
    // of cache when asked for as `password` — it would still fail the GCM tag, but
    // it would be reported as a tampered payload rather than as the context
    // violation it is, which sends an operator to the wrong place entirely.
    const kms = new FakeKms();
    const subject = vault(kms);
    const sealed = await subject.seal('the-url', CONNECTION_URL);
    await subject.open(sealed, CONNECTION_URL);

    await expect(subject.open(sealed, CONNECTION_PASSWORD)).rejects.toThrow(
      /InvalidCiphertextException/,
    );
  });

  it('forgets everything on demand, so a revocation need not be waited out', async () => {
    const kms = new FakeKms();
    const subject = vault(kms);
    const sealed = await subject.seal('secret', CONNECTION_URL);

    await subject.open(sealed, CONNECTION_URL);
    subject.forgetCachedDataKeys();
    await expect(subject.open(sealed, CONNECTION_URL)).resolves.toBe('secret');

    expect(kms.decryptCalls).toHaveLength(2);
  });
});

describe('how a KMS failure is reported', () => {
  it('marks a key-policy refusal as not worth retrying', async () => {
    const kms = new FakeKms();
    kms.failNext(named('AccessDeniedException', 'not authorized to perform kms:GenerateDataKey'));

    const error = await vault(kms)
      .seal('s', CONNECTION_URL)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(CatalogKmsVaultError);
    expect(error instanceof CatalogKmsVaultError && error.retryable).toBe(false);
    expect(error instanceof Error && error.message).toContain('GenerateDataKey');
    expect(error instanceof Error && error.message).toContain('CloudTrail');
  });

  it('marks a throttle as worth retrying', async () => {
    const kms = new FakeKms();
    kms.failNext(named('ThrottlingException', 'Rate exceeded'));

    const error = await vault(kms)
      .seal('s', CONNECTION_URL)
      .catch((thrown: unknown) => thrown);

    expect(error instanceof CatalogKmsVaultError && error.retryable).toBe(true);
  });

  it('keeps the AWS error as the cause', async () => {
    const kms = new FakeKms();
    const aws = named('KMSInvalidStateException', 'key is pending deletion');
    kms.failNext(aws);

    const error = await vault(kms)
      .seal('s', CONNECTION_URL)
      .catch((thrown: unknown) => thrown);

    expect(error instanceof CatalogKmsVaultError && error.cause).toBe(aws);
  });

  it('refuses a response with no key material rather than proceeding', async () => {
    const broken: CatalogKmsClient = { send: async () => ({ KeyId: GOV_KEY_ARN }) };

    await expect(vault(broken).seal('s', CONNECTION_URL)).rejects.toThrow(
      /returned no usable `Plaintext`/,
    );
  });

  it('refuses a client that is not a KMS client at all', async () => {
    const wrong: CatalogKmsClient = { send: async () => 'ok' };

    await expect(vault(wrong).seal('s', CONNECTION_URL)).rejects.toThrow(
      /not an AWS KMS client|returned string/,
    );
  });
});

describe('construction', () => {
  it('refuses an empty key at construction, not at the first save', async () => {
    expect(() => new KmsCatalogSecretVault({ client: new FakeKms(), key: '' })).toThrow(
      /needs a key to seal under/,
    );
  });
});
