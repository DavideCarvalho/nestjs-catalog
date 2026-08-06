/**
 * The metadata model.
 *
 * Two ideas hold this together:
 *
 * 1. **Structure is derived, semantics are declared.** Everything that can be
 *    read off the ORM (column names, SQL types, nullability, foreign keys) is
 *    derived — no human writes it twice. Everything a human knows and the
 *    database does not (what to call it, what it means, who may see it) is
 *    declared with decorators or, for the purely cosmetic parts, edited at
 *    runtime through the overlay.
 *
 * 2. **Tier 0 changes are not schema changes.** Display names, descriptions,
 *    grouping, visibility and ordering never touch the database, so they never
 *    need a migration and never need an engineer. That boundary is what makes
 *    it safe to hand the editor to a non-engineer.
 */

import type { CatalogFilterOperator } from './catalog.filters';

export type ScalarType = 'string' | 'number' | 'boolean' | 'date' | 'json' | 'uuid' | 'unknown';

export type RelationKind = '1:1' | '1:m' | 'm:1' | 'm:n';

/** A single scalar field on an object type. */
export interface CatalogPropertyDef {
  /** Code name, as written in the entity. Stable — the overlay never changes it. */
  name: string;
  /** Human label. Tier 0: editable at runtime, no migration. */
  displayName: string;
  /**
   * What this field means in the business. Tier 0.
   *
   * **Markdown**, since the console started editing it as rich text. Plain text
   * is still valid markdown, so anything written before — or declared by a
   * decorator — is unchanged and renders as itself.
   *
   * Consumers that print it raw keep working: the worst they will see is
   * `**bold**`, which reads. That is the whole reason it is not HTML — `<strong>`
   * in a tooltip is noise, and a consumer that decided to render it as HTML
   * would have an injection point. Render it with a markdown renderer if you
   * want the formatting; `RichTextView` in `@dudousxd/nestjs-catalog-react` is
   * the one this console uses.
   */
  description?: string;
  type: ScalarType;
  /** The physical column. Derived from the ORM; shown so engineers can trace it. */
  columnName: string;
  nullable: boolean;
  primary: boolean;
  /** Tier 0: hide from generic UIs without dropping the column. */
  hidden: boolean;
  /** Tier 0: display order. Lower sorts first. */
  order: number;
  /** e.g. "CUI", "UNCLASSIFIED". Drives redaction in generic UIs. Tier 0. */
  classification?: string;
  /** e.g. "miles", "USD", "days". Tier 0. */
  unit?: string;
  /** True when the value came from a hand-written decorator rather than the ORM. */
  enriched: boolean;
}

/**
 * A link between two object types — the thing that makes this an ontology
 * rather than a list of tables.
 *
 * **Structure derived, semantics declared**, the same split as everywhere else.
 * A `@ManyToOne` already names its target, its kind and its join column, so none
 * of that is ever written by hand — a decorator that could restate it is a
 * decorator that can disagree with the schema. What a human adds is what they
 * add to a scalar, a label and a meaning, through `@CatalogProperty` or the
 * overlay; both key on the property name and so reach a relation without having
 * to know it is one.
 *
 * **One row per declaration, not per link.** `@ManyToOne(() => Base)` on `Mvr`
 * with the matching `@OneToMany` on `Base` is two rows describing one link.
 * Collapsing them here would mean `Base` could not carry its own label for the
 * end it declares, and a type could not say what it points at without consulting
 * every other type. The graph collapses them instead — see {@link CatalogGraph}.
 */
