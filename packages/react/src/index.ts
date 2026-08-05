export { CatalogManager, type CatalogManagerProps } from './CatalogManager';
export { CoverageLedger } from './CoverageLedger';
export { EditableField } from './EditableField';
// Mounted on the Model screen already. Exported because a host that builds its
// own type panel out of this package's parts should not have to rebuild the one
// section that can say an incremental load of a type is currently refused.
export {
  DELETE_STRATEGIES,
  LoadExpectationSection,
  type LoadExpectationSectionProps,
} from './LoadExpectationSection';
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
// Embedding: the same charts, in an application that is not this one. Output
// only — see src/embed/actions.ts for what an embed deliberately cannot do.
export {
  EMBED_ACTIONS,
  type EmbedAction,
  type EmbedActions,
  EmbeddedChart,
  type EmbeddedChartPayload,
  type EmbeddedChartProps,
  EmbeddedDashboard,
  type EmbeddedDashboardPayload,
  type EmbeddedDashboardProps,
  type EmbedFailureSlot,
  type EmbedLoadingSlot,
  chartsInLayoutOrder,
  resolveEmbedActions,
} from './embed';
export { FlowView } from './FlowView';
export { GovernanceTimeline } from './GovernanceTimeline';
export { QueryConsole, type QueryConsoleProps } from './QueryConsole';
// One box across the whole catalog: types, properties, saved queries, boards.
// Not mounted anywhere by this package — a host places it wherever its shell
// wants a search, and tells it where each kind of thing lives with the same
// `explorerHref` shape `CatalogManager` takes.
export { CatalogSearch, type CatalogSearchProps } from './search-console';
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
// The schema-discovery seam, whole.
//
// `PipelineConsoleProps['schemaDiscovery']` is a bridge the HOST implements —
// this package cannot ask a connector for its columns, only render the answer —
// and every one of these was reachable from that prop's type and from nowhere
// else. So the only way to write the bridge with its signature spelled out was
// to name it through an indexed access on a component's props, or to deep-import
// a file inside `dist/`. Both are the caller paying for a list that fell behind.
//
// `initialChoices` and `proposalFrom` come with them because they are the rules
// that decide whether a schema somebody ticked is one the publish route will
// accept — pure and deliberately outside the panel, per their own docblocks, and
// worth nothing there if the only way to run them is to render it.
export {
  type ColumnChoice,
  type ConnectorSchemaDiscovery,
  type DiscoveredColumn,
  type DiscoveredTypeDraft,
  initialChoices,
  PipelineConsole,
  type PipelineConsoleProps,
  proposalFrom,
  type SchemaDiscoveryBridge,
  type SchemaDrift,
} from './PipelineConsole';
export { TransformEditor, type TransformEditorProps } from './TransformEditor';

// Why one load came out different from the last one.
//
// The screens above already carry their own way in — the transform editor, the
// saved-query list, and the `code v3` on a connector run — so a host mounting
// this console needs none of this. It is exported for the host that wants the
// comparison somewhere else: beside its own deploy log, in an approval flow, or
// on a page this package does not ship.
//
// `diffLines` and `foldUnchanged` are pure and come with it deliberately. They
// are the whole of the algorithm, they take no dependency and reach no network,
// and a host that wants to render a comparison its own way should not have to
// choose between this package's markup and writing an LCS.
export {
  DiffBody,
  RevisionHistory,
  type RevisionHistoryProps,
  RevisionHistoryButton,
  RevisionHistorySheet,
  type RevisionHistorySheetProps,
  type RevisionSubject,
  type RevisionSubjectKind,
} from './diff/RevisionDiff';
export {
  DIFF_CONTEXT_LINES,
  DIFF_MAX_CELLS,
  DIFF_MIN_FOLD,
  type DiffLine,
  type DiffOp,
  type DiffSection,
  diffLines,
  foldUnchanged,
  type LineDiff,
} from './diff/line-diff';
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
  type DurabilityCopy,
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
  type ValidateOptions,
  validateWorkflow,
  type WorkflowDraft,
  type WorkflowProblem,
  type WorkflowProblemCode,
  type WorkflowProblemLevel,
  wouldCycle,
} from './workflow/validate';

