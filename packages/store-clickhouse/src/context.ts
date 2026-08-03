import { createClient } from '@clickhouse/client';
import type { ClickHouseClient } from '@clickhouse/client';
import type { Provider } from '@nestjs/common';
import {
  CATALOG_CLICKHOUSE_OPTIONS,
  type CatalogClickHouseConnection,
  type CatalogClickHouseStoreOptions,
} from './options';

/** The client every write in this package goes through. */
export const CATALOG_CLICKHOUSE_CLIENT = Symbol('CATALOG_CLICKHOUSE_CLIENT');
/** The client the ad-hoc SQL console goes through. Never used for writes. */
export const CATALOG_CLICKHOUSE_QUERY_CLIENT = Symbol('CATALOG_CLICKHOUSE_QUERY_CLIENT');

function build(connection: CatalogClickHouseConnection): ClickHouseClient {
  return createClient({
    url: connection.url,
    username: connection.username,
    password: connection.password,
    database: connection.database,
    request_timeout: connection.requestTimeoutMs,
    max_open_connections: connection.maxOpenConnections,
    clickhouse_settings: {
      // Dates arrive as ISO strings from `coerce`, and `basic` — the default —
      // parses only `YYYY-MM-DD hh:mm:ss`. Without this every date column in
      // every load fails to parse, and the error names the value rather than
      // the setting, so it reads as bad data.
      date_time_input_format: 'best_effort',
      // A column added by a later schema evolution is absent from the JSON of
      // an older producer's row. Without this the insert is rejected for the
      // missing field; with it the column takes its default, which for a
      // `Nullable` column is NULL — which is the truth about a value nobody
      // sent.
      input_format_skip_unknown_fields: 1,
    },
  });
}

/**
 * Providers for the clients, resolved once for the module.
 *
 * The query client falls back to the write client when the host configured no
 * separate credential. That is not a silent downgrade of the read-only promise:
 * every console statement is sent with `readonly = 1` regardless, which the
 * server enforces per-request. A separate credential narrows the blast radius
 * of a bug *in this package*; it is not what makes the console safe.
 */
export function catalogClickHouseProviders(options: CatalogClickHouseStoreOptions): Provider[] {
  return [
    { provide: CATALOG_CLICKHOUSE_OPTIONS, useValue: options },
    {
      provide: CATALOG_CLICKHOUSE_CLIENT,
      useFactory: (): ClickHouseClient => {
        if (options.client) return options.client;
        if (!options.connection) {
          throw new Error(
            "CatalogClickHouseStoreModule.forRoot needs either `connection` or `client`. Refusing to fall back to http://localhost:8123, because a store that silently connects somewhere plausible is a store that loads a production dataset into a developer's laptop.",
          );
        }
        return build(options.connection);
      },
    },
    {
      provide: CATALOG_CLICKHOUSE_QUERY_CLIENT,
      inject: [CATALOG_CLICKHOUSE_CLIENT],
      useFactory: (writeClient: ClickHouseClient): ClickHouseClient =>
        options.queryConnection ? build(options.queryConnection) : writeClient,
    },
  ];
}
