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
