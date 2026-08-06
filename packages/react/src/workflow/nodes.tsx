import { Handle, type NodeProps, Position } from '@xyflow/react';
import {
  CircleAlert,
  CircleCheck,
  CircleSlash,
  Code2,
  Database,
  ExternalLink,
  Filter,
  GitBranch,
  Loader2,
  Plug,
  Repeat,
  TriangleAlert,
} from 'lucide-react';
import { type ReactNode, createContext, useContext } from 'react';
import { cn } from '../cn';
import { Tooltip } from '../ui/tooltip';
import { type WorkflowFlowNode, type WorkflowNodeData, describeDrop } from './graph';
import type { WorkflowNodeKind } from './model';

const RULE = 'border-zinc-200 dark:border-zinc-800';
const PANEL = 'bg-white dark:bg-zinc-900';
const MUTED = 'text-zinc-400 dark:text-zinc-500';

/**
 * What a node can reach without being handed a callback in its `data`.
 *
 * A context rather than props on the node data, because React Flow re-creates
 * a node's props from `data` and compares them: a handler in `data` is a new
 * function identity on every render of the screen, which invalidates every node
 * at once and makes dragging one node re-render all of them.
 *
 * The default throws rather than no-oping. A node rendered outside the canvas
 * would otherwise look completely normal and quietly ignore every click, which
 * is a much worse bug to find than an error naming the missing provider.
 */
interface WorkflowNodeHandlers {
  /** Open the inspector for this node. */
  onInspect(nodeId: string): void;
  /** Jump straight to the code editor for this node's transform. */
  onEditCode(nodeId: string): void;
  /** Whether editing is offered at all. */
  canEdit: boolean;
}

const WorkflowNodeContext = createContext<WorkflowNodeHandlers | null>(null);

export function WorkflowNodeProvider({
  handlers,
  children,
}: {
  handlers: WorkflowNodeHandlers;
  children: ReactNode;
}) {
  return <WorkflowNodeContext.Provider value={handlers}>{children}</WorkflowNodeContext.Provider>;
}

function useWorkflowNodeHandlers(): WorkflowNodeHandlers {
  const handlers = useContext(WorkflowNodeContext);
  if (!handlers) {
    throw new Error('A workflow node was rendered outside <WorkflowNodeProvider>.');
  }
  return handlers;
}

const KIND_STYLE: Record<
  WorkflowNodeKind,
  { accent: string; chip: string; icon: typeof Plug; noun: string }
> = {
  source: {
    accent: 'bg-sky-500',
    chip: 'text-sky-700 dark:text-sky-300',
    icon: Plug,
    noun: 'source',
  },
  transform: {
    accent: 'bg-sky-500',
    chip: 'text-sky-700 dark:text-sky-300',
    icon: Repeat,
    noun: 'transform',
  },
  sink: {
    accent: 'bg-emerald-500',
    chip: 'text-emerald-700 dark:text-emerald-300',
    icon: Database,
    noun: 'sink',
  },
  // Amber and its own icon, because a call is the one node whose work does not
  // happen here: the box on the canvas is a handle on a workflow somebody else
  // owns, and it should not read as another transform.
  call: {
    accent: 'bg-amber-500',
    chip: 'text-amber-700 dark:text-amber-300',
    icon: ExternalLink,
    noun: 'call',
  },
  // Violet and a fork, because an if is the only node whose effect is on the
  // *graph* rather than on the rows: everything else here does something to
  // data, and this one decides which boxes exist for this run. It should not
  // read as another step in the line.
  if: {
    accent: 'bg-fuchsia-500',
    chip: 'text-fuchsia-700 dark:text-fuchsia-300',
    icon: GitBranch,
    noun: 'if',
  },
  // Rose and a funnel. It is the only kind whose effect is *subtraction* — every
  // other node either produces rows, reshapes them or decides which boxes run —
  // and the whole reason it is a node rather than a transform returning a subset
  // is that "rows are being dropped here" should be visible without opening
  // anything. Deliberately not the fuchsia an `if` wears: both of them make a
  // load smaller and they do it in completely different ways, so they are the
  // two that must never be confused at a glance.
  filter: {
    accent: 'bg-rose-500',
    chip: 'text-rose-700 dark:text-rose-300',
    icon: Filter,
    noun: 'filter',
  },
};

