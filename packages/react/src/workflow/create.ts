import { defaultLabel } from './graph';
import {
  WORKFLOW_BRANCH_LABELS,
  WORKFLOW_NODE_KINDS,
  type WorkflowBranchLabel,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowNodeKind,
  newLocalId,
  nodeName,
  unreachableNodeKind,
} from './model';
import { placeBetween } from './place';
import { canConnect, edgeId } from './validate';

/**
 * Making nodes and wires, and deciding which of those the graph would accept.
 *
 * Lifted out of the canvas screen when a second surface needed it. The wiring
 * menu on a node, the inspector's picker and now the right-click menu all have
 * to offer *exactly* what `canConnect` allows and nothing else — and the way
 * that goes wrong is never a bug in one of them, it is a second copy of the rule
 * written down so a menu can be "smart". Everything here asks; nothing restates.
 *
 * The other reason it is its own module: `defaultLabel` is over in `graph.ts`,
 * `canConnect` in `validate.ts`, and these functions are the join between them.
 * They were sitting in the middle of a six-thousand-line component, which is
 * where a rule goes to be quietly duplicated by the next person who cannot find
 * it.
 */

/**
 * A fresh node of one kind, carrying only the fields that kind has.
 *
 * Built per kind rather than as one shape with optional fields, because the
 * executable model is a discriminated union: a source carries a source kind and
 * a config, a transform carries a transform, a sink carries the type it commits,
 * and nothing carries a field belonging to another kind.
 */
export function newNodeOfKind(
  kind: WorkflowNodeKind,
  id: string,
  position: { x: number; y: number },
  name: string,
): WorkflowNode {
  if (kind === 'source') {
    return { id, name, kind: 'source', sourceKind: 'http', config: {}, position };
  }
  if (kind === 'transform') {
    return { id, name, kind: 'transform', transformId: '', position };
  }
  if (kind === 'call') {
    // Both empty, and the graph is invalid until they are not — deliberately.
    // There is no list of workflows to default from (see `CallableWorkflowRef`
    // in core), and defaulting a *version* to "1" would be the one guess that
    // matters: it would silently pin whichever code happens to be registered as
    // version 1 in whatever deployment this graph is promoted into.
    return { id, name, kind: 'call', callName: '', callVersion: '', config: {}, position };
  }
  if (kind === 'if') {
    // No variable, so the graph is invalid until somebody names one. There is
    // nothing to guess: which variable tells this deployment apart from another
    // is the entire content of the node, and a default would be a decision the
    // graph appears to make and nobody authored.
    //
    // The *kind* of test does get a default, and it is the deployment one,
    // because a predicate has to be one of them and an empty variable name is a
    // gate that visibly refuses to publish. A row-count gate with its default
    // threshold would publish happily while testing something nobody chose.
    return { id, name, kind: 'if', predicate: { kind: 'env', envVar: '' }, position };
  }
  if (kind === 'filter') {
    // One empty comparison rather than an empty `all`, and rather than nothing.
    //
    // Nothing is not available: the model has no "no predicate yet" state, on
    // purpose, because a filter whose test is absent has to be given one by
    // somebody and every default is a rule about rows nobody wrote. An empty
    // `all` *is* representable and is refused by the validator, which is exactly
    // why it is not the starting point — a group with no conditions keeps every
    // row, so a filter that started that way would draw as a working node that
    // does nothing.
    //
    // So it starts as one comparison with no column, which the validator refuses
    // by name: the node says "needs a column" on the canvas from the moment it
    // is dropped. The operator defaults to `equals` because it is the only one
    // that is a guess about *form* rather than about data — every other choice
    // implies something about the column's type before a column is chosen.
    return {
      id,
      name,
      kind: 'filter',
      predicate: { kind: 'compare', column: '', operator: 'equals', value: '' },
      position,
    };
  }
  if (kind === 'rename') {
    // One entry with both halves blank, and the validator refuses it by name
    // from the moment the node is dropped — the same stance `filter` takes and
    // for the same reason. An empty map is representable and is exactly the
    // dangerous state: with unnamed columns kept it is a node that draws as
    // finished and does nothing, and with them dropped it deletes every column
    // of every row. So the node starts visibly incomplete rather than
    // invisibly inert.
    //
    // `unnamed` is left absent, which means keep. A rename that started by
    // dropping everything it does not name would be a projection wearing the
    // word "rename", and somebody would find that out by looking at a committed
    // snapshot.
    return { id, name, kind: 'rename', columns: { '': '' }, position };
  }
  if (kind === 'aggregate') {
    // One blank group-by column and one blank aggregate, so the validator
    // refuses it by name from the moment it is dropped. The same stance
    // `filter` and `rename` take, and here the empty states are the two most
    // dangerous in the file: an aggregate with no group-by columns commits
    // exactly one row whether the source held everything or nothing, and one
    // with no aggregates commits the distinct group keys with every other
    // column of every row gone. Neither errors. So the node starts visibly
    // incomplete rather than invisibly destructive.
    //
    // `count` as the starting function because it is the only one that needs no
    // column to mean something, so the half-filled node the person is looking
    // at is refused for the fields they have not reached yet rather than for a
    // choice the form made on their behalf.
    return {
      id,
      name,
      kind: 'aggregate',
      groupBy: [''],
      aggregates: [{ as: '', fn: 'count' }],
      position,
    };
  }
  if (kind === 'sink') {
    return { id, name, kind: 'sink', targetType: '', position };
  }
  return unreachableNodeKind(kind, 'newNodeOfKind');
}

