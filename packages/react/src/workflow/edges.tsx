import {
  BaseEdge,
  EdgeLabelRenderer,
  type EdgeProps,
  getSmoothStepPath,
  useReactFlow,
} from '@xyflow/react';
import { X } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { type ReactNode, createContext, useContext } from 'react';
import { Button } from '../ui/button';
import type { WorkflowEdge } from './model';

/**
 * The edge, and the one gesture it was missing.
 *
 * ## Why this file exists
 *
 * Removing a connection was already wired — `onDisconnect(edge)` has been on the
 * canvas since the wiring menu was added — but every way of *reaching* it went
 * through something else: a menu hanging off a node, a row in the wiring rail,
 * or selecting the line and knowing that Delete is a key. The thing somebody
 * reaches for first is the connection itself, and clicking it did nothing
 * visible. So this is not a new capability; it is the missing gesture on one
 * that already existed.
 *
 * ## Selection, not hover
 *
 * The × appears when the edge is **selected**, which React Flow does on click
 * and also on Enter or Space when the edge has keyboard focus. Hover would have
 * been fractionally quicker with a mouse and unreachable without one, and it
 * would put a delete button under the pointer of somebody who is only tracing
 * where a line goes. Selection is a decision; hover is a coincidence.
 *
 * ## What the keyboard gets
 *
 * All of it, by two routes. React Flow renders the edge as a focusable element
 * with `edgesFocusable`, so Tab reaches it and Enter or Space selects it — at
 * which point the × exists in the document and is an ordinary `<button>` in the
 * tab order. And the route that predates this is untouched: the wiring rail
 * beside the canvas lists every connection as a row with its own Disconnect
 * button, reachable without going near the canvas at all. The × is an
 * affordance, never the only way through, and `workflow-edge-delete.spec.tsx`
 * holds both halves of that so neither can quietly become the other.
 *
 * ## What reduced motion gets
 *
 * The same button, in the same place, doing the same thing — it simply arrives
 * without the scale-and-fade. Nothing here is revealed *by* an animation: the ×
 * is mounted by `selected`, and `AnimatePresence` only decides how it comes and
 * goes. Somebody with `prefers-reduced-motion` loses a flourish, not a control.
 *
 * ## Why the placement and the animation are on two different elements
 *
 * They used to be on one, and that is the bug this file was reopened for. The ×
 * was a `motion.div` that both carried
 * `transform: translate(-50%, -140%) translate(Xpx, Ypx)` in its `style` and
 * animated `scale`. Motion owns the WHOLE `transform` property of anything it
 * animates a transform component of: it composes the property from its own
 * values every frame and writes the result, so the hand-written translate was
 * overwritten — and at rest, with `scale: 1` and nothing else to compose, what
 * it wrote was `transform: none`. The control then sat at the untranslated
 * origin of `.react-flow__edgelabel-renderer`, which is the top-left of the
 * graph, underneath the first node. Measured in a browser: the button 414px
 * left and 42px above the line's midpoint, and `elementFromPoint` at its centre
 * returning the source node's header. It was present, labelled, opacity 1, and
 * unreachable.
 *
 * So the two jobs are split. A plain `<div>` does the positioning and Motion
 * never touches it; the `motion.div` inside it animates opacity and scale only,
 * about an origin the outer div has already put in the right place. The outer
 * div stays mounted whether or not the × is offered, because it is what
 * `AnimatePresence` needs to be rendered inside for the exit to play at all.
 * `workflow-edge-delete.spec.tsx` pins the translate onto that outer element.
 */

/**
 * What an edge can reach without being handed a callback through `data`.
 *
 * A context for the same reason `WorkflowNodeContext` is one: React Flow
 * compares an edge's `data` between renders, and a function in there is a new
 * identity every time the screen renders, which invalidates every edge at once.
 *
 * The default throws rather than no-oping. An edge rendered outside the canvas
 * would otherwise look entirely normal and quietly ignore every click on its ×,
 * which is a far worse bug to find than an error naming the missing provider.
 */
interface WorkflowEdgeHandlers {
  /** Remove this connection. Same callback the wiring menu and the rail use. */
  onDisconnect(edge: WorkflowEdge): void;
  /** Whether editing is offered at all. Read-only viewers get no ×. */
  canEdit: boolean;
}

const WorkflowEdgeContext = createContext<WorkflowEdgeHandlers | null>(null);

export function WorkflowEdgeProvider({
  handlers,
  children,
}: {
  handlers: WorkflowEdgeHandlers;
  children: ReactNode;
}) {
  return <WorkflowEdgeContext.Provider value={handlers}>{children}</WorkflowEdgeContext.Provider>;
}

function useWorkflowEdgeHandlers(): WorkflowEdgeHandlers {
  const handlers = useContext(WorkflowEdgeContext);
  if (!handlers) {
    throw new Error('A workflow edge was rendered outside <WorkflowEdgeProvider>.');
  }
  return handlers;
}

/**
 * What an edge carries for its own sake, beyond the two node ids.
 *
 * The labels rather than the ids, because the accessible name of the delete
 * button has to say which connection it removes in the words on the canvas —
 * "Remove the connection from src_1 to snk_1" names two things nobody can see.
 */
export interface WorkflowEdgeData extends Record<string, unknown> {
  fromLabel: string;
  toLabel: string;
}

function readLabels(data: unknown): { fromLabel: string; toLabel: string } {
  // Narrowed rather than asserted: `data` is React Flow's open bag, and an edge
  // built by anything other than `toFlowEdges` would otherwise render a button
  // whose accessible name is the word "undefined".
  if (typeof data === 'object' && data !== null && 'fromLabel' in data && 'toLabel' in data) {
    const { fromLabel, toLabel } = data;
    if (typeof fromLabel === 'string' && typeof toLabel === 'string') return { fromLabel, toLabel };
  }
  return { fromLabel: '', toLabel: '' };
}

