import {
  CATALOG_DIRECTORY,
  CATALOG_TRACE_STORE,
  CATALOG_WORKSPACE_STORE,
  CatalogAuditRecorder,
  CatalogRegistry,
} from '@dudousxd/nestjs-catalog';
import {
  type DynamicModule,
  type InjectionToken,
  Module,
  type ModuleMetadata,
  type OptionalFactoryDependency,
  type Provider,
} from '@nestjs/common';
import { DrizzleCatalogDirectory } from './directory';
import { DrizzleCatalogOverlayStore } from './overlay.store';
import { DrizzleCatalogRegistry } from './registry';
import { DrizzleCatalogTraceStore } from './trace.store';
import { type CatalogDrizzleStoreOptions, DrizzleWorkspaceStore } from './workspace.store';

export const CATALOG_DRIZZLE_STORE_OPTIONS = Symbol('CATALOG_DRIZZLE_STORE_OPTIONS');

/** What the module registers besides the stores. */
export interface CatalogDrizzleStoreModuleFlags {
  /**
   * Record every catalog event into the audit table through
   * `CatalogAuditRecorder`. Defaults to true. Off for a deployment that keeps the
   * events in its own tracing and nowhere else.
   */
  readonly audit?: boolean;
  /** How long the registry serves its model before checking for changes. See `DrizzleCatalogRegistry`. */
  readonly staleAfterMs?: number;
}

export interface CatalogDrizzleStoreAsyncOptions extends CatalogDrizzleStoreModuleFlags {
  readonly imports?: ModuleMetadata['imports'];
  readonly inject?: Array<InjectionToken | OptionalFactoryDependency>;
  readonly useFactory: (
    ...args: never[]
  ) => CatalogDrizzleStoreOptions | Promise<CatalogDrizzleStoreOptions>;
}

/**
 * Registers the Drizzle stores: the workspace store under
 * `CATALOG_WORKSPACE_STORE`, the trace store under `CATALOG_TRACE_STORE`, the
 * stored registry under `CatalogRegistry` (loaded on module init), the directory
 * under `CATALOG_DIRECTORY`, the audit recorder, and the overlay store as a
 * provider the host hands to `CatalogModule`.
 *
 * `forRootAsync` is the usual entry: the host's database, or its transaction
 * wrapper, is itself a provider.
 */
@Module({})
export class CatalogDrizzleStoreModule {
  static forRoot(
    options: CatalogDrizzleStoreOptions & CatalogDrizzleStoreModuleFlags,
  ): DynamicModule {
    return CatalogDrizzleStoreModule.build(
      [],
      { provide: CATALOG_DRIZZLE_STORE_OPTIONS, useValue: options },
      options,
    );
  }

  static forRootAsync(options: CatalogDrizzleStoreAsyncOptions): DynamicModule {
    return CatalogDrizzleStoreModule.build(
      options.imports ?? [],
      {
        provide: CATALOG_DRIZZLE_STORE_OPTIONS,
        inject: options.inject ?? [],
        useFactory: options.useFactory as (...args: unknown[]) => CatalogDrizzleStoreOptions,
      },
      options,
    );
  }

  private static build(
    imports: NonNullable<ModuleMetadata['imports']>,
    optionsProvider: Provider,
    flags: CatalogDrizzleStoreModuleFlags,
  ): DynamicModule {
    const fromOptions = <T>(make: (options: CatalogDrizzleStoreOptions) => T) => ({
      inject: [CATALOG_DRIZZLE_STORE_OPTIONS],
      useFactory: make,
    });
    return {
      module: CatalogDrizzleStoreModule,
      imports,
      providers: [
        optionsProvider,
        {
          provide: DrizzleWorkspaceStore,
          ...fromOptions((options) => new DrizzleWorkspaceStore(options)),
        },
        { provide: CATALOG_WORKSPACE_STORE, useExisting: DrizzleWorkspaceStore },
        {
          provide: DrizzleCatalogTraceStore,
          ...fromOptions((options) => new DrizzleCatalogTraceStore(options)),
        },
        { provide: CATALOG_TRACE_STORE, useExisting: DrizzleCatalogTraceStore },
        {
          provide: DrizzleCatalogOverlayStore,
          ...fromOptions((options) => new DrizzleCatalogOverlayStore(options)),
        },
        {
          provide: DrizzleCatalogRegistry,
          ...fromOptions(
            (options) =>
              new DrizzleCatalogRegistry({ ...options, staleAfterMs: flags.staleAfterMs }),
          ),
        },
        { provide: CatalogRegistry, useExisting: DrizzleCatalogRegistry },
        {
          provide: DrizzleCatalogDirectory,
          ...fromOptions((options) => new DrizzleCatalogDirectory(options)),
        },
        { provide: CATALOG_DIRECTORY, useExisting: DrizzleCatalogDirectory },
        ...(flags.audit === false ? [] : [CatalogAuditRecorder]),
      ],
      exports: [
        CATALOG_DRIZZLE_STORE_OPTIONS,
        DrizzleWorkspaceStore,
        CATALOG_WORKSPACE_STORE,
        DrizzleCatalogTraceStore,
        CATALOG_TRACE_STORE,
        DrizzleCatalogOverlayStore,
        DrizzleCatalogRegistry,
        CatalogRegistry,
        DrizzleCatalogDirectory,
        CATALOG_DIRECTORY,
      ],
    };
  }
}
