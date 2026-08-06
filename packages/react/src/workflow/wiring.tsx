import {
  Panel,
  Position,
  ViewportPortal,
  type XYPosition,
  getSmoothStepPath,
  useInternalNode,
  useReactFlow,
} from '@xyflow/react';
import { CircleAlert, Link2 } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '../ui/button';
import { NODE_HEIGHT, NODE_WIDTH, type WorkflowFlowNode } from './graph';
import { type WorkflowEdge, type WorkflowNode, nodeName } from './model';
import { canConnect } from './validate';

/**
 * Wiring by clicking twice, and the line that shows what is being drawn.
 *
 * ## The complaint
 *
 * "O wire acho que invés de clicar e arrastar, queremos clicar na pontinha, aí
 * já aparece a linha ta ligado e aí é só clicar no outro né e é isso." Click the
 * end of a node, see a line, click the other node, done. No drag.
 *
 * ## Why React Flow's own `connectOnClick` was not enough
 *
 * It is on by default and it *does* connect: `<Handle>` sets
 * `connectionClickStartHandle` on the first click and completes on the second.
 * But it draws nothing in between. React Flow's connection line renders from
 * `connection.inProgress`, and `inProgress` is only ever set by the POINTER-DOWN
 * path in `XYHandle.onPointerDown` — and only once the pointer has moved past
 * `connectionDragThreshold` (1px by default). A click never moves, so the flag
 * never flips, so there is no rubber band. That is exactly the half of the
 * gesture the complaint is about: the feedback, not the outcome. Somebody
 * clicking a handle on the shipped canvas got no acknowledgement at all and
 * concluded, reasonably, that clicking does nothing.
 *
 * The other half is the refusal. React Flow's click path hands `onClickConnectEnd`
 * the store's `connection`, which on a click is still the idle one — no
 * `toHandle`, no `toNode`. So there is nothing to say *why* an illegal pair was
 * refused, and a refused click is indistinguishable from a click that missed.
 *
 * So the click gesture is owned here instead: `connectOnClick` is turned off on
 * the canvas and each handle gets its own `onClick`, which lands in
 * {@link useClickWiring}. The drag is untouched — it is React Flow's
 * pointer-down path and it still works, still validates through the same
 * `isValidConnection`, and still colours the handle under the cursor. This adds
 * a way in; it removes none.
 *
 * ## The rules are not restated here
 *
 * Every decision — can this start a wire, can that receive one, why not —
 * comes from {@link canConnect}, the same function the drag, the wiring menu and
 * the inspector's picker are refused by. A second copy of "a sink commits its
 * rows" living in this file is how the canvas ends up offering an edge it then
 * rejects.
 */

/** The name on the box, or the id if a node has been added and not yet named. */
function labelOf(nodes: WorkflowNode[], id: string): string {
  const node = nodes.find((candidate) => candidate.id === id);
  return node ? nodeName(node) : id;
}

/** Which side of a node a handle is. React Flow's word, not the node's kind. */
export type WiringHandleType = 'source' | 'target';

/** The handle a click-to-click connection is being drawn from. */
export interface PendingWire {
  nodeId: string;
  type: WiringHandleType;
}

/**
 * What a node needs in order to take part in click-to-click wiring.
 *
 * Handed down the same context the node's other callbacks travel in, for the
 * same reason: React Flow rebuilds a node's props from `data`, so anything
 * function-shaped in there invalidates every node on every render of the screen.
 */
export interface WorkflowWiring {
  /** The handle a wire is currently coming out of, or null almost always. */
  pending: PendingWire | null;
  /** A click landed on a handle. The whole gesture is two of these. */
  onHandleClick(nodeId: string, type: WiringHandleType): void;
  /**
   * Could the wire being drawn right now legally end on this handle?
   *
   * False whenever nothing is being drawn, so a resting canvas is not a canvas
   * of green dots. Used only to colour handles — the answer is asked again, from
   * the same function, when the click actually arrives.
   */
  accepts(nodeId: string, type: WiringHandleType): boolean;
  /** Put the half-drawn wire away. The pane, Escape, and the hint's button. */
  cancel(): void;
}

