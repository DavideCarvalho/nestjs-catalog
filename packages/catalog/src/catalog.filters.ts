import type { CatalogPropertyDef, ScalarType } from './catalog.types';

/**
 * Filtering a catalogued type, derived from the type.
 *
 * **Nothing here lists a filterable column, and nothing anywhere else may.** The
 * types this catalog serves are created at runtime — `PUT publish/:type/schema`
 * writes the properties and the store builds the physical columns from them — so
 * a hand-maintained list of what is filterable is a list that goes quiet the day
 * somebody publishes a column nobody edited it for. That is the failure mode this
 * module exists to remove: the operators a column offers are a function of the
 * column, computed by {@link filterOperatorsFor}, and both the server (deciding
 * what it will accept) and the console (deciding what to draw) call that one
 * function. A screen offering a control the server would refuse, or refusing one
 * the server would take, is then not expressible.
 *
 * This is also why `@dudousxd/nestjs-filter` is not what is used here. That
 * library derives its filters from entities and routes known at compile time, and
 * these types do not exist at compile time.
 *
 * **The module is pure and imports nothing but types**, because it ships to the
 * browser through `@dudousxd/nestjs-catalog/client` — the same reason
 * `validateWorkflow` does. A second copy of the derivation living in the console
 * is exactly the drift that entry point exists to prevent.
 */

/**
 * Every operator, in the order a control should offer them.
 *
 * One list, so nothing narrows a stored or transmitted operator against a second
 * hand-maintained copy of these names — the same argument
 * `CATALOG_SNAPSHOT_MODES` makes one file over.
 *
 * There is no `between`. A range is `gte` and `lte` on one property, which is two
 * filters that compose with everything else rather than one operator that needs
 * its own wire form, its own second value and its own "what if the ends are the
 * wrong way round" answer.
 */
export const CATALOG_FILTER_OPERATORS = [
  'eq',
  'ne',
  'contains',
  'gte',
  'lte',
  'gt',
  'lt',
  'empty',
  'notEmpty',
] as const;

export type CatalogFilterOperator = (typeof CATALOG_FILTER_OPERATORS)[number];

export function isCatalogFilterOperator(value: string): value is CatalogFilterOperator {
  return CATALOG_FILTER_OPERATORS.some((operator) => operator === value);
}

/**
 * The operators that take no value.
 *
 * "Has no value" cannot be spelled as a comparison — `= NULL` matches nothing in
 * SQL and `= ''` misses the NULLs — so it is an operator rather than a value a
 * caller types, and a filter carrying one is complete without a `value`.
 */
export const VALUELESS_FILTER_OPERATORS = ['empty', 'notEmpty'] as const;

export function filterOperatorTakesValue(operator: CatalogFilterOperator): boolean {
  return !VALUELESS_FILTER_OPERATORS.some((valueless) => valueless === operator);
}

/** One filter as it crosses the wire: a property name, an operator, raw text. */
export interface CatalogObjectFilter {
  /**
   * The property's `name`, which is its identity in the type — never its
   * `columnName`. On a published type the two differ whenever the source spelled
   * a column in a way SQL cannot: `Asset Id` arrives as `columnName` and the
   * property is `Asset_Id`. Filtering by the source spelling would resolve to no
   * property at all on every one of them.
   */
  property: string;
  op: CatalogFilterOperator;
  /** Absent for {@link VALUELESS_FILTER_OPERATORS}. Text, as it was typed. */
  value?: string;
}

/**
 * The minimum a column has to say for the rule below to run on it.
 *
 * Structural rather than `CatalogPropertyDef`, because the console holds the
 * *page's* columns rather than the type's — `CatalogObjectPage.columns` — and the
 * whole point is that both sides ask the same function. Both shapes satisfy this.
 */
export interface CatalogFilterableColumn {
  name: string;
  type: ScalarType;
  hidden?: boolean;
  classification?: string;
}

const TEXT_OPERATORS: readonly CatalogFilterOperator[] = [
  'contains',
  'eq',
  'ne',
  'empty',
  'notEmpty',
];
const NUMBER_OPERATORS: readonly CatalogFilterOperator[] = [
  'eq',
  'ne',
  'gte',
  'lte',
  'gt',
  'lt',
  'empty',
  'notEmpty',
];
/**
 * A date gets the two range ends and nothing else.
 *
 * No `eq`, deliberately. These columns are `DATETIME`, and a person filtering a
 * date types a day — so `= 2026-03-04` compares against midnight and misses every
 * row loaded at any other second of that day. It looks like "nothing happened on
 * the 4th", which is the most expensive wrong answer a filter can give. `gte` the
 * 4th and `lte` the 4th is the same intent expressed in a way that is true.
 */
