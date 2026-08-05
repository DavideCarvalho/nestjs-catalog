/**
 * What a run is allowed to write down about itself.
 *
 * `config-secrets.ts` settled where redaction belongs and why: not in the store,
 * because the store's readers are not all screens and a runner handed a
 * placeholder cannot connect; at the boundary where the audience stops being a
 * machine and becomes a person, next to the scope that permits the read. A run's
 * logs and its `error` are that same boundary and were never given the same
 * treatment.
 *
 * The hole it leaves is not subtle. `fetchHttp` throws `GET ${url} → ${status}`
 * and the file source does the same. `ConnectorRunnerService` pushes
 * `Failed: ${message}` into `logs` and emits `connector.run.finished` carrying
 * `error: message`; `WorkflowRunnerService.finish` does both as well. Both sinks
 * are served under the softest scope in the system — `GET pipeline/runs` returns
 * `logs` and `error` verbatim at `catalog:read`, and `GET catalog/events` returns
 * the payload verbatim. So a signed URL, or an endpoint with `?api_key=` in it,
 * needed to fail **once** to become readable by everybody who may look at the
 * catalog at all. `redactConnector` guarded the connector list; nothing guarded
 * the runs.
 *
 * ## Why `redactConfigSecrets` is not the tool
 *
 * It walks the top-level string values of a config object and replaces the ones
 * that parse whole as a URL with a password. An error message is not a config
 * object and never parses as a URL: the credential sits somewhere inside a
 * sentence, with `GET ` in front of it and ` → 401` after it. What is needed
 * here is a scan of free text for URL-shaped runs, which is a different
 * operation with a different failure mode, and giving them one name would have
 * meant one of the two callers getting a function that does not quite do what it
 * says.
 *
 * ## Why the whole query string goes, not the parameters that look sensitive
 *
 * Because naming them is a deny-list, and this file exists because a deny-list
 * lost. `token`, `api_key`, `apikey`, `sig`, `signature`, `X-Amz-Signature`,
 * `access_token`, and whatever the next vendor calls it. A query string in a
 * failed-request log is worth very little next to the scheme, host and path,
 * which are what actually tell an operator which source refused them — so the
 * cheap, total answer is available here in a way it almost never is.
 *
 * ## What this does not cover, said plainly
 *
 * A credential that is not inside a URL. A transform printing
 * `authorization: Bearer …`, a driver quoting a password in a sentence of its
 * own, a token pasted into a log line as a bare word: none of those are
 * URL-shaped and none of them are touched. Saying so is better than a scan that
 * looks total and is not — the same stance `config-secrets.ts` takes about
 * `config.headers`. Credentials belong in `secretEnvVar`, and the allow-list in
 * `secret-env-allowlist.ts` is what decides which of those may be read.
 */

import { REDACTED_SECRET } from './config-secrets';

/**
 * The default character bound on one line, and the reason there is one.
 *
 * Lifted from `workflow-runner.service.ts`, which measured it: a transform
 * logging one line that named every record it received put a 9.8KB string into a
 * durable step's output checkpoint and into the finish step's input as well, on
 * a 1,200-row load — and it grows with the data, which is the one property a
 * step boundary must not have. The connector runner capped its transform logs on
 * the line axis only (`.slice(0, 50)`) and so had the same unbounded string
 * going straight into a run row.
 */
export const LOG_LINE_CHARS = 400;

/**
 * Every URL-shaped run in a string, with its password, query and fragment gone.
 *
 * Idempotent, which matters because the workflow path redacts a node's logs
 * where they are produced and again where the run is finished: a value already
 * reading `REDACTED` redacts to itself, so the second pass is free and cannot
 * corrupt the first.
 *
 * A URL with nothing to hide is left **byte for byte** as it was. That is not an
 * optimisation. Round-tripping through `URL` normalises — a bare host gains a
 * trailing slash, the host lower-cases, characters get percent-encoded — and a
 * redactor that quietly rewrote every innocuous `s3://bucket/key` in every log
 * in the system would be a change nobody asked for showing up in the one place
 * people go when they are already confused.
 */
