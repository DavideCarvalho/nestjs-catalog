import { NODE_HEIGHT, NODE_WIDTH } from './graph';
import type { WorkflowNode } from './model';

/**
 * Where a node goes when something other than the toolbar creates it.
 *
 * Three callers now, and they were one: wiring a new node off an existing one,
 * inserting one into a wire that already exists, and dropping one where somebody
 * right-clicked. They share a rule — *land on the grid `layout` would have used,
 * and never on top of something* — and that rule was written out once, inside
 * the canvas, next to seven hundred lines that have nothing to do with geometry.
 *
 * Moved out rather than copied, because the failure of a second copy is silent:
 * two placements that disagree by 32 pixels look correct in isolation and shuffle
 * the whole graph the first time somebody presses Tidy.
 */

/**
 * The grid `layout` uses, restated because it keeps its gaps to itself.
 *
 * `NODE_WIDTH` and `NODE_HEIGHT` come from core — the server spaces its own
 * adopted graphs by them — but the column and row *gaps* are private to
 * `layout`. They are repeated here so a node created by any of the gestures
 * below lands where Tidy would have put it. If they ever drift, the consequence
 * is spacing that looks slightly off and never a node in the wrong place: every
 * function here is defined by what is *occupied*, not by these numbers.
 */
export const COLUMN_STEP = NODE_WIDTH + 96;
export const ROW_STEP = NODE_HEIGHT + 32;

/** Every position a node currently sits on, as the key the search below tests. */
function occupied(nodes: WorkflowNode[]): Set<string> {
  return new Set(nodes.map((node) => `${node.position?.x ?? 0},${node.position?.y ?? 0}`));
}

/**
 * The first free spot at or below a point, stepping down one row at a time.
 *
 * Down rather than right, in every caller, because down is the axis `layout`
 * treats as "same depth, different branch": moving right would claim a column
 * that means "runs after this", which is a lie about the graph told in the one
 * language the canvas has for saying it.
 */
export function freeSpot(
  nodes: WorkflowNode[],
  at: { x: number; y: number },
): { x: number; y: number } {
  const taken = occupied(nodes);
  let y = at.y;
  while (taken.has(`${at.x},${y}`)) y += ROW_STEP;
  return { x: at.x, y };
}

/**
 * Where a node created *by wiring from another node* goes.
 *
 * One column to the right of the node that spawned it, because that is exactly
 * what the canvas's arrangement means: `layout` puts a node one column past the
 * deepest thing feeding it, and a node created by this action is fed by that
 * node and nothing else. So the position that matches the picture is not a
 * guess — it is the position the layout would have chosen anyway.
 *
 * The three obvious alternatives are each wrong in their own way: under the
 * cursor puts a node wherever a menu happened to be dismissed, on top of an
 * existing node reads as "the button did nothing", and off-screen — which is
 * what `nextPosition` does, correctly, for the toolbar's add buttons, since
 * those have no parent to sit beside — leaves somebody looking at an unchanged
 * canvas. Sitting beside its parent means it is on screen whenever its parent
 * is, which is the only guarantee available without measuring the viewport.
 */
export function placeNextTo(from: WorkflowNode, nodes: WorkflowNode[]): { x: number; y: number } {
  return freeSpot(nodes, {
    x: (from.position?.x ?? 0) + COLUMN_STEP,
    y: from.position?.y ?? 0,
  });
}

/**
 * Where a node **spliced into an existing wire** goes: between its two ends.
 *
 * Deliberately not `placeNextTo(from)`. A node inserted into `A → B` runs after
 * A and before B, and the whole reason somebody can read this canvas is that
 * left-to-right is run order — so dropping it in A's next column, which is
 * frequently B's column, would draw the new node level with the node it now
 * feeds. Halfway is the only position that states the relationship correctly
 * before Tidy is ever pressed.
 *
 * Rounded to whole pixels because these end up in a saved graph and
 * `{x: 383.5}` in stored JSON is noise that shows up in every diff of it.
 */
export function placeBetween(
  from: WorkflowNode | undefined,
  to: WorkflowNode | undefined,
  nodes: WorkflowNode[],
): { x: number; y: number } {
  const a = from?.position ?? { x: 0, y: 0 };
  const b = to?.position ?? { x: a.x + COLUMN_STEP * 2, y: a.y };
  return freeSpot(nodes, {
    x: Math.round((a.x + b.x) / 2),
    y: Math.round((a.y + b.y) / 2),
  });
}