/**
 * What one click on a handle means, given what was already in hand.
 *
 * A pure function returning a decision rather than a branch that also does
 * things, so the rules of the gesture can be read in one place and the hook
 * below is only the part that touches state. The verdict comes from
 * {@link canConnect}, which is the same function the drag is refused by.
 */
type ClickOutcome =
  /** Nothing was in flight. This click picks up a wire. */
  | { kind: 'start'; wire: PendingWire }
  /** Two outputs, or two inputs. Not an error — just a different starting end. */
  | { kind: 'restart'; wire: PendingWire }
  /** The same handle twice, which is how somebody says "never mind". */
  | { kind: 'cancel' }
  /** A legal pair. Both ids in the direction the edge actually runs. */
  | { kind: 'connect'; from: string; to: string }
  /** An illegal pair, and the sentence explaining which rule it broke. */
  | { kind: 'refuse'; reason: string };

function readClick(
  pending: PendingWire | null,
  clicked: PendingWire,
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
): ClickOutcome {
  // Either end is a legal start — somebody who thinks "this sink needs feeding"
  // should be able to say so from the sink, and the wire is drawn backwards
  // until it lands.
  if (!pending) return { kind: 'start', wire: clicked };
  if (pending.nodeId === clicked.nodeId && pending.type === clicked.type) return { kind: 'cancel' };
  if (pending.type === clicked.type) return { kind: 'restart', wire: clicked };

  // Whichever end was clicked first, the edge runs output → input.
  const from = pending.type === 'source' ? pending.nodeId : clicked.nodeId;
  const to = pending.type === 'source' ? clicked.nodeId : pending.nodeId;

  const verdict = canConnect(nodes, edges, from, to);
  return verdict.ok ? { kind: 'connect', from, to } : { kind: 'refuse', reason: verdict.reason };
}

/**
 * The two-click gesture, and the sentence it says when it refuses.
 *
 * The refusal is kept in state rather than only announced, because the whole
 * point of moving this off the drag is that a click has no "hold it there and
 * look at the red handle" moment. A click that is not allowed has to say so in
 * words that stay on the screen, and {@link WiringHint} is where they go.
 */
export function useClickWiring({
  canEdit,
  nodes,
  edges,
  onConnect,
  onSay,
}: {
  canEdit: boolean;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  /** Make the connection. Already validated by the time this is called. */
  onConnect(from: string, to: string): void;
  /** The live region. Everything visible here is also said out loud. */
  onSay(sentence: string): void;
}): { wiring: WorkflowWiring; refusal: string | null } {
  const [pending, setPending] = useState<PendingWire | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  const cancel = useCallback(() => {
    setPending(null);
    setRefusal(null);
  }, []);

  // Escape, because a half-drawn wire is a mode, and every mode on this screen
  // has to be leaveable without hunting for the thing that started it.
  useEffect(() => {
    if (!pending) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      cancel();
      onSay('Wiring cancelled.');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending, cancel, onSay]);

  const onHandleClick = useCallback(
    (nodeId: string, type: WiringHandleType) => {
      if (!canEdit) return;
      setRefusal(null);

      const outcome = readClick(pending, { nodeId, type }, nodes, edges);
      switch (outcome.kind) {
        case 'start':
          setPending(outcome.wire);
          onSay(
            type === 'source'
              ? `Wiring out of ${labelOf(nodes, nodeId)}. Click the input of the node it should feed, or press Escape.`
              : `Wiring into ${labelOf(nodes, nodeId)}. Click the output of the node that should feed it, or press Escape.`,
          );
          return;
        case 'restart':
          setPending(outcome.wire);
          return;
        case 'cancel':
          cancel();
          onSay('Wiring cancelled.');
          return;
        case 'refuse':
          // The wire stays half-drawn on purpose: the next click is very likely
          // the target they meant, and cancelling would make them start over to
          // correct a mistake the canvas has just explained.
          setRefusal(outcome.reason);
          onSay(outcome.reason);
          return;
        case 'connect':
          onConnect(outcome.from, outcome.to);
          setPending(null);
          return;
      }
    },
    [canEdit, pending, nodes, edges, onConnect, onSay, cancel],
  );

  const accepts = useCallback(
    (nodeId: string, type: WiringHandleType) => {
      if (!pending || pending.type === type) return false;
      const from = pending.type === 'source' ? pending.nodeId : nodeId;
      const to = pending.type === 'source' ? nodeId : pending.nodeId;
      return canConnect(nodes, edges, from, to).ok;
    },
    [pending, nodes, edges],
  );

  const wiring = useMemo<WorkflowWiring>(
    () => ({ pending, onHandleClick, accepts, cancel }),
    [pending, onHandleClick, accepts, cancel],
  );

  return { wiring, refusal };
}

