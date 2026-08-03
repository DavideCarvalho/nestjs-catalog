import {
  CATALOG_PIPELINE_STORE,
  CATALOG_STORE,
  CATALOG_TRACE_STORE,
  CATALOG_WORKSPACE_STORE,
  CatalogRegistry,
} from '@dudousxd/nestjs-catalog';
import { type DynamicModule, Module } from '@nestjs/common';
import { CatalogAuditRecorder, MySqlCatalogTraceStore } from './audit-recorder.service';
import {
  CATALOG_STORE_ENTITY_MANAGER,
  CATALOG_STORE_MIKRO_ORM,
  catalogConnectionProviders,
} from './context';
import { MySqlWarehouseStore } from './mysql-warehouse.store';
import { CATALOG_STORE_OPTIONS, type CatalogStoreModuleOptions } from './options';
import { MySqlPipelineStore } from './pipeline.store';
import { StoredCatalogRegistry } from './stored-registry.service';
import { MySqlWorkspaceStore } from './workspace.store';

/**
 * Binds both of the catalog library's swappable seams to a warehouse: the model
 * is stored rather than derived, and rows live in tables this package owns
 * rather than in somebody else's.
 */
@Module({})
export class CatalogMikroOrmStoreModule {
  static forRoot(options: CatalogStoreModuleOptions = {}): DynamicModule {
    return {
      module: CatalogMikroOrmStoreModule,
      providers: [
        // First, so everything below resolves its EntityManager from the
        // connection the host named rather than from whichever one happens to
        // be the default in this process.
        ...catalogConnectionProviders(options.contextName),
        { provide: CATALOG_STORE_OPTIONS, useValue: options },
        StoredCatalogRegistry,
        MySqlWarehouseStore,
        MySqlWorkspaceStore,
        MySqlPipelineStore,
        { provide: CATALOG_PIPELINE_STORE, useExisting: MySqlPipelineStore },
        { provide: CatalogRegistry, useExisting: StoredCatalogRegistry },
        { provide: CATALOG_STORE, useExisting: MySqlWarehouseStore },
        { provide: CATALOG_WORKSPACE_STORE, useExisting: MySqlWorkspaceStore },
        // Only when asked for. A deployment that routes the diagnostics channel
        // into its own tracing and wants nothing in a table simply leaves this
        // off, and every read still works.
        ...(options.audit === false ? [] : [CatalogAuditRecorder]),
        // Reading traces is independent of recording them: a deployment that
        // routes the diagnostics channel elsewhere and turns the recorder off
        // still has whatever rows were written before, and grouping them is a
        // read like any other.
        MySqlCatalogTraceStore,
        { provide: CATALOG_TRACE_STORE, useExisting: MySqlCatalogTraceStore },
      ],
      exports: [
        // Exported so a host that adds its own services on top of this store —
        // a publish endpoint, a seeder — writes through the *same* connection
        // instead of injecting `EntityManager` positionally and quietly landing
        // in the host's database. Handing out the token is what makes that
        // possible without the host having to know how the connection is named.
        CATALOG_STORE_ENTITY_MANAGER,
        CATALOG_STORE_MIKRO_ORM,
        StoredCatalogRegistry,
        MySqlWarehouseStore,
        MySqlWorkspaceStore,
        MySqlPipelineStore,
        CatalogRegistry,
        CATALOG_STORE,
        CATALOG_WORKSPACE_STORE,
        CATALOG_PIPELINE_STORE,
        CATALOG_TRACE_STORE,
      ],
    };
  }
}
