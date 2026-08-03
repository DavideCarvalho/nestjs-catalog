/**
 * Kept in its own file, not beside the module that consumes it.
 *
 * The registry needs this token and the module needs the registry, so declaring
 * the token in the module makes the two files import each other. Nest resolves
 * a circular import to `undefined` at injection time, and the error it reports
 * points at the argument position rather than at the cycle.
 */
export const CATALOG_STORE_OPTIONS = Symbol('CATALOG_STORE_OPTIONS');

export interface CatalogStoreModuleOptions {
  /**
   * Create and update this package's tables at boot. Default true.
   *
   * Set false when the host manages them through its own migrations — and feed
   * `catalogManagedTables()` to the differ so it never tries to drop them.
   */
  autoSchema?: boolean;
  /**
   * Record the diagnostics stream into the audit table. Default true.
   *
   * The channel reaches observers listening at the time; governance asks about
   * six weeks ago. Turn this off only when something else is keeping the
   * answer.
   */
  audit?: boolean;
  /**
   * The MikroORM context name this store reads and writes — the same string
   * passed to `MikroOrmModule.forRoot({ contextName })`. Omit for the default
   * connection, which is what a service that owns its process wants.
   *
   * Set it when the catalog is mounted *inside* an application that already has
   * a MikroORM connection of its own. Without it the injected EntityManager is
   * the host's, so this package would create its tables and load every snapshot
   * into the host's database — a failure with no error attached to it, because
   * writing to the wrong schema is not a type error and the rows land
   * successfully.
   */
  contextName?: string;
}
