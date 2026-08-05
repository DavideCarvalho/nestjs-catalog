import type { EntityClass, EntityMetadata, EntityProperty } from '@mikro-orm/core';
// Value import, not type-only: Nest resolves this constructor parameter from
// the emitted `design:paramtypes`, which a type-only import erases.
import { MikroORM } from '@mikro-orm/core';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  type CatalogPropertyOptions,
  readPropertyOptions,
  readTypeOptions,
} from './catalog.decorators';
import { type CatalogEventPayloads, curationActor, emitCatalog } from './catalog.events';
import { CATALOG_OPTIONS, type CatalogModuleOptions } from './catalog.options';
import type { CatalogOverlayStore } from './catalog.overlay-store';
import { CATALOG_OVERLAY_STORE } from './catalog.overlay-store.token';
import { CatalogRegistry } from './catalog.registry.base';
import type {
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

/**
 * Which end of the link holds the key.
 *
 * Not simply `prop.owner`, and the difference matters. MikroORM sets that flag
 * while resolving the *pair*, so it is dependable for `1:1` and `m:n` — where
 * either side could plausibly own the key and only the mapping says which — and
 * beside the point for the two kinds that have no choice: a `m:1` is the many
 * end and therefore always holds the column, a `1:m` is the one end and
 * therefore never does. Deriving those two from the kind rather than from a flag
 * also means metadata assembled by hand (an `EntitySchema`, or a test) answers
 * correctly without having to know the flag exists.
 *
 * `mappedBy` is checked first because it is unambiguous wherever it appears: the
 * ORM only ever writes it on the inverse side.
 */
function isOwningSide(prop: EntityProperty, kind: RelationKind): boolean {
  if (prop.mappedBy) return false;
  if (kind === '1:m') return false;
  if (kind === 'm:1') return true;
  return Boolean(prop.owner);
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

  /** Tier-0 edit on a type. Never touches the database. */
  async patchType(
    typeName: string,
    patch: Partial<CatalogOverlay['types'][string]>,
    curatedBy: string,
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
      // Through `curationActor` rather than passed straight in, even though the
      // parameter is required: the callers this class actually has to survive are
      // the ones the compiler never saw. See the note on that function.
      principalId: curationActor(curatedBy),
    });
    return this.getType(type.name);
  }

  /** Tier-0 edit on a property. Never touches the database. */
  async patchProperty(
    typeName: string,
    propertyName: string,
    patch: NonNullable<CatalogOverlay['types'][string]['properties']>[string],
    curatedBy: string,
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
      principalId: curationActor(curatedBy),
    });
    return this.getType(type.name);
  }

  /**
   * Drop every tier-0 edit, and leave a record that it happened.
   *
   * The summary is taken before the overlay is cleared because it is the only
   * record there will ever be: nothing versions an overlay, so the discarded
   * values are gone the instant the store is written. See `overlay.reset` in
   * `catalog.events.ts` for why the payload is a summary and not a copy.
   *
   * Emitted after the write, like the two patches above, so the trail says what
   * happened rather than what was about to.
   *
   * The actor is applied here rather than inside {@link summariseOverlay}, which
   * stays a pure function of the overlay. What was destroyed and who destroyed it
   * are facts from two different places, and folding the principal into the
   * summariser would mean the one function that must be callable with nothing but
   * an old overlay suddenly needing the request as well.
   */
  async resetOverlay(resetBy: string): Promise<void> {
    const discarded = summariseOverlay(this.overlay);
    this.overlay = { types: {} };
    await this.persist();
    emitCatalog('overlay.reset', { ...discarded, principalId: curationActor(resetBy) });
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

    // Two passes, because a relation cannot be described without knowing the
    // whole catalog: whether its target is published is a fact about the
    // catalog, not about the entity being read, and a single pass would answer
    // it differently depending on discovery order.
    this.entityClasses.clear();
    const included: EntityMetadata[] = [];
    for (const meta of all.values()) {
      if (!this.shouldInclude(meta)) continue;
      this.entityClasses.set(meta.className, meta.class);
      included.push(meta);
    }

    const published = new Set(included.map((meta) => meta.className));
    for (const meta of included) types.push(this.buildType(meta, published));

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

  private buildType(meta: EntityMetadata, published: Set<string>): CatalogObjectTypeDef {
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
      const { displayName, description, hidden, order } = resolveFieldPresentation(
        prop.name,
        index,
        fromDecorator,
        fromOverlay,
      );

      if (isRelationKind(prop.kind)) {
        const targetType = prop.targetMeta?.className ?? String(prop.type);
        relations.push({
          name: prop.name,
          displayName,
          description,
          kind: prop.kind,
          targetType,
          localKey: prop.fieldNames?.[0],
          nullable: Boolean(prop.nullable),
          hidden,
          order,
          owner: isOwningSide(prop, prop.kind),
          // Either name identifies the same thing — the property at the other
          // end — and only one of them is ever set, on the side the ORM decided
          // is inverse. Read as one field because callers pairing the two ends
          // do not care which of the two spellings carried it.
          inverseName: prop.mappedBy || prop.inversedBy || undefined,
          targetPublished: published.has(targetType),
          // A relation is enriched on the same terms as a scalar: somebody said
          // something about it. Structure is not enrichment — every relation
          // here was derived, so its existence proves nothing about curation.
          enriched: Boolean(fromDecorator || fromOverlay),
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
        properties.some((p) => p.enriched) ||
        // Relations count too. A type whose only human input is "this link is
        // called Home base" has been worked on, and leaving it out of the tally
        // put it back on the "nobody has named this" list the curator uses to
        // decide what to do next.
        relations.some((r) => r.enriched),
      properties,
      relations,
    };
  }
}

/**
 * What a reset is about to destroy, in the shape the trail keeps it.
 *
 * Here rather than in `catalog.events.ts` because it reads a `CatalogOverlay`,
 * and this is the only registry that has one — the payload type is the contract,
 * this is one producer of it. Pure and taking the overlay as an argument so the
 * order is forced: a caller has to hold the old overlay to call it, and cannot
 * accidentally summarise the empty one it just installed.
 *
 * Everything the payload holds except the actor, stated as an `Omit` of the
 * payload rather than a shape of its own. A hand-written interface here would be
 * a second copy of the contract, free to fall behind the day a field is added —
 * and the failure would be a summary silently missing a key that the type says
 * is required. `principalId` is the caller's to supply because it is a fact about
 * the request, not about the overlay.
 *
 * A type entry counts whatever it holds, including an entry that ended up empty.
 * `buildType` treats a present entry as enrichment on the same terms, and the
 * honest reading of one is "somebody patched this type" — which is exactly what
 * the reset undid.
 */
function summariseOverlay(
  overlay: CatalogOverlay,
): Omit<CatalogEventPayloads['overlay.reset'], 'principalId'> {
  const typeNames = Object.keys(overlay.types);
  const classifications: CatalogEventPayloads['overlay.reset']['classifications'] = [];
  let properties = 0;

  for (const typeName of typeNames) {
    const patched = overlay.types[typeName]?.properties ?? {};
    for (const [property, patch] of Object.entries(patched)) {
      properties += 1;
      const { classification } = patch;
      // Only a classification that was actually set. An entry that merely
      // renamed the column carries the key as `undefined`, and listing it would
      // report a classification lost that nobody had applied.
      if (classification !== undefined) {
        classifications.push({ typeName, property, classification });
      }
    }
  }

  return { typeNames, properties, classifications };
}

/**
 * How one field is presented, resolved across the tiers.
 *
 * Overlay beats decorator beats a derived default, the same precedence the
 * type-level fields use. Split out of `buildType` because it is the one job in
 * that loop which is identical whether the field turns out to be a scalar or a
 * relation — both branches consume exactly this.
 */
function resolveFieldPresentation(
  name: string,
  index: number,
  fromDecorator: CatalogPropertyOptions | undefined,
  fromOverlay: CatalogPropertyOptions | undefined,
): { displayName: string; description?: string; hidden: boolean; order: number } {
  return {
    displayName: fromOverlay?.displayName ?? fromDecorator?.displayName ?? humanize(name),
    description: fromOverlay?.description ?? fromDecorator?.description,
    hidden: fromOverlay?.hidden ?? fromDecorator?.hidden ?? false,
    order: fromOverlay?.order ?? fromDecorator?.order ?? index,
  };
}
