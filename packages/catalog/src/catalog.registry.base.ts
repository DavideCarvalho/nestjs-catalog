import type {
  CatalogGraph,
  CatalogObjectTypeDef,
  CatalogOverlay,
  CatalogSnapshot,
} from './catalog.types';

/**
 * What the catalog knows about your types, however it came to know it.
 *
 * An abstract class rather than an interface so it doubles as the DI token.
 *
 * Two implementations are expected and they are genuinely different: one
 * *derives* the model from an ORM in the application that owns the tables, and
 * one *stores* it because the model arrived over the wire from somewhere else.
 * A warehouse has no entity classes to reflect over — the type definitions are
 * data it was handed. Everything above this line works the same either way.
 */
export abstract class CatalogRegistry {
  abstract getSnapshot(): CatalogSnapshot;
  abstract getType(name: string): CatalogObjectTypeDef | undefined;
  abstract getGraph(): CatalogGraph;

  /** Presentation-only edits. Never a schema change. */
  abstract patchType(
    typeName: string,
    patch: Partial<CatalogOverlay['types'][string]>,
  ): Promise<CatalogObjectTypeDef | undefined>;

  abstract patchProperty(
    typeName: string,
    propertyName: string,
    patch: NonNullable<CatalogOverlay['types'][string]['properties']>[string],
  ): Promise<CatalogObjectTypeDef | undefined>;

  abstract resetOverlay(): Promise<void>;
}
