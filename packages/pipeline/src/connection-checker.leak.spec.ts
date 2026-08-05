import type { CatalogConnection } from '@dudousxd/nestjs-catalog';
import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionChecker } from './connection-checker.service';

/**
 * What a failed connection check tells the caller.
 *
 * `POST pipeline/connections/:id/check` asks only `catalog:read`, and a probe
 * that fails throws with the address in its message — `GET https://…` for an
 * HTTP source, the driver's own text for a SQL one. A connection URL is the
 * credential, so the softest scope in the system was reading the strongest
 * secret in it, through an error string rather than through the config the
 * redaction was built to guard.
 *
 * The check is not made useless by fixing it: which host refused, and as whom,
 * is the entire value of a failed check. What goes is the password, the query
 * string and the fragment — the three places a credential rides in a URL.
 */

let checker: ConnectionChecker;

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  checker = new ConnectionChecker();
  // A server that ANSWERS, refusing. That is the path that puts the URL into
  // the message — `probeHttp` throws `${url} answered ${status}.` — and it is
  // the only deterministic one.
  //
  // My first version of this file let the connection be refused instead, which
  // makes `fetch` throw its own 'fetch failed' with no URL in it at all. Every
  // "does not contain the password" assertion passed against a string that had
  // never contained one: green, and proving nothing.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve({ ok: false, status: 401, text: () => Promise.resolve('') })),
  );
});

/** A connection whose probe is guaranteed to fail, with the URL in the message. */
function unreachable(url: string): CatalogConnection {
  return {
    id: 'c1',
    name: 'Fleet warehouse',
    kind: 'http',
    config: { url },
    createdBy: 'davi',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('a failed connection check', () => {
  it('does not hand the password back in the error', async () => {
    // THE case. The route is `catalog:read`; the password is not.
    const result = await checker.check(
      unreachable('http://user:S3cr3t@127.0.0.1:1/nowhere'),
    );

    expect(result.ok).toBe(false);
    expect(result.error ?? '').not.toContain('S3cr3t');
  });

  it('does not hand back a query string, which is where tokens ride', async () => {
    // Redacting the password alone would leave `?api_key=…` — the other half of
    // how a credential travels in a URL, and the half a deny-list of "sensitive"
    // parameter names would keep missing.
    const result = await checker.check(
      unreachable('http://127.0.0.1:1/nowhere?api_key=abcdef123456'),
    );

    expect(result.error ?? '').not.toContain('abcdef123456');
  });

  it('still says which host refused, and as whom', async () => {
    // The redaction has to leave a usable answer behind. An operator reading
    // "Could not reach it." with no address cannot tell a typo from an outage,
    // and would go looking in the process log — which is exactly the trip this
    // route exists to save them.
    const result = await checker.check(
      unreachable('http://reader:S3cr3t@127.0.0.1:1/nowhere'),
    );

    expect(result.error ?? '').toContain('127.0.0.1');
    expect(result.error ?? '').toContain('reader');
  });

  it('leaves an address with no credential in it exactly as it was', async () => {
    // Most checks fail for ordinary reasons against ordinary URLs. A redaction
    // that rewrote those too — normalising a trailing slash, reordering
    // nothing — would make every message subtly not what the driver said.
    const result = await checker.check(unreachable('http://warehouse.internal/health'));

    expect(result.error ?? '').toContain('http://warehouse.internal/health');
  });
});
