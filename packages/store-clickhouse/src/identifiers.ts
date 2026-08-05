import { assertSafeIdentifier } from '@dudousxd/nestjs-catalog';

/**
 * Every table and column name in this service comes from another application
 * over HTTP, and all of it ends up in DDL and in SELECT lists where no
 * placeholder can stand in for it. So identifiers are not escaped, they are
 * *rejected*: anything outside a narrow character set never becomes SQL.
 *
 * ClickHouse quotes identifiers with backticks, same as MySQL, and the same
 * argument applies with more force: this store issues `ALTER TABLE ... DROP
 * PARTITION` and `EXCHANGE TABLES`, statements whose blast radius is a whole
 * partition or a whole name, so a name that got through by being cleverly
 * escaped rather than by being plainly safe is not a risk worth carrying.
 *
 * Which character set, and how long, is not decided here. It is
 * `assertSafeIdentifier` in the core package, next to
 * `CATALOG_RESERVED_COLUMNS`, and taken from there for the same reason that
 * list is: a publisher is told the rule once, in one sentence, whichever
 * adapter is mounted. This file used to state it, and so did the MySQL adapter,
 * in identical words that nothing kept identical — and the publish-time refusal
 * that the pipeline package raises before a load starts was reading the MySQL
 * copy, so a deployment with only this store mounted was the one being asked to
 * trust that the two agreed.
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
 * Backticks are this adapter's own business — ClickHouse's quoting is not the
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
 * those cannot be columns here. The mapping is derived rather than stored, so
 * the same property name always resolves to the same column on every node and
 * after every restart.
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

/** Property name → physical column. Stable, so it never needs storing twice. */
export function physicalColumn(propertyName: string): string {
  return propertyName
    .replace(/[^A-Za-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 60);
}

/** Physical table for an object type — every load of it, ever. */
export function tableFor(typeName: string): string {
  return `obj_${toPhysicalName(typeName).toLowerCase()}`;
}

/**
 * The landing table a batch is built in before it is swapped into place.
 *
 * Its existence is the whole idempotence story of this adapter. ClickHouse has
 * no transactional delete — `ALTER TABLE ... DELETE` is a mutation, which is
 * asynchronous, rewrites parts, and gives no useful moment at which the old
 * rows are gone and the new ones are not yet there. What it does have is
 * `ALTER TABLE dst REPLACE PARTITION p FROM src`, which swaps one partition's
 * parts under a single metadata commit and hardlinks rather than copies when
 * both tables sit on the same disk. So a batch is built here and then replaces
 * its partition in the real table in one atomic, cheap step.
 *
 * It must be structurally identical to the object table — ClickHouse refuses
 * `REPLACE PARTITION` between tables with different columns — which is why
 * {@link module:schema} adds every column to both.
 */
export function stageFor(typeName: string): string {
  return `${tableFor(typeName)}__stage`;
}

/**
 * `Mvr` -> `mvr`. The view a query writes in its FROM clause.
 *
 * Views, rather than teaching the query layer to rewrite table names: a view is
 * a thing ClickHouse already understands, so joins, subqueries, CTEs and
 * aggregates all work without anyone writing a SQL parser. The alternative —
 * intercepting identifiers in a statement we did not parse — is how query
 * layers acquire their worst bugs.
 */
export function viewFor(typeName: string): string {
  return typeName
    .replace(/[^A-Za-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .toLowerCase();
}

/**
 * The half-built view a commit swaps into place.
 *
 * `CREATE OR REPLACE VIEW` is *not* atomic on ClickHouse — measured, not
 * assumed: hammering one view with 400 concurrent reads while replacing it 400
 * times produced 18 `UNKNOWN_TABLE` errors, because the replace drops the name
 * and recreates it. `EXCHANGE TABLES a AND b` on an Atomic database engine did
 * the same 400 swaps with zero misses. So the shadow view is built under a name
 * nobody reads, and the commit is the exchange.
 */
export function shadowViewFor(typeName: string): string {
  return `${viewFor(typeName)}__next`;
}

/** Reserved columns the warehouse adds to every object table. */
export const SNAPSHOT_COLUMN = '_snapshot_id';
export const PRINCIPAL_COLUMN = '_principal_id';
export const LOADED_AT_COLUMN = '_loaded_at';
/** Which batch of a load a row came from. Makes a re-sent batch replace itself. */
export const BATCH_COLUMN = '_batch';
/**
 * Position within the batch.
 *
 * ClickHouse has no auto-increment, and paging without a total order is paging
 * that silently repeats and skips rows between pages. `(_batch, _row)` is that
 * order, and it doubles as the table's sorting key so the ordering costs
 * nothing at read time.
 */
export const ROW_COLUMN = '_row';
export const RESERVED_COLUMNS = [
  SNAPSHOT_COLUMN,
  PRINCIPAL_COLUMN,
  LOADED_AT_COLUMN,
  BATCH_COLUMN,
  ROW_COLUMN,
];

/**
 * The batch number carried rows are written under.
 *
 * Negative on purpose. `write()` defaults an unnumbered batch to 0 and callers
 * count up from there, so anything at or above zero can legitimately arrive
 * from outside; a negative number is one no caller produces, which keeps the
 * store's own rows separable from the load's by a predicate rather than by
 * convention. Everything below relies on that: telling carried rows from
 * written ones is what makes the merge, the recount and the retry work. Here it
 * does one more job — it makes the carried rows their own *partition*, so a
 * re-run of the merge replaces them wholesale instead of deleting them.
 */
export const CARRY_FORWARD_BATCH = -1;
