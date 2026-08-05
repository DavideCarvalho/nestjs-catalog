import type { SecretContext } from '@dudousxd/nestjs-catalog';
import type { VaultSession } from './auth';
import { VaultTransitError } from './errors';
import { type VaultHttp, isRecord } from './http';

/**
 * Transit's wire shapes, and the two places they do not match what
 * `SealedSecret` says it holds.
 *
 * ## `ciphertext` is documented as base64. Transit's is not.
 *
 * The contract's comment reads `ciphertext: string; // base64, opaque to the
 * library`. Transit returns `vault:v1:<base64>` — a version-tagged string with
 * two colons in it, which is not base64 and does not decode as base64.
 *
 * The two halves of that comment disagree, and which half is true decides
 * whether this package is correct. If `opaque` governs, anything round-trips and
 * Transit's format is fine. If `base64` governs, this provider violates the
 * contract on its very first field.
 *
 * **This package stores Transit's string verbatim**, and the reason is
 * operational rather than aesthetic:
 *
 * - The version tag is the only self-description a stored row has. `keyId` names
 *   the mount and the key but *not* the version, because the version is in here.
 *   Wrapping it in another base64 layer means a row nobody can date without
 *   decoding it by hand.
 * - Vault's own tooling consumes this exact string. `vault write
 *   transit/rewrap/catalog-secrets ciphertext=@row` is how a key rotation gets
 *   finished, and every operator runbook for Transit is written against it.
 *   Re-encoding makes the column unusable by the tool that exists to operate on
 *   it.
 *
 * **The risk this accepts, stated plainly.** If anything downstream takes
 * `// base64` literally — a column with a base64 CHECK constraint, a JSON schema
 * with `contentEncoding: base64`, a `Buffer.from(value, 'base64')` round trip —
 * it will not throw. `Buffer.from('vault:v1:abc', 'base64')` silently discards
 * the characters it does not recognise and returns different bytes. A wrong
 * answer, not an error. Reported to the contract's author; the fix is one word
 * in a comment, and it has to be the right word.
 *
 * ## Transit has no equivalent of an encryption context, unless the key opts in.
 *
 * See {@link bindingFor}.
 */

/**
 * Transit ciphertexts, as a shape this package will accept.
 *
 * Checked on the way **out** of `seal` as well as on the way in to `open`. The
 * outbound check looks redundant — Vault produced the string — and it is the one
 * that has caught something: a corporate proxy that answered a `200` with an
 * HTML interstitial parsed as JSON far enough to yield a string, which was then
 * stored as a perfectly ordinary-looking secret and only discovered at the point
 * of use, months later, with the plaintext long gone. Refusing to persist
 * anything that is not a ciphertext turns that into a failed save.
 */
const TRANSIT_CIPHERTEXT = /^vault:v[1-9][0-9]*:[A-Za-z0-9+/]+={0,2}$/;

export function isTransitCiphertext(value: string): boolean {
  return TRANSIT_CIPHERTEXT.test(value);
}

/**
 * The key version a ciphertext was produced under, for diagnostics only.
 *
 * Never used to choose a key. Transit reads the version out of the ciphertext
 * itself on decrypt, which is precisely why {@link parseKeyId} does not carry
 * one — see the note there about what a stored row does and does not tell you.
 */
export function ciphertextKeyVersion(ciphertext: string): number | undefined {
  const match = /^vault:v([1-9][0-9]*):/.exec(ciphertext);
  return match === null ? undefined : Number(match[1]);
}

/**
 * Segments of a Vault path this package is willing to build a URL from.
 *
 * Vault key names permit letters, digits, `-`, `_` and `.`. Enforcing that here
 * is not pedantry about names: `mount` and `key` on the `open` path come out of
 * a **database row**, and they are interpolated into an API path. A row holding
 * `../../sys` would aim a POST at an arbitrary Vault endpoint with the
 * catalog's own token attached. The catalog writes those rows, so this is
 * defence in depth rather than a live hole — but "the input is trusted" is
 * exactly the sentence that precedes the incident, and the check costs a regex.
 */
const PATH_SEGMENT = /^[A-Za-z0-9_.-]+$/;

export interface TransitKeyRef {
  /** Where the Transit engine is mounted. May be nested: `platform/transit`. */
  mount: string;
  /** The key's name within that mount. */
  keyName: string;
}

