import type { SecretContext } from '@dudousxd/nestjs-catalog';
import type { VaultAuth } from './auth';
import type { VaultFetch } from './http';

/** The resolved options, bound so a host can inspect what it actually got. */
export const CATALOG_VAULT_SECRETS_OPTIONS = Symbol('CATALOG_VAULT_SECRETS_OPTIONS');

/**
 * The default value of `SealedSecret.vault`, and a name to change with care.
 *
 * This name is **data**. It is written into every sealed row, and the store
 * dispatches on it: `openSealed` looks for a bound vault whose `name` equals the
 * row's and refuses by name when none matches. Renaming the vault in
 * configuration therefore orphans every secret already sealed under the old name
 * — recoverably, by binding a second instance under the old name alongside the
 * new one, since `CATALOG_SECRET_VAULT` takes an array. That is also how a
 * genuine migration is done, and it is the reason the token is a list.
 */
export const DEFAULT_VAULT_NAME = 'vault-transit';

/** Vault's own default mount path for the Transit engine. */
export const DEFAULT_TRANSIT_MOUNT = 'transit';

/** Named rather than left required: a deployment with one key wants one obvious
 *  name in the policy, the audit log and the runbook, and picking it here means
 *  the README's `vault write` command is copy-pasteable. */
export const DEFAULT_TRANSIT_KEY = 'catalog-secrets';

/**
 * Five seconds. Transit encryption is a CPU operation on a few dozen bytes, so a
 * healthy Vault answers in single-digit milliseconds and anything approaching a
 * second means the cluster is in trouble. Long enough to ride out a leader
 * election, short enough that a save button does not appear to hang.
 */
export const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * The retry policy, and the argument for why the two directions differ.
 *
 * The brief asked which of "sealing fails a save" and "opening fails a connector
 * run" should retry. They are not symmetric, and the asymmetry is not about
 * Vault:
 *
 * - **`seal` does not retry.** A person is waiting on a form, and nothing has
 *   been written — a failed seal means the row was never saved, so there is no
 *   partial state and no cleanup. The cheapest correct recovery is to report the
 *   failure and let them press the button again, which is a retry with a human
 *   deciding the backoff. Retrying under them turns a two-second error into a
 *   ten-second one and reports the *last* failure rather than the first, which
 *   is usually the less informative of the two.
 * - **`open` retries.** Nobody is waiting, the failure aborts a scheduled load,
 *   and the most likely cause is a leader election or a sealed standby that
 *   resolves in seconds. It also has nowhere else to be retried: `open` is
 *   called from inside the catalog's own run path, so a host cannot wrap it, and
 *   `CatalogSecretVault` gives the caller no way to learn that the failure was
 *   transient (see {@link import('./errors').VaultTransitError}). A provider
 *   that does not retry here is a provider that turns a five-second failover
 *   into a failed load, and the only party positioned to know better is this
 *   one.
 *
 * Both are configurable, and both only ever repeat a failure classified
 * retryable — a `403`, a bad ciphertext or a trimmed key version fails once and
 * immediately, however many attempts are allowed.
 */
export const DEFAULT_OPEN_ATTEMPTS = 3;
export const DEFAULT_SEAL_ATTEMPTS = 1;

/** Doubling from 100ms with full jitter: 3 attempts spans roughly 0.3s, which
 *  covers a leader election without holding a worker slot for a minute. */
export const DEFAULT_RETRY_BASE_DELAY_MS = 100;

export interface VaultTransitSecretVaultOptions {
  /**
   * What lands in `SealedSecret.vault`. Defaults to {@link DEFAULT_VAULT_NAME};
   * read that constant before overriding it.
   */
  name?: string;
  /** `VAULT_ADDR` — `https://vault.internal:8200`. */
  address: string;
  /** `VAULT_NAMESPACE`. Enterprise only, and it is not recorded in the row —
   *  see {@link import('./transit').formatKeyId}. */
  namespace?: string;
  /** Where the Transit engine is mounted. Nested mounts are fine. */
  mount?: string;
  /** The key new secrets are sealed under. Existing rows name their own. */
  key?: string;
  /**
   * Chooses the key for a *new* seal from the context — a separate key for
   * connections and connectors, say, so their policies can differ.
   *
   * Only `kind` and `field` are usable here in practice. Keying on `id` looks
   * possible and is not: it is absent on a first save, so the seal and the
   * later opens would name different keys. `open` reads the key from the stored
   * `keyId` rather than calling this, so changing this function never strands
   * an existing row.
   */
  keyFor?: (context: SecretContext) => string;
  auth: VaultAuth;
  /**
   * The HTTP client. Defaults to the global `fetch`. Supply one for mTLS, a
   * private CA, a proxy, or to put this package's calls through a host's own
   * instrumented client.
   */
  fetch?: VaultFetch;
  timeoutMs?: number;
  /**
   * Send `SecretContext` as Transit's `context`, binding the ciphertext to the
   * kind and field it was sealed for.
   *
   * **Off by default, and turning it on requires a key created with
   * `derived=true`.** Against an ordinary key Vault answers `400`. Against a
   * derived key it cannot be turned off again without re-sealing everything.
   * Read {@link import('./transit').bindingFor} before setting this.
   */
  bindContext?: boolean;
  openAttempts?: number;
  sealAttempts?: number;
  retryBaseDelayMs?: number;
}

/** Options with every default applied — what the vault actually runs on. */
export interface ResolvedVaultOptions {
  name: string;
  address: string;
  namespace?: string;
  mount: string;
  key: string;
  keyFor?: (context: SecretContext) => string;
  auth: VaultAuth;
  fetch: VaultFetch;
  timeoutMs: number;
  bindContext: boolean;
  openAttempts: number;
  sealAttempts: number;
  retryBaseDelayMs: number;
}

/**
 * Applies the defaults, and refuses a configuration that cannot work.
 *
 * The checks are here rather than at the first call because all of them are
 * answerable at boot, and every one of them presents at the first call as
 * something else: a missing `address` becomes a `fetch` failure against
 * `undefined/v1/...`, and a runtime without `fetch` becomes
 * `options.fetch is not a function` several frames deep. A module that refuses
 * to construct names the actual problem while somebody is still looking at the
 * wiring.
 */
export function resolveOptions(options: VaultTransitSecretVaultOptions): ResolvedVaultOptions {
  if (typeof options.address !== 'string' || options.address.length === 0) {
    throw new TypeError('CatalogVaultSecretsModule needs an `address` (VAULT_ADDR)');
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new TypeError(
      'CatalogVaultSecretsModule found no global fetch — pass `fetch` explicitly (Node >= 18)',
    );
  }
  return {
    name: options.name ?? DEFAULT_VAULT_NAME,
    address: options.address,
    namespace: options.namespace,
    mount: options.mount ?? DEFAULT_TRANSIT_MOUNT,
    key: options.key ?? DEFAULT_TRANSIT_KEY,
    keyFor: options.keyFor,
    auth: options.auth,
    fetch: fetchImpl,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    bindContext: options.bindContext ?? false,
    openAttempts: options.openAttempts ?? DEFAULT_OPEN_ATTEMPTS,
    sealAttempts: options.sealAttempts ?? DEFAULT_SEAL_ATTEMPTS,
    retryBaseDelayMs: options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
  };
}
