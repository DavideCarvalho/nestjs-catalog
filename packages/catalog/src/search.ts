/**
 * One box that crosses the catalog.
 *
 * A catalog with two hundred object types is a catalog where finding anything
 * means already knowing which screen it lives on — types and properties on the
 * model screen, saved queries on the query screen, boards on the dashboards
 * screen — and the thing people actually type is a word they half-remember. This
 * module is the half of that which has no request in it: given a term, some
 * types, some saved queries and some dashboards, which rows come back and in
 * what order.
 *
 * Pure on purpose. The ranking is the part a reader has to be able to predict
 * and the part that must not change by accident, so it is a function with no
 * store, no principal and no clock in it, and the two things that DO depend on
 * who is asking — {@link visibleToPrincipal} and the route's scope — sit either
 * side of it where they can be read.
 */

import {
  type CatalogPrincipal,
  hasScope,
  mayRead,
  maySeeClassification,
} from './catalog.principal';
import type { CatalogObjectTypeDef } from './catalog.types';
import type {
  CatalogSearchField,
  CatalogSearchHit,
  CatalogSearchKind,
  CatalogSearchRank,
  CatalogSearchResult,
} from './search.types';

/**
 * What comes back when nothing was asked for, or when the caller may see
 * nothing at all.
 *
 * A function rather than a shared constant so no two responses can hand out the
 * same `hits` array — a frozen empty list is safe until somebody downstream
 * decides an empty result is a fine thing to push a "nothing found" placeholder
 * onto.
 *
 * The two cases are deliberately indistinguishable from outside. "You may see
 * none of the eleven things that matched" and "eleven things matched, none of
 * them yours" are the same sentence to a caller, and the second one is the
 * disclosure.
 */
export function emptySearch(term = ''): CatalogSearchResult {
  return { term, total: 0, truncated: false, hits: [] };
}

export const DEFAULT_SEARCH_LIMIT = 50;
export const MAX_SEARCH_LIMIT = 200;

/**
 * Strongest first. The numbers are only ever compared, never shown — the wire
 * carries the name, so a client can render "exact" without knowing this table.
 */
const RANK_ORDER: Record<CatalogSearchRank, number> = {
  exact: 0,
  prefix: 1,
  name: 2,
  text: 3,
};

/**
 * The tie-break after rank, and it is a claim about what people search for.
 *
 * A type is the thing somebody is usually looking for; a property only exists
 * inside one; a saved query and a board are things somebody made later. Equal
 * evidence, so the more likely intent wins. It is stated as a table rather than
 * left to array order because the order results are *built* in is an
 * implementation detail and this is not.
 */
const KIND_ORDER: Record<CatalogSearchKind, number> = {
  objectType: 0,
  property: 1,
  savedQuery: 2,
  dashboard: 3,
};

interface Candidate {
  field: CatalogSearchField;
  value: string | undefined;
  /**
   * Whether this field says what the thing is CALLED, as opposed to what
   * somebody wrote about it. Identifying fields can reach every rank; describing
   * fields only ever reach `text`.
   */
  identifying: boolean;
}

/**
 * The best rank any of these fields can claim for this term, and which field
 * claimed it.
 *
 * Ties go to the field declared first, which is why every call site below lists
 * `name` before `displayName`: on equal evidence the code name wins, because it
 * is the stable identity, the string a URL carries, and the one a person who
 * typed it was almost certainly typing on purpose.
 *
 * `term` is expected already lower-cased and trimmed — done once by the caller
 * rather than per field, since this runs over every property of every type.
 */
export function bestMatch(
  term: string,
  candidates: Candidate[],
): { rank: CatalogSearchRank; field: CatalogSearchField } | undefined {
  let best: { rank: CatalogSearchRank; field: CatalogSearchField } | undefined;

  for (const candidate of candidates) {
    const rank = rankOne(term, candidate);
    if (rank && (!best || RANK_ORDER[rank] < RANK_ORDER[best.rank])) {
      best = { rank, field: candidate.field };
      // `exact` is the ceiling, so nothing later can beat it and the remaining
      // fields need not be read at all.
      if (rank === 'exact') return best;
    }
  }

  return best;
}

