/**
 * The graph model this screen is written against.
 *
 * This file used to *declare* the model, because the executable one did not
 * exist yet. It does now, so everything that describes a node, an edge or a
 * graph is re-exported from `@dudousxd/nestjs-catalog/client` rather than
 * restated here. A second declaration of a wire format is a second thing to
 * keep in step, and the first time it drifts the canvas draws a graph the
 * server will not run.
 *
 * `/client` rather than the package root on purpose: the root entry point pulls
 * in NestJS and MikroORM, and this is browser code. `/client` is types plus a
 * handful of pure functions, and is published precisely so a canvas can share
 * the server's rules without shipping the server.
 *
 * What is still declared here is the short list below, and each entry says why
 * core does not own it. The rule is simple: if the server persists it or
 * executes it, it belongs to core; if only this screen has an opinion about it,
 * it belongs here.
 */

export type {
  CallableWorkflowRef,
  CatalogWorkflow,
  WorkflowEdge,
  WorkflowCallNode,
  WorkflowGraph,
  WorkflowNode,
  WorkflowNodeKind,
  WorkflowSinkNode,
  WorkflowSourceNode,
  WorkflowTransformNode,
} from '@dudousxd/nestjs-catalog/client';

export {
  isWorkflowNodeKind,
  WORKFLOW_NODE_ID_PATTERN,
  WORKFLOW_NODE_KINDS,
} from '@dudousxd/nestjs-catalog/client';

import { WORKFLOW_NODE_ID_PATTERN, type WorkflowNode } from '@dudousxd/nestjs-catalog/client';

/**
 * What a caller may set.
 *
 * Authored fields only, never state: `version`, `graphHash`, `createdBy` and the
 * timestamps are consequences the server writes, and a form that could send them
 * would let somebody claim a graph was authored by someone else.
 *
 * There is deliberately **no `targetType` here.** The type a workflow produces
 * is set on each sink node, because the sink is the node that commits — see
 * {@link WorkflowSinkNode}. A graph may now have several sinks writing several
 * types, so one field on the workflow could only ever name one of them.
 */
export interface WorkflowInput {
  /** Present when editing. Absent creates a new workflow. */
  id?: string;
  name: string;
  description?: string;
  nodes: WorkflowNode[];
  edges: Array<{ from: string; to: string }>;
}

/**
 * Whether this deployment can checkpoint between nodes.
 *
 * Core has {@link CatalogWorkflowCapabilities}, which answers `durable` or
 * `inline` and nothing else. This shape keeps a third answer — the field being
 * absent — because a server that predates it has not said, and a console that
 * reads silence as "no durable engine" is asserting something it was never told.
 * The screen renders all three states distinctly; see `describeDurability`.
 */
export interface WorkflowDurability {
  available: boolean;
  /**
   * What is providing it, when the server can say. Shown because "durable" on
   * its own is a claim, and naming the engine makes it checkable.
   */
  engine?: string;
}

/** The three answers, as prose the screen can render without branching twice. */
export interface DurabilityCopy {
  state: 'durable' | 'inline' | 'unknown';
  label: string;
  detail: string;
}

export function describeDurability(durability: WorkflowDurability | undefined): DurabilityCopy {
  if (!durability) {
    return {
      state: 'unknown',
      label: 'checkpointing: not reported',
      detail:
        'This deployment did not say whether a durable engine is wired up. Assume there is none: a run that fails part-way will start again from the beginning. Treating silence as "resumable" is how a graph gets built that nobody can restart.',
    };
  }
  if (durability.available) {
    return {
      state: 'durable',
      label: durability.engine ? `checkpointing: ${durability.engine}` : 'checkpointing: on',
      detail:
        'Every node runs as its own durable step. A ten-node graph that fails at node seven resumes at node seven — the first six are not re-run, and whatever they wrote is not written twice.',
    };
  }
  return {
    state: 'inline',
    label: 'checkpointing: off',
    detail:
      'No durable engine is available here, so the whole graph runs inline in one process. A failure at node seven re-runs the graph from node one, and nothing between nodes is checkpointed.',
  };
}

