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
// Mounted on the Model screen too, directly above the expectation section — the
// two are one question in two halves: who loads this type, and what is checked
// when they do. `loadersOf` is exported beside the component because it is the
// whole rule (a graph's SINKS decide, not its stored `targetType`), and a host
// that renders its own row wants the rule rather than a second reading of it.
export {
  LoadedBySection,
  type LoadedBySectionProps,
  loadersOf,
} from './LoadedBySection';
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

// Getting data in: the addresses a pipeline reads through and the code that
// reshapes what it fetches. These used to live in the consuming app, which meant
// any other host installing this package got a console with no way to manage a
// load.
//
// There is deliberately no connector screen here any more. A connector is what a
// published workflow runs as — nothing authors one — so authoring a pipeline is
// `WorkflowCanvas`, on the `/workflow` subpath, and this is the two shared
// objects it borrows.
export {
  ConnectionPanel,
  type ConnectionPanelProps,
  connectionOptionsFor,
  describeConnection,
} from './ConnectionPanel';
// What a connection IS, as data: which kinds can be one, what each needs, and
// the two rules — completeness, and the redaction placeholder — that decide
// whether a form may send one.
//
// Exported because there are two forms now. The console's is here; the source
// node's inspector on the canvas has its own, behind the `/workflow` subpath,
// and a host assembling a third should be reading these rather than restating
// what an S3 connection needs.
export {
  CONNECTABLE_KINDS,
  CONNECTION_KIND_OPTIONS,
  CONNECTION_KINDS,
  type ConnectableKind,
  type ConnectableKindSpec,
  ConnectionCheckResult,
  type ConnectionDraft,
  ConnectionKindFields,
  type ConnectionKindSpec,
  type UnconnectableKindSpec,
  type UpdateDraft,
  connectableSpec,
  connectionConfigFor,
  connectionDraftFrom,
  connectionIsIncomplete,
  redactedCredentialIn,
  toConnectableKind,
} from './connection-form';
// Creating a connection from wherever a source is being configured.
//
// On the root entry and not behind `/workflow`, for the reason
// `SchemaDiscoveryPanel` is: it imports no React Flow, and it is the other half
// of the same offer — the sink's panel makes the type, this makes the address. A
// host assembling its own source inspector should be able to mount either.
export { SourceConnectionCreator } from './source-connection';
export {
  PipelineConsole,
  type PipelineConsoleProps,
} from './PipelineConsole';
// The schema-discovery seam, whole.
//
// `SchemaDiscoveryBridge` is a bridge a HOST may implement — this package cannot
// ask a source for its columns, only render the answer — and every one of these
// was once reachable only through an indexed access on a component's props, or
// by deep-importing a file inside `dist/`. Both are the caller paying for a list
// that fell behind.
//
// `initialChoices` and `proposalFrom` come with them because they are the rules
// that decide whether a schema somebody ticked is one the publish route will
// accept — pure and deliberately outside the panel, per their own docblocks, and
// worth nothing there if the only way to run them is to render it.
//
// `SchemaDiscoveryPanel` is exported for the same reason it stopped living
// inside a screen: the canvas mounts it from behind the `/workflow` subpath, and
// a host assembling its own source inspector should be able to do the same.
export {
  type ColumnChoice,
  type ConnectorSchemaDiscovery,
  type DiscoveredColumn,
  type DiscoveredTypeDraft,
  initialChoices,
  narrowDiscovery,
  proposalFrom,
  type SchemaDiscoveryBridge,
  SchemaDiscoveryPanel,
  type SchemaDrift,
} from './schema-discovery';
export { TransformEditor, type TransformEditorProps } from './TransformEditor';

