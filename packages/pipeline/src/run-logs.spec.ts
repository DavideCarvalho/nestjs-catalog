import { describe, expect, it } from 'vitest';
import { LOG_LINE_CHARS, capLines, redactLines, redactSecrets, safeLogLines } from './run-logs';

describe('redactSecrets', () => {
  // The literal thing `fetchHttp` throws. A credential-bearing URL that failed
  // once was readable from `GET pipeline/runs` by every holder of `catalog:read`.
  it('takes the password out of a URL inside a sentence', () => {
    expect(redactSecrets('GET https://ana:hunter2@vendor.example/v1/items → 401')).toBe(
      'GET https://ana:REDACTED@vendor.example/v1/items → 401',
    );
  });

  // The one the whole design of `sources.ts` rests on: a connection URL *is* the
  // credential, and a driver quoting one in an error is the same leak in a
  // different sentence.
  it('takes the password out of a SQL connection URL', () => {
    expect(redactSecrets('connect ECONNREFUSED postgres://svc:s3cr3t@warehouse:5432/fleet')).toBe(
      'connect ECONNREFUSED postgres://svc:REDACTED@warehouse:5432/fleet',
    );
  });

  // The username identifies which account could not authenticate, which is the
  // first thing an operator wants, and it is not the half that opens anything.
  // `redactUrlPassword` in `config-secrets.ts` draws the line in the same place.
  it('keeps the username', () => {
    expect(redactSecrets('GET https://ana:pw@host/x → 401')).toContain('ana:');
  });

  // The whole query, not the parameters that look sensitive. Naming them is a
  // deny-list, and this file exists because a deny-list lost: `token`, `sig`,
  // `X-Amz-Signature`, `access_token`, and whatever the next vendor calls it.
  it('takes the whole query string, not the parameters it recognises', () => {
    expect(redactSecrets('GET https://vendor.example/v1?page=2&api_key=abc123 → 500')).toBe(
      'GET https://vendor.example/v1?REDACTED → 500',
    );
  });

  it('takes a signed object-store URL down to its path', () => {
    const signed =
      'GET https://bucket.s3.amazonaws.com/drop.csv?X-Amz-Signature=deadbeef&X-Amz-Expires=900 → 403';
    expect(redactSecrets(signed)).toBe(
      'GET https://bucket.s3.amazonaws.com/drop.csv?REDACTED → 403',
    );
  });

  it('takes the fragment, where an implicit-flow token is delivered', () => {
    expect(redactSecrets('opened https://idp.example/cb#access_token=abc')).toBe(
      'opened https://idp.example/cb#REDACTED',
    );
  });

  // Not an optimisation. Round-tripping through `URL` normalises — a bare host
  // gains a slash, characters get percent-encoded — and quietly rewriting every
  // innocuous URL in every log in the system is a change nobody asked for
  // showing up where people go when they are already confused.
  it('leaves a URL with nothing to hide byte for byte as it was', () => {
    const line = 'Read s3://drops/2026/02/part-00000 (1,200 rows)';
    expect(redactSecrets(line)).toBe(line);
    expect(redactSecrets('GET https://vendor.example/v1/items → 404')).toBe(
      'GET https://vendor.example/v1/items → 404',
    );
  });

  it('leaves a line with no URL in it alone', () => {
    const line = 'Transform "Normalise" v3 produced 1,200 rows in 84ms.';
    expect(redactSecrets(line)).toBe(line);
    expect(redactSecrets('')).toBe('');
  });

  // The two runners redact a node's logs where they are produced and again where
  // the run is finished, so this has to be free to repeat. It also means a
  // second pass cannot corrupt the first.
  it('is idempotent', () => {
    const once = redactSecrets('GET https://ana:pw@host/x?token=abc#f → 401');
    expect(redactSecrets(once)).toBe(once);
  });

  it('redacts every URL in a line, not just the first', () => {
    expect(redactSecrets('copied postgres://a:1@src/db into postgres://b:2@dst/db')).toBe(
      'copied postgres://a:REDACTED@src/db into postgres://b:REDACTED@dst/db',
    );
  });

  // The URL run is delimited by whitespace, so the full stop that ends the
  // sentence would otherwise be swallowed into the path and put back in the
  // wrong place.
  it('does not eat the punctuation that ends the sentence', () => {
    expect(redactSecrets('Could not reach https://ana:pw@host/x?t=1.')).toBe(
      'Could not reach https://ana:REDACTED@host/x?REDACTED.',
    );
    expect(redactSecrets('(see https://ana:pw@host/x)')).toBe('(see https://ana:REDACTED@host/x)');
  });

  it('leaves something that only looks like a URL alone', () => {
    expect(redactSecrets('ratio 3://4')).toBe('ratio 3://4');
  });
});

describe('redactLines', () => {
  it('redacts each line and keeps the order', () => {
    expect(redactLines(['fine', 'GET https://a:b@h/x → 401', 'also fine'])).toEqual([
      'fine',
      'GET https://a:REDACTED@h/x → 401',
      'also fine',
    ]);
  });

  it('has nothing to say about no lines', () => {
    expect(redactLines([])).toEqual([]);
  });
});

describe('capLines', () => {
  // Both axes, and that is the point: capping the count alone still let a single
  // line naming every record it received put ~10KB into a step's output
  // checkpoint — and it grew with the data, which is what a step boundary and a
  // run row must never do.
  it('drops the lines past the cap', () => {
    expect(capLines(['a', 'b', 'c'], 2)).toEqual(['a', 'b']);
  });

  it('truncates a long line and says by how much', () => {
    expect(capLines(['x'.repeat(30)], 5, 10)[0]).toBe(`${'x'.repeat(10)}… (20 more characters)`);
  });

  it('says nothing about a line that fits exactly', () => {
    expect(capLines(['x'.repeat(10)], 5, 10)).toEqual(['x'.repeat(10)]);
  });

  it('has a default line length, so a caller cannot forget the second axis', () => {
    expect(capLines(['x'.repeat(5_000)], 5)[0]?.length).toBeLessThan(LOG_LINE_CHARS + 40);
  });
});

describe('safeLogLines', () => {
  it('does both jobs', () => {
    const [line] = safeLogLines(['GET https://a:b@h/x → 401', 'dropped'], 1);
    expect(line).toBe('GET https://a:REDACTED@h/x → 401');
    expect(safeLogLines(['GET https://a:b@h/x → 401', 'dropped'], 1)).toHaveLength(1);
  });

  // The ordering, as a test, with the wrong order run beside it so the claim is
  // demonstrated rather than asserted. Cutting first hands the redactor a line
  // whose URL has lost its `@` — `ana:hunter2is` reads as a host and a port,
  // which does not parse — so nothing is redacted and the first nine characters
  // of the password are published. There are four call sites and it only takes
  // one of them getting this backwards.
  it('redacts before it cuts, so a password across the cut is not half-published', () => {
    const line = `${'x'.repeat(78)} https://ana:hunter2is-a-very-long-password@vendor.example/items`;

    // What the wrong order would have written into the run row.
    const [wrongWayRound] = redactLines(capLines([line], 1, 100));
    expect(wrongWayRound).toContain('hunter2');

    const [safe] = safeLogLines([line], 1, 100);
    expect(safe).not.toContain('hunter2');
    expect(safe).toContain('REDACTED');
  });

  it('still applies the cut after redacting', () => {
    const [safe] = safeLogLines([`${'x'.repeat(500)} https://a:b@h/x`], 1, 100);
    expect(safe).toContain('more characters');
    expect(safe?.length).toBeLessThan(140);
  });
});