/** How well one field matches, on its own. The four tiers, and nothing else. */
function rankOne(term: string, candidate: Candidate): CatalogSearchRank | undefined {
  const value = candidate.value?.trim().toLowerCase();
  if (!value) return undefined;
  if (!candidate.identifying) {
    // Describing fields get one rank and no gradations. See the note on
    // `CatalogSearchRank`: "the description opens with your word" is not
    // evidence of anything.
    return value.includes(term) ? 'text' : undefined;
  }
  if (value === term) return 'exact';
  if (value.startsWith(term)) return 'prefix';
  if (value.includes(term)) return 'name';
  return undefined;
}

/**
 * The catalog as this principal is allowed to see it.
 *
 * Two rules, and both are about names rather than values:
 *
 * *A type they may not read does not exist here*, and neither do its properties.
 * A search that answers "there is a type called `PayrollAdjustment`" to somebody
 * whose `readTypes` excludes it has disclosed the thing they were excluded from,
 * even though not one row came back.
 *
 * *A classified property they do not hold the classification for is dropped, not
 * blanked.* `readableObjectPage` deletes such a column from a page of rows for
 * the same reason; here the sensitive part IS the name — `settlement_amount` on
 * a table called `Dispute` is the disclosure, and a hit saying "there is a
 * property here you may not see" is worse than no hit, because it also confirms
 * the guess that produced the search term.
 *
 * **An absent principal filters nothing**, and that is not a fail-open. This
 * library resolves no principal and ships no guard — the split is written out at
 * length above `mayWrite` in `catalog.principal.ts` — so `undefined` here means
 * the host wired no guard, and in that deployment `GET /catalog` already hands
 * the entire snapshot, every type and every property name, to whoever asks.
 * Search must never be a SOFTER path to something than the routes that exist;
 * being exactly as soft as the snapshot route, and strictly harder the moment a
 * principal appears, is the guarantee this can honestly make.
 *
 * Hidden properties are kept. `hidden` is a tier-0 display flag any curator can
 * flip back, it is already in the snapshot, and excluding it would make search
 * the one place a curator cannot find the property they just hid in order to
 * un-hide it.
 */
export function visibleToPrincipal(
  principal: CatalogPrincipal | undefined,
  types: CatalogObjectTypeDef[],
): CatalogObjectTypeDef[] {
  if (!principal) return types;

  const visible: CatalogObjectTypeDef[] = [];
  for (const type of types) {
    if (!mayRead(principal, type.name)) continue;
    const properties = type.properties.filter((property) =>
      maySeeClassification(principal, property.classification),
    );
    // Rebuilt only when something was actually dropped, so the common case
    // hands back the registry's own object rather than a copy of it per search.
    visible.push(properties.length === type.properties.length ? type : { ...type, properties });
  }
  return visible;
}

/**
 * Whether this principal may use the search route at all.
 *
 * The route declares `catalog:read` and a host's guard is what enforces it, so
 * in a correctly wired deployment this can never be false. It is asked anyway
 * because of what would otherwise be inconsistent: `visibleToPrincipal` drops
 * every type for a principal without `catalog:read` — `mayRead` checks the scope
 * first — while the saved queries and dashboards, which have no per-object grant
 * to check, would sail through. A route that answers "no types, but here are
 * eleven board names" to somebody who may read nothing is a route whose access
 * story depends on which half of it you read.
 */
export function maySearch(principal: CatalogPrincipal | undefined): boolean {
  if (!principal) return true;
  return hasScope(principal, 'catalog:read');
}

