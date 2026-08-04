import 'reflect-metadata';

export const CATALOG_TYPE_META = Symbol('catalog:type');
export const CATALOG_PROPERTY_META = Symbol('catalog:property');

export interface CatalogTypeOptions {
  displayName?: string;
  pluralDisplayName?: string;
  description?: string;
  icon?: string;
  group?: string;
  titleProperty?: string;
}

export interface CatalogPropertyOptions {
  displayName?: string;
  description?: string;
  hidden?: boolean;
  order?: number;
  classification?: string;
  unit?: string;
}

/**
 * Declares the semantics the database cannot know: what this entity is called
 * in the business, which section it belongs to, and what to show when it
 * appears as a link somewhere else.
 *
 * Structure is never declared here — it is read off the ORM. An entity with no
 * `@CatalogType` still appears in the catalog, just with a name derived from
 * its class and no group.
 */
export function CatalogType(options: CatalogTypeOptions = {}): ClassDecorator {
  return (target) => {
    const existing: CatalogTypeOptions = Reflect.getMetadata(CATALOG_TYPE_META, target) ?? {};
    Reflect.defineMetadata(CATALOG_TYPE_META, { ...existing, ...options }, target);
  };
}

/**
 * Enriches one property. Everything it sets is tier 0 — the overlay can
 * override any of it at runtime without a migration, which is precisely why
 * these live in metadata rather than in the column definition.
 *
 * **This is also how a relation is enriched, and there is deliberately no
 * `@CatalogRelation`.** The metadata is keyed by property name, and a
 * `@ManyToOne` is a property; the registry looks the options up before it
 * decides whether the field is a scalar or a link, so
 * `@CatalogProperty({ displayName: 'Home base' })` on `Mvr.base` labels the link
 * exactly as it labels a column. A second decorator would be a synonym for this
 * one.
 *
 * A decorator that declared a relation *outright* — target, kind, join column —
 * was considered and rejected twice over. Everything an ORM models is already
 * derived, and a hand-written line that could restate it is a line that can
 * disagree with the schema, which is the one thing this model does not allow.
 * And the links an ORM genuinely cannot see are, in practice, the ones that
 * cross applications: neither side's ORM holds both ends, so no decorator in
 * either codebase can assert them. That is a curation act in the console, and it
 * needs a route that does not exist yet.
 */
export function CatalogProperty(options: CatalogPropertyOptions = {}): PropertyDecorator {
  return (target, propertyKey) => {
    const ctor = target.constructor;
    const existing: Record<string, CatalogPropertyOptions> =
      Reflect.getMetadata(CATALOG_PROPERTY_META, ctor) ?? {};
    Reflect.defineMetadata(
      CATALOG_PROPERTY_META,
      {
        ...existing,
        [String(propertyKey)]: { ...existing[String(propertyKey)], ...options },
      },
      ctor,
    );
  };
}

export function readTypeOptions(target: unknown): CatalogTypeOptions {
  if (typeof target !== 'function') return {};
  return Reflect.getMetadata(CATALOG_TYPE_META, target) ?? {};
}

export function readPropertyOptions(target: unknown): Record<string, CatalogPropertyOptions> {
  if (typeof target !== 'function') return {};
  return Reflect.getMetadata(CATALOG_PROPERTY_META, target) ?? {};
}