/**
 * A wire, with its branch already decided when it leaves an `if`.
 *
 * Assigned here rather than left blank for somebody to fill in, because a blank
 * one is refused by `validateWorkflow` and the refusal would fire on the very
 * first wire out of a node somebody just created — the premature-error problem
 * `partitionProblems` exists to describe, arrived at from a different direction.
 *
 * The first wire out of a gate is the `then`, the second is the `else`, and
 * after that it is `then` again. That ordering is not arbitrary: those are the
 * two somebody is drawing when they draw a gate, in that order, and a third wire
 * is fan-out on a side they then choose in the inspector. Every one of them is
 * editable there, so this is a default and never a decision.
 */
export function newEdge(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  from: string,
  to: string,
): WorkflowEdge {
  const source = nodes.find((node) => node.id === from);
  if (source?.kind !== 'if') return { from, to };
  const taken = edges.filter((edge) => edge.from === from).map((edge) => edge.branch);
  const free = WORKFLOW_BRANCH_LABELS.find((label) => !taken.includes(label));
  return { from, to, branch: free ?? 'then' };
}

/**
 * A name nobody has used yet, so the fourth transform is not also "Transform".
 *
 * Every node used to be born called exactly `defaultLabel(kind)`, which is how
 * a graph ends up with three boxes called "Transform" and a problem message
 * that has to fall back to naming the id — `Sink (sink_3b5a…)` — because the
 * name it was given identifies nothing. A message that names an id is a message
 * whose reader has to go hunting for which box it means.
 *
 * Compared against what nodes are *called* rather than against a counter, so
 * renaming "Transform 2" to "Join" frees the number again, and so a name typed
 * by hand is never duplicated by one generated afterwards. `nodeName` is what
 * the rest of the screen displays, so it is what has to be unique.
 */