/**
 * What a saved query contributes to a search. A subset, not the row: `sql` is
 * deliberately absent from the input as well as the output.
 *
 * Matching on the statement is a tempting feature — "which query touches
 * `mvr`?" — and it is the wrong one here. It turns a name search into a code
 * search, so a term like `select` matches everything; the hit it produces cannot
 * be explained in a row without showing the SQL that justified it; and the row
 * would then be a fragment of a statement rendered somewhere a statement was
 * never meant to appear. A host that wants to grep saved SQL wants a different
 * route with a different name.
 */
export interface SearchableSavedQuery {
  id: string;
  name: string;
  description?: string;
  /** Free-form grouping. Ranked as a `group`, which is what it is. */
  folder?: string;
}

export interface SearchableDashboard {
  id: string;
  name: string;
  description?: string;
}

export interface SearchInput {
  term: string;
  types: CatalogObjectTypeDef[];
  savedQueries: SearchableSavedQuery[];
  dashboards: SearchableDashboard[];
  /** Bounded by {@link MAX_SEARCH_LIMIT} whatever is passed. */
  limit?: number;
}

/**
 * Search four kinds of thing and return them in one ranked list.
 *
 * ---------------------------------------------------------------------------
 * **Why connectors and transforms are not in here.**
 *
 * Not an oversight, and not something to add later without moving something
 * else first. Connectors and transforms are served by
 * `@dudousxd/nestjs-catalog-pipeline`, a package this one does not depend on and
 * should not: `routes.ts` in the React package makes the argument in full, but
 * the short version is that the catalog library ships no controller for them
 * because how a deployment exposes the code that reshapes its data is the
 * deployment's decision, not this library's.
 *
 * The access consequence is the deciding one. This route declares
 * `catalog:read`. A connector carries a connection reference and a
 * `secretEnvVar` naming where its credential lives, and whatever guard a host
 * put on its pipeline routes, it was not necessarily this one. Folding
 * connectors into a `catalog:read` result would quietly re-grant them under a
 * scope their owner never agreed to — the exact shape of the failure the scope
 * table at the top of `catalog.controller.ts` exists to prevent.
 *
 * So the seam is stated rather than hidden: this searches the registry snapshot
 * plus the workspace store, which are the two things the catalog module owns. A
 * console that wants connectors in the same box makes a second call against the
 * pipeline's own routes, under the pipeline's own guard, and merges two lists —
 * which is honest about the fact that they are two permissions.
 * ---------------------------------------------------------------------------
 *
 * The order, in full, so it can be argued with:
 *
 * 1. rank — `exact`, then `prefix`, then `name`, then `text`;
 * 2. kind — type, property, saved query, dashboard;
 * 3. label, then id, lexicographically.
 *
 * Rank outranks kind because an exact property match is a better answer than a
 * type whose description happens to mention the word. Steps 2 and 3 exist so the
 * result is *total*: a search that returned the same rows in a different order
 * on the next call would make the top of the list flicker under a debounced
 * input, and would make every test of this function a test of `Array.sort`
 * stability.
 */
export function searchCatalog(input: SearchInput): CatalogSearchResult {
  const term = input.term.trim().toLowerCase();
  // An empty box is not an error. A search screen mounts empty, and a 400 on
  // mount is a red panel where a prompt should be.
  if (!term) return emptySearch();

  const limit = Math.min(
    Math.max(Math.trunc(Number(input.limit) || DEFAULT_SEARCH_LIMIT), 1),
    MAX_SEARCH_LIMIT,
  );

  // One flat list, built per kind and ranked as a whole. Building it per kind
  // and concatenating would put the kind order ahead of the rank, which is
  // exactly backwards — see the order stated above.
  const hits: CatalogSearchHit[] = [
    ...input.types.flatMap((type) => hitsForType(term, type)),
    ...input.savedQueries.flatMap((query) => hitsForSavedQuery(term, query)),
    ...input.dashboards.flatMap((dashboard) => hitsForDashboard(term, dashboard)),
  ];

  hits.sort(compareHits);

  return {
    term,
    // Counted before the cut, so a UI can say "50 of 312" — and counted after
    // the caller's own types were filtered out upstream, which is the half that
    // matters. See `CatalogSearchResult.total`.
    total: hits.length,
    truncated: hits.length > limit,
    hits: hits.slice(0, limit),
  };
}