/**
 * Where a handle is, in the coordinates the canvas draws in.
 *
 * From the measurement React Flow already made, so the line starts on the dot
 * rather than near it. The fallback is the geometric edge of the box, which is
 * where the handle is anyway — it matters only for the frame between a node
 * mounting and the `ResizeObserver` reporting it, and a line that starts a few
 * pixels out for one frame beats no line at all.
 */
function handlePoint(node: WorkflowInternalNode, type: WiringHandleType): XYPosition {
  const at = node.internals.positionAbsolute;
  const handle = node.internals.handleBounds?.[type]?.[0];
  if (handle) {
    return { x: at.x + handle.x + handle.width / 2, y: at.y + handle.y + handle.height / 2 };
  }
  const width = node.measured.width ?? NODE_WIDTH;
  const height = node.measured.height ?? NODE_HEIGHT;
  return { x: at.x + (type === 'source' ? width : 0), y: at.y + height / 2 };
}

type WorkflowInternalNode = NonNullable<ReturnType<typeof useInternalNode<WorkflowFlowNode>>>;

/**
 * The line that follows the pointer while a click-started wire is open.
 *
 * React Flow will not draw this one — see the note at the top of this file — so
 * it is drawn here, into `ViewportPortal`, which puts it in the same transformed
 * layer as the edges. That is what keeps it registered with the graph while
 * somebody pans or zooms mid-gesture; arithmetic on the viewport transform in
 * this file would be a second, worse copy of what that portal already does.
 *
 * Dashed and travelling, because a wire that is not committed yet should not
 * look like one that is. Under `prefers-reduced-motion` the dashes hold still —
 * the line, its colour and its position are the information; the march is not.
 */
export function PendingWireLine({ pending }: { pending: PendingWire | null }) {
  const reduced = useReducedMotion();
  const { screenToFlowPosition } = useReactFlow();
  const node = useInternalNode<WorkflowFlowNode>(pending?.nodeId ?? '');
  const [pointer, setPointer] = useState<XYPosition | null>(null);

  useEffect(() => {
    if (!pending) {
      setPointer(null);
      return;
    }
    const follow = (event: PointerEvent) => {
      setPointer(screenToFlowPosition({ x: event.clientX, y: event.clientY }));
    };
    window.addEventListener('pointermove', follow);
    return () => window.removeEventListener('pointermove', follow);
  }, [pending, screenToFlowPosition]);

  if (!pending || !node) return null;

  const origin = handlePoint(node, pending.type);
  // Drawn source-end to target-end whichever end was clicked first, so a wire
  // started from an input curves the same way as one started from an output.
  // Until the pointer has moved once there is nowhere to draw TO — so the anchor
  // is drawn on its own rather than nothing at all, because the frames between
  // the click and the first movement are exactly the ones somebody is looking at
  // to find out whether the click registered.
  const from = pending.type === 'source' ? origin : pointer;
  const to = pending.type === 'source' ? pointer : origin;

  const path =
    from && to
      ? getSmoothStepPath({
          sourceX: from.x,
          sourceY: from.y,
          targetX: to.x,
          targetY: to.y,
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
          borderRadius: 12,
        })[0]
      : null;

  return (
    <ViewportPortal>
      {/*
       * Zero-sized with visible overflow: the SVG is a coordinate space pinned
       * to the graph's origin, not a box. `pointer-events: none` throughout,
       * because the one thing this line must never do is get in the way of the
       * click that ends it.
       */}
      <svg
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: 1,
          height: 1,
          overflow: 'visible',
          pointerEvents: 'none',
          zIndex: 1001,
        }}
      >
        <title>The connection being drawn</title>
        {path && (
          <motion.path
            d={path}
            fill="none"
            stroke="var(--xy-connectionline-stroke)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeDasharray="7 6"
            initial={reduced ? false : { strokeDashoffset: 0, opacity: 0 }}
            animate={reduced ? { opacity: 1 } : { strokeDashoffset: -26, opacity: 1 }}
            transition={
              reduced
                ? { duration: 0 }
                : {
                    strokeDashoffset: {
                      duration: 0.7,
                      repeat: Number.POSITIVE_INFINITY,
                      ease: 'linear',
                    },
                    opacity: { duration: 0.12 },
                  }
            }
          />
        )}
        {/* The end it is anchored to, so the gesture has a visible origin from
            the click itself rather than from the first movement after it. */}
        <circle cx={origin.x} cy={origin.y} r={4} fill="var(--xy-connectionline-stroke)" />
        {!reduced && (
          <motion.circle
            cx={origin.x}
            cy={origin.y}
            fill="none"
            stroke="var(--xy-connectionline-stroke)"
            strokeWidth={1.5}
            initial={{ r: 4, opacity: 0.7 }}
            animate={{ r: 12, opacity: 0 }}
            transition={{ duration: 1.1, repeat: Number.POSITIVE_INFINITY, ease: 'easeOut' }}
          />
        )}
      </svg>
    </ViewportPortal>
  );
}

