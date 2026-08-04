import {
  type DynamicModule,
  type FactoryProvider,
  Module,
  type Provider,
  type Type,
  UseGuards,
} from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import {
  DASHBOARD_AUTH,
  type DashboardAuthOptions,
  resolveDashboardAuth,
} from './auth/dashboard-auth-config.js';
import { CatalogAuthController } from './catalog-auth.controller.js';
import { CatalogUiSessionGuard } from './catalog-session.guard.js';
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
  /**
   * Guards fronting the console's own controllers.
   *
   * Separate from `auth`, and the reason is the failure it prevents: `auth`
   * describes how a session is validated, so a host that has not configured it
   * yet has an OPEN console. A host that would rather be shut than open passes a
   * denying guard here — it needs no secret, no DI and no session to work.
   *
   * Bound at module-definition time, so it cannot come from `forRootAsync`.
   */
  guards?: Type<unknown>[];
}

export interface CatalogDashboardAsyncOptions extends Omit<CatalogDashboardOptions, 'auth'> {
  imports?: DynamicModule['imports'];
  inject?: FactoryProvider['inject'];
  /**
   * Builds the auth from DI. See {@link CatalogDashboardModule.forRootAsync}.
   *
   * May return `undefined`, and that is the important case rather than an
   * afterthought: a host whose signing secret is unset has no way to mint a
   * session, and the honest answer is "no auth mechanism" — paired with a
   * denying `guards` entry, which is what turns that into a CLOSED console
   * instead of an open one. Forcing a return here would push hosts to invent an
   * auth object around an absent secret, i.e. a cookie signed with nothing.
   */
  useDashboardAuth: (
    ...args: never[]
  ) => DashboardAuthOptions | undefined | Promise<DashboardAuthOptions | undefined>;
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
    // Resolved, not passed through: `resolveDashboardAuth` derives `modes` from
    // which hooks are present, and every consumer reads that. Handing over the
    // raw options gives a value whose `modes` is undefined, and the endpoints
    // fail with `Cannot read properties of undefined (reading 'includes')` — a
    // 500 where a 401 belongs.
    return build(options, {
      provide: DASHBOARD_AUTH,
      useValue: options.auth ? resolveDashboardAuth(options.auth) : null,
    });
  }

  /**
   * Same mount, but the auth is built from DI.
   *
   * Needed whenever validating a session means asking something the host owns —
   * a user store, a session service. `forRoot` cannot express that: `guards` and
   * the router are bound at module-DEFINITION time, before any injector exists,
   * which is why `guards` stays a static option on both forms.
   */
  static forRootAsync(options: CatalogDashboardAsyncOptions): DynamicModule {
    const factory = options.useDashboardAuth;
    const mounted = build(options, {
      provide: DASHBOARD_AUTH,
      // Same resolution as `forRoot`, wrapped around the host's factory so the
      // async path cannot skip it.
      useFactory: async (...args: never[]) => {
        const auth = await factory(...args);
        return auth ? resolveDashboardAuth(auth) : null;
      },
      inject: options.inject ?? [],
    });
    // Appended, not replaced: `build` puts the RouterModule registration in
    // `imports`, and overwriting it would leave the console unrouted.
    return {
      ...mounted,
      imports: [...(mounted.imports ?? []), ...(options.imports ?? [])],
    };
  }
}

/** See the note where this is set: `UseGuards` appends, and these classes are shared. */
let sessionGuardStamped = false;

function build(
  options: CatalogDashboardOptions | CatalogDashboardAsyncOptions,
  auth: Provider,
): DynamicModule {
  const path = normalise(options.path ?? '/catalog');
  const apiPath = normalise(options.apiPath ?? '/api/catalog-service');

  // The session guard, on the SPA and its assets.
  //
  // This was missing, and its absence was not visible from anywhere: `auth`
  // configures how a session is minted and validated, the docblocks describe it
  // as the thing that closes an otherwise-open console, and nothing ever stamped
  // the guard that enforces it. A host that configured `auth` correctly still
  // served the console shell to anyone who could reach the URL.
  //
  // NOT on `CatalogAuthController`: that is where a session is obtained, and
  // gating it on already having one locks the door from the inside.
  //
  // The guard is a no-op when `auth` is absent, so this is safe on an
  // intentionally open mount — "open" then remains a decision the host made by
  // omitting `auth`, rather than one the module made by forgetting.
  //
  // Stamped once per process, not once per mount. `UseGuards` APPENDS to the
  // controller's metadata and these controller classes are module-level, so a
  // second `forRoot` in the same process would run the guard twice per request.
  if (!sessionGuardStamped) {
    UseGuards(CatalogUiSessionGuard)(CatalogUiController);
    sessionGuardStamped = true;
  }

  // Host guards on top, applied to both controllers so a host can shut the whole
  // console — including the way in — without touching the rest of its app.
  // `UseGuards` at definition time is why `guards` cannot come from DI.
  for (const guard of options.guards ?? []) {
    UseGuards(guard)(CatalogUiController);
    UseGuards(guard)(CatalogAuthController);
  }

  const providers: Provider[] = [
    { provide: DASHBOARD_BASE_PATH, useValue: path },
    { provide: DASHBOARD_API_PATH, useValue: apiPath },
    auth,
    // Constructed by Nest, so it must be declared here — a guard stamped by
    // `UseGuards` is still resolved from the declaring module's injector.
    CatalogUiSessionGuard,
  ];

  return {
    module: CatalogDashboardModule,
    // The controllers are `@Controller()` with no path of their own, and the
    // prefix arrives here instead. That is what lets `path` be configurable at
    // all: a decorator argument is fixed at class-definition time, so a
    // hardcoded one would pin every host to the same mount point.
    //
    // Without this the controllers inherit whatever the host's global prefix is
    // — they answered on `/api` — and the console 404s at its configured path
    // while the module reports itself initialised, which is a confusing pair of
    // symptoms to hold at once.
    imports: [RouterModule.register([{ path, module: CatalogDashboardModule }])],
    controllers: [CatalogUiController, CatalogAuthController],
    providers,
    exports: providers,
  };
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
): string[] {
  const base = normalise(options.path ?? '/catalog').replace(/^\//, '');
  // Plain strings with a `{*splat}` wildcard, which is the shape `setGlobalPrefix`'s
  // `exclude` matches and what every other Aviary console helper returns. An
  // object form is accepted by the type but does NOT match here, and the symptom
  // is subtle: the console mounts, logs itself as initialised, and answers on
  // `/api/<path>` while 404ing at `/<path>`.
  return [base, `${base}/{*splat}`];
}

/** Leading slash, no trailing one — the shape every consumer below assumes. */
function normalise(path: string): string {
  const withLeading = path.startsWith('/') ? path : `/${path}`;
  return withLeading.length > 1 ? withLeading.replace(/\/+$/, '') : withLeading;
}