/** The type itself, then every property on it. Zero, one or many. */
function hitsForType(term: string, type: CatalogObjectTypeDef): CatalogSearchHit[] {
  const hits: CatalogSearchHit[] = [];

  const typeMatch = bestMatch(term, [
    { field: 'name', value: type.name, identifying: true },
    { field: 'displayName', value: type.displayName, identifying: true },
    // The plural is an identifying field too — somebody typing "vehicles" means
    // the type — but it is reported as `displayName`, because "matched:
    // pluralDisplayName" is a distinction no reader of a search row wants.
    { field: 'displayName', value: type.pluralDisplayName, identifying: true },
    { field: 'description', value: type.description, identifying: false },
    { field: 'group', value: type.group, identifying: false },
  ]);
  if (typeMatch) {
    hits.push({
      kind: 'objectType',
      id: type.name,
      label: type.displayName || type.name,
      typeName: type.name,
      detail: type.group || undefined,
      ...typeMatch,
    });
  }

  for (const property of type.properties) {
    const match = bestMatch(term, [
      { field: 'name', value: property.name, identifying: true },
      { field: 'displayName', value: property.displayName, identifying: true },
      { field: 'description', value: property.description, identifying: false },
      { field: 'unit', value: property.unit, identifying: false },
    ]);
    if (!match) continue;
    hits.push({
      kind: 'property',
      id: property.name,
      label: property.displayName || property.name,
      typeName: type.name,
      detail: property.unit ? `${property.type} · ${property.unit}` : property.type,
      ...match,
    });
  }

  return hits;
}

function hitsForSavedQuery(term: string, query: SearchableSavedQuery): CatalogSearchHit[] {
  const match = bestMatch(term, [
    // A saved query has no code name, so `name` is its one identifying field —
    // listed first, matching the tie-break rule everywhere else.
    { field: 'name', value: query.name, identifying: true },
    { field: 'description', value: query.description, identifying: false },
    { field: 'group', value: query.folder, identifying: false },
  ]);
  if (!match) return [];
  return [
    {
      kind: 'savedQuery',
      id: query.id,
      label: query.name,
      detail: query.folder || undefined,
      ...match,
    },
  ];
}

function hitsForDashboard(term: string, dashboard: SearchableDashboard): CatalogSearchHit[] {
  const match = bestMatch(term, [
    { field: 'name', value: dashboard.name, identifying: true },
    { field: 'description', value: dashboard.description, identifying: false },
  ]);
  if (!match) return [];
  return [{ kind: 'dashboard', id: dashboard.id, label: dashboard.name, ...match }];
}

function compareHits(a: CatalogSearchHit, b: CatalogSearchHit): number {
  const byRank = RANK_ORDER[a.rank] - RANK_ORDER[b.rank];
  if (byRank !== 0) return byRank;
  const byKind = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  if (byKind !== 0) return byKind;
  // Plain comparison rather than `localeCompare`: the order has to be the same
  // in a test, on a developer's machine and in a container with no ICU data,
  // and a locale-aware collation is the one thing here that differs between all
  // three.
  if (a.label !== b.label) return a.label < b.label ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  // Two properties of the same name on different types. Nothing else can
  // separate them, and leaving it to sort stability would make the order depend
  // on the registry's iteration order.
  //
  // Zero when even that is equal, rather than a constant 1: a comparator that
  // reports `a > b` and `b > a` for the same pair is not an ordering, and some
  // sort implementations are entitled to do anything at all with one.
  const aType = a.typeName ?? '';
  const bType = b.typeName ?? '';
  if (aType === bType) return 0;
  return aType < bType ? -1 : 1;
}