export interface CatalogRelationDef {
  name: string;
  displayName: string;
  description?: string;
  kind: RelationKind;
  /** Class name of the type on the other end. */
  targetType: string;
  /** Property on this side holding the key, when the ORM exposes one. */
  localKey?: string;
  nullable: boolean;
  hidden: boolean;
  order: number;
  /**
   * True when this side physically holds the key.
   *
   * The two ends of a link are not interchangeable. The owning end is where the
   * foreign key actually is, so it is the end a join is written from, the end
   * whose column can be indexed, and the end whose removal breaks the link. A
   * `1:m` is never the owner — the key lives on the many side.
   */
  owner: boolean;
  /**
   * The property on {@link targetType} that is the other end of this same link,
   * when the ORM knows it (MikroORM's `mappedBy` / `inversedBy`).
   *
   * This is what lets two rows be recognised as one link. Pairing them by name
   * instead only works for the accident of both ends being spelled the same:
   * `Mvr.base` and `Base.mvrs` are one link and would otherwise draw two edges,
   * which is exactly the picture a graph is supposed to prevent.
   */
  inverseName?: string;
  /**
   * Whether {@link targetType} is a type this catalog actually holds.
   *
   * False when the target was excluded by configuration, or belongs to an
   * application that has not published it. The relation is still reported: that
   * an MVR points at something called `Base` is true, and when the other end is
   * missing that is the most useful single fact about it. Dropping it silently
   * would leave a type looking unlinked when it is really linked to something
   * out of reach — but drawing it as a navigable edge promises a node that
   * cannot be opened, so the graph omits it and the type page keeps it, marked.
   */
  targetPublished: boolean;
  /** True when a human has labelled or described this link. */
  enriched: boolean;
}

/** One node of the ontology. */
export interface CatalogObjectTypeDef {
  /** Entity class name — the stable identity. */
  name: string;
  /** Tier 0. */
  displayName: string;
  /** Tier 0. */
  pluralDisplayName: string;
  /** Tier 0. */
  description?: string;
  /** Physical table. Derived. */
  tableName: string;
  /** Tier 0: an emoji or icon key, for the generic UIs. */
  icon?: string;
  /** Tier 0: the section this type belongs to, e.g. "Fleet", "Maintenance". */
  group: string;
  /**
   * Tier 0: which property to render when this object appears as a link.
   * Falls back to the primary key.
   */
  titleProperty?: string;
  primaryKey: string[];
  /**
   * True when a human has said anything about this type — a `@CatalogType`, a
   * `@CatalogProperty`, or a tier-0 edit. The whole point of showing it is to
   * make the un-enriched types visible, because those are the ones whose names
   * came from a regex and are probably wrong.
   */
  enriched: boolean;

  /**
   * When readers started seeing the data this type currently serves.
   *
   * `committedAt` of the newest committed snapshot, not `createdAt`: a load that
   * was written and never committed is not what anybody is reading, and dating
   * the type by it would report freshness nobody has.
   *
   * **Absent means no committed snapshot ever**, which is a different statement
   * from "committed a year ago" — a type published by a schema and never loaded
   * looked exactly like a type loaded daily until this field existed, and both
   * looked exactly like a type whose publisher was deleted six months ago.
   *
   * Carried on the type rather than fetched per type on demand. The value of
   * this signal is that it arrives without anybody going to look for it, and a
   * field costing one request per row on a screen listing every type is a field
   * that screen will not use.
   */
  lastCommittedAt?: string;

  /**
   * Rows in that snapshot.
   *
   * Here for a failure the timestamp cannot show: a connector that starts
   * returning 12 rows where it returned 40,000 produces data that is wrong and
   * *fresh*, so every staleness signal reports it as healthy. The count next to
   * the date is what makes that visible, and it is the same read.
   */
  rowCount?: number;

  /**
   * Which application committed it.
   *
   * Because "stale since March" is never the last question — "so who was
   * loading this?" is — and the answer is already in the row being read.
   */
  lastPrincipalId?: string;

  properties: CatalogPropertyDef[];
  relations: CatalogRelationDef[];
}

export interface CatalogSnapshot {
  /** Bumps whenever the overlay changes, so clients can cache. */
  version: number;
  generatedAt: string;
  /** How many types the ORM exposed vs. how many carry hand-written semantics. */
  stats: {
    types: number;
    properties: number;
    /**
     * Declared relations, summed over the types — **not** distinct links. A link
     * declared at both ends counts twice, because that is what this number is
     * derived from and quietly halving it would make it disagree with the rows
     * on the type pages that produce it. `getGraph().edges.length` is the count
     * of links.
     */
    relations: number;
    enrichedTypes: number;
  };
  types: CatalogObjectTypeDef[];
}

/**
 * Nodes and edges, for drawing the ontology.
 *
 * One edge per **link**, not per declaration: a link declared at both ends is
 * one line on the picture, drawn from the end that holds the key so the arrow
 * points the way a join is written. And every edge lands on a node that is
 * present — a target this catalog does not hold produces no edge, because an
 * edge to nowhere is a node the reader will try to click.
 */
