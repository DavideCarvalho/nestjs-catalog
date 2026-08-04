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

/** A link between two object types. Derived entirely from the ORM. */
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
    relations: number;
    enrichedTypes: number;
  };
  types: CatalogObjectTypeDef[];
}

/** Nodes and edges, for drawing the ontology. */
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
  }>;
  rows: Array<Record<string, unknown>>;
}
