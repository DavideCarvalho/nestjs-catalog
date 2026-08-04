import type {
  CatalogConnection,
  CatalogTransform,
  ConnectorKind,
} from '@dudousxd/nestjs-catalog/client';
import {
  Background,
  BackgroundVariant,
  type Connection,
  ConnectionLineType,
  Controls,
  type EdgeChange,
  MiniMap,
  type NodeChange,
  type OnConnectEnd,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react';
// React Flow ships its own stylesheet and renders as an unstyled pile of divs
// without it — no edges, every node at the top-left corner. Imported by the
// component that needs it rather than left to the host, because a missing
// stylesheet does not error and the host that forgets has nothing to go on.
// See src/styles.d.ts for why `tsc` tolerates this import.
import '@xyflow/react/dist/style.css';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight,
  CircleAlert,
  Code2,
  Database,
  LayoutGrid,
  Loader2,
  Play,
  Plug,
  Plus,
  Repeat,
  Save,
  Trash2,
  TriangleAlert,
  Unplug,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TransformEditor } from './TransformEditor';
import { cn } from './cn';
import { catalogQueryKeys, useCatalogClient } from './context';
import {
  CredentialField,
  INLINE_CONNECTION,
  KIND_OPTIONS,
  ReadModeFields,
  type SourceDraft,
  SourceFields,
  connectionOptions,
  readsIncrementally,
  sourceConfigFrom,
  sourceDraftFrom,
  toConnectorKind,
  usesConnection,
} from './source-fields';
import { ConfirmDialog } from './ui/dialog';
import { TextField } from './ui/field';
import { Select, SelectField, type SelectOption } from './ui/select';
import { Sheet } from './ui/sheet';
import { Tooltip, TooltipProvider } from './ui/tooltip';
import {
  type NodeDescriptions,
  type WorkflowFlowEdge,
  type WorkflowFlowNode,
  defaultLabel,
  layout,
  layoutIfUnarranged,
  nextPosition,
  toFlowEdges,
  toFlowNodes,
} from './workflow/graph';
import {
  type CatalogWorkflow,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowNodeKind,
  type WorkflowRun,
  type WorkflowSinkNode,
  type WorkflowSourceNode,
  type WorkflowTransformNode,
  describeDurability,
  isWorkflowNodeKind,
  newLocalId,
  nodeName,
  producedTypes,
} from './workflow/model';
import { WORKFLOW_NAME } from './workflow/name';
import { WorkflowNodeProvider, workflowNodeTypes } from './workflow/nodes';
import {
  type WorkflowProblem,
  canConnect,
  edgeId,
  hasBlockingProblem,
  problemsByNode,
  validateWorkflow,
} from './workflow/validate';

const MUTED = 'text-zinc-400 dark:text-zinc-500';
const RULE = 'border-zinc-200 dark:border-zinc-800';
const PANEL = 'bg-white dark:bg-zinc-900';

/**
 * The value the workflow picker uses for "start a fresh one".
 *
 * A sentinel rather than a null option, because Base UI's select hands back the
 * item's value and a null there is indistinguishable from a cleared select.
 */
const NEW_WORKFLOW = '__new__';

/**
 * React Flow's own theme, expressed as overrides of its CSS variables.
 *
 * Driven by the host's `dark:` class rather than by React Flow's `colorMode`
 * prop, and that is the whole point. `colorMode="system"` follows the operating
 * system, which is not the same thing as the app's theme: a host whose user has
 * chosen light inside an app on a dark desktop would get a dark canvas embedded
 * in a light page. Tying the variables to `dark:` means the canvas is dark
 * exactly when everything around it is.
 */
const CANVAS_THEME = cn(
  '[--xy-background-color:#fafafa] dark:[--xy-background-color:#09090b]',
  '[--xy-background-pattern-color:#d4d4d8] dark:[--xy-background-pattern-color:#3f3f46]',
  '[--xy-edge-stroke:#a1a1aa] dark:[--xy-edge-stroke:#52525b]',
  '[--xy-edge-stroke-selected:#8b5cf6] dark:[--xy-edge-stroke-selected:#a78bfa]',
  '[--xy-connectionline-stroke:#8b5cf6] dark:[--xy-connectionline-stroke:#a78bfa]',
  '[--xy-controls-button-background-color:#ffffff] dark:[--xy-controls-button-background-color:#18181b]',
  '[--xy-controls-button-background-color-hover:#f4f4f5] dark:[--xy-controls-button-background-color-hover:#27272a]',
  '[--xy-controls-button-color:#52525b] dark:[--xy-controls-button-color:#a1a1aa]',
  '[--xy-controls-button-border-color:#e4e4e7] dark:[--xy-controls-button-border-color:#27272a]',
  '[--xy-minimap-background-color:#ffffff] dark:[--xy-minimap-background-color:#18181b]',
  '[--xy-minimap-node-background-color:#d4d4d8] dark:[--xy-minimap-node-background-color:#52525b]',
  '[--xy-minimap-mask-background-color:rgba(244,244,245,0.7)] dark:[--xy-minimap-mask-background-color:rgba(24,24,27,0.7)]',
  '[--xy-attribution-background-color:transparent]',
  '[--xy-selection-background-color:rgba(139,92,246,0.08)]',
  '[--xy-selection-border:1px_dotted_#8b5cf6]',
);

/**
 * React Flow's built-in screen-reader copy, replaced with copy that says what
 * the keys actually do here.
 *
 * The default node description talks about arrow keys and nothing else, which
 * leaves the one thing a keyboard user cannot discover — that wiring is done
 * from the inspector, not from the canvas — entirely unsaid.
 */
const ARIA_LABELS = {
  'node.a11yDescription.default':
    "Press Enter to open this node's inspector, where it can be renamed, wired to another node and deleted. Press the arrow keys to move it. Press Delete to remove it.",
  'controls.ariaLabel': 'Canvas controls',
  'minimap.ariaLabel': `Overview of the ${WORKFLOW_NAME.singular}`,
};

interface Draft {
  /** Absent until the server has stored it once. */
  id?: string;
  name: string;
  description: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  /** Which stored version this was loaded from, for the "v2 next" hint. */
  version?: number;
  dirty: boolean;
}

function blankDraft(): Draft {
  return { name: '', description: '', nodes: [], edges: [], dirty: false };
}

function draftFrom(workflow: CatalogWorkflow): Draft {
  return {
    id: workflow.id,
    name: workflow.name,
    description: workflow.description ?? '',
    // Copied rather than referenced: the query cache owns the objects it
    // returned, and mutating a node's position in place would edit the cached
    // workflow, so a background refetch would silently "confirm" edits that
    // were never saved.
    //
    // Arranged on the way in, when nothing has arranged it. A graph created
    // through the API — by a scheduler, by a promotion, by a script — carries no
    // positions, and drawing those at the origin stacks every node on the first
    // one and makes a perfectly ordinary DAG read as a loop. See
    // `layoutIfUnarranged`.
    nodes: layoutIfUnarranged(
      workflow.nodes.map((node) => ({
        ...node,
        position: node.position ? { ...node.position } : undefined,
      })),
      workflow.edges,
    ),
    edges: workflow.edges.map((edge) => ({ from: edge.from, to: edge.to })),
    version: workflow.version,
    dirty: false,
  };
}

export interface WorkflowCanvasProps {
  /** Heading copy, so the host can call this whatever its users call it. */
  title?: string;
  eyebrow?: string;
  intro?: string;
  /**
   * Set false where the viewer is known to be read-only. The endpoints refuse
   * regardless; this only stops the canvas offering controls that always 403.
   */
  canEdit?: boolean;
}

/**
 * Transforms wired to each other, ending at one or more sinks.
 *
 * Deliberately **not** called Flow. `FlowView` in this package is a *derived*
 * picture — it reconstructs who feeds what from the audit trail, and argues in
 * its own comment that inferring the graph from what publishers actually did is
 * more truthful than a diagram somebody maintains. This screen is the opposite
 * claim: a graph a person authors and the server then executes. Sharing a name
 * would leave two screens making opposite promises about where the truth is.
 * See `workflow/name.ts`.
 */
