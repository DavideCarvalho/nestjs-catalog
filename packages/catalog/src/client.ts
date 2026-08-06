/**
 * The browser-facing entry point: `@dudousxd/nestjs-catalog/client`.
 *
 * Types and route builders only — nothing here imports NestJS, MikroORM or
 * anything Node-only, so a browser bundle can take a dependency on it without
 * pulling the server in.
 *
 * This exists so the HTTP surface is genuinely usable by someone writing their
 * own UI. The endpoints alone are not an API; the endpoints plus the response
 * types are.
 */

// Type-only, and re-exported again further down: `export … from` creates no
// local binding, and the load-expectation declarations at the foot of this file
// need to refer to these shapes by name.
import type {
  DeleteReconciliation,
  LoadExpectation,
  RowCountBound,
  StoredLoadExpectation,
} from './catalog.pipeline';

// The query types live beside the store interface they belong to, not in
// catalog.types — but a browser consumer should not have to know that.
export type {
  AuditQuery,
  CatalogAuditEvent,
  // The revision shape, exported here as well as from the package root because
  // the diff screen that consumes it is a browser one. A console that had to
  // restate it would be the second copy of a contract two packages serve —
  // which is the drift this entry point exists to prevent, and which the React
  // package is currently paying by mirroring it.
  CatalogRevision,
  Dashboard,
  DashboardCard,
  QueryVisualization,
  SaveQueryInput,
  SavedQuery,
} from './catalog.workspace';

// A value, not a type: a screen saying how far back the history goes should read
// the number rather than print one of its own. See its docblock for what the cap
// costs.
export { CATALOG_REVISION_LIMIT } from './catalog.workspace';

export type {
  CatalogQueryRelation,
  CatalogQueryRequest,
  CatalogQueryResult,
} from './catalog.query';

// What `GET /catalog/search` answers. A separate module from the matcher so
// this entry point stays types-only — the ranking runs on the server, and a
// browser that re-implemented it would produce a second order for the same
// term. See search.types.ts for what a hit deliberately does not carry.
export type {
  CatalogSearchField,
  CatalogSearchHit,
  CatalogSearchKind,
  CatalogSearchRank,
  CatalogSearchResult,
} from './search.types';

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

/**
 * The filter rule, shipped to the browser deliberately — the same exception, for
 * the same reason, that `validateWorkflow` further down is.
 *
 * A console has to know which control to draw for a column, and the only way for
 * that answer to match what the server will accept is for both to run this
 * function. A screen with its own copy of the rules eventually lies: it offers a
 * control the read refuses, or omits one that would have worked, and on types
 * that are created at runtime nobody notices until a publisher adds a column. The
 * functions are pure and import nothing.
 *
 * `SnapshotRef` rides along because a snapshot picker is a browser screen and
 * `GET objects/:name/snapshots` is what fills it. The endpoints alone are not an
 * API; the endpoints plus the response types are.
 */
export {
  CATALOG_FILTER_LIMIT,
  CATALOG_FILTER_OPERATORS,
  coerceFilterValue,
  encodeObjectFilter,
  filterOperatorTakesValue,
  filterOperatorsFor,
  isCatalogFilterOperator,
  offeredFilterOperators,
  parseObjectFilter,
  resolveObjectFilters,
  VALUELESS_FILTER_OPERATORS,
} from './catalog.filters';
export type {
  CatalogFilterableColumn,
  CatalogFilterOperator,
  CatalogFilterResolution,
  CatalogObjectFilter,
  CatalogResolvedFilter,
} from './catalog.filters';
export type { SnapshotRef } from './catalog.store';

