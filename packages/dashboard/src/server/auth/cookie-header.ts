/**
 * Parse a raw `Cookie` request header into a name→value map. Dependency-free so it works on raw
 * Express AND Fastify requests without `cookie-parser`. Values are URL-decoded; malformed
 * segments are skipped, never thrown.
 */
export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (typeof header !== 'string' || header === '') return cookies;
  for (const segment of header.split(';')) {
    const eq = segment.indexOf('=');
    if (eq <= 0) continue;
    const name = segment.slice(0, eq).trim();
    if (name === '') continue;
    let rawValue = segment.slice(eq + 1).trim();
    // Strip a single pair of wrapping double-quotes (RFC 6265 quoted form).
    if (rawValue.length >= 2 && rawValue.startsWith('"') && rawValue.endsWith('"')) {
      rawValue = rawValue.slice(1, -1);
    }
    // First occurrence wins; don't clobber an earlier value with a later dup.
    if (name in cookies) continue;
    try {
      cookies[name] = decodeURIComponent(rawValue);
    } catch {
      cookies[name] = rawValue;
    }
  }
  return cookies;
}

export interface SetCookieOptions {
  /** Cookie `Path`. The dashboard scopes its session cookie to `/` — see `session-cookie-io.ts`
   *  for why (the UI mount and the JSON API mount can be configured to live at unrelated paths). */
  path: string;
  /** Cookie lifetime in seconds. Ignored (and forced to 0) when `clear` is set. */
  maxAgeSeconds: number;
  /** Add `Secure` when the request is https. */
  secure: boolean;
  /** Clear the cookie: empty value + `Max-Age=0` (and `Expires` in the past). */
  clear?: boolean;
}

/**
 * Serialize a `Set-Cookie` header value. Always `HttpOnly` + `SameSite=Lax`. Platform-agnostic:
 * just a string.
 *
 * WHAT `SameSite=Lax` BUYS, EXACTLY
 * ---------------------------------
 * A Lax cookie is withheld from every cross-site request except a top-level GET navigation. So it
 * covers the CSRF cases that matter here — a cross-site `fetch`/`XMLHttpRequest`, and a cross-site
 * form `POST` — which is what makes the console's `credentials: 'same-origin'` a real boundary
 * rather than a convention (see `client/transport.ts`): another site's script cannot get this
 * cookie attached to a request at all, whatever the service's CORS says.
 *
 * It does NOT cover a cross-site top-level GET navigation, which is the one thing Lax lets
 * through. That leaves exactly the state-changing GET endpoints exposed, and this package ships
 * one deliberately: `GET <basePath>/logout`. It destroys only the caller's own session, so the
 * worst a third-party link achieves is signing somebody out. The trade is argued where the route
 * is defined — `catalog-auth.controller.ts` — and stated only there, so the two cannot disagree
 * about what is covered.
 *
 * `Strict` was considered and rejected. It costs nothing on the flows this package ships (Mode A's
 * launcher and Mode B's login page both navigate same-origin, via root-relative URLs), but a
 * Strict cookie is also withheld from a top-level navigation ARRIVING from another site — a link
 * to the console from the host's own product on a different registrable domain, a wiki, a chat
 * message. A signed-in operator following one would land on the login page (or, under Mode A, on
 * "open this console from your application"), and be signed in again on reload. That is an
 * intermittent-looking auth bug traded for coverage of GET-only CSRF the package already has no
 * meaningful exposure to.
 */
export function serializeSetCookie(name: string, value: string, options: SetCookieOptions): string {
  const parts = [`${name}=${options.clear ? '' : encodeURIComponent(value)}`];
  parts.push(`Path=${options.path}`);
  parts.push('HttpOnly');
  parts.push('SameSite=Lax');
  if (options.secure) parts.push('Secure');
  if (options.clear) {
    parts.push('Max-Age=0');
    parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  } else {
    parts.push(`Max-Age=${options.maxAgeSeconds}`);
  }
  return parts.join('; ');
}
