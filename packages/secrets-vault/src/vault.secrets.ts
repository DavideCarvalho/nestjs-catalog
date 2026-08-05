import type { CatalogSecretVault, SealedSecret, SecretContext } from '@dudousxd/nestjs-catalog';
import { VaultSession } from './auth';
import { VaultTransitError } from './errors';
import { VaultHttp } from './http';
import {
  type ResolvedVaultOptions,
  type VaultTransitSecretVaultOptions,
  resolveOptions,
} from './options';
import {
  TransitClient,
  type TransitKeyRef,
  assertPath,
  bindingFor,
  decodeBase64,
  encodeBase64,
  formatKeyId,
  isTransitCiphertext,
  parseKeyId,
} from './transit';

/**
 * `CatalogSecretVault` over HashiCorp Vault's Transit engine.
 *
 * Encryption as a service: the plaintext travels to Vault, the ciphertext comes
 * back, and the key itself never leaves. That is the property the catalog wanted
 * — `CatalogConnection` has spent its life storing the *name* of an environment
 * variable specifically to avoid owning a master key and its blast radius — and
 * Transit is the mechanism that removes the reason for the restriction rather
 * than working around it.
 *
 * ## What this provider proves about the seam, and what it does not
 *
 * The interface fits Transit well enough to implement without contortion, and
 * three things are genuinely better here than the interface needs: rotation is
 * invisible to `open` (see below), the key material is unavailable to a
 * compromised catalog process by construction rather than by policy, and `keyId`
 * is small enough to be readable in a database row.
 *
 * Three things did not fit, and they are documented where they bite:
 * {@link import('./transit').bindingFor} for the encryption context,
 * {@link import('./errors').VaultTransitError} for retryability, and
 * {@link rewrap} for rotation without plaintext. They are collected in the
 * README's "what did not fit" section.
 *
 * What fits better than the brief assumed is **routing**. `CATALOG_SECRET_VAULT`
 * takes an array; `MySqlPipelineStore.openSealed` picks the bound vault whose
 * `name` equals `sealed.vault` and refuses by name when none does. So a KMS ->
 * Transit migration has a middle: bind `[transit, kms]`, let saves reseal under
 * Transit, drop KMS when nothing carries its name. That is the seam a
 * multi-provider abstraction needs, and it is already there — this provider's
 * own name check in {@link refFor} is defence in depth for a host holding the
 * class directly, not the dispatch mechanism.
 */
export class VaultTransitSecretVault implements CatalogSecretVault {
  readonly name: string;
  private readonly transit: TransitClient;

  constructor(private readonly options: ResolvedVaultOptions) {
    this.name = options.name;
    const http = new VaultHttp({
      address: options.address,
      namespace: options.namespace,
      fetch: options.fetch,
      timeoutMs: options.timeoutMs,
    });
    this.transit = new TransitClient(http, new VaultSession({ auth: options.auth, http }));
  }

  /**
   * Encrypts under the configured key and returns a row that can find its way
   * back.
   *
   * The returned ciphertext is checked against Transit's format before it is
   * handed over — see {@link isTransitCiphertext} for the incident shape that
   * check exists for. Failing the save is the right outcome: nothing has been
   * written, so a refused seal costs a retry, while a stored non-ciphertext
   * costs the secret.
   */
  async seal(plaintext: string, context: SecretContext): Promise<SealedSecret> {
    const ref = this.keyRefFor(context);
    const ciphertext = await this.attempt(
      () => this.transit.encrypt(ref, encodeBase64(plaintext), this.binding(context)),
      this.options.sealAttempts,
    );

    if (!isTransitCiphertext(ciphertext)) {
      throw new VaultTransitError(
        `Vault returned something that is not a Transit ciphertext for ${formatKeyId(ref)} — refusing to store it`,
        { kind: 'malformed-response' },
      );
    }

    return { vault: this.name, keyId: formatKeyId(ref), ciphertext };
  }

  /**
   * Decrypts a stored row.
   *
   * **The key comes from the row, not from the configuration.** `seal` uses the
   * configured mount and key; `open` uses whatever `keyId` says. That asymmetry
   * is the entire value of storing `keyId` at all: a deployment that moves the
   * Transit engine to a new mount, or starts sealing under a new key, keeps
   * every existing secret readable, and does so without a migration.
   *
   * **A rewrapped ciphertext needs nothing.** Transit carries its key version
   * inside the ciphertext (`vault:v3:...`) and picks the matching version
   * itself, so a row rewrapped from `v1` to `v3` decrypts through this code
   * unchanged — and so does a row that was *not* rewrapped after a rotation,
   * because old versions stay decryptable. **Rotation requires no change here
   * and no coordination with the catalog at all.** What does require care is
   * `min_decryption_version`: raising it deletes the ability to read anything
   * older, permanently, and Vault will not warn that rows exist at those
   * versions because it does not know about the rows. Rewrap before trimming —
   * {@link rewrap}, and the README's rotation section.
   */
  async open(sealed: SealedSecret, context: SecretContext): Promise<string> {
    const ref = this.refFor(sealed);
    const plaintextBase64 = await this.attempt(
      () => this.transit.decrypt(ref, sealed.ciphertext, this.binding(context)),
      this.options.openAttempts,
    );
    return decodeBase64(plaintextBase64, `a plaintext for ${sealed.keyId}`);
  }

