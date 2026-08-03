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
