import { readFile } from 'node:fs/promises';
import { VaultTransitError } from './errors';
import { type VaultHttp, isRecord } from './http';

/**
 * How this package gets a token, and whose problem it is when the token dies.
 *
 * **Renewal is mine, not the host's — but by re-login, never by a timer.**
 *
 * The obvious implementation is a background `setInterval` calling
 * `auth/token/renew-self`. It is the wrong one here, for reasons that are about
 * this being a *library*:
 *
 * - A timer outlives the call that created it. Nest can tear a module down
 *   without the process exiting (tests do it constantly), and an interval nobody
 *   cleared keeps a handle open and keeps logging in against a Vault the test
 *   already finished with. Getting that right needs `OnModuleDestroy`, which
 *   needs this class to be a provider with a lifecycle, which is a great deal of
 *   machinery for a token.
 * - It renews on wall-clock time rather than on need. Twenty replicas renew
 *   twenty tokens around the clock whether or not anybody sealed a secret that
 *   day, which is load on Vault proportional to fleet size instead of to work.
 * - It does not actually remove the failure case. `renew-self` extends a lease
 *   up to the token's `max_ttl` and then refuses, so any correct implementation
 *   needs the re-login path anyway. Building both means the rare path — the one
 *   that runs at 3am on the day the max TTL is hit — is the one with no
 *   coverage.
 *
 * So: the token is cached with its expiry, refreshed lazily when a call needs
 * one and the cached one is close to expiring, and minted again if Vault rejects
 * it outright. The work happens on the path that needs it, there is nothing to
 * clean up, and the "expired" path is the *same code* as the "first call" path,
 * which is the path every test exercises.
 *
 * **Static tokens are the host's problem, and this says so out loud.**
 * {@link staticToken} cannot mint anything. When its token expires, `seal` and
 * `open` fail with `kind: 'forbidden'` and stay failing until somebody changes
 * the configuration and restarts. That is a real operational cliff and it is not
 * hidden: {@link VaultAuth.canRelogin} is `false`, the error says the strategy
 * cannot re-authenticate, and the README recommends it for development only.
 */

export interface VaultTokenGrant {
  token: string;
  /**
   * The token's TTL in seconds, as Vault reported it. `0` means Vault reported
   * no lease — a root token, or a static one this package was simply handed —
   * and is treated as "no expiry we know of", never as "expires immediately".
   */
  leaseDurationSeconds: number;
}

export interface VaultAuth {
  /** For error messages and the README's wiring table. */
  readonly method: string;
  /**
   * Whether {@link login} can produce a *fresh* token, or only replay one it was
   * given. Decides whether a rejected token is worth one silent retry or is
   * terminal — see {@link VaultSession.withToken}.
   */
  readonly canRelogin: boolean;
  login(http: VaultHttp): Promise<VaultTokenGrant>;
}

/**
 * A token supplied directly — `VAULT_TOKEN`, a dev server's root token, a
 * sidecar that writes one into the environment.
 *
 * Honest about what it is: there is no renewal here, by this package or anybody
 * else, and when the token expires every seal and open fails until the process
 * is restarted with a new one. Fine for `vault server -dev` and for a deployment
 * where an agent sidecar re-injects and restarts. Not fine as the thing standing
 * between a scheduled connector run and its credentials.
 */
export function staticToken(token: string): VaultAuth {
  if (token.length === 0) throw new TypeError('staticToken() was given an empty token');
  return {
    method: 'token',
    canRelogin: false,
    login: () => Promise.resolve({ token, leaseDurationSeconds: 0 }),
  };
}

export interface AppRoleAuthOptions {
  roleId: string;
  secretId: string;
  /** Where the AppRole backend is mounted. `approle` is Vault's default. */
  mount?: string;
}