/**
 * Handles are styled larger than React Flow's default 6px dot.
 *
 * A 6px target is fine for somebody with a mouse and a steady hand and awful
 * for everybody else, and the whole interaction of this screen is landing a
 * drag on one. `connectionRadius` on the canvas widens the drop zone; this
 * widens what you can see to aim at.
 */
const HANDLE = cn(
  '!h-3 !w-3 !rounded-full !border-2',
  '!border-zinc-300 !bg-white dark:!border-zinc-600 dark:!bg-zinc-800',
  // React Flow adds these while a connection is being dragged. Colouring them
  // is what makes an illegal target — one that would close a loop, or a source
  // that takes no input — visibly refuse *before* the mouse is released.
  '[.react-flow__handle-connecting&]:!border-red-500',
  '[.react-flow__handle-valid&]:!border-emerald-500 [.react-flow__handle-valid&]:!bg-emerald-500',
);

function RunBadge({ run }: { run: NonNullable<WorkflowNodeData['run']> }) {
  if (run.status === 'running') {
    return (
      <Tooltip content="Running now.">
        <span className="flex items-center">
          <Loader2 size={11} className="animate-spin text-sky-500" />
        </span>
      </Tooltip>
    );
  }
  if (run.status === 'failed') {
    return (
      <Tooltip content={run.error ?? 'This step failed.'}>
        <span className="flex items-center">
          <CircleAlert size={11} className="text-red-500" />
        </span>
      </Tooltip>
    );
  }
  if (run.status === 'succeeded') {
    return (
      <Tooltip
        content={
          run.replayed
            ? // The single most useful fact on a resumed run, and there is
              // nowhere else on the screen to read it from.
              'Replayed from a checkpoint — this step did not run again.'
            : // A filter reports the pair rather than the total, and it is the
              // one kind for which "42 rows" would be an actively misleading
              // badge: the number that matters is what it *removed*, and a node
              // that showed only its output would make a filter that dropped
              // nine tenths of a load look identical to a source that read a
              // tenth as much. `describeDrop` answers for filters and stays
              // silent for everything else, so this stays one expression.
              `${describeBranchTaken(run) ?? 'Ran'}${describeRunSize(run)}.`
        }
      >
        <span className="flex items-center">
          <CircleCheck size={11} className={run.replayed ? 'text-zinc-400' : 'text-emerald-500'} />
        </span>
      </Tooltip>
    );
  }
  // Drawn rather than left blank, which is what this was.
  //
  // A skipped node used to render nothing at all, which was defensible while
  // `skipped` meant only "the run stopped before here" — the failed node beside
  // it carried the story. It is not defensible now that a node can be skipped by
  // a branch on a run that went perfectly: a sink that quietly shows no badge is
  // exactly the "nothing loaded and nothing said so" this feature has to avoid.
  if (run.status === 'skipped') {
    return (
      <Tooltip content={describeSkip(run)}>
        <span className="flex items-center">
          <CircleSlash size={11} className="text-zinc-400" />
        </span>
      </Tooltip>
    );
  }
  return null;
}

/**
 * How much data went through a node, in the terms that node is measured in.
 *
 * A filter reports the pair — in, out, and what that means as a share — because
 * for a filter the number that matters is what it *removed*, and a badge showing
 * only its output would make one that dropped nine tenths of a load look exactly
 * like a source that read a tenth as much. Everything else reports what it
 * produced, which is what "rows" has always meant on this badge.
 */
function describeRunSize(run: NonNullable<WorkflowNodeData['run']>): string {
  const dropped = describeDrop(run);
  if (dropped) return `: ${dropped}`;
  return typeof run.rows === 'number' ? `, ${run.rows} rows` : '';
}

/** What an `if` node's badge says it decided. Absent on every other kind. */
function describeBranchTaken(run: WorkflowNodeData['run']): string | undefined {
  if (!run?.branch) return undefined;
  return `Took the "${run.branch}" branch`;
}

/**
 * The two meanings of `skipped`, told apart.
 *
 * The branch wording deliberately says what did **not** happen to the data,
 * because for a sink that is the whole question: a node that never ran committed
 * nothing, so whatever was published before this run is still published. A
 * reader who is not told that assumes the load emptied it.
 */