export function WorkflowCanvas(props: WorkflowCanvasProps) {
  return (
    <TooltipProvider>
      {/*
       * The provider is here rather than inside the canvas component because
       * `useReactFlow` — which the inspector's fit-view needs — only works
       * under it, and putting it inside would mean the hook and the provider
       * are in the same component, which React Flow refuses.
       */}
      <ReactFlowProvider>
        <Canvas {...props} />
      </ReactFlowProvider>
    </TooltipProvider>
  );
}

/**
 * The selection after a batch of React Flow `select` changes.
 *
 * React Flow reports selection one id at a time, and both nodes and edges use
 * the same shape for it, so folding the batch here keeps one description of what
 * selecting means. Returns the array it was given when nothing selected,
 * so an unrelated batch of changes does not re-render the canvas.
 */
function nextSelection(
  current: string[],
  changes: (NodeChange<WorkflowFlowNode> | EdgeChange<WorkflowFlowEdge>)[],
): string[] {
  let next = current;
  for (const change of changes) {
    if (change.type !== 'select') continue;
    next = change.selected
      ? [...new Set([...next, change.id])]
      : next.filter((id) => id !== change.id);
  }
  return next;
}

/**
 * A fresh node of one kind, carrying only the fields that kind has.
 *
 * Built per kind rather than as one shape with optional fields, because the
 * executable model is a discriminated union: a source carries a source kind and
 * a config, a transform carries a transform, a sink carries the type it commits,
 * and nothing carries a field belonging to another kind.
 */
function newNodeOfKind(
  kind: WorkflowNodeKind,
  id: string,
  position: { x: number; y: number },
): WorkflowNode {
  const name = defaultLabel(kind);
  if (kind === 'source') {
    return { id, name, kind: 'source', sourceKind: 'http', config: {}, position };
  }
  if (kind === 'transform') {
    return { id, name, kind: 'transform', transformId: '', position };
  }
  return { id, name, kind: 'sink', targetType: '', position };
}

/**
 * A server refusal, verbatim.
 *
 * The server knows things this canvas does not — which types exist, who may
 * write to them, whether a transform's output fits the sink — so its wording is
 * the useful one, not a generic "could not save".
 */
function RefusalNote({ lead, error }: { lead: string; error: unknown }) {
  return (
    <p className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-1.5 text-[11px] text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
      {lead} {error instanceof Error ? error.message : 'no reason given.'}
    </p>
  );
}

/**
 * Save, run, delete.
 *
 * Save is deliberately **not** disabled when the local checks fail. Disabling
 * would make this screen the gate, and the checks beside the canvas cannot see
 * everything the server sees — a rule that is subtly wrong here would become a
 * graph nobody can save at all, with no error to read. The button is coloured to
 * warn and the tooltip says what will happen; the refusal, when it comes, comes
 * from the server with its reasons.
 */
