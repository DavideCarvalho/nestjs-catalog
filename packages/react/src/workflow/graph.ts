import {
  WORKFLOW_NODE_HEIGHT,
  WORKFLOW_NODE_WIDTH,
  workflowColumnX,
  workflowRowY,
  workflowRunOrder,
} from '@dudousxd/nestjs-catalog/client';
import type { Edge, Node } from '@xyflow/react';
import { MarkerType } from '@xyflow/react';
import {
  type WorkflowBranchLabel,
  type WorkflowCallNode,
  type WorkflowEdge,
  type WorkflowFilterNode,
  type WorkflowFilterOperator,
  type WorkflowFilterPredicate,
  type WorkflowFilterValue,
  type WorkflowIfNode,
  type WorkflowIfPredicate,
  type WorkflowNode,
  type WorkflowNodeKind,
  type WorkflowRunNode,
  type WorkflowSourceNode,
  nodeName,
  unreachableFilterOperator,
  unreachableFilterPredicateKind,
  unreachableNodeKind,
  unreachablePredicateKind,
  workflowCallMode,
} from './model';
import { type WorkflowProblem, edgeId } from './validate';

/**
 * Turning the stored graph into what React Flow draws, and back.
 *
 * Kept out of the screen because the two models genuinely differ and the
 * conversion is where that difference is allowed to live. React Flow wants
 * `source`/`target` on an edge and a `data` bag on a node; the executable model
 * wants `from`/`to` and named fields. Letting React Flow's vocabulary leak into
 * what gets saved would tie the wire format to a rendering library, and the
 * next person swapping the canvas would be migrating a database.
 */

/**
 * Fixed node dimensions, used by the layout below.
 *
 * Declared rather than measured because layout runs before React Flow has
 * measured anything — on a graph loaded from the server, or one somebody just
 * pasted — and a layout that waits for measurements draws every node stacked at
 * the origin for one frame, which reads as a broken canvas.
 *
 * **Re-exported from core rather than declared here**, and that is the point of
 * the change that moved them. The server also writes positions —
 * `adoptConnector` wraps a connector into a graph and has to space its columns —
 * and while these numbers lived only in this file it had nothing to derive from,
 * so it used a literal that was four pixels narrower than the node. Every
 * adopted graph drew its boxes overlapping. Sharing the constant is what stops
 * the two from being able to disagree; the names stay `NODE_WIDTH`/`NODE_HEIGHT`
 * because they are part of this package's published `/workflow` surface.
 */
export const NODE_WIDTH = WORKFLOW_NODE_WIDTH;
export const NODE_HEIGHT = WORKFLOW_NODE_HEIGHT;

/**
 * What a node needs to draw itself.
 *
 * A `type` alias rather than an `interface`, and this is not a style
 * preference: React Flow's `Node<T>` constrains `T extends Record<string,
 * unknown>`, and TypeScript gives a type alias of an object literal an implicit
 * index signature while an interface never gets one. Written as an interface,
 * this fails to satisfy the constraint with an error that points at the
 * generic rather than at the declaration.
 *
 * Handlers are deliberately absent — they arrive through context instead (see
 * `WorkflowNodeContext`). Putting a callback in `data` gives every node a new
 * `data` object on every render of the screen, which defeats React Flow's own
 * memoisation and makes a large graph stutter while somebody drags one node.
 */
export type WorkflowNodeData = {
  kind: WorkflowNodeKind;
  label: string;
  /** The second line: which transform, which system, which type. */
  subtitle: string;
  /** Only the problems naming this node, so the node can ring itself. */
  problems: WorkflowProblem[];
  run?: WorkflowRunNode;
};

export type WorkflowFlowNode = Node<WorkflowNodeData, 'workflowNode'>;
export type WorkflowFlowEdge = Edge;

export interface NodeDescriptions {
  transformName(id: string | undefined): string | undefined;
  connectionName(id: string | undefined): string | undefined;
}

/**
 * The second line on a node, per kind.
 *
 * A source reads its own description off itself rather than off a connector it
 * points at: a source *is* the reading half of a connector — a kind, an optional
 * named connection, a config — and pointing one at a whole connector would be
 * circular, since a connector references a workflow.
 */
