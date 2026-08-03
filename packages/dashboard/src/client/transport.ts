import type { CatalogTransport } from '@dudousxd/nestjs-catalog-react';

/**
 * The developer escape hatch, and nothing else.
 *
 * A signed-in person's credential is **not** here and cannot be: it is an
 * `HttpOnly` cookie, which this file has no way to read and no need to — the
 * browser attaches it to every same-origin request on its own. That is the
 * point. This console renders labels, descriptions, SQL, transform source and
 * verbatim MySQL error strings that other people wrote, so it should be assumed
 * that script can end up running in this page; a credential in `localStorage`
 * is one line of that script away from leaving the building, and a cookie the
 * page cannot read is not.
 *
 * What stays here is a raw application key, for a developer working against a
 * local service who does not want to seed a user first. It is off by default,
 * it is never set by signing in, and the moment one is stored every request
 * this console makes is attributed to that application rather than to a person
 * — which is exactly the thing being fixed, so it is worth seeing on screen.
 * Set it from the sign-in screen's "use an application key" panel, or from the
 * devtools console with:
 *
 *   localStorage.setItem("catalog.devKey", "…"); location.reload();
 */
const DEV_KEY_STORAGE = 'catalog.devKey';

/** A previous build kept the console's shared key here. Cleared on sight. */
const LEGACY_KEY_STORAGE = 'catalog.key';

export function getDevKey(): string | null {
  // Migrating rather than reading both: leaving the old entry in place means a
  // browser that was open before this change keeps authenticating as the old
  // shared console key forever, and nobody would ever see the sign-in screen.
  const legacy = localStorage.getItem(LEGACY_KEY_STORAGE);
  if (legacy !== null) {
    localStorage.removeItem(LEGACY_KEY_STORAGE);
  }
  return localStorage.getItem(DEV_KEY_STORAGE);
}

export function setDevKey(key: string): void {
  localStorage.setItem(DEV_KEY_STORAGE, key);
}

export function clearDevKey(): void {
  localStorage.removeItem(DEV_KEY_STORAGE);
}

export class UnauthorizedError extends Error {}

async function request<T>(
  path: string,
  init: RequestInit & { params?: Record<string, unknown> } = {},
): Promise<T> {
  const { params, ...rest } = init;
  const url = new URL(`/api${path}`, window.location.origin);
  for (const [name, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(name, String(value));
    }
  }

  const devKey = getDevKey();

  const response = await fetch(url, {
    ...rest,
    // Explicit rather than relying on the default. The session cookie is
    // `SameSite=Strict`, so it rides along on same-origin requests and on
    // nothing else — which is what stops the service's permissive CORS from
    // being a way for another site to act as a signed-in user.
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      // Only when a developer has deliberately stored one. Sending an empty
      // header on every request would make "no key" and "wrong key" the same
      // thing on the server, and there is a real difference between them.
      ...(devKey ? { 'x-catalog-key': devKey } : {}),
      // Always sent, and never defaulted server-side. An environment the caller
      // did not choose is the one thing this design refuses to guess: silently
      // answering with production because nobody said otherwise is how a test
      // becomes an incident.
      'x-catalog-environment': getEnvironment(),
      ...rest.headers,
    },
  });

  if (response.status === 401 || response.status === 403) {
    throw new UnauthorizedError(await response.text());
  }
  if (!response.ok) {
    // Surface the server's own words. For the query console especially, "Unknown
    // column 'foo'" is the entire value of the error — a status code tells the
    // person typing nothing they can act on.
    const detail = await response.text();
    let message = `${init.method ?? 'GET'} ${path} → ${response.status}`;
    try {
      const parsed = JSON.parse(detail) as { message?: string | string[] };
      if (parsed.message) {
        message = Array.isArray(parsed.message) ? parsed.message.join(', ') : parsed.message;
      }
    } catch {
      if (detail) message = detail;
    }
    throw new Error(message);
  }
  const text = await response.text();
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

