import { CATALOG_WORKSPACE_STORE } from '@dudousxd/nestjs-catalog';
import {
  type DynamicModule,
  type InjectionToken,
  Module,
  type ModuleMetadata,
  type OptionalFactoryDependency,
} from '@nestjs/common';
import { DrizzleCatalogOverlayStore } from './overlay.store';
import { type CatalogDrizzleStoreOptions, DrizzleWorkspaceStore } from './workspace.store';

export const CATALOG_DRIZZLE_STORE_OPTIONS = Symbol('CATALOG_DRIZZLE_STORE_OPTIONS');

export interface CatalogDrizzleStoreAsyncOptions {
  readonly imports?: ModuleMetadata['imports'];
  readonly inject?: Array<InjectionToken | OptionalFactoryDependency>;
  readonly useFactory: (
    ...args: never[]
  ) => CatalogDrizzleStoreOptions | Promise<CatalogDrizzleStoreOptions>;
}

/**
 * Registers the Drizzle workspace store under `CATALOG_WORKSPACE_STORE`, and the
 * overlay store as a provider the host can hand to `CatalogModule`.
 *
 * `forRootAsync` is the usual entry: the host's database, or its transaction
 * wrapper, is itself a provider.
 */
@Module({})
export class CatalogDrizzleStoreModule {
  static forRoot(options: CatalogDrizzleStoreOptions): DynamicModule {
    return CatalogDrizzleStoreModule.build([], {
      provide: CATALOG_DRIZZLE_STORE_OPTIONS,
      useValue: options,
    });
  }

  static forRootAsync(options: CatalogDrizzleStoreAsyncOptions): DynamicModule {
    return CatalogDrizzleStoreModule.build(options.imports ?? [], {
      provide: CATALOG_DRIZZLE_STORE_OPTIONS,
      inject: options.inject ?? [],
      useFactory: options.useFactory as (...args: unknown[]) => CatalogDrizzleStoreOptions,
    });
  }

  private static build(
    imports: NonNullable<ModuleMetadata['imports']>,
    optionsProvider: NonNullable<ModuleMetadata['providers']>[number],
  ): DynamicModule {
    return {
      module: CatalogDrizzleStoreModule,
      imports,
      providers: [
        optionsProvider,
        {
          provide: DrizzleWorkspaceStore,
          inject: [CATALOG_DRIZZLE_STORE_OPTIONS],
          useFactory: (options: CatalogDrizzleStoreOptions) => new DrizzleWorkspaceStore(options),
        },
        { provide: CATALOG_WORKSPACE_STORE, useExisting: DrizzleWorkspaceStore },
        {
          provide: DrizzleCatalogOverlayStore,
          inject: [CATALOG_DRIZZLE_STORE_OPTIONS],
          useFactory: (options: CatalogDrizzleStoreOptions) =>
            new DrizzleCatalogOverlayStore(options),
        },
      ],
      exports: [
        CATALOG_DRIZZLE_STORE_OPTIONS,
        DrizzleWorkspaceStore,
        CATALOG_WORKSPACE_STORE,
        DrizzleCatalogOverlayStore,
      ],
    };
  }
}
