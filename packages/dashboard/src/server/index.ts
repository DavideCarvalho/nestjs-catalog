export type {
  DashboardAuthOptions,
  UnauthenticatedPageContext,
  UnauthenticatedPageHook,
} from './auth/dashboard-auth-config.js';
export { DASHBOARD_AUTH } from './auth/dashboard-auth-config.js';
export type { DashboardSessionUser } from './auth/session-cookie.js';
export { CatalogAuthController } from './catalog-auth.controller.js';
export {
  CatalogDashboardModule,
  catalogDashboardMountPaths,
  type CatalogDashboardAsyncOptions,
  type CatalogDashboardOptions,
} from './catalog-dashboard.module.js';
export {
  CatalogApiSessionGuard,
  CatalogUiSessionGuard,
} from './catalog-session.guard.js';
export {
  CatalogUiController,
  DASHBOARD_API_PATH,
  DASHBOARD_BASE_PATH,
} from './catalog-ui.controller.js';
