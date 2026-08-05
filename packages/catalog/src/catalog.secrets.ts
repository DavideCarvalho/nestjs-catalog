/**
 * Encrypting the credential that has to rest in `catalog_connection.config`.
 *
 * `config-secrets.ts` in the pipeline package closed the HTTP half of this: a
 * connection URL is a password with an address attached, `config` is served by
 * `GET pipeline/connections` under `catalog:read`, and the redaction stopped it
 * travelling in a response. `MySqlPipelineStore` closed the write half: a
 * password-bearing URL that is not already stored is refused, with a message
 * naming `secretEnvVar`.
 *
 * Neither touches the thing this file is about. A redaction protects a reader
 * coming through the API. It does nothing at all for a database dump, a read
 * replica, a nightly backup, or anybody holding `SELECT` on the RDS instance —
 * and for those, `config` is still a list of every password the catalog knows.
 * `allowInlineCredentials` makes that population larger on purpose, which is
 * precisely why encryption becomes worth building at the same time as the flag
 * that needs it.
 *
 * ## A seam, not an implementation
 *
 * There is no cipher in this file and there must not be one. A library that
 * shipped AES with a key read from an environment variable would have moved the
 * problem from one column to one variable, and would have to answer for key
 * rotation, per-environment separation, and an audit trail — all of which the
 * host's KMS, Vault, or HSM already answers for, and none of which this package
 * can answer for on its behalf. What is here is the shape of the question, so a
 * provider can be written against it: {@link CatalogSecretVault}.
 *
 * The library never inspects a ciphertext, never chooses a key, and never
 * decides an algorithm. It decides *which values* are secrets, *when* they are
 * sealed, and *what happens when the vault cannot be reached* — three questions
 * a provider should not have to have an opinion about.
 *
 * ## What the default does
 *
 * Refuses. {@link RefusingSecretVault} throws on `seal`, naming the token to
 * bind. A default that quietly stored plaintext would be the worst shape
 * available here: a host would turn `encryptCredentials` on, see saves succeed,
 * and have exactly the same column contents as before with a docblock now
 * claiming otherwise. Every other refusing default in this codebase exists for
 * the same reason — `CATALOG_LOAD_EXPECTATIONS` unbound means incremental loads
 * are refused rather than silently unpoliced.
 */

/**
 * What a vault hands back. Stored verbatim; opaque to this library.
 *
 * Three fields and no fourth, because everything a rotation needs is here and
 * nothing a reader could misuse is: the ciphertext says nothing without the
 * vault, and the vault says nothing without the key. It is a plain JSON object
 * so that it can sit in the same `json` column the plaintext sat in — no
 * migration, no second table, and a column that may hold either form for as
 * long as it takes a deployment to move over. {@link isSealedSecret} is what
 * tells the two apart on the way out.
 */
export interface SealedSecret {
  /** Which vault sealed it — `CatalogSecretVault.name`. */
  vault: string;
  /** Which key, in whatever form that vault names keys. */
  keyId: string;
  /**
   * An opaque string the vault chose. **Not base64, and never decoded here.**
   *
   * This said "base64" first, and both provider implementations proved it
   * wrong from opposite directions: HashiCorp Transit returns
   * `vault:v1:<base64>`, which has two colons and is not decodable as base64 at
   * all. The provider stores that verbatim and is right to — the `v1` is the
   * row's only self-description of which key version sealed it, and
   * `transit/rewrap` takes exactly that string back.
   *
   * The claim was harmless while nothing acted on it, which is what makes it
   * worth correcting now rather than later: the day something takes it
   * literally — a base64 `CHECK` constraint, a JSON-schema `contentEncoding`, a
   * `Buffer.from(value, 'base64')` round trip — it breaks **silently**, because
   * `Buffer.from` does not throw on input it cannot read. It returns different
   * bytes.
   *
   * So the only rule is: non-empty, and given back to the vault exactly as it
   * came. {@link isSealedSecret} checks that it is a non-empty string and must
   * never be tightened past that — any narrower test encodes one vault's format
   * as the contract and silently rejects the next one's rows.
   */
  ciphertext: string;
}

