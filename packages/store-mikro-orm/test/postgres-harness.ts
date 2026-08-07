// First, and a side-effect import on purpose — the same reason `mysql-harness.ts`
// opens this way. MikroORM's decorators read the property types out of
// `design:type`, which the compiler only writes when `Reflect.metadata` exists at
// the moment the entity module is evaluated, and SWC's helper silently no-ops
// when it does not.
import 'reflect-metadata';
import type { CatalogObjectTypeDef } from '@dudousxd/nestjs-catalog';
// By package NAME, mapped to source in `tsconfig.spec.base.json` — see the long
// note at the top of `mysql-harness.ts` for why this is not a relative path and
// not a workspace link.
import {
  ObjectTypeRow,
  POSTGRES_DIALECT,
  PostgresWarehouseStore,
  PropertyRow,
  StoredCatalogRegistry,
  catalogStoreEntities,
  ensureCatalogSchema,
  tableFor,
  toPhysicalName,
} from '@dudousxd/nestjs-catalog-store-mikro-orm';
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { MikroORM } from '@mikro-orm/postgresql';
import type { EntityManager } from '@mikro-orm/sql';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * Booting a real PostgreSQL catalog, for the `*.db.spec.ts` suites.
 *
 * The sibling of `mysql-harness.ts`, deliberately shaped the same way and
 * deliberately *not* factored into a common one. The two differ in exactly the
 * places the engines differ — how a database is created out of band, which
 * driver package the ORM comes from — and a shared harness would have to branch
 * on the engine in each of them, which is a conditional in the fixture rather
 * than in the thing under test. What must not be duplicated is the *contract*,
 * and it is not: both harnesses feed the one suite in
 * `test/catalog-store-contract.ts`.
 *
 * Nothing here is a fake, for the same reason nothing in the MySQL harness is:
 * every property this adapter promises is a property of the SQL it emits and of
 * what the engine does with it, and a fake store passes all of them by
 * construction.
 */

/**
 * Pinned, for the reason the MySQL image is pinned.
 *
 * The guarantees this dialect makes are guarantees about one engine's behaviour
 * — that `CREATE OR REPLACE VIEW` refuses a column inserted mid-list (which is
 * why the store drops and recreates instead), that DDL inside a transaction is
 * atomic (which is why doing so still honours `atomicCutover`), that
 * `SET LOCAL statement_timeout` leaves no residue on the pooled connection. A
 * suite that silently followed a major version would turn "this engine changed"
 * into "this adapter broke".
 */
export const POSTGRES_IMAGE = 'postgres:16-alpine';

export async function startPostgres(): Promise<StartedPostgreSqlContainer> {
  return new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase('catalog')
    .withUsername('catalog')
    .withPassword('catalog')
    .start();
}

