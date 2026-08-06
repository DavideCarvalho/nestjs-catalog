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
  UNATTRIBUTED_PRINCIPAL_ID,
  catalogEventPhase,
  channelNameFor,
  curationActor,
  emitCatalog,
} from './catalog.events';
export { CatalogModule } from './catalog.module';
export {
  assertReadOnlyShape,
  type CatalogQueryRelation,
  type CatalogQueryRequest,
  type CatalogQueryResult,
  type CatalogQueryStore,
  type CatalogQueryStreamRequest,
  isQueryStore,
  isStreamingQueryStore,
} from './catalog.query';
export { CATALOG_OPTIONS, type CatalogModuleOptions } from './catalog.options';
// Everything, deliberately, and here more than anywhere: this is a seam two
// separate provider packages are being written against. A barrel that shipped
// `CATALOG_SECRET_VAULT` and `CatalogSecretVault` but not `SealedSecret` or
// `SecretContext` — the return type and the argument of the two methods a
// provider implements — would be the exact gap `index.barrel.spec.ts` was
// written after, reproduced on the one surface where a third party compiles
// against it.
export * from './catalog.secrets';
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
  CODE_CONTEXT_CONTRACT,
  type CatalogCodeContext,
  type CatalogConnection,
  type CatalogConnector,
  type ConnectionCheck,
  CONNECTOR_KINDS,
  type CatalogLoadExpectations,
  type CatalogLoadExpectationStore,
  type CatalogPipelineStore,
  type CatalogStageStore,
  type CatalogTransform,
  type CatalogWorkflow,
  type CatalogWorkflowCapabilities,
  type CatalogWorkflowStore,
  type CallableWorkflowRef,
  type ConnectorKind,
  type ConnectorRun,
  type DeleteReconciliation,
  isConnectorKind,
  isPipelineStore,
  isTransformLanguage,
  type LoadExpectation,
  type RowCountBound,
  type StoredLoadExpectation,
  readWorkflowCallOutput,
  supportsLoadExpectations,
  supportsTransformRevisions,
  isWorkflowEdge,
  isWorkflowExecutionMode,
  isWorkflowNode,
  isWorkflowNodeKind,
  isWorkflowStatus,
  supportsWorkflows,
  supportsWorkflowStages,
  TRANSFORM_RUNNER,
  TRANSFORM_LANGUAGES,
  type TransformLanguage,
  type TransformResult,
  type TransformRunner,
  validateWorkflow,
  WORKFLOW_CALL_CONTRACT,
  WORKFLOW_EXECUTION_MODES,
  WORKFLOW_ISSUE_CODES,
  WORKFLOW_NODE_ID_PATTERN,
  WORKFLOW_NODE_KINDS,
  WORKFLOW_STATUSES,
  type WorkflowCallEnvelope,
  type WorkflowCallNode,
  type WorkflowCallOutput,
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
  type WorkflowStatus,
  type WorkflowTransformNode,
  type WorkflowValidationIssue,
} from './catalog.pipeline';
// The environment surface: which catalog database a call is served from, and
// how a connector or a transform is promoted between them.
export * from './catalog.environment';
export { QueryCache } from './catalog.query-cache';
// CSV. `toCsv` is the shape it always was; `csvLines` is the one the export
// route uses, and `guardFormula` is exported because a host writing its own
// export route needs the escaping and not the framing.
export { type CsvRow, csvCell, csvLines, guardFormula, toCsv } from './catalog.csv';
export {
  SubprocessTransformRunner,
  type TransformRunnerOptions,
} from './transform-runner';
export { CatalogService } from './catalog.service';
// Search. The result types are on `/client` too, for a browser; these are here
// because a host that passed `controller: false` and wrote its own routes needs
// to type the handler, and — more importantly — needs `visibleToPrincipal` and
// `maySearch` if it calls `searchCatalog` directly rather than going through
// `CatalogService.search`. Exporting the matcher without them would ship the
// half that ranks and withhold the half that decides who may see what, which is
// the exact shape of the gap `index.barrel.spec.ts` was written after.
export {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  bestMatch,
  emptySearch,
  maySearch,
  type SearchInput,
  type SearchableDashboard,
  type SearchableSavedQuery,
  searchCatalog,
  visibleToPrincipal,
} from './search';
export type {
  CatalogSearchField,
  CatalogSearchHit,
  CatalogSearchKind,
  CatalogSearchRank,
  CatalogSearchResult,
} from './search.types';
export {
  type AuditQuery,
  CATALOG_REVISION_LIMIT,
  CATALOG_TRACE_OUTCOMES,
  CATALOG_TRACE_STORE,
  CATALOG_WORKSPACE_STORE,
  type CatalogAuditEvent,
  // The archive of everything whose text a person edits — a transform's code and
  // a saved query's SQL. Exported here as well as on `/client` because a host
  // writing its own revisions route has to type the handler.
  type CatalogRevision,
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
  supportsSavedQueryRevisions,
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
  readableObjectPage,
  StaticKeyPrincipalResolver,
} from './catalog.principal';
// Everything, deliberately. The last release exported the directory interface
// but not the two types its one method takes and returns, so the seam could be
// implemented only by a host willing to restate them — which nothing in this
// repo would have caught: no consumer compiles against the built barrel here.
export * from './catalog.access';
// The filter rule, whole. A store implementing `CatalogFilteringReadStore` needs
// the operator list to declare what it applies and `CatalogResolvedFilter` to
// read what it was handed, and a host writing its own objects route needs
// `resolveObjectFilters` — shipping the interface without them would be the same
// unimplementable seam the barrel spec above was written after. It is also on
// `/client`, because the console derives its controls from the same function.
export * from './catalog.filters';
export {
  assertNoColumnCollisions,
  assertSafeIdentifier,
  CATALOG_RESERVED_COLUMNS,
  CATALOG_SNAPSHOT_MODES,
  CATALOG_STORE,
  type CarryForwardResult,
  type CatalogColumnCollision,
  CatalogColumnCollisionError,
  type CatalogFilteringReadStore,
  supportsObjectFilters,
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
  isSafeIdentifier,
  isWriteStore,
  outputAlias,
  physicalColumn,
  type SnapshotRef,
  supportsCarryForward,
  UnsafeIdentifierError,
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
