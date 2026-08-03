import { Entity, Index, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

/**
 * One load of one object type.
 *
 * Append-only: a load never overwrites the previous one, it writes rows tagged
 * with a new snapshot id and then commits. Two things fall out of that which
 * are hard to get any other way — a crash mid-load is invisible rather than a
 * table with half the rows, and a bad load is undone by committing the previous
 * snapshot instead of by restoring a backup.
 */
@Entity({ tableName: 'catalog_snapshot' })
@Index({ properties: ['typeName', 'createdAt'] })
export class SnapshotRow {
  /** `<type>:<snapshotId>`. */
  @PrimaryKey({ length: 300 })
  id!: string;

  @Property({ length: 128 })
  typeName!: string;

  /**
   * Supplied by the publisher, not generated here. Callers pass something they
   * already have that identifies the load — for FLIP's ingestion, the durable
   * run id — which makes the write idempotent under retry for free.
   */
  @Property({ length: 128 })
  snapshotId!: string;

  /** Which application wrote it. Not nullable: a load without an author is one nobody can be asked about. */
  @Property({ length: 128 })
  principalId!: string;

  @Property()
  rowCount = 0;

  /** Until this flips, readers do not see the snapshot. */
  @Property()
  committed = false;

  @Property({ type: 'json', nullable: true })
  labels?: Record<string, string>;

  @Property({ onCreate: () => new Date() })
  createdAt!: Date;

  @Property({ nullable: true })
  committedAt?: Date;
}

/**
 * A calling application.
 *
 * `keyHash` is the fallback path, for a caller that lives outside the identity
 * provider. The intended path is OIDC client credentials: the token's `azp` is
 * the principal id, and rotation, expiry and revocation are the IdP's problem
 * rather than a column here. A row with no `keyHash` is exactly that — an app
 * that authenticates with a token and is only described here.
 */
@Entity({ tableName: 'catalog_principal' })
export class PrincipalRow {
  /** Matches the OIDC client id when there is one, e.g. `flip-nestjs`. */
  @PrimaryKey({ length: 128 })
  id!: string;

  @Property({ length: 255 })
  displayName!: string;

  /** SHA-256 of the static key. Null when this principal authenticates by token. */
  @Property({ length: 64, nullable: true })
  keyHash?: string;

  @Property({ type: 'json' })
  scopes: string[] = [];

  /** Types this principal may load. No default: an unlisted type is a denied write. */
  @Property({ type: 'json' })
  writeTypes: string[] = [];

  /** Null means every type — a safe default for read, unlike write. */
  @Property({ type: 'json', nullable: true })
  readTypes?: string[];

  @Property({ type: 'json' })
  classifications: string[] = [];

  @Property()
  active = true;

  @Property({ onCreate: () => new Date() })
  createdAt!: Date;

  @Property({ nullable: true })
  lastSeenAt?: Date;
}
