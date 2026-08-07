/**
 * What one SQL engine does differently from another, and nothing else.
 *
 * This package shipped as `MySqlWarehouseStore`, `MySqlPipelineStore`,
 * `MySqlWorkspaceStore` and `MySqlCatalogTraceStore` — four names asserting a
 * dependency that only one of them actually had. Three of the four reach their
 * tables through MikroORM's entity API, which is dialect-agnostic already; the
 * only thing binding them to MySQL was a *type-only* import of `EntityManager`
 * from `@mikro-orm/mysql`, which is a re-export of `@mikro-orm/sql`'s
 * `SqlEntityManager` and is therefore the same class `@mikro-orm/postgresql`
 * re-exports. Repointing that import was the whole of their portability work.
 *
 * The warehouse store is the one that is genuinely dialect-bound, because it is
 * the one that writes SQL by hand — DDL for the `obj_*` tables, an anti-join for
 * the merge, a view for the query console. This file is the seam it reaches
 * those differences through, and it is deliberately a **value** rather than a
 * class hierarchy: a second store subclassing the first is two implementations
 * that diverge the moment one of them is edited, and this codebase has refused
 * that shape before.
 *
 * ## What is NOT in here, and why that is the finding
 *
 * The list is much shorter than it looks from a grep, because MikroORM 7 already
 * absorbs most of it. Measured against a real Postgres 16 rather than assumed:
 *
 * - **`?` placeholders are portable.** `connection.execute(sql, params)` formats
 *   them client-side, so `?` works on Postgres and `$1` does *not*. Every
 *   parameterised statement in this package is portable exactly as written.
 * - **`LIMIT ? OFFSET ?` is portable**, including the parameters.
 * - **`.onConflict('id').merge([...])` compiles correctly on both.** Verified by
 *   round-trip, not by reading the builder: on Postgres it emits
 *   `on conflict ("id") do update set "rows" = excluded."rows"`, and re-sending
 *   a staged batch replaces it rather than appending.
 * - **`START TRANSACTION READ ONLY` refuses writes on both.** An `INSERT` inside
 *   one comes back as `cannot execute INSERT in a read-only transaction`, which
 *   is the same guarantee `runReadOnlyQuery` documents for MySQL.
 * - **`INSERT ... SELECT` may name its own target on both.** The carry-forward's
 *   anti-join is legal as written.
 * - **`type: 'json'` on an entity maps to `jsonb` on Postgres by itself.** See
 *   {@link POSTGRES_DIALECT} for why that mapping is kept rather than overridden.
 */

import { assertSafeIdentifier } from '@dudousxd/nestjs-catalog';
import type { ScalarType } from '@dudousxd/nestjs-catalog';

/**
 * The engine-shaped half of the warehouse store.
 *
 * Every member is here because a statement this package issues is different
 * between the two engines *and produces wrong data rather than an error* if the
 * wrong one is used. A difference that fails loudly — `ENGINE=InnoDB` on
 * Postgres — is still here, but it is the cheap half; the expensive half is
 * {@link caseInsensitiveLike} and {@link foldsColumnCase}, which are the two
 * that silently return a different set of rows.
 */
export interface CatalogSqlDialect {
  /** How this dialect is named in logs, errors and test titles. */
  readonly name: 'mysql' | 'postgres';

  /**
   * Whether the engine treats two column names differing only in case as one
   * column.
   *
   * **MySQL does; Postgres, through a quoted identifier, does not.** This is the
   * difference with the largest blast radius in the file and it runs in the
   * direction people do not expect: a type carrying both `assetId` and `AssetID`
   * is *refused* on MySQL and *accepted* on Postgres, where they become two
   * columns. Verified — `CREATE TABLE "cf" ("assetId" INT, "AssetID" INT)`
   * succeeds and `information_schema` reports both.
   *
   * So a model that a Postgres deployment publishes happily can be refused by a
   * MySQL one, and that asymmetry is real and cannot be papered over: making
   * Postgres refuse it too would be this package inventing a restriction its
   * engine does not have, and making MySQL accept it would be this package
   * lying about a collision that will happen.
   *
   * It also decides how {@link CatalogSqlDialect.existingColumns} answers are
   * compared. Lower-casing both sides on Postgres would match `AssetId` against
   * an existing `assetid` and skip creating a column that is genuinely missing —
   * the load then fails on `column "AssetId" does not exist`, on a table that
   * looks fine.
   */
  readonly foldsColumnCase: boolean;