export interface CatalogGraph {
  nodes: Array<{
    id: string;
    label: string;
    group: string;
    icon?: string;
    propertyCount: number;
    relationCount: number;
  }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
    label: string;
    kind: RelationKind;
  }>;
}

/**
 * The runtime-editable slice. Everything here is tier 0 — it changes what
 * people see, never what the database holds.
 */
export interface CatalogOverlay {
  types: Record<
    string,
    {
      displayName?: string;
      pluralDisplayName?: string;
      description?: string;
      icon?: string;
      group?: string;
      titleProperty?: string;
      /**
       * Keyed by property name — and a relation is a property to whoever is
       * looking, so a link's label and description are curated through this map
       * too, under the relation's own name. That is why curating a link needs no
       * new route and no new patch shape: `patchProperty` already accepts one.
       */
      properties?: Record<
        string,
        {
          displayName?: string;
          description?: string;
          hidden?: boolean;
          order?: number;
          classification?: string;
          unit?: string;
        }
      >;
    }
  >;
}

export interface CatalogObjectQuery {
  page?: number;
  size?: number;
  search?: string;
  sort?: string;
  dir?: 'asc' | 'desc';
  /**
   * Column filters, as they arrived: `property:operator:value`, one string each.
   *
   * Unvalidated, exactly like `sort` and `search` beside it — these are what a
   * caller typed. `CatalogService.readObjects` resolves them against the type
   * before any store sees them, and refuses the read if any of them cannot be
   * honoured. See `catalog.filters.ts`, which owns both halves of that rule and
   * is also what a console derives its controls from.
   */
  filters?: string[];
}

export interface CatalogObjectPage {
  type: string;
  page: number;
  size: number;
  total: number;
  pages: number;
  /**
   * The visible, non-blob columns, in overlay order.
   *
   * Visible means "not hidden by the overlay". It does **not** mean redacted for
   * a caller: a classified column is here, with its `classification` on it, and
   * dropping it is the host's move — see `readableObjectPage`.
   */
  columns: Array<{
    name: string;
    displayName: string;
    type: ScalarType;
    classification?: string;
    unit?: string;
    /**
     * How the source spells this column, when it is not how the property is
     * named.
     *
     * Lineage, and only lineage — nothing reads a record through it. A reader
     * recognises the source spelling because it is what is on their spreadsheet,
     * and a filter has to be built from the property name, so both are here and a
     * screen can show one and send the other.
     *
     * The two differ less often than they used to. A property may now be named
     * `Asset Id` outright: a store cleans the name to reach its column and
     * aliases its view to the cleaned form, so a name is no longer required to be
     * a SQL identifier. Publishers were previously told to send `{ name:
     * 'Asset_Id', columnName: 'Asset Id' }`, which is where most of the divergent
     * pairs in an older catalog come from — and it was a costly instruction,
     * because a load matches records to properties by NAME, so those columns
     * loaded NULL. The two still differ whenever a publisher chooses different
     * names for its own reasons, which is why the field stays.
     *
     * Optional: a page served by a version of this library that predates the
     * field simply does not say, and a screen falls back to the property name.
     */
    columnName?: string;
    /**
     * What this column may be filtered with, here and now.
     *
     * Derived from the column by `filterOperatorsFor` and then narrowed to what
     * the mounted store can actually apply, so the list is the server's answer
     * rather than the screen's guess. **Empty means not filterable** — a
     * classified column, a blob, or a store that does not filter at all.
     *
     * Optional, and absent is not the same as empty: a server older than this
     * field has not been asked. A screen must read absent the pessimistic way and
     * offer nothing, because offering a control the server will refuse is worse
     * than offering none.
     */
    filterOperators?: CatalogFilterOperator[];
  }>;
  rows: Array<Record<string, unknown>>;

  /**
   * Which load these rows came from, when the store keeps history.
   *
   * Reported by the store as part of the read rather than looked up separately,
   * so it costs nothing and — more importantly — it describes the snapshot that
   * was actually read rather than the one the caller believes it asked for. A
   * screen that drew its "you are looking at an old load" banner from its own
   * state would be trusting the wrong end of the request.
   *
   * Absent when the store keeps no snapshots at all.
   */
  snapshot?: {
    id: string;
    /** False means these rows are NOT what a reader gets by default. */
    current: boolean;
  };
}