/**
 * How a name becomes a column, shipped to the browser deliberately.
 *
 * The second exception to "types only" on this entry point, and it is made for
 * the same reason `validateWorkflow` is the first: the answer has to be the
 * same one the server will give, and the only way to guarantee that is for both
 * to run these functions.
 *
 * A console proposing to replicate a table has to be able to ask, *before* it
 * draws anything, whether the source's own column spellings could be published
 * as property names — because a property `name` is what the warehouse looks
 * every field up by, `row[property.name]`, so a name the publisher then refuses
 * has to be renamed, and a rename with nothing renaming the record's keys to
 * match writes null into that column on every run and reports success. That is
 * not a hypothesis; it is what happened to six types in one evening.
 *
 * **Both halves, because the composition is the rule.** A name no longer has to
 * be an identifier itself — the view's output alias and the read's lookup key go
 * through {@link outputAlias} together, so `Asset Id` is a perfectly good
 * property name and lands in `Asset_Id`. What is still refused is a name whose
 * *cleaned* form is not an identifier: `2024 Total` cleans to `2024_Total`, and
 * no store will quote a name starting with a digit. So the question worth asking
 * from a browser is `isSafeIdentifier(physicalColumn(name))` — the same two
 * calls, in the same order, that `identifierRefusal` makes at publish time.
 * Exporting only `isSafeIdentifier` would let a console answer the stricter,
 * obsolete question and refuse a graph the server would have accepted.
 *
 * Safe to export because `catalog.identifiers.ts` imports nothing at all.
 */
export {
  isSafeIdentifier,
  outputAlias,
  physicalColumn,
  UnsafeIdentifierError,
} from './catalog.identifiers';

/** What a tier-0 edit to a type may change. */
export interface TypePatch {
  displayName?: string;
  pluralDisplayName?: string;
  description?: string;
  icon?: string;
  group?: string;
  titleProperty?: string;
}

/** What a tier-0 edit to a property may change. */
export interface PropertyPatch {
  displayName?: string;
  description?: string;
  hidden?: boolean;
  order?: number;
  classification?: string;
  unit?: string;
}

export interface ObjectQueryParams {
  page?: number;
  size?: number;
  search?: string;
  sort?: string;
  dir?: 'asc' | 'desc';
  /**
   * `property:operator:value`, one entry per filter, ANDed by the server.
   *
   * Named `filter` rather than `filters` because that is the query parameter the
   * route reads, and this object is handed to a transport that serialises it
   * verbatim — a name that disagreed with the route would be a filter that is
   * sent, ignored, and reported by the screen as applied.
   *
   * Build entries with `encodeObjectFilter` rather than by hand: it is what the
   * server parses with, and the two colons are load-bearing.
   */
  filter?: string[];
  /**
   * Read the type as of an earlier load. Omit for the current one, which is what
   * every reader must get by default.
   *
   * Ids come from `GET objects/:name/snapshots`. A store that keeps no history
   * refuses this rather than answering with current state.
   */
  snapshot?: string;
}

/**
 * Builds the paths the catalog controller serves, relative to wherever it was
 * mounted. Kept as string builders rather than a fetch wrapper so the host
 * keeps its own HTTP client, interceptors and auth.
 */
export const catalogRoutes = {
  snapshot: () => '/catalog',
  graph: () => '/catalog/graph',
  /**
   * One term across types, properties, saved queries and dashboards.
   *
   * No arguments, unlike `type(name)` and friends: `q` and `limit` are a query
   * string, and every route here that takes one — `objects`, `events`, `traces`
   * — leaves it to the caller's HTTP client, because that is the layer that
   * already knows how to serialise and encode one. `accessRoutes.people` in the
   * React package does it the other way and is the odd one out.
   */
  search: () => '/catalog/search',
  type: (name: string) => `/catalog/types/${encodeURIComponent(name)}`,
  property: (name: string, property: string) =>
    `/catalog/types/${encodeURIComponent(name)}/properties/${encodeURIComponent(property)}`,
  reset: () => '/catalog/reset',
  objects: (name: string) => `/catalog/objects/${encodeURIComponent(name)}`,
  snapshots: (name: string) => `/catalog/objects/${encodeURIComponent(name)}/snapshots`,
  queryRelations: () => '/catalog/query/relations',
  query: () => '/catalog/query',
  workspaceCapabilities: () => '/catalog/workspace/capabilities',
  savedQueries: () => '/catalog/saved-queries',
  savedQuery: (id: string) => `/catalog/saved-queries/${encodeURIComponent(id)}`,
  /**
   * Every SQL this query has ever been.
   *
   * A sub-resource of the saved query rather than a `?version=` on it, because
   * the question a diff screen asks first is "what were all of them" — it has to
   * see the list before it knows which two to compare, and one request that
   * answers that beats a list plus two fetches.
   */
  savedQueryRevisions: (id: string) => `/catalog/saved-queries/${encodeURIComponent(id)}/revisions`,
  runSavedQuery: (id: string) => `/catalog/saved-queries/${encodeURIComponent(id)}/run`,
  exportSavedQuery: (id: string) => `/catalog/saved-queries/${encodeURIComponent(id)}/export.csv`,
  dashboards: () => '/catalog/dashboards',
  dashboard: (id: string) => `/catalog/dashboards/${encodeURIComponent(id)}`,
  events: () => '/catalog/events',
  // Grouped into one causal story each, rather than the flat list `events`
  // returns. Both exist because they answer different questions: "what happened
  // recently" and "what happened during that load".
  traces: () => '/catalog/events/traces',
  trace: (id: string) => `/catalog/events/traces/${encodeURIComponent(id)}`,
} as const;