  /**
   * Quote an identifier already known to be safe. Throws rather than sanitising.
   *
   * The refusal is shared — `assertSafeIdentifier` in the core package, so a
   * publisher is told the rule once whichever adapter is mounted — and only the
   * quoting is the dialect's own.
   */
  ident(value: string): string;

  /**
   * The column type one of the catalog's coarse scalars lands in.
   *
   * Deliberately wide on both, for the reason the MySQL mapping already gave: a
   * warehouse is fed by publishers that widen a column one day without telling
   * anyone, and a load that fails on a value one character too long is a worse
   * outcome than a roomy column.
   */
  columnType(type: ScalarType): string;

  /**
   * Turn a JavaScript value into something the driver may bind for that column.
   *
   * The one real difference is `boolean`: MySQL's `TINYINT(1)` takes `1`/`0` and
   * Postgres's `BOOLEAN` refuses them outright — `column "active" is of type
   * boolean but expression is of type integer`. Everything else is shared and
   * lives in {@link coerceScalar}.
   */
  coerce(value: unknown, type: ScalarType): unknown;

  /**
   * The statements that create an object table, in the order they must run.
   *
   * A list rather than one string, because MySQL declares the secondary index
   * inside `CREATE TABLE` (`KEY ix_… (…)`) and Postgres has no such syntax —
   * `KEY` there parses as a column named `ix_…` of a type that does not exist.
   * Postgres therefore returns two statements, and the caller runs them in order.
   */
  createObjectTable(input: {
    table: string;
    /** `[column, type]`, already quoted by {@link ident}, in declaration order. */
    columns: Array<[quotedColumn: string, declaration: string]>;
    rowColumn: string;
    snapshotColumn: string;
    principalColumn: string;
    loadedAtColumn: string;
    batchColumn: string;
    index: string;
  }): string[];

  /** `ALTER TABLE … ADD COLUMN`. Identical on both, kept here so nothing guesses. */
  addColumn(table: string, column: string, declaration: string): string;

  /**
   * Add the `(_snapshot_id, _batch)` index to a table that already exists.
   *
   * MySQL spells it `ALTER TABLE … ADD INDEX`, Postgres `CREATE INDEX`. Postgres
   * takes `IF NOT EXISTS`, which matters because `CREATE INDEX` is otherwise not
   * idempotent — `relation "ix_snapshot_batch" already exists` — and this runs
   * once per table per process across however many pods a deployment has.
   */
  addIndex(table: string, index: string, columns: readonly string[]): string;

  /** The catalogue read that says which columns a table already has. */
  existingColumnsQuery(): string;

  /** The catalogue read that says which indexes a table already has. */
  existingIndexesQuery(): string;

  /**
   * `COUNT(*)` and "how many of those were carried", in one statement.
   *
   * MySQL sums a boolean — `SUM(_batch = ?)` — which Postgres refuses outright
   * (`function sum(boolean) does not exist`). Postgres has the standard form,
   * `COUNT(*) FILTER (WHERE _batch = ?)`, which MySQL does not. Both bind one
   * parameter, in the same position, so the caller's parameter list is unchanged.
   */
  countCarried(quotedBatchColumn: string): string;