/**
 * AppRole: a `role_id` that identifies the application and a `secret_id` that
 * proves it. The standard choice outside Kubernetes.
 *
 * The `secret_id` is itself a credential with a TTL and, often, a use count —
 * which means this strategy re-logs-in against a secret that can run out. When
 * it does, the login fails with `forbidden` and names the mount, because the
 * failure looks identical to a policy problem and the fix is completely
 * different (re-issue the secret_id, versus edit a policy).
 */
export function appRoleAuth(options: AppRoleAuthOptions): VaultAuth {
  const mount = options.mount ?? 'approle';
  return {
    method: `approle (${mount})`,
    canRelogin: true,
    login: (http) =>
      loginWith(http, `auth/${mount}/login`, {
        role_id: options.roleId,
        secret_id: options.secretId,
      }),
  };
}

export interface KubernetesAuthOptions {
  /** The Vault role bound to this service account. */
  role: string;
  /** Where the Kubernetes backend is mounted. `kubernetes` is Vault's default. */
  mount?: string;
  /** Overridable for tests and for a non-default projected volume mount path. */
  jwtPath?: string;
}

export const DEFAULT_SERVICE_ACCOUNT_TOKEN_PATH =
  '/var/run/secrets/kubernetes.io/serviceaccount/token';

/**
 * Kubernetes auth: the pod's projected service-account JWT is the proof.
 *
 * **The file is read on every login, never cached.** Projected service-account
 * tokens are short-lived and the kubelet rewrites the file in place as they
 * approach expiry. A JWT read once at construction is valid for perhaps an hour
 * and then is not, and the pod that has been up for a day holds a token Vault
 * refuses — which presents as a permission problem, hours after the last
 * deploy, with nothing having changed. Reading per login costs one `open` of a
 * tmpfs file on a path that already involves a network round trip.
 */
export function kubernetesAuth(options: KubernetesAuthOptions): VaultAuth {
  const mount = options.mount ?? 'kubernetes';
  const jwtPath = options.jwtPath ?? DEFAULT_SERVICE_ACCOUNT_TOKEN_PATH;
  return {
    method: `kubernetes (${mount})`,
    canRelogin: true,
    login: async (http) => {
      let jwt: string;
      try {
        jwt = (await readFile(jwtPath, 'utf8')).trim();
      } catch (cause) {
        // Not `unreachable`: nothing was attempted against Vault, and a caller
        // retrying this forever will not make the file appear. A missing
        // projected token is a pod spec that is wrong.
        throw new VaultTransitError(
          `Kubernetes auth could not read the service account token at ${jwtPath}`,
          { kind: 'invalid-request', cause },
        );
      }
      return loginWith(http, `auth/${mount}/login`, { role: options.role, jwt });
    },
  };
}

/** The shared half of every login backend: POST credentials, read `auth` back. */
async function loginWith(
  http: VaultHttp,
  path: string,
  body: Record<string, unknown>,
): Promise<VaultTokenGrant> {
  const response = await http.post(path, body);
  const auth = response.auth;
  if (!isRecord(auth) || typeof auth.client_token !== 'string') {
    throw new VaultTransitError(`Vault login at ${path} returned no client token`, {
      kind: 'malformed-response',
      path,
    });
  }
  return {
    token: auth.client_token,
    leaseDurationSeconds: typeof auth.lease_duration === 'number' ? auth.lease_duration : 0,
  };
}

export interface VaultSessionOptions {
  auth: VaultAuth;
  http: VaultHttp;
  /**
   * How early to treat a token as expired, as a fraction of its lease. A token
   * with 5% of a 60-second lease left will be rejected by the time the request
   * lands, and the resulting `forbidden` costs a round trip to discover.
   */
  refreshAtRemainingFraction?: number;
  /** Injectable for tests. Nothing else should pass it. */
  now?: () => number;
}

const DEFAULT_REFRESH_FRACTION = 0.1;
/** A floor under the fractional skew: 10% of a 10-second lease is a millisecond
 *  of headroom, which is no headroom across a network. */
const MIN_SKEW_MS = 10_000;

