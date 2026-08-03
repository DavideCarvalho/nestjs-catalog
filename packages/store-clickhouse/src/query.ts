import type { ClickHouseClient } from '@clickhouse/client';
import type {
  CatalogObjectTypeDef,
  CatalogQueryRelation,
  CatalogQueryRequest,
  CatalogQueryResult,
} from '@dudousxd/nestjs-catalog';
import { BadRequestException } from '@nestjs/common';
import { normaliseCell } from './column-types';
import {
  BATCH_COLUMN,
  CARRY_FORWARD_BATCH,
  LOADED_AT_COLUMN,
  PRINCIPAL_COLUMN,
  ROW_COLUMN,
  SNAPSHOT_COLUMN,
  ident,
  physicalColumn,
  shadowViewFor,
  tableFor,
  viewFor,
} from './identifiers';

/**
 * A string literal for a place no query parameter can reach.
 *
 * Views store their SELECT text, so the snapshot a view is pinned to has to be
 * baked into the DDL rather than bound — `{s:String}` in a view body would be
 * resolved once at creation and is not even accepted there. Snapshot ids are
 * caller-supplied and opaque by contract (a durable run id, typically), so they
 * cannot be rejected the way identifiers are; they are escaped instead, with
 * the two characters that can end a ClickHouse string literal, plus a flat
 * refusal of anything with a newline or control character in it. Nothing that
 * identifies a load legitimately contains one, and a snapshot id that can carry
 * a line break into stored DDL is a foothold rather than a value.
 */
export function quoteString(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: detecting control characters is this guard's whole purpose
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new BadRequestException(
      `Refusing to use ${JSON.stringify(value)} as a snapshot id: it contains a control character, and this value is written into stored SQL.`,
    );
  }
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * Point a type's view at the snapshot readers should get, atomically.
 *
 * **`CREATE OR REPLACE VIEW` is not atomic on ClickHouse.** That is measured,
 * not assumed: 400 concurrent `SELECT`s against a view being replaced 400 times
 * produced 18 `UNKNOWN_TABLE` failures on 24.8, because the replace drops the
 * name and recreates it and there is a window in between. The same test against
 * `EXCHANGE TABLES`, which an Atomic database engine performs as one metadata
 * commit, produced none. So the new definition is built under a name nobody
 * reads and then exchanged into place, and the commit is the exchange.
 *
 * The exception is a type's first commit, where the name does not exist yet.
 * There is nothing to exchange with and nothing that could be mid-read, so the
 * shadow is simply renamed. Until then a type has no view at all, which is the
 * honest state: a name that resolves to an empty result is worse than one that
 * does not resolve, because the first looks like an answer.
 *
 * **One predicate over one table, and it stays that way even for incremental
 * loads.** That is not an accident of the current feature set, it is the whole
 * reason incremental loads copy the previous snapshot's surviving rows forward
 * instead of storing a delta: a snapshot is always the complete state, so
 * "current" is a filter and "as of last Tuesday" is the same filter with a
 * different value. Had deltas been stored instead, this function would have to
 * emit a union back to the last full load, every reader that ever selects from
 * the physical table by hand would have to reproduce that union correctly, and
 * a snapshot in the middle of a broken chain would answer confidently and
 * wrongly.
 */
