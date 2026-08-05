import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { CatalogSecretVault, SealedSecret, SecretContext } from '@dudousxd/nestjs-catalog';
import { DataKeyCache, zeroKey } from './data-key-cache';
import { additionalAuthenticatedData, encryptionContextFor } from './encryption-context';
import { NONCE_BYTES, packEnvelope, unpackEnvelope } from './envelope';
import { CatalogKmsVaultError } from './errors';
import { type CatalogKmsClient, decryptDataKey, generateDataKey } from './kms.client';
import {
  type CatalogAwsKmsVaultOptions,
  DEFAULT_DATA_KEY_CACHE_MAX_ENTRIES,
  DEFAULT_DATA_KEY_CACHE_TTL_MS,
  DEFAULT_VAULT_NAME,
} from './options';

/**
 * AES-256-GCM, and the reason it is not negotiable.
 *
 * GCM is authenticated: the tag is checked before `final()` returns, so a
 * ciphertext altered in the database fails loudly instead of decrypting to
 * plausible rubbish that gets handed to a database driver as a connection URL.
 * A `json` column that a `SELECT`-holder can also `UPDATE` is exactly the threat
 * model where an unauthenticated mode (CBC, CTR) is a bug rather than a
 * preference. It is also FIPS-approved, which is the other half of running in
 * GovCloud; nothing in this file needs a primitive that a FIPS-mode OpenSSL
 * would refuse.
 */
const CIPHER = 'aes-256-gcm';

/**
 * A {@link CatalogSecretVault} backed by AWS KMS, using envelope encryption.
 *
 * ## Envelope, not `kms:Encrypt`
 *
 * A connection URL is a few hundred bytes and fits inside KMS's 4 KB direct-
 * encryption limit, so calling `kms:Encrypt` on the payload would work today.
 * It is still the wrong shape, for three reasons that all arrive later:
 *
 * - **Every open becomes a KMS call on the payload itself**, and there is
 *   nothing to cache — the ciphertext differs per secret, so caching it would be
 *   caching the credential. With an envelope the thing that repeats is the data
 *   key, which *can* be held for a bounded time (see {@link DataKeyCache}) and
 *   which is one rung further from the secret than the secret is.
 * - **Throughput becomes a service quota.** `kms:Decrypt` is limited per region
 *   and shared with everything else in the account, so a catalog reading
 *   configuration competes with whatever else that account encrypts.
 * - **4 KB is a limit somebody will hit.** A client certificate, a service
 *   account JSON, a Kerberos keytab — all plausible things to put behind
 *   `connection.config`, all larger, and all of which would turn a working
 *   feature into a size error at the moment somebody needed it most.
 *
 * So: one `GenerateDataKey` per seal, AES-256-GCM locally, and the wrapped key
 * travels beside the ciphertext inside `SealedSecret.ciphertext` (see
 * {@link packEnvelope} for the frame).
 *
 * ## One data key per secret
 *
 * Not reused, not derived, not cached on the seal path. The AWS Encryption SDK
 * offers a caching materials manager that reuses a data key across encryptions,
 * and it is the right trade for a workload encrypting millions of records a
 * minute. A seal here happens when a human presses save on a connection form,
 * so there is no rate to relieve, and the thing reuse costs — several secrets
 * recoverable from one compromised data key — is paid in the currency this
 * package exists to protect.
 *
 * ## What is bound to what
 *
 * The secret's `kind` and `field` go into the KMS encryption context *and* into
 * the GCM additional authenticated data. `id` deliberately does not.
 * {@link encryptionContextFor} argues both at length; the short version is that
 * `SecretContext.id` is absent on a first save, so binding it would seal every
 * secret unopenable.
 */
export class KmsCatalogSecretVault implements CatalogSecretVault {
  readonly name: string;

  private readonly client: CatalogKmsClient;
  private readonly key: string;
  private readonly cache: DataKeyCache;

  constructor(options: CatalogAwsKmsVaultOptions) {
    this.client = options.client;
    this.key = requireKey(options.key);
    this.name = options.name ?? DEFAULT_VAULT_NAME;
    this.cache = new DataKeyCache(
      options.dataKeyCacheTtlMs ?? DEFAULT_DATA_KEY_CACHE_TTL_MS,
      options.dataKeyCacheMaxEntries ?? DEFAULT_DATA_KEY_CACHE_MAX_ENTRIES,
    );
  }

  /**
   * Wrap a secret. One KMS call, then local AES.
   *
   * The data key is zeroed on the way out and is never cached — see the class
   * note. It is zeroed in a `finally` so that a failure between generating it
   * and framing the envelope does not leave key material behind on a path
   * nobody is looking at.
   */
  async seal(plaintext: string, context: SecretContext): Promise<SealedSecret> {
    if (typeof plaintext !== 'string') {
      throw new CatalogKmsVaultError(
        'A vault seals strings. It was handed something else, which means the caller has not decided what the stored form of this secret is — and the answer must not be whatever `String()` makes of it.',
      );
    }

    const encryptionContext = encryptionContextFor(context);
    const dataKey = await generateDataKey(this.client, this.key, encryptionContext);

    try {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv(CIPHER, dataKey.plaintext, nonce);
      cipher.setAAD(additionalAuthenticatedData(encryptionContext));
      const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

      return {
        vault: this.name,
        // The ARN KMS resolved, never `this.key`. See `generateDataKey`.
        keyId: dataKey.keyId,
        ciphertext: packEnvelope({
          wrappedKey: dataKey.wrapped,
          nonce,
          tag: cipher.getAuthTag(),
          body,
        }),
      };
    } finally {
      zeroKey(dataKey.plaintext);
    }
  }