/**
 * What the canvas says while a wire is open, and when it will not close one.
 *
 * On the canvas rather than only in the live region, because this is the
 * gesture's entire feedback for somebody using a mouse: the drag could refuse
 * itself by turning a handle red under the cursor, and a click has no equivalent
 * moment. "Refused visibly" has to mean a sentence somebody can read.
 *
 * `Panel` places it in React Flow's own overlay layer, so it stays put while the
 * graph is panned underneath it.
 */
export function WiringHint({
  pending,
  refusal,
  nodes,
  onCancel,
}: {
  pending: PendingWire | null;
  refusal: string | null;
  nodes: WorkflowNode[];
  onCancel(): void;
}) {
  const reduced = useReducedMotion();
  const anchor = pending ? labelOf(nodes, pending.nodeId) : '';

  return (
    <Panel position="top-center" className="pointer-events-none">
      <AnimatePresence mode="wait">
        {pending && (
          <motion.div
            key={refusal ?? 'drawing'}
            initial={reduced ? false : { opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced ? { opacity: 1 } : { opacity: 0, y: -6 }}
            transition={reduced ? { duration: 0 } : { type: 'spring', stiffness: 500, damping: 34 }}
            className={
              refusal
                ? 'pointer-events-auto flex max-w-md items-start gap-2 rounded-full border border-rose-300 bg-rose-50/95 py-1 pl-3 pr-1 text-[11px] text-rose-700 shadow-sm backdrop-blur dark:border-rose-900 dark:bg-rose-950/90 dark:text-rose-300'
                : 'pointer-events-auto flex max-w-md items-start gap-2 rounded-full border border-violet-300 bg-violet-50/95 py-1 pl-3 pr-1 text-[11px] text-violet-700 shadow-sm backdrop-blur dark:border-violet-900 dark:bg-violet-950/90 dark:text-violet-300'
            }
          >
            <span className="mt-[3px] shrink-0">
              {refusal ? <CircleAlert size={12} /> : <Link2 size={12} />}
            </span>
            <span className="py-0.5 leading-snug">
              {refusal ??
                (pending.type === 'source'
                  ? `Wiring out of “${anchor}”. Click the input of the node it should feed.`
                  : `Wiring into “${anchor}”. Click the output of the node that should feed it.`)}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-5 shrink-0 rounded-full px-2 text-[10px] font-medium"
              onClick={onCancel}
            >
              Cancel
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
    </Panel>
  );
}
