/**
 * One error type for every way a Transit call can fail, carrying the one thing
 * `CatalogSecretVault` has nowhere to put: whether trying again could work.
 *
 * **This exists because `CatalogSecretVault` gives a vault nowhere to say it.**
 * `open` returns `Promise<string>` and reports failure by throwing, so every
 * failure reaches the store as the same shape. The two behind it want opposite
 * handling:
 *
 * - Vault is sealed, failing over, or briefly unreachable. The row is fine, the
 *   key is fine, and the same call in thirty seconds succeeds. A connector run
 *   that gives up here has failed a load for no reason.
 * - The ciphertext was encrypted under a key version an operator has since
 *   trimmed past `min_decryption_version`, or the token's policy does not cover
 *   this key, or the mount was removed. Waiting cannot help, and the wait is not
 *   free: the connector step retries three times over fifteen minutes, and the
 *   error an operator finally reads is whatever the *last* attempt said.
 *
 * The catalog does have the concept — `SecretOpenFailedError` carries
 * `retryable`, and the durable dispatch boundary acts on exactly that field. It
 * has no channel from the vault to it. `MySqlPipelineStore.openSealed` sets
 * `retryable: !isPermanent(error)`, and `isPermanent` recognises one thing:
 * `error instanceof SecretVaultNotConfiguredError`. Everything a provider throws
 * is therefore retryable by default, including the failures the provider knows
 * are terminal.
 *
 * Wrong in the safe direction, and the store argues for that explicitly. But the
 * vault is the only layer that *can* answer, so this class answers it anyway,
 * on the error, where a store that wants it can read it. The AWS KMS provider
 * arrived at the same field independently, which makes the fix cheap and
 * provider-agnostic: `isPermanent` could read `retryable === false` off the
 * cause. Recorded in the README under "what did not fit".
 */

/**
 * What went wrong, at the granularity that changes what an operator does about
 * it. Deliberately coarser than an HTTP status: `503` and a TCP reset are the
 * same problem wearing different clothes, and an on-call page that distinguishes
 * them has made the reader do the joining.
 */
export const VAULT_FAILURE_KINDS = [
  /** No answer at all: DNS, TCP, TLS, or our own timeout fired first. */
  'unreachable',
  /** Vault answered that it cannot serve right now — sealed, standby, no leader. */
  'unavailable',
  /**
   * A performance standby has not yet caught up to the write we depend on.
   * Vault answers `412` and means "ask again in a moment", which is genuinely
   * different from every other 4xx: it is the only one where the *client* did
   * nothing wrong.
   */
  'not-yet-consistent',
  /** A quota or rate limit rejected the call. */
  'throttled',
  /** The token is missing, expired, or its policy does not cover this path. */
  'forbidden',
  /** The mount or the key does not exist. */
  'not-found',
  /**
   * Vault understood the request and refused it: a ciphertext it cannot parse,
   * a key version below `min_decryption_version`, `context` supplied to a key
   * that was not created with `derived=true`.
   */
  'rejected',
  /**
   * Something answered, and it was not Vault. An HTML login page from a proxy,
   * a truncated body, a `200` with no `data.ciphertext` in it. Separated from
   * `rejected` because the fix is never in the catalog — it is in the network
   * between it and Vault.
   */
  'malformed-response',
  /**
   * The failure never reached the network: a `keyId` that does not parse, a
   * ciphertext that is not in Transit's format, a `SealedSecret` addressed to a
   * different vault. Always terminal, and always a bug or a corrupted row.
   */
  'invalid-request',
] as const;

export type VaultFailureKind = (typeof VAULT_FAILURE_KINDS)[number];

/**
 * Whether the same call, unchanged, could succeed later.
 *
 * `forbidden` is the interesting one and it is listed as **not** retryable on
 * purpose. An expired token is fixable, but it is fixed by logging in again
 * rather than by repeating the call, and {@link VaultSession} already does that
 * once before the error is ever constructed. By the time a `forbidden` escapes
 * to a caller, either the strategy cannot mint a token (a static one) or a fresh
 * token was refused too — and both of those are a policy to fix, not a wait.
 */
const RETRYABLE: Readonly<Record<VaultFailureKind, boolean>> = {
  unreachable: true,
  unavailable: true,
  'not-yet-consistent': true,
  throttled: true,
  forbidden: false,
  'not-found': false,
  rejected: false,
  'malformed-response': false,
  'invalid-request': false,
};

export interface VaultTransitErrorInit {
  kind: VaultFailureKind;
  /** Absent when nothing answered — see `unreachable`. */
  status?: number;
  /** Vault's own `errors[]` array, verbatim. Empty when the body carried none. */
  vaultErrors?: string[];
  /** The Vault API path the call was made against, for the message. */
  path?: string;
  cause?: unknown;
}

/**
 * Every failure this package raises, including the ones that never reach the
 * network. One class rather than a hierarchy: callers branch on
 * {@link retryable} or on {@link kind}, and a `catch` that has to know six class
 * names to decide one boolean has moved the work rather than done it.
 */
export class VaultTransitError extends Error {
  readonly kind: VaultFailureKind;
  readonly retryable: boolean;
  readonly status?: number;
  readonly vaultErrors: string[];
  readonly path?: string;

  constructor(message: string, init: VaultTransitErrorInit) {
    // `cause` goes through the Error options bag rather than being assigned
    // after, so the stack Node prints already carries the underlying `TypeError`
    // from `fetch` — which is the only place the real reason for `unreachable`
    // (ECONNREFUSED, EAI_AGAIN, a bad CA) is written down.
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'VaultTransitError';
    this.kind = init.kind;
    this.retryable = RETRYABLE[init.kind];
    this.status = init.status;
    this.vaultErrors = init.vaultErrors ?? [];
    this.path = init.path;
  }
}

/**
 * Maps an HTTP status onto a {@link VaultFailureKind}.
 *
 * Kept as a function on the status alone, never on the body. Vault's error
 * strings are not a stable interface — they are prose, they are localised by
 * nobody, and they change between minor versions — so a classifier that reads
 * them is a classifier that silently reclassifies on upgrade. The status is the
 * part Vault documents.
 *
 * The one place that costs something is `400`: "ciphertext is not valid" and
 * "key version 1 is less than the minimum decryption version 3" arrive
 * identically, and an operator needs to tell them apart. They can — the
 * `errors[]` array is preserved verbatim on the error and printed in the
 * message. It is just not what decides control flow.
 */
export function classifyStatus(status: number): VaultFailureKind {
  if (status === 400 || status === 422) return 'rejected';
  if (status === 401 || status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  if (status === 412) return 'not-yet-consistent';
  if (status === 429) return 'throttled';
  // 500 included with the 5xx that are worth retrying. Vault documents it as
  // "internal error, may be safe to retry", and the alternative — treating the
  // most common symptom of a struggling cluster as terminal — fails loads that
  // would have succeeded on the next attempt.
  if (status >= 500) return status === 501 ? 'rejected' : 'unavailable';
  return 'malformed-response';
}