/**
 * What goes in `SealedSecret.keyId`, and what a person reading a stored row
 * learns from it.
 *
 * The format is `<mount>/<keyName>` — `transit/catalog-secrets`.
 *
 * **What the row tells you.** Which Transit mount and which key name were used.
 * That is enough to decrypt it, to find it in an audit log, and to know which
 * key an operator must not delete.
 *
 * **What the row does not tell you, and why each is deliberate.**
 *
 * - *Which key version.* It is inside the ciphertext, because that is where
 *   Vault puts it and where Vault reads it from. Duplicating it into `keyId`
 *   would create a second copy that goes stale the moment somebody rewraps a
 *   row: the ciphertext would say `v3`, the column would say `v1`, and the
 *   column is the one a human would believe. Rotation is supposed to be
 *   invisible to this table, and a version in `keyId` is exactly the field that
 *   would make it visible and wrong.
 * - *Which Vault cluster.* The address is configuration, not data. A row that
 *   named its cluster would have to be rewritten to move between a primary and
 *   a DR replica, or to change a hostname — and replication is the mechanism
 *   that makes those the *same* key.
 * - *Which namespace.* Same argument, with a sharper edge: on Vault Enterprise,
 *   two namespaces can each hold `transit/catalog-secrets`, and they are
 *   different keys. If a host repoints `namespace` at a different tenant, every
 *   existing row silently addresses the wrong key. It fails closed — Transit
 *   refuses a ciphertext it did not produce — so the outcome is a hard error
 *   rather than a wrong plaintext, which is the only reason this is an
 *   acceptable trade. It is called out in the README.
 */
export function formatKeyId(ref: TransitKeyRef): string {
  return `${ref.mount}/${ref.keyName}`;
}

/**
 * The inverse, applied to whatever a row happens to contain.
 *
 * Splits at the **last** slash, so nested mounts survive: `platform/transit/k`
 * is the key `k` on the mount `platform/transit`, which is the only reading
 * that works, since mounts nest and key names do not contain slashes.
 */
export function parseKeyId(keyId: string): TransitKeyRef {
  const cut = keyId.lastIndexOf('/');
  if (cut <= 0 || cut === keyId.length - 1) {
    throw new VaultTransitError(
      `keyId ${JSON.stringify(keyId)} is not "<mount>/<key>" — the sealed secret cannot be routed`,
      { kind: 'invalid-request' },
    );
  }
  const ref = { mount: keyId.slice(0, cut), keyName: keyId.slice(cut + 1) };
  assertPath(ref);
  return ref;
}

/** Throws unless every segment is a name Vault could have. */
export function assertPath(ref: TransitKeyRef): void {
  const segments = [...ref.mount.split('/'), ref.keyName];
  for (const segment of segments) {
    if (!PATH_SEGMENT.test(segment) || segment === '.' || segment === '..') {
      throw new VaultTransitError(
        `${JSON.stringify(`${ref.mount}/${ref.keyName}`)} contains a path segment that is not a valid Vault name`,
        { kind: 'invalid-request' },
      );
    }
  }
}

/**
 * The bytes bound to a ciphertext when the key was created with `derived=true`,
 * and the single largest gap between this contract and Vault.
 *
 * **What the contract seems to want.** `SecretContext` is passed to `seal` *and*
 * to `open`. There is only one reason to hand the same descriptor to both halves
 * of an encryption round trip: it is meant to be bound, so that a ciphertext
 * sealed for `{connection, url}` cannot be opened as `{connector, password}`.
 * That is AWS KMS's `EncryptionContext` — additional authenticated data, checked
 * by the algorithm, decrypt fails on mismatch — and the shape of this interface
 * is the shape of that feature.
 *
 * **What Vault has.** Transit's `context` parameter is *not* AAD. It is an input
 * to key derivation, available only on keys created with `derived=true`, and it
 * changes which key you get rather than authenticating anything. The effect on a
 * mismatch is the same in practice — you derive a different key, so the decrypt
 * fails — but the preconditions are entirely different:
 *
 * - It must be decided when the **key is created**. `vault write -f
 *   transit/keys/k derived=true` is not reversible on an existing key, so this
 *   cannot be turned on later without re-sealing every secret.
 * - On a non-derived key, sending `context` is a `400`, not a no-op. So a
 *   provider that always sends it breaks against the key most people create.
 * - Derived keys cannot produce data keys and interact with convergent
 *   encryption, so opting in has consequences past this package.
 *
 * Hence `bindContext`, default **off**. See the README.
 *
 * ## `id` is excluded from the binding, and it has to be
 *
 * `SecretContext.id` is documented as *absent on a first save*. Anything derived
 * from it is therefore not stable across the lifetime of the secret it
 * describes: the value is sealed during a create, when there is no id, and
 * opened afterwards, when there is one. Binding it means every secret saved at
 * create time is undecryptable forever, discovered on the first connector run
 * rather than at the save that caused it.
 *
 * So the binding is `["kind","field"]` and nothing else — the two fields that
 * exist at both ends.
 *
 * The contract anticipates this: `SecretContext.id` documents that it is
 * "absent, not invented", and says a provider wanting id-binding has to decide
 * what to do about it. This is that decision, and the KMS provider made the same
 * one for the same reason. What neither can do is bind the row — so the property
 * the contract's own docblock offers as the motivating example, that a secret
 * sealed for `connection/abc/url` cannot be replayed as `connector/xyz/url`,
 * holds for the `kind`/`field` half and **not** for the id. Two rows of the same
 * kind and field are interchangeable ciphertexts under every provider. Recorded
 * in the README.
 *
 * JSON of a fixed-length array rather than `${kind}:${field}`, because `field`
 * is an arbitrary config key: `kind:'a', field:'b:c'` and `kind:'a:b',
 * field:'c'` concatenate identically, and two contexts that should derive
 * different keys deriving the same one is the failure this exists to prevent.
 */