function CanvasActions({
  draft,
  canEdit,
  blocked,
  saving,
  running,
  durabilityDetail,
  onSave,
  onRun,
  onAskDelete,
}: {
  draft: Draft;
  canEdit: boolean;
  blocked: boolean;
  saving: boolean;
  running: boolean;
  durabilityDetail: string;
  onSave: () => void;
  onRun: () => void;
  onAskDelete: () => void;
}) {
  return (
    <div className="flex flex-wrap items-start gap-2 self-end pb-1">
      <Tooltip
        content={
          blocked
            ? 'There are errors listed beside the canvas, and the server will almost certainly refuse this. Sending it anyway is allowed — the server decides, not this screen.'
            : 'Store it. The server checks it again, and its answer is the one that counts.'
        }
      >
        <button
          type="button"
          onClick={onSave}
          disabled={
            !canEdit ||
            saving ||
            draft.name.trim().length === 0 ||
            (!draft.dirty && Boolean(draft.id))
          }
          className={cn(
            'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs disabled:opacity-40',
            blocked
              ? 'bg-amber-600 text-white'
              : 'bg-zinc-950 text-zinc-50 dark:bg-zinc-100 dark:text-zinc-950',
          )}
        >
          {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
          {draft.dirty ? 'Save' : 'Saved'}
        </button>
      </Tooltip>
      <Tooltip
        content={
          draft.dirty
            ? 'Save first — a run executes the stored graph, not what is on screen.'
            : durabilityDetail
        }
      >
        <button
          type="button"
          onClick={onRun}
          disabled={!canEdit || !draft.id || draft.dirty || running}
          className={cn(
            'flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs disabled:opacity-40',
            RULE,
            'hover:bg-zinc-50 dark:hover:bg-zinc-800',
          )}
        >
          {running ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
          Run
        </button>
      </Tooltip>
      {draft.id && canEdit && (
        <Tooltip content={`Delete this ${WORKFLOW_NAME.singular}.`}>
          <button
            type="button"
            onClick={onAskDelete}
            aria-label={`Delete this ${WORKFLOW_NAME.singular}`}
            className={cn('rounded-md border p-1.5 text-zinc-400 hover:text-red-600', RULE)}
          >
            <Trash2 size={12} />
          </button>
        </Tooltip>
      )}
    </div>
  );
}

/** The three things that can be put on the canvas, and the button that tidies them. */
function AddNodeBar({
  refreshing,
  onAdd,
  onTidy,
}: {
  refreshing: boolean;
  onAdd: (kind: WorkflowNodeKind) => void;
  onTidy: () => void;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 px-6 pt-3">
      <AddButton
        icon={Plug}
        label="Source"
        hint="Reads records out of a system: a kind, an optional named connection, and a config."
        onClick={() => onAdd('source')}
      />
      <AddButton
        icon={Repeat}
        label="Transform"
        hint="Code that reshapes whatever is wired into it."
        onClick={() => onAdd('transform')}
      />
      <AddButton
        icon={Database}
        label="Sink"
        hint="Writes and commits one object type. Several are fine — each commits independently."
        onClick={() => onAdd('sink')}
      />
      <Tooltip content="Lay the nodes out left to right by dependency, with every sink in the last column.">
        <button
          type="button"
          onClick={onTidy}
          className={cn(
            'flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs',
            RULE,
            MUTED,
            'hover:bg-zinc-50 dark:hover:bg-zinc-800',
          )}
        >
          <LayoutGrid size={12} />
          Tidy
        </button>
      </Tooltip>
      {refreshing && (
        // A background refetch says so without replacing anything: the graph on
        // screen stays exactly where it is.
        <span className={cn('ml-auto font-mono text-[10px]', MUTED)}>refreshing…</span>
      )}
    </div>
  );
}

/**
 * Which workflow the screen should be showing.
 *
 * Falls through to the first stored one so an empty picker opens on something
 * rather than on a blank canvas, and to the new-workflow sentinel when there is
 * nothing stored at all.
 */
function wantedWorkflowId(list: CatalogWorkflow[], selected: string): string {
  return selected || list[0]?.id || NEW_WORKFLOW;
}

/** The draft for a chosen id: the stored graph, or a blank one if there is none. */
function draftForId(list: CatalogWorkflow[], wanted: string): Draft {
  if (wanted === NEW_WORKFLOW) return blankDraft();
  const found = list.find((workflow) => workflow.id === wanted);
  return found ? draftFrom(found) : blankDraft();
}

/**
 * The minimap dot colour for a node, by kind.
 *
 * Narrowed rather than asserted: MiniMap types `data` as an open record, and a
 * bad `kind` here would be a thrown error inside React Flow's own render rather
 * than a mis-coloured dot.
 */
function miniMapColor(data: { kind?: unknown } | undefined): string {
  const kind = data?.kind;
  if (!isWorkflowNodeKind(kind)) return '#a1a1aa';
  if (kind === 'source') return '#0ea5e9';
  if (kind === 'sink') return '#10b981';
  return '#8b5cf6';
}

/**
 * The graph itself, and the two states in which there is no graph to draw.
 *
 * Loading and failure are drawn inside the canvas's own frame rather than in
 * place of the screen, so the header and its controls stay put while a refetch
 * resolves — and a failed read never looks like an empty workflow.
 */
function GraphSurface({
  loading,
  failed,
  error,
  onRetry,
  canEdit,
  draft,
  flowNodes,
  flowEdges,
  onInspect,
  onEditCode,
  onNodesChange,
  onEdgesChange,
  onConnect,
  isValidConnection,
  onConnectEnd,
}: {
  loading: boolean;
  failed: boolean;
  error: unknown;
  onRetry: () => void;
  canEdit: boolean;
  draft: Draft;
  flowNodes: WorkflowFlowNode[];
  flowEdges: WorkflowFlowEdge[];
  onInspect: (id: string) => void;
  onEditCode: (id: string) => void;
  onNodesChange: (changes: NodeChange<WorkflowFlowNode>[]) => void;
  onEdgesChange: (changes: EdgeChange<WorkflowFlowEdge>[]) => void;
  onConnect: (connection: Connection) => void;
  isValidConnection: (candidate: { source: string | null; target: string | null }) => boolean;
  onConnectEnd: OnConnectEnd;
}) {
  return (
    <div
      className={cn(
        'relative h-[55vh] min-h-[15rem] shrink-0 overflow-hidden rounded-lg border',
        'lg:h-auto lg:min-h-0 lg:flex-1 lg:shrink',
        RULE,
      )}
    >
      {loading && <CanvasSkeleton />}

      {failed && <CanvasFailure error={error} onRetry={onRetry} />}

      {!loading && !failed && (
        <WorkflowNodeProvider handlers={{ onInspect, onEditCode, canEdit }}>
          <ReactFlow
            className={CANVAS_THEME}
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={workflowNodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            isValidConnection={isValidConnection}
            onConnectEnd={onConnectEnd}
            connectionLineType={ConnectionLineType.SmoothStep}
            nodesDraggable={canEdit}
            nodesConnectable={canEdit}
            elementsSelectable
            nodesFocusable
            edgesFocusable
            deleteKeyCode={canEdit ? ['Delete', 'Backspace'] : null}
            // A wider drop zone than the 20px default, because these handles are
            // the only drop target on the screen and missing one reads as the
            // canvas ignoring you.
            connectionRadius={28}
            proOptions={{ hideAttribution: false }}
            ariaLabelConfig={ARIA_LABELS}
            aria-label={`${WORKFLOW_NAME.title} canvas. ${draft.nodes.length} nodes, ${draft.edges.length} connections.`}
            fitView
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable nodeColor={(node) => miniMapColor(node.data)} />
          </ReactFlow>
        </WorkflowNodeProvider>
      )}
    </div>
  );
}

/** A node's display name, falling back to its id when it is not in the graph. */
function nodeLabelIn(nodes: WorkflowNode[], id: string): string {
  const found = nodes.find((candidate) => candidate.id === id);
  return found ? nodeName(found) : id;
}

/**
 * What this graph commits, read off the sinks.
 *
 * A summary and never a control. The type is set on the sink that commits it,
 * because a graph may have several sinks writing several types and a single
 * field at the top of the screen could only ever name one of them.
 */
function CommitsBadge({ produces }: { produces: string[] }) {
  if (produces.length === 0) return null;
  return (
    <Tooltip
      content={`Read off the sinks. Each one commits its own type independently — a run that writes ${produces[0]} and fails on another is a failed run that committed ${produces[0]}, not a success.`}
    >
      <span className={cn('font-mono text-[10px]', MUTED)}>commits {produces.join(', ')}</span>
    </Tooltip>
  );
}

/** Where React Flow moved nodes to, and which it removed, out of one batch. */
function nodeMovesAndRemovals(changes: NodeChange<WorkflowFlowNode>[]): {
  positions: Map<string, { x: number; y: number }>;
  removed: Set<string>;
} {
  const positions = new Map<string, { x: number; y: number }>();
  const removed = new Set<string>();
  for (const change of changes) {
    if (change.type === 'position' && change.position) {
      positions.set(change.id, change.position);
    }
    if (change.type === 'remove') removed.add(change.id);
  }
  return { positions, removed };
}

function Canvas({
  title = WORKFLOW_NAME.titlePlural,
  eyebrow = 'Ingestion',
  intro = 'Wire sources through transforms into sinks. Each sink commits its own object type independently, so one expensive read can feed several outputs.',
  canEdit = true,
}: WorkflowCanvasProps) {
  const client = useCatalogClient();
  const queryClient = useQueryClient();
  const { fitView } = useReactFlow();

  const workflows = useQuery({
    queryKey: catalogQueryKeys.workflows,
    queryFn: () => client.listWorkflows(),
  });
  const { data: transforms = [] } = useQuery({
    queryKey: catalogQueryKeys.transforms,
    queryFn: () => client.listTransforms(),
    staleTime: 30_000,
  });
  const { data: connections = [] } = useQuery({
    queryKey: catalogQueryKeys.connections,
    queryFn: () => client.listConnections(),
    staleTime: 30_000,
  });
  const { data: capabilities } = useQuery({
    queryKey: catalogQueryKeys.capabilities,
    queryFn: () => client.pipelineCapabilities(),
    // Which languages an image can execute, and whether a durable engine is
    // wired up, cannot change without a redeploy — and a redeploy reloads the
    // page. Refetching would be a request that can only return the same answer.
    staleTime: Number.POSITIVE_INFINITY,
  });
  const { data: snapshot } = useQuery({
    queryKey: catalogQueryKeys.snapshot,
    queryFn: () => client.snapshot(),
    staleTime: 30_000,
  });

  const [selected, setSelected] = useState<string>('');
  const [draft, setDraft] = useState<Draft>(blankDraft);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<string[]>([]);
  const [inspecting, setInspecting] = useState<string | null>(null);
  const [editingCodeFor, setEditingCodeFor] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [run, setRun] = useState<WorkflowRun | null>(null);
  /**
   * The last thing the canvas refused, and the last thing it did.
   *
   * One string, announced politely, because a canvas gives no other feedback to
   * somebody who cannot see it: a refused drag is silence, and a node added off
   * screen is silence too.
   */
  const [announcement, setAnnouncement] = useState('');

  /**
   * Which workflow the draft was built from.
   *
   * A ref rather than state so that a background refetch — which produces a new
   * array with the same ids — does not re-enter the load branch and throw away
   * everything somebody has moved since.
   */
  const loadedRef = useRef<string | null>(null);

  useEffect(() => {
    const list = workflows.data;
    if (!list) return;
    const wanted = wantedWorkflowId(list, selected);
    if (loadedRef.current === wanted) return;
    loadedRef.current = wanted;
    if (selected !== wanted) setSelected(wanted);
    setDraft(draftForId(list, wanted));
    setSelectedNodeIds([]);
    setSelectedEdgeIds([]);
    setInspecting(null);
    setRun(null);
  }, [workflows.data, selected]);

  // Fit after the graph swaps, on the frame after the new nodes have been laid
  // out. Calling it in the same tick fits an empty canvas, because React Flow
  // has not measured anything yet.
  const draftId = draft.id;
  // `draftId` is the trigger, not a value the body reads — which is exactly why
  // the rule calls it unnecessary. Dropping it would fit the view once on mount
  // and never again, leaving every workflow opened afterwards off-screen.
  // biome-ignore lint/correctness/useExhaustiveDependencies: draftId is what the effect watches for, not something its body uses
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => fitView({ padding: 0.25, duration: 200 }));
    return () => window.cancelAnimationFrame(frame);
  }, [draftId, fitView]);

  const edit = useCallback((change: (current: Draft) => Draft) => {
    setDraft((current) => ({ ...change(current), dirty: true }));
  }, []);

  const transformIds = useMemo(
    () => new Set(transforms.map((transform) => transform.id)),
    [transforms],
  );

  const problems = useMemo(
    () => validateWorkflow({ nodes: draft.nodes, edges: draft.edges }, { transformIds }),
    [draft.nodes, draft.edges, transformIds],
  );
  const problemsFor = useMemo(() => problemsByNode(problems), [problems]);
  const brokenEdgeIds = useMemo(
    () => new Set(problems.flatMap((problem) => problem.edgeIds)),
    [problems],
  );
  const runFor = useMemo(
    () => new Map((run?.nodes ?? []).map((node) => [node.nodeId, node])),
    [run],
  );

  const describe = useMemo<NodeDescriptions>(
    () => ({
      transformName: (id) => (id ? transforms.find((t) => t.id === id)?.name : undefined),
      connectionName: (id) => (id ? connections.find((c) => c.id === id)?.name : undefined),
    }),
    [transforms, connections],
  );

  const flowNodes = useMemo<WorkflowFlowNode[]>(() => {
    const selectedIds = new Set(selectedNodeIds);
    return toFlowNodes(draft.nodes, draft.edges, describe, problemsFor, runFor).map((node) => ({
      ...node,
      selected: selectedIds.has(node.id),
    }));
  }, [draft.nodes, draft.edges, describe, problemsFor, runFor, selectedNodeIds]);

  const flowEdges = useMemo<WorkflowFlowEdge[]>(() => {
    const selectedIds = new Set(selectedEdgeIds);
    return toFlowEdges(draft.edges, draft.nodes, brokenEdgeIds).map((edge) => ({
      ...edge,
      selected: selectedIds.has(edge.id),
    }));
  }, [draft.edges, draft.nodes, brokenEdgeIds, selectedEdgeIds]);

  /**
   * React Flow's changes, applied to the stored model rather than to a second
   * copy of the graph.
   *
   * The alternative — `useNodesState` holding React Flow's own nodes as the
   * source of truth — means two representations of the same graph that have to
   * be kept in step, and the bug that produces is a saved workflow whose wiring
   * does not match what was on screen.
   */
  const onNodesChange = useCallback(
    (changes: NodeChange<WorkflowFlowNode>[]) => {
      setSelectedNodeIds((current) => nextSelection(current, changes));

      const { positions, removed } = nodeMovesAndRemovals(changes);
      if (positions.size === 0 && removed.size === 0) return;

      edit((current) => ({
        ...current,
        nodes: current.nodes
          .filter((node) => !removed.has(node.id))
          .map((node) => {
            const position = positions.get(node.id);
            return position ? { ...node, position } : node;
          }),
        // A removed node takes its wiring with it. Leaving the edges behind
        // would produce edges pointing at nothing, which React Flow silently
        // drops from the canvas while the save still sends them.
        edges: current.edges.filter((edge) => !removed.has(edge.from) && !removed.has(edge.to)),
      }));

      if (removed.size > 0) {
        setAnnouncement(
          `${removed.size} node${removed.size === 1 ? '' : 's'} removed, along with their connections.`,
        );
      }
    },
    [edit],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<WorkflowFlowEdge>[]) => {
      setSelectedEdgeIds((current) => nextSelection(current, changes));
      const removed = new Set(
        changes.filter((change) => change.type === 'remove').map((c) => c.id),
      );
      if (removed.size === 0) return;
      edit((current) => ({
        ...current,
        edges: current.edges.filter((edge) => !removed.has(edgeId(edge))),
      }));
      setAnnouncement(`${removed.size} connection${removed.size === 1 ? '' : 's'} removed.`);
    },
    [edit],
  );

  const disconnect = useCallback(
    (edge: WorkflowEdge) => {
      const id = edgeId(edge);
      edit((current) => ({
        ...current,
        edges: current.edges.filter((candidate) => edgeId(candidate) !== id),
      }));
      setAnnouncement('Connection removed.');
    },
    [edit],
  );

  const connect = useCallback(
    (from: string, to: string) => {
      const verdict = canConnect(draft.nodes, draft.edges, from, to);
      if (!verdict.ok) {
        setAnnouncement(verdict.reason);
        return;
      }
      // Appended rather than inserted anywhere else: a node with several inbound
      // edges receives its inputs in the order the edges appear in this array,
      // and that order is part of what the graph produces.
      edit((current) => ({ ...current, edges: [...current.edges, { from, to }] }));
      setAnnouncement(
        `${nodeLabelIn(draft.nodes, from)} now feeds ${nodeLabelIn(draft.nodes, to)}.`,
      );
    },
    [draft.nodes, draft.edges, edit],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      // Narrowed rather than trusted: React Flow types both ends as `string`
      // but a connection dropped on empty canvas arrives with no target on
      // some paths, and an edge with an empty id renders as a line to nowhere.
      if (!connection.source || !connection.target) return;
      connect(connection.source, connection.target);
    },
    [connect],
  );

  /**
   * Why a drag was refused, said once at the end of it.
   *
   * At the end rather than on every pointer move, which would set state dozens
   * of times a second while somebody is still deciding where to drop. The
   * boolean half of this lives in `isValidConnection` below.
   */
  const announceRefusedDrop = useCallback<OnConnectEnd>(
    (_event, state) => {
      if (state.isValid !== false) return;
      const from = state.fromNode?.id;
      const to = state.toNode?.id;
      if (!from || !to) return;
      const verdict = canConnect(draft.nodes, draft.edges, from, to);
      if (!verdict.ok) setAnnouncement(verdict.reason);
    },
    [draft.nodes, draft.edges],
  );

  /**
   * The while-drawing check.
   *
   * Boolean only, and asked on every pointer move, so it cannot be where the
   * explanation lives — React Flow uses the answer to put a valid/invalid class
   * on the handle under the cursor, which is what makes an illegal drop refuse
   * itself visibly before the mouse is released. The sentence comes from
   * `onConnectEnd`, below, using the same function.
   */
  const isValidConnection = useCallback(
    (candidate: { source: string | null; target: string | null }) => {
      if (!candidate.source || !candidate.target) return false;
      return canConnect(draft.nodes, draft.edges, candidate.source, candidate.target).ok;
    },
    [draft.nodes, draft.edges],
  );

  const save = useMutation({
    mutationFn: () =>
      client.saveWorkflow({
        id: draft.id,
        name: draft.name.trim(),
        description: draft.description.trim() || undefined,
        nodes: draft.nodes,
        edges: draft.edges,
      }),
    onSuccess: (saved) => {
      loadedRef.current = saved.id;
      setSelected(saved.id);
      setDraft(draftFrom(saved));
      setAnnouncement(`Saved. This is now v${saved.version}.`);
      queryClient.invalidateQueries({ queryKey: catalogQueryKeys.workflows });
    },
  });

  const runIt = useMutation({
    mutationFn: (id: string) => client.runWorkflow(id),
    onSuccess: (result) => {
      setRun(result);
      // A run writes rows, so the catalog snapshot every other screen reads is
      // now stale. Invalidating it here is what stops the object explorer
      // showing yesterday's counts beside a run that just finished.
      queryClient.invalidateQueries({ queryKey: catalogQueryKeys.snapshot });
      queryClient.invalidateQueries({ queryKey: catalogQueryKeys.workflows });
      setAnnouncement(
        result.status === 'succeeded'
          ? 'The run finished. Check each sink below for what it committed.'
          : `The run ${result.status}. ${result.error ?? ''}`,
      );
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => client.deleteWorkflow(id),
    onSuccess: () => {
      setConfirmingDelete(false);
      loadedRef.current = null;
      setSelected('');
      queryClient.invalidateQueries({ queryKey: catalogQueryKeys.workflows });
    },
  });

  const addNode = useCallback((kind: WorkflowNodeKind) => {
    const id = newLocalId(kind);
    setDraft((current) => {
      const node = newNodeOfKind(kind, id, nextPosition(current.nodes));
      return { ...current, nodes: [...current.nodes, node], dirty: true };
    });
    setInspecting(id);
    setAnnouncement(`A ${kind} node was added. Its inspector is open.`);
  }, []);

  const tidy = useCallback(() => {
    edit((current) => ({
      ...current,
      nodes: layout(current.nodes, current.edges),
    }));
    window.requestAnimationFrame(() => fitView({ padding: 0.25, duration: 200 }));
    setAnnouncement(
      'The nodes were laid out left to right by dependency, with every sink in the last column.',
    );
  }, [edit, fitView]);

  const durability = describeDurability(capabilities?.durable);
  const blocked = hasBlockingProblem(problems);
  const inspectingNode = draft.nodes.find((node) => node.id === inspecting) ?? null;
  const editingNode = draft.nodes.find((node) => node.id === editingCodeFor);
  const editingTransform: CatalogTransform | undefined =
    editingNode?.kind === 'transform'
      ? transforms.find((transform) => transform.id === editingNode.transformId)
      : undefined;

  const typeOptions = useMemo<SelectOption[]>(
    () =>
      (snapshot?.types ?? []).map((type) => ({
        value: type.name,
        label: type.displayName,
        hint: type.name,
      })),
    [snapshot],
  );

  const workflowOptions = useMemo<SelectOption[]>(
    () => [
      ...(workflows.data ?? []).map((workflow) => ({
        value: workflow.id,
        label: workflow.name,
        hint: `${workflow.nodes.length} nodes → ${producedTypes(workflow.nodes).join(', ') || 'nothing yet'}`,
      })),
      { value: NEW_WORKFLOW, label: `New ${WORKFLOW_NAME.singular}` },
    ],
    [workflows.data],
  );

  const produces = producedTypes(draft.nodes);

  return (
    /*
     * The screen lives inside the viewport: a header sized to its content and a
     * canvas that takes whatever is left.
     *
     * `min-h-0` on both this column and the row below it is the load-bearing
     * part. A flex child defaults to `min-height: auto`, which means "at least
     * as tall as my content" and makes it refuse to shrink — so a canvas with a
     * minimum height pushed itself past the bottom of a `main` that does not
     * scroll, and there was no way to reach the lower half of it. Fit View could
     * not save that: it fits the graph into a box, and half the box was off
     * screen. See `QueryConsole` for the same pattern.
     */
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-6 pt-5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <p className={cn('font-mono text-[11px] uppercase tracking-[0.18em]', MUTED)}>
            {eyebrow}
          </p>
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          <CommitsBadge produces={produces} />
        </div>
        <p className="mt-0.5 max-w-3xl text-xs text-zinc-500 dark:text-zinc-400">{intro}</p>

        <DurabilityBanner durability={durability} />

        <div className="mt-2.5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <SelectField
            label={WORKFLOW_NAME.title}
            ariaLabel={`Which ${WORKFLOW_NAME.singular} to edit`}
            value={selected}
            onValueChange={(value) => {
              loadedRef.current = null;
              setSelected(value);
            }}
            options={workflowOptions}
            disabled={workflows.isPending}
          />
          <TextField
            label="Name"
            value={draft.name}
            onChange={(name) => edit((current) => ({ ...current, name }))}
            placeholder="Fleet readiness"
            disabled={!canEdit}
          />
          <CanvasActions
            draft={draft}
            canEdit={canEdit}
            blocked={blocked}
            saving={save.isPending}
            running={runIt.isPending}
            durabilityDetail={durability.detail}
            onSave={() => save.mutate()}
            onRun={() => draft.id && runIt.mutate(draft.id)}
            onAskDelete={() => setConfirmingDelete(true)}
          />
        </div>

        {save.error && <RefusalNote lead="The server refused it:" error={save.error} />}
        {runIt.error && <RefusalNote lead="The run could not start:" error={runIt.error} />}
      </div>

      {canEdit && (
        <AddNodeBar
          refreshing={workflows.isFetching && !workflows.isPending}
          onAdd={addNode}
          onTidy={tidy}
        />
      )}

      {/*
       * Stacked below the canvas on a narrow screen rather than hidden. The
       * rail is where the problems are written out and where connections can be
       * removed without a pointer, so hiding it under a breakpoint would make
       * the screen less operable on exactly the devices where a drag is hardest.
       *
       * Narrow: this column scrolls, and the canvas takes a fixed share of the
       * viewport so the rail below it is reachable. Wide: nothing scrolls, and
       * the canvas is `flex-1 min-h-0` so it grows with the window.
       */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6 pb-5 pt-3 lg:flex-row lg:overflow-hidden">
        <GraphSurface
          loading={workflows.isPending}
          failed={workflows.isError}
          error={workflows.error}
          onRetry={() => workflows.refetch()}
          canEdit={canEdit}
          draft={draft}
          flowNodes={flowNodes}
          flowEdges={flowEdges}
          onInspect={setInspecting}
          onEditCode={setEditingCodeFor}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          isValidConnection={isValidConnection}
          onConnectEnd={announceRefusedDrop}
        />

        <WiringRail
          draft={draft}
          problems={problems}
          run={run}
          canEdit={canEdit}
          onInspect={setInspecting}
          onDisconnect={disconnect}
        />
      </div>

      {/*
       * Everything the canvas does, said out loud once.
       *
       * `polite` rather than `assertive`: these are confirmations and refusals,
       * not emergencies, and interrupting somebody mid-sentence to tell them a
       * node moved is worse than waiting for a pause.
       */}
      <output aria-live="polite" className="sr-only">
        {announcement}
      </output>

      <NodeInspector
        node={inspectingNode}
        draft={draft}
        transforms={transforms}
        connections={connections}
        typeOptions={typeOptions}
        canEdit={canEdit}
        problems={inspectingNode ? (problemsFor.get(inspectingNode.id) ?? []) : []}
        onClose={() => setInspecting(null)}
        onChange={(next) =>
          edit((current) => ({
            ...current,
            nodes: current.nodes.map((node) => (node.id === next.id ? next : node)),
          }))
        }
        onConnect={connect}
        onDisconnect={disconnect}
        onDelete={(nodeId) => {
          edit((current) => ({
            ...current,
            nodes: current.nodes.filter((node) => node.id !== nodeId),
            edges: current.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId),
          }));
          setInspecting(null);
          setAnnouncement('Node removed, along with its connections.');
        }}
        onEditCode={(nodeId) => setEditingCodeFor(nodeId)}
      />

      {/*
       * The code editor, over the canvas rather than instead of it.
       *
       * `TransformEditor` is a full screen of its own, and rendering it in
       * place of the canvas would unmount React Flow — losing every node
       * position, the half-drawn branch and the viewport somebody panned to,
       * none of which is saved yet. A sheet keeps all of it mounted behind.
       */}
      <Sheet
        open={editingCodeFor !== null}
        onOpenChange={(open) => {
          if (!open) setEditingCodeFor(null);
        }}
        width="wide"
        title={editingTransform ? editingTransform.name : 'Transform'}
        description="The canvas behind this is still exactly as you left it."
      >
        {editingTransform ? (
          <TransformEditor
            transform={editingTransform}
            languages={capabilities?.languages ?? ['javascript']}
            pythonPackages={capabilities?.pythonPackages ?? []}
            onClose={() => setEditingCodeFor(null)}
            onSaved={() => {
              setEditingCodeFor(null);
              queryClient.invalidateQueries({
                queryKey: catalogQueryKeys.transforms,
              });
            }}
          />
        ) : (
          <p className={cn('py-8 text-center text-xs', MUTED)}>
            This node does not name a transform yet. Choose one in the inspector first — there is no
            code to open until it does.
          </p>
        )}
      </Sheet>

      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title={`Delete "${draft.name || WORKFLOW_NAME.singular}"?`}
        description={`The graph goes with it. The transforms and connections it wired together are not touched — they are shared, and other ${WORKFLOW_NAME.plural} may use them.`}
        confirmLabel="Delete"
        pending={remove.isPending}
        error={remove.error instanceof Error ? remove.error.message : undefined}
        onConfirm={() => draft.id && remove.mutate(draft.id)}
      />
    </div>
  );
}

