import {
  type CatalogConnector,
  type CatalogWorkflow,
  type ConnectorKind,
  type ConnectorRun,
  WORKFLOW_BRANCH_LABELS,
  WORKFLOW_CALL_MODES,
  WORKFLOW_FILTER_MAX_DEPTH,
  WORKFLOW_FILTER_MAX_VALUES,
  WORKFLOW_PREDICATE_KINDS,
  type WorkflowAggregate,
  type WorkflowBranchLabel,
  type WorkflowCallMode,
  type WorkflowEdge,
  type WorkflowFilterPredicate,
  type WorkflowIfPredicate,
  type WorkflowNode,
  type WorkflowSkipReason,
  aggregateRefusals,
  isConnectorKind,
  isWorkflowAggregateFunction,
  isWorkflowBranchLabel,
  isWorkflowCallMode,
  isWorkflowFilterPredicate,
  isWorkflowNodeKind,
  isWorkflowRenameUnnamed,
  renameColumnRefusals,
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
    return toTransformNode(raw, { id, name, position });
  }

  if (kind === 'sink') {
    return toSinkNode(raw, { id, name, position });
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

  if (kind === 'rename') {
    return toRenameNode(raw, { id, name, position });
  }

  if (kind === 'aggregate') {
    return toAggregateNode(raw, { id, name, position });
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
  const callMode = readCallMode(raw, base);
  // Spread rather than assigned, so a call node that named no mode is stored
  // with no `callMode` key at all rather than with an explicit `undefined`.
  // That is what keeps `workflowGraphHash` still, and it is what every graph in
  // every deployment already looks like.
  return { ...base, kind: 'call', callName, callVersion, ...(callMode ? { callMode } : {}) };
}

/**
 * Which wire format this call node was authored in, refused at the boundary if
 * it is a word this build has no rule for.
 *
 * Refused rather than defaulted, for the reason {@link readVersion} refuses a
 * pin it cannot use: the two modes send genuinely different payloads, and
 * quietly reading an unrecognised one as `'envelope'` would wrap a config that
 * was authored to travel bare — and the callee would fail on the first key it
 * looked for, in a durable child run, with nothing at the boundary to point at.
 *
 * Absent and `null` fold together into absent, which is `'envelope'`: what every
 * call node stored before this field existed is, and what all of them have
 * always done. Absent is returned as `undefined` rather than as the string, so a
 * graph that did not name a mode is stored exactly as it arrived and its
 * `workflowGraphHash` does not move.
 */
function readCallMode(
  raw: unknown,
  base: { id: string; name: string },
): WorkflowCallMode | undefined {
  const found = readUnknown(raw, 'callMode');
  if (found === undefined || found === null) return undefined;
  if (!isWorkflowCallMode(found)) {
    throw new BadRequestException(
      `Call node "${base.name}" (${base.id}) carries a callMode of ${JSON.stringify(found)}, and the only ones this build can put on the wire are ${WORKFLOW_CALL_MODES.join(' and ')}. Leave it out for the envelope, which is what a call node has always sent.`,
    );
  }
  return found;
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

/**
 * A transform node as it arrived over HTTP.
 *
 * Its own function rather than a branch of {@link toNode}, which the complexity
 * bound will not hold any more of — the same split `isWorkflowNode` already
 * makes one package over, and the same reason: every kind that reads more than
 * one field gets a place of its own to say why.
 */
function toTransformNode(
  raw: unknown,
  base: { id: string; name: string; position?: { x: number; y: number } },
): WorkflowNode {
  const transformId = readString(raw, 'transformId');
  if (!transformId) {
    throw new BadRequestException(
      `Transform node "${base.name}" (${base.id}) names no transform, so there would be no code for it to run.`,
    );
  }
  return {
    ...base,
    kind: 'transform',
    transformId,
    transformVersion: readVersion(raw, 'transformVersion', base),
  };
}

/**
 * A sink node as it arrived over HTTP.
 *
 * The sink's own type, and nowhere else to fall back to. A workflow may have
 * several sinks writing different types, so a graph-level default would silently
 * make two sinks agree that were meant to differ.
 *
 * `position` comes through `base`, like every other kind. Its absence here once
 * meant a sink could not be placed at all — by any route: drag one on the canvas,
 * save, reload, and it was back where the automatic layout puts it, while a
 * `POST` carrying explicit coordinates answered 201 and dropped them.
 */
function toSinkNode(
  raw: unknown,
  base: { id: string; name: string; position?: { x: number; y: number } },
): WorkflowNode {
  const type = readString(raw, 'targetType');
  if (!type) {
    throw new BadRequestException(
      `Sink "${base.name}" (${base.id}) writes no object type, so there would be nothing for the run to commit into.`,
    );
  }
  return {
    ...base,
    kind: 'sink',
    targetType: type,
    mode: readMode(raw),
    ...readReuse(raw, base),
  };
}

/**
 * A rename node as it arrived over HTTP, refused rather than repaired.
 *
 * The map is checked entry by entry against `renameColumnRefusals` — the same
 * function `validateWorkflow` and the canvas call — so a graph posted by curl and
 * one saved from the screen are refused by one sentence. Repairing it is the one
 * thing this must not do: dropping an unreadable entry would store a rename that
 * silently does less than it says, and the symptom of *that* is a column of
 * NULLs under a name somebody put in an object type on purpose.
 *
 * `unnamed` absent means `keep`, and is stored absent rather than normalised to
 * the word, so there is one spelling of the default and picking up this release
 * cannot renumber a stored graph. A value that is present and unrecognised is
 * refused: reading it as `keep` would turn a projection into a pass-through and
 * commit every column the author meant to remove.
 */
function toRenameNode(
  raw: unknown,
  base: { id: string; name: string; position?: { x: number; y: number } },
): WorkflowNode {
  const columns = readUnknown(raw, 'columns');
  if (typeof columns !== 'object' || columns === null || Array.isArray(columns)) {
    throw new BadRequestException(
      `Rename node "${base.name}" (${base.id}) carries no map of columns, so there is nothing for it to rename. Send \`columns\` as an object of old name to new name.`,
    );
  }
  const map: Record<string, string> = {};
  for (const [from, to] of Object.entries(columns)) {
    if (typeof to !== 'string') {
      throw new BadRequestException(
        `Rename node "${base.name}" (${base.id}) renames ${JSON.stringify(from)} to ${JSON.stringify(to)}, and a column's new name has to be a string.`,
      );
    }
    map[from] = to;
  }
  const refusals = renameColumnRefusals(map);
  if (refusals.length > 0) {
    throw new BadRequestException(
      `Rename node "${base.name}" (${base.id}) cannot be stored as it is. ${refusals.join(' ')}`,
    );
  }

  const unnamed = readUnknown(raw, 'unnamed');
  if (unnamed !== undefined && unnamed !== null && !isWorkflowRenameUnnamed(unnamed)) {
    throw new BadRequestException(
      `Rename node "${base.name}" (${base.id}) says its unnamed columns are ${JSON.stringify(unnamed)}, and the only two answers are "keep" and "drop". Reading an unrecognised one as "keep" would pass on every column this node was meant to remove.`,
    );
  }

  return {
    ...base,
    kind: 'rename',
    columns: map,
    unnamed: unnamed === 'drop' ? 'drop' : undefined,
  };
}

/**
 * An aggregate node as it arrived over HTTP, refused rather than repaired.
 *
 * The whole node goes through `aggregateRefusals` — the same function
 * `validateWorkflow`, the canvas and the fold itself call — so a graph posted by
 * curl and one saved from the screen are refused by one sentence. Repairing it
 * is the one thing this must not do, and here that is sharper than it was for a
 * rename: dropping an unreadable aggregate stores a node that computes one fewer
 * column than it says, and dropping an unreadable group-by column changes
 * sixteen thousand rows into one. Both commit, and both report success.
 *
 * The optional numbers are read one by one rather than spread off the payload,
 * so a `maxLength` arriving as the string `"1024"` is refused here instead of
 * being compared against a number at run time — where `'1024' > 500` is a
 * comparison JavaScript is happy to make and nobody meant.
 */
function toAggregateNode(
  raw: unknown,
  base: { id: string; name: string; position?: { x: number; y: number } },
): WorkflowNode {
  const groupByRaw = readUnknown(raw, 'groupBy');
  const aggregatesRaw = readUnknown(raw, 'aggregates');
  const maxGroups = readUnknown(raw, 'maxGroups');

  const refusals = aggregateRefusals({
    groupBy: groupByRaw,
    aggregates: aggregatesRaw,
    maxGroups,
  });
  if (refusals.length > 0) {
    throw new BadRequestException(
      `Aggregate node "${base.name}" (${base.id}) cannot be stored as it is. ${refusals.join(' ')}`,
    );
  }
  if (!Array.isArray(groupByRaw) || !Array.isArray(aggregatesRaw)) {
    // Unreachable while `aggregateRefusals` refuses a non-array, and written as
    // a refusal rather than a cast for exactly that reason: the narrowing is
    // what makes the two arrays below typed, and a type assertion here would be
    // a promise about another function's behaviour rather than a check.
    throw new BadRequestException(
      `Aggregate node "${base.name}" (${base.id}) carries no columns to group on and no aggregates to compute.`,
    );
  }

  const groupBy: string[] = [];
  for (const column of groupByRaw) {
    if (typeof column !== 'string') continue;
    groupBy.push(column);
  }

  const aggregates: WorkflowAggregate[] = [];
  for (const entry of aggregatesRaw) {
    const aggregate = toAggregate(entry);
    if (aggregate !== undefined) aggregates.push(aggregate);
  }

  return {
    ...base,
    kind: 'aggregate',
    groupBy,
    aggregates,
    // Stored absent when it was absent, so the default has one spelling and
    // picking up this release cannot renumber a graph. Same rule as a rename's
    // `unnamed`.
    ...(typeof maxGroups === 'number' ? { maxGroups } : {}),
  };
}

/**
 * One entry of an aggregate list, narrowed field by field.
 *
 * `undefined` for anything unreadable, which is only reachable because
 * `aggregateRefusals` has already refused the node — so this cannot silently
 * drop an entry a caller meant. The optional fields are read one by one rather
 * than spread off the payload, so a `maxLength` arriving as the string `"1024"`
 * is dropped here instead of being compared against a number at run time, where
 * `'1024' > 500` is a comparison JavaScript is happy to make and nobody meant.
 */
function toAggregate(entry: unknown): WorkflowAggregate | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined;
  const as = Reflect.get(entry, 'as');
  const fn = Reflect.get(entry, 'fn');
  if (typeof as !== 'string' || !isWorkflowAggregateFunction(fn)) return undefined;
  const column = Reflect.get(entry, 'column');
  const separator = Reflect.get(entry, 'separator');
  const maxLength = Reflect.get(entry, 'maxLength');
  return {
    as,
    fn,
    ...(typeof column === 'string' ? { column } : {}),
    ...(typeof separator === 'string' ? { separator } : {}),
    ...(typeof maxLength === 'number' ? { maxLength } : {}),
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