export function uniqueName(nodes: WorkflowNode[], kind: WorkflowNodeKind): string {
  const base = defaultLabel(kind);
  const taken = new Set(nodes.map((node) => nodeName(node)));
  if (!taken.has(base)) return base;
  // `taken.size + 1` candidates for `taken.size` names: one of them is free, so
  // this always returns from inside the loop.
  for (let n = 2; n <= taken.size + 1; n += 1) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base} ${taken.size + 2}`;
}

/**
 * A probe id no real node can hold.
 *
 * Node ids are minted by `newLocalId`, which always contains an underscore and a
 * UUID; this cannot collide with one, and it never leaves the function that
 * makes it.
 */
const PROBE = '__probe__';

/**
 * Which kinds of new node this one could legally feed — asked, never restated.
 *
 * The menu must offer only edges the graph allows, and the temptation is to
 * write that down: "a source may feed a transform or a sink; nothing follows a
 * sink". Writing it down is how the canvas ends up with a second copy of rules
 * that live in `canConnect`, and the first time the two disagree the menu either
 * offers an edge that is then refused or hides one that was always fine.
 *
 * So this builds a throwaway node of each kind, drops it into a copy of the
 * graph, and asks `canConnect` — the same function the drag uses, the same one
 * the "send its output to" picker filters with. The probe is never stored and
 * its id never leaves this function. When a rule changes, this follows.
 *
 * The list itself is {@link WORKFLOW_NODE_KINDS} and never a hand-written row:
 * `filter` shipped complete — model, validator, executor, inspector, its own
 * colour on the canvas — and could not be added from this screen at all, because
 * the palette was six JSX elements somebody had typed out and only five of them
 * had been typed.
 */
export function newKindsFrom(
  from: WorkflowNode,
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
): WorkflowNodeKind[] {
  return WORKFLOW_NODE_KINDS.filter((kind) => {
    const probe = newNodeOfKind(kind, PROBE, { x: 0, y: 0 }, PROBE);
    return canConnect([...nodes, probe], edges, from.id, PROBE).ok;
  });
}

/**
 * Which kinds could be **spliced into** an existing wire.
 *
 * Asked exactly like {@link newKindsFrom}, and asked twice, because splicing is
 * two connections and not one: the upstream node has to be able to feed the new
 * kind, *and* the new kind has to be able to feed the downstream node. A menu
 * that checked only the first half would happily offer to insert a sink into the
 * middle of a graph and then produce a graph in which nothing runs after it.
 *
 * The original wire is taken out of the graph before either question is asked.
 * Leaving it in means the second question is answered against a graph where the
 * two ends are still directly connected, and every candidate would be refused
 * for closing a loop that is about to stop existing.
 */
export function kindsBetween(
  edge: WorkflowEdge,
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
): WorkflowNodeKind[] {
  const id = edgeId(edge);
  const rest = edges.filter((candidate) => edgeId(candidate) !== id);
  return WORKFLOW_NODE_KINDS.filter((kind) => {
    const probe = newNodeOfKind(kind, PROBE, { x: 0, y: 0 }, PROBE);
    const all = [...nodes, probe];
    if (!canConnect(all, rest, edge.from, PROBE).ok) return false;
    const half: WorkflowEdge[] = [...rest, { from: edge.from, to: PROBE }];
    return canConnect(all, half, PROBE, edge.to).ok;
  });
}

/**
 * The graph with a new node standing in the middle of an existing wire.
 *
 * `A → B` becomes `A → new → B`, and the two new wires go in **at the index the
 * old one held**. That is not cosmetic: a node with several inbound edges
 * receives its inputs in the order the edges appear in this array, and that
 * order is part of what the graph produces. Appending would silently reorder the
 * feeds into `B` — a join would see its two inputs the other way round — which
 * is exactly the kind of change nobody would look for, because on screen the
 * picture is identical.
 *
 * The branch label travels with the first half. A wire leaving an `if` node is
 * on a side, the side decides which half of the pipeline runs, and dropping it
 * here would move the whole downstream branch onto the gate's default and pass
 * validation while doing it. The second half is built by {@link newEdge}, which
 * gives it a branch only if the *inserted* node is itself a gate.
 */
export function nodeBetween(
  edge: WorkflowEdge,
  kind: WorkflowNodeKind,
  nodes: WorkflowNode[],
): WorkflowNode {
  return newNodeOfKind(
    kind,
    newLocalId(kind),
    placeBetween(
      nodes.find((candidate) => candidate.id === edge.from),
      nodes.find((candidate) => candidate.id === edge.to),
      nodes,
    ),
    uniqueName(nodes, kind),
  );
}

/**
 * The splice itself, taking the node rather than making one.
 *
 * Separate from {@link nodeBetween} for a reason that has bitten this file's
 * neighbours: the id comes from `newLocalId`, so calling one function twice —
 * once to find out what was created and once inside the state updater — mints
 * two different nodes. The node is therefore made once, outside, and this is
 * pure with respect to it.
 */
export function graphWithNodeBetween(
  edge: WorkflowEdge,
  node: WorkflowNode,
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  const id = edgeId(edge);
  const at = edges.findIndex((candidate) => edgeId(candidate) === id);
  const rest = edges.filter((candidate) => edgeId(candidate) !== id);
  const first: WorkflowEdge =
    edge.branch === undefined
      ? { from: edge.from, to: node.id }
      : { from: edge.from, to: node.id, branch: edge.branch };
  const second = newEdge([...nodes, node], [...rest, first], node.id, edge.to);

  const next = [...rest];
  next.splice(at < 0 ? next.length : at, 0, first, second);
  return { nodes: [...nodes, node], edges: next };
}

/** The branch a wire is not on, when it is on one at all. */
export function otherBranch(branch: WorkflowBranchLabel): WorkflowBranchLabel {
  return WORKFLOW_BRANCH_LABELS.find((label) => label !== branch) ?? branch;
}
