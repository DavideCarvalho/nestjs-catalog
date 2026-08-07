/**
 * Keeping a connection URL's password out of a read that only needs
 * `catalog:read`.
 *
 * Three docblocks in this codebase assert that a credential is never stored —
 * `sources.ts` says what the catalog database holds is the *name* of a secret,
 * and both `ConnectorRow.config` and `ConnectionRow.config` say "never the
 * credential". For every source that authenticates with a header or a token
 * that was true, because those really do come from `secretEnvVar`. For SQL it
 * was not, and the line that gives it away is in `fetchSql`:
 *
 * ```ts
 * const url = secret ?? String(connector.config.url ?? '');
 * ```
 *
 * A connection URL *is* the credential — `postgres://user:pass@host/db` is a
 * password with an address attached — and `config` is persisted verbatim,
 * returned verbatim, and served by `GET pipeline/connections` and
 * `GET pipeline/connectors`, both of which ask only for `catalog:read`. So the
 * softest scope in the system read the strongest secret in it.
 *
 * ## Redacting on the way out, refusing on the way in — both, for different rows
 *
 * The refusal (in `MySqlPipelineStore`) is what makes the three docblocks true
 * *going forward*: a password-bearing URL that is not already stored is turned
 * away with a message naming `secretEnvVar`. It cannot help rows that are
 * already in the table, and those are exactly the rows a leak would be about.
 * Hence the redaction here, which stops serving them, and applies to whatever a
 * deployment already has.
 *
 * ## Why the redaction is at the route and not in the store
 *
 * Because the store's readers are not all screens. `ConnectorRunnerService`
 * resolves the connector it is about to run through `getConnector`, and
 * `applyPromotion` copies connectors between environments by reading them with
 * `listConnectors` and writing them into the target — a store that redacted
 * would hand the runner a URL that cannot connect, and would promote the
 * placeholder into the next environment as though it were the password. The
 * store's job is to say what is there. The audience changes from a machine to a
 * person at the HTTP boundary, which is where the redaction belongs and where
 * it can be seen next to the scope that permits the read.
 *
 * ## The round trip
 *
 * A console reads a connector, someone renames it, the console posts the whole
 * object back. Whatever it was shown for the URL is what it sends. Left alone,
 * that writes the placeholder in as the real password and the connector stops
 * working — the classic way this fix corrupts the data it was meant to protect.
 * {@link restoreRedactedSecrets} closes it: a value that is exactly the
 * redaction of what is stored means "unchanged", and the stored one is put
 * back. Anything else is a real edit and goes to the store, which refuses it if
 * it carries a new plaintext password.
 *
 * ## What this does not cover
 *
 * Top-level string values only. A secret hidden inside `config.headers`
 * (`authorization: "Bearer …"`) is untouched, and saying so is better than a
 * traversal that looks total and is not — a nested redaction would also have to
 * be undone in the round trip, key by key, and a miss there writes the
 * placeholder into the database. Headers should move to `secretEnvVar`, which
 * `fetchHttp` already reads.
 */

import type { CatalogConnection, CatalogConnector } from '@dudousxd/nestjs-catalog';
import { REDACTED_SECRET } from '@dudousxd/nestjs-catalog';

/**
 * What a redacted password reads as.
 *
 * Declared in `@dudousxd/nestjs-catalog` and re-exported here, rather than the
 * other way round, because the literal is part of what this route ANSWERS and
 * the audience is a browser: a form offering somebody a box to paste an address
 * into has to be able to recognise the string a read showed them. That package
 * has a browser entry point and this one does not — it reaches `node:fs` and a
 * database driver — so a console importing the constant from here would drag
 * the server into its bundle to learn one word.
 *
 * Re-exported and not merely imported: every reader below, and three specs,
 * already name it through this module, and a constant that moved package
 * without leaving a forwarding address is a rename dressed as a refactor.
 */
export { REDACTED_SECRET };

/**
 * The config as a screen may see it: every URL password replaced.
 *
 * Idempotent — redacting an already-redacted value yields the same string —
 * which is what lets {@link restoreRedactedSecrets} compare the two forms
 * without caring how many times a value has been round-tripped.
 *
 * The returned object is a copy. Redacting in place would mutate the row the
 * store just read and, on a store that caches, the value the runner connects
 * with.
 */
export function redactConfigSecrets(config: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = { ...config };
  for (const [key, value] of Object.entries(config)) {
    if (typeof value !== 'string') continue;
    const hidden = redactUrlPassword(value);
    if (hidden !== undefined) redacted[key] = hidden;
  }
  return redacted;
}

/**
 * Put back every value the caller was only ever shown a redaction of.
 *
 * The test is equality against `redact(stored)`, not "does it contain the
 * sentinel". Someone who genuinely wants a password of `REDACTED` under a
 * *different* host is making a real edit and must reach the store's refusal,
 * rather than silently keeping whatever was there before.
 *
 * `stored` absent — a brand new connector — means there is nothing a
 * placeholder could stand for, so the input passes through untouched and the
 * store turns it away.
 */
export function restoreRedactedSecrets(
  incoming: Record<string, unknown>,
  stored: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!stored) return { ...incoming };
  const restored: Record<string, unknown> = { ...incoming };
  for (const [key, value] of Object.entries(incoming)) {
    if (typeof value !== 'string') continue;
    const previous = stored[key];
    if (typeof previous !== 'string') continue;
    if (redactUrlPassword(previous) === value) restored[key] = previous;
  }
  return restored;
}

/** One connector, as a screen may see it. */
export function redactConnector(connector: CatalogConnector): CatalogConnector {
  return { ...connector, config: redactConfigSecrets(connector.config) };
}

/** One connection, as a screen may see it. */
export function redactConnection(connection: CatalogConnection): CatalogConnection {
  return { ...connection, config: redactConfigSecrets(connection.config) };
}

/** Whether a string is a URL carrying a password — the thing worth hiding. */
export function carriesUrlPassword(value: string): boolean {
  return passwordOf(value) !== undefined;
}

/**
 * The value with its password replaced, or `undefined` when there is nothing to
 * replace.
 *
 * `undefined` rather than the input unchanged, so callers can tell "not a URL"
 * from "a URL nobody put a password in" without parsing it a second time.
 */
function redactUrlPassword(value: string): string | undefined {
  const url = asUrl(value);
  if (!url || url.password.length === 0) return undefined;
  url.password = REDACTED_SECRET;
  return url.toString();
}

function passwordOf(value: string): string | undefined {
  const url = asUrl(value);
  if (!url || url.password.length === 0) return undefined;
  return url.password;
}

/**
 * Parse, or say it is not a URL.
 *
 * `WHATWG URL` handles non-special schemes, so `postgres:` and `mysql:` parse
 * with a real `password` rather than being swept into an opaque path — which is
 * the whole reason this is not a regular expression.
 */
function asUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}
