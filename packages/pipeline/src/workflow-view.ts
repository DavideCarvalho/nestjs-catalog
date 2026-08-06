import {
  type CatalogConnector,
  type CatalogWorkflow,
  type ConnectorKind,
  type ConnectorRun,
  type WorkflowEdge,
  type WorkflowNode,
  isConnectorKind,
  isWorkflowNodeKind,
  workflowRunOrder,
} from '@dudousxd/nestjs-catalog';
import { BadRequestException } from '@nestjs/common';

/**
 * Translating between the graph the canvas draws and the graph this service
 * executes.
 *
 * The two are not the same shape and pretending otherwise would push the
 * difference into whichever of them changed last. The canvas
 * (`@dudousxd/nestjs-catalog-react`) declares its own node model — a `label`, a
 * `connectorId` on a source, one `targetType` for the whole workflow, edges
 * with ids — because it was written before the executable model existed and
 * says so in its own comments. The executable model
 * (`@dudousxd/nestjs-catalog`) has a discriminated union, the target type on
 * the sink, and edges identified by their endpoints.
 *
 * This file is the one place that knows both, so the reconciliation is a diff
 * against one module rather than an archaeology exercise across the API. It
 * accepts either shape on the way in — a canvas node and a hand-written core
 * node both parse — and always answers in the canvas's shape, because that is
 * what the screen renders.
 *
 * Nothing here trusts what it was sent. Every field is read and narrowed
 * individually, because this is HTTP input and the alternative is a graph that
 * stores cleanly and fails halfway through a load.
 */

/** What a canvas sends. Deliberately loose: it is narrowed field by field. */
export interface CanvasWorkflowInput {
  id?: string;
  name?: unknown;
  description?: unknown;
  targetType?: unknown;
  nodes?: unknown;
  edges?: unknown;
}

/** What a canvas renders. */
/** One node of a run, as the canvas's run panel reads it. */
export interface CanvasWorkflowRunNode {
  nodeId: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
  rows?: number;
  error?: string;
}