function AddButton({
  icon: Icon,
  label,
  hint,
  onClick,
}: {
  icon: typeof Plug;
  label: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <Tooltip content={hint}>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs',
          RULE,
          'hover:bg-zinc-50 dark:hover:bg-zinc-800',
        )}
      >
        <Plus size={11} />
        <Icon size={12} />
        {label}
      </button>
    </Tooltip>
  );
}

/**
 * Whether a failed run resumes or restarts, stated on the screen that implies
 * it.
 *
 * Not a tooltip and not a footnote. A canvas of discrete boxes looks like a
 * checkpointed pipeline whether or not one exists, and somebody who builds a
 * ten-node graph on that assumption finds out only when node seven fails at
 * three in the morning. Kept to one line so it costs the canvas as little
 * height as a fact this important can be said in.
 */
function DurabilityBanner({
  durability,
}: {
  durability: ReturnType<typeof describeDurability>;
}) {
  const tone =
    durability.state === 'durable'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300'
      : durability.state === 'inline'
        ? 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300'
        : 'border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400';

  return (
    <div
      className={cn(
        'mt-2.5 flex flex-wrap items-baseline gap-x-2 rounded-md border px-2.5 py-1.5',
        tone,
      )}
    >
      <p className="font-mono text-[10px] uppercase tracking-[0.14em]">{durability.label}</p>
      <p className="text-[11px] leading-relaxed">{durability.detail}</p>
    </div>
  );
}

