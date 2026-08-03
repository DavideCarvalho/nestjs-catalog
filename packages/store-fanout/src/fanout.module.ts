import { CATALOG_STORE } from '@dudousxd/nestjs-catalog';
import { type DynamicModule, Module } from '@nestjs/common';
import {
  FanoutCatalogStore,
  type FanoutFollower,
  type FanoutPrimary,
  asWriteStore,
} from './fanout.store';
import { type CatalogFanoutJournal, FileFanoutJournal } from './journal';
import { CatalogFanoutMigration } from './migration';
import {
  CATALOG_FANOUT_FOLLOWERS,
  CATALOG_FANOUT_JOURNAL,
  CATALOG_FANOUT_OPTIONS,
  CATALOG_FANOUT_PRIMARY,
  type CatalogFanoutStoreModuleOptions,
  DEFAULT_FOLLOWER_STRICTNESS,
  DEFAULT_JOURNAL_PATH,
} from './options';

/**
 * Binds `CATALOG_STORE` to a fan-out over stores other packages provide.
 *
 * This module depends on no adapter. It is handed injection tokens and composes
 * whatever they resolve to, so a MySQL primary with a ClickHouse follower, a
 * DuckDB primary with two followers, and any combination that has not been
 * written yet all wire up the same way. That is not architectural politeness:
 * the point of the exercise is to move between engines, and a fan-out that had
 * to be updated to know about the engine you are moving to would have to be
 * updated at exactly the moment you least want to be changing infrastructure.
 *
 * ```ts
 * CatalogFanoutStoreModule.forRoot({
 *   imports: [
 *     CatalogMikroOrmStoreModule.forRoot({ contextName: "catalog" }),
 *     CatalogClickHouseStoreModule.forRoot({ url: process.env.CLICKHOUSE_URL }),
 *   ],
 *   primary: { name: "mysql", store: MySqlWarehouseStore },
 *   followers: [{ name: "clickhouse", store: ClickHouseWarehouseStore }],
 * })
 * ```
 *
 * **Import the adapter modules through this module's `imports`, not into your
 * `AppModule`.** Each of them exports `CATALOG_STORE` bound to itself. Side by
 * side in one injector, that token ends up bound to whichever module was
 * registered last, everything that injects it bypasses the fan-out, and there is
 * no error anywhere — loads go to one store and the other silently stops
 * receiving them, which is the exact failure this package exists to make
 * impossible. Imported here, the adapters' exports stay inside this module,
 * where the local `CATALOG_STORE` provider shadows them, and only the fan-out's
 * is re-exported.
 */
@Module({})
export class CatalogFanoutStoreModule {
  static forRoot(options: CatalogFanoutStoreModuleOptions): DynamicModule {
    const followerOptions = options.followers ?? [];
    assertNamesAreUsable(options);

    return {
      module: CatalogFanoutStoreModule,
      imports: options.imports ?? [],
      providers: [
        ...(options.providers ?? []),
        { provide: CATALOG_FANOUT_OPTIONS, useValue: options },
        {
          provide: CATALOG_FANOUT_JOURNAL,
          useFactory: (): CatalogFanoutJournal =>
            options.journal ?? new FileFanoutJournal(options.journalPath ?? DEFAULT_JOURNAL_PATH),
        },
        {
          // Resolved through a factory rather than injected into the store
          // directly, so the "is this actually a writable store" check happens
          // once, at boot, with the name the operator chose in the message.
          // Discovering that a token was misbound in the middle of a load, as
          // `store.write is not a function`, would be a much worse day.
          provide: CATALOG_FANOUT_PRIMARY,
          useFactory: (store: unknown): FanoutPrimary => ({
            name: options.primary.name,
            store: asWriteStore(options.primary.name, store),
          }),
          inject: [options.primary.store],
        },
        {
          provide: CATALOG_FANOUT_FOLLOWERS,
          useFactory: (...stores: unknown[]): FanoutFollower[] =>
            followerOptions.map((follower, index) => ({
              name: follower.name,
              store: asWriteStore(follower.name, stores[index]),
              strictness: follower.strictness ?? DEFAULT_FOLLOWER_STRICTNESS,
            })),
          inject: followerOptions.map((follower) => follower.store),
        },
        FanoutCatalogStore,
        CatalogFanoutMigration,
        { provide: CATALOG_STORE, useExisting: FanoutCatalogStore },
      ],
      exports: [
        CATALOG_STORE,
        FanoutCatalogStore,
        // Exported so a host can publish its own endpoints for status, compare
        // and replay. This package ships no controller on purpose: a route that
        // can rewrite a follower's copy of a dataset is not something a library
        // should mount by default, and the shape of the surface — who may call
        // it, under which prefix, behind which guard — is a decision only the
        // host can make.
        CatalogFanoutMigration,
        CATALOG_FANOUT_JOURNAL,
        CATALOG_FANOUT_PRIMARY,
        CATALOG_FANOUT_FOLLOWERS,
      ],
    };
  }
}

/**
 * Refuse a configuration whose names cannot do their job.
 *
 * The names are how a follower is referred to in the journal, in a replay, and
 * in every comparison an operator reads. Two stores sharing one name means the
 * journal records one store's debt against the other; a follower sharing the
 * primary's name means a replay cannot say which one it is repairing. Both fail
 * silently and both are trivial to prevent here.
 */
function assertNamesAreUsable(options: CatalogFanoutStoreModuleOptions): void {
  const names = [
    options.primary.name,
    ...(options.followers ?? []).map((follower) => follower.name),
  ];
  for (const name of names) {
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new Error(
        "Every store in a catalog fan-out needs a name. The name is what the journal records a follower's missed loads against, so an unnamed store is one whose failures cannot be attributed.",
      );
    }
  }
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) {
      throw new Error(
        `Two stores in this fan-out are both called "${name}". The name is the key everything else uses — the journal, replay, the comparison output — so a duplicate would record one store's debt against the other.`,
      );
    }
    seen.add(name);
  }
}