export {
  type CatalogClient,
  type CatalogIdentity,
  // One saved version of a transform's code or a saved query's SQL. Owned by
  // `@dudousxd/nestjs-catalog/client` and re-exported through context.tsx, so a
  // host typing what this client returns need not know which of the two packages
  // declares which shape.
  type CatalogRevision,
  // What `CatalogClient.listPeople` answers with. The interface was exported and
  // the shape of its one paged reply was not, so a host writing a user table
  // could name the client and not the page — and the honest workaround, typing
  // the state as `CatalogPersonSummary[]`, is the exact mistake that method's
  // docblock warns about: it drops `total` and under-reports who has access.
  type CatalogPeoplePage,
  type CatalogPersonRole,
  type CatalogPersonSummary,
  type CatalogPrincipalSummary,
  CatalogProvider,
  type CatalogProviderProps,
  type CatalogTransport,
  type ConnectionInput,
  type ConnectorInput,
  catalogQueryKeys,
  // The load-expectation shapes. Mirrored from the pipeline package for the
  // reason `PipelineCapabilities` is — see their docblocks in context.tsx —
  // and exported so a host writing its own panel can name what the four
  // `expectations` routes answer with.
  type DeleteReconciliation,
  type LoadExpectation,
  type LoadExpectationInput,
  type ResolvedLoadExpectation,
  type RowCountBound,
  type StoredLoadExpectation,
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
  // The third default, which had been left out while its two siblings were
  // exported — so `CatalogProviderProps.publishBasePath` was documented as
  // defaulting to a constant a host could not name, and the way to override it
  // relative to the default was to retype the string and hope.
  DEFAULT_PUBLISH_BASE_PATH,
  // The embed paths, which the catalog controller does serve — exported so a
  // host writing its own embed consumer need not restate them. See routes.ts.
  embedRoutes,
  // The one argument `AccessRoutes.people` and `CatalogClient.listPeople` take.
  type PeopleQuery,
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
export { CodeEditor, type CodeEditorProps } from './ui/code-editor';
export {
  RichTextField,
  RichTextView,
  type RichTextFieldProps,
} from './ui/rich-text-field';
export { Button, type ButtonProps, type ButtonSize, type ButtonVariant } from './ui/button';
export { Tabs, TabsList, TabsPanel, TabsTab } from './ui/tabs';
export { Tooltip, TooltipProvider } from './ui/tooltip';

// Getting a chart out of the console as a file.
//
// PNG needs no dependency at all — a serialised SVG, a canvas and `toBlob` are
// already in every browser. Two limits are worth knowing before offering it: an
// SVG rasterised through a data URI cannot load `@font-face`, so exported text
// falls back to a system face; and the built-in CSS bar chart draws with divs
// rather than an `<svg>`, so it cannot be exported at all.
//
// PDF is a SEAM, not a renderer. This package takes no PDF dependency — the
// two candidates cost ~128KB gzipped on every consumer for a feature only some
// want, which is the same argument `charts/registry.tsx` makes about chart
// libraries. The host registers something backed by its own document pipeline,
// and where nobody did, no PDF action appears.
export {
  buildChartPdfSource,
  canRasterise,
  type ChartPdfExporter,
  type ChartPdfSource,
  defaultPngFilename,
  downloadSvgAsPng,
  type ExportBackground,
  exportSvgAsPdf,
  findExportableSvg,
  getPdfExporter,
  type PdfExport,
  type PdfSourceOptions,
  type PngExport,
  type PngExportOptions,
  type PngExportTarget,
  rasteriseSerializedSvg,
  registerPdfExporter,
  serializeSvg,
  subscribeToPdfExporter,
  type SvgRasteriser,
  svgToPngBlob,
  useHasExportableSvg,
  usePdfExport,
  usePngExport,
} from './export';