/**
 * A skeleton, never an empty canvas.
 *
 * An empty canvas is a real state — a workflow with no nodes looks exactly like
 * this — so rendering one while the list is still in flight tells somebody
 * their graph is gone.
 */
function CanvasSkeleton() {
  return (
    <div className="flex h-full w-full items-center justify-center bg-zinc-50 dark:bg-zinc-950">
      <div className="flex items-center gap-3">
        <div className="h-16 w-48 animate-pulse rounded-lg bg-zinc-200 dark:bg-zinc-800" />
        <ArrowRight size={14} className={MUTED} />
        <div className="h-16 w-48 animate-pulse rounded-lg bg-zinc-200 dark:bg-zinc-800" />
        <ArrowRight size={14} className={MUTED} />
        <div className="h-16 w-48 animate-pulse rounded-lg bg-zinc-200 dark:bg-zinc-800" />
      </div>
    </div>
  );
}

function CanvasFailure({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-red-50 px-6 dark:bg-red-950/30">
      <div className="max-w-md text-center">
        <CircleAlert size={18} className="mx-auto text-red-600" />
        <p className="mt-2 text-sm text-red-700 dark:text-red-300">
          {/* Said as a failure, not drawn as an empty canvas. The two look
              identical and mean opposite things. */}
          The {WORKFLOW_NAME.plural} could not be read, so nothing below is drawn. This is not an
          empty {WORKFLOW_NAME.singular}.
        </p>
        <p className="mt-1 font-mono text-[11px] text-red-600 dark:text-red-400">
          {error instanceof Error ? error.message : 'No reason was given.'}
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 rounded-md border border-red-300 px-3 py-1 text-xs text-red-700 dark:border-red-800 dark:text-red-300"
        >
          Try again
        </button>
      </div>
    </div>
  );
}