export interface CanvasWorkflowRun {
  id: string;
  workflowId: string;
  snapshotId: string;
  status: 'running' | 'succeeded' | 'failed';
  /**
   * Whether *this* run was checkpointed — read off the run row, never off the
   * current configuration. A deployment can gain or lose its durable engine
   * between one run and the next, and the older run is still what it was.
   */
  durable: boolean;
  nodes: CanvasWorkflowRunNode[];
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

/**
 * Turn what arrived over HTTP into an executable graph.
 *
 * A source node may name a connector, and when it does the connector supplies
 * the kind — which is why this is async and why it takes a lookup rather than a
 * store: what a source *is* has one authority, and copying the kind onto the
 * node at save time is a cache of that authority, kept only so the pure
 * validator can see it. Execution re-reads the connector, so an edited
 * connector takes effect on the next run.
 */
export function toGraph(input: CanvasWorkflowInput): {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
} {
  const rawNodes = Array.isArray(input.nodes) ? input.nodes : [];
  const rawEdges = Array.isArray(input.edges) ? input.edges : [];

  const nodes: WorkflowNode[] = [];
  for (const raw of rawNodes) {
    nodes.push(toNode(raw));
  }

  const edges: WorkflowEdge[] = rawEdges.map((raw) => {
    const from = readString(raw, 'from');
    const to = readString(raw, 'to');
    if (!from || !to) {
      throw new BadRequestException(
        'An edge arrived without both endpoints. An edge is identified by the nodes it joins, so one without them cannot be stored.',
      );
    }
    // The order of this array is preserved exactly as it arrived: a node with
    // several inbound edges receives its inputs in this order, so sorting them
    // here would silently change what a merge produces.
    return { from, to };
  });

  return { nodes, edges };
}

function toNode(raw: unknown): WorkflowNode {
  const id = readString(raw, 'id');
  const kind = readUnknown(raw, 'kind');
  if (!id) {
    throw new BadRequestException('A node arrived with no id.');
  }
  if (!isWorkflowNodeKind(kind)) {
    throw new BadRequestException(
      `Node "${id}" has kind ${JSON.stringify(kind)}, which is not one this service can execute.`,
    );
  }

  // `name` is the executable model's word and `label` is the canvas's. Falling
  // back to the id keeps a node nameable rather than refusing a graph over a
  // cosmetic field.
  const name = readString(raw, 'name') ?? readString(raw, 'label') ?? id;
  const position = readPosition(raw);

  if (kind === 'transform') {
    const transformId = readString(raw, 'transformId');
    if (!transformId) {
      throw new BadRequestException(
        `Transform node "${name}" (${id}) names no transform, so there would be no code for it to run.`,
      );
    }
    return { id, name, kind, transformId, position };
  }

  if (kind === 'sink') {
    // The sink's own type, and nowhere else to fall back to. A workflow may now
    // have several sinks writing different types, so a graph-level default
    // would silently make two sinks agree that were meant to differ.
    const type = readString(raw, 'targetType');
    if (!type) {
      throw new BadRequestException(
        `Sink "${name}" (${id}) writes no object type, so there would be nothing for the run to commit into.`,
      );
    }
    // `position` like every other kind. Its absence here meant a sink could not
    // be placed at all — by any route. Drag one on the canvas, save, reload, and
    // it is back where the automatic layout puts it; a `POST` carrying explicit
    // coordinates answers 201 and drops them. The read is already done above for
    // every node, so this was one branch forgetting to hand it back rather than
    // a decision about sinks.
    return { id, name, kind, targetType: type, mode: readMode(raw), position };
  }

  const config = readRecord(raw, 'config');

  if (kind === 'call') {
    return toCallNode(raw, { id, name, config, position });
  }

  const declared = readUnknown(raw, 'sourceKind');

  if (!isConnectorKind(declared)) {
    // Refusing, rather than saving a source with nothing to read from.
    //
    // The wording matters because of how this went wrong once: an outbound view
    // that dropped `sourceKind` and `config` made a perfectly configured inline
    // source arrive here as an empty object, and the honest refusal below would
    // then have looked like a complaint about the person's graph instead of a
    // bug in what we sent them. If this fires on a source that runs, suspect
    // the view before suspecting the author.
    throw new BadRequestException(
      `Source "${name}" (${id}) names neither a connector nor a source kind, so there is nothing for it to read from. If this source does run, the graph was read out of the catalog without its configuration — report it rather than re-entering it, because saving now would overwrite what is stored with what you were shown.`,
    );
  }
  return {
    id,
    name,
    kind,
    sourceKind: declared,
    config,
    connectionId: readString(raw, 'connectionId'),
    secretEnvVar: readString(raw, 'secretEnvVar'),
    mode: readMode(raw),
    position,
  };
}

/**
 * A call node, refused at the boundary if it names half of what it needs.
 *
 * Checked here rather than left to `validateWorkflow`, which a draft is stored
 * without running: a call node saved with an empty version is a node that would
 * run whichever version is registered on the day somebody publishes it — the
 * exact substitution the pin exists to prevent, arrived at by saving something
 * unfinished rather than by anybody choosing it.
 */
function toCallNode(
  raw: unknown,
  base: {
    id: string;
    name: string;
    config: Record<string, unknown>;
    position?: { x: number; y: number };
  },
): WorkflowNode {
  const callName = readString(raw, 'callName');
  const callVersion = readString(raw, 'callVersion');
  if (!callName || !callVersion) {
    throw new BadRequestException(
      `Call node "${base.name}" (${base.id}) names ${
        callName ? 'no version of the workflow it calls' : 'no workflow to call'
      }. A call pins a name and a version together, because the version is what decides which code runs.`,
    );
  }
  return { ...base, kind: 'call', callName, callVersion };
}

/**
 * A run, node by node.
 *
 * The node list comes from the graph's own run order rather than from the keys
 * of `nodeOutcomes`, so a run that stopped early still shows every node, in the
 * order it would have run them, with the ones after the failure marked
 * `skipped` and any that never got an entry marked `pending`. A panel built
 * from the outcome keys alone would silently shorten itself exactly when
 * somebody most needs to see where a graph stopped.
 */
export function toRunView(workflow: CatalogWorkflow, run: ConnectorRun): CanvasWorkflowRun {
  const outcomes = run.nodeOutcomes ?? {};
  const nodes: CanvasWorkflowRunNode[] = workflowRunOrder(workflow).map((entry) => {
    const outcome = outcomes[entry.node.id];
    if (!outcome) {
      return {
        nodeId: entry.node.id,
        status: run.status === 'running' ? 'pending' : 'skipped',
      };
    }
    return {
      nodeId: entry.node.id,
      status: outcome.status,
      rows: outcome.rows,
      error: outcome.error,
    };
  });

  return {
    id: run.id,
    workflowId: run.workflowId ?? workflow.id,
    snapshotId: run.snapshotId,
    status: run.status,
    durable: run.executionMode === 'durable',
    nodes,
    startedAt: run.startedAt,
    // Coalesced rather than passed through: a JSON column that has never been
    // written reads back as `null`, and a screen checking `run.error` truthily
    // is fine with either but one that renders `String(error)` is not.
    finishedAt: run.finishedAt ?? undefined,
    error: run.error ?? undefined,
  };
}

/* --- narrowing helpers ------------------------------------------------- */

function readUnknown(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return Reflect.get(value, key);
}

function readString(value: unknown, key: string): string | undefined {
  const found = readUnknown(value, key);
  return typeof found === 'string' && found.length > 0 ? found : undefined;
}

function readRecord(value: unknown, key: string): Record<string, unknown> {
  const found = readUnknown(value, key);
  if (typeof found !== 'object' || found === null || Array.isArray(found)) {
    return {};
  }
  const record: Record<string, unknown> = {};
  for (const entry of Object.keys(found)) {
    record[entry] = Reflect.get(found, entry);
  }
  return record;
}

function readMode(value: unknown): 'full' | 'incremental' | undefined {
  const found = readUnknown(value, 'mode');
  if (found === 'full' || found === 'incremental') return found;
  return undefined;
}

function readPosition(value: unknown): { x: number; y: number } | undefined {
  const found = readUnknown(value, 'position');
  const x = readUnknown(found, 'x');
  const y = readUnknown(found, 'y');
  if (typeof x !== 'number' || typeof y !== 'number') return undefined;
  return { x, y };
}