/**
 * Where a secret is being used, so a vault can scope or audit by it.
 *
 * Passed to `open` as well as to `seal`, and that is the interesting half: a
 * KMS provider can put this in an encryption context so a ciphertext sealed for
 * `connection/abc/url` cannot be replayed as `connector/xyz/url`, and a Vault
 * provider can write an audit line naming the row somebody's credential was
 * read for. Neither is possible if the seam only carries bytes.
 */
export interface SecretContext {
  /** `connection` or `connector`. */
  kind: string;
  /**
   * The row's id. Present and stable whenever `MySqlPipelineStore` is the
   * caller, including on a first save.
   *
   * This said "absent on a first save", and both provider implementations
   * independently left `id` out of their encryption context because of it —
   * correctly, given what it said. A context that is absent on create and
   * present on update seals under one context and opens under another, and the
   * failure lands at the first connector run rather than at the save.
   *
   * So the store was changed rather than the providers: it mints the row's id
   * *before* sealing instead of inside `em.create`, which costs one hoisted
   * `randomUUID()` and makes the binding property real. A provider may now put
   * this in an encryption context and get what the seam always claimed —
   * `connection/abc/url` is not replayable as `connection/xyz/url`.
   *
   * Two things this does NOT make true, both worth stating before somebody
   * relies on them:
   *
   *  - It is still optional in the type, because a host calling a vault
   *    directly is not obliged to have a row. A provider that binds it must
   *    decide what an absent `id` means for its own callers.
   *  - **Rows sealed before this existed were sealed without it.** A provider
   *    that starts binding `id` on a deployment that already has sealed rows
   *    strands every one of them. Binding it is safe on a new deployment, and
   *    on an existing one only behind a re-seal.
   */
  id?: string;
  /** The config key being sealed — `url`, `password`. */
  field: string;
}

/**
 * The seam a host binds to make credentials unreadable in the catalog's own
 * database.
 *
 * Both methods are async and both are expected to fail sometimes: they are
 * network calls to something outside this process. What each failure *means*
 * is not symmetric, and the store treats them differently — see
 * {@link SecretSealFailedError} and {@link SecretOpenFailedError}.
 */
export interface CatalogSecretVault {
  /**
   * Stable, stored on every SealedSecret so a rotation can find its own.
   *
   * Stable across deployments and releases, not merely across a process: it is
   * written into rows. Renaming it strands every row already sealed under the
   * old name, which the store refuses loudly rather than guessing at — a bound
   * vault whose name does not match the row's is not asked to try.
   */
  readonly name: string;
  seal(plaintext: string, context: SecretContext): Promise<SealedSecret>;
  open(sealed: SealedSecret, context: SecretContext): Promise<string>;

  /**
   * ## The third method, deliberately absent: `reseal`
   *
   * Transit has `rewrap` and KMS has `ReEncrypt` — re-encrypt an existing
   * ciphertext under the current key version without the plaintext leaving the
   * vault. It is the headline capability of both providers this seam spans, and
   * with only `seal` and `open` a rotation has to be open-then-seal: every
   * credential in the catalog dragged back through application memory to do
   * something neither vault needed the application for. That is strictly worse
   * than the primitive, on exactly the property the vault was adopted for. The
   * gap is real and it is not being denied.
   *
   * It is still not being added yet, for the reason `DeleteReconciliation`
   * gives about tombstones: **nothing in this library would call it.** There is
   * no rotation command, no route, no CLI — so `reseal` would be a method every
   * provider implements, no two agree on the meaning of, and no test exercises
   * end to end. "Adding a strategy name that nothing implements would be
   * exactly the dropdown-with-a-lie this codebase refuses everywhere else"; a
   * method nothing invokes is the same lie with a return type.
   *
   * What is owed instead is that the contract does not foreclose it, and it
   * does not. The shape, when the caller exists:
   *
   * ```ts
   * reseal?(sealed: SealedSecret, context: SecretContext): Promise<SealedSecret>;
   * ```
   *
   * Optional, with a `supportsReseal()` guard beside it — the pattern
   * {@link CatalogWorkflowStore} already uses for a capability a backend may
   * legitimately not have, so "this vault cannot rewrap" is a sentence a
   * console can say rather than a method missing at run time. A vault without
   * it falls back to open-then-seal, which is what the store does today and is
   * correct, merely worse. And `keyId` is already on every row, which is what
   * makes "which rows are still on the old key version" answerable by a query
   * rather than by decrypting the table.
   *
   * Until then, provider-specific is the honest answer rather than a workaround:
   * a host that wants `rewrap` today calls its provider directly, and does so
   * knowing the library is not pretending to have abstracted it.
   */
}

