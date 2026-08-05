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
  WorkflowEdge,
  WorkflowExecutionMode,
  WorkflowGraph,
  WorkflowIssueCode,
  WorkflowNode,
  WorkflowNodeKind,
  WorkflowNodeOutcome,
  WorkflowSinkNode,
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
} from './catalog.pipeline';
export type { WorkflowStatus } from './catalog.pipeline';

// Traces: the same grouping the shipped view renders, so a host writing its own
// activity screen gets the shapes as well as the routes.
export type {
  CatalogTrace,
  CatalogTraceList,
  CatalogTraceOutcome,
  CatalogTraceSpan,
  TraceQuery,
} from './catalog.workspace';
