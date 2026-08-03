import {
  type WorkflowEdge,
  type WorkflowIssueCode,
  type WorkflowNode,
  validateWorkflow as validateCoreWorkflow,
} from '@dudousxd/nestjs-catalog/client';
import { nodeName } from './model';
import { WORKFLOW_NAME } from './name';

/**
 * What is wrong with a graph, checked in the browser while it is being drawn.
 *
 * **The rules are core's, not this file's.** `validateWorkflow` in
 * `@dudousxd/nestjs-catalog` is pure and dependency-free and is exported from
 * `/client` for exactly this purpose, so the canvas and the store run the same
 * function over the same graph. This file used to carry its own copy of those
 * rules and they had already drifted: it checked a `connectorId` field the
 * executable model does not have, and reported "does not name a connector" on a
 * source that ran perfectly well. A validator that flags correct graphs is worse
 * than no validator, because people learn to ignore it and then they ignore the
 * real one.
 *
 * What is left here is the part core genuinely cannot answer:
 *
 * - **Mid-drag connection legality.** `canConnect` is asked before an edge
 *   exists, on every pointer move, so React Flow can refuse the drop visibly.
 *   Core validates a graph that already has the edge in it.
 * - **A transform naming something that was deleted.** Core has no idea which
 *   transforms exist; only a screen holding the list does.
 * - **A sink with no object type.** Core's type requires `targetType` on a sink
 *   but its validator never checks that the string is non-empty, and the server
 *   refuses one that is. The check is additive, not contradictory.
 * - **Two sinks writing the same type.** Core reports it as `duplicate-sink-type`.
 *
 * The consequence worth stating: nothing in the canvas may *skip* a server check
 * because this passed. Save always goes to the server, the server's refusal
 * always wins, and a graph with no problems here can still be rejected — core
 * sees which types exist and who may write to them, and this does not.
 */

export type WorkflowProblemLevel = 'error' | 'warning';

/**
 * Core's codes, plus the three this screen adds.
 *
 * Core's are re-used verbatim rather than remapped so that a caller — or a test
 * — matching on a code matches the same string the server would have sent back.
 */
export type WorkflowProblemCode =
  | WorkflowIssueCode
  | 'missing-transform'
  | 'sink-has-no-type'
  | 'duplicate-sink-type';

export interface WorkflowProblem {
  level: WorkflowProblemLevel;
  code: WorkflowProblemCode;
  message: string;
  /** Which nodes to ring on the canvas. Empty means the graph as a whole. */
  nodeIds: string[];
  /** Which wires to draw in red. Derived here; core reports nodes only. */
  edgeIds: string[];
}

export interface WorkflowDraft {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface ValidateOptions {
  /**
   * Ids of transforms that currently exist. A node pointing at a transform
   * somebody deleted still looks fine on the canvas and fails at run time, so
   * the list is passed in rather than assumed complete.
   */
  transformIds: ReadonlySet<string>;
}

/**
 * Core issues this canvas deliberately does not show, and the only place the two
 * validators disagree.
 *
 * Both codes encode a rule that has been withdrawn: "a workflow produces exactly
 * one object type". It was withdrawn because the whole reason a graph exists is
 * one expensive read feeding several outputs — pull ten million rows once,
 * derive vehicles and work orders from them — and one type per workflow means
 * pulling twice. The partial-commit worry that motivated the rule was never
 * specific to workflows: two connectors writing `Mvr` and `Subwo` can already
 * half-fail today, and nobody calls that broken. The fix is to be explicit that
 * each sink commits its own type independently, which this screen is, rather
 * than to forbid the shape.
 *
 * The half of the rule that survives is enforced below as `duplicate-sink-type`:
 * two sinks writing the *same* type really is ambiguous, because it is two
 * snapshots of one type in one run with nothing to say which won.
 *
 * Core now agrees: it emits `duplicate-sink-type` and no longer has
 * `multiple-sinks` or `mixed-output-types`. There is consequently nothing left
 * to suppress, and the set is gone rather than left empty — an empty
 * suppression list is an invitation to put something back in it, and a screen
 * that hides one of the server's answers is a screen that will eventually
 * promise a save the server refuses.
 */

/** The wires an issue is really about, since core names nodes and not edges. */
function edgesFor(code: WorkflowProblemCode, nodeIds: string[], edges: WorkflowEdge[]): string[] {
  if (code !== 'cycle' && code !== 'self-edge' && code !== 'duplicate-edge') {
    return [];
  }
  const named = new Set(nodeIds);
  return edges
    .filter((edge) => named.has(edge.from) && named.has(edge.to))
    .map((edge) => edgeId(edge));
}

/**
 * The identity React Flow needs, derived rather than stored.
 *
 * The executable model gives an edge no id of its own — `from` and `to` already
 * identify a wire, and a second identity is something a canvas could let drift
 * from the pair that actually matters. React Flow does need a string, so it is
 * computed the same way everywhere from the only two fields there are.
 */
export function edgeId(edge: WorkflowEdge): string {
  return `${edge.from}->${edge.to}`;
}

export function validateWorkflow(
  draft: WorkflowDraft,
  options: ValidateOptions,
): WorkflowProblem[] {
  const { nodes, edges } = draft;
  const problems: WorkflowProblem[] = [];

  for (const issue of validateCoreWorkflow({ nodes, edges })) {
    problems.push({
      level: 'error',
      code: issue.code,
      message: issue.message,
      nodeIds: issue.nodeIds,
      edgeIds: edgesFor(issue.code, issue.nodeIds, edges),
    });
  }

  // Everything below is canvas-only. It runs whatever core said, because these
  // are different questions and suppressing them behind a structural error would
  // make somebody fix one problem to be told about the next.
  const sinkTypes = new Map<string, string[]>();

  for (const node of nodes) {
    const name = nodeName(node);

    if (node.kind === 'transform') {
      if (node.transformId.length > 0 && !options.transformIds.has(node.transformId)) {
        // A deleted transform is invisible on the canvas — the node keeps its
        // name and its wiring, and only fails when the graph runs. Core cannot
        // see this; it has no list of transforms.
        problems.push({
          level: 'error',
          code: 'missing-transform',
          message: `"${name}" points at a transform that no longer exists. It was probably deleted from the Transforms tab.`,
          nodeIds: [node.id],
          edgeIds: [],
        });
      }
      continue;
    }

    if (node.kind !== 'sink') continue;

    const type = typeof node.targetType === 'string' ? node.targetType.trim() : '';
    if (type.length === 0) {
      problems.push({
        level: 'error',
        code: 'sink-has-no-type',
        message: `"${name}" does not say which object type it writes, so there would be nothing for the run to commit into. The type is chosen on the sink because the sink is the node that commits.`,
        nodeIds: [node.id],
        edgeIds: [],
      });
      continue;
    }
    sinkTypes.set(type, [...(sinkTypes.get(type) ?? []), node.id]);
  }

  for (const [type, ids] of sinkTypes) {
    if (ids.length < 2) continue;
    const named = ids
      .map((id) => {
        const node = nodes.find((candidate) => candidate.id === id);
        return node ? `"${nodeName(node)}"` : `"${id}"`;
      })
      .join(' and ');
    problems.push({
      level: 'error',
      code: 'duplicate-sink-type',
      message: `${named} both write ${type}. Two sinks may write two different types — that is the point of a ${WORKFLOW_NAME.singular}, one read feeding several outputs — but two writing the same type would commit two snapshots of ${type} in one run with nothing to say which one won. Merge the branches into a single ${type} sink.`,
      nodeIds: ids,
      edgeIds: [],
    });
  }

  return problems;
}

/**
 * Would adding `from -> to` close a loop?
 *
 * Asked before the edge exists, which is the whole point: this is what lets the
 * canvas refuse the connection at the moment somebody drags it, instead of
 * accepting it and having core report a cycle a second later. A cycle exists iff
 * `from` is already reachable from `to`.
 */
export function wouldCycle(edges: WorkflowEdge[], from: string, to: string): boolean {
  if (from === to) return true;
  const out = new Map<string, string[]>();
  for (const edge of edges) {
    out.set(edge.from, [...(out.get(edge.from) ?? []), edge.to]);
  }
  const seen = new Set<string>([to]);
  const stack = [to];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    for (const next of out.get(current) ?? []) {
      if (next === from) return true;
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(next);
    }
  }
  return false;
}

