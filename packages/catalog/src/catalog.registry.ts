import type { EntityClass, EntityMetadata, EntityProperty } from '@mikro-orm/core';
// Value import, not type-only: Nest resolves this constructor parameter from
// the emitted `design:paramtypes`, which a type-only import erases.
import { MikroORM } from '@mikro-orm/core';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { readPropertyOptions, readTypeOptions } from './catalog.decorators';
import { emitCatalog } from './catalog.events';
import { CATALOG_OPTIONS, type CatalogModuleOptions } from './catalog.options';
import type { CatalogOverlayStore } from './catalog.overlay-store';
import { CATALOG_OVERLAY_STORE } from './catalog.overlay-store.token';
import { CatalogRegistry } from './catalog.registry.base';
import type {
  CatalogGraph,
  CatalogObjectTypeDef,
  CatalogOverlay,
  CatalogPropertyDef,
  CatalogRelationDef,
  CatalogSnapshot,
  RelationKind,
  ScalarType,
} from './catalog.types';

const RELATION_KINDS: RelationKind[] = ['1:1', '1:m', 'm:1', 'm:n'];

function isRelationKind(kind: string): kind is RelationKind {
  return RELATION_KINDS.includes(kind as RelationKind);
}

/** Classify one type name. Returns "unknown" when nothing matches. */
function classify(raw: string): ScalarType {
  const t = raw.toLowerCase();
  if (!t) return 'unknown';
  if (t.includes('uuid')) return 'uuid';
  // tinyint(1) is how MySQL spells boolean, so it has to beat the "int" test.
  if (t.includes('bool') || t.startsWith('tinyint(1)')) return 'boolean';
  if (t.includes('date') || t.includes('time')) return 'date';
  if (
    t.includes('int') ||
    t.includes('float') ||
    t.includes('double') ||
    t.includes('decimal') ||
    t.includes('number') ||
    t.includes('numeric')
  ) {
    return 'number';
  }
  if (t.includes('json') || t.includes('array')) return 'json';
  if (t.includes('string') || t.includes('char') || t.includes('text') || t.includes('enum')) {
    return 'string';
  }
  return 'unknown';
}

/**
 * Turn an ORM property into something a UI can switch on.
 *
 * Three sources are tried in order, because no single one is reliable. A field
 * declared `Opt<string>` (MikroORM's optional brand) emits `Object` through
 * `emitDecoratorMetadata`, so the TypeScript-side type is useless for roughly
 * half the columns in a real schema — but the SQL column type always knows.
 * Hence the fallback to `columnTypes`.
 *
 * Kept deliberately coarse. This is not reproducing the SQL type system, it is
 * answering "can I right-align this, and does a date picker make sense".
 */
function toScalarType(prop: EntityProperty): ScalarType {
  const candidates = [prop.runtimeType, prop.type, prop.columnTypes?.[0]].filter(
    (c): c is string => typeof c === 'string' && c.length > 0,
  );

  for (const candidate of candidates) {
    const resolved = classify(candidate);
    // `Object` is what a branded or optional type erases to; it tells us
    // nothing, so keep looking rather than calling it json.
    if (resolved !== 'unknown' && candidate.toLowerCase() !== 'object') {
      return resolved;
    }
  }
  return 'unknown';
}

/**
 * `PriBuyBuyListDetail` -> `Pri Buy Buy List Detail`.
 *
 * A guess, and a visibly imperfect one. That is the point: the derived name is
 * a starting value, and the whole reason the overlay exists is so a human can
 * correct it in ten seconds without opening an editor.
 */
function humanize(name: string): string {
  const spaced = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!spaced) return name;
  // `id` -> `ID` rather than `Id`: it is the single most common column in any
  // schema, and getting it wrong is the first thing anyone notices.
  if (spaced.toLowerCase() === 'id') return 'ID';
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function pluralize(name: string): string {
  if (/(s|x|z|ch|sh)$/i.test(name)) return `${name}es`;
  if (/[^aeiou]y$/i.test(name)) return `${name.slice(0, -1)}ies`;
  return `${name}s`;
}

@Injectable()
export class MikroOrmCatalogRegistry extends CatalogRegistry implements OnModuleInit {
  private readonly logger = new Logger(MikroOrmCatalogRegistry.name);
  private snapshot: CatalogSnapshot | null = null;
  private overlay: CatalogOverlay = { types: {} };
  private version = 0;
  /**
   * Class name -> entity constructor, collected while walking the metadata.
   *
   * Kept here rather than looked up on demand because MikroORM's metadata Map
   * is typed as keyed by `EntityName` (a class), so a `.get(someString)` does
   * not typecheck even though the runtime keys are class names.
   */
  private readonly entityClasses = new Map<string, EntityClass<Record<string, unknown>>>();

