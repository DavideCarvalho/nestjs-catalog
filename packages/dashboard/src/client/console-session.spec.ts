/**
 * The mint-then-navigate call, which is the whole of what `useOpenCatalogConsole` and
 * `<OpenCatalogConsoleButton>` do — they only add state around it.
 *
 * Tested at this level rather than through the button because every rule worth protecting lives
 * here: which URL is derived from `basePath`, that the request is sent with the flags that make the
 * cookie stick, that a redirect is a REFUSAL rather than a success, and that a refusal never
 * navigates. A launcher that navigates on a refused mint drops the user on the console's "no
 * session" page, which reads as a broken console rather than as a permission decision.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ConsoleSessionError,
  catalogConsoleSessionUrl,
  catalogConsoleUrl,
  mintCatalogConsoleSession,
  openCatalogConsole,
} from './console-session.js';

/** A `fetch` that answers once and records exactly what it was called with. */
function fetchStub(response: Response | Error) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl: typeof globalThis.fetch = (input, init = {}) => {
    calls.push({ url: String(input), init });
    return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
  };
  return { impl, calls };
}

/**
 * A browser's answer to `redirect: 'manual'`, which is not a normal `Response`: `type` is
 * `opaqueredirect` and `status` is 0, neither of which the `Response` constructor will produce.
 * Defined on the instance so the rest of the object stays a real `Response`.
 */
function opaqueRedirect(): Response {
  const response = new Response(null, { status: 200 });
  Object.defineProperty(response, 'type', { value: 'opaqueredirect' });
  Object.defineProperty(response, 'status', { value: 0 });
  return response;
}

describe('catalogConsoleSessionUrl / catalogConsoleUrl', () => {
  // The route belongs to this package (the auth controller is mounted relative to `basePath`), so
  // a host that hardcodes it is guessing. These pin what it derives, including the two inputs a
  // host is most likely to hand over: a trailing slash, and a path with no leading one.
  it('derives the session endpoint from the mount default', () => {
    expect(catalogConsoleSessionUrl()).toBe('/catalog/session');
    expect(catalogConsoleUrl()).toBe('/catalog');
  });

  it('accepts a custom mount', () => {
    expect(catalogConsoleSessionUrl('/admin/catalog')).toBe('/admin/catalog/session');
    expect(catalogConsoleUrl('/admin/catalog')).toBe('/admin/catalog');
  });

  it.each([
    ['/catalog/', '/catalog/session'],
    ['/catalog///', '/catalog/session'],
    // No leading slash: concatenating raw would produce `catalog/session`, a relative URL that
    // resolves against whatever page the launcher happens to be on.
    ['catalog', '/catalog/session'],
    ['  /catalog  ', '/catalog/session'],
  ])('normalises %o', (basePath, expected) => {
    expect(catalogConsoleSessionUrl(basePath)).toBe(expected);
  });

  // Mounted at the root: the session endpoint is still a real path, and the console itself is `/`
  // rather than the empty string, which is not a URL a navigation can use.
  it('handles a root mount', () => {
    expect(catalogConsoleSessionUrl('/')).toBe('/session');
    expect(catalogConsoleUrl('/')).toBe('/');
  });
});

