import { Collection, type Ref } from '@mikro-orm/core';
import { Entity, ManyToOne, OneToMany, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

/**
 * The model, stored.
 *
 * This is the difference between the catalog service and the library running
 * inside an application. There, object types are *derived* — the ORM already
 * has the entity classes, so the catalog reflects over them. Here there are no
 * entity classes for `Mvr` or `Subwo` and there never will be: their
 * definitions arrived over the wire from the application that owns them, so
 * they are rows like any other data.
 */
/**
 * One link, as it is stored.
 *
 * Deliberately not `CatalogRelationDef`. Two of that interface's fields are
 * answers about the catalog rather than about the link — `targetPublished`,
 * which changes the moment another application publishes or stops publishing,
 * and `enriched`, which is a reading of the other fields — and persisting either
 * would mean storing a conclusion that goes stale in the row. They are computed
 * on read, where they are true.
 *
 * `kind` is a bare `string` for the same reason `PropertyRow.type` is: what
 * comes back out of a column is whatever some earlier version of some publisher
 * put in, so it is narrowed at the boundary rather than trusted at the type
 * level.
 */
export interface StoredRelation {
  /** The property name on the publisher's own entity, e.g. `base`. */
  name: string;
  /** One of the catalog's relation kinds — `m:1`, `1:m`, `1:1`, `m:n`. */
  kind: string;
  /** Class name of the type on the other end, as its publisher calls it. */
  targetType: string;
  displayName: string;
  description?: string;
  /** The column holding the key, on the end that holds it. */
  localKey?: string;
  nullable: boolean;
  hidden: boolean;
  position: number;
  /** Whether this end holds the key. See `CatalogRelationDef.owner`. */
  owner: boolean;
  /** The property at the other end of this same link, when the publisher knows it. */
  inverseName?: string;
}

/**
 * What a publisher sends for one link: structure required, presentation
 * optional.
 *
 * The split is the wire contract. Name, kind and target are the link — a
 * payload without them describes nothing — while a label is something the
 * publisher may not have and the console can supply later.
 */
export type PublishedRelation = Pick<StoredRelation, 'name' | 'kind' | 'targetType'> &
  Partial<Omit<StoredRelation, 'name' | 'kind' | 'targetType'>>;

@Entity({ tableName: 'catalog_object_type' })
export class ObjectTypeRow {
  /** Class name as the publishing application knows it, e.g. `Mvr`. */
  @PrimaryKey({ length: 128 })
  name!: string;

  /**
   * Which principal published this type. A type has exactly one owner: two
   * applications publishing the same name would otherwise silently fight over
   * its shape, and the loser's columns would vanish on the next load.
   */
  @Property({ length: 128 })
  ownerPrincipalId!: string;

  @Property({ length: 255 })
  displayName!: string;

  @Property({ length: 255 })
  pluralDisplayName!: string;

  @Property({ type: 'text', nullable: true })
  description?: string;

  @Property({ length: 32, nullable: true })
  icon?: string;

  @Property({ length: 128 })
  group = 'Ungrouped';

  @Property({ length: 128, nullable: true })
  titleProperty?: string;

  @Property({ type: 'json' })
  primaryKey: string[] = [];

  /** The physical table this type's rows land in, e.g. `obj_mvr`. */
  @Property({ length: 128 })
  physicalTable!: string;

  /**
   * The links this type declares. See {@link StoredRelation}.
   *
   * A column rather than a `catalog_relation` table, and the asymmetry with
   * {@link PropertyRow} is the argument. A property earns a table because it has
   * a *physical* consequence: the warehouse store reads these rows to build and
   * widen the `obj_*` table, so a property is joined to, filtered on and
   * compared against real columns. A relation has none. There are no foreign
   * keys in the warehouse — every published type lands as a flat snapshot — so a
   * link here is pure metadata that drives no DDL, is never queried on its own,
   * and is only ever read as "the links belonging to this type", which is
   * exactly the read {@link ObjectTypeRow} already is.
   *
   * The second reason is one this file has been bitten by before, twice, in the
   * comments beside `ConnectionRow` and `WorkflowRow`: a new entity has to be
   * named in two lists outside this file to be created and managed at all, and
   * being absent from either is invisible until the first read. A column on an
   * entity that is already in both lists cannot go missing, and it moves the
   * schema fingerprint by itself, so an existing deployment actually applies it.
   *
   * Nullable, and optional in TypeScript, because that is what is true: every
   * row written before this column existed holds `NULL`, and a required field
   * would be a promise the database does not keep. It would also force every
   * existing `em.create(ObjectTypeRow, …)` — including the one in the promotion
   * path, which copies types between environments — to name a field it has
   * nothing to say about. Read through {@link relationsOf} rather than directly.
   */
  @Property({ type: 'json', nullable: true })
  relations?: StoredRelation[] = [];

  /**
   * Take the structure a publisher just sent, keep the labels a human wrote.
   *
   * The same rule `PublishService` applies to properties, and it is the whole
   * reason curating in the console is worth doing: the application that owns a
   * type redeploys constantly and re-publishes its whole shape each time, so
   * anything that followed the publisher unconditionally would reset every
   * display name a curator had chosen.
   *
   * Structural fields — kind, target, join column, which end owns it — always
   * follow the publisher, because those are facts about a schema this service
   * cannot see and a stale copy of them is a link that no longer exists. Labels
   * and descriptions are filled in only when nothing is there.
   *
   * A relation the publisher stopped sending is DROPPED, unlike a property.
   * They are not the same case: a column that vanishes from a payload may still
   * hold data in the warehouse, so forgetting it would strand rows nobody could
   * read; a link holds nothing, and keeping one the schema no longer has means
   * the ontology asserts a join that will fail.
   *
   * A method on the row rather than a free function so the merge rule lives
   * beside the column it merges, and so a caller that already has the row needs
   * no second import to write it correctly.
   */
  mergeRelations(published: PublishedRelation[]): void {
    const curated = new Map(relationsOf(this).map((relation) => [relation.name, relation]));

    // A NEW array, never a mutation of the existing one. MikroORM decides a JSON
    // property changed by comparing it against the snapshot taken at load;
    // mutating the array in place can leave the two the same object, and the
    // flush then writes nothing while appearing to have succeeded.
    this.relations = published.map((relation, index) => {
      const existing = curated.get(relation.name);
      const description = existing?.description ?? relation.description;
      return {
        name: relation.name,
        kind: relation.kind,
        targetType: relation.targetType,
        nullable: relation.nullable ?? true,
        owner: relation.owner ?? false,
        displayName: existing?.displayName ?? relation.displayName ?? relation.name,
        hidden: existing?.hidden ?? relation.hidden ?? false,
        position: existing?.position ?? relation.position ?? index,
        // Spread rather than assigned, so an absent value leaves no key behind.
        // `exactOptionalPropertyTypes` forbids the plain assignment, and the
        // rule it is enforcing is the one that matters here: these rows are
        // serialised into a JSON column, and `"localKey": null` sitting in the
        // database reads as a decision somebody made.
        ...(description === undefined ? {} : { description }),
        ...(relation.localKey === undefined ? {} : { localKey: relation.localKey }),
        ...(relation.inverseName === undefined ? {} : { inverseName: relation.inverseName }),
      };
    });
  }

  /**
   * The snapshot readers get. Null until the first load commits — an
   * uncommitted type is visible in the model and empty in the data, which is
   * the honest state rather than a half-loaded table.
   */
  @Property({ length: 128, nullable: true })
  currentSnapshotId?: string;

  @Property({ onCreate: () => new Date() })
  createdAt!: Date;

  @Property({ onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt!: Date;

  @OneToMany(
    () => PropertyRow,
    (p: PropertyRow) => p.objectType,
  )
  properties = new Collection<PropertyRow>(this);
}

/**
 * The links on a row, safely.
 *
 * The field initialiser only runs for rows this process constructs. A row that
 * predates the column is hydrated straight from the database, where the value is
 * `NULL`, and every `.map` and `.sort` over it throws — so the whole catalog
 * fails to load on the first boot after this shipped, which is the boot where
 * nobody is watching for a relations bug.
 */
export function relationsOf(row: ObjectTypeRow): StoredRelation[] {
  return Array.isArray(row.relations) ? row.relations : [];
}

@Entity({ tableName: 'catalog_property' })
export class PropertyRow {
  /** `<type>.<name>`, so a publisher can upsert without reading first. */
  @PrimaryKey({ length: 300 })
  id!: string;

  @ManyToOne(() => ObjectTypeRow, { ref: true, deleteRule: 'cascade' })
  objectType!: Ref<ObjectTypeRow>;

  @Property({ length: 128 })
  name!: string;

  @Property({ length: 255 })
  displayName!: string;

  @Property({ type: 'text', nullable: true })
  description?: string;

  /** One of the catalog's coarse scalar types, not a SQL type. */
  @Property({ length: 32 })
  type!: string;

  /** The column in the publisher's own table. Kept for tracing, not for reads. */
  @Property({ length: 255 })
  sourceColumn!: string;

  /** The column in *our* physical table. */
  @Property({ length: 128 })
  physicalColumn!: string;

  @Property()
  nullable = true;

  @Property()
  primary = false;

  @Property()
  hidden = false;

  @Property()
  position = 0;

  @Property({ length: 64, nullable: true })
  classification?: string;

  @Property({ length: 64, nullable: true })
  unit?: string;
}
