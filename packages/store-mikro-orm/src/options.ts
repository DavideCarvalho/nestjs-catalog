import type { Provider } from '@nestjs/common';
import type { CatalogSqlDialect } from './dialect';

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
   * Seal credential-bearing config values through a vault before they are
   * written, so `catalog_connection.config` holds ciphertext rather than a
   * password. Default false.
   *
   * The redaction above stops a password travelling in an HTTP response. It
   * does nothing for a database dump, a read replica, a backup, or anybody
   * holding `SELECT` on the instance — and for those, this column is a list of
   * every password the catalog knows. This is the flag for that reader.
   *
   * Requires `CATALOG_SECRET_VAULT` to be bound to a {@link
   * CatalogSecretVault}. Bound to nothing, the default vault refuses every seal
   * with a message naming the token, so a save fails rather than a save
   * succeeding in plaintext.
   *
   * ## How it composes with `allowInlineCredentials`
   *
   * Three meanings, four combinations, and no fourth meaning — because sealing
   * happens **before** the refusal is asked, so a sealed value is not a
   * plaintext credential by the time anything looks:
   *
   * | `allowInlineCredentials` | `encryptCredentials` | What a credential in `config` does |
   * | --- | --- | --- |
   * | `false` *(default)* | `false` *(default)* | **Refused.** Unchanged: the save is turned away naming `secretEnvVar`. |
   * | `false` | `true` | **Sealed.** The refusal never fires — it inspects the config after sealing, and finds a ciphertext object rather than a password-bearing string. |
   * | `true` | `true` | **Sealed.** Identical to the row above. `allowInlineCredentials` is not contradicted here, it is simply already satisfied. |
   * | `true` | `false` | **Plaintext.** The deliberate dev-environment trade `allowInlineCredentials` documents. |
   *
   * The combination worth naming is the second: `false, true` is the one a
   * production deployment wants, and reading the two flags separately makes it
   * look like a contradiction — "refuse inline credentials" and "encrypt inline
   * credentials". It is not. `allowInlineCredentials` asks whether a *password*
   * may rest in this column, and with sealing on, none does.
   *
   * ## Turning it back off does not strand anything
   *
   * The flag gates writes only. Reads open a sealed value whatever it says, so
   * a host that turns encryption off keeps every existing row readable and
   * simply stops sealing new ones. The opposite — a flag that also gated
   * decryption — would make this switch a data-loss button.
   *
   * ## Rows already holding plaintext
   *
   * Sealed on their next save, and not before. There is no read-through-reseal:
   * a read that writes is a read that can fail a connector run for a
   * bookkeeping reason, and `getConnector` is on the runner's hot path and the
   * durable step's preflight. There is no one-shot migration in this release
   * either; the column takes both forms indefinitely, and what this change
   * guarantees is that a migration written later needs no schema change and can
   * tell the two apart with `isSealedSecret`.
   */
  encryptCredentials?: boolean;
  /**
   * The vault `encryptCredentials` seals through, as a provider for
   * `CATALOG_SECRET_VAULT`.
   *
   * It has to arrive this way rather than from the host's own module: the store
   * is constructed inside `CatalogMikroOrmStoreModule`'s injector, which cannot
   * see providers the host declared elsewhere, so a token bound outside would
   * resolve to `undefined` and the refusing default would fire on a host that
   * had bound a real vault. This is the same shape
   * `CatalogPipelineModule.forRoot({ expectations })` uses, for the same
   * reason.
   *
   * ```ts
   * CatalogMikroOrmStoreModule.forRoot({
   *   encryptCredentials: true,
   *   secretVault: { provide: CATALOG_SECRET_VAULT, useValue: new KmsSecretVault(...) },
   * })
   * ```
   *
   * `useValue` may be a single {@link CatalogSecretVault} or an array of them.
   * An array is what makes a key rotation possible without an outage — the
   * first seals, and any of them may open, matched on the `vault` name each row
   * carries. The token's own docblock spells the transition out.
   *
   * Omitting it while `encryptCredentials` is on is not a silent fallback: the
   * first save that has a credential to seal fails, naming this token.
   */
  secretVault?: Provider;
  /**
   * How long this process may serve its in-memory model before asking the
   * database whether somebody else has changed it. Milliseconds, default 1000.
   * **`0` turns the check off entirely.**
   *
   * The problem it exists for is a deployment with more than one replica.
   * `StoredCatalogRegistry` loads the model once at boot and rebuilds it when
   * something in *its own process* writes — so `PUT publish/:type/schema`
   * answers 200 from the pod that handled it, and a connector run routed to a
   * sibling pod moments later is told the type has not been published. It
   * self-heals only when that pod happens to serve a publish itself, or
   * restarts. Every host running two replicas has that window.
   *
   * So the registry re-reads a **watermark** — the row counts and newest
   * `updated_at` of `catalog_object_type` and `catalog_property` — and rebuilds
   * only when it has moved. This is how often it is allowed to ask.
   *
   * ## What it costs
   *
   * Nothing per call. `getSnapshot()` and `getType()` stay synchronous field
   * reads; what they gained is one integer comparison, and when it says the
   * window has elapsed they start the check **without waiting for it** — the
   * caller is served the snapshot it already had. So no request is ever slower
   * for this, however many arrive.
   *
   * What it costs the database is at most one statement per window per process,
   * regardless of traffic: two counts and two maxima over the model tables,
   * which hold a few hundred types and their columns. Neither aggregate is
   * indexed, so both are scans of small tables — see `readWatermark` for why an
   * index is not declared and what to add by hand if a deployment's model ever
   * gets big enough to want one.
   *
   * ## Choosing a value
   *
   * The default is the width of the window the bug lives in, so keep it small.
   * Raising it trades convergence time for query rate linearly; there is no
   * cliff in either direction.
   *
   * `0` is for a deployment that genuinely runs one process and wants its
   * behaviour and its query count exactly as they were before this existed.
   * It is not the default, because the failure it re-enables is invisible: a
   * stale replica answers 200s and 404s that look like the truth.
   */
  staleAfterMs?: number;
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
  /**
   * Which SQL engine this store's warehouse writes for. Default `'mysql'`.
   *
   * Only the *warehouse* store reads this, because only the warehouse store
   * writes SQL by hand — the pipeline, workspace and trace stores go through
   * MikroORM's entity API and are portable already. See `dialect.ts` for what
   * genuinely differs between the two and, more usefully, for the longer list of
   * things that turned out not to.
   *
   * ## What a Postgres deployment has to know that a MySQL one does not
   *
   * Two behavioural differences survive the seam, because closing either would
   * mean this package lying about its engine:
   *
   * - **Column names are case-sensitive.** Postgres identifiers are quoted here,
   *   so `assetId` and `AssetID` are two columns; MySQL folds them into one and
   *   refuses the type. A model published happily against Postgres can therefore
   *   be *refused* by MySQL, which is the direction people do not expect. It
   *   matters at migration time and nowhere else.
   * - **Search stays case-insensitive**, and that one is a repair rather than a
   *   difference: the dialect uses `ILIKE` so a Postgres catalog's search box
   *   returns the same rows a MySQL one does.
   *
   * The environment model is unchanged: **one database per environment**, not
   * one schema. Postgres could do the latter and deliberately does not — see
   * `catalog.environment.ts` for the argument, which turns on isolation staying
   * physical rather than becoming session state on a pooled connection.
   */
  dialect?: CatalogSqlDialect['name'];
  /**
   * The `EntityManager` class `@mikro-orm/nestjs` registered for the *default*
   * connection, when it is not `@mikro-orm/mysql`'s.
   *
   * Needed only by a Postgres host that sets no `contextName`:
   * `@mikro-orm/postgresql` exports its own `EntityManager` subclass, so the
   * token this package aliases by default is a different class and Nest cannot
   * resolve it. Passing a `contextName` avoids the question entirely and is the
   * better answer for a host that has a database of its own. See
   * `catalogConnectionProviders`.
   */
  entityManagerToken?: unknown;
  /** The matching `MikroORM` class, for the same reason. */
  mikroOrmToken?: unknown;
}