function subtitleFor(node: WorkflowNode, describe: NodeDescriptions): string {
  if (node.kind === 'source') return sourceSubtitle(node, describe);
  if (node.kind === 'sink') {
    const type = typeof node.targetType === 'string' ? node.targetType.trim() : '';
    return type.length > 0 ? `commits ${type}` : 'no object type chosen';
  }
  if (node.kind === 'call') return callSubtitle(node);
  if (node.kind === 'if') return ifSubtitle(node);
  if (node.kind === 'filter') return filterSubtitle(node);
  if (node.kind === 'transform') {
    return describe.transformName(node.transformId) ?? 'no transform chosen';
  }
  return unreachableNodeKind(node, 'subtitleFor');
}

/**
 * How much a node's face will spend on a predicate before summarising it.
 *
 * A node is 224px wide and the subtitle is one truncated line, so a long
 * predicate spelled out in full is an ellipsis and nothing else. Past this many
 * leaves the face says how many conditions there are instead, which at least
 * tells a reader there is something to open.
 */
const FILTER_FACE_LEAVES = 2;

/**
 * The test, on the face of the node — the reason this kind exists rather than a
 * transform that returns a subset.
 *
 * "Keep the open orders" readable off the canvas is reason one of three on
 * `WorkflowFilterNode`, so the subtitle is the feature and not decoration. It
 * shows the *values* as well as the columns, which is a difference from
 * `ifSubtitle` and a deliberate one: an if node stores the name of an
 * environment variable and never its contents, because that is where a
 * credential would be, while a filter's value is a business constant somebody
 * typed into the graph and is already visible to anyone who can see the node.
 *
 * The predicate is read into a variable that admits `undefined` before it is
 * narrowed, for the reason `ifSubtitle` gives: this draws whatever a server
 * sent, and a canvas that throws while rendering a node is a screen nobody can
 * use to fix that node.
 */
function filterSubtitle(node: WorkflowFilterNode): string {
  const predicate: WorkflowFilterPredicate | undefined = node.predicate;
  if (!predicate) return 'nothing to test';
  const leaves = countFilterLeaves(predicate);
  if (leaves > FILTER_FACE_LEAVES) return `keeps rows matching ${leaves} conditions`;
  return `keeps ${describeFilterPredicate(predicate)}`;
}

/** How many comparisons a predicate is made of, groups not counted. */
function countFilterLeaves(predicate: WorkflowFilterPredicate): number {
  if (predicate.kind === 'all' || predicate.kind === 'any') {
    let total = 0;
    for (const child of predicate.children) total += countFilterLeaves(child);
    return total;
  }
  return 1;
}

/**
 * A predicate as a sentence.
 *
 * Shared by the node's face and by the inspector's summary, so the two cannot
 * describe one filter differently — which on a screen whose whole job is making
 * a drop visible would be worse than describing it badly.
 *
 * Groups are parenthesised whenever they are nested, and never at the top, so
 * the common single-group predicate reads as a list rather than as a formula.
 */
export function describeFilterPredicate(
  predicate: WorkflowFilterPredicate,
  nested = false,
): string {
  if (predicate.kind === 'all' || predicate.kind === 'any') {
    const joined = predicate.children
      .map((child) => describeFilterPredicate(child, true))
      .join(predicate.kind === 'all' ? ' and ' : ' or ');
    return nested && predicate.children.length > 1 ? `(${joined})` : joined;
  }
  if (predicate.kind === 'present') {
    return `${predicate.column} ${predicate.operator === 'isNull' ? 'is empty' : 'has a value'}`;
  }
  if (predicate.kind === 'oneOf') {
    const values = predicate.values.map((value) => showFilterValue(value)).join(', ');
    return `${predicate.column} ${predicate.operator === 'in' ? 'is one of' : 'is none of'} ${values}`;
  }
  if (predicate.kind === 'compare') {
    return `${predicate.column} ${FILTER_OPERATOR_WORDS[predicate.operator]} ${showFilterValue(predicate.value)}`;
  }
  return unreachableFilterPredicateKind(predicate, 'describeFilterPredicate');
}