function describeSkip(run: NonNullable<WorkflowNodeData['run']>): string {
  if (run.skippedBecause === 'branch-not-taken') {
    return 'Skipped: this is on the branch that was not taken. It did not run, so it wrote nothing and committed nothing — anything it publishes is still whatever was there before this run.';
  }
  return 'Skipped: the run stopped before reaching this step.';
}

export function WorkflowNodeBody({ id, data, selected }: NodeProps<WorkflowFlowNode>) {
  const { onInspect, onEditCode, canEdit } = useWorkflowNodeHandlers();
  const style = KIND_STYLE[data.kind];
  const Icon = style.icon;

  const errors = data.problems.filter((problem) => problem.level === 'error');
  const warnings = data.problems.filter((problem) => problem.level === 'warning');

  return (
    <div
      className={cn(
        'relative w-56 overflow-hidden rounded-lg border shadow-sm transition-shadow',
        RULE,
        PANEL,
        selected && 'ring-2 ring-sky-500/40',
        errors.length > 0 && 'border-red-400 dark:border-red-800',
        errors.length === 0 && warnings.length > 0 && 'border-amber-300 dark:border-amber-800',
      )}
    >
      <span className={cn('absolute inset-y-0 left-0 w-1', style.accent)} />

      {/* A source is fed by nothing and a sink feeds nothing, so those handles
          simply do not exist. Rendering them and refusing the connection later
          would offer somebody a target that can never be valid. */}
      {data.kind !== 'source' && (
        <Handle
          type="target"
          position={Position.Left}
          className={HANDLE}
          aria-label={`input of ${data.label}`}
        />
      )}
      {data.kind !== 'sink' && (
        <Handle
          type="source"
          position={Position.Right}
          className={HANDLE}
          aria-label={`output of ${data.label}`}
        />
      )}

      <div className="pl-3 pr-2 py-2">
        <div className="flex items-center gap-1.5">
          <Icon size={12} className={style.chip} />
          <span className={cn('font-mono text-[9px] uppercase tracking-[0.16em]', style.chip)}>
            {style.noun}
          </span>
          <span className="ml-auto flex items-center gap-1">
            {data.run && <RunBadge run={data.run} />}
            {errors.length > 0 && (
              <Tooltip content={errors.map((p) => p.message).join(' ')}>
                <span className="flex items-center">
                  <CircleAlert size={11} className="text-red-500" />
                </span>
              </Tooltip>
            )}
            {errors.length === 0 && warnings.length > 0 && (
              <Tooltip content={warnings.map((p) => p.message).join(' ')}>
                <span className="flex items-center">
                  <TriangleAlert size={11} className="text-amber-500" />
                </span>
              </Tooltip>
            )}
          </span>
        </div>

        {/* The whole body is the button rather than a link in the corner: a
            node is one target, and a click anywhere on it should open it. The
            `nodrag` class is what keeps the click from being read as the start
            of a drag by React Flow's pointer handling. */}
        <button
          type="button"
          onClick={() => onInspect(id)}
          className="nodrag mt-1 block w-full text-left"
        >
          <span className="block truncate text-[13px] font-medium">{data.label}</span>
          <span className={cn('block truncate font-mono text-[10px]', MUTED)}>{data.subtitle}</span>
        </button>

        {data.kind === 'transform' && canEdit && (
          <div className="mt-1.5 flex">
            <Tooltip content="Open this transform's code. The canvas stays where it is.">
              <button
                type="button"
                onClick={() => onEditCode(id)}
                aria-label={`Edit the code behind ${data.label}`}
                className={cn(
                  'nodrag flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[9px]',
                  RULE,
                  MUTED,
                  'hover:bg-zinc-50 dark:hover:bg-zinc-800',
                )}
              >
                <Code2 size={9} />
                code
              </button>
            </Tooltip>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Declared once, at module scope.
 *
 * React Flow compares `nodeTypes` by identity and warns — then remounts every
 * node — when it changes. An object literal written inline in the screen is a
 * new object on every render, so the canvas would tear down and rebuild the
 * whole graph on each keystroke in the name field.
 */
export const workflowNodeTypes = { workflowNode: WorkflowNodeBody };