/**
 * The token a host binds one vault — or several — to.
 *
 * **Several is the supported shape, and it is what makes rotation possible.**
 * Bind `CatalogSecretVault[]` and the store seals with the *first* and opens
 * with whichever one's `name` matches the row. Moving from one vault to another
 * is then: bind `[next, current]`, let saves reseal under `next`, and drop
 * `current` when nothing is sealed under it any more. With a single vault that
 * transition has no middle — the moment `next` is bound, every row sealed by
 * `current` is unreadable — and a library that made rotation require an outage
 * would be a library whose keys never got rotated.
 *
 * `@Optional()` where it is injected, so a host that binds nothing still boots.
 * It then gets {@link RefusingSecretVault}, which costs nothing until something
 * actually asks for a seal.
 */
export const CATALOG_SECRET_VAULT = Symbol('CATALOG_SECRET_VAULT');

/**
 * Whether a value that came back out of a JSON column is a sealed secret.
 *
 * A runtime guard and not a cast, because this is a `json` column: MikroORM
 * hands back whatever is in it, and what is in it may have been written by a
 * different release, by a hand-run `UPDATE`, or by a host's own seeder. The
 * same argument `WorkflowRow.nodes` makes for being typed `unknown[]`.
 *
 * Deliberately strict about emptiness. A `{ vault: '', keyId: '', ciphertext:
 * '' }` is not a sealed secret and must not be treated as one — treating it as
 * one sends it to a vault that will refuse it, and the operator is told their
 * vault is broken when the row is. An empty ciphertext falls through as an
 * ordinary config value instead, which is what it is.
 *
 * Deliberately loose about everything else, and that is the harder half to
 * hold. `ciphertext` is tested for "non-empty string" and must never be tested
 * for more — not base64, not a length, not a prefix. Two vaults already
 * disagree about its shape: KMS hands back base64, Transit hands back
 * `vault:v1:<base64>`. Any tighter check would encode one of them as the
 * contract and start silently refusing the other's rows, which surfaces as
 * "this credential is not encrypted" for a value that is.
 *
 * What it cannot distinguish is a config value a host deliberately authored as
 * an object with exactly these three non-empty string fields. Nothing prevents
 * that and nothing sensible produces it; saying so is better than adding a
 * marker field that would then have to be defended against forgery it also
 * could not detect.
 */
export function isSealedSecret(value: unknown): value is SealedSecret {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const vault = Reflect.get(value, 'vault');
  const keyId = Reflect.get(value, 'keyId');
  const ciphertext = Reflect.get(value, 'ciphertext');
  return (
    typeof vault === 'string' &&
    vault.length > 0 &&
    typeof keyId === 'string' &&
    typeof ciphertext === 'string' &&
    ciphertext.length > 0
  );
}

/** The name {@link RefusingSecretVault} answers to. No row can carry it: it never seals. */
export const UNCONFIGURED_VAULT = 'unconfigured';

/**
 * The default: a vault that will not pretend.
 *
 * Bound whenever `CATALOG_SECRET_VAULT` is not, which is every host that has
 * not thought about this. It costs nothing until `encryptCredentials` is turned
 * on — the store only reaches a vault when there is something to seal or
 * something sealed to open — so the refusal lands on the deployment that asked
 * for encryption and did not say with what, and lands at the first save rather
 * than at the first run.
 *
 * The alternative shapes were both considered and are both worse. A default
 * that stored plaintext would make `encryptCredentials: true` a no-op with a
 * reassuring name. A default that base64-encoded would be worse still: it looks
 * sealed, `isSealedSecret` would agree, and a dump would be trivially reversed
 * by anybody who noticed.
 */
