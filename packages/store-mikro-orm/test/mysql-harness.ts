// First, and a side-effect import on purpose. MikroORM's decorators read the
// property types out of `design:type`, which the compiler only writes when
// `Reflect.metadata` exists at the moment the entity module is evaluated — and
// SWC's helper silently no-ops when it does not. Loaded anywhere later, the
// entities discover as `Please provide either 'type' or 'entity' attribute`,
// which reads as a bug in the entity rather than as a missing polyfill.
import 'reflect-metadata';
import type { CatalogObjectTypeDef } from '@dudousxd/nestjs-catalog';
// By package NAME, including for the package this file sits inside — and that is a deliberate
// choice between three, because it decides what a `*.db.spec.ts` is actually testing.
//
// A relative `../src/index` would resolve, always, with no configuration. But the fan-out suite
// imports this harness across a package boundary, so a relative path would have store-fanout's
// specs reaching into a sibling's source through a route no consumer of either package can take,
// and the barrel — the thing every consumer does go through — would stop being exercised.
//
// A workspace link (a self-referencing `@dudousxd/nestjs-catalog-store-mikro-orm` dependency) would
// resolve by name, but through `main`/`types` to `dist/`. That is the build artefact: the suite
// would test whatever was last compiled while vitest, which aliases these names to source, ran
// something else. Two programs, one report.
//
// So: by name, mapped to source in `tsconfig.spec.base.json`, which vitest derives its aliases from.
// The name stays the one a consumer writes, the file resolved is the one vitest executes, and there
// is no link to forget — which is what happened here. There was none, so this import resolved to
// nothing, the entities below all inferred as `object`, and thirty-odd cascading errors sat in a
// config that nothing ran.
import {
  MySqlWarehouseStore,
  ObjectTypeRow,
  PropertyRow,
  StoredCatalogRegistry,
  catalogStoreEntities,
  ensureCatalogSchema,
  tableFor,
  toPhysicalName,
} from '@dudousxd/nestjs-catalog-store-mikro-orm';
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import type { EntityManager } from '@mikro-orm/mysql';
import { MikroORM } from '@mikro-orm/mysql';
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';

/**
 * Booting a real MySQL catalog, for the `*.db.spec.ts` suites.
 *
 * Lives beside the adapter it boots rather than in a shared test folder for one
 * unglamorous reason: `@mikro-orm/mysql` is a dependency of *this* package and
 * of nothing above it, so a helper anywhere else in the workspace cannot resolve
 * it. The fan-out suite imports this file across packages, which is what it
 * looks like to want two engines wired the way a deployment wires them.
 *
 * Nothing here is a fake. This runs the same schema management the module runs
 * at boot (`ensureCatalogSchema`), constructs the same store and registry the
 * module constructs, and publishes types by writing the same rows the publish
 * endpoint writes. What it skips is Nest's injector, because the wiring is one
 * line per provider and a test that boots a module is testing the module.
 */

/**
 * Pinned, and not to a floating tag by accident.
 *
 * Every guarantee this adapter makes is a guarantee about what one engine does
 * with the statements it emits — `CREATE OR REPLACE VIEW` taking a metadata lock
 * rather than dropping the name, `INSERT ... SELECT` being allowed to name its
 * own target in a FROM clause. A suite that silently followed a major version
 * would turn "this engine changed" into "this adapter broke".
 */
export const MYSQL_IMAGE = 'mysql:8.0';

export async function startMySql(): Promise<StartedMySqlContainer> {
  return new MySqlContainer(MYSQL_IMAGE)
    .withDatabase('catalog')
    .withUsername('catalog')
    .withUserPassword('catalog')
    .withRootPassword('root')
    .start();
}

