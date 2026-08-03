import type { TelescopeExtension } from '@dudousxd/nestjs-telescope';
import { catalogLiveProviders } from './catalog-live-providers.js';
import { catalogTraceProviders } from './catalog-trace-providers.js';
import { type CatalogDashboardOptions, catalogDashboard } from './catalog.dashboard.js';
import { CATALOG_ENTRY_TYPE } from './catalog.shared.js';
import { CatalogWatcher, type CatalogWatcherOptions } from './catalog.watcher.js';

/** Options for {@link catalogTelescopeExtension}. */
export interface CatalogTelescopeOptions extends CatalogWatcherOptions, CatalogDashboardOptions {}

/**
 * The Telescope extension for `@dudousxd/nestjs-catalog`: a "Catalog" tab fed
 * by two sources.
 *
 * **The durable trace store** (`CATALOG_TRACE_STORE`) is the authority. It is
 * the catalog's own audit trail, grouped into causal stories by the snapshot id
 * that already correlated them, and it survives a restart. Everything about
 * loads — outcomes, row counts, durations, failures, and the governance edits
 * that belong to no load — is read from there.
 *
 * **The `aviary:catalog:*` diagnostics channel**, via {@link CatalogWatcher},
 * feeds the live section and populates Telescope's own entry timeline and trace
 * waterfall. It is ephemeral: it lives for as long as the host's prune window,
 * and it exists to answer "is anything happening right now" and to make a
 * failure visible even in a deployment with no trace store bound.
 *
 * Nothing here imports the catalog runtime, and nothing in
 * `@dudousxd/nestjs-catalog` imports this. The catalog publishes on the neutral
 * diagnostics channel and exposes a store token; this package subscribes and
 * resolves. A deployment without Telescope carries none of this code and loses
 * nothing.
 *
 * ## Host wiring
 * The durable panels resolve `CATALOG_TRACE_STORE` out of the host DI container
 * at request time. Bind it — from `@dudousxd/nestjs-catalog-store-mikro-orm` or
 * another trace-capable store — in the same module that registers Telescope. If
 * it is not bound, those panels render empty and the live section keeps working.
 *
 * ```ts
 * TelescopeModule.forRoot({ extensions: [catalogTelescopeExtension()] });
 * ```
 *
 * ## Naming
 * The extension name, the entry-type id, the dashboard id and every provider
 * name share the `catalog` prefix. Telescope's extension registry enforces
 * global uniqueness across extensions on each of those namespaces, so the
 * shared prefix is what keeps this from colliding with a sibling.
 */
export function catalogTelescopeExtension(options?: CatalogTelescopeOptions): TelescopeExtension {
  return {
    name: CATALOG_ENTRY_TYPE,
    watchers: () => [new CatalogWatcher(options)],
    entryTypes: () => [
      {
        id: CATALOG_ENTRY_TYPE,
        label: 'Catalog',
        // Indigo. Chosen only to be distinct from the dots the sibling
        // extensions already claim — sky for diagnostics, amber for durable —
        // so a mixed timeline is readable at a glance.
        dot: 'bg-indigo-400',
      },
    ],
    dashboards: () => [catalogDashboard(options)],
    dataProviders: () => [...catalogTraceProviders(), ...catalogLiveProviders()],
  };
}

export default catalogTelescopeExtension;
