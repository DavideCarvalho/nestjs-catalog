import {
  type CatalogConnector,
  type CatalogWorkflow,
  type ConnectorKind,
  type ConnectorRun,
  WORKFLOW_BRANCH_LABELS,
  WORKFLOW_FILTER_MAX_DEPTH,
  WORKFLOW_FILTER_MAX_VALUES,
  WORKFLOW_PREDICATE_KINDS,
  type WorkflowBranchLabel,
  type WorkflowEdge,
  type WorkflowFilterPredicate,
  type WorkflowIfPredicate,
  type WorkflowNode,
  type WorkflowSkipReason,
  isConnectorKind,
  isWorkflowBranchLabel,
  isWorkflowFilterPredicate,
  isWorkflowNodeKind,
  unreachableNodeKind,
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
  /**
   * What a filter node was *given*, against `rows` above, which is what it let
   * through. Absent on every other kind, and absent on filters that ran before
   * this was recorded — see `WorkflowNodeOutcome.rowsIn` on why absent and zero
   * must not be folded together.
   *
   * The panel subtracts to show what was dropped. It is carried out to the
   * screen for the reason the whole node exists: a filter whose effect is
   * invisible is how data goes missing without anybody noticing.
   */
  rowsIn?: number;
  /**
   * Which branch an `if` node took. The panel's answer to "why did nothing load
   * into X", and the only place a screen can read the decision from — it is a
   * fact about this run, not about the graph.
   */
  branch?: WorkflowBranchLabel;
  /**
   * Why a `skipped` node did not run, when the reason is a branch rather than a
   * failure upstream.
   *
   * Carried all the way out to the screen rather than collapsed into `status`,
   * because a **sink** with `status: 'skipped'` and this set committed nothing
   * *and that is correct*: whatever snapshot was live stays live. The same node
   * with `status: 'succeeded'` and `rows: 0` did commit — an empty incremental
   * merge — and the same node with `skipped` and no reason is part of a run that
   * fell over. Three different things a panel has to be able to tell apart.
   */
  skippedBecause?: WorkflowSkipReason;
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
    return { from, to, branch: readBranch(raw, from, to) };
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
    return {
      id,
      name,
      kind,
      transformId,
      transformVersion: readVersion(raw, 'transformVersion', { id, name }),
      position,
    };
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
    return {
      id,
      name,
      kind,
      targetType: type,
      mode: readMode(raw),
      ...readReuse(raw, { id, name }),
      position,
    };
  }

  const config = readRecord(raw, 'config');

  if (kind === 'call') {
    return toCallNode(raw, { id, name, config, position });
  }

  if (kind === 'if') {
    return toIfNode(raw, { id, name, position });
  }

  if (kind === 'filter') {
    return toFilterNode(raw, { id, name, position });
  }

  // Everything below is a source. Written as a refusal rather than as a fallthrough
  // so that a kind added to the list without a branch above is a type error here
  // — `kind` narrows to `never` only while every kind is accounted for — instead
  // of a node of the new kind quietly arriving as a source with no `sourceKind`.
  if (kind !== 'source') return unreachableNodeKind(kind, 'toGraph');

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
    ...readReuse(raw, { id, name }),
    position,
  };
}

/**
 * The reusable reference a node arrived carrying, refused rather than dropped.
 *
 * Both halves, because both are silent when they go missing. A `useId` that this
 * boundary quietly dropped would store a node that looks identical and is not
 * the same node: the graph would keep running, and it would stop appearing in
 * the count of what uses that reusable node — so the next person editing it
 * would be told nobody was downstream. And a dropped `useVersion` turns a pinned
 * node into one that follows the latest, which is exactly the substitution the
 * pin exists to prevent, arrived at by a payload passing through a version of
 * this file that had not heard of it.
 *
 * Spread into the node rather than assigned, so a node with no reference carries
 * no keys at all. `{ useId: undefined }` and `{}` are the same object to
 * `validateWorkflow` and different ones to `JSON.stringify`, and the second is
 * what lands in the column.
 */
function readReuse(
  raw: unknown,
  base: { id: string; name: string },
): { useId?: string; useVersion?: number } {
  const useId = readString(raw, 'useId');
  const useVersion = readVersion(raw, 'useVersion', base);
  if (useId === undefined) {
    if (useVersion !== undefined) {
      throw new BadRequestException(
        `Node "${base.name}" (${base.id}) is pinned to version ${useVersion} but names no reusable node, so there is nothing for that version to be a version of. Either name one or drop the pin.`,
      );
    }
    return {};
  }
  return useVersion === undefined ? { useId } : { useId, useVersion };
}

/**
 * A version pin, refused unless it is a whole number of at least one.
 *
 * The same refusal `validateWorkflow` makes, made here as well for the reason
 * {@link toRowCountPredicate} gives about its threshold: a draft is stored
 * without validating, and a pin arriving as the *string* `"3"` — which is what
 * an unparsed form field is — matches no stored version, so it would be
 * discovered by a run that stops halfway through a load rather than by the
 * person who typed it.
 *
 * `null` is folded in with absent, because that is what a JSON round trip of an
 * unset optional field produces, and absent means "follow the latest" — which is
 * what every node in every deployment does today.
 */