export const transport: CatalogTransport = {
  get: (path, params) => request(path, { params }),
  patch: (path, body) => request(path, { method: 'PATCH', body: JSON.stringify(body) }),
  post: (path, body) =>
    request(path, {
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  delete: (path) => request(path, { method: 'DELETE' }),
};

/** Endpoints outside the catalog library's own surface. */
export const api = {
  me: () => request<Identity>('/auth/me'),
  login: (email: string, password: string) =>
    request<Identity>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  logout: () => request<{ signedOut: boolean }>('/auth/logout', { method: 'POST' }),
  principals: () => request<PrincipalSummary[]>('/access/principals'),
  people: () => request<PersonSummary[]>('/access/people'),
  upsertPerson: (input: {
    email: string;
    displayName: string;
    role: PersonRole;
    password?: string;
    active?: boolean;
  }) =>
    request<{ email: string; created: boolean; sessionsRevoked: boolean }>('/access/people', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  snapshots: (type: string) => request<SnapshotSummary[]>(`/publish/${type}/snapshots`),
  aiCapabilities: () =>
    request<{ available: boolean; provider: string | null }>('/query-ai/capabilities'),
  generateSql: (prompt: string) =>
    request<{ sql: string }>('/query-ai/generate', {
      method: 'POST',
      body: JSON.stringify({ prompt }),
    }),
};

export type PersonRole = 'viewer' | 'curator' | 'admin';

/**
 * Who the server thinks is calling.
 *
 * `kind` is the distinction the whole sign-in exists to make: `"user"` means a
 * person is behind this and `principalId` names them, `"application"` means a
 * key is and it does not.
 */
export interface Identity {
  kind: 'user' | 'application';
  /** Exactly the string that will land in the audit trail for anything you do. */
  principalId: string;
  applicationId: string;
  displayName: string;
  actor: { id: string; displayName: string } | null;
  scopes: string[];
  writeTypes: string[];
  readTypes: string[] | null;
  classifications: string[];
  session: { expiresAt: string; idleMinutes: number } | null;
}

export interface PrincipalSummary {
  id: string;
  displayName: string;
  scopes: string[];
  writeTypes: string[];
  readTypes: string[] | null;
  classifications: string[];
  active: boolean;
  authMethod: 'key' | 'token' | 'session';
  lastSeenAt: string | null;
  ownedTypes: string[];
}

export interface PersonSummary {
  email: string;
  displayName: string;
  role: PersonRole;
  active: boolean;
  principalId: string;
  hasPassword: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  liveSessions: number;
  effective: {
    scopes: string[];
    writeTypes: string[];
    readTypes: string[] | null;
    classifications: string[];
  };
}

export interface SnapshotSummary {
  id: string;
  createdAt: string;
  rowCount: number;
  principalId: string;
  labels?: Record<string, string>;
}

/**
 * Which copy of the world this console is looking at.
 *
 * Kept in `localStorage` rather than in React state so a reload does not
 * silently move somebody from staging to production between two clicks, and
 * read on every request rather than captured once, so switching takes effect
 * without a remount.
 *
 * There is no default beyond the first environment on the release path. Picking
 * production for somebody who never chose it is exactly the mistake the server
 * refuses to make, and a client that quietly supplies what the server refused
 * to assume has undone the protection.
 */
const ENVIRONMENT_STORAGE_KEY = 'catalog.environment';

export function getEnvironment(): string {
  const stored = window.localStorage.getItem(ENVIRONMENT_STORAGE_KEY);
  return stored && stored.length > 0 ? stored : 'dev';
}

export function setEnvironment(id: string): void {
  window.localStorage.setItem(ENVIRONMENT_STORAGE_KEY, id);
}

export interface CatalogEnvironmentSummary {
  id: string;
  displayName: string;
  rank: number;
  protected: boolean;
}

/** The environments this deployment serves. Needs no environment of its own. */
export function listEnvironments(): Promise<CatalogEnvironmentSummary[]> {
  return request<CatalogEnvironmentSummary[]>('/environments');
}