/**
 * The cached token, and the single retry that makes an expired one invisible.
 */
export class VaultSession {
  private grant?: { token: string; expiresAtMs?: number; leaseMs: number };
  /** The in-flight login, so N concurrent callers cause one login rather than N.
   *  Without this a cold start that opens forty connectors at once opens forty
   *  logins, which is how an AppRole with `secret_id_num_uses` burns out in a
   *  second and how a rate limit quota gets hit by a healthy deployment. */
  private pending?: Promise<string>;
  private readonly now: () => number;
  private readonly fraction: number;

  constructor(private readonly options: VaultSessionOptions) {
    this.now = options.now ?? Date.now;
    this.fraction = options.refreshAtRemainingFraction ?? DEFAULT_REFRESH_FRACTION;
  }

  /**
   * Runs `call` with a valid token, minting one if needed, and retries **once**
   * if Vault rejects the token anyway.
   *
   * The retry is what makes lazy renewal correct rather than merely cheap. A
   * cached token can be revoked, or the lease can have been shorter than Vault
   * reported, or a clock can be wrong — and in all three the first call comes
   * back `403` with a perfectly valid cached token in hand. Re-login and one
   * repeat covers every one of them, and it covers them without the caller
   * knowing that tokens exist.
   *
   * It is exactly once. A second failure with a token minted seconds ago is not
   * an expiry — it is a policy that does not grant this path, and repeating it
   * turns a clear `permission denied` into a slow one.
   */
  async withToken<T>(call: (token: string) => Promise<T>): Promise<T> {
    try {
      return await call(await this.token());
    } catch (error) {
      if (!isForbidden(error) || !this.options.auth.canRelogin) throw error;
      this.invalidate();
      return call(await this.token());
    }
  }

  /** The cached token, or a freshly minted one. */
  async token(): Promise<string> {
    const cached = this.grant;
    if (cached !== undefined && !this.isExpiring(cached)) return cached.token;
    if (this.pending !== undefined) return this.pending;

    const pending = this.login();
    this.pending = pending;
    try {
      return await pending;
    } finally {
      // Cleared whether the login succeeded or threw. Leaving a rejected promise
      // cached would make one failed login the permanent answer for the life of
      // the process — every later call would await the same rejection and never
      // attempt Vault again.
      this.pending = undefined;
    }
  }

  /** Forget the cached token. Called when Vault rejects it. */
  invalidate(): void {
    this.grant = undefined;
  }

  private async login(): Promise<string> {
    const grant = await this.options.auth.login(this.options.http);
    const leaseMs = grant.leaseDurationSeconds * 1000;
    this.grant = {
      token: grant.token,
      leaseMs,
      // A zero lease means "Vault told us nothing", which is not the same as
      // "expires now". Recording no expiry keeps the token in use until Vault
      // itself rejects it, at which point `withToken` mints another.
      expiresAtMs: leaseMs > 0 ? this.now() + leaseMs : undefined,
    };
    return grant.token;
  }

  /**
   * Whether the cached token is close enough to expiry to replace now.
   *
   * The window is a fraction of the **original lease**, floored at
   * {@link MIN_SKEW_MS}. A fraction alone is wrong at both ends: 10% of a
   * ten-second lease is a millisecond, which is less than one round trip to
   * Vault, so the token would be handed out and rejected. The floor alone is
   * wrong too — a 24-hour token would be refreshed only in its last ten seconds,
   * so every replica refreshes inside the same ten-second window every day.
   */
  private isExpiring(grant: { expiresAtMs?: number; leaseMs: number }): boolean {
    if (grant.expiresAtMs === undefined) return false;
    const skew = Math.max(MIN_SKEW_MS, grant.leaseMs * this.fraction);
    return grant.expiresAtMs - this.now() <= skew;
  }
}

function isForbidden(error: unknown): boolean {
  return error instanceof VaultTransitError && error.kind === 'forbidden';
}