export interface CatalogDatabase {
  readonly dbName: string;
  readonly orm: MikroORM;
  readonly em: EntityManager;
  readonly store: MySqlWarehouseStore;
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
 * `dbName` is a parameter because the fan-out suite needs two independent
 * catalogs — a primary and a follower — and two schemas on one server is the
 * cheapest honest way to get them: separate object tables, separate snapshot
 * bookkeeping, separate `catalog_object_type`, and a failure that can be
 * injected into one without touching the other.
 */
export async function openCatalogDatabase(
  container: StartedMySqlContainer,
  dbName: string,
  /**
   * Every statement this catalog issues, as MikroORM logs it.
   *
   * For the suites whose subject is *how many* statements a path emits rather
   * than what it returns — a per-batch cost is invisible to an assertion about
   * the answer, because the answer is right either way. Counting them from the
   * driver's own log is the only version of that question that cannot drift
   * from what actually reached the server.
   *
   * Passing it switches `debug` on, which is itself a cost, so it is off unless
   * a spec asks and no timing is ever taken from a run that passed it.
   */
  onQuery?: (sql: string) => void,
): Promise<CatalogDatabase> {
  // Through the container's own client rather than a connection of ours: there
  // is no database to connect *to* yet, and asking the server to make one is
  // exactly the kind of thing a fixture should do out of band.
  const created = await container.exec([
    'mysql',
    '-h',
    '127.0.0.1',
    '-u',
    'root',
    `-p${container.getRootPassword()}`,
    '-e',
    `CREATE DATABASE IF NOT EXISTS \`${dbName}\`;`,
  ]);
  if (created.exitCode !== 0) {
    throw new Error(`Could not create ${dbName}: ${created.output}`);
  }

  const orm = await MikroORM.init({
    host: container.getHost(),
    port: container.getPort(),
    user: 'root',
    password: container.getRootPassword(),
    dbName,
    entities: [...catalogStoreEntities],
    // Not a default any more, and this package's entities need it. MikroORM 7
    // ships the base `MetadataProvider`, which infers nothing and refuses any
    // `@Property` without an explicit `type`; the entities here are written in
    // the legacy decorator style and carry their types only in
    // `design:type`. Omitting this fails discovery with "Please provide either
    // 'type' or 'entity' attribute in ObjectTypeRow.name", which reads as a
    // broken entity rather than as a missing host setting — so a host mounting
    // this store has to set it too.
    metadataProvider: ReflectMetadataProvider,
    // The `date` scalar maps to `DATETIME`, which stores a wall clock and no
    // zone. Without this the driver writes and reads it in whatever timezone the
    // process happens to be in, so the same load round-trips to a different
    // instant on a laptop and in CI — and the contract's scalar case would fail
    // for a reason that has nothing to do with the adapter. Pinning UTC is what
    // a deployment should do anyway; it is set here rather than assumed because
    // the adapter does not get to choose it.
    forceUtcTimezone: true,
    // Both halves, because they are two different settings. `forceUtcTimezone`
    // governs what MikroORM writes; `timezone` is what the driver uses to turn a
    // `DATETIME` back into a `Date`, and the store's reads go through raw SQL
    // where MikroORM is not in the conversion. With only the first, a load
    // round-trips through the process's own offset and comes back shifted by
    // it — three hours here, none in a UTC container, which is precisely the
    // sort of difference that gets blamed on the data.
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

  await ensureCatalogSchema(orm);

  const em = orm.em;
  const store = new MySqlWarehouseStore(em);
  // `autoSchema: false` because `ensureCatalogSchema` already ran above. The
  // registry would run it again on `onModuleInit`, which is harmless and is also
  // a second thing to go wrong in a fixture.
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
 * Written directly rather than through `PublishService`, which lives in the
 * pipeline package and would drag a module's worth of unrelated wiring into a
 * store test. What matters for the contract is that the model tables end up
 * holding what a publish produces: the store's `read` resolves the served
 * snapshot through `catalog_object_type`, so a type that is absent from it
 * commits cleanly and then reads back empty — which is the failure this exists
 * to keep out of the suite.
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
