export {
  ORPHAN_SCAN_LIMIT,
  abandonedRunMessage,
  closeAbandonedAttempts,
  type AbandonedRunLog,
  type AbandonedRunStore,
  type AbandonedScan,
} from './abandoned-runs';
export { ConnectionChecker } from './connection-checker.service';
export {
  REDACTED_SECRET,
  carriesUrlPassword,
  redactConfigSecrets,
  redactConnection,
  redactConnector,
  restoreRedactedSecrets,
} from './config-secrets';
export {
  CONNECTOR_RUN_STEP,
  ConnectorRunSteps,
  type ConnectorRunStepInput,
  type ConnectorRunStepOutput,
} from './connector-run.steps';
export {
  CONNECTOR_RUN_WORKFLOW,
  ConnectorRunWorkflow,
  type ConnectorRunInput,
} from './connector-run.workflow';
export { CATALOG_ADOPT_CONNECTORS, ConnectorAdoption } from './connector-adoption.service';
export { ConnectorRunnerService } from './connector-runner.service';
export {
  CATALOG_SCHEDULER_ENABLED,
  ConnectorScheduler,
} from './connector-scheduler.service';
export {
  CatalogPipelineModule,
  CATALOG_PIPELINE_TOKENS,
  type CatalogPipelineModuleOptions,
} from './pipeline.module';
export { createPipelineController } from './pipeline.controller';
export {
  describeStoredUnpublishableNames,
  identifierRefusal,
  isUnpublishableName,
  refuseUnpublishablePropertyNames,
  type NamedProperty,
} from './property-names';
export { createPublishController } from './publish.controller';
export { PublishService, type PublishedType } from './publish.service';
export { WorkflowLauncher, type WorkflowDurability } from './workflow-launcher.service';
export {
  toGraph,
  toRunView,
  type CanvasWorkflowInput,
  type CanvasWorkflowRun,
} from './workflow-view';
export {
  SAMPLE_LIMIT,
  columnsFromSqlDescription,
  discoverSourceSchema,
  driftFrom,
  flagUnusableNames,
  type ColumnConfidence,
  type ConnectorSchemaDiscovery,
  type DiscoverSchemaInput,
  type DiscoverySource,
  type DiscoveredColumn,
  type DiscoveryBasis,
  type SchemaDrift,
} from './schema-discovery';
export {
  CATALOG_PIPELINE_DURABILITY_DETAIL,
  CATALOG_PIPELINE_EM,
  CATALOG_PIPELINE_REGISTRY,
  CATALOG_PIPELINE_SCOPE,
  passthroughScope,
  type CatalogPipelineEmResolver,
  type CatalogPipelineRegistry,
  type CatalogPipelineScope,
} from './seams';
export {
  SOURCES,
  applyConnection,
  describeSql,
  resolveSecret,
  toBufferedFetchResult,
  toFetchResult,
  toRecordStream,
  zeroRowStatement,
  type FetchResult,
  type RecordStream,
  type SqlDescription,
  type SqlDialect,
  type SqlFieldDescription,
  type StreamedFetchResult,
} from './sources';
export {
  WORKFLOW_FINISH_STEP,
  WORKFLOW_NODE_STEP,
  WORKFLOW_PLAN_STEP,
  WorkflowRunSteps,
} from './workflow-run.steps';
export {
  CATALOG_WORKFLOW_RUN,
  CatalogWorkflowRunWorkflow,
  type CatalogWorkflowRunInput,
  type CatalogWorkflowRunOutput,
} from './workflow-run.workflow';
export {
  WorkflowRunnerService,
  stageRefsFor,
  type WorkflowFinishInput,
  type WorkflowPlanResult,
} from './workflow-runner.service';
export {
  assertMayWriteTypes,
  committedTypes,
  requirePrincipal,
} from './write-grants';

// Everything, deliberately. This surface is how a host declares what it expects
// of a load — the deletion strategy for a type and the bound a snapshot may not
// shrink past — and a hand-maintained list is how the catalog package's barrel
// came to export an interface without the two types its one method takes.
// Nothing here is internal: a host that cannot name `CATALOG_LOAD_EXPECTATIONS`
// cannot bind it, and a token nobody can bind is a feature nobody can switch on.
export * from './load-expectations';
