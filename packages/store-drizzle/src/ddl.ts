import { type AnyPgTable, getTableConfig } from 'drizzle-orm/pg-core';
import { type CatalogDrizzleTableOptions, catalogDrizzleTables } from './schema';

/**
 * The SQL that creates the catalog's tables, derived from the Drizzle
 * definitions so the two cannot disagree.
 *
 * For a host that keeps hand-written migrations rather than generating them:
 * copy the output into a migration of its own. Every statement is `IF NOT
 * EXISTS` and nothing here creates a role, an extension or a schema, changes an
 * owner, or grants anything, so it runs as whatever role owns the host's other
 * tables. Grants and row-security policies are the host's to write beside it.
 *
 * A host that uses drizzle-kit does not need this: export the tables from
 * {@link catalogDrizzleTables} in its schema file and generate as usual.
 */
export function catalogDrizzleSql(options: CatalogDrizzleTableOptions = {}): string {
  const tables = catalogDrizzleTables(options);
  return `${Object.values(tables)
    .flatMap((table) => tableStatements(table))
    .join('\n\n')}\n`;
}

function ident(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function tableStatements(table: AnyPgTable): string[] {
  const config = getTableConfig(table);
  const qualified = config.schema
    ? `${ident(config.schema)}.${ident(config.name)}`
    : ident(config.name);

  const columns = config.columns.map((column) => {
    const parts = [ident(column.name), column.getSQLType()];
    if (column.primary) parts.push('PRIMARY KEY');
    if (column.notNull && !column.primary) parts.push('NOT NULL');
    if (column.hasDefault && column.default !== undefined) {
      parts.push(`DEFAULT ${literal(column.default)}`);
    }
    return `  ${parts.join(' ')}`;
  });

  const statements = [`CREATE TABLE IF NOT EXISTS ${qualified} (\n${columns.join(',\n')}\n);`];
  for (const index of config.indexes) {
    const name = index.config.name;
    if (!name) throw new Error(`An index on ${config.name} has no name.`);
    const on = index.config.columns.map((column) => {
      const columnName = 'name' in column ? column.name : undefined;
      if (!columnName) throw new Error(`An index on ${config.name} is not on named columns.`);
      return ident(columnName);
    });
    statements.push(
      `CREATE INDEX IF NOT EXISTS ${ident(name)} ON ${qualified} (${on.join(', ')});`,
    );
  }
  return statements;
}

function literal(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`;
  throw new Error(`No SQL literal for a column default of type ${typeof value}.`);
}
