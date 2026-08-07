/**
 * One environment's store set, built from one connection.
 *
 * The library already had the mechanism for pointing a store at a named
 * connection — `CatalogMikroOrmStoreModule.forRoot({ contextName })` and the
 * two tokens in `context.ts`. An environment is that, plus the observation that
 * there is now more than one of them at a time in the same process. This file
 * does not invent a second mechanism; it builds the same services against a
 * connection whose `dbName` is the environment's own database, and holds them
 * together so a caller can ask for "the dev catalog" as one thing.
 *
 * Built imperatively rather than as N Nest modules, and that is a deliberate
 * choice worth explaining. The store's services are all bound to the same
 * injection tokens — `CATALOG_STORE`, `CATALOG_PIPELINE_STORE`,
 * `CatalogRegistry` — so N copies of the module in one injector would be N
 * providers fighting over the same three tokens, and which one a given
 * consumer got would depend on Nest's module resolution order. That is exactly
 * the kind of isolation-by-luck this whole feature exists to remove. Every one
 * of these classes takes its EntityManager as a plain constructor argument, so
 * constructing them by hand is both possible and completely unambiguous: the
 * connection is visible at the call site.
 */

import type { CatalogEnvironment, CatalogEnvironmentId } from '@dudousxd/nestjs-catalog';
import { UnknownEnvironmentError } from '@dudousxd/nestjs-catalog';
import type { MikroORM } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/sql';
import { Logger } from '@nestjs/common';
import { MySqlCatalogTraceStore } from './audit-recorder.service';
import { type CatalogSqlDialect, dialectForPlatform } from './dialect';
import type { PromotionTarget } from './environment.promotion';
import { MySqlPipelineStore } from './pipeline.store';
import { ensureCatalogSchema } from './schema';
import { StoredCatalogRegistry } from './stored-registry.service';
import { MikroOrmWarehouseStore } from './warehouse.store';
import { MySqlWorkspaceStore } from './workspace.store';

/**
 * Everything the catalog can do, for exactly one environment.
 *
 * `implements PromotionTarget` is a claim checked here rather than at a call
 * site, because in this repository there is no call site: `applyPromotion` is
 * exported for hosts, so nothing else would notice the day a store on this
 * class is renamed and a promotion stops compiling only in somebody else's
 * build.
 */
export class CatalogEnvironmentBundle implements PromotionTarget {
  readonly registry: StoredCatalogRegistry;
  readonly store: MikroOrmWarehouseStore;
  readonly pipeline: MySqlPipelineStore;
  readonly workspace: MySqlWorkspaceStore;
  readonly traces: MySqlCatalogTraceStore;

  private constructor(
    readonly environment: CatalogEnvironment,
    readonly orm: MikroORM,
    readonly em: EntityManager,
    dialect: CatalogSqlDialect,
  ) {
    // `autoSchema: false` because `prepare()` below runs `ensureCatalogSchema`
    // itself, in a place where the environment it is about to touch is named in
    // the log line. Leaving it to the registry's own `onModuleInit` would mean
    // relying on Nest to call a lifecycle hook on an object Nest did not
    // construct — which it does not, so the schema would silently never be
    // applied and the first read would fail on a missing table.
    this.registry = new StoredCatalogRegistry(em, orm, { autoSchema: false });
    // The base class with the environment's own dialect, rather than one of the
    // two named subclasses. There is no injector here to pick a provider, and
    // the dialect is derived from the connection this environment actually
    // opened — so an environment cannot be served DDL for the wrong engine, and
    // two environments on two engines is expressible rather than merely not
    // forbidden.
    this.store = new MikroOrmWarehouseStore(em, dialect);
    this.pipeline = new MySqlPipelineStore(em);
    this.workspace = new MySqlWorkspaceStore(em);
    this.traces = new MySqlCatalogTraceStore(em);
  }