/**
 * Each operator as the words a reader of the canvas would use.
 *
 * A `Record` keyed by the operator union, so an operator added to core without a
 * phrase here is a build failure rather than a node whose subtitle silently says
 * `undefined` — the same reason `BRANCH_STYLE` above is a record.
 *
 * Symbols rather than words for the four orderings, because `>` is unambiguous
 * in every locale a column name is written in and "greater than" is three words
 * of a line that has to fit in 224 pixels.
 */
const FILTER_OPERATOR_WORDS: Record<WorkflowFilterOperator, string> = {
  equals: '=',
  notEquals: '≠',
  greaterThan: '>',
  greaterThanOrEqual: '≥',
  lessThan: '<',
  lessThanOrEqual: '≤',
  contains: 'contains',
  notContains: 'does not contain',
  startsWith: 'starts with',
  notStartsWith: 'does not start with',
};

/**
 * One value, quoted only when it is text.
 *
 * `status = "OPEN"` and `qty = 10` are different tests, and the quotes are the
 * only thing on the face that says which — three-valued logic aside, a string
 * `"10"` never equals a number `10` here, and that is exactly the mistake the
 * run log has to report as an incomparable value.
 */
function showFilterValue(value: WorkflowFilterValue): string {
  return typeof value === 'string' ? `"${value}"` : String(value);
}

/**
 * The test, on the face of the node.
 *
 * Written as the condition rather than as the variable alone, because the whole
 * question somebody reads a branch to answer is "which way does this go here",
 * and `CLICKHOUSE_URL` on its own does not say whether it is being tested for
 * presence or for a value. The name is shown; a value never is — the node stores
 * the name of a variable and this screen has no more than that.
 *
 * The predicate is read into a variable that admits `undefined` before it is
 * narrowed, even though the type says it is always there. This runs on whatever
 * a server sent, and a canvas that throws while drawing a node is a screen
 * nobody can use to fix the node — a subtitle saying the gate has no test is.
 */
function ifSubtitle(node: WorkflowIfNode): string {
  const predicate: WorkflowIfPredicate | undefined = node.predicate;
  if (!predicate) return 'nothing to decide on';
  if (predicate.kind === 'env') {
    const name = typeof predicate.envVar === 'string' ? predicate.envVar.trim() : '';
    if (name.length === 0) return 'no variable chosen';
    return predicate.equals === undefined
      ? `if ${name} is set`
      : `if ${name} = ${predicate.equals}`;
  }
  if (predicate.kind === 'rowCount') {
    return predicate.atLeast === 1
      ? 'if any rows arrived'
      : `if ${predicate.atLeast} rows or more arrived`;
  }
  return unreachablePredicateKind(predicate, 'ifSubtitle');
}

/** What a source reads from: its kind, and the connection or mode that narrows it. */
function sourceSubtitle(node: WorkflowSourceNode, describe: NodeDescriptions): string {
  const kind = typeof node.sourceKind === 'string' ? node.sourceKind : '';
  if (kind.length === 0) return 'no source kind chosen';
  const connection = describe.connectionName(node.connectionId);
  if (connection) return `${kind} · ${connection}`;
  return node.mode === 'incremental' ? `${kind} · incremental` : kind;
}

/**
 * `name@version`, and the version is on the face of the node deliberately.
 *
 * It is the half that decides which code actually runs and the half people
 * forget is there: a node reading `billing` and a node reading `billing@2` are
 * different loads, and only one of them is pinned. So an unpinned call says so
 * on the canvas rather than only in the inspector nobody has open.
 */
function callSubtitle(node: WorkflowCallNode): string {
  const name = typeof node.callName === 'string' ? node.callName.trim() : '';
  const version = typeof node.callVersion === 'string' ? node.callVersion.trim() : '';
  if (name.length === 0) return 'no workflow chosen';
  const pinned = version.length > 0 ? `${name}@${version}` : `${name} · no version pinned`;
  // The plain mode is on the face of the node for the reason the version is:
  // it is the half that decides what the node can *do*, and a plain call that
  // reads like an ordinary one is a box somebody wires into a sink and then
  // wonders why the graph will not save.
  return workflowCallMode(node) === 'plain' ? `${pinned} · plain` : pinned;
}

