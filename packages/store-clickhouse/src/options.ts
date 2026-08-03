import type { ClickHouseClient } from '@clickhouse/client';

/**
 * Kept in its own file, not beside the module that consumes it.
 *
 * The providers need this token and the module needs the providers, so
 * declaring the token in the module makes the two files import each other. Nest
 * resolves a circular import to `undefined` at injection time, and the error it
 * reports points at the argument position rather than at the cycle.
 */
export const CATALOG_CLICKHOUSE_OPTIONS = Symbol('CATALOG_CLICKHOUSE_OPTIONS');

/** Enough of `createClient`'s config to point this store at a server. */
export interface CatalogClickHouseConnection {
  /** e.g. `http://localhost:8123`. */
  url: string;
  username?: string;
  password?: string;
  /** The database every table this store owns is created in. */
  database?: string;
  requestTimeoutMs?: number;
  maxOpenConnections?: number;
}

export interface CatalogClickHouseStoreOptions {
  /**
   * Where to write. Either a connection this module builds a client from, or a
   * client the host already made.
   *
   * A host that passes its own client keeps ownership of it: this module will
   * not close it on shutdown, because a client shared with the rest of the
   * application is not this module's to close.
   */
  connection?: CatalogClickHouseConnection;
  client?: ClickHouseClient;

  /**
   * A second connection for the ad-hoc SQL console, ideally authenticating as a
   * ClickHouse user with no INSERT or DDL grants at all.
   *
   * Every console query is already sent with `readonly = 1`, which the server
   * enforces and which a query cannot turn off — ClickHouse refuses to modify
   * the `readonly` setting while it is set. That is a real boundary, not a
   * keyword denylist. This option exists because "the server refuses writes
   * from this request" and "this credential cannot write at all" are different
   * strengths of the same promise, and the second one survives a mistake in
   * this package.
   */
  queryConnection?: CatalogClickHouseConnection;

  /**
   * Create this package's own tables at boot. Default true.
   *
   * There are exactly two of them and they hold snapshot bookkeeping, not data.
   * Set false when the host provisions them through its own change management —
   * {@link catalogClickHouseManagedTables} names them.
   */
  autoSchema?: boolean;

  /**
   * Refuse to write to an object table this store did not shape. Default true.
   *
   * The idempotence and time-travel guarantees here are not properties of
   * ClickHouse, they are properties of one specific physical layout: a plain
   * `MergeTree` partitioned by `(_snapshot_id, _batch)`. Pointed at a
   * `ReplacingMergeTree`, retries would appear to work while background merges
   * quietly collapsed old snapshots; pointed at a `Distributed` table,
   * `REPLACE PARTITION` would not mean what this code thinks it means. Both
   * failures are invisible until someone asks for last month's data and gets
   * this month's. So the layout is checked, and a mismatch is refused.
   */
  verifyEngine?: boolean;
}