/**
 * How the × comes and goes.
 *
 * A spring rather than a tween, so it settles rather than stopping — the control
 * is appearing at a point somebody just clicked, and a linear pop reads as a
 * tooltip rather than as something they summoned. Short and stiff enough that it
 * is finished before the hand moves.
 */
const APPEAR = { type: 'spring', stiffness: 520, damping: 30, mass: 0.6 } as const;

export function WorkflowEdgeBody({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  selected,
  data,
}: EdgeProps) {
  const { onDisconnect, canEdit } = useWorkflowEdgeHandlers();
  const reduced = useReducedMotion();
  const { setEdges } = useReactFlow();
  const { fromLabel, toLabel } = readLabels(data);

  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    // Rounder than React Flow's 5px default. The corners are the only part of a
    // smoothstep edge with any character, and at 5px they read as a mitre.
    borderRadius: 12,
  });

  const offered = Boolean(selected) && canEdit;

  return (
    <>
      {/*
       * A halo under the selected line, drawn before `BaseEdge` so it paints
       * behind it. A selected edge previously said so by getting 1px thicker,
       * which on a canvas of grey lines at 80% zoom is not a signal anybody
       * finds — and it is the state the × belongs to, so it is worth being able
       * to see. Wide, faint, and in the same variable the stroke uses, so it
       * follows the theme rather than introducing a second palette.
       */}
      {selected && (
        <path
          d={path}
          fill="none"
          stroke="var(--xy-edge-stroke-selected)"
          strokeWidth={10}
          strokeOpacity={0.18}
          strokeLinecap="round"
          // Never a click target: the interaction path below is what catches
          // the pointer, and a second wide path that also did would make the
          // selected edge harder to click *past* than an unselected one.
          style={{ pointerEvents: 'none' }}
        />
      )}

      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{
          ...style,
          // Only the width is set here. The colour stays on React Flow's own
          // `--xy-edge-stroke` variables, which `CANVAS_THEME` already themes for
          // light and dark — restating a hex here would be a third place for the
          // canvas's palette to live, and the one that forgets dark mode.
          strokeWidth: selected ? 2.5 : (style?.strokeWidth ?? 1.5),
        }}
        // Wider than the 20px default. This is the invisible path that catches
        // the click, and the whole complaint was that clicking the line did
        // nothing — which is at least as often "missed it" as "nothing happened".
        interactionWidth={26}
      />

      <EdgeLabelRenderer>
        {/*
         * The placement, on a plain element nothing animates.
         *
         * Positioned above the midpoint of the line rather than on it, so the
         * button does not sit on top of the thing it refers to. The translate is
         * in the label layer's coordinates and React Flow's own viewport
         * transform is already applied by that layer's container.
         *
         * This element exists whether or not the × is offered. It has to: it is
         * the box `AnimatePresence` renders inside, and moving the mount/unmount
         * up here would take the exit animation with it. Empty it is 0×0 and
         * takes no pointer, so an unselected edge costs one inert div.
         */}
        <div
          className="nodrag nopan"
          style={{
            position: 'absolute',
            transform: `translate(-50%, -140%) translate(${labelX}px, ${labelY}px)`,
            // The label layer has no pointer events by default, which is what
            // keeps edge labels from eating drags. This wrapper does not want
            // them either — only the button inside it does.
            pointerEvents: 'none',
          }}
        >
          <AnimatePresence>
            {offered && (
              <motion.div
                // Opacity and scale ONLY. Motion composes the entire `transform`
                // property from the values it animates, so a translate written
                // here would be overwritten the moment `scale` moves — which is
                // exactly how this control ended up at the origin, under a node.
                // The translate lives on the parent, where nothing composes it.
                style={{ pointerEvents: 'all' }}
                initial={reduced ? false : { opacity: 0, scale: 0.6 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={reduced ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.6 }}
                transition={reduced ? { duration: 0 } : APPEAR}
              >
                <Button
                  variant="outline"
                  size="icon"
                  // Round, small, and red on hover — the shape says "close this
                  // one thing" and the colour arrives only once the pointer has
                  // committed, so a row of edges is not a row of red buttons.
                  className="h-6 w-6 rounded-full shadow-sm transition-colors hover:border-rose-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:border-rose-800 dark:hover:bg-rose-950 dark:hover:text-rose-400"
                  aria-label={`Remove the connection from ${fromLabel || source} to ${toLabel || target}`}
                  onClick={() => {
                    // Deselected first, so the button is gone by the time the
                    // graph re-renders. Without this the id stays in React
                    // Flow's selection and a *new* edge later given the same id
                    // — same two nodes rewired — would come back already
                    // selected, with an × floating over a connection nobody
                    // clicked.
                    setEdges((edges) =>
                      edges.map((edge) => (edge.id === id ? { ...edge, selected: false } : edge)),
                    );
                    onDisconnect({ from: source, to: target });
                  }}
                >
                  <X size={12} />
                </Button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

/**
 * Declared once, at module scope, for the same reason `workflowNodeTypes` is.
 *
 * React Flow compares `edgeTypes` by identity and warns — then remounts every
 * edge — when it changes. An object literal written inline in the screen is a new
 * object on every render, so the canvas would tear down and rebuild every
 * connection on each keystroke in the name field.
 */
export const workflowEdgeTypes = { workflowEdge: WorkflowEdgeBody };