/**
 * The sentence a screen reader reads when a node takes focus.
 *
 * Assembled here rather than left to React Flow's default, which announces
 * nothing but a node id. Everything that makes the node meaningful — what it
 * does, what feeds it, whether it is broken — has to be in this string, because
 * on a canvas it is the only thing a screen reader user gets.
 */
function ariaLabelFor(
  node: WorkflowNode,
  data: WorkflowNodeData,
  incoming: string[],
  outgoing: string[],
): string {
  const parts = [`${node.kind} node, ${data.label}, ${data.subtitle}`];
  parts.push(incoming.length === 0 ? 'nothing feeds it' : `fed by ${incoming.join(', ')}`);
  parts.push(outgoing.length === 0 ? 'feeds nothing' : `feeds ${outgoing.join(', ')}`);
  // The branch and the reason for a skip are in here as well as in the tooltip,
  // because on a canvas this string is the only thing a screen reader gets — and
  // "skipped" alone cannot distinguish a node a branch stood down from a node a
  // failure stranded, which is the one distinction this feature adds.
  if (data.run) {
    const branch = data.run.branch ? `, took the ${data.run.branch} branch` : '';
    const because =
      data.run.skippedBecause === 'branch-not-taken'
        ? ', because it is on the branch that was not taken, so it committed nothing'
        : '';
    // The drop is in the spoken label as well as the tooltip, because a tooltip
    // is a hover and this is the sentence a screen reader user gets instead of
    // the whole canvas. A filter that dropped nine tenths of a load and said so
    // only on hover would be invisible to exactly the reader who cannot check.
    const dropped = describeDrop(data.run);
    parts.push(`last run ${data.run.status}${branch}${because}${dropped ? `, ${dropped}` : ''}`);
  }
  for (const problem of data.problems) parts.push(problem.message);
  return parts.join('. ');
}

/**
 * What a filter did to a run, as a phrase — or nothing, for every other node.
 *
 * Keyed off `rowsIn` being **present** rather than off the node's kind, which is
 * the only check that stays right in both directions: a filter that ran before
 * the server recorded an input count has no drop to report and must not claim
 * one, and no other kind sets the field at all. Subtracting from a defaulted
 * zero would make every historical node read as having dropped its whole output.
 *
 * Exported so the node badge and the aria label say the same sentence.
 */
export function describeDrop(run: WorkflowRunNode): string | undefined {
  const given = run.rowsIn;
  if (typeof given !== 'number' || typeof run.rows !== 'number') return undefined;
  const dropped = given - run.rows;
  if (dropped <= 0) return `${given} rows in, none dropped`;
  // The percentage is what makes the number readable: "7,541,187 dropped" needs
  // arithmetic before anybody can tell a working filter from a broken predicate,
  // and "98.7%" does not.
  const share = given === 0 ? 0 : Math.round((dropped / given) * 1000) / 10;
  return `${given} rows in, ${run.rows} out — ${dropped} dropped (${share}%)`;
}