export async function refreshView(
  client: ClickHouseClient,
  type: CatalogObjectTypeDef,
  snapshotId: string,
): Promise<void> {
  const view = viewFor(type.name);
  const shadow = shadowViewFor(type.name);
  const columns = type.properties.map(
    (p) => `${ident(physicalColumn(p.name))} AS ${ident(p.name)}`,
  );
  // The snapshot id rides along so a query can tell which load it is reading
  // without joining back to the snapshot table.
  columns.push(`${ident(SNAPSHOT_COLUMN)} AS ${ident('_snapshot')}`);

  await client.command({
    query: `CREATE OR REPLACE VIEW ${ident(shadow)} AS
              SELECT ${columns.join(', ')}
                FROM ${ident(tableFor(type.name))}
               WHERE ${ident(SNAPSHOT_COLUMN)} = ${quoteString(snapshotId)}`,
  });

  const exists = await client.query({
    query: `SELECT count() AS n FROM system.tables
             WHERE database = currentDatabase() AND name = {v:String}`,
    query_params: { v: view },
    format: 'JSONEachRow',
  });
  const [row] = await exists.json<{ n: string | number }>();

  if (Number(row?.n ?? 0) === 0) {
    await client.command({
      query: `RENAME TABLE ${ident(shadow)} TO ${ident(view)}`,
    });
    return;
  }

  // The one atomic cutover ClickHouse offers. Afterwards the shadow holds the
  // previously-served definition, which is harmless — nobody selects from it —
  // and is overwritten by the next commit.
  await client.command({
    query: `EXCHANGE TABLES ${ident(view)} AND ${ident(shadow)}`,
  });
}

export async function dropView(client: ClickHouseClient, typeName: string): Promise<void> {
  await client.command({
    query: `DROP VIEW IF EXISTS ${ident(viewFor(typeName))}`,
  });
  await client.command({
    query: `DROP VIEW IF EXISTS ${ident(shadowViewFor(typeName))}`,
  });
}

/**
 * What a query may select from.
 *
 * Two relations per type, and the distinction is the whole point of the screen:
 * the view is the committed snapshot, the physical table is every load that has
 * ever run.
 */
export function relationsFor(types: CatalogObjectTypeDef[]): CatalogQueryRelation[] {
  const relations: CatalogQueryRelation[] = [];
  for (const type of types) {
    const columns = type.properties.map((p) => ({
      name: p.name,
      type: p.type,
    }));
    relations.push({
      name: viewFor(type.name),
      kind: 'current',
      objectType: type.name,
      description: `${type.displayName} as of the committed snapshot.`,
      columns: [...columns, { name: '_snapshot', type: 'string' }],
    });
    relations.push({
      name: tableFor(type.name),
      kind: 'history',
      objectType: type.name,
      // `_batch` is described rather than merely listed because it is the one
      // column here whose meaning is not guessable, and it answers a question
      // people do ask of an incremental load: which of these rows did this run
      // actually produce, and which are just still true from last time.
      description: `Every load of ${type.displayName} ever written, one partition per (_snapshot_id, _batch). Filter on _snapshot_id to pick one, or group by it to compare. Within a snapshot, _batch is which chunk of the load a row arrived in; _batch = ${CARRY_FORWARD_BATCH} marks rows carried forward unchanged from the previous snapshot by an incremental run.`,
      columns: [
        ...type.properties.map((p) => ({
          name: physicalColumn(p.name),
          type: p.type,
        })),
        { name: SNAPSHOT_COLUMN, type: 'string' },
        { name: PRINCIPAL_COLUMN, type: 'string' },
        { name: LOADED_AT_COLUMN, type: 'date' },
        { name: BATCH_COLUMN, type: 'number' },
        { name: ROW_COLUMN, type: 'number' },
      ],
    });
  }
  return relations;
}

interface QueryEnvelope {
  meta?: Array<{ name: string; type: string }>;
  data: Array<Record<string, unknown>>;
}

function isEnvelope(value: unknown): value is QueryEnvelope {
  return typeof value === 'object' && value !== null && Array.isArray(Reflect.get(value, 'data'));
}