  /**
   * Create the environment's database if it is not there, bring its tables in
   * line, and load its model.
   *
   * `ensureDatabase` before anything else, because an environment is a database
   * and a deployment that adds `staging` to its configuration should get one
   * rather than a connection error naming a schema nobody has been told to
   * create by hand.
   */
  static async prepare(
    environment: CatalogEnvironment,
    orm: MikroORM,
  ): Promise<CatalogEnvironmentBundle> {
    const logger = new Logger('CatalogEnvironment');
    const em = orm.em;
    if (!isSqlEntityManager(em)) {
      throw new Error(
        `The ORM for environment "${environment.id}" did not produce a SQL EntityManager. This store speaks SQL (MySQL or PostgreSQL), and continuing would mean discovering that on the first query rather than at boot.`,
      );
    }

    // Asked of the connection rather than configured beside it. An environment
    // is a database, the ORM opened it, and the ORM is therefore the only thing
    // that cannot be wrong about which engine is on the other end.
    const dialect = dialectForPlatform(orm);

    // Still a database and still one per environment, on both engines. Postgres
    // could put each environment in a schema on one connection and deliberately
    // does not — see the note on `CatalogEnvironment.databaseName` for the
    // argument, which is that isolation has to stay physical rather than become
    // session state on a pooled connection.
    await orm.schema.ensureDatabase();
    const bundle = new CatalogEnvironmentBundle(environment, orm, em, dialect);
    await ensureCatalogSchema(orm, dialect);
    await bundle.registry.reload();
    logger.log(
      `Environment "${environment.id}" ready on ${dialect.name} database ${environment.databaseName} (${bundle.registry.getSnapshot().stats.types} object types).`,
    );
    return bundle;
  }

  async close(): Promise<void> {
    await this.orm.close(true);
  }
}

/**
 * A SQL EntityManager, checked rather than asserted.
 *
 * `MikroORM.em` is typed as the base `EntityManager` from core, and every store
 * in this package wants the MySQL driver's one. The difference is real —
 * `getConnection().execute` and `qb()` only exist on the SQL flavour — so this
 * asks for the two methods the stores actually call instead of casting and
 * finding out at the first raw query.
 */
function isSqlEntityManager(em: unknown): em is EntityManager {
  if (!em || typeof em !== 'object') return false;
  return (
    typeof Reflect.get(em, 'getConnection') === 'function' &&
    typeof Reflect.get(em, 'fork') === 'function'
  );
}

/**
 * Every environment this process runs, and the only way to get one.
 *
 * `get` throws for an unknown id rather than returning undefined. A caller that
 * received undefined would have to decide what to do about it, and the tempting
 * decision — fall back to the one environment it knows — is the failure mode
 * the whole design is built to make impossible. There is no lookup here that
 * can quietly produce production.
 */
export class CatalogEnvironmentSet {
  private readonly byId = new Map<CatalogEnvironmentId, CatalogEnvironmentBundle>();

  constructor(bundles: readonly CatalogEnvironmentBundle[]) {
    for (const bundle of bundles) {
      if (this.byId.has(bundle.environment.id)) {
        throw new Error(
          `Environment "${bundle.environment.id}" was configured twice. Two bundles under one id means half the process talks to one database and half to the other, and nothing reports it.`,
        );
      }
      this.byId.set(bundle.environment.id, bundle);
    }
    if (this.byId.size === 0) {
      throw new Error(
        'No environments were configured. A catalog with no environment has nowhere to put anything; configure at least one.',
      );
    }
    assertDistinctDatabases(bundles);
  }

  list(): CatalogEnvironment[] {
    return [...this.byId.values()]
      .map((bundle) => bundle.environment)
      .sort((a, b) => a.rank - b.rank);
  }

  ids(): CatalogEnvironmentId[] {
    return this.list().map((environment) => environment.id);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  get(id: string): CatalogEnvironmentBundle {
    const bundle = this.byId.get(id);
    if (!bundle) throw new UnknownEnvironmentError(id, this.ids());
    return bundle;
  }

  all(): CatalogEnvironmentBundle[] {
    return this.list().map((environment) => this.get(environment.id));
  }

  async close(): Promise<void> {
    await Promise.all(this.all().map((bundle) => bundle.close()));
  }
}

/**
 * Two environments pointed at one database is the incident, restated.
 *
 * It is the same shape as two durable engines on one Redis keyspace: everything
 * connects, every query succeeds, and the only symptom is that one
 * environment's writes turn up in the other's reads. Since a configuration
 * mistake here is a single character in an env var, it is checked at boot,
 * loudly, before anything has written anything.
 */
function assertDistinctDatabases(bundles: readonly CatalogEnvironmentBundle[]): void {
  const seen = new Map<string, CatalogEnvironmentId>();
  for (const bundle of bundles) {
    const database = bundle.environment.databaseName;
    const owner = seen.get(database);
    if (owner) {
      throw new Error(
        `Environments "${owner}" and "${bundle.environment.id}" are both configured on database "${database}". They would share every table, which is not isolation with a bug in it — it is no isolation at all, and it produces no error at any point afterwards.`,
      );
    }
    seen.set(database, bundle.environment.id);
  }
}