// The pipeline types. A browser consumer building a connector screen needs the
// same shapes the server persists, and leaving them out meant the shipped
// console imported names this entry point did not export — which nothing
// caught, because the web build strips types rather than checking them.
export type {
  CatalogConnection,
  CatalogConnector,
  ConnectionCheck,
  CatalogTransform,
  CatalogWorkflow,
  CatalogWorkflowCapabilities,
  ConnectorKind,
  ConnectorRun,
  TransformLanguage,
  TransformResult,
  CallableWorkflowRef,
  WorkflowBranchLabel,
  WorkflowCallEnvelope,
  WorkflowCallNode,
  WorkflowCallOutput,
  WorkflowEdge,
  WorkflowExecutionMode,
  WorkflowGraph,
  WorkflowIfNode,
  WorkflowIssueCode,
  WorkflowNode,
  WorkflowNodeKind,
  WorkflowNodeOutcome,
  WorkflowRunOrderEntry,
  WorkflowSinkNode,
  WorkflowSkipReason,
  WorkflowSourceNode,
  WorkflowStageRef,
  WorkflowTransformNode,
  WorkflowValidationIssue,
} from './catalog.pipeline';

// Values, not types: a form that offers the kinds should read them from here
// rather than keeping a copy that drifts.
export {
  CONNECTOR_KINDS,
  isConnectorKind,
  isTransformLanguage,
  // The canvas narrows nodes and edges it reads back from HTTP. Without these
  // it either imports them from the package root — dragging NestJS and MikroORM
  // into a browser bundle — or writes its own copy of the checks, which is the
  // drift this entry point exists to prevent.
  isWorkflowEdge,
  isWorkflowNode,
  TRANSFORM_LANGUAGES,
  // A screen that shows what a call node got back narrows it the same way the
  // runner does, so the two cannot disagree about what "no rows" looks like.
  readWorkflowCallOutput,
  WORKFLOW_CALL_CONTRACT,
} from './catalog.pipeline';

/**
 * The workflow validator, shipped to the browser deliberately.
 *
 * A canvas has to be able to say "this graph has a cycle" while somebody is
 * drawing it, and the only way for that answer to match what the server will do
 * is for both to run this function. The alternative — a canvas with its own
 * copy of the rules — is a canvas that eventually lies: either it refuses
 * something the server would take, or it accepts something the server rejects
 * halfway through a load. This is the exception to "types only" on this entry
 * point, and it is safe to make because these functions are pure and import
 * nothing.
 *
 * `workflowGraphHash` is here for the same reason: a canvas can tell whether
 * what is on screen still matches the saved version without asking.
 * `WORKFLOW_NODE_ID_PATTERN` and `WORKFLOW_NODE_KINDS` are what a palette and an
 * id field should be built from rather than from a second copy that drifts.
 */
