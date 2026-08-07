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
import { motion, useReducedMotion } from 'motion/react';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  createContext,
  useContext,
} from 'react';
import { cn } from '../cn';
import { Tooltip } from '../ui/tooltip';
import { NODE_WIDTH, type WorkflowFlowNode, type WorkflowNodeData, describeDrop } from './graph';
import type { WorkflowNodeKind } from './model';
import type { WiringHandleType, WorkflowWiring } from './wiring';

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
  /** Click-to-click wiring: what a click on a handle does, and what is in flight. */
  wiring: WorkflowWiring;
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

/**
 * The per-kind palette, in three coordinated pieces rather than one accent.
 *
 * `accent` is the rail down the left edge, `chip` colours the icon and the kind
 * word, and `wash` tints the strip they sit in. Three tokens per kind rather
 * than one, because a single accent bar on an otherwise identical white box
 * meant the four kinds were told apart by four pixels of colour — which at the
 * zoom people actually work at is no difference at all.
 *
 * Every entry names a `dark:` variant, and that is not decoration: this canvas
 * is embedded in a host whose theme it follows (see `CANVAS_THEME`), and a
 * colour with no dark counterpart is the failure mode that has bitten the
 * dropdowns in this package before — legible on the theme it was written on,
 * unreadable on the other.
 *
 * The rail is a gradient rather than a flat fill. It is 4px wide and runs the
 * full height of the box, which is exactly the shape where a flat fill reads as
 * a printing error and a gradient reads as an edge — and it is the only piece of
 * a node that carries its kind at a glance from across the canvas.
 */
const KIND_STYLE: Record<
  WorkflowNodeKind,
  { accent: string; chip: string; wash: string; icon: typeof Plug; noun: string }