  constructor(
    private readonly orm: MikroORM,
    @Inject(CATALOG_OPTIONS) private readonly options: CatalogModuleOptions,
    @Inject(CATALOG_OVERLAY_STORE)
    private readonly overlayStore: CatalogOverlayStore,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    this.overlay = await this.overlayStore.load();
    this.rebuild();
    const { types, properties, relations, enrichedTypes } = this.getSnapshot().stats;
    this.logger.log(
      `Catalog built: ${types} object types, ${properties} properties, ${relations} relations (${enrichedTypes} enriched)`,
    );
  }

  getSnapshot(): CatalogSnapshot {
    if (!this.snapshot) this.rebuild();
    // rebuild() always assigns, so this is total.
    return this.snapshot as CatalogSnapshot;
  }

  getType(name: string): CatalogObjectTypeDef | undefined {
    return this.getSnapshot().types.find((t) => t.name.toLowerCase() === name.toLowerCase());
  }

  /**
   * The entity constructor behind a catalogued type. Only types that passed
   * `shouldInclude` are here, so an excluded entity cannot be read through the
   * generic object endpoint by guessing its name.
   */
  getEntityClass(name: string): EntityClass<Record<string, unknown>> | undefined {
    if (!this.snapshot) this.rebuild();
    return this.entityClasses.get(name);
  }

