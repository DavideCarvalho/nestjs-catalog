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
   * Allow a connection or connector to store a password inside `config`.
   * **Default false, and the default is the one to keep.**
   *
   * A connection URL IS the credential — `mysql://user:pass@host/db` — and
   * `config` is served by `GET pipeline/connections` under `catalog:read`. That
   * is how this column came to hold every SQL source's password in plaintext
   * while three separate docblocks promised it never would. The refusal is what
   * makes the promise true rather than aspirational, and the intended shape is
   * still `secretEnvVar`: the catalog stores the NAME of an environment
   * variable, the pod holds the value, and a leaked catalog database leaks the
   * shape of the integration rather than the keys to it.
   *
   * Turning this on is a deliberate trade for a deployment that would rather
   * type a connection string than provision an env var — a dev environment,
   * usually. **It does not undo the other half.** Reads are still redacted, so
   * the password does not travel in an HTTP response either way; what changes
   * is only whether it may rest in the catalog's own database.
   *
   * Which means the honest way to read this flag is: "who can read this
   * catalog's `catalog_connection` table by other means, and am I content for
   * them to have these passwords". In dev that is usually yes. In production it
   * is the question the refusal exists to make somebody answer.
   */
  allowInlineCredentials?: boolean;
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