export interface PostgresCatalogDatabase {
  readonly dbName: string;
  readonly orm: MikroORM;
  readonly em: EntityManager;
  readonly store: PostgresWarehouseStore;
  readonly registry: StoredCatalogRegistry;
  /** Register the type in `catalog_object_type`, then shape `obj_<type>`. */
  publish(type: CatalogObjectTypeDef): Promise<void>;
  /** Raw SQL, for the cases that have to break something on purpose. */
  execute(sql: string): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * Open one catalog database on a running server.
 *
 * `dbName` is a parameter for the same reason it is on the MySQL side: a suite
 * that wants two independent catalogs gets two databases rather than two prefixes.
 *
 * **A database and not a schema, and that is the environment model rather than a
 * convenience.** Postgres could put each catalog in its own schema on one
 * connection, which MySQL cannot do — and `catalog.environment.ts` still says
 * one database per environment. The argument is in that file: isolation by
 * `search_path` is session state on a pooled connection, which is the failure
 * `query.ts` already documents having been bitten by, and isolation by
 * schema-qualifying every identifier is isolation by application care, which is
 * exactly what the environment model exists to refuse. The fixture mirrors the
 * deployment.
 */
export async function openPostgresCatalogDatabase(
  container: StartedPostgreSqlContainer,
  dbName: string,
  /** Every statement this catalog issues, as MikroORM logs it. See the MySQL harness. */
  onQuery?: (sql: string) => void,
): Promise<PostgresCatalogDatabase> {
  // Out of band, through the container's own client: there is no database to
  // connect *to* yet. `CREATE DATABASE` cannot run inside a transaction block on
  // Postgres, and `psql -c` runs it outside one, which is why this is a shell
  // call rather than a statement on a connection of ours.
  //
  // `IF NOT EXISTS` is not available for `CREATE DATABASE`, so a duplicate is
  // tolerated by inspecting the message rather than by asking first — asking is
  // a race, and the only thing the answer would change is whether we skip.
  const created = await container.exec([
    'psql',
    '-U',
    container.getUsername(),
    '-d',
    container.getDatabase(),
    '-c',
    `CREATE DATABASE "${dbName}"`,
  ]);
  if (created.exitCode !== 0 && !created.output.includes('already exists')) {
    throw new Error(`Could not create ${dbName}: ${created.output}`);
  }

  const orm = await MikroORM.init({
    host: container.getHost(),
    port: container.getPort(),
    user: container.getUsername(),
    password: container.getPassword(),
    dbName,
    entities: [...catalogStoreEntities],
    // Required for the same reason the MySQL harness requires it: MikroORM 7
    // ships the base `MetadataProvider`, which infers nothing, and this
    // package's entities carry their types only in `design:type`.
    metadataProvider: ReflectMetadataProvider,
    // Both halves, exactly as on MySQL. The `date` scalar maps to a zoneless
    // `TIMESTAMP(3)` here — chosen to match `DATETIME` rather than
    // `TIMESTAMPTZ`, see `dialect.ts` — so the same reasoning applies: without
    // these the same load round-trips to a different instant on a laptop and in
    // CI, and the contract's scalar case would fail for a reason that has
    // nothing to do with the adapter.
    forceUtcTimezone: true,
    timezone: '+00:00',
    ...(onQuery === undefined
      ? { debug: false }
      : {
          debug: ['query'],
          logger: (message: string) => {
            onQuery(message);
          },
        }),
  });

  // The dialect is passed rather than inferred, because a fixture asserting
  // Postgres behaviour must fail loudly if it is somehow handed MySQL DDL rather
  // than quietly proving something about the wrong engine.
  await ensureCatalogSchema(orm, POSTGRES_DIALECT);

  const em = orm.em;
  const store = new PostgresWarehouseStore(em);
  const registry = new StoredCatalogRegistry(em, orm, { autoSchema: false });
  await registry.reload();

  return {
    dbName,
    orm,
    em,
    store,
    registry,
    async publish(type: CatalogObjectTypeDef): Promise<void> {
      await publishType(em, type);
      await registry.reload();
      await store.ensureType(type);
    },
    async execute(sql: string): Promise<unknown> {
      return orm.em.getConnection().execute(sql);
    },
    async close(): Promise<void> {
      await orm.close(true);
    },
  };
}

/**
 * Write the rows a publisher's `upsertType` writes.
 *
 * A copy of the MySQL harness's function, and the duplication is deliberate
 * rather than overlooked: it is fixture setup, it is engine-independent, and
 * sharing it would mean one harness importing the other — which makes the
 * Postgres suite fail whenever somebody breaks the MySQL fixture, for reasons
 * that have nothing to do with Postgres. The thing that must not be duplicated
 * is the contract, and it is not.
 */
async function publishType(em: EntityManager, type: CatalogObjectTypeDef): Promise<void> {
  const fork = em.fork();
  const existing = await fork.findOne(
    ObjectTypeRow,
    { name: type.name },
    { populate: ['properties'] },
  );
  const row =
    existing ??
    fork.create(ObjectTypeRow, {
      name: type.name,
      ownerPrincipalId: 'contract',
      displayName: type.displayName,
      pluralDisplayName: type.pluralDisplayName,
      group: type.group,
      primaryKey: type.primaryKey,
      physicalTable: tableFor(type.name),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  row.displayName = type.displayName;
  row.pluralDisplayName = type.pluralDisplayName;
  row.description = type.description;
  row.group = type.group;
  row.primaryKey = type.primaryKey;

  const known = new Map(
    (existing ? row.properties.getItems() : []).map((each) => [each.name, each]),
  );
  type.properties.forEach((property, index) => {
    const target =
      known.get(property.name) ??
      fork.create(PropertyRow, {
        id: `${type.name}.${property.name}`,
        objectType: row,
        name: property.name,
        displayName: property.displayName,
        type: property.type,
        sourceColumn: property.columnName,
        physicalColumn: toPhysicalName(property.name),
        nullable: property.nullable,
        primary: property.primary,
        hidden: property.hidden,
        position: property.order ?? index,
      });
    target.type = property.type;
    target.nullable = property.nullable;
    target.primary = property.primary;
    target.hidden = property.hidden;
    target.position = property.order ?? index;
  });

  await fork.flush();
}