export {
  validateWorkflow,
  WORKFLOW_EXECUTION_MODES,
  WORKFLOW_ISSUE_CODES,
  WORKFLOW_NODE_ID_PATTERN,
  WORKFLOW_NODE_KINDS,
  // The branch vocabulary, for the same reason as the kinds beside it: a canvas
  // that has to draw a then and an else must read the two labels from here, or
  // it keeps a copy and the copy is what eventually spells one of them wrong —
  // which is a subtree that silently never runs.
  WORKFLOW_BRANCH_LABELS,
  WORKFLOW_SKIP_REASONS,
  isWorkflowBranchLabel,
  isWorkflowSkipReason,
  // Exported so a screen can answer "would this node have run" from a recorded
  // run exactly the way the runner decided it, rather than approximating.
  workflowNodeRuns,
  unreachableNodeKind,
  // The draft/ready pair, for the same reason as the list above: a canvas that
  // cannot see it restates it, and the copy is what drifts. Without this the
  // editor could not tell a graph it is allowed to store from one the server
  // would refuse — so it told everybody the second, which is wrong for every
  // draft and is exactly the kind of confident-and-false sentence this codebase
  // keeps removing.
  WORKFLOW_STATUSES,
  workflowGraphHash,
  workflowRunOrder,
  isWorkflowExecutionMode,
  isWorkflowNodeKind,
  isWorkflowStatus,
  // The rule that decides whether an announced workflow may be committed onto a
  // call node, for the same reason `validateWorkflow` is here: the picker greys
  // an option out and the server reasons about the same list, and a picker with
  // its own copy of the rule is one that eventually offers an entry the rest of
  // the system considers unusable.
  callableWorkflowBlock,
} from './catalog.pipeline';
export type {
  CallableWorkflowBlock,
  CallableWorkflowDisagreement,
  WorkflowStatus,
} from './catalog.pipeline';

// Traces: the same grouping the shipped view renders, so a host writing its own
// activity screen gets the shapes as well as the routes.
export type {
  CatalogTrace,
  CatalogTraceList,
  CatalogTraceOutcome,
  CatalogTraceSpan,
  TraceQuery,
} from './catalog.workspace';

/*
 * What a load has to be true of before it becomes the data everybody reads —
 * the browser's half of it.
 *
 * The shapes themselves live in `catalog.pipeline.ts` beside `CatalogConnector`,
 * and are re-exported here for the same reason the connector shapes above are:
 * a screen that had to restate them would be the second copy of a contract two
 * packages serve. What is DECLARED here rather than re-exported is the pair the
 * pipeline's HTTP surface invented and nothing else has a claim on — the
 * provenance answer and the request body — plus the strategy list, which a
 * `<select>` has to be built from rather than from a copy that drifts.
 *
 * The enforcement functions are deliberately not here and are not coming: they
 * are in `@dudousxd/nestjs-catalog-pipeline`, they decide whether a load
 * commits, and a browser running its own copy of them would be a second answer
 * to a question with one.
 */
export type {
  CatalogLoadExpectations,
  DeleteReconciliation,
  LoadExpectation,
  RowCountBound,
  StoredLoadExpectation,
} from './catalog.pipeline';

/**
 * The three answers to "how do deletions at the source reach this type", as a
 * value.
 *
 * A list rather than only the union, because the editor on the Model screen has
 * to offer them and a hand-written array in a component is the copy that drifts
 * — the same argument {@link CONNECTOR_KINDS} makes one screen over. The server
 * validates against this too: a `strategy` off the wire is `string` until
 * something checks it, and the check and the dropdown reading one list is what
 * stops the two from disagreeing about what is acceptable.
 *
 * **There are three and there is deliberately no fourth.** Tombstones off a
 * change feed is the correct answer and needs machinery nothing here has; a
 * strategy name that nothing implements is a dropdown with a lie in it. See
 * `DeleteReconciliation` for the whole argument.
 */
export const DELETE_RECONCILIATION_STRATEGIES = [
  'accepted',
  'soft-deleted-at-source',
  'periodic-full-reload',
] as const;

export type DeleteReconciliationStrategy = (typeof DELETE_RECONCILIATION_STRATEGIES)[number];