  /**
   * Re-encrypts a stored secret under the current version of its key, **without
   * the plaintext existing anywhere outside Vault**.
   *
   * Deliberately outside `CatalogSecretVault`, because there is no verb for it
   * there — and that absence is a finding rather than an oversight this package
   * routes around. Rotating a key without handling the plaintext is the headline
   * capability of both providers this abstraction is meant to span: Transit has
   * `rewrap`, KMS has `ReEncrypt`. Expressed only through the contract, a
   * rotation becomes `open` then `seal`, which drags every credential in the
   * catalog back through application memory to accomplish something neither
   * vault needed the application for. The workaround is strictly worse than the
   * primitive, and only on the security property the vault was adopted for.
   *
   * Until the contract grows one, a host reaches this by injecting the concrete
   * class — which means the rotation job is provider-specific. Honest, and the
   * README says so.
   *
   * `context` must be the same context the secret was sealed with when
   * `bindContext` is on; rewrap re-derives the same key and cannot succeed
   * without it.
   */
  async rewrap(sealed: SealedSecret, context: SecretContext): Promise<SealedSecret> {
    const ref = this.refFor(sealed);
    const ciphertext = await this.attempt(
      () => this.transit.rewrap(ref, sealed.ciphertext, this.binding(context)),
      this.options.openAttempts,
    );
    if (!isTransitCiphertext(ciphertext)) {
      throw new VaultTransitError(
        `Vault returned something that is not a Transit ciphertext rewrapping ${sealed.keyId}`,
        { kind: 'malformed-response' },
      );
    }
    // `keyId` is unchanged on purpose: rewrapping moves the *version*, and the
    // version lives in the ciphertext. A rewrap that rewrote `keyId` would be
    // the version leaking into the column that documents its own absence.
    return { vault: this.name, keyId: sealed.keyId, ciphertext };
  }

  /** Where a *new* secret goes. */
  private keyRefFor(context: SecretContext): TransitKeyRef {
    const ref = {
      mount: this.options.mount,
      keyName: this.options.keyFor?.(context) ?? this.options.key,
    };
    // Validated even though it came from configuration: a `keyFor` returning ''
    // would otherwise produce `POST transit/encrypt/`, which Vault answers with
    // a 404 that reads as a missing key rather than a bad callback.
    assertPath(ref);
    return ref;
  }

  /** Where an *existing* secret is, having checked the row is ours to read. */
  private refFor(sealed: SealedSecret): TransitKeyRef {
    if (sealed.vault !== this.name) {
      // The store dispatches by name before it gets here, so in a wired
      // deployment this is unreachable. It is kept for the host that injects
      // this class directly — a rotation job calling `rewrap` over a table it
      // paged itself — where a row sealed by another provider would otherwise
      // be posted to Transit and come back as an unparseable-ciphertext 400
      // attributed to Vault.
      throw new VaultTransitError(
        `Sealed secret names vault ${JSON.stringify(sealed.vault)}, but this vault is ${JSON.stringify(this.name)} — it was sealed by a different provider`,
        { kind: 'invalid-request' },
      );
    }
    if (!isTransitCiphertext(sealed.ciphertext)) {
      // Checked before the request rather than letting Vault answer 400, because
      // a truncated or re-encoded ciphertext is a storage problem and Vault's
      // message for it ("invalid ciphertext: no prefix") sends the reader to
      // Vault instead.
      throw new VaultTransitError(
        `Sealed secret for ${sealed.keyId} does not hold a Transit ciphertext (expected "vault:vN:<base64>")`,
        { kind: 'invalid-request' },
      );
    }
    return parseKeyId(sealed.keyId);
  }

  /** `undefined` unless the key was created derived — see `bindingFor`. */
  private binding(context: SecretContext): string | undefined {
    return this.options.bindContext ? encodeBase64(bindingFor(context)) : undefined;
  }

  /**
   * Repeats `operation` while it fails in a way that could succeed later.
   *
   * Full jitter rather than plain exponential backoff: a Vault leader election
   * fails every in-flight call across the fleet at the same instant, and
   * un-jittered backoff has all of them return together on the retry, which is a
   * thundering herd aimed at a cluster that has just finished electing a leader.
   */
  private async attempt<T>(operation: () => Promise<T>, attempts: number): Promise<T> {
    let lastError: unknown;
    for (let index = 0; index < Math.max(1, attempts); index += 1) {
      try {
        return await operation();
      } catch (error) {
        // Anything not classified retryable stops here regardless of the budget:
        // a permission denial or an unparseable ciphertext is not going to
        // change, and spending the budget on it replaces a fast, accurate error
        // with a slow one.
        if (!(error instanceof VaultTransitError) || !error.retryable) throw error;
        lastError = error;
        if (index < Math.max(1, attempts) - 1) {
          await sleep(Math.random() * this.options.retryBaseDelayMs * 2 ** index);
        }
      }
    }
    throw lastError;
  }
}

/**
 * A vault built outside the Nest container, for the binding this module's
 * `forRoot` cannot express.
 *
 * `CATALOG_SECRET_VAULT` accepts an *array*, and that is how a rotation runs
 * without an outage: seals go to the first, opens go to whichever bound vault's
 * `name` matches the row. `CatalogVaultSecretsModule.forRoot` binds exactly one,
 * so a host mid-migration — two Transit keys under two names, or Transit
 * alongside KMS — has to assemble the list itself:
 *
 * ```ts
 * {
 *   provide: CATALOG_SECRET_VAULT,
 *   useValue: [
 *     createVaultTransitSecretVault({ ...common, name: 'vault-transit-2026', key: 'catalog-2026' }),
 *     createVaultTransitSecretVault({ ...common, name: 'vault-transit', key: 'catalog-secrets' }),
 *   ],
 * }
 * ```
 *
 * A plain factory rather than a second module method, because the list is
 * heterogeneous by design: the other element may come from a different package
 * entirely, and no `forRoot` of this one can know about it.
 */
export function createVaultTransitSecretVault(
  options: VaultTransitSecretVaultOptions,
): VaultTransitSecretVault {
  return new VaultTransitSecretVault(resolveOptions(options));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
