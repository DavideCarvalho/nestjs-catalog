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
  type CatalogWorkflowRelease,
  type CatalogWorkflowReleaseStore,
  type CatalogWorkflowStore,
  type CallableWorkflowBlock,
  type CallableWorkflowDisagreement,
  type CallableWorkflowRef,
  callableWorkflowBlock,
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
  REDACTED_SECRET,
  supportsLoadExpectations,
  supportsReusableNodes,
  supportsTransformPins,
  supportsTransformRevisions,
  applyReusableNode,
  type CatalogReusableNode,
  type CatalogReusableNodeStore,
  type CatalogReusableNodeUse,
  describeLiveVersion,
  describeVersionPin,
  isReusableNodeBody,
  isReusableNodeKind,
  NODE_KIND_IS_REUSABLE,
  nodeKindIsReusable,
  REUSABLE_NODE_KINDS,
  type ReusableNodeBody,
  type ReusableNodeKind,
  type ReusableNodeRef,
  type ReusableSinkBody,
  type ReusableSourceBody,
  reusableNodeBodyOf,
  unreachableReusableNodeKind,
  type VersionPinCopy,
  isWorkflowBranchLabel,
  isWorkflowEdge,
  isWorkflowExecutionMode,
  isWorkflowFilterOperator,
  isWorkflowFilterPredicate,
  isWorkflowFilterPredicateKind,
  isWorkflowFilterValue,
  isWorkflowIfPredicate,
  isWorkflowNode,
  isWorkflowCallMode,
  isWorkflowNodeKind,
  isWorkflowPredicateKind,
  isWorkflowSkipReason,
  isWorkflowStatus,
  liveWorkflowVersion,
  supportsWorkflowReleases,
  supportsWorkflows,
  supportsWorkflowStages,
  TRANSFORM_RUNNER,
  TRANSFORM_LANGUAGES,
  type TransformLanguage,
  type TransformResult,
  type TransformRunner,
  unreachableFilterOperator,
  unreachableFilterPredicateKind,
  unreachableCallMode,
  unreachableNodeKind,
  unreachablePredicateKind,
  validateWorkflow,
  WORKFLOW_BRANCH_LABELS,
  WORKFLOW_CALL_CONTRACT,
  WORKFLOW_CALL_MODES,
  WORKFLOW_COLUMN_GAP,
  WORKFLOW_EXECUTION_MODES,
  WORKFLOW_FILTER_COLUMN_PATTERN,
  WORKFLOW_FILTER_MAX_DEPTH,
  WORKFLOW_FILTER_MAX_VALUES,
  WORKFLOW_FILTER_OPERATORS,
  WORKFLOW_FILTER_PREDICATE_KINDS,
  WORKFLOW_ISSUE_CODES,
  WORKFLOW_NODE_HEIGHT,
  WORKFLOW_NODE_ID_PATTERN,
  WORKFLOW_NODE_KINDS,
  WORKFLOW_NODE_WIDTH,
  WORKFLOW_PREDICATE_KINDS,
  WORKFLOW_ROW_GAP,
  WORKFLOW_SKIP_REASONS,
  WORKFLOW_STATUSES,
  type WorkflowBranchLabel,
  workflowColumnX,
  workflowRowY,
  type WorkflowCallEnvelope,
  type WorkflowCallMode,
  workflowCallMode,
  type WorkflowCallNode,
  type WorkflowCallOutput,
  type WorkflowEdge,
  type WorkflowExecutionMode,
  type WorkflowFilterAll,
  type WorkflowFilterAny,
  type WorkflowFilterComparison,
  type WorkflowFilterGroup,
  workflowFilterMatches,
  type WorkflowFilterNode,
  type WorkflowFilterOneOf,
  type WorkflowFilterOperator,
  type WorkflowFilterPredicate,
  type WorkflowFilterPredicateKind,
  type WorkflowFilterPresence,
  type WorkflowFilterValue,
  type WorkflowGraph,
  workflowGraphHash,
  type WorkflowEnvPredicate,
  type WorkflowIfNode,
  type WorkflowIfPredicate,
  type WorkflowIssueCode,
  type WorkflowNode,
  type WorkflowNodeKind,
  workflowNarrowedTypes,
  type WorkflowNodeOutcome,
  workflowNodeRuns,
  type WorkflowNodeStepInput,
  type WorkflowNodeStepOutput,
  workflowRunOrder,
  type WorkflowRunOrderEntry,
  type WorkflowPredicateKind,
  type WorkflowRowCountPredicate,
  type WorkflowSinkNode,
  type WorkflowSkipReason,
  type WorkflowSourceNode,
  type WorkflowStageRef,
  type WorkflowStatus,
  type WorkflowTransformNode,
  type WorkflowValidationIssue,
} from './catalog.pipeline';
// How a staged batch is written down. Exported because `CatalogStageStore` is a
// seam a host can implement — a stage kept in object storage or a columnar
// warehouse rather than the catalog database is the case the interface exists
// for — and such a host needs the codec, not a description of it. Two stores
// encoding the same batch differently would be a run that cannot resume across
// a deployment that changed its mind about where stages live.
export {
  type ColumnarStageBatch,
  STAGE_ENCODING,
  STAGE_ENCODING_VERSION,
  type StagePayload,
  classifyStagePayload,
  decodeStageRows,
  encodeStageRows,
  isColumnarStageBatch,
} from './catalog.stage-encoding';
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