  getGraph(): CatalogGraph {
    const snapshot = this.getSnapshot();
    const known = new Set(snapshot.types.map((t) => t.name));
    const nodes = snapshot.types.map((t) => ({
      id: t.name,
      label: t.displayName,
      group: t.group,
      icon: t.icon,
      propertyCount: t.properties.length,
      relationCount: t.relations.length,
    }));

    // Both ends of a relation are declared, so every link shows up twice. Keep
    // one edge per unordered pair per name so the graph does not double up.
    const seen = new Set<string>();
    const edges: CatalogGraph['edges'] = [];
    for (const type of snapshot.types) {
      for (const relation of type.relations) {
        if (!known.has(relation.targetType)) continue;
        const pair = [type.name, relation.targetType].sort().join('::');
        const key = `${pair}::${relation.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          id: `${type.name}.${relation.name}`,
          source: type.name,
          target: relation.targetType,
          label: relation.displayName,
          kind: relation.kind,
        });
      }
    }
    return { nodes, edges };
  }

  /** Tier-0 edit on a type. Never touches the database. */
  async patchType(
    typeName: string,
    patch: Partial<CatalogOverlay['types'][string]>,
  ): Promise<CatalogObjectTypeDef | undefined> {
    const type = this.getType(typeName);
    if (!type) return undefined;
    const current = this.overlay.types[type.name] ?? {};
    // `properties` is patched through patchProperty; a type patch must not
    // clobber it.
    const { properties: _ignored, ...rest } = patch;
    this.overlay.types[type.name] = { ...current, ...rest };
    await this.persist();
    emitCatalog('type.curated', {
      typeName: type.name,
      changed: Object.keys(rest),
    });
    return this.getType(type.name);
  }

  /** Tier-0 edit on a property. Never touches the database. */
  async patchProperty(
    typeName: string,
    propertyName: string,
    patch: NonNullable<CatalogOverlay['types'][string]['properties']>[string],
  ): Promise<CatalogObjectTypeDef | undefined> {
    const type = this.getType(typeName);
    if (!type) return undefined;
    const known =
      type.properties.some((p) => p.name === propertyName) ||
      type.relations.some((r) => r.name === propertyName);
    if (!known) return undefined;

    const currentType = this.overlay.types[type.name] ?? {};
    const currentProps = currentType.properties ?? {};
    this.overlay.types[type.name] = {
      ...currentType,
      properties: {
        ...currentProps,
        [propertyName]: { ...currentProps[propertyName], ...patch },
      },
    };
    await this.persist();
    emitCatalog('type.curated', {
      typeName: type.name,
      property: propertyName,
      changed: Object.keys(patch),
    });
    return this.getType(type.name);
  }

  async resetOverlay(): Promise<void> {
    this.overlay = { types: {} };
    await this.persist();
  }

  private async persist(): Promise<void> {
    await this.overlayStore.save(this.overlay);
    this.rebuild();
  }

  private rebuild(): void {
    // `getAll()` returns a Map, not a plain object. Reaching for Object.values
    // here yields an empty array and a catalog that silently contains nothing.
    const all = this.orm.getMetadata().getAll();
    const types: CatalogObjectTypeDef[] = [];

    this.entityClasses.clear();
    for (const meta of all.values()) {
      if (!this.shouldInclude(meta)) continue;
      this.entityClasses.set(meta.className, meta.class);
      types.push(this.buildType(meta));
    }

    types.sort(
      (a, b) => a.group.localeCompare(b.group) || a.displayName.localeCompare(b.displayName),
    );

    this.version += 1;
    this.snapshot = {
      version: this.version,
      generatedAt: new Date().toISOString(),
      stats: {
        types: types.length,
        properties: types.reduce((n, t) => n + t.properties.length, 0),
        relations: types.reduce((n, t) => n + t.relations.length, 0),
        enrichedTypes: types.filter((t) => t.enriched).length,
      },
      types,
    };
  }

  private shouldInclude(meta: EntityMetadata): boolean {
    if (meta.abstract || meta.pivotTable || meta.virtual) return false;
    if (!meta.className || !meta.tableName) return false;
    const { include, exclude } = this.options;
    if (include && include.length > 0 && !include.includes(meta.className)) {
      return false;
    }
    if (exclude?.includes(meta.className)) return false;
    return true;
  }

  private buildType(meta: EntityMetadata): CatalogObjectTypeDef {
    const entityClass = meta.class;
    const declared = readTypeOptions(entityClass);
    const declaredProps = readPropertyOptions(entityClass);
    const overlay = this.overlay.types[meta.className] ?? {};
    const overlayProps = overlay.properties ?? {};

    const properties: CatalogPropertyDef[] = [];
    const relations: CatalogRelationDef[] = [];

    meta.props.forEach((prop, index) => {
      // Persisted-only view: `persist: false` marks derived/virtual fields that
      // have no column to read, and embedded roots duplicate their children.
      if (prop.persist === false && prop.kind === 'scalar') return;
      if (prop.kind === 'embedded') return;

      const fromDecorator = declaredProps[prop.name];
      const fromOverlay = overlayProps[prop.name];
      const displayName =
        fromOverlay?.displayName ?? fromDecorator?.displayName ?? humanize(prop.name);
      const description = fromOverlay?.description ?? fromDecorator?.description;
      const hidden = fromOverlay?.hidden ?? fromDecorator?.hidden ?? false;
      const order = fromOverlay?.order ?? fromDecorator?.order ?? index;

      if (isRelationKind(prop.kind)) {
        relations.push({
          name: prop.name,
          displayName,
          description,
          kind: prop.kind,
          targetType: prop.targetMeta?.className ?? String(prop.type),
          localKey: prop.fieldNames?.[0],
          nullable: Boolean(prop.nullable),
          hidden,
          order,
        });
        return;
      }

      properties.push({
        name: prop.name,
        displayName,
        description,
        type: toScalarType(prop),
        columnName: prop.fieldNames?.[0] ?? prop.name,
        nullable: Boolean(prop.nullable),
        primary: Boolean(prop.primary),
        hidden,
        order,
        classification: fromOverlay?.classification ?? fromDecorator?.classification,
        unit: fromOverlay?.unit ?? fromDecorator?.unit,
        enriched: Boolean(fromDecorator || fromOverlay),
      });
    });

    properties.sort((a, b) => a.order - b.order);
    relations.sort((a, b) => a.order - b.order);

    const displayName = overlay.displayName ?? declared.displayName ?? humanize(meta.className);

    return {
      name: meta.className,
      displayName,
      pluralDisplayName:
        overlay.pluralDisplayName ?? declared.pluralDisplayName ?? pluralize(displayName),
      description: overlay.description ?? declared.description,
      tableName: meta.tableName,
      icon: overlay.icon ?? declared.icon,
      group: overlay.group ?? declared.group ?? this.options.defaultGroup ?? 'Ungrouped',
      titleProperty: overlay.titleProperty ?? declared.titleProperty,
      primaryKey: meta.primaryKeys ?? [],
      enriched:
        Object.keys(declared).length > 0 ||
        Object.keys(overlay).length > 0 ||
        properties.some((p) => p.enriched),
      properties,
      relations,
    };
  }
}