// Why one load came out different from the last one.
//
// The screens above already carry their own way in — the transform editor, the
// saved-query list, and the `code v3` on a connector run — so a host mounting
// this console needs none of this. It is exported for the host that wants the
// comparison somewhere else: beside its own deploy log, in an approval flow, or
// on a page this package does not ship.
//
// `diffLines` and `foldUnchanged` used to be exported alongside it, on the
// argument that a host wanting to render its own comparison should not have to
// choose between this package's markup and writing an LCS. They are gone: the
// diff is `@pierre/diffs` now, which is a peer dependency a host already has
// installed, and re-exporting a weaker second differ from here would be handing
// out an answer that can disagree with the one this screen shows.
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
  // What a call node's picker offers: one workflow the live fleet announces it
  // can execute, one entry per version. Produced by `GET pipeline/callable-workflows`
  // since durable 0.65.0 gave the engine `announcedWorkflows()`; before that it
  // was a declaration with nothing behind it. Named here because a host writing
  // its own inspector is exactly who needs it.
  type CallableWorkflowRef,
  type CatalogWorkflow,
  describeDurability,
  type DurabilityCopy,
  isWorkflowNodeKind,
  newLocalId,
  nodeName,
  producedTypes,
  WORKFLOW_NODE_ID_PATTERN,
  WORKFLOW_NODE_KINDS,
  type WorkflowCallNode,
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
// Whether what a source reads fits the type its sink writes.
//
// The canvas answers this for itself now — it holds what `discoverSourceSchema`
// returned for each source node and compares it against the snapshot it already
// reads, so there is no prop and nothing for a host to wire. These are exported
// because the comparison is pure and a host may well want it somewhere else: a
// pre-flight before a scheduled run, say. `ConnectorSchemaDiscovery` above is
// already a `SourceShape`, so that caller has one for free.
export {
  checkShapes,
  type ShapeKnowledge,
  type SourceColumn,
  type SourceShape,
  type TargetProperty,
  type TargetShape,
} from './workflow/shape';
// Core's rules, run in the browser, plus the questions core cannot answer:
// whether a connection is legal mid-drag, whether a node names a transform that
// still exists, and whether a source supplies the columns its sink writes.
// Exported so a host can run the same checks before it offers a save — never so
// it can skip the server's, which is the authority.
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
// The prefilled graphs, on this entry point rather than on `/workflow` because
// they import no React Flow: a template produces nodes, edges, transform bodies
// and expectation payloads, and a host should be able to build one — or check
// what it would decide — without installing a canvas to do it. Whether a screen
// then draws the result is the canvas's business, not the template's.
export {
  attachTransformIds,
  buildWorkflowTemplate,
  type EnrichOptions,
  enrichWithLookup,
  fanOutTypes,
  type FanOutOptions,
  type FanOutTarget,
  FILE_DROP_KINDS,
  type FileDropOptions,
  joinSources,
  type JoinOptions,
  loadFileDrop,
  type PeriodicFullReloadOptions,
  periodicFullReload,
  planIsRunnable,
  planToWorkflowInput,
  refuseUnusableColumnNames,
  RELOAD_CADENCE_IDS,
  RELOAD_CADENCES,
  type ReloadCadence,
  replicateTable,
  type ReplicateTableOptions,
  SOURCE_KINDS,
  type TemplateDeclaration,
  type TemplateExpectation,
  type TemplateOutcome,
  type TemplatePlan,
  type TemplateRefusal,
  type TemplateRefusalCode,
  type TemplateRequest,
  type TemplateSchedule,
  type TemplateTransformRequest,
  withinMsFor,
  WORKFLOW_TEMPLATE_IDS,
  WORKFLOW_TEMPLATES,
  type WorkflowTemplateId,
  type WorkflowTemplateMeta,
} from './workflow/templates';

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
  // What `connectionWorkflows` answers with: the pipelines that would break if a
  // connection went. `ConnectorInput` used to sit here and is gone with the
  // routes that took one — see the note where it was declared.
  type ConnectionUse,
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
  // What `listCallableWorkflows` answers with. Mirrored for the same reason
  // `PipelineCapabilities` is, and carrying the `supported` flag that separates
  // "the fleet announces nothing" from "nobody could be asked".
  type CallableWorkflowList,
  // What a stored schedule came back as, and what a manual run may say about
  // itself — including the acknowledgement that lets a deliberately collapsing
  // load past the row-count bound. Named here because they are arguments and
  // answers of `CatalogClient`, and a host driving it directly cannot type
  // either otherwise.
  type ScheduledWorkflow,
  type TransformInput,
  type WorkflowRunOptions,
  type WorkflowScheduleInput,
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
export { Combobox, ComboboxField, type ComboOption, type ComboboxProps } from './ui/combobox';
export { Switch } from './ui/switch';
export { Sheet } from './ui/sheet';
// `codeEditorRoot` and `codeEditorText` come with it because the editor renders
// into a shadow root: without them a host cannot assert on its own screen, and
// every consumer would rediscover the tag name by reading our source.
export {
  CodeEditor,
  type CodeEditorHandle,
  type CodeEditorProps,
  codeEditorRoot,
  codeEditorText,
} from './ui/code-editor';
// The grammars and themes the editor above can be given, which is a shorter list
// than Shiki's and is the reason `dist/spa` is not nine tenths grammar files. A
// host reads `CatalogCodeLanguage` off `CodeEditorProps` anyway; it is named here
// so the set can be asserted against, and so the build plugin that enforces it —
// `@dudousxd/nestjs-catalog-react/bundler` — has something to point at.
export {
  CATALOG_CODE_LANGUAGES,
  CATALOG_CODE_THEMES,
  type CatalogCodeLanguage,
  type CatalogCodeTheme,
  TRANSFORM_HIGHLIGHTED_AS,
} from './ui/code-languages';
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
