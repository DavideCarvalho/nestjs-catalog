import { type WorkflowEdge, type WorkflowNode, nodeName } from './model';

/**
 * Taking nodes out, and saying what went with them.
 *
 * ## Why this is not an undo
 *
 * It was, for about an hour. Deleting a node became a one-click control on the
 * node's hover toolbar and an item on its right-click menu — both asked for,
 * both right — and a one-click delete with no way back is a bad trade on a
 * canvas where the unsaved draft is *everything* somebody has done since their
 * last save. So this file grew a ten-second "removed · undo" window.
 *
 * A real per-action undo stack landed while that was being written, and it is a
 * better answer to the same problem in every respect: it covers every gesture
 * rather than the destructive two, it has a Reset beside it, and it guards the
 * tab against being closed on unsaved work. Shipping a second, narrower
 * mechanism next to it would give the canvas two things called undo that behave
 * differently — which is precisely the failure this whole change exists to fix,
 * since the reason a context menu was needed at all is that the canvas had two
 * things called "wire". So the window went, and `history.tsx` is the way back.
 *
 * ## What is left, and why it is worth a module
 *
 * One fact that the undo stack does not state and nothing else on the screen
 * does either: **a node takes its wires with it.** Removing a box silently
 * unwires up to two other boxes, and a canvas that reports "node removed" leaves
 * somebody to discover half an hour later that their graph no longer reaches its
 * sink. Undo makes that recoverable; it does not make it visible.
 *
 * So this is the filter and the sentence, together, so that every gesture that
 * removes a node says the same thing about what it cost — and so the menu item
 * and the delete button can say it *before* the click as well as after.
 */

/** "1 connection" / "3 connections", with the plural not left to the reader. */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * The graph without those nodes, and what that cost, in one sentence.
 *
 * The edges are counted before the nodes are dropped, because an edge goes for
 * touching a removed node *at either end* — and a caller working from the
 * filtered graph could no longer tell which ones those were.
 *
 * The nodes are named and the wires are counted, deliberately in that
 * proportion. "1 node removed" sends somebody looking at the canvas to work out
 * which; a node with six wires named one at a time is a sentence nobody
 * finishes. The count is what answers the question this sentence exists for:
 * *did anything else just change?*
 */
export function removeNodes(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  ids: readonly string[],
): { nodes: WorkflowNode[]; edges: WorkflowEdge[]; said: string } {
  const going = new Set(ids);
  const removed = nodes.filter((node) => going.has(node.id));
  const cut = wiresOn(edges, ids);

  return {
    nodes: nodes.filter((node) => !going.has(node.id)),
    edges: edges.filter((edge) => !going.has(edge.from) && !going.has(edge.to)),
    said: describeRemoval(removed, cut),
  };
}

function describeRemoval(removed: WorkflowNode[], wires: number): string {
  if (removed.length === 0) return 'Nothing was removed.';
  const named =
    removed.length <= 3
      ? removed.map((node) => `"${nodeName(node)}"`).join(', ')
      : count(removed.length, 'node');
  if (wires === 0) return `${named} removed. Nothing was wired to it.`;
  return `${named} removed, and the ${count(wires, 'connection')} it was part of went with it.`;
}

/**
 * How many wires a removal would take, for a warning written before the click.
 *
 * The same count {@link removeNodes} reports afterwards, asked in advance —
 * which is where it does the most good: on the menu item, and on the tooltip of
 * a delete button that does not stop to ask.
 */
export function wiresOn(edges: WorkflowEdge[], ids: readonly string[]): number {
  const going = new Set(ids);
  return edges.filter((edge) => going.has(edge.from) || going.has(edge.to)).length;
}