  /**
   * The operator a substring search uses.
   *
   * **`LIKE` on MySQL and `ILIKE` on Postgres, and that is a behaviour repair
   * rather than a translation.** MySQL's default collation
   * (`utf8mb4_0900_ai_ci`) is case-*insensitive*, so `LIKE '%a%'` there matches
   * `A`. Postgres's `LIKE` is case-sensitive and returns nothing for the same
   * row — verified, `LIKE '%A%'` against a row holding `a` comes back empty and
   * `ILIKE '%A%'` finds it.
   *
   * Left as `LIKE`, a Postgres deployment's search box and its `contains` filter
   * would quietly return fewer rows than the same catalog on MySQL, with no
   * error anywhere. That is the class of difference this whole seam exists for,
   * and it is the one my own grep of the file did not turn up.
   */
  readonly likeOperator: 'LIKE' | 'ILIKE';

  /**
   * How the committed view is repointed at a snapshot.
   *
   * The two engines need genuinely different statements and the difference is
   * not cosmetic. `CREATE OR REPLACE VIEW` on Postgres **may only append columns
   * at the end** — verified: replacing a view so that a new column lands before
   * an existing one fails with `cannot change name of view column "_snapshot" to
   * "score"`. Since {@link refreshView} puts `_snapshot` last and the type's
   * properties before it, *every* type that gains a property hits exactly that
   * refusal, on the commit rather than on the publish.
   *
   * So Postgres drops and recreates — inside a transaction, which is why the
   * `atomicCutover: true` capability survives rather than being downgraded.
   * Postgres DDL is transactional, so a concurrent `SELECT` waits on the lock and
   * then reads one definition or the other; the name is never undefined. That is
   * the same guarantee MySQL gets from `CREATE OR REPLACE VIEW` taking an
   * exclusive metadata lock, obtained a different way, and it is strictly
   * stronger than the ClickHouse adapter could claim without `EXCHANGE TABLES`.
   */
  refreshViewStatements(input: {
    view: string;
    select: string;
    table: string;
    snapshotColumn: string;
    quotedSnapshotValue: string;
  }): string[];

  /** `CREATE TABLE` for the applied-schema marker. */
  markerTableCreate(table: string): string;

  /** The marker upsert: `ON DUPLICATE KEY UPDATE` against `ON CONFLICT … DO UPDATE`. */
  markerUpsert(table: string): string;

  /**
   * How a read-only statement is given a deadline.
   *
   * MySQL rides an optimizer hint on the wrapping `SELECT`, deliberately rather
   * than `SET SESSION MAX_EXECUTION_TIME`, because a session variable poisons the
   * pooled connection for whoever borrows it next — measured, and documented at
   * length in `query.ts`.
   *
   * Postgres has no such hint. `/*+ MAX_EXECUTION_TIME(1000) *&#47;` there is an
   * ordinary comment: it parses, it runs, and it enforces nothing, which is the
   * worst of the available failures because the timeout looks configured. What
   * Postgres has instead is `SET LOCAL statement_timeout`, and `LOCAL` is the
   * whole reason it is safe here — it is scoped to the enclosing transaction, and
   * both read paths are already inside one. Verified on both counts: a runaway
   * cross join is cancelled (`canceling statement due to statement timeout`), and
   * after the rollback a fresh `SHOW statement_timeout` reads back `0`. So the
   * hint's no-residue property is preserved rather than traded away.
   *
   * Returns the statement to issue before the query, or nothing when the budget
   * rides on the query itself.
   */
  statementTimeout(budgetMs: number): { preamble?: string; hint: string };
}