/**
 * The outcome of running a graph, node by node.
 *
 * Not in core, and this is the one place where that is a statement rather than
 * an omission: core models what a *connector* run records ({@link ConnectorRun}
 * plus `nodeOutcomes`), and this is the shape the workflow run endpoint answers
 * with — every node of the graph in run order, including the ones that never
 * got an outcome because the run stopped before them.
 *
 * Per node rather than one status for the whole run, for two reasons that have
 * both become load-bearing. The durable claim is only visible per node: "resumes
 * at node seven" is prose until a screen can show which node was seven and that
 * the six before it did not run again. And a graph may now commit several types
 * at several sinks, each independently — so "the run succeeded" is not a fact
 * about the run, it is a fact about each sink, and only the per-node list can
 * say which ones committed.
 */
export interface WorkflowRun {
  id: string;
  workflowId: string;
  /** The snapshot this run wrote, which is also the durable run id. */
  snapshotId: string;
  /**
   * The whole run's outcome, which is `failed` if **any** sink failed. A run
   * that committed `Mvr` and could not commit `Subwo` is a failed run that
   * happens to have written something, and calling it succeeded is exactly the
   * kind of half-truth the per-sink list below exists to prevent.
   */
  status: 'running' | 'succeeded' | 'failed';
  /**
   * Whether this particular run was checkpointed. Recorded per run, not read
   * from capabilities, because a deployment can gain or lose its durable engine
   * between one run and the next and the older run is still what it was.
   */
  durable: boolean;
  nodes: WorkflowRunNode[];
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

export interface WorkflowRunNode {
  nodeId: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
  /**
   * True when the durable engine replayed a completed step instead of running
   * it again. This is the single most useful fact on a resumed run and there is
   * nowhere else to read it from.
   */
  replayed?: boolean;
  rows?: number;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

/**
 * A stable id for a node the person just drew.
 *
 * Checked against core's {@link WORKFLOW_NODE_ID_PATTERN} rather than assumed to
 * fit it: a node id becomes a durable step name and part of the key its staged
 * rows are stored under, so an id the server refuses is a graph that cannot be
 * saved at all, reported as a validation error about a field nobody typed.
 */
export function newLocalId(prefix: string): string {
  // `crypto.randomUUID` is not universally present in the browsers this package
  // supports (it needs a secure context), and a canvas that throws while adding
  // a node is worse than one with slightly less pretty ids. The fallback only
  // has to be unique within one unsaved draft — the server keeps whatever it is
  // sent, so both branches have to satisfy the pattern.
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const id = `${prefix}_${random}`;
  if (WORKFLOW_NODE_ID_PATTERN.test(id)) return id;
  // Only reachable if a future prefix carries something outside the alphabet.
  // Stripping is better than shipping an id the server will refuse.
  return `${prefix.replace(/[^A-Za-z0-9_-]/g, '')}_${random}`.slice(0, 64);
}

/**
 * What a node is called on screen.
 *
 * `name` is typed `string` and is checked at run time anyway, because this
 * arrives over HTTP: a server that has not yet been updated sends nodes without
 * one, and `undefined.trim()` inside a render is a blank canvas rather than a
 * node with a dull label.
 */
export function nodeName(node: WorkflowNode): string {
  return typeof node.name === 'string' && node.name.trim().length > 0 ? node.name.trim() : node.id;
}

/**
 * Every object type this graph commits, in sink order.
 *
 * A list rather than a single value, because a workflow may have several sinks
 * and the whole point of that is one expensive read feeding several outputs.
 * Anything wanting to *summarise* what a graph produces reads this; nothing sets
 * a type through it, because a type is set on the sink that commits it.
 */
export function producedTypes(nodes: WorkflowNode[]): string[] {
  const types: string[] = [];
  for (const node of nodes) {
    if (node.kind !== 'sink') continue;
    const type = typeof node.targetType === 'string' ? node.targetType.trim() : '';
    if (type.length > 0 && !types.includes(type)) types.push(type);
  }
  return types;
}