export function redactSecrets(text: string): string {
  return text.replace(URL_RUN, (match) => {
    // The trailing punctuation of the *sentence*, not of the URL. `…at
    // https://host/x.` ends a sentence; swallowing the full stop into the URL
    // would make it part of the path and put it back in the wrong place.
    const trailing = TRAILING_PUNCTUATION.exec(match)?.[0] ?? '';
    const candidate = trailing.length > 0 ? match.slice(0, -trailing.length) : match;
    return `${redactUrl(candidate) ?? candidate}${trailing}`;
  });
}

/** {@link redactSecrets} over a run's log lines. */
export function redactLines(lines: readonly string[]): string[] {
  return lines.map(redactSecrets);
}

/**
 * Trim logging to something a checkpoint and a run row can hold, on both axes.
 *
 * A truncated line says so, because a line that was silently cut looks like a
 * transform that stopped mid-sentence — which is a bug report about the wrong
 * thing.
 *
 * **Not safe on its own for anything that may carry a URL.** Cutting a line at
 * 400 characters can leave `https://user:secr` — the first half of a password,
 * with the redactor's chance to see a whole URL cut away with the rest of it.
 * {@link safeLogLines} is the one to reach for; this stays exported because it
 * is the pure half and is tested as one.
 */
export function capLines(
  lines: readonly string[],
  maxLines: number,
  maxChars: number = LOG_LINE_CHARS,
): string[] {
  return lines
    .slice(0, maxLines)
    .map((line) =>
      line.length > maxChars
        ? `${line.slice(0, maxChars)}… (${line.length - maxChars} more characters)`
        : line,
    );
}

/**
 * Redact, then cap. In that order, and the order is the whole reason this
 * function exists rather than two calls at each site.
 *
 * Capping first hands the redactor a line that has already been cut, so a
 * credential straddling the cut is half-published and invisible to the scan that
 * was meant to remove it. There are four call sites and it only takes one of
 * them getting the order wrong.
 */
export function safeLogLines(
  lines: readonly string[],
  maxLines: number,
  maxChars: number = LOG_LINE_CHARS,
): string[] {
  return capLines(redactLines(lines), maxLines, maxChars);
}

/**
 * A URL-shaped run of text: a scheme, `://`, and everything up to whitespace.
 *
 * Stops at whitespace rather than at a character class of "things a URL may
 * contain", because the strings being scanned are sentences somebody wrote —
 * `GET ${url} → ${status}` — and a URL in one of them is delimited by the spaces
 * around it and by nothing else. The scheme pattern is the RFC 3986 one, so
 * `postgres://` and `s3://` are found as readily as `https://`; the credential
 * this file is most afraid of lives in the first of those.
 */
const URL_RUN = /[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+/gi;

/** Sentence punctuation that a whitespace-delimited run swallows off the end. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}>'"]+$/;

/**
 * One URL with everything a credential can hide in removed, or `undefined` when
 * there was nothing to remove.
 *
 * `undefined` rather than the input unchanged, so {@link redactSecrets} can tell
 * "a URL nobody put a secret in" from "a URL I have rewritten" and leave the
 * former exactly as it found it. The same distinction `redactUrlPassword` draws
 * in `config-secrets.ts`, for the same reason.
 *
 * `URL` rather than a regular expression, and that is load-bearing for the case
 * that matters most: the WHATWG parser handles non-special schemes, so
 * `postgres://user:pass@host/db` yields a real `password` instead of being swept
 * into an opaque path.
 */
function redactUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }

  let changed = false;
  if (url.password.length > 0) {
    url.password = REDACTED_SECRET;
    changed = true;
  }
  if (url.search.length > 0) {
    url.search = `?${REDACTED_SECRET}`;
    changed = true;
  }
  // A fragment never reaches a server, so it cannot be the credential that made
  // *this* request fail — but a URL a person pasted into a connector's config can
  // carry one (an implicit-flow token is delivered in exactly this position),
  // and it costs one branch to not have to argue about it.
  if (url.hash.length > 0) {
    url.hash = `#${REDACTED_SECRET}`;
    changed = true;
  }

  // The username is kept, matching `redactUrlPassword`. It is the half that
  // identifies which account could not authenticate, which is the first thing an
  // operator reading a failed run wants, and it is not the half that opens
  // anything.
  return changed ? url.toString() : undefined;
}