export class RefusingSecretVault implements CatalogSecretVault {
  readonly name = UNCONFIGURED_VAULT;

  seal(_plaintext: string, context: SecretContext): Promise<SealedSecret> {
    return Promise.reject(
      new SecretVaultNotConfiguredError(
        `encryptCredentials is on, so ${context.kind}.config.${context.field} has to be sealed, and no vault is bound to seal it with. Bind CATALOG_SECRET_VAULT to a CatalogSecretVault — an AWS KMS or HashiCorp Vault provider, or your own — or turn encryptCredentials off and decide what allowInlineCredentials should be instead.`,
      ),
    );
  }

  open(sealed: SealedSecret, context: SecretContext): Promise<string> {
    // Reachable only through a row this instance did not write, since `seal`
    // never returns — so the useful thing to say is the name the row is asking
    // for, which is the one the operator has to go and bind.
    return Promise.reject(
      new SecretVaultNotConfiguredError(
        `${context.kind}.config.${context.field} was sealed by the "${sealed.vault}" vault and no vault is bound to open it. Bind CATALOG_SECRET_VAULT to that provider; nothing else can read this value.`,
      ),
    );
  }
}

/**
 * Nothing is bound, or nothing bound answers to the name a row carries.
 *
 * `retryable = false`, and that field is not decoration. A connector run is
 * dispatched as a durable step, and the dispatch boundary serialises a throw
 * into `{message, code, retryable}` — `retryable` is the only field the engine
 * reads on the way back in, and its predicate is `error?.retryable !== false`.
 * A missing token will be exactly as missing on the third attempt as on the
 * first, so this must not burn fifteen minutes of exponential backoff before
 * saying so. `connector-run.steps.ts` documents that mechanism at length and
 * this is the same use of it.
 */
export class SecretVaultNotConfiguredError extends Error {
  /** The field the dispatch boundary serialises and the engine acts on. */
  readonly retryable = false;
  readonly code = 'secret_vault_not_configured';

  constructor(message: string) {
    super(message);
    this.name = 'SecretVaultNotConfiguredError';
  }
}

/**
 * A save could not seal a credential, so the save did not happen.
 *
 * Which is the correct outcome and worth being explicit about: the fallback a
 * reasonable person reaches for — write it in plaintext and log a warning — is
 * the one thing this feature exists to make impossible. A deployment that
 * turned `encryptCredentials` on and then, during a vault outage, quietly wrote
 * three passwords in the clear would have no way to find out which three.
 *
 * Deliberately not a `BadRequestException`. The caller's URL is fine; the vault
 * is down. A 400 sends somebody to edit a field that is correct.
 */
export class SecretSealFailedError extends Error {
  readonly code = 'secret_seal_failed';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SecretSealFailedError';
  }
}

/**
 * A read could not open a sealed credential.
 *
 * **This is the one whose class matters**, because a connector run is a durable
 * step and the step decides whether to retry from the error it catches. Two
 * things had to be got right here and both are load-bearing:
 *
 *  - It is **not** a `NotFoundException` or a `BadRequestException`.
 *    `ConnectorRunSteps.runConnector` catches exactly those two around the
 *    runner and converts them to `UnavailableConnectorError`, which carries
 *    `retryable = false`. A vault that timed out would then be filed under
 *    `connector_unavailable` and never retried — and an operator filtering a
 *    failed-run list on that code would go looking for a connector somebody
 *    deleted. That is precisely the confusion `UnmetLoadExpectationError` was
 *    split into its own class to avoid.
 *  - `retryable` is **true by default**. A vault being briefly unreachable is
 *    the same kind of failure as a source being briefly unreachable, which is
 *    exactly what that step's `retries: 3, backoff exp 60s…900s` policy exists
 *    for. It is set false only when waiting provably cannot help: nothing is
 *    bound, or nothing bound answers to the name the row carries.
 */
export class SecretOpenFailedError extends Error {
  /** The field the dispatch boundary serialises and the engine acts on. */
  readonly retryable: boolean;
  readonly code = 'secret_open_failed';

  constructor(message: string, options: { retryable: boolean; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.name = 'SecretOpenFailedError';
    this.retryable = options.retryable;
  }
}