export function toFlowNodes(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  describe: NodeDescriptions,
  problemsFor: Map<string, WorkflowProblem[]>,
  runFor: Map<string, WorkflowRunNode>,
): WorkflowFlowNode[] {
  const labelOf = new Map(nodes.map((node) => [node.id, nodeName(node)]));
  const names = (ids: string[]) => ids.map((id) => labelOf.get(id) ?? id);

  return nodes.map((node) => {
    const data: WorkflowNodeData = {
      kind: node.kind,
      label: nodeName(node),
      subtitle: subtitleFor(node, describe),
      problems: problemsFor.get(node.id) ?? [],
      run: runFor.get(node.id),
    };
    const incoming = names(edges.filter((edge) => edge.to === node.id).map((edge) => edge.from));
    const outgoing = names(edges.filter((edge) => edge.from === node.id).map((edge) => edge.to));

    return {
      id: node.id,
      type: 'workflowNode',
      // Defaulted only as a last resort: `layoutIfUnarranged` is what is meant
      // to have supplied one, and a node reaching here without a position would
      // otherwise land on top of whatever else is at the origin.
      position: node.position ?? { x: 0, y: 0 },
      // Declared, not left to measurement.
      //
      // The minimap reads its rectangles from the node objects handed to React
      // Flow — `getNodeDimensions(userNode)` — not from what the DOM turned out
      // to be, and it draws nothing for a node with no dimensions. Without
      // these the canvas rendered perfectly and the overview beside it was a
      // blank white box, which reads as "this graph is empty" rather than as a
      // missing prop. They are the same numbers the layout already spaces nodes
      // by, so the map matches the canvas instead of approximating it.
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      data,
      ariaLabel: ariaLabelFor(node, data, incoming, outgoing),
      // React Flow's default role for a node is "group", which a screen reader
      // announces as a container rather than as something you can act on. These
      // nodes are the interactive objects on the screen.
      ariaRole: 'button',
    };
  });
}

export function defaultLabel(kind: WorkflowNodeKind): string {
  if (kind === 'source') return 'Source';
  if (kind === 'sink') return 'Sink';
  if (kind === 'call') return 'Call';
  if (kind === 'if') return 'If';
  if (kind === 'filter') return 'Filter';
  if (kind === 'transform') return 'Transform';
  return unreachableNodeKind(kind, 'defaultLabel');
}

/**
 * How a branch is drawn: a word on the wire, and a colour that means it.
 *
 * A **label**, not only a colour, and that is the accessibility half rather than
 * a stylistic one — two lines leaving one box differing by hue alone are one
 * line as far as a colour-blind reader is concerned, and this particular
 * distinction decides which half of a pipeline runs. Emerald for the branch
 * taken when the test passes and zinc for the other reads as "the positive one
 * and the fallback", which is what a then and an else are.
 *
 * Kept as a `Record` keyed by the label union so a third branch label added to
 * core without a line here is a type error rather than an unlabelled grey wire.
 */
const BRANCH_STYLE: Record<WorkflowBranchLabel, { stroke: string; text: string }> = {
  else: { stroke: '#a1a1aa', text: '#71717a' },
  // biome-ignore lint/suspicious/noThenProperty: the rule guards against an object being mistaken for a thenable by `await`; the key here is one of core's two branch labels and this record is only ever indexed by one of them, never awaited nor returned from anything async. Keying it by the label union is what makes a third label a compile error rather than an unlabelled grey wire, which is the whole reason it is a record and not a function.
  then: { stroke: '#10b981', text: '#059669' },
};

/**
 * The stored edges, as React Flow draws them.
 *
 * `flowing` is the set of edge ids whose upstream node is running right now, and
 * it is a parameter rather than something derived here because this module knows
 * nothing about runs. It is also **the caller's job to pass an empty set when
 * motion is unwanted** — see `WorkflowCanvas`, which reads `prefers-reduced-motion`
 * — because React Flow's `animated` flag is a CSS keyframe in its own stylesheet
 * and there is nothing this package can turn off from the outside.
 */
export function toFlowEdges(
  edges: WorkflowEdge[],
  nodes: WorkflowNode[],
  brokenEdgeIds: ReadonlySet<string>,
  flowing: ReadonlySet<string> = new Set(),
): WorkflowFlowEdge[] {
  const labelOf = new Map(nodes.map((node) => [node.id, nodeName(node)]));
  return edges.map((edge) =>
    toFlowEdge(edge, {
      from: labelOf.get(edge.from) ?? edge.from,
      to: labelOf.get(edge.to) ?? edge.to,
      broken: brokenEdgeIds.has(edgeId(edge)),
      flowing: flowing.has(edgeId(edge)),
    }),
  );
}