/**
 * The graph as a list, beside the graph as a picture.
 *
 * Not a convenience. React Flow makes nodes focusable and movable from the
 * keyboard, but there is no keyboard gesture for drawing an edge — dragging
 * from one handle to another is a pointer interaction and nothing else. Without
 * a linear, operable representation of the wiring, this screen would be
 * buildable only with a mouse, and readable only by somebody who can see it.
 *
 * The problems list sits in the same rail for the same reason: a red ring
 * around a node off the left edge of the viewport communicates nothing.
 */
function WiringRail({
  draft,
  problems,
  run,
  canEdit,
  onInspect,
  onDisconnect,
}: {
  draft: Draft;
  problems: WorkflowProblem[];
  run: WorkflowRun | null;
  canEdit: boolean;
  onInspect: (nodeId: string) => void;
  onDisconnect: (edge: WorkflowEdge) => void;
}) {
  const label = (id: string) => {
    const node = draft.nodes.find((n) => n.id === id);
    return node ? nodeName(node) : id;
  };
  const errors = problems.filter((problem) => problem.level === 'error');
  const warnings = problems.filter((problem) => problem.level === 'warning');
  const sinks = draft.nodes.filter((node) => node.kind === 'sink');

  return (
    <aside
      className="flex w-full shrink-0 flex-col gap-3 lg:w-72 lg:min-h-0 lg:overflow-y-auto"
      aria-label={`${WORKFLOW_NAME.title} wiring and problems`}
    >
      <section className={cn('rounded-lg border p-3', RULE, PANEL)}>
        <h2 className={cn('font-mono text-[10px] uppercase tracking-[0.14em]', MUTED)}>Wiring</h2>
        {draft.edges.length === 0 ? (
          <p className={cn('mt-2 text-[11px]', MUTED)}>Nothing is wired together yet.</p>
        ) : (
          <ul className="mt-2 space-y-1">
            {draft.edges.map((edge) => (
              <li key={edgeId(edge)} className="flex items-center gap-1.5 text-[11px]">
                <button
                  type="button"
                  onClick={() => onInspect(edge.from)}
                  className="truncate hover:underline"
                >
                  {label(edge.from)}
                </button>
                <ArrowRight size={10} className={cn('shrink-0', MUTED)} />
                <button
                  type="button"
                  onClick={() => onInspect(edge.to)}
                  className="truncate hover:underline"
                >
                  {label(edge.to)}
                </button>
                {canEdit && (
                  <Tooltip content="Remove this connection.">
                    <button
                      type="button"
                      onClick={() => onDisconnect(edge)}
                      aria-label={`Disconnect ${label(edge.from)} from ${label(edge.to)}`}
                      className="ml-auto shrink-0 rounded p-0.5 text-zinc-400 hover:text-red-600"
                    >
                      <Unplug size={11} />
                    </button>
                  </Tooltip>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={cn('rounded-lg border p-3', RULE, PANEL)}>
        <h2 className={cn('font-mono text-[10px] uppercase tracking-[0.14em]', MUTED)}>Problems</h2>
        {problems.length === 0 ? (
          <p className={cn('mt-2 text-[11px]', MUTED)}>
            {/* Deliberately not "valid". These are the same rules the server
                runs, but it knows things they cannot see — which types exist,
                who may write to them — and its answer is the one that counts. */}
            Nothing to flag here. The server checks it again on save.
          </p>
        ) : (
          <ul className="mt-2 space-y-2">
            {[...errors, ...warnings].map((problem) => (
              <li
                key={`${problem.code}:${problem.nodeIds.join(',')}`}
                className="flex gap-1.5 text-[11px] leading-relaxed"
              >
                {problem.level === 'error' ? (
                  <CircleAlert size={11} className="mt-0.5 shrink-0 text-red-500" />
                ) : (
                  <TriangleAlert size={11} className="mt-0.5 shrink-0 text-amber-500" />
                )}
                <span>
                  {problem.message}
                  {problem.nodeIds.length > 0 && (
                    <span className="ml-1">
                      {problem.nodeIds.map((nodeId) => (
                        <button
                          key={nodeId}
                          type="button"
                          onClick={() => onInspect(nodeId)}
                          className={cn(
                            'mr-1 rounded border px-1 font-mono text-[9px]',
                            RULE,
                            MUTED,
                          )}
                        >
                          {label(nodeId)}
                        </button>
                      ))}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {run && (
        <section className={cn('rounded-lg border p-3', RULE, PANEL)}>
          <h2 className={cn('font-mono text-[10px] uppercase tracking-[0.14em]', MUTED)}>
            Last run
          </h2>
          <p className="mt-1 text-[11px]">
            {run.status}
            {/* Read from the run, not from capabilities: a deployment can gain
                or lose its durable engine between runs, and this run is what it
                was when it happened. */}
            <span className={cn('ml-1 font-mono text-[10px]', MUTED)}>
              {run.durable ? 'checkpointed per node' : 'ran inline, no checkpoints'}
            </span>
          </p>

          {/*
           * What each sink committed, called out separately from the node list.
           *
           * A graph may commit several types, and each sink commits its own
           * independently — there is no transaction across them. So "the run
           * succeeded" is not a fact about the run: `Mvr` can be live while
           * `Subwo` failed, and a single status line would say the opposite of
           * what happened to one of them. The overall status above is failed if
           * any sink failed; this is where somebody reads which.
           */}
          {sinks.length > 0 && (
            <div className="mt-2">
              <h3 className={cn('font-mono text-[10px] uppercase tracking-[0.14em]', MUTED)}>
                Committed
              </h3>
              <ul className="mt-1 space-y-1">
                {sinks.map((sink) => {
                  const outcome = run.nodes.find((node) => node.nodeId === sink.id);
                  const type =
                    sink.kind === 'sink' && sink.targetType ? sink.targetType : 'no type';
                  return (
                    <li key={sink.id} className="flex items-center gap-1.5 text-[11px]">
                      <span className="truncate font-mono text-[10px]">{type}</span>
                      <span
                        className={cn(
                          'ml-auto shrink-0 font-mono text-[10px]',
                          outcome?.status === 'failed'
                            ? 'text-red-500'
                            : outcome?.status === 'succeeded'
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : MUTED,
                        )}
                      >
                        {outcome
                          ? outcome.status === 'succeeded' && typeof outcome.rows === 'number'
                            ? `${outcome.rows} rows`
                            : outcome.status
                          : 'no outcome recorded'}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <p className={cn('mt-1 text-[10px] leading-relaxed', MUTED)}>
                Each sink commits on its own. One committing and another failing is a failed run
                that nevertheless wrote something, not a partial success that will be rolled back.
              </p>
            </div>
          )}

          <ul className="mt-2 space-y-1">
            {run.nodes.map((node) => (
              <li key={node.nodeId} className="flex items-center gap-1.5 font-mono text-[10px]">
                <span className="truncate">{label(node.nodeId)}</span>
                <span
                  className={cn(
                    'ml-auto shrink-0',
                    node.status === 'failed' ? 'text-red-500' : MUTED,
                  )}
                >
                  {node.replayed ? 'replayed' : node.status}
                </span>
              </li>
            ))}
          </ul>
          {run.error && <p className="mt-2 text-[11px] text-red-600">{run.error}</p>}
        </section>
      )}
    </aside>
  );
}

/**
 * One end of a node's wiring — everything feeding it, or everything it feeds.
 *
 * Both directions render the same list off the same edges, so they share one
 * description of it. Only which end of the edge to name, and how removing it is
 * announced, differ; `children` carries whatever belongs under the list.
 */
function WiringList({
  title,
  edges,
  otherEnd,
  describeRemoval,
  canEdit,
  onDisconnect,
  children,
}: {
  title: string;
  edges: WorkflowEdge[];
  otherEnd: (edge: WorkflowEdge) => string;
  describeRemoval: (name: string) => string;
  canEdit: boolean;
  onDisconnect: (edge: WorkflowEdge) => void;
  children?: ReactNode;
}) {
  return (
    <section>
      <h3 className={cn('font-mono text-[10px] uppercase tracking-[0.14em]', MUTED)}>{title}</h3>
      {edges.length === 0 ? (
        <p className={cn('mt-1 text-[11px]', MUTED)}>Nothing yet.</p>
      ) : (
        <ul className="mt-1 space-y-1">
          {edges.map((edge) => (
            <li key={edgeId(edge)} className="flex items-center gap-1.5 text-[11px]">
              <span className="truncate">{otherEnd(edge)}</span>
              {canEdit && (
                <Tooltip content="Remove this connection.">
                  <button
                    type="button"
                    onClick={() => onDisconnect(edge)}
                    aria-label={describeRemoval(otherEnd(edge))}
                    className="ml-auto rounded p-0.5 text-zinc-400 hover:text-red-600"
                  >
                    <Unplug size={11} />
                  </button>
                </Tooltip>
              )}
            </li>
          ))}
        </ul>
      )}
      {children}
    </section>
  );
}

/** Which transform runs here, and a way into its code. */
function TransformInspector({
  node,
  transforms,
  canEdit,
  onChange,
  onEditCode,
}: {
  node: WorkflowTransformNode;
  transforms: CatalogTransform[];
  canEdit: boolean;
  onChange: (node: WorkflowNode) => void;
  onEditCode: (nodeId: string) => void;
}) {
  return (
    <div className="space-y-2">
      <SelectField
        label="Transform"
        ariaLabel="Which transform runs at this node"
        value={node.transformId}
        onValueChange={(transformId) => onChange({ ...node, transformId })}
        options={transforms.map((transform) => ({
          value: transform.id,
          label: transform.name,
          hint: `${transform.language} · v${transform.version}`,
        }))}
        placeholder="Choose a transform…"
        disabled={!canEdit}
      />
      <button
        type="button"
        onClick={() => onEditCode(node.id)}
        disabled={node.transformId.length === 0}
        className={cn(
          'flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs disabled:opacity-40',
          RULE,
          'hover:bg-zinc-50 dark:hover:bg-zinc-800',
        )}
      >
        <Code2 size={12} />
        Open the code
      </button>
    </div>
  );
}

/**
 * What this sink commits, and whether it replaces or merges.
 *
 * The type is set here, on the node that commits it, rather than once for the
 * whole graph — several sinks may write several types.
 */
function SinkInspector({
  node,
  typeOptions,
  canEdit,
  onChange,
}: {
  node: WorkflowSinkNode;
  typeOptions: SelectOption[];
  canEdit: boolean;
  onChange: (node: WorkflowNode) => void;
}) {
  return (
    <div className="space-y-3">
      <SelectField
        label="Commits"
        ariaLabel="Which object type this sink writes"
        value={node.targetType}
        onValueChange={(targetType) => onChange({ ...node, targetType })}
        options={typeOptions}
        placeholder="Choose one type…"
        disabled={!canEdit}
        hint="The type is set here, on the node that commits it, rather than once for the whole graph — several sinks may write several types."
      />
      <SelectField
        label="Commit mode"
        ariaLabel="Whether this sink replaces the dataset or merges into it"
        value={node.mode ?? 'full'}
        onValueChange={(mode) =>
          onChange({
            ...node,
            mode: mode === 'incremental' ? 'incremental' : 'full',
          })
        }
        options={[
          { value: 'full', label: 'Full — replace the dataset' },
          { value: 'incremental', label: 'Incremental — merge into it' },
        ]}
        disabled={!canEdit}
      />
      <p className={cn('text-[11px] leading-relaxed', MUTED)}>
        This sink commits {node.targetType || 'its type'} on its own. Another sink in the same graph
        committing a different type is a separate commit — one can succeed while this one fails, and
        the run is reported as failed when any of them does.
      </p>
    </div>
  );
}

function NodeInspector({
  node,
  draft,
  transforms,
  connections,
  typeOptions,
  canEdit,
  problems,
  onClose,
  onChange,
  onConnect,
  onDisconnect,
  onDelete,
  onEditCode,
}: {
  node: WorkflowNode | null;
  draft: Draft;
  transforms: CatalogTransform[];
  connections: CatalogConnection[];
  typeOptions: SelectOption[];
  canEdit: boolean;
  problems: WorkflowProblem[];
  onClose: () => void;
  onChange: (node: WorkflowNode) => void;
  onConnect: (from: string, to: string) => void;
  onDisconnect: (edge: WorkflowEdge) => void;
  onDelete: (nodeId: string) => void;
  onEditCode: (nodeId: string) => void;
}) {
  const [pendingTarget, setPendingTarget] = useState('');

  const label = (id: string) => {
    const found = draft.nodes.find((n) => n.id === id);
    return found ? nodeName(found) : id;
  };

  const outgoing = node ? draft.edges.filter((edge) => edge.from === node.id) : [];
  const incoming = node ? draft.edges.filter((edge) => edge.to === node.id) : [];

  /**
   * The keyboard path to wiring.
   *
   * React Flow has no keyboard gesture for drawing an edge — a connection is a
   * drag from one handle to another and nothing else — so without this control
   * the screen would be operable with a mouse only. The eligible list is
   * filtered by the same `canConnect` the drag uses, so a target that would
   * close a loop is simply not offered rather than offered and then refused.
   */
  const eligible = useMemo<SelectOption[]>(() => {
    if (!node) return [];
    return draft.nodes
      .filter((candidate) => canConnect(draft.nodes, draft.edges, node.id, candidate.id).ok)
      .map((candidate) => ({
        value: candidate.id,
        label: nodeName(candidate),
        hint: candidate.kind,
      }));
  }, [node, draft.nodes, draft.edges]);

  return (
    <Sheet
      open={node !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={node ? nodeName(node) : ''}
      description={node ? `${node.kind} node` : undefined}
    >
      {node && (
        <div className="space-y-4">
          {problems.length > 0 && (
            <ul className="space-y-1.5 rounded-md border border-red-200 bg-red-50 p-2 dark:border-red-900 dark:bg-red-950/40">
              {problems.map((problem) => (
                <li
                  key={problem.code}
                  className="text-[11px] leading-relaxed text-red-700 dark:text-red-300"
                >
                  {problem.message}
                </li>
              ))}
            </ul>
          )}

          <TextField
            label="Name"
            value={node.name}
            onChange={(name) => onChange({ ...node, name })}
            placeholder={node.kind}
            disabled={!canEdit}
            hint="What it is called on the canvas and in the wiring list. Renaming it does not change what the graph does, so it does not bump the version."
          />

          {node.kind === 'transform' && (
            <TransformInspector
              node={node}
              transforms={transforms}
              canEdit={canEdit}
              onChange={onChange}
              onEditCode={onEditCode}
            />
          )}

          {node.kind === 'source' && (
            <SourceInspector
              // Keyed so the text fields reset when a different source is
              // opened. Without it the draft state would survive the swap and
              // one node's URL would appear inside another.
              key={node.id}
              node={node}
              connections={connections}
              canEdit={canEdit}
              onChange={onChange}
            />
          )}

          {node.kind === 'sink' && (
            <SinkInspector
              node={node}
              typeOptions={typeOptions}
              canEdit={canEdit}
              onChange={onChange}
            />
          )}

          <WiringList
            title="Fed by"
            edges={incoming}
            otherEnd={(edge) => label(edge.from)}
            describeRemoval={(name) => `Stop ${name} feeding this node`}
            canEdit={canEdit}
            onDisconnect={onDisconnect}
          >
            {incoming.length > 1 && (
              <p className={cn('mt-1 text-[11px] leading-relaxed', MUTED)}>
                Inputs arrive in this order, and the order is part of what the graph produces — a
                transform joining two feeds sees them exactly like this.
              </p>
            )}
          </WiringList>

          <WiringList
            title="Feeds"
            edges={outgoing}
            otherEnd={(edge) => label(edge.to)}
            describeRemoval={(name) => `Stop this node feeding ${name}`}
            canEdit={canEdit}
            onDisconnect={onDisconnect}
          >
            {canEdit && (
              <div className="mt-2 flex items-end gap-2">
                <div className="min-w-0 flex-1">
                  <Select
                    ariaLabel="Send this node's output to"
                    value={pendingTarget}
                    onValueChange={setPendingTarget}
                    options={eligible}
                    placeholder={
                      eligible.length === 0
                        ? 'Nothing can be wired from here'
                        : 'Send its output to…'
                    }
                    disabled={eligible.length === 0}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (!pendingTarget) return;
                    onConnect(node.id, pendingTarget);
                    setPendingTarget('');
                  }}
                  disabled={!pendingTarget}
                  className={cn(
                    'shrink-0 rounded-md border px-2.5 py-1.5 text-xs disabled:opacity-40',
                    RULE,
                    'hover:bg-zinc-50 dark:hover:bg-zinc-800',
                  )}
                >
                  Connect
                </button>
              </div>
            )}
            <p className={cn('mt-1 text-[11px] leading-relaxed', MUTED)}>
              Only nodes that can legally take this one's output are listed — anything that would
              close a loop, or feed a source, is left out.
            </p>
          </WiringList>

          {canEdit && (
            <button
              type="button"
              onClick={() => onDelete(node.id)}
              className="flex items-center gap-1.5 rounded-md border border-red-200 px-2.5 py-1.5 text-xs text-red-600 hover:bg-red-50 dark:border-red-900 dark:hover:bg-red-950/40"
            >
              <Trash2 size={12} />
              Remove this node
            </button>
          )}
        </div>
      )}
    </Sheet>
  );
}

/**
 * Where a source reads from.
 *
 * The same fields the connector form uses, from the same module, because a
 * source node and a connector are the same half of the same idea and the
 * executable model gives them the same vocabulary: a kind, an optional named
 * connection, a config, the name of an env var holding the credential, and
 * whether it reads everything or only what changed.
 *
 * There is deliberately no "which connector feeds this" picker. A connector
 * references a *workflow*, so a source referencing a connector would be
 * circular — and it would leave one load with two authorities on where its data
 * comes from.
 *
 * The text fields are held locally and pushed up as a config on every change,
 * rather than read back out of the node. Re-deriving them from the stored config
 * would make a half-typed number disappear the moment it stopped parsing.
 */
function SourceInspector({
  node,
  connections,
  canEdit,
  onChange,
}: {
  node: WorkflowSourceNode;
  connections: CatalogConnection[];
  canEdit: boolean;
  onChange: (node: WorkflowNode) => void;
}) {
  const [source, setSource] = useState<SourceDraft>(() => sourceDraftFrom(node.config));
  const kind: ConnectorKind = toConnectorKind(node.sourceKind ?? 'http');
  const options = connectionOptions(kind, connections);
  // A connection chosen for one kind is meaningless for another, so switching
  // the kind drops it rather than keeping an id the server would reject.
  const chosen = options.some((option) => option.value === node.connectionId)
    ? (node.connectionId ?? INLINE_CONNECTION)
    : INLINE_CONNECTION;
  const viaConnection = chosen !== INLINE_CONNECTION;
  const mode = node.mode === 'incremental' ? 'incremental' : 'full';
  const incremental = readsIncrementally(kind) && mode === 'incremental';

  /** One place that turns the text fields back into a stored config. */
  const push = (next: SourceDraft, over: Partial<WorkflowSourceNode> = {}) => {
    const merged: WorkflowSourceNode = { ...node, ...over };
    const mergedKind = toConnectorKind(merged.sourceKind ?? 'http');
    const mergedVia = Boolean(merged.connectionId);
    onChange({
      ...merged,
      config: sourceConfigFrom(mergedKind, next, {
        viaConnection: mergedVia,
        incremental: readsIncrementally(mergedKind) && merged.mode === 'incremental',
      }),
    });
  };

  const update = (next: SourceDraft) => {
    setSource(next);
    push(next);
  };

  return (
    <div className="space-y-3">
      <SelectField
        label="Source kind"
        ariaLabel="What kind of system this reads from"
        value={kind}
        onValueChange={(value) => {
          const sourceKind = toConnectorKind(value);
          // The connection goes with the kind it belonged to. Keeping it would
          // point an S3 source at a SQL address.
          push(source, { sourceKind, connectionId: undefined });
        }}
        options={KIND_OPTIONS}
        disabled={!canEdit}
      />

      {/*
       * The connection picker, above the address fields it replaces.
       *
       * Offered rather than required: a one-off source does not deserve a second
       * object to manage, and forcing one would make the quickest thing this
       * screen can do — paste a URL, load it once — the slowest.
       */}
      {usesConnection(kind) && (
        <SelectField
          label="Read through"
          ariaLabel="Connection"
          value={chosen}
          onValueChange={(value) =>
            push(source, {
              // Omitted, never sent empty: an empty string is a connection id
              // the server would look up and fail to find, where absent means
              // "this source carries its own address".
              connectionId: value === INLINE_CONNECTION ? undefined : value,
            })
          }
          options={[
            {
              value: INLINE_CONNECTION,
              label: 'Configure the address here',
              hint: 'This source alone',
            },
            ...options,
          ]}
          disabled={!canEdit}
          hint={
            options.length === 0
              ? 'No connections of this kind yet. One is worth making when a second source needs the same address.'
              : viaConnection
                ? 'The connection supplies the address and the credential. What stays below is only what is specific to this load.'
                : undefined
          }
        />
      )}

      <SourceFields
        kind={kind}
        draft={source}
        onChange={update}
        viaConnection={viaConnection}
        disabled={!canEdit}
      />

      <ReadModeFields
        kind={kind}
        mode={mode}
        onModeChange={(next) => push(source, { mode: next })}
        draft={source}
        onChange={update}
        disabled={!canEdit}
      />

      {!viaConnection && (
        <CredentialField
          kind={kind}
          value={node.secretEnvVar ?? ''}
          onChange={(value) => push(source, { secretEnvVar: value.trim() ? value : undefined })}
          disabled={!canEdit}
        />
      )}

      {incremental && (
        <p className={cn('text-[11px] leading-relaxed', MUTED)}>
          A watermark is kept per node, so two sources in the same graph reading incrementally do
          not overwrite each other's position.
        </p>
      )}
    </div>
  );
}
