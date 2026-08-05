import { CATALOG_RESERVED_COLUMNS, assertSafeIdentifier } from '@dudousxd/nestjs-catalog';

/**
 * Every table and column name in this service comes from another application
 * over HTTP, and all of it ends up in DDL and in SELECT lists where no
 * placeholder can stand in for it. So identifiers are not escaped, they are
 * *rejected*: anything outside a narrow character set never becomes SQL.
 *
 * Which character set, and how long, is not decided here. It is
 * `assertSafeIdentifier` in the core package, next to
 * `CATALOG_RESERVED_COLUMNS`, and taken from there for the same reason that
 * list is: a publisher is told the rule once, in one sentence, whichever
 * adapter is mounted. This file used to state it, and so did the ClickHouse
 * adapter, in identical words that nothing kept identical.
 */

/**
 * The refusal, re-exported rather than declared.
 *
 * A store's caller catches this to tell a name it may fix from a fault it
 * cannot, so it has to be the same class the other adapters throw — an
 * `instanceof` against a per-adapter copy is a check that quietly stops
 * matching the moment somebody mounts a different store.
 */
export { UnsafeIdentifierError } from '@dudousxd/nestjs-catalog';

/**
 * Quote a value already known to be safe. Throws rather than sanitising.
 *
 * Backticks are this adapter's own business — MySQL's quoting is not the
 * catalog's to know — but what may be quoted at all is the shared rule's.
 */
export function ident(value: string): string {
  assertSafeIdentifier(value);
  return `\`${value}\``;
}

/**
 * Turn a publisher's name into a column we can create.
 *
 * Publishers name things for their own schema — `Asset NSN`, `Sub/Un Sub` — and
 * those cannot be columns here. The mapping is stored on the property row, so
 * the original is never lost and reads translate back.
 */
export function toPhysicalName(value: string, prefix = 'c'): string {
  const cleaned = value
    .replace(/[^A-Za-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  if (!cleaned) return `${prefix}_unnamed`;
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `${prefix}_${cleaned}`;
}

/** Physical table for an object type. */
export function tableFor(typeName: string): string {
  return `obj_${toPhysicalName(typeName).toLowerCase()}`;
}

/** Reserved columns the warehouse adds to every object table. */
export const SNAPSHOT_COLUMN = '_snapshot_id';
export const PRINCIPAL_COLUMN = '_principal_id';
export const LOADED_AT_COLUMN = '_loaded_at';
/** Which batch of a load a row came from. Makes a re-sent batch replace itself. */
export const BATCH_COLUMN = '_batch';
/**
 * The auto-increment primary key, and the default read order.
 *
 * Named here rather than written as a literal in the four statements that use
 * it, because it is one of the reserved names and the list below is what a
 * publisher's property is checked against. A copy of it hidden inside a SQL
 * string is a copy the check cannot see, and `_row` was in fact missing from
 * that list until this constant existed.
 */
export const ROW_COLUMN = '_row';
/**
 * Taken from the core package rather than restated.
 *
 * These names are part of what the catalog promises a reader — the SQL console
 * lists them, ad-hoc queries filter on them — so they belong to the contract,
 * and a per-adapter copy is a copy that can quietly stop matching the one a
 * publisher was told about.
 */
export const RESERVED_COLUMNS: readonly string[] = CATALOG_RESERVED_COLUMNS;