/**
 * The arrowhead, hoisted out of the edge builder — and this is a bug fix, not tidying.
 *
 * React Flow keeps one `<defs>` of marker definitions, derived from the markers
 * its edges reference. `toFlowEdges` is memoised on `draft.nodes`, so **every
 * frame of a node drag rebuilds the whole edge array**, and a fresh
 * `{ type, width, height }` literal per edge per frame churned that registry:
 * for the instant the defs were being rebuilt, `marker-end="url(#…)"` pointed at
 * nothing. The line survived — it is a `path` — and the arrowhead vanished,
 * which is exactly what somebody dragging a node reported seeing.
 *
 * One frozen object, referenced by every edge, gives the registry a stable
 * identity to dedupe on. Frozen rather than merely `const` because it is now
 * shared by every edge on the canvas, and a mutation would move all of them.
 */
const ARROW_END = Object.freeze({
  type: MarkerType.ArrowClosed,
  width: 14,
  height: 14,
});

/**
 * One wire, drawn.
 *
 * Split out of the `map` above so the styling decisions — arrowhead, branch
 * colour, the red a loop wears — sit in one function that is about a wire,
 * rather than in a closure that is also about resolving names.
 */
function toFlowEdge(
  edge: WorkflowEdge,
  context: { from: string; to: string; broken: boolean; flowing: boolean },
): WorkflowFlowEdge {
  const branch = edge.branch === undefined ? undefined : BRANCH_STYLE[edge.branch];
  return {
    id: edgeId(edge),
    source: edge.from,
    target: edge.to,
    // This package's own edge rather than the built-in `smoothstep`, because
    // clicking a connection has to offer to remove it. See `workflow/edges.tsx`.
    type: 'workflowEdge',
    // The names, not the ids: they become the accessible name of the delete
    // button, which has to say which connection it removes in the words that
    // are on the canvas.
    data: { fromLabel: context.from, toLabel: context.to },
    // Marching ants while the node feeding this edge is actually running. The
    // one thing a canvas can say about a run that a list of statuses cannot:
    // where the work currently is.
    animated: context.flowing,
    // An arrowhead, because "the output of this feeds that" is directional and
    // a plain line says only that two nodes are related.
    markerEnd: ARROW_END,
    label: edge.branch,
    labelStyle: branch ? { fill: branch.text, fontSize: 10, fontWeight: 600 } : undefined,
    // The word sits on the wire, so it takes the canvas behind it rather than a
    // filled plate that would blank out whatever the wire crosses.
    labelBgStyle: branch ? { fill: 'transparent' } : undefined,
    ariaLabel: `the output of ${context.from} feeds ${context.to}${
      edge.branch ? `, on the ${edge.branch} branch` : ''
    }${context.broken ? ', part of a loop' : ''}`,
    // An inline stroke rather than a class, because the stroke lands on an
    // SVG `<path>` React Flow owns: a Tailwind class on the edge wrapper does
    // not reach it, and inventing a stylesheet rule would mean this package
    // ships CSS for the first time just to colour one line.
    //
    // Broken wins over branch: a wire in a loop is a graph that will not run at
    // all, which is a bigger fact than which side of a decision it is on.
    style: edgeStroke(context, branch),
  };
}

/** Red for a loop, the branch's colour for a branch, React Flow's default otherwise. */
function edgeStroke(
  context: { broken: boolean },
  branch: { stroke: string } | undefined,
): { stroke: string; strokeWidth: number } | undefined {
  if (context.broken) return { stroke: '#ef4444', strokeWidth: 2 };
  return branch ? { stroke: branch.stroke, strokeWidth: 2 } : undefined;
}

/** Who feeds each node, by node id. Every node gets an entry, most of them empty. */
function feedersByNode(nodes: WorkflowNode[], edges: WorkflowEdge[]): Map<string, string[]> {
  const incoming = new Map<string, string[]>();
  for (const node of nodes) incoming.set(node.id, []);
  for (const edge of edges) {
    const list = incoming.get(edge.to);
    if (list) list.push(edge.from);
  }
  return incoming;
}

/**
 * Move one node to one column past the deepest thing feeding it, never left.
 *
 * Only ever increasing is what makes it safe to call repeatedly on the same
 * node, which is what the relaxation below relies on.
 */