  /**
   * Unwrap a secret. A KMS call only when the data key is not already held.
   *
   * The order of the checks below is the order of increasing cost, and that is
   * the design: a row addressed to another vault, or a value that is not a frame
   * at all, is refused without spending a network call — so a column somebody
   * can write is not a lever for generating KMS traffic.
   */
  async open(sealed: SealedSecret, context: SecretContext): Promise<string> {
    if (sealed.vault !== this.name) {
      // The store is documented as routing by name and refusing rather than
      // guessing, so reaching here is a wiring bug — and one worth naming
      // precisely, because during a rotation there really are two of these
      // bound and "the wrong one was asked" is the mistake to expect.
      throw new CatalogKmsVaultError(
        `This secret was sealed by the "${sealed.vault}" vault and was handed to "${this.name}". Nothing this vault holds can open it; bind the vault whose name matches, or if that is this class over a different key, give each instance its own \`name\`.`,
      );
    }

    const encryptionContext = encryptionContextFor(context);
    const envelope = unpackEnvelope(sealed.ciphertext);
    const cacheKey = dataKeyCacheKey(envelope.wrappedKey, encryptionContext);

    // A hit returns the cache's own buffer, which the cache keeps owning — so
    // this path neither hands it back nor zeroes it. A miss unwraps a buffer
    // this call owns until it is handed over below.
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) return openBody(cached, envelope, encryptionContext);

    const dataKey = await decryptDataKey(
      this.client,
      envelope.wrappedKey,
      sealed.keyId,
      encryptionContext,
    );

    try {
      return openBody(dataKey, envelope, encryptionContext);
    } finally {
      // In a `finally`, so a payload that fails to authenticate does not leave a
      // live data key behind on the one path where something has already gone
      // wrong. Ownership transfers here whatever happened: when caching is off,
      // `set` zeroes on the spot, which is why there is no second branch.
      this.cache.set(cacheKey, dataKey);
    }
  }

  /**
   * Forget every held data key.
   *
   * The operational answer to "the key is rotated / the role is revoked / this
   * pod may be compromised, and we are not waiting out the TTL". No route ships
   * for it: what may trigger a cache flush, and who may, is a decision only the
   * host can make — the same position `@dudousxd/nestjs-catalog-store-fanout`
   * takes about shipping no controller for a replay.
   */
  forgetCachedDataKeys(): void {
    this.cache.clear();
  }
}

/**
 * The local half: AES-256-GCM under a data key that is already in hand.
 *
 * A free function rather than a method, so it cannot reach `this` and cannot
 * quietly acquire a second source of the context — the map it authenticates
 * against has to be the same object the KMS call was made with, and passing it
 * is how that stays true.
 */
function openBody(
  dataKey: Buffer,
  envelope: { nonce: Buffer; tag: Buffer; body: Buffer },
  encryptionContext: Record<string, string>,
): string {
  try {
    const decipher = createDecipheriv(CIPHER, dataKey, envelope.nonce);
    decipher.setAAD(additionalAuthenticatedData(encryptionContext));
    decipher.setAuthTag(envelope.tag);
    return Buffer.concat([decipher.update(envelope.body), decipher.final()]).toString('utf8');
  } catch (error) {
    throw new CatalogKmsVaultError(
      "This sealed secret did not authenticate. Its data key unwrapped, so the key and the encryption context are right and the payload is what failed: the stored ciphertext has been altered since it was written, or one row's value has been copied over another's. Nothing recovers the original — the secret has to be entered again.",
      { cause: error },
    );
  }
}

/**
 * The cache key: the wrapped blob *and* the context it was unwrapped under.
 *
 * The blob alone would be enough to be correct, since KMS produces a distinct
 * one per data key. Including the context is what stops the cache from ever
 * becoming a way around the check it exists beside: a ciphertext moved to
 * another field presents the same blob with a different context, and must miss
 * so that KMS gets to refuse it. It would still fail the GCM tag afterwards —
 * this makes it fail at the layer that reports it as a context violation, which
 * is what an operator needs to see.
 */
function dataKeyCacheKey(wrappedKey: Buffer, encryptionContext: Record<string, string>): string {
  return `${wrappedKey.toString('base64')} ${JSON.stringify(
    Object.entries(encryptionContext).sort(([left], [right]) => (left < right ? -1 : 1)),
  )}`;
}

/**
 * Refuse an empty key at construction rather than at the first save.
 *
 * `key: process.env.CATALOG_KMS_KEY ?? ''` is the shape this catches, and the
 * unhelpful version of this failure is a `ValidationException` from KMS on the
 * day somebody saves their first connection — by which point the deployment has
 * been declared done.
 */
function requireKey(key: string): string {
  if (typeof key !== 'string' || key.trim().length === 0) {
    throw new CatalogKmsVaultError(
      'An AWS KMS secret vault needs a key to seal under: an alias such as "alias/catalog-secrets", a key id, or a key ARN. It was given an empty one, which usually means the environment variable holding it is unset in this environment.',
    );
  }
  return key;
}