/**
 * Run one statement and make sure it cannot write.
 *
 * `readonly = 1` is the guarantee, and it is a real one rather than a keyword
 * denylist: the server rejects INSERT, every DDL, `OPTIMIZE`, and `ALTER ...
 * DELETE` outright, and — the part that makes it hold — it refuses to let the
 * statement modify the `readonly` setting itself, so a `SETTINGS readonly = 0`
 * appended to the query is an error rather than an escape. Verified against a
 * live server rather than read off a docs page.
 *
 * `readonly = 1` also freezes every *other* setting for the request, so a
 * `SETTINGS max_execution_time = 0` appended to the statement is rejected too.
 * Under `readonly = 2` — the weaker mode, which allows setting changes — that
 * same clause is accepted and the query runs forever, which is why this uses 1.
 *
 * **One hole, and it is a resource hole rather than a safety one.** The
 * statement is wrapped in a subquery to impose the row cap, and a `SETTINGS`
 * clause written *inside* the user's statement therefore ends up inside that
 * subquery, where ClickHouse does apply it — measured: `SELECT * FROM (SELECT
 * ... SETTINGS max_execution_time = 99) AS q` reads back 99 under a request-level
 * 5. It cannot introduce a write, because there is no write syntax available in
 * a `FROM` position, and it cannot escape the row cap, because the `LIMIT` is
 * outside the subquery and belongs to us. What it can do is outlive its
 * timeout. Two things close that: the request is aborted from this side when
 * the deadline passes, and `cancel_http_readonly_queries_on_client_close` tells
 * the server to stop working when that abort drops the connection. A deployment
 * that wants the timeout to be unarguable should point `queryConnection` at a
 * ClickHouse user whose profile *constrains* `max_execution_time`, which no
 * statement can override at any nesting depth.
 */
export async function runReadOnlyQuery(
  client: ClickHouseClient,
  request: CatalogQueryRequest,
): Promise<CatalogQueryResult> {
  const maxRows = request.maxRows ?? 1_000;
  const timeoutMs = request.timeoutMs ?? 15_000;
  const started = Date.now();

  // Fetch one extra row: if it comes back, the cap cut the result short and the
  // UI can say so rather than quietly showing a prefix as if it were the whole.
  const wrapped = `SELECT * FROM (${request.sql.trim().replace(/;\s*$/, '')}) AS ${ident('q')} LIMIT ${maxRows + 1}`;

  // A grace period over the server's own deadline, so the ordinary case is
  // ClickHouse timing the query out and saying so — a message that names the
  // limit — rather than this timer firing first and producing an abort with no
  // explanation attached.
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), timeoutMs + 2_000);

  try {
    // `JSON` rather than `JSONEachRow` for the column list: a query returning
    // no rows still has columns, and a results grid that loses its headers when
    // the WHERE matched nothing looks broken in a way that sends people
    // rewriting a query that was fine.
    const result = await client.query({
      query: wrapped,
      format: 'JSON',
      abort_signal: controller.signal,
      clickhouse_settings: {
        // The other half of the abort: without this the server finishes a query
        // nobody is listening to any more, which is the expensive half.
        cancel_http_readonly_queries_on_client_close: 1,
        // Strings because that is the type the client declares for ClickHouse's
        // UInt64 settings — they go onto the URL as text, and a number here is
        // a compile error rather than a runtime surprise.
        readonly: '1',
        max_execution_time: Math.max(1, Math.ceil(timeoutMs / 1000)),
        // A backstop rather than the mechanism: the LIMIT above is what caps
        // the result. This catches the case where the wrapper is defeated by a
        // statement shape nobody anticipated.
        max_result_rows: String(maxRows + 1),
        result_overflow_mode: 'break',
      },
    });

    const envelope: unknown = await result.json();
    if (!isEnvelope(envelope)) {
      throw new BadRequestException(
        'ClickHouse returned a response this store could not read as a result set.',
      );
    }

    const truncated = envelope.data.length > maxRows;
    const page = truncated ? envelope.data.slice(0, maxRows) : envelope.data;
    const columns = envelope.meta
      ? envelope.meta.map((column) => column.name)
      : page.length > 0
        ? Object.keys(page[0])
        : [];

    return {
      columns,
      rows: page.map((row) => {
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row)) {
          out[key] = normaliseCell(value);
        }
        return out;
      }),
      rowCount: page.length,
      truncated,
      elapsedMs: Date.now() - started,
    };
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    // The database's message is the useful one here — "Unknown expression
    // identifier 'foo'" is exactly what the person typing needs, and wrapping
    // it in something friendlier would hide it.
    throw new BadRequestException(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(deadline);
  }
}