export function bindingFor(context: SecretContext): string {
  return JSON.stringify([context.kind, context.field]);
}

/** Base64 as Vault emits and expects it: standard alphabet, padded. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export function encodeBase64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

/**
 * Base64 in, UTF-8 out — with the shape checked first.
 *
 * `Buffer.from(x, 'base64')` never throws. It skips characters outside the
 * alphabet and returns whatever it managed to assemble, so a truncated or
 * mangled body becomes a shorter, wrong plaintext rather than an error. On this
 * path the plaintext is a database password: a wrong one produces an
 * authentication failure against the *source system*, which is investigated as a
 * credential problem in a completely different repository. Checking the shape
 * turns that into a failure that names Vault.
 */
export function decodeBase64(value: string, what: string): string {
  if (value.length % 4 !== 0 || !BASE64.test(value)) {
    throw new VaultTransitError(`Vault returned ${what} that is not valid base64`, {
      kind: 'malformed-response',
    });
  }
  return Buffer.from(value, 'base64').toString('utf8');
}

/**
 * The three Transit calls this package makes.
 *
 * Every one goes through {@link VaultSession.withToken}, so an expired token is
 * re-minted and the call repeated without any of this knowing.
 */
export class TransitClient {
  constructor(
    private readonly http: VaultHttp,
    private readonly session: VaultSession,
  ) {}

  /** `POST {mount}/encrypt/{key}` -> the `vault:vN:...` ciphertext. */
  encrypt(ref: TransitKeyRef, plaintextBase64: string, context?: string): Promise<string> {
    return this.ciphertextCall(ref, 'encrypt', { plaintext: plaintextBase64 }, context);
  }

  /** `POST {mount}/decrypt/{key}` -> the base64 plaintext. */
  async decrypt(ref: TransitKeyRef, ciphertext: string, context?: string): Promise<string> {
    const path = `${ref.mount}/decrypt/${ref.keyName}`;
    const data = await this.call(path, withContext({ ciphertext }, context));
    if (typeof data.plaintext !== 'string') {
      throw new VaultTransitError(`Vault ${path} returned no plaintext`, {
        kind: 'malformed-response',
        path,
      });
    }
    return data.plaintext;
  }

  /**
   * `POST {mount}/rewrap/{key}` -> the same secret under the key's current
   * version, **without the plaintext ever existing outside Vault**.
   *
   * Not part of `CatalogSecretVault`. There is no verb for it there, which is
   * the finding: rotation without plaintext is the main operational reason to
   * use an external vault at all, and both Transit and KMS (`ReEncrypt`) offer
   * it. See `VaultTransitSecretVault.rewrap`.
   */
  rewrap(ref: TransitKeyRef, ciphertext: string, context?: string): Promise<string> {
    return this.ciphertextCall(ref, 'rewrap', { ciphertext }, context);
  }

  private async ciphertextCall(
    ref: TransitKeyRef,
    operation: 'encrypt' | 'rewrap',
    body: Record<string, unknown>,
    context?: string,
  ): Promise<string> {
    const path = `${ref.mount}/${operation}/${ref.keyName}`;
    const data = await this.call(path, withContext(body, context));
    if (typeof data.ciphertext !== 'string') {
      throw new VaultTransitError(`Vault ${path} returned no ciphertext`, {
        kind: 'malformed-response',
        path,
      });
    }
    return data.ciphertext;
  }

  /** POST, unwrap Vault's `{ data: ... }` envelope, with a valid token. */
  private async call(
    path: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.session.withToken(async (token) => {
      const response = await this.http.post(path, body, token);
      if (!isRecord(response.data)) {
        throw new VaultTransitError(`Vault ${path} returned no data object`, {
          kind: 'malformed-response',
          path,
        });
      }
      return response.data;
    });
  }
}

/** Adds `context` only when there is one — see {@link bindingFor} for why an
 *  empty one is not the same as none. */
function withContext(
  body: Record<string, unknown>,
  context: string | undefined,
): Record<string, unknown> {
  return context === undefined ? body : { ...body, context };
}