function placeAfterFeeders(id: string, column: Map<string, number>, feeders: string[]): void {
  const depth =
    feeders.length === 0 ? 0 : Math.max(...feeders.map((from) => (column.get(from) ?? 0) + 1));
  column.set(id, Math.max(depth, column.get(id) ?? 0));
}

/**
 * Layer a graph that has no usable run order, by longest path.
 *
 * Relax every node repeatedly until nothing moves. With no cycle that settles in
 * at most one pass per node; with a cycle the pass cap is what stops it, and the
 * nodes on the cycle end up wherever the cap left them. So a graph with a loop
 * still draws — badly — rather than hanging while somebody is trying to see the
 * loop they need to remove.
 */
function relaxColumns(
  nodes: WorkflowNode[],
  incoming: Map<string, string[]>,
  column: Map<string, number>,
): void {
  for (let pass = 0; pass < nodes.length + 1; pass += 1) {
    const before = [...column.values()].join(',');
    for (const node of nodes) placeAfterFeeders(node.id, column, incoming.get(node.id) ?? []);
    if ([...column.values()].join(',') === before) break;
  }
  for (const node of nodes) if (!column.has(node.id)) column.set(node.id, 0);
}

/**
 * Which column each node belongs in, left to right.
 *
 * Built on core's `workflowRunOrder`, which is already topologically sorted and
 * is the same function the runner uses to decide what happens when. Taking the
 * order from there rather than computing a second one means the picture and the
 * execution agree by construction: a node drawn to the right of another really
 * does run after it.
 *
 * `workflowRunOrder` throws on a graph it will not run, which is a graph
 * somebody is in the middle of drawing — half-wired, or with a loop they are
 * about to remove. That is exactly when a canvas most needs to draw, so
 * `relaxColumns` layers it by longest path anyway.
 */
function columnsFor(nodes: WorkflowNode[], edges: WorkflowEdge[]): Map<string, number> {
  const incoming = feedersByNode(nodes, edges);
  const column = new Map<string, number>();

  try {
    // Topological order, so one pass is exact: everything feeding a node has
    // already been placed by the time the node is reached.
    for (const entry of workflowRunOrder({ nodes, edges })) {
      placeAfterFeeders(entry.node.id, column, incoming.get(entry.node.id) ?? []);
    }
  } catch {
    relaxColumns(nodes, incoming, column);
  }
  return column;
}

/**
 * Lay the graph out left to right, one column per dependency depth.
 *
 * Sources end up on the left, every wire points right, and **every sink is put
 * in the last column** — past the deepest node in the graph — because a sink is
 * where a branch ends and the arrangement is the only thing that communicates
 * direction. A reader who cannot tell which way the graph flows has to fall back
 * on the wiring rail, and at that point the canvas is decoration. With several
 * sinks that matters more, not less: "everything ends at the right" is how the
 * shape is read at a glance.
 *
 * The positions this produces are then draggable and saved like any others.
 */
