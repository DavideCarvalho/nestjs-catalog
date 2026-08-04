export {
  CatalogProperty,
  type CatalogPropertyOptions,
  CatalogType,
  type CatalogTypeOptions,
} from './catalog.decorators';
export {
  CATALOG_EVENT_PHASE,
  CATALOG_EVENT_PHASE_FALLBACK,
  CATALOG_EVENTS,
  CATALOG_LIB,
  type CatalogEvent,
  type CatalogEventPayloads,
  catalogEventPhase,
  channelNameFor,
  emitCatalog,
} from './catalog.events';
export { CatalogModule } from './catalog.module';
export {
  assertReadOnlyShape,
  type CatalogQueryRelation,
  type CatalogQueryRequest,
  type CatalogQueryResult,
  type CatalogQueryStore,
  isQueryStore,
} from './catalog.query';
export { CATALOG_OPTIONS, type CatalogModuleOptions } from './catalog.options';
export {
  type CatalogOverlayStore,
  FileCatalogOverlayStore,
  InMemoryCatalogOverlayStore,
} from './catalog.overlay-store';
export { CATALOG_OVERLAY_STORE } from './catalog.overlay-store.token';
export { MikroOrmCatalogRegistry } from './catalog.registry';
export { CatalogRegistry } from './catalog.registry.base';
export {
  CATALOG_PIPELINE_STORE,
  type CatalogConnection,
  type CatalogConnector,
  type ConnectionCheck,
  CONNECTOR_KINDS,
  type CatalogPipelineStore,
  type CatalogStageStore,
  type CatalogTransform,
  type CatalogWorkflow,
  type CatalogWorkflowCapabilities,
  type CatalogWorkflowStore,
  type ConnectorKind,
  type ConnectorRun,
  isConnectorKind,
  isPipelineStore,
  isTransformLanguage,
  isWorkflowEdge,
  isWorkflowExecutionMode,
  isWorkflowNode,
  isWorkflowNodeKind,
  supportsWorkflows,
  supportsWorkflowStages,
  TRANSFORM_RUNNER,
  TRANSFORM_LANGUAGES,
  type TransformLanguage,
  type TransformResult,
  type TransformRunner,
  validateWorkflow,
  WORKFLOW_EXECUTION_MODES,
  WORKFLOW_ISSUE_CODES,
  WORKFLOW_NODE_ID_PATTERN,
  WORKFLOW_NODE_KINDS,
  type WorkflowEdge,
  type WorkflowExecutionMode,
  type WorkflowGraph,
  workflowGraphHash,
  type WorkflowIssueCode,
  type WorkflowNode,
  type WorkflowNodeKind,
  type WorkflowNodeOutcome,
  type WorkflowNodeStepInput,
  type WorkflowNodeStepOutput,
  workflowRunOrder,
  type WorkflowSinkNode,
  type WorkflowSourceNode,
  type WorkflowStageRef,
  type WorkflowTransformNode,
  type WorkflowValidationIssue,
} from './catalog.pipeline';
// The environment surface: which catalog database a call is served from, and
// how a connector or a transform is promoted between them.
export * from './catalog.environment';
export { QueryCache, toCsv } from './catalog.query-cache';
export {
  SubprocessTransformRunner,
  type TransformRunnerOptions,
} from './transform-runner';
export { CatalogService } from './catalog.service';
export {
  type AuditQuery,
  CATALOG_TRACE_OUTCOMES,
  CATALOG_TRACE_STORE,
  CATALOG_WORKSPACE_STORE,
  type CatalogAuditEvent,
  type CatalogTrace,
  type CatalogTraceList,
  type CatalogTraceOutcome,
  type CatalogTraceSpan,
  type CatalogTraceStore,
  type CatalogTraceTotals,
  type CatalogUnlinkedList,
  type CatalogWorkspaceStore,
  type Dashboard,
  type DashboardCard,
  // The embed payload types. Absent until now, which made the one surface
  // another company's frontend consumes the one surface whose response shape a
  // host had to restate by hand — the same gap the barrel spec was written for.
  type EmbeddedChart,
  type EmbeddedChartPlacement,
  type EmbeddedDashboard,
  embeddedVisualization,
  isCatalogTraceOutcome,
  isTraceStore,
  isWorkspaceStore,
  type QueryVisualization,
  type SaveQueryInput,
  type SavedQuery,
  type TraceQuery,
  traceOutcomeFilter,
} from './catalog.workspace';
export {
  CATALOG_PRINCIPAL_RESOLVER,
  type CatalogActor,
  type CatalogGrants,
  type CatalogPrincipal,
  type CatalogPrincipalResolver,
  type CatalogScope,
  composePrincipalId,
  delegatePrincipal,
  expandScopes,
  hasScope,
  parsePrincipalId,
  PRINCIPAL_ACTOR_SEPARATOR,
  maySeeClassification,
  mayRead,
  mayWrite,
  StaticKeyPrincipalResolver,
} from './catalog.principal';
// Everything, deliberately. The last release exported the directory interface
// but not the two types its one method takes and returns, so the seam could be
// implemented only by a host willing to restate them — which nothing in this
// repo would have caught: no consumer compiles against the built barrel here.
export * from './catalog.access';
export {
  assertNoColumnCollisions,
  CATALOG_RESERVED_COLUMNS,
  CATALOG_SNAPSHOT_MODES,
  CATALOG_STORE,
  type CarryForwardResult,
  type CatalogColumnCollision,
  CatalogColumnCollisionError,
  type CatalogMergeStore,
  type CatalogReadQuery,
  type CatalogReadResult,
  type CatalogReadStore,
  type CatalogReservedColumn,
  type CatalogSnapshotMode,
  type CatalogStoreCapabilities,
  type CatalogWriteStore,
  type ColumnCollisionOptions,
  findColumnCollisions,
  isCatalogStoreCapabilities,
  isReservedColumn,
  isWriteStore,
  type SnapshotRef,
  supportsCarryForward,
} from './catalog.store';
export { MikroOrmReadStore } from './stores/mikro-orm-read.store';
export type {
  CatalogGraph,
  CatalogObjectPage,
  CatalogObjectQuery,
  CatalogObjectTypeDef,
  CatalogOverlay,
  CatalogPropertyDef,
  CatalogRelationDef,
  CatalogSnapshot,
  RelationKind,
  ScalarType,
} from './catalog.types';
export {
  REQUIRED_SCOPES,
  REQUIRES_HUMAN,
  RequireHuman,
  RequireScopes,
} from './catalog.route-auth';