const DATE_OPERATORS: readonly CatalogFilterOperator[] = ['gte', 'lte', 'empty', 'notEmpty'];
const BOOLEAN_OPERATORS: readonly CatalogFilterOperator[] = ['eq', 'empty', 'notEmpty'];

/**
 * What may be filtered on this column, derived from what the column is.
 *
 * An empty list means "not filterable", and there are three ways to get one.
 *
 * **Hidden** is the overlay saying a column is not part of the generic UI, and a
 * filter is generic UI.
 *
 * **Classified** is the one worth stating out loud, because the column is
 * otherwise perfectly filterable and the value is never rendered anyway. It is
 * excluded for the reason `MikroOrmReadStore.buildWhere` already excludes it from
 * SEARCH: a predicate over a classified column leaks it through row membership.
 * Filtering is strictly worse than searching there — `gte`/`lte` let a reader
 * binary-search a value they may not see, in as many requests as it takes.
 *
 * **`json`** because a blob has no useful comparison, and it is already dropped
 * from the readable columns by `CatalogService.visibleColumns`.
 */
export function filterOperatorsFor(column: CatalogFilterableColumn): CatalogFilterOperator[] {
  if (column.hidden === true) return [];
  if (column.classification) return [];
  switch (column.type) {
    case 'number':
      return [...NUMBER_OPERATORS];
    case 'date':
      return [...DATE_OPERATORS];
    case 'boolean':
      return [...BOOLEAN_OPERATORS];
    case 'json':
      return [];
    default:
      // `string`, `uuid` and `unknown`. The warehouse stores all three as text
      // and the ORM store compares them as strings, so they take the same
      // operators; `unknown` is a column whose type nobody could derive, and
      // treating it as text is what every other read path here does with it.
      return [...TEXT_OPERATORS];
  }
}

/** Which operators a column offers, once the store's own limits are applied. */
export function offeredFilterOperators(
  column: CatalogFilterableColumn,
  supported: readonly CatalogFilterOperator[],
): CatalogFilterOperator[] {
  return filterOperatorsFor(column).filter((operator) =>
    supported.some((available) => available === operator),
  );
}

/**
 * `property:op:value`, repeated once per filter.
 *
 * The value is everything after the second colon, so it may contain colons — a
 * timestamp does. A property name containing one cannot be addressed by this
 * form; that is refused by name in {@link resolveObjectFilters} rather than
 * silently mis-parsed, because a filter that quietly does not apply is a screen
 * showing every row as though it had been filtered.
 */
export function encodeObjectFilter(filter: CatalogObjectFilter): string {
  if (!filterOperatorTakesValue(filter.op)) return `${filter.property}:${filter.op}`;
  return `${filter.property}:${filter.op}:${filter.value ?? ''}`;
}

export function parseObjectFilter(raw: string): CatalogObjectFilter | undefined {
  const parts = raw.split(':');
  if (parts.length < 2) return undefined;
  const [property, op, ...rest] = parts;
  if (!property || !isCatalogFilterOperator(op)) return undefined;
  if (!filterOperatorTakesValue(op)) return { property, op };
  return { property, op, value: rest.join(':') };
}

/**
 * A filter with the property it names already resolved to the type's own.
 *
 * The property is carried as the definition rather than as a string, and that is
 * the guard rather than a nicety: a store builds a predicate out of a column
 * name, and the only names it can be handed here are ones that came off the type.
 * A caller's string never reaches SQL — it is matched against the type first, and
 * the store then maps the property to its physical column exactly as `sort` and
 * `search` already do, through the adapter's identifier rule.
 */
export interface CatalogResolvedFilter {
  property: CatalogPropertyDef;
  op: CatalogFilterOperator;
  /** Coerced to the property's type. Absent for the valueless operators. */
  value?: string | number | boolean | Date;
}

export interface CatalogFilterResolution {
  filters: CatalogResolvedFilter[];
  /** One sentence per filter that could not be honoured. Empty means all were. */
  problems: string[];
}