> = {
  source: {
    accent: 'bg-gradient-to-b from-sky-400 to-sky-600',
    chip: 'text-sky-700 dark:text-sky-300',
    wash: 'bg-sky-50/70 dark:bg-sky-950/30',
    icon: Plug,
    noun: 'source',
  },
  transform: {
    accent: 'bg-gradient-to-b from-violet-400 to-violet-600',
    chip: 'text-violet-700 dark:text-violet-300',
    wash: 'bg-violet-50/70 dark:bg-violet-950/30',
    icon: Repeat,
    noun: 'transform',
  },
  sink: {
    accent: 'bg-gradient-to-b from-emerald-400 to-emerald-600',
    chip: 'text-emerald-700 dark:text-emerald-300',
    wash: 'bg-emerald-50/70 dark:bg-emerald-950/30',
    icon: Database,
    noun: 'sink',
  },
  // Amber and its own icon, because a call is the one node whose work does not
  // happen here: the box on the canvas is a handle on a workflow somebody else
  // owns, and it should not read as another transform.
  call: {
    accent: 'bg-gradient-to-b from-amber-400 to-amber-600',
    chip: 'text-amber-700 dark:text-amber-300',
    wash: 'bg-amber-50/70 dark:bg-amber-950/30',
    icon: ExternalLink,
    noun: 'call',
  },
  // Violet and a fork, because an if is the only node whose effect is on the
  // *graph* rather than on the rows: everything else here does something to
  // data, and this one decides which boxes exist for this run. It should not
  // read as another step in the line.
  if: {
    accent: 'bg-gradient-to-b from-fuchsia-400 to-fuchsia-600',
    chip: 'text-fuchsia-700 dark:text-fuchsia-300',
    wash: 'bg-fuchsia-50/70 dark:bg-fuchsia-950/30',
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
    accent: 'bg-gradient-to-b from-rose-400 to-rose-600',
    chip: 'text-rose-700 dark:text-rose-300',
    wash: 'bg-rose-50/70 dark:bg-rose-950/30',
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
  '!h-3 !w-3 !rounded-full !border-2 !transition-all !duration-150',
  '!border-zinc-300 !bg-white dark:!border-zinc-600 dark:!bg-zinc-800',
  // A pointer, not a crosshair: a click is now enough. See `wiring.tsx`.
  '!cursor-pointer',
  // Grows under the pointer, so the thing you are about to click
  // acknowledges you before you commit to it.
  'hover:!scale-125 hover:!border-violet-400',
  'focus-visible:!outline-none focus-visible:!ring-2 focus-visible:!ring-sky-500/50',
  // React Flow adds these while a connection is being dragged. Colouring them
  // is what makes an illegal target — one that would close a loop, or a source
  // that takes no input — visibly refuse *before* the mouse is released.
  '[.react-flow__handle-connecting&]:!border-red-500',
  '[.react-flow__handle-valid&]:!border-emerald-500 [.react-flow__handle-valid&]:!bg-emerald-500',
);

/**
 * What a handle looks like while a click-started wire is open.
 *
 * The drag has had this since the beginning — React Flow paints the handle under
 * the cursor valid or invalid, which is what makes an illegal drop refuse itself
 * before the mouse is released. A click has no "under the cursor" moment, so the
 * same judgement is shown on every handle at once: where this wire can land is
 * green, where it cannot is faded almost out, and the end it started from is
 * held in the connection line's own violet.
 *
 * The pulse is `motion-safe:`, so somebody who has asked for stillness gets the
 * colour and not the throb. The colour is the information.
 */
type HandleWiringState = 'idle' | 'origin' | 'open' | 'shut';

const HANDLE_WIRING: Record<HandleWiringState, string> = {
  idle: '',
  origin: '!border-violet-500 !bg-violet-500 !ring-4 !ring-violet-500/25',
  open: cn(
    '!border-emerald-500 !bg-emerald-500 !ring-4 !ring-emerald-500/25',
    'motion-safe:!animate-pulse',
  ),
  shut: '!opacity-20',
};

function handleWiringState(
  wiring: WorkflowWiring,
  nodeId: string,
  type: WiringHandleType,
): HandleWiringState {
  const { pending } = wiring;
  if (!pending) return 'idle';
  if (pending.nodeId === nodeId && pending.type === type) return 'origin';
  return wiring.accepts(nodeId, type) ? 'open' : 'shut';
}

/** The box's version of {@link handleWiringState}. Drawn on the whole node. */
function nodeWiringState(wiring: WorkflowWiring, nodeId: string): HandleWiringState {
  if (!wiring.pending) return 'idle';
  if (wiring.pending.nodeId === nodeId) return 'origin';
  if (wiring.accepts(nodeId, 'target') || wiring.accepts(nodeId, 'source')) return 'open';
  return 'shut';
}

/**
 * The props that turn a handle into something a click, or a key, can operate.
 *
 * Spread onto `<Handle>` rather than written inline twice, because the two
 * handles differ only in which side of the node they are. React Flow spreads its
 * own rest props last, so an `onClick` given here is the one that runs — and the
 * canvas turns `connectOnClick` off besides, so there is exactly one click path
 * and it is this one. `onMouseDown` is untouched: that is where the drag lives,
 * and the drag still works.
 *
 * `role`/`tabIndex`/`onKeyDown` because a handle is now a control, and a control
 * that only a pointer can reach is not one. React Flow renders a `<div>`, so the
 * button semantics have to be stated rather than inherited.
 */
function wireOn(nodeId: string, type: WiringHandleType, wiring: WorkflowWiring) {
  const start = () => wiring.onHandleClick(nodeId, type);
  return {
    role: 'button',
    tabIndex: 0,
    onClick: (event: ReactMouseEvent<HTMLDivElement>) => {
      // Kept off the node underneath, which would otherwise read the same click
      // as "open this node's inspector" and cover the canvas with a sheet.
      event.stopPropagation();
      start();
    },
    onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      // Space on a focused element scrolls the page by default, and Enter would
      // reach the node's own key handling.
      event.preventDefault();
      event.stopPropagation();
      start();
    },
  };
}

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
 * How a node arrives.
 *
 * On mount only, so it plays when a graph is opened and when somebody adds a box
 * — and not while one is dragged, because dragging does not remount. Scale from
 * just under one rather than from zero: the node grows into place instead of
 * being inflated, which at eight nodes on a canvas is the difference between a
 * screen settling and a screen erupting.
 *
 * Under `prefers-reduced-motion` the node is simply there. Nothing is conveyed
 * by the arrival that its presence does not already convey, which is the test
 * for whether skipping an animation costs anybody information.
 */