export function layout(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowNode[] {
  const column = columnsFor(nodes, edges);
  // Measured over everything that is not a sink, then sinks go one past it. A
  // sink fed by a short branch would otherwise sit level with a transform that
  // runs later on a longer one, and "the ends are on the right" would stop being
  // true of the picture. Sinks share a column with each other, which is correct:
  // several sinks are several endings, and they are read as a column of them.
  const deepestBeforeSinks = Math.max(
    0,
    ...nodes.filter((node) => node.kind !== 'sink').map((node) => column.get(node.id) ?? 0),
  );
  const sinkColumn = nodes.some((node) => node.kind !== 'sink') ? deepestBeforeSinks + 1 : 0;

  const rows = new Map<number, number>();
  return nodes.map((node) => {
    const placed = node.kind === 'sink' ? sinkColumn : (column.get(node.id) ?? 0);
    const row = rows.get(placed) ?? 0;
    rows.set(placed, row + 1);
    return { ...node, position: { x: workflowColumnX(placed), y: workflowRowY(row) } };
  });
}

/**
 * Arrange a graph that nobody has arranged, and leave one that somebody has.
 *
 * Graphs arrive from the API as often as they are drawn — created by a
 * scheduler, promoted from another environment, written by a script — and none
 * of those set positions. `position` is optional in the executable model
 * precisely because it means nothing to execution, so an unset one is normal
 * rather than exceptional. Drawing those at the origin puts every node on top of
 * the first one, and the graph then reads as something it is not: a sink stacked
 * under a source draws its inbound edge doubling back across the canvas, which
 * looks exactly like a cycle. A DAG that renders as apparently cyclic is wrong
 * by definition.
 *
 * Two triggers, not one. Any node **missing** a position is the obvious case.
 * Two nodes sharing **the same** position is the other, and it is included
 * because a server that defaults a missing position to `{0, 0}` produces
 * collisions rather than absences, and the two are the same problem wearing
 * different clothes. Nobody drags two boxes onto the same pixel, so treating an
 * exact collision as "never arranged" costs nothing real.
 *
 * All-or-nothing on purpose. Positioning only the unplaced nodes relative to
 * hand-placed ones produces a worse arrangement than either — the new ones land
 * in columns that mean nothing next to the old ones — so either the layout is
 * authored or it is derived.
 *
 * This runs when a workflow is loaded, and does **not** mark the draft as
 * modified: the result is a pure function of the graph, so it re-derives
 * identically next time and there is nothing to lose by not saving it. Somebody
 * who then drags a node has authored a layout, and that one is saved.
 */
export function layoutIfUnarranged(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowNode[] {
  const seen = new Set<string>();
  let arranged = true;
  for (const node of nodes) {
    const position = node.position;
    if (!position || typeof position.x !== 'number' || typeof position.y !== 'number') {
      arranged = false;
      break;
    }
    const key = `${position.x},${position.y}`;
    if (seen.has(key)) {
      arranged = false;
      break;
    }
    seen.add(key);
  }
  return arranged ? nodes : layout(nodes, edges);
}

/**
 * Which edges should show their work moving, and when that is none of them.
 *
 * An edge flows while the node feeding it is running. That is the one thing a
 * picture can say about a run which the per-node status list cannot: not what
 * each step's outcome was, but where the work *is* right now.
 *
 * `reducedMotion` short-circuits to the empty set, and this function exists
 * largely so that decision is a value rather than a branch inside a render.
 * React Flow's `animated` is a CSS keyframe in its own stylesheet — there is no
 * prop to soften it and no way to reach it from here — so the only honest
 * accommodation is not to mark the edge at all. Nothing is lost by it: a running
 * node still spins its own badge and the run panel still lists every step, which
 * is the test for whether an animation was carrying information or decorating
 * it.
 */
export function flowingEdgeIds(
  edges: WorkflowEdge[],
  runNodes: readonly WorkflowRunNode[],
  options: { reducedMotion: boolean },
): ReadonlySet<string> {
  if (options.reducedMotion) return new Set();
  const running = new Set(
    runNodes.filter((node) => node.status === 'running').map((node) => node.nodeId),
  );
  if (running.size === 0) return new Set();
  return new Set(edges.filter((edge) => running.has(edge.from)).map((edge) => edgeId(edge)));
}

/**
 * Where to drop a node somebody just added.
 *
 * To the right of everything that already exists, rather than at the origin,
 * because dropping it at the origin puts it underneath whatever is already
 * there and reads as "the button did nothing".
 */
export function nextPosition(nodes: WorkflowNode[]): { x: number; y: number } {
  if (nodes.length === 0) return { x: 0, y: 0 };
  const xs = nodes.map((node) => node.position?.x ?? 0);
  const right = Math.max(...xs);
  const inColumn = xs.filter((x) => x === right);
  // `workflowColumnX(1)` is one whole column — the node's width plus the gap —
  // added to wherever the rightmost node happens to be, which need not sit on a
  // column boundary once somebody has dragged things around.
  return { x: right + workflowColumnX(1), y: workflowRowY(inColumn.length) };
}