/**
 * How many filters one read may carry.
 *
 * A cap rather than none, because every filter is another conjunct in the two
 * statements a paged read issues, and a caller that can send five hundred can
 * make one request cost whatever it likes. Twenty is far past what a person
 * builds by hand and far short of anything that would trouble the optimiser.
 */
export const CATALOG_FILTER_LIMIT = 20;

/**
 * Turn what arrived into what a store may be given, or say why not.
 *
 * **Unhonourable filters are reported, never dropped.** The neighbouring
 * `parseOutcomes` on the controller drops an unrecognised trace outcome on
 * purpose, and this goes the other way for a reason that is worth the two
 * sentences: dropping there costs a filter, so a typo widens the result set and
 * shows more traces than asked for. Dropping HERE would narrow nothing — the read
 * would come back unfiltered and the screen would present the whole table as
 * though it were the matching rows. A filter that silently does not apply is the
 * one failure mode a filtering UI must not have.
 *
 * @param columns the properties this reader may see. Deliberately the visible,
 * non-blob columns rather than `type.properties`: a filter is only ever resolved
 * against what the same request would return.
 */
export function resolveObjectFilters(
  columns: readonly CatalogPropertyDef[],
  raw: readonly string[],
): CatalogFilterResolution {
  const filters: CatalogResolvedFilter[] = [];
  const problems: string[] = [];

  if (raw.length > CATALOG_FILTER_LIMIT) {
    problems.push(
      `${raw.length} filters were sent and at most ${CATALOG_FILTER_LIMIT} are accepted on one read.`,
    );
    return { filters, problems };
  }

  for (const entry of raw) {
    const resolved = resolveOne(columns, entry);
    if ('problem' in resolved) problems.push(resolved.problem);
    else filters.push(resolved.filter);
  }

  return { filters, problems };
}

/** One entry: the filter it names, or the sentence explaining why it is not one. */
function resolveOne(
  columns: readonly CatalogPropertyDef[],
  entry: string,
): { filter: CatalogResolvedFilter } | { problem: string } {
  const parsed = parseObjectFilter(entry);
  if (!parsed) {
    return {
      problem: `"${entry}" is not a filter. The form is property:operator:value, and the operator is one of ${CATALOG_FILTER_OPERATORS.join(', ')}.`,
    };
  }

  const property = columns.find((column) => column.name === parsed.property);
  if (!property) {
    return {
      problem: `${parsed.property} is not a readable property of this type. Filter by a property's name — on a published type that is the identifier form, which is not always how the source spelled the column.`,
    };
  }

  const allowed = filterOperatorsFor(property);
  if (!allowed.some((operator) => operator === parsed.op)) {
    return {
      problem:
        allowed.length === 0
          ? `${property.name} cannot be filtered.`
          : `${property.name} is ${property.type} and cannot be filtered with ${parsed.op}. It takes ${allowed.join(', ')}.`,
    };
  }

  if (!filterOperatorTakesValue(parsed.op)) return { filter: { property, op: parsed.op } };

  const coerced = coerceFilterValue(property.type, parsed.value ?? '');
  if (!coerced.ok) return { problem: `${property.name}: ${coerced.problem}` };
  return { filter: { property, op: parsed.op, value: coerced.value } };
}

/**
 * A typed value, or the reason there is none.
 *
 * Refusing rather than passing the text through is the whole of this function's
 * value. MySQL compares a string to a `DOUBLE` by coercing the string — `'abc'`
 * becomes `0` — so `mileage >= abc` is not an error, it is `mileage >= 0`, and it
 * comes back as a full page of rows that look filtered. The same is true of a
 * date that does not parse.
 */
export function coerceFilterValue(
  type: ScalarType,
  value: string,
): { ok: true; value: string | number | boolean | Date } | { ok: false; problem: string } {
  if (type === 'number') {
    const parsed = Number(value);
    if (value.trim() === '' || !Number.isFinite(parsed)) {
      return { ok: false, problem: `"${value}" is not a number.` };
    }
    return { ok: true, value: parsed };
  }
  if (type === 'date') {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return { ok: false, problem: `"${value}" is not a date.` };
    }
    return { ok: true, value: parsed };
  }
  if (type === 'boolean') {
    const normalised = value.trim().toLowerCase();
    if (['true', '1', 'yes'].includes(normalised)) return { ok: true, value: true };
    if (['false', '0', 'no'].includes(normalised)) return { ok: true, value: false };
    return { ok: false, problem: `"${value}" is not true or false.` };
  }
  return { ok: true, value };
}
