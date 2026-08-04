import { PrincipalRow, SnapshotRow } from './entities/governance';
import { ObjectTypeRow, PropertyRow } from './entities/model';
import {
  ConnectionRow,
  ConnectorRow,
  ConnectorRunRow,
  TransformRow,
  WorkflowRow,
  WorkflowStageRow,
} from './entities/pipeline';
import { AuditEventRow, DashboardRow, SavedQueryRow } from './entities/workspace';

export {
  CatalogAuditRecorder,
  MySqlCatalogTraceStore,
} from './audit-recorder.service';
export { PrincipalRow, SnapshotRow } from './entities/governance';
export {
  AuditEventRow,
  DashboardRow,
  SavedQueryRow,
} from './entities/workspace';
export { MikroOrmCatalogDirectory } from './directory.service';
export { MySqlWorkspaceStore } from './workspace.store';
export { MySqlPipelineStore } from './pipeline.store';
export {
  ConnectionRow,
  ConnectorRow,
  ConnectorRunRow,
  TransformRow,
  WorkflowRow,
  WorkflowStageRow,
} from './entities/pipeline';
export {
  CatalogEnvironmentBundle,
  CatalogEnvironmentSet,
} from './environment.bundle';
export {
  currentEnvironment,
  currentEnvironmentBundle,
  requireEnvironmentBundle,
  RoutingCatalogRegistry,
  RoutingCatalogStore,
  RoutingPipelineStore,
  RoutingWorkspaceStore,
  runInEnvironment,
} from './environment.routing';
export {
  applyPromotion,
  type PromotionOutcome,
  readPromotable,
} from './environment.promotion';
export { ObjectTypeRow, PropertyRow } from './entities/model';
export {
  BATCH_COLUMN,
  ident,
  LOADED_AT_COLUMN,
  PRINCIPAL_COLUMN,
  RESERVED_COLUMNS,
  ROW_COLUMN,
  SNAPSHOT_COLUMN,
  tableFor,
  toPhysicalName,
  UnsafeIdentifierError,
} from './identifiers';
export { MySqlWarehouseStore } from './mysql-warehouse.store';
export {
  dropView,
  refreshView,
  relationsFor,
  runReadOnlyQuery,
  viewFor,
} from './query';
export {
  catalogManagedTables,
  ensureCatalogSchema,
  MARKER_TABLE,
} from './schema';
export {
  CATALOG_STORE_ENTITY_MANAGER,
  CATALOG_STORE_MIKRO_ORM,
} from './context';
export {
  CATALOG_STORE_OPTIONS,
  type CatalogStoreModuleOptions,
} from './options';
export { CatalogMikroOrmStoreModule } from './store.module';
export { StoredCatalogRegistry } from './stored-registry.service';

/**
 * Every entity this package owns. Spread into your MikroORM `entities`.
 *
 * The host still registers them: this package manages their *schema*, not the
 * ORM's discovery. Hiding registration behind a module would leave the MikroORM
 * CLI — migrations, schema commands — unable to see them.
 */
export const catalogStoreEntities = [
  ObjectTypeRow,
  PropertyRow,
  SnapshotRow,
  PrincipalRow,
  SavedQueryRow,
  DashboardRow,
  AuditEventRow,
  ConnectorRow,
  TransformRow,
  ConnectorRunRow,
  // Reachable from nothing for the same reason as `ConnectionRow` below: a
  // connector holds a workflow id rather than a relation, and a staged batch
  // holds a run id. Absent here, `catalog_workflow` is never created and every
  // workflow read dies on missing metadata rather than on a missing table.
  WorkflowRow,
  WorkflowStageRow,
  // Reachable from nothing: a connector holds a connection *id*, deliberately
  // not a foreign key, so MikroORM's discovery cannot walk to this entity from
  // any other. It has to be listed by hand, and being absent here is invisible
  // until the first read — `catalog_connection` is never created and every
  // connection query dies on missing metadata rather than on a missing table.
  ConnectionRow,
];