function readVersion(
  raw: unknown,
  key: string,
  base: { id: string; name: string },
): number | undefined {
  const found = readUnknown(raw, key);
  if (found === undefined || found === null) return undefined;
  if (typeof found !== 'number' || !Number.isInteger(found) || found < 1) {
    throw new BadRequestException(
      `Node "${base.name}" (${base.id}) carries a ${key} of ${JSON.stringify(found)}, and a version is a whole number of at least 1. Leave it out for the node to follow the latest; a pin no stored version can equal would fail this node partway through a load.`,
    );
  }
  return found;
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
 * A gate, refused at the boundary if it has nothing to decide on.
 *
 * Checked here rather than left to `validateWorkflow`, which a draft is stored
 * without running, for exactly the reason {@link toCallNode} gives about a
 * missing version: a gate saved with no variable would have to pick a branch
 * anyway on the day somebody publishes it, and whichever it picked would be a
 * decision the graph appears to make and nobody authored — with half the graph
 * silently not running as the only symptom.
 */
function toIfNode(
  raw: unknown,
  base: { id: string; name: string; position?: { x: number; y: number } },
): WorkflowNode {
  return { ...base, kind: 'if', predicate: toPredicate(readUnknown(raw, 'predicate'), base) };
}

/**
 * The test a gate arrived carrying, narrowed one kind at a time.
 *
 * The kind is read first and refused if it is not one of the two, rather than
 * being guessed from which fields are present. Guessing is what the flat shape
 * would have forced — "it has an `envVar`, so it must be an env test" — and it
 * answers a payload carrying both fields, or neither, by picking one. A gate
 * that runs the test its author did not choose is the failure this whole node is
 * arranged against, so the ambiguity is refused at the boundary instead.
 */
function toPredicate(raw: unknown, base: { id: string; name: string }): WorkflowIfPredicate {
  const kind = readUnknown(raw, 'kind');
  if (kind === 'rowCount') {
    return toRowCountPredicate(raw, base);
  }
  if (kind === 'env') {
    return toEnvPredicate(raw, base);
  }
  throw new BadRequestException(
    `If node "${base.name}" (${base.id}) carries a predicate of kind ${JSON.stringify(
      kind,
    )}, and a gate can test one of ${WORKFLOW_PREDICATE_KINDS.map((one) => `"${one}"`).join(
      ' or ',
    )}. Without one there is nothing for it to decide on, and a gate that decides anyway sends half the graph down a path nobody chose.`,
  );
}

/** Refused at the boundary for the reason {@link toCallNode} gives: a draft is stored unvalidated. */
function toEnvPredicate(raw: unknown, base: { id: string; name: string }): WorkflowIfPredicate {
  const envVar = readString(raw, 'envVar');
  if (!envVar) {
    throw new BadRequestException(
      `If node "${base.name}" (${base.id}) names no environment variable, so there would be nothing for it to decide on. It reads the name of a variable on the machine that runs the load — never a value, and never a credential.`,
    );
  }
  const equals = readUnknown(raw, 'equals');
  if (equals !== undefined && equals !== null && typeof equals !== 'string') {
    throw new BadRequestException(
      `If node "${base.name}" (${base.id}) compares ${envVar} against something that is not a string. An environment variable is text; a comparison against anything else could never match, and a branch that can never be taken is a subtree that silently never runs.`,
    );
  }
  // Read as `unknown` rather than through `readString`, because that helper
  // folds an empty string into "absent" — and here the two are different tests.
  // `equals: ''` asks "is it set but blank"; no `equals` at all asks "is it set
  // to anything". `null` is folded in with absent because that is what a JSON
  // round trip of an unset optional field produces.
  return {
    kind: 'env',
    envVar,
    equals: typeof equals === 'string' ? equals : undefined,
  };
}

/**
 * A row-count test, refused unless the threshold is a whole number of at least
 * one.
 *
 * The same refusal `validateWorkflow` makes, made here as well because a draft
 * is stored without validating and a threshold arriving as the *string* `"5"` —
 * which is what an unparsed form field is — would compare false against every
 * count and strand the `then` branch on every run. Zero is refused for the
 * reason given on {@link WorkflowRowCountPredicate.atLeast}: it can only ever
 * answer one way.
 */
function toRowCountPredicate(
  raw: unknown,
  base: { id: string; name: string },
): WorkflowIfPredicate {
  const atLeast = readUnknown(raw, 'atLeast');
  if (typeof atLeast !== 'number' || !Number.isInteger(atLeast) || atLeast < 1) {
    throw new BadRequestException(
      `If node "${base.name}" (${base.id}) branches on a row count of ${JSON.stringify(
        atLeast,
      )}, and a threshold has to be a whole number of at least 1. "At least 1" is the "did anything arrive at all" test; anything else here compares false against every count, which is a branch that silently never runs.`,
    );
  }
  return { kind: 'rowCount', atLeast };
}

/**
 * A filter, refused at the boundary if its test or its acknowledgement is
 * unreadable.
 *
 * Checked here for the reason {@link toCallNode} gives — a draft is stored
 * without validating — and the stakes are the highest of the three. A gate
 * saved with no test picks a branch nobody authored; a filter saved with a test
 * this build cannot evaluate would throw inside a durable step halfway through a
 * load, and one saved with a *silently repaired* test decides which rows a
 * published type contains. So the whole predicate goes through the same guard
 * the database read uses, and anything it will not accept is refused with the
 * rules spelled out rather than patched into something runnable.
 *
 * `narrows` is read here rather than left to `validateWorkflow` for a sharper
 * version of the same argument: it is the acknowledgement that a published
 * snapshot is about to become a subset, and a value that arrived as a bare
 * string — which is what a form field that forgot to wrap itself sends — must
 * not be dropped, because dropping it turns an acknowledged graph into one that
 * never was, and the refusal that follows would name a field somebody did fill
 * in.
 */
function toFilterNode(
  raw: unknown,
  base: { id: string; name: string; position?: { x: number; y: number } },
): WorkflowNode {
  const narrows = readUnknown(raw, 'narrows');
  if (
    narrows !== undefined &&
    narrows !== null &&
    (!Array.isArray(narrows) || !narrows.every((type) => typeof type === 'string'))
  ) {
    throw new BadRequestException(
      `Filter node "${base.name}" (${base.id}) says it narrows ${JSON.stringify(narrows)}, and that has to be a list of object type names. It is the record that this filter is allowed to shrink what those types publish, so a value nothing can read is refused rather than treated as no acknowledgement at all.`,
    );
  }

  return {
    ...base,
    kind: 'filter',
    predicate: toFilterPredicate(readUnknown(raw, 'predicate'), base),
    // Trimmed and deduplicated, because the validator compares this against the
    // set of types the graph says are narrowed and `[" Mvr", "Mvr"]` would fail
    // that comparison over whitespace. Absent stays absent: an empty list and no
    // list mean the same thing here, and storing `[]` would be a second spelling.
    narrows: Array.isArray(narrows) ? readNarrowedTypes(narrows) : undefined,
  };
}

/** The acknowledged types, trimmed, deduplicated, and `undefined` when there are none. */
function readNarrowedTypes(narrows: readonly string[]): string[] | undefined {
  const types: string[] = [];
  for (const raw of narrows) {
    const type = raw.trim();
    if (type.length > 0 && !types.includes(type)) types.push(type);
  }
  return types.length === 0 ? undefined : types;
}

/**
 * The test a filter arrived carrying, checked whole.
 *
 * One guard rather than a walk written a second time here. `isWorkflowFilterPredicate`
 * is the same function the store narrows with and the same one the canvas runs,
 * and a boundary that reimplemented the rules would be a fourth opinion about
 * what an empty `all` means — which is the difference between a filter that
 * keeps everything and one that keeps nothing.
 *
 * The message lists the rules rather than pointing at the offending node of the
 * tree, and that is a deliberate limit: the guard answers yes or no, and making
 * it answer *where* would mean it returned a diagnostic instead of narrowing a
 * type. The console builds the predicate through a form that cannot produce most
 * of these, so the reader of this message is somebody posting JSON.
 */
function toFilterPredicate(
  raw: unknown,
  base: { id: string; name: string },
): WorkflowFilterPredicate {
  if (isWorkflowFilterPredicate(raw)) return raw;
  throw new BadRequestException(
    `Filter node "${base.name}" (${base.id}) carries a test this service cannot run. A filter tests bare column names — letters, digits and underscore, starting with a letter or underscore — against plain strings, finite numbers or booleans, combined with "all" and "any". A group must hold at least one condition, a list at least one value and at most ${WORKFLOW_FILTER_MAX_VALUES}, and the tree may nest at most ${WORKFLOW_FILTER_MAX_DEPTH} deep. Nothing is repaired here: an "all" with no conditions keeps every row and an "any" with none drops every row, so a test that cannot be read is refused rather than guessed at.`,
  );
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
      rowsIn: outcome.rowsIn,
      branch: outcome.branch,
      skippedBecause: outcome.skippedBecause,
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

/**
 * The branch a wire is on, refusing anything that is neither label nor absent.
 *
 * Absent is normal — it is what every wire that does not leave an `if` is, and
 * what every wire drawn before branches existed is. What is *not* tolerated is
 * an unrecognised string: dropping it would silently turn a labelled wire into a
 * plain one, which either makes a subtree run when a branch said it should not
 * or makes it stop running with nothing anywhere to point at. Both are the
 * failure this whole feature has to avoid, so a typo is a 400 at the boundary.
 */
function readBranch(value: unknown, from: string, to: string): WorkflowBranchLabel | undefined {
  const found = readUnknown(value, 'branch');
  if (found === undefined || found === null) return undefined;
  if (!isWorkflowBranchLabel(found)) {
    throw new BadRequestException(
      `The wire from "${from}" to "${to}" is labelled ${JSON.stringify(found)}, which is not a branch. A branch is ${WORKFLOW_BRANCH_LABELS.map((label) => `"${label}"`).join(' or ')}; anything else names a side of the decision that nothing takes.`,
    );
  }
  return found;
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
