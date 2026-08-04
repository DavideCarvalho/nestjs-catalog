export type {
  DashboardAuthOptions,
  // What `DASHBOARD_AUTH` actually carries. A host reading the session off a
  // request injects that token and needs a name for what comes out.
  ResolvedDashboardAuth,
  UnauthenticatedPageContext,
  UnauthenticatedPageHook,
} from './auth/dashboard-auth-config.js';
export { DASHBOARD_AUTH } from './auth/dashboard-auth-config.js';
export type { DashboardSession, DashboardSessionUser } from './auth/session-cookie.js';
/**
 * Read and verify the console's session off a request.
 *
 * Exported because this package deliberately does NOT proxy the catalog's API —
 * that surface is mounted by `CatalogModule` and guarded by whatever the host
 * put in front of it. Which leaves a gap the host cannot close on its own: the
 * console SPA fetches that API from a browser, carrying this cookie and no
 * bearer token, so a host whose API guard only understands its own token
 * answers 401 to every screen while the console shell loads perfectly. The
 * symptom reads as a broken API, not as two auth systems that were never
 * introduced.
 *
 * So the host's own resolver can ask this: given a request, is there a valid
 * console session on it, and whose? Signature and expiry are checked here;
 * `revalidate` is not run, because that is renewal and belongs to the guard
 * that owns the cookie's lifetime.
 *
 * The ready-made half of the same answer is `CatalogApiSessionGuard` below —
 * take that when a console session simply IS the credential for the host's API
 * surface, and this when the host has a guard already and needs the identity
 * rather than a verdict.
 */
export { readSessionFromRequest as readCatalogConsoleSession } from './auth/session-cookie-io.js';
export { CatalogAuthController } from './catalog-auth.controller.js';
export {
  CatalogDashboardModule,
  catalogDashboardMountPaths,
  type CatalogDashboardAsyncOptions,
  type CatalogDashboardOptions,
} from './catalog-dashboard.module.js';
/**
 * `CatalogUiSessionGuard` is stamped on the console shell by the module and needs nothing from a
 * host. `CatalogApiSessionGuard` is the opposite: it is bound to nothing, because the API it
 * guards is mounted in the HOST's tree — apply it there with `@UseGuards`, having imported
 * `CatalogDashboardModule` (which provides and exports it). See its docblock.
 */
export {
  CatalogApiSessionGuard,
  CatalogUiSessionGuard,
} from './catalog-session.guard.js';
export {
  CatalogUiController,
  DASHBOARD_API_PATH,
  DASHBOARD_BASE_PATH,
} from './catalog-ui.controller.js';
