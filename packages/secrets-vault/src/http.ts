import { VaultTransitError, classifyStatus } from './errors';

/**
 * The HTTP boundary, and the reason this package has no HTTP client in it.
 *
 * **`fetch`, not `node-vault`.** Three reasons, in the order they mattered.
 *
 * The first is the dependency itself. This package holds the code path that
 * every database password in the catalog passes through, and the brief was that
 * an HTTP client must never be a hard dependency. A peer dependency satisfies
 * the letter of that; *no* dependency satisfies it outright. `fetch` has been in
 * Node since 18 and unflagged since 21, so the entire Transit surface used here
 * — two endpoints for the data path, one for login — costs zero packages and
 * zero transitive supply-chain surface on the component least able to afford it.
 *
 * The second is types. `node-vault` resolves its responses as `any`. Turning
 * those into `SealedSecret` means either trusting them, or asserting — and this
 * repo does not assert. Narrowing an `any` with a runtime guard is the same work
 * whether the `any` came from a library or from `JSON.parse`, so the library was
 * buying nothing and charging a dependency for it.
 *
 * The third is that the interesting behaviour is not in the request. It is in
 * classifying the failure (see {@link VaultTransitError}) and in re-logging-in
 * once on a rejected token (see `VaultSession`), and a client that wraps the
 * request while leaving both of those to the caller has wrapped the easy half.
 *
 * A host that needs mTLS, a proxy, a private CA, or its own retry-and-metrics
 * stack supplies {@link VaultFetch}. That seam is the whole extension point, and
 * it is deliberately shaped as a *function* rather than a class: everything from
 * `undici`'s `fetch` with a custom `dispatcher` to a three-line test stub
 * satisfies it without implementing anything.
 */

/** What this package sends. Narrower than `RequestInit` on purpose — every field
 *  here is one this package actually sets, so a host implementing
 *  {@link VaultFetch} by hand can see the whole contract without reading fetch's. */
export interface VaultFetchInit {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}

/** What this package reads off the answer. A `Response` satisfies it
 *  structurally, so `globalThis.fetch` is assignable with no adapter. */
export interface VaultFetchResponse {
  readonly status: number;
  readonly ok: boolean;
  text(): Promise<string>;
}

export type VaultFetch = (url: string, init: VaultFetchInit) => Promise<VaultFetchResponse>;

export interface VaultHttpOptions {
  /** `VAULT_ADDR` — scheme, host, port. Trailing slashes are tolerated. */
  address: string;
  /** `VAULT_NAMESPACE`. Enterprise only; omitted entirely on OSS. */
  namespace?: string;
  fetch: VaultFetch;
  timeoutMs: number;
}

/**
 * A POST to a Vault API path, with the failure taxonomy applied.
 *
 * Only POST, because Transit's encrypt, decrypt, rewrap and every auth login are
 * all POSTs. A `get` would be dead code with a plausible-looking signature,
 * which is worse than no code.
 */
export class VaultHttp {
  private readonly base: string;

  constructor(private readonly options: VaultHttpOptions) {
    this.base = options.address.replace(/\/+$/, '');
  }

  /**
   * @param path Vault API path *without* the `/v1` prefix — `transit/encrypt/k`.
   *   The prefix is added here so no caller can forget it and get a `404` that
   *   reads as "the key does not exist".
   * @param token Omitted for a login call, which is the one request that has no
   *   token yet.
   */
  async post(
    path: string,
    body: Record<string, unknown>,
    token?: string,
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      // Vault requires this on some paths and treats it as a CSRF guard on the
      // rest: a browser cannot set a custom header on a cross-origin request
      // without a preflight Vault will not answer. It costs nothing and it means
      // a Vault reachable from a browser cannot be driven by one.
      'X-Vault-Request': 'true',
    };
    if (token !== undefined) headers['X-Vault-Token'] = token;
    // Set only when configured. Sending an empty `X-Vault-Namespace` to an OSS
    // Vault is not the same as sending none — it is a namespace named "".
    if (this.options.namespace !== undefined) {
      headers['X-Vault-Namespace'] = this.options.namespace;
    }

    let response: VaultFetchResponse;
    try {
      response = await this.options.fetch(`${this.base}/v1/${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        // A timeout is not optional here. Both callers of this sit in front of
        // something a person or a scheduler is waiting on, and `fetch` with no
        // signal waits on the OS socket timeout — minutes, during which a save
        // button spins and a connector run holds its slot.
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (cause) {
      // Everything `fetch` throws lands here: DNS, connection refused, TLS
      // verification, and our own abort. All of them are "no answer", all of
      // them are worth retrying, and the specific one is in `cause` rather than
      // sniffed out of an error message that varies by runtime.
      throw new VaultTransitError(
        `Vault at ${this.base} could not be reached for ${path} within ${this.options.timeoutMs}ms`,
        { kind: 'unreachable', path, cause },
      );
    }

    const text = await response.text();

    if (!response.ok) {
      const vaultErrors = readErrors(text);
      const detail = vaultErrors.length > 0 ? `: ${vaultErrors.join('; ')}` : '';
      throw new VaultTransitError(`Vault answered ${response.status} for ${path}${detail}`, {
        kind: classifyStatus(response.status),
        status: response.status,
        vaultErrors,
        path,
      });
    }

    // `204 No Content` is a legitimate success for some Vault writes. It is not
    // one this package's callers can use, but answering `{}` and letting the
    // caller's own "where is `data`" check report it produces a better message
    // than a JSON parse error on an empty string.
    if (text.length === 0) return {};

    const parsed: unknown = safeParse(text);
    if (!isRecord(parsed)) {
      throw new VaultTransitError(
        `Vault answered ${response.status} for ${path} with a body that is not a JSON object`,
        { kind: 'malformed-response', status: response.status, path },
      );
    }
    return parsed;
  }
}

/** `JSON.parse` that answers `undefined` rather than throwing — the caller's
 *  `isRecord` check reports it, with the path in the message. */
function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Vault's `{"errors": ["..."]}` array, when the body has one.
 *
 * Best-effort by design. This runs on a path that is already failing, and an
 * error body that is itself unparseable — an HTML error page from a load
 * balancer is the usual one — must not replace the status the caller needs with
 * a `SyntaxError` from the error handler.
 */
function readErrors(text: string): string[] {
  const parsed: unknown = safeParse(text);
  if (!isRecord(parsed) || !Array.isArray(parsed.errors)) return [];
  return parsed.errors.filter((entry): entry is string => typeof entry === 'string');
}