/** Values that are the same on every SQL engine this package speaks. */
export function coerceScalar(value: unknown, type: ScalarType): unknown {
  if (value === undefined || value === null || value === '') return null;
  if (type === 'date') {
    const parsed = new Date(String(value));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (type === 'number') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (type === 'json') return JSON.stringify(value);
  return String(value);
}

/**
 * MySQL, exactly as this package has always emitted it.
 *
 * Every string below is moved rather than rewritten. Nothing about the MySQL
 * behaviour changes in this release, which is the condition the whole extraction
 * was done under: its suite passes untouched.
 */
export const MYSQL_DIALECT: CatalogSqlDialect = {
  name: 'mysql',
  foldsColumnCase: true,
  likeOperator: 'LIKE',

  ident(value: string): string {
    assertSafeIdentifier(value);
    return `\`${value}\``;
  },

  columnType(type: ScalarType): string {
    switch (type) {
      case 'number':
        return 'DOUBLE';
      case 'boolean':
        return 'TINYINT(1)';
      case 'date':
        return 'DATETIME';
      case 'uuid':
        return 'CHAR(36)';
      case 'json':
        return 'JSON';
      default:
        return 'TEXT';
    }
  },

  coerce(value: unknown, type: ScalarType): unknown {
    if (value === undefined || value === null || value === '') return null;
    if (type === 'boolean') return value ? 1 : 0;
    return coerceScalar(value, type);
  },

  createObjectTable(input): string[] {
    const { ident } = MYSQL_DIALECT;
    return [
      `CREATE TABLE IF NOT EXISTS ${ident(input.table)} (
           ${ident(input.rowColumn)} BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
           ${ident(input.snapshotColumn)} VARCHAR(128) NOT NULL,
           ${ident(input.principalColumn)} VARCHAR(128) NOT NULL,
           ${ident(input.loadedAtColumn)} DATETIME NOT NULL,
           ${ident(input.batchColumn)} INT NOT NULL DEFAULT 0,
           ${input.columns.map(([column, declaration]) => `${column} ${declaration}`).join(',\n           ')},
           KEY ${ident(input.index)} (${ident(input.snapshotColumn)}, ${ident(input.batchColumn)})
         ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    ];
  },

  addColumn(table, column, declaration): string {
    const { ident } = MYSQL_DIALECT;
    return `ALTER TABLE ${ident(table)} ADD COLUMN ${ident(column)} ${declaration}`;
  },

  addIndex(table, index, columns): string {
    const { ident } = MYSQL_DIALECT;
    return `ALTER TABLE ${ident(table)} ADD INDEX ${ident(index)} (${columns.map(ident).join(', ')})`;
  },

  existingColumnsQuery(): string {
    return `SELECT COLUMN_NAME AS column_name FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`;
  },

  existingIndexesQuery(): string {
    return `SELECT DISTINCT INDEX_NAME AS index_name FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`;
  },

  countCarried(quotedBatchColumn: string): string {
    return `SUM(${quotedBatchColumn} = ?)`;
  },

  refreshViewStatements(input): string[] {
    const { ident } = MYSQL_DIALECT;
    return [
      `CREATE OR REPLACE VIEW ${ident(input.view)} AS SELECT ${input.select}
       FROM ${ident(input.table)} WHERE ${ident(input.snapshotColumn)} = ${input.quotedSnapshotValue}`,
    ];
  },

  markerTableCreate(table: string): string {
    const { ident } = MYSQL_DIALECT;
    return `CREATE TABLE IF NOT EXISTS ${ident(table)} (
       ${ident('id')} VARCHAR(32) NOT NULL PRIMARY KEY,
       ${ident('fingerprint')} VARCHAR(64) NOT NULL,
       ${ident('applied_at')} DATETIME NOT NULL
     )`;
  },

  markerUpsert(table: string): string {
    const { ident } = MYSQL_DIALECT;
    return `INSERT INTO ${ident(table)} (id, fingerprint, applied_at)
     VALUES ('catalog', ?, NOW())
     ON DUPLICATE KEY UPDATE fingerprint = VALUES(fingerprint), applied_at = VALUES(applied_at)`;
  },

  statementTimeout(budgetMs: number): { preamble?: string; hint: string } {
    return { hint: `/*+ MAX_EXECUTION_TIME(${budgetMs}) */ ` };
  },
};

/**
 * PostgreSQL.
 *
 * ## JSON versus JSONB
 *
 * **`jsonb`, and it is the entity layer's own default rather than a choice made
 * here** — MikroORM's Postgres platform maps `@Property({ type: 'json' })` to
 * `jsonb` unprompted, verified against a generated schema. So the decision on
 * the table was never "which do we pick" but "do we override 24 columns", and
 * three things say not to.
 *
 * **It is the answer that keeps the two dialects agreeing.** `catalog.stage-encoding.ts`
 * records that a MySQL `JSON` column does not store the text it was given — it
 * stores a normalised binary document whose object members are sorted by key
 * length then bytes, so `{zebra, a, Middle_Name, b}` reads back as
 * `{a, b, zebra, Middle_Name}`. Postgres's `jsonb` normalises identically;
 * Postgres's `json` is a validated *string* and preserves the input order
 * exactly. Verified side by side: `jsonb` returns
 * `{"a":2,"b":4,"zebra":1,"Middle_Name":3}` and `json` returns
 * `{"zebra":1,"a":2,"Middle_Name":3,"b":4}`. Choosing `json` would therefore make
 * the *Postgres* store the odd one out, and would hand a caller a fidelity
 * guarantee that a deployment loses the day it migrates to MySQL.
 *
 * The columnar encoding does not rely on either behaviour, and that is why the
 * choice is free: it carries key names in a JSON **array**, and arrays keep their
 * order in `jsonb` as well as in `json` — confirmed, `shapes[0]` reads back in
 * emission order under both.
 *
 * **The cost was measured rather than assumed**, because `catalog.stage-encoding.ts`
 * is explicit that the encoding's saving arrives through `INSERT` time being
 * linear in bytes and not through parse CPU — so `jsonb`'s parse-and-normalise
 * on write is exactly the term that could have eaten it. Postgres 16 in a local
 * container, 60 batches of 500 rows over the 22-column shape (8.16 MB of JSON
 * text), warm, alternating runs:
 *
 * | | `json` | `jsonb` |
 * | --- | --- | --- |
 * | first insert of every batch | 502 ms | 550 ms |
 * | re-sending every batch (a retry) | 480 ms | 547 ms |
 * | reading every batch back | 124 ms | 191 ms |
 * | stored, `pg_total_relation_size` | 2.56 MB | 2.70 MB |
 *
 * So `jsonb` costs roughly 10% of the write and 5% of the stored bytes on this
 * shape, against 8.16 MB of text compressed to 2.6 MB by TOAST either way. That
 * is a real cost and it is small, it is paid on a path the columnar encoding
 * already halved, and it buys agreement with MySQL on what a staged batch reads
 * back as. Read the numbers as an upper bound on the difference rather than as a
 * benchmark of either engine: one container, one machine, one shape.
 *
 * ## What an operator has to know that MySQL did not make them know
 *
 * Two things, both consequences of Postgres quoting identifiers rather than
 * folding them — see {@link CatalogSqlDialect.foldsColumnCase} and
 * {@link CatalogSqlDialect.likeOperator}.
 */
export const POSTGRES_DIALECT: CatalogSqlDialect = {
  name: 'postgres',
  // Quoted identifiers are case-sensitive here, and `ident` always quotes.
  foldsColumnCase: false,
  // Not a translation of MySQL's `LIKE` but a repair of it. See the interface.
  likeOperator: 'ILIKE',

  ident(value: string): string {
    assertSafeIdentifier(value);
    return `"${value}"`;
  },

  columnType(type: ScalarType): string {
    switch (type) {
      case 'number':
        return 'DOUBLE PRECISION';
      case 'boolean':
        return 'BOOLEAN';
      // `TIMESTAMP` and deliberately not `TIMESTAMPTZ`, which is the tempting
      // answer and the wrong one for this column. MySQL's `DATETIME` stores a
      // wall clock and no zone, and the store's raw reads hand the text straight
      // out — so a `date` property round-trips as `2026-01-02 03:04:05` there.
      // `TIMESTAMPTZ` reads back as `2026-01-02 03:04:05+00`, a different string
      // for the same instant, and the shared contract pins the rendering across
      // adapters precisely so that "two adapters behind one interface returning
      // two date formats" cannot happen. Zoneless matches zoneless.
      case 'date':
        return 'TIMESTAMP(3)';
      // `CHAR(36)` rather than Postgres's native `UUID`, matching MySQL. The
      // native type would refuse any value that is not a UUID, and this column
      // is fed by publishers over HTTP — a load failing on one malformed id is
      // the outcome the "deliberately wide types" rule exists to avoid.
      case 'uuid':
        return 'CHAR(36)';
      case 'json':
        return 'JSONB';
      default:
        return 'TEXT';
    }
  },

  coerce(value: unknown, type: ScalarType): unknown {
    if (value === undefined || value === null || value === '') return null;
    // The one real difference. `BOOLEAN` refuses an integer outright rather than
    // coercing it, so MySQL's `1`/`0` would fail the INSERT on every row.
    if (type === 'boolean') return Boolean(value);
    return coerceScalar(value, type);
  },

  createObjectTable(input): string[] {
    const { ident } = POSTGRES_DIALECT;
    return [
      `CREATE TABLE IF NOT EXISTS ${ident(input.table)} (
           ${ident(input.rowColumn)} BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
           ${ident(input.snapshotColumn)} VARCHAR(128) NOT NULL,
           ${ident(input.principalColumn)} VARCHAR(128) NOT NULL,
           ${ident(input.loadedAtColumn)} TIMESTAMP(3) NOT NULL,
           ${ident(input.batchColumn)} INT NOT NULL DEFAULT 0,
           ${input.columns.map(([column, declaration]) => `${column} ${declaration}`).join(',\n           ')}
         )`,
      // Separate, because Postgres has no in-`CREATE TABLE` index syntax at all:
      // `KEY ix_a ("a")` parses as a column named `ix_a` and fails with
      // `type "ix_a" does not exist`, which is a confusing way to be told that.
      POSTGRES_DIALECT.addIndex(input.table, input.index, [
        input.snapshotColumn,
        input.batchColumn,
      ]),
    ];
  },

  addColumn(table, column, declaration): string {
    const { ident } = POSTGRES_DIALECT;
    return `ALTER TABLE ${ident(table)} ADD COLUMN ${ident(column)} ${declaration}`;
  },

  addIndex(table, index, columns): string {
    const { ident } = POSTGRES_DIALECT;
    return `CREATE INDEX IF NOT EXISTS ${ident(index)} ON ${ident(table)} (${columns.map(ident).join(', ')})`;
  },

  existingColumnsQuery(): string {
    // `current_schema()` rather than `DATABASE()`. The environment model puts
    // each environment in its own database (see `catalog.environment.ts`), so
    // this is asking about the one schema on the one connection that this
    // environment's tables live in — which on a default install is `public`.
    return `SELECT column_name FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = ?`;
  },

  existingIndexesQuery(): string {
    // `pg_indexes` rather than `information_schema.STATISTICS`, which Postgres
    // does not have — the SQL standard has no index catalogue and every engine
    // invents its own.
    return `SELECT indexname AS index_name FROM pg_indexes
         WHERE schemaname = current_schema() AND tablename = ?`;
  },

  countCarried(quotedBatchColumn: string): string {
    // The standard form. `SUM(x = ?)` is a MySQL-ism that Postgres refuses with
    // `function sum(boolean) does not exist`, which at least fails loudly.
    return `COUNT(*) FILTER (WHERE ${quotedBatchColumn} = ?)`;
  },

  refreshViewStatements(input): string[] {
    const { ident } = POSTGRES_DIALECT;
    const create = `CREATE VIEW ${ident(input.view)} AS SELECT ${input.select}
       FROM ${ident(input.table)} WHERE ${ident(input.snapshotColumn)} = ${input.quotedSnapshotValue}`;
    // Drop and recreate, wrapped so the pair is one atomic change — see the
    // interface for why `CREATE OR REPLACE VIEW` cannot be used and why this
    // still honours `atomicCutover: true`.
    return ['BEGIN', `DROP VIEW IF EXISTS ${ident(input.view)}`, create, 'COMMIT'];
  },

  markerTableCreate(table: string): string {
    const { ident } = POSTGRES_DIALECT;
    return `CREATE TABLE IF NOT EXISTS ${ident(table)} (
       ${ident('id')} VARCHAR(32) NOT NULL PRIMARY KEY,
       ${ident('fingerprint')} VARCHAR(64) NOT NULL,
       ${ident('applied_at')} TIMESTAMP(3) NOT NULL
     )`;
  },

  markerUpsert(table: string): string {
    const { ident } = POSTGRES_DIALECT;
    return `INSERT INTO ${ident(table)} (id, fingerprint, applied_at)
     VALUES ('catalog', ?, NOW())
     ON CONFLICT (id) DO UPDATE SET fingerprint = EXCLUDED.fingerprint, applied_at = EXCLUDED.applied_at`;
  },

  statementTimeout(budgetMs: number): { preamble?: string; hint: string } {
    // `LOCAL`, which is what makes this equivalent to MySQL's hint rather than
    // to the session variable that hint exists to avoid: it is unset when the
    // enclosing transaction ends, and both read paths already open one.
    return { preamble: `SET LOCAL statement_timeout = ${budgetMs}`, hint: '' };
  },
};

/** Every dialect this package speaks, by name. */
export const CATALOG_SQL_DIALECTS: Record<CatalogSqlDialect['name'], CatalogSqlDialect> = {
  mysql: MYSQL_DIALECT,
  postgres: POSTGRES_DIALECT,
};

/**
 * Which dialect an already-initialised ORM is talking.
 *
 * Asked of the ORM rather than configured beside it, because the ORM already
 * knows and a second declaration is a second thing that can disagree with the
 * connection — and the way it would disagree is by emitting MySQL quoting at a
 * Postgres server, which fails at boot with a syntax error rather than with a
 * sentence anybody can act on.
 *
 * Matched on the platform's class name rather than with `instanceof`, and that
 * is deliberate: `instanceof PostgreSqlPlatform` would mean importing
 * `@mikro-orm/postgresql` as a *value* from a package that must not depend on
 * either driver — the same reason `context.ts` reproduces
 * `@mikro-orm/nestjs`'s token names rather than importing them. Every Postgres
 * platform in MikroORM 7 descends from `BasePostgreSqlPlatform` and every one of
 * them is named `…PostgreSqlPlatform`, which the prototype walk below covers.
 *
 * **Unrecognised platforms fall back to MySQL rather than throwing**, which is
 * the one place in this file where a default is chosen over a refusal. The
 * reason is that this package has shipped MySQL-only, so anything this function
 * cannot name today is something that was already being served MySQL DDL, and
 * turning that into a boot failure would break a working deployment to tell it
 * something it does not need to know. A host that wants certainty passes the
 * dialect explicitly.
 */
export function dialectForPlatform(orm: {
  em: { getPlatform(): object };
}): CatalogSqlDialect {
  let current: object | null = orm.em.getPlatform();
  while (current) {
    const name = current.constructor?.name ?? '';
    if (name.includes('PostgreSql') || name.includes('Postgres')) return POSTGRES_DIALECT;
    if (name.includes('MySql') || name.includes('MariaDb')) return MYSQL_DIALECT;
    current = Object.getPrototypeOf(current);
  }
  return MYSQL_DIALECT;
}