describe('mintCatalogConsoleSession', () => {
  it('POSTs to the derived endpoint with the flags that make the cookie stick', async () => {
    const { impl, calls } = fetchStub(new Response(null, { status: 204 }));

    await mintCatalogConsoleSession({ basePath: '/admin/catalog', fetch: impl });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/admin/catalog/session');
    expect(calls[0]?.init.method).toBe('POST');
    // `credentials: 'include'` is why the Set-Cookie sticks at all.
    expect(calls[0]?.init.credentials).toBe('include');
    // `redirect: 'manual'` is load-bearing: fetch follows redirects by default, so an auth layer
    // that rewrites 401 into "go to /signin" would make this resolve 200 against the sign-in HTML.
    expect(calls[0]?.init.redirect).toBe('manual');
  });

  it('forwards static headers', async () => {
    const { impl, calls } = fetchStub(new Response(null, { status: 204 }));

    await mintCatalogConsoleSession({ fetch: impl, headers: { authorization: 'Bearer abc' } });

    expect(calls[0]?.init.headers).toEqual({ authorization: 'Bearer abc' });
  });

  it.each([
    ['sync', () => ({ authorization: 'Bearer fresh' })],
    ['async', async () => ({ authorization: 'Bearer fresh' })],
  ])('resolves a %s headers function at call time, not at wiring time', async (_kind, headers) => {
    const { impl, calls } = fetchStub(new Response(null, { status: 204 }));

    await mintCatalogConsoleSession({ fetch: impl, headers });

    // The point of accepting a function: a refreshing token must be read now, not captured when
    // the launcher was configured.
    expect(calls[0]?.init.headers).toEqual({ authorization: 'Bearer fresh' });
  });

  it('forwards an abort signal', async () => {
    const { impl, calls } = fetchStub(new Response(null, { status: 204 }));
    const controller = new AbortController();

    await mintCatalogConsoleSession({ fetch: impl, signal: controller.signal });

    expect(calls[0]?.init.signal).toBe(controller.signal);
  });

  it('refuses a non-ok answer, carrying the status', async () => {
    const { impl } = fetchStub(new Response('nope', { status: 403 }));

    const error = await mintCatalogConsoleSession({ fetch: impl }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConsoleSessionError);
    expect(error).toMatchObject({ status: 403, url: '/catalog/session' });
    expect(String(error)).toContain('403');
  });

  // Both halves of the redirect case, because the two runtimes disagree on how they report it and
  // a fix that only handles one of them looks correct in Node tests and fails in the browser.
  it('refuses a Node-style 3xx rather than treating it as a mint', async () => {
    const { impl } = fetchStub(new Response(null, { status: 302 }));

    const error = await mintCatalogConsoleSession({ fetch: impl }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConsoleSessionError);
    expect(error).toMatchObject({ status: 302 });
    expect(String(error)).toContain('redirect');
  });

  it('refuses a browser-style opaque redirect, whose status is 0', async () => {
    const { impl } = fetchStub(opaqueRedirect());

    const error = await mintCatalogConsoleSession({ fetch: impl }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConsoleSessionError);
    expect(String(error)).toContain('redirect');
    // Status 0 is not a status. Reporting it as one would send a reader looking for HTTP 0.
    expect(error).toMatchObject({ status: undefined });
  });

  it('wraps a network failure, with no status to report', async () => {
    const { impl } = fetchStub(new TypeError('Failed to fetch'));

    const error = await mintCatalogConsoleSession({ fetch: impl }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConsoleSessionError);
    expect(error).toMatchObject({ status: undefined, url: '/catalog/session' });
    expect(String(error)).toContain('Failed to fetch');
  });

  it('says so when there is no fetch to call', async () => {
    // A caller in a runtime with no global `fetch` should get a sentence naming the option to
    // pass, not `doFetch is not a function` thrown from inside the library.
    vi.stubGlobal('fetch', undefined);
    try {
      const error = await mintCatalogConsoleSession().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConsoleSessionError);
      expect(String(error)).toContain('options.fetch');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('openCatalogConsole', () => {
  it('navigates to the console only after the mint succeeds', async () => {
    const { impl } = fetchStub(new Response(null, { status: 204 }));
    const navigate = vi.fn();

    await openCatalogConsole({ basePath: '/admin/catalog', fetch: impl, navigate });

    expect(navigate.mock.calls).toEqual([['/admin/catalog']]);
  });

  it('does not navigate when the mint is refused', async () => {
    const { impl } = fetchStub(new Response(null, { status: 401 }));
    const navigate = vi.fn();

    await expect(openCatalogConsole({ fetch: impl, navigate })).rejects.toBeInstanceOf(
      ConsoleSessionError,
    );

    // The regression this guards: landing on the console with no session looks like a bug, so a
    // refusal has to stay a refusal all the way up to the caller.
    expect(navigate).not.toHaveBeenCalled();
  });

  it('does not navigate when the endpoint answers with a redirect', async () => {
    const { impl } = fetchStub(opaqueRedirect());
    const navigate = vi.fn();

    await expect(openCatalogConsole({ fetch: impl, navigate })).rejects.toBeInstanceOf(
      ConsoleSessionError,
    );
    expect(navigate).not.toHaveBeenCalled();
  });
});
