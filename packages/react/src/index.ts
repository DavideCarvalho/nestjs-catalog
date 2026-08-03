export { CatalogManager, type CatalogManagerProps } from './CatalogManager';
export { CoverageLedger } from './CoverageLedger';
export { EditableField } from './EditableField';
export { cn } from './cn';
export { ObjectExplorer, type ObjectExplorerProps } from './ObjectExplorer';
export { DashboardBoard } from './DashboardBoard';
export {
  CHART_COLORS,
  type ChartRenderer,
  type ChartRendererProps,
  getChartRenderer,
  registerChartRenderer,
  registeredChartLibraries,
  seriesFrom,
} from './charts/registry';
export {
  ChartEmpty,
  ChartFailed,
  ChartSkeleton,
  type ChartSkeletonProps,
} from './charts/skeleton';
// The fallback every other renderer degrades to, and the guard that decides
// when a time-scale chart cannot draw what a saved query asked for.
export { CssBarChart, looksLikeTimeSeries } from './charts/css';
export { FlowView } from './FlowView';
export { GovernanceTimeline } from './GovernanceTimeline';
export { QueryConsole, type QueryConsoleProps } from './QueryConsole';
export { SavedQueryPanel } from './SavedQueryPanel';
export {
  CATALOG_EVENT_META,
  type CatalogTraceSource,
  eventMeta,
  TraceExplorer,
  useTraceSource,
} from './TraceExplorer';

// Getting data in: connections, connectors and the code that reshapes what they
// fetch. These used to live in the consuming app, which meant any other host
// installing this package got a console with no way to manage a load.
export {
  ConnectionPanel,
  type ConnectionPanelProps,
  connectionOptionsFor,
  describeConnection,
} from './ConnectionPanel';
export { PipelineConsole, type PipelineConsoleProps } from './PipelineConsole';
export { TransformEditor, type TransformEditorProps } from './TransformEditor';
export { AccessConsole, type AccessConsoleProps } from './AccessConsole';

// The authored graph: sources wired through transforms into sinks.
//
// `<WorkflowCanvas />` itself is **not** exported here. It imports
// `@xyflow/react`, which is an optional peer, and anything reachable from this
// entry point is resolved by the host's bundler whether or not the host renders
// it — so exporting it here would make every consumer install React Flow to
// build at all. It lives on its own subpath instead, exactly as the chart
// renderers do:
//
//     import { WorkflowCanvas } from "@dudousxd/nestjs-catalog-react/workflow";
//
// The model, the name and the validation rules have no React Flow import and
// stay here, so a host can talk about a workflow — or check one — without
// installing a canvas.
//
// Deliberately not named after `FlowView`, which derives lineage from what
// publishers actually did; this executes a graph somebody wrote.
//
// Most of what follows is re-exported from `@dudousxd/nestjs-catalog/client`
// rather than declared here — a node, an edge and a graph have one definition,
// and it belongs to the package that executes them. See `workflow/model.ts`.
export {
  type CatalogWorkflow,
  describeDurability,
  isWorkflowNodeKind,
  newLocalId,
  nodeName,
  producedTypes,
  WORKFLOW_NODE_ID_PATTERN,
  WORKFLOW_NODE_KINDS,
  type WorkflowDurability,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowInput,
  type WorkflowNode,
  type WorkflowNodeKind,
  type WorkflowRun,
  type WorkflowRunNode,
  type WorkflowSinkNode,
  type WorkflowSourceNode,
  type WorkflowTransformNode,
} from './workflow/model';
export { WORKFLOW_NAME } from './workflow/name';
// Core's rules, run in the browser, plus the two questions core cannot answer:
// whether a connection is legal mid-drag, and whether a node names a transform
// that still exists. Exported so a host can run the same checks before it offers
// a save — never so it can skip the server's, which is the authority.
export {
  canConnect,
  type ConnectionVerdict,
  edgeId,
  hasBlockingProblem,
  problemsByNode,
  validateWorkflow,
  type WorkflowProblem,
  type WorkflowProblemCode,
  wouldCycle,
} from './workflow/validate';

export {
  type CatalogClient,
  type CatalogIdentity,
  type CatalogPersonRole,
  type CatalogPersonSummary,
  type CatalogPrincipalSummary,
  CatalogProvider,
  type CatalogProviderProps,
  type CatalogTransport,
  type ConnectionInput,
  type ConnectorInput,
  catalogQueryKeys,
  type PersonInput,
  type PersonUpsertResult,
  type PipelineCapabilities,
  type TransformInput,
  useCatalogClient,
} from './context';

// The paths behind the pipeline and access screens, exported so a host can
// mount those endpoints wherever it likes and tell the provider where they are.
// See routes.ts for why they are here rather than in the server package.
export {
  type AccessRoutes,
  accessRoutes,
  DEFAULT_ACCESS_BASE_PATH,
  DEFAULT_PIPELINE_BASE_PATH,
  type PipelineRoutes,
  pipelineRoutes,
} from './routes';

// The vendored primitives. Exported because a host composing its own screen out
// of this package's parts should not have to rebuild a tooltip to match.
export { ConfirmDialog } from './ui/dialog';
export { FieldGroup, TextAreaField, TextField } from './ui/field';
export { Select, SelectField, type SelectOption } from './ui/select';
export { Switch } from './ui/switch';
export { Sheet } from './ui/sheet';
export { Tabs, TabsList, TabsPanel, TabsTab } from './ui/tabs';
export { Tooltip, TooltipProvider } from './ui/tooltip';
