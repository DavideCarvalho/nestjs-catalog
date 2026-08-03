import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { DASHBOARD_AUTH, type DashboardAuthOptions } from './auth/dashboard-auth-config.js';
import { CatalogAuthController } from './catalog-auth.controller.js';
import {
  CatalogUiController,
  DASHBOARD_API_PATH,
  DASHBOARD_BASE_PATH,
} from './catalog-ui.controller.js';

export interface CatalogDashboardOptions {
  /**
   * Where the console is served. Default `/catalog`.
   *
   * Not under the host's API prefix: this serves HTML and assets, and a host
   * that sets a global `/api` prefix has to exclude these paths from it — see
   * {@link catalogDashboardMountPaths}.
   */
  path?: string;
  /**
   * Where the catalog's JSON API lives, baked into the SPA so it knows what to
   * call. Default `/api/catalog-service`.
   *
   * A separate option because the console does NOT proxy the API — unlike some
   * Aviary dashboards, the catalog's HTTP surface is already mounted by
   * `CatalogModule` and `CatalogPipelineModule`, and a second copy behind this
   * console would be a second set of routes to keep authorised.
   */
  apiPath?: string;
  /**
   * How a visitor is authenticated.
   *
   * **Omit it and the console is open.** That is a real decision, not a
   * default to drift into: this console can rewrite a catalog's model and run
   * its connectors. A host with any notion of users should pass this, and a
   * host that means to leave it open should say so where someone will read it.
   */
  auth?: DashboardAuthOptions;
}

/**
 * The catalog console, as a mountable module.
 *
 * Serves the SPA and the session endpoints; nothing else. The screens come from
 * `@dudousxd/nestjs-catalog-react` and the data from the catalog's own API, so
 * this package is the mount, the auth and the asset serving — the three things a
 * component library cannot do for itself.
 */
@Module({})
export class CatalogDashboardModule {
  static forRoot(options: CatalogDashboardOptions = {}): DynamicModule {
    const path = normalise(options.path ?? '/catalog');
    const apiPath = normalise(options.apiPath ?? '/api/catalog-service');

    const providers: Provider[] = [
      { provide: DASHBOARD_BASE_PATH, useValue: path },
      { provide: DASHBOARD_API_PATH, useValue: apiPath },
      { provide: DASHBOARD_AUTH, useValue: options.auth ?? null },
    ];

    return {
      module: CatalogDashboardModule,
      controllers: [CatalogUiController, CatalogAuthController],
      providers,
      exports: providers,
    };
  }
}

/**
 * The paths a host must exclude from its global API prefix.
 *
 * Without this, a host calling `setGlobalPrefix('api')` moves the console to
 * `/api/catalog` while the SPA still asks for `/catalog/assets/...`, and the
 * console loads as a blank page with 404s in the network tab — which reads as a
 * broken build rather than a routing mistake.
 *
 * Derived from the same defaulting `forRoot` uses, so the two cannot drift.
 */
export function catalogDashboardMountPaths(
  options: Pick<CatalogDashboardOptions, 'path'> = {},
): Array<{ path: string; method: number }> {
  const base = normalise(options.path ?? '/catalog').replace(/^\//, '');
  // `RequestMethod.ALL` is 7; spelled out so this helper does not drag in a
  // Nest import for one enum a host already has.
  return [
    { path: base, method: 7 },
    { path: `${base}/{*path}`, method: 7 },
  ];
}

/** Leading slash, no trailing one — the shape every consumer below assumes. */
function normalise(path: string): string {
  const withLeading = path.startsWith('/') ? path : `/${path}`;
  return withLeading.length > 1 ? withLeading.replace(/\/+$/, '') : withLeading;
}
