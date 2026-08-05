/**
 * What one search across the catalog gives back.
 *
 * A separate file from `search.ts` so `client.ts` can re-export these without
 * dragging the matcher into a browser bundle. The shapes are the contract — a
 * host writing its own search box needs them as much as it needs the path.
 *
 * **Rows, not objects.** Every hit carries what it takes to draw a line and
 * follow it, and nothing else: no `sql`, no property list, no card layout. That
 * is not a size optimisation. A search route is the one endpoint whose result
 * set is chosen by a stranger's typing, so it is the endpoint where "we returned
 * a bit more than the screen needed" turns into a disclosure nobody reviewed. A
 * caller that wants the whole saved query asks `GET saved-queries/:id`, which is
 * a route somebody thought about.
 */

/**
 * What kind of thing was found.
 *
 * Four, and the omissions are deliberate — see the block above `searchCatalog`
 * in `search.ts` for why connectors and transforms are not here and cannot be
 * without changing which package owns their access model.
 */
export type CatalogSearchKind = 'objectType' | 'property' | 'savedQuery' | 'dashboard';

/**
 * How well it matched, strongest first. Four values rather than a number,
 * because a score is only useful if a reader can predict it, and nobody has ever
 * been able to predict `0.6231`.
 *
 * - `exact` — an identifying field IS the term.
 * - `prefix` — an identifying field starts with it.
 * - `name` — an identifying field contains it somewhere.
 * - `text` — a describing field contains it.
 *
 * Identifying means `name` or `displayName`: what the thing is called. Describing
 * means `description`, `group`, `unit`: what somebody wrote about it. The split
 * is the whole ranking. Within a describing field no distinction is made between
 * "starts with" and "contains", because a description that happens to open with
 * your word is not a better answer than one that mentions it in the middle, and
 * pretending otherwise is where an unpredictable score starts.
 */
export type CatalogSearchRank = 'exact' | 'prefix' | 'name' | 'text';

/** Which field the term was found in — the "why" on every row. */
export type CatalogSearchField = 'name' | 'displayName' | 'description' | 'group' | 'unit';

export interface CatalogSearchHit {
  kind: CatalogSearchKind;
  /**
   * What identifies it within its kind: the type name, the property name, the
   * saved query's or dashboard's id.
   *
   * Not unique across kinds on its own — a property called `status` on two types
   * is two hits with the same `id` — so anything keying on a hit keys on
   * `kind`, `typeName` and `id` together.
   */
  id: string;
  /** What to show. The display name where there is one, the code name otherwise. */
  label: string;
  /**
   * The object type this result belongs to: itself for an `objectType`, its
   * owner for a `property`, absent for a saved query or a dashboard.
   *
   * Set on the type as well as the property so a client navigating to the model
   * screen writes `hit.typeName && explorerHref(hit.typeName)` once, rather than
   * a branch per kind that will be wrong the first time a kind is added.
   */
  typeName?: string;
  /**
   * One short line of context: the group for a type, the scalar type and unit
   * for a property, the folder for a saved query.
   *
   * Structural, never a snippet of the description. A snippet would have to be
   * cut somewhere, and a description cut mid-sentence is how a classified
   * meaning ends up half-rendered in a dropdown; `field` already says the match
   * was in the description, and the row it links to shows the whole of it.
   */
  detail?: string;
  rank: CatalogSearchRank;
  field: CatalogSearchField;
}

export interface CatalogSearchResult {
  /** The term as it was searched, trimmed. Echoed so a stale answer is recognisable. */
  term: string;
  /**
   * How many hits matched **and were visible to this caller**, before the cap.
   *
   * After the access filter, deliberately. A total counted before it would let
   * a caller learn that eleven more types match "payroll" than they can see,
   * which is the disclosure this route spends most of its code avoiding.
   */
  total: number;
  /** True when {@link total} exceeded the limit and {@link hits} was cut. */
  truncated: boolean;
  hits: CatalogSearchHit[];
}