/** Whether a value off the wire names one of the three. */
export function isDeleteReconciliationStrategy(
  value: unknown,
): value is DeleteReconciliationStrategy {
  return (
    typeof value === 'string' &&
    (DELETE_RECONCILIATION_STRATEGIES as readonly string[]).includes(value)
  );
}

/**
 * What an operator sends to set a type's expectation.
 *
 * Both fields optional and both meaning "leave this alone" when absent, which is
 * why they are not simply `LoadExpectation`: a request that omits `rowCount`
 * has said nothing about row counts, and reading that as "clear it" would let a
 * form that only renders the delete strategy silently drop a bound somebody set.
 * Clearing the whole stored row is `DELETE`, which is a decision with a verb on
 * it.
 */
export interface LoadExpectationInput {
  deletes?: DeleteReconciliation;
  rowCount?: Partial<RowCountBound>;
}

/**
 * The resolved expectation for one type, and which layer won each field.
 *
 * The provenance is the whole reason this is not just a `LoadExpectation`. The
 * policy is sourced from three layers — `host.byType[type]`, then the stored row
 * an operator set, then `host.default` — and a screen that showed only the
 * answer would let somebody edit a field this deployment has pinned in code and
 * watch the edit vanish on the next read, with nothing anywhere saying why.
 * {@link hostLocked} is what lets it say "this deployment fixed it" instead.
 */
export interface ResolvedLoadExpectation {
  typeName: string;
  /** The three layers merged, field by field. What the load is actually judged against. */
  resolved: LoadExpectation;
  /**
   * Which layer supplied the delete strategy.
   *
   * `'default'` means the host's house-wide `default` did. `'none'` means
   * nothing did, anywhere — which is not a gap to be filled in silently: it is
   * the state that refuses every incremental load of this type, and the one the
   * screen most needs to name.
   */
  deletesFrom: 'host' | 'stored' | 'default' | 'none';
  /**
   * Which layer supplied the row-count bound — the strongest one that set any
   * field of it, since the three are merged key by key rather than replaced
   * whole.
   *
   * There is no `'none'`, and that is a statement rather than an omission: a
   * bound always applies. Where no layer says anything the built-in
   * `DEFAULT_ROW_COUNT_BOUND` does, and that is what `'default'` covers as well
   * as the host's own `default`.
   */
  rowCountFrom: 'host' | 'stored' | 'default';
  /** The operator's row, present whether or not it won anything. */
  stored?: StoredLoadExpectation;
  /**
   * Which fields this deployment declared in code, per field.
   *
   * True means a stored value for that field would never apply, so the editor
   * shows it disabled and says so. Only `host.byType[type]` locks: `host.default`
   * is the weakest layer and an operator's row beats it, so a house-wide default
   * is not a lock and must not be drawn as one.
   */
  hostLocked: { deletes: boolean; rowCount: boolean };
}

/**
 * Where the per-type expectations sit, relative to wherever the pipeline
 * controller was mounted.
 *
 * A function of the base path rather than a frozen object like
 * {@link catalogRoutes}, and the difference is the one `routes.ts` in the React
 * package draws: the catalog controller's paths cannot move, and these move with
 * whatever `path` the host passed to `CatalogPipelineModule.forRoot` — the
 * routes below are `<path>/pipeline/expectations`, and `/pipeline` is only the
 * default.
 *
 * Two builders for four routes: `PUT` and `DELETE` address the same path a `GET`
 * of one type does, and a builder per verb would be three names for one string.
 */
export function pipelineExpectationRoutes(basePath = '/pipeline') {
  const base = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
  return {
    /** Every stored row, plus the types the host has locked. `GET`, `catalog:read`. */
    expectations: () => `${base}/expectations`,
    /**
     * One type: `GET` for the resolved expectation and its provenance, `PUT` to
     * set the stored row, `DELETE` to drop it. The writes need `catalog:curate`
     * and a signed-in person.
     */
    expectation: (typeName: string) => `${base}/expectations/${encodeURIComponent(typeName)}`,
  } as const;
}