const ARRIVE = { type: 'spring', stiffness: 420, damping: 34, mass: 0.7 } as const;

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
  const { onInspect, onEditCode, canEdit, wiring } = useWorkflowNodeHandlers();
  const reduced = useReducedMotion();
  const style = KIND_STYLE[data.kind];
  const Icon = style.icon;

  const errors = data.problems.filter((problem) => problem.level === 'error');
  const warnings = data.problems.filter((problem) => problem.level === 'warning');
  const landing = nodeWiringState(wiring, id);

  return (
    <motion.div
      // The width comes from the constant rather than from a `w-56` class, and
      // that is the whole mechanism behind the overlap fix: `WORKFLOW_NODE_WIDTH`
      // is what the server spaces its columns by, so a node whose drawn width
      // came from somewhere else could silently stop matching the layout that
      // was computed for it. There is now one number and no way to change the
      // box without changing it.
      //
      // A width in `style` rather than an animated value, deliberately: React
      // Flow measures `offsetWidth` to place the edges, and a width mid-tween
      // would move every connection while it settled.
      style={{ width: NODE_WIDTH }}
      initial={reduced ? false : { opacity: 0, scale: 0.94 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={reduced ? { duration: 0 } : ARRIVE}
      className={cn(
        'group/node relative overflow-hidden rounded-xl border',
        // A lift on hover and a deeper one while selected. `transition-all`
        // rather than `transition-shadow` because the ring width changes too,
        // and a ring that snaps while the shadow fades reads as a glitch.
        'shadow-sm transition-all duration-150 motion-safe:hover:-translate-y-0.5 hover:shadow-lg',
        'hover:border-zinc-300 dark:hover:border-zinc-700',
        RULE,
        PANEL,
        selected && 'shadow-md ring-2 ring-sky-500/50 dark:ring-sky-400/50',
        errors.length > 0 && 'border-red-400 dark:border-red-800',
        errors.length === 0 && warnings.length > 0 && 'border-amber-300 dark:border-amber-800',
        // While a wire is open, the whole box says whether it can take it — the
        // handle is 12px across and the node is 224, and somebody looking for
        // "where can this go" is looking at boxes. Same judgement, same
        // function, drawn bigger.
        landing === 'open' && 'ring-2 ring-emerald-500/45 dark:ring-emerald-400/45',
        landing === 'origin' && 'ring-2 ring-violet-500/50 dark:ring-violet-400/50',
        landing === 'shut' && 'opacity-40',
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
          className={cn(HANDLE, HANDLE_WIRING[handleWiringState(wiring, id, 'target')])}
          aria-label={`input of ${data.label}`}
          {...wireOn(id, 'target', wiring)}
        />
      )}
      {data.kind !== 'sink' && (
        <Handle
          type="source"
          position={Position.Right}
          className={cn(HANDLE, HANDLE_WIRING[handleWiringState(wiring, id, 'source')])}
          aria-label={`output of ${data.label}`}
          {...wireOn(id, 'source', wiring)}
        />
      )}

      {/* The kind, on its own tinted strip above a hairline. Separating it from
          the name gives the two lines that matter — what this is and what it is
          called — room to be read as two lines rather than as a paragraph. */}
      <div
        className={cn(
          'flex items-center gap-1.5 border-b pl-3 pr-2 py-1',
          RULE,
          style.wash,
          // The accent rail runs the full height, so the header's left padding
          // has to clear it exactly as the body's does.
        )}
      >
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

      <div className="pl-3 pr-2 py-2">
        {/* The whole body is the button rather than a link in the corner: a
            node is one target, and a click anywhere on it should open it. The
            `nodrag` class is what keeps the click from being read as the start
            of a drag by React Flow's pointer handling. */}
        <button
          type="button"
          onClick={() => onInspect(id)}
          className="nodrag block w-full text-left"
        >
          <span className="block truncate text-[13px] font-medium leading-snug">{data.label}</span>
          <span className={cn('mt-0.5 block truncate font-mono text-[10px]', MUTED)}>
            {data.subtitle}
          </span>
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
                  'transition-colors',
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
    </motion.div>
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