/**
 * May these two be wired together?
 *
 * One function, two callers, and that is the point. React Flow's
 * `isValidConnection` only wants a boolean and is asked on every pointer move
 * during a drag, so it cannot be where the explanation lives; `onConnectEnd`
 * and the keyboard wiring control both need the sentence. Two implementations
 * would eventually disagree, and the disagreement would show up as a drag that
 * is refused with no reason or a reason with no refusal.
 *
 * Every rule here is one core also enforces once the edge exists — a source
 * takes no input, nothing runs after a sink, no duplicates, no loops. Asking
 * them a moment earlier is the canvas's job; deciding what they are is not.
 */
export type ConnectionVerdict = { ok: true } | { ok: false; reason: string };

export function canConnect(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  from: string,
  to: string,
): ConnectionVerdict {
  if (from === to) {
    return { ok: false, reason: 'A node cannot feed itself.' };
  }

  const source = nodes.find((node) => node.id === from);
  const target = nodes.find((node) => node.id === to);
  if (!source || !target) {
    return { ok: false, reason: 'One end of that connection is not a node.' };
  }

  if (source.kind === 'sink') {
    return {
      ok: false,
      reason: `"${nodeName(source)}" commits its rows. Nothing runs after a sink.`,
    };
  }
  if (target.kind === 'source') {
    return {
      ok: false,
      reason: `"${nodeName(target)}" reads from a system, so nothing can feed into it.`,
    };
  }

  if (edges.some((edge) => edge.from === from && edge.to === to)) {
    return {
      ok: false,
      reason: `Those two are already wired together, and wiring them twice would send "${nodeName(target)}" the same rows twice.`,
    };
  }

  if (wouldCycle(edges, from, to)) {
    return {
      ok: false,
      reason: `That would close a loop: "${nodeName(target)}" already feeds "${nodeName(source)}", directly or through other nodes. A ${WORKFLOW_NAME.singular} that loops has no order to run in.`,
    };
  }

  return { ok: true };
}

/** Convenience for the save button: errors block, warnings do not. */
export function hasBlockingProblem(problems: WorkflowProblem[]): boolean {
  return problems.some((problem) => problem.level === 'error');
}

/** Node id -> the problems mentioning it, for ringing nodes on the canvas. */
export function problemsByNode(problems: WorkflowProblem[]): Map<string, WorkflowProblem[]> {
  const byNode = new Map<string, WorkflowProblem[]>();
  for (const problem of problems) {
    for (const nodeId of problem.nodeIds) {
      const list = byNode.get(nodeId) ?? [];
      list.push(problem);
      byNode.set(nodeId, list);
    }
  }
  return byNode;
}
