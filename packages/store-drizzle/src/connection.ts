import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

/**
 * Any Drizzle Postgres database or transaction handle.
 *
 * A `PgTransaction` is a `PgDatabase`, so a store method receives the same type
 * whether the host handed over its pool-backed database or opened a transaction
 * of its own and passed that in. Nothing here names a driver: `node-postgres`,
 * `postgres-js` and Neon all produce one of these.
 */
// biome-ignore lint/suspicious/noExplicitAny: the schema and relations generics belong to the host, not to this package.
export type CatalogDrizzleDatabase = PgDatabase<PgQueryResultHKT, any, any>;

/**
 * Runs one unit of catalog work and hands back its result.
 *
 * This is the seam for a host that must see every statement: one that sets
 * row-security settings at the start of each transaction, or that refuses any
 * query not opened through its own wrapper. Each store method makes exactly one
 * call, and every statement of that method runs on the handle the callback is
 * given, so a method is never split across two transactions the host did not
 * open.
 *
 * **Each call must get exactly one transaction of its own, or a savepoint.**
 * Open a transaction per call (`db.transaction(work)`), or, inside a
 * transaction the host already holds, a savepoint (`tx.transaction(work)`),
 * and commit or roll it back when `work` settles. Two store guarantees rest on
 * that:
 *
 * - **Atomicity.** A saved query and the revision it records are written by
 *   separate statements in one call. They commit together, or neither does,
 *   only if the call is one transaction or savepoint. Handing `work` a bare
 *   connection in autocommit mode commits each statement on its own.
 * - **The edit lock.** An edit reads the row `FOR UPDATE` so two concurrent edits
 *   of one query cannot both write the same next version. The lock is held until
 *   the transaction ends, so in autocommit mode it is released before the update
 *   runs and protects nothing.
 *
 * A `run` that hands every call the same open transaction, with no savepoint,
 * keeps both guarantees only until something rolls back: the rollback then takes
 * every earlier call's writes with it.
 */
export type CatalogDrizzleRun = <T>(work: (db: CatalogDrizzleDatabase) => Promise<T>) => Promise<T>;

/**
 * How a store reaches the database: a Drizzle database, or a function that runs
 * work in the host's own transaction. Exactly one of the two.
 */
export type CatalogDrizzleConnection =
  | { readonly db: CatalogDrizzleDatabase; readonly run?: never }
  | { readonly run: CatalogDrizzleRun; readonly db?: never };

/**
 * The runner a store calls, from either form of connection.
 *
 * Given a bare database, each unit of work is one transaction, so a save and
 * the revision it records commit together or not at all — the same guarantee
 * the MikroORM store gets from flushing one unit of work.
 */
export function catalogDrizzleRunner(connection: CatalogDrizzleConnection): CatalogDrizzleRun {
  if (typeof connection.run === 'function') return connection.run;
  const db = connection.db;
  if (!db) {
    throw new Error(
      '@dudousxd/nestjs-catalog-store-drizzle: pass either `db` (a Drizzle Postgres database) or `run` (a function that runs work in your transaction).',
    );
  }
  return (work) => db.transaction((tx) => work(tx));
}
