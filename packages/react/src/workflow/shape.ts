import type {
  ScalarType,
  WorkflowEdge,
  WorkflowNode,
  WorkflowSinkNode,
  WorkflowSourceNode,
} from '@dudousxd/nestjs-catalog/client';
import { nodeName } from './model';
import type { WorkflowProblem } from './validate';

/**
 * Whether what a source produces fits the type a sink writes, asked while the
 * graph is being drawn rather than after a load has committed.
 *
 * WHAT THIS ANSWERS, AND WHY IT IS WORTH ANSWERING
 * ------------------------------------------------
 * Every other check on this canvas is topological: a sink with no type, two
 * sinks on one type, a node nothing reaches. All of them pass a graph whose
 * source does not supply a single one of the columns its sink writes, because
 * nothing in the graph says what the columns *are*. The load then succeeds,
 * commits, and reports its row count — and the rows are null.
 *
 * That is not hypothetical. `subwo` has 84 columns, 73 of them spelled in ways
 * SQL cannot use as an identifier, and the mismatch was found after a run
 * reported `fetched=6905, written=6905`. Thirteen types were published the same
 * way and six came out with most of their columns null, 313,833 rows of the
 * largest — see the `property-names.ts` header in the pipeline package, which
 * moved *its* half of the problem to publish time for the same reason this moves
 * the other half to design time: everything needed to answer the question is
 * already on screen, and answering it costs nothing.
 *
 * THE COMPARISON, WHICH IS THE WHOLE THING
 * ----------------------------------------
 * A published property has two names and they are not interchangeable:
 *
 * - `name` is what the load looks the field up by — `row[property.name]`, see
 *   the warehouse store — and nothing on the write path consults anything else.
 * - `columnName` is lineage: how the source spells the field, recorded for
 *   tracing when the property ended up called something else.
 *
 * A source with no transform between it and the sink hands its records over
 * exactly as they arrive, keyed by the source's own spelling. So a record has
 * `Asset Id` and the store asks for `Asset_Id`, and the answer is `undefined`,
 * and `undefined` is written as null in every row of every run, forever, and
 * the load reports success.
 *
 * Which means the comparison that matters is `column.name` against
 * `property.name`. Matching against `columnName` instead would report "fits" on
 * precisely the graph that produced the 6,905 rows — the two names agree about
 * the source and disagree about what the store will ask for. `columnName` is
 * still read, but only to *explain* a miss: a source column that matches the
 * property's `columnName` and not its `name` is the split-name case, and saying
 * so is the difference between "this column is missing" and "these two are the
 * same field under two names".
 *
 * Where that split came from, and why the repair is now the cheap one: publish
 * used to refuse any property name that was not a SQL identifier outright,
 * because the name was written verbatim as the view's output alias. Publishers
 * did what the refusal told them — renamed the property to `Asset_Id`, put
 * `Asset Id` in `columnName` — and that is the type that loads nulls. Both
 * aliases now go through `outputAlias`, so `Asset Id` is a perfectly good
 * property name and the type can simply be renamed to what the source calls the
 * field. A transform is still the answer where the name genuinely cannot become
 * a column, which is why the message names both.
 *
 * THREE OUTCOMES, NOT TWO
 * -----------------------
 * Discovery reports how it knows what it knows, and against a real deployment it
 * came back `basis: "driver"` with `sampled: 0` — the driver described the
 * result set and not one row was read. So there are questions this genuinely
 * cannot settle, and pretending otherwise in either direction is the failure:
 *
 * - **fits** — nothing is reported.
 * - **does not fit** — `level: "error"`. Reserved for what is decided by the
 *   two schemas alone and cannot come out any other way: a column the source
 *   does not produce under the name the store will ask for.
 * - **not known well enough to say** — `level: "warning"`. A type difference
 *   `coerce` may or may not survive depending on the values, a column discovery
 *   reached no conclusion about, a nullability the two sides disagree about, or
 *   a transform on the path.
 *
 * That third outcome uses the level distinction {@link WorkflowProblem} already
 * has rather than a new one. It is not decoration: `hasBlockingProblem` reads
 * `level`, so an unproven column colours nothing and blocks nothing, and the
 * rail already sorts warnings under errors behind an amber glyph. Rendering "I
 * could not tell" as an error is how a panel stops being read, which is the
 * failure `validate.ts` opens by describing.
 *
 * WHEN SOMETHING THAT COMPUTES ROWS IS ON THE PATH
 * ------------------------------------------------
 * Said out loud, never silently passed. What a transform emits is whatever its
 * TypeScript returns, and knowing that means compiling and running it — a
 * different project. A `call` node is further out of reach still: what it emits
 * is decided by a durable workflow this graph does not own, possibly written in
 * another language, and the graph holds nothing but its name and a version. So a
 * sink fed through either gets a warning naming the node, and no error and no
 * silence. Guessing that a node is shape-preserving would be a validator
 * inventing a fact, and a validator that invents facts is worse than none.
 *
 * The branch is on "not a source" rather than on the kind, deliberately: a kind
 * added to the vocabulary tomorrow lands in the honest answer by default instead
 * of falling through the comparison as though a source had produced its rows.
 *
 * WHEN NOTHING IS KNOWN AT ALL
 * ----------------------------
 * If no source feeding a sink has a discovered shape, this reports nothing —
 * not even "could not check". A deployment that has never run discovery would
 * otherwise carry a permanent amber warning on every graph, which is the same
 * noise by another route. The warnings above are for a question that was asked
 * and came back inconclusive, not for one nobody asked.
 *
 * That is not a hypothetical state on the canvas: discovery is a read of a live
 * source behind a `POST`, run when somebody presses the button on a source
 * node's inspector, and never on anybody's behalf. So a graph nobody has asked
 * about is the ordinary case, and silence is what it gets.
 */

/**
 * One column, exactly as `POST pipeline/workflows/:id/nodes/:nodeId/discover`
 * reports it.
 *
 * A structural subset of that route's answer rather than an import of it: this
 * module has no business knowing about a screen, and `DiscoveredColumn` in
 * `schema-discovery.tsx` carries fields — a `note`, the source's own type
 * string — that are for a reader and not for a comparison. Written this way, a
 * discovery response IS a {@link SourceShape} with no conversion, which is what
 * the canvas relies on, and a host with some other way to learn a source's
 * columns can still supply one.
 */
export interface SourceColumn {
  /**
   * The column as the SOURCE spells it — which is the key its records carry,
   * and therefore the string the store's `row[property.name]` has to match.
   */
  name: string;
  /** `null` where discovery reached no conclusion, which is not a type. */
  type: ScalarType | null;
  /** `null` where the source did not say. Postgres never does over a query. */
  nullable: boolean | null;
  confidence: 'reported' | 'inferred' | 'unknown';
  /** The source's own vocabulary — a driver type id. Quoted back, never parsed. */
  sourceType?: string;
}

export interface SourceShape {
  columns: readonly SourceColumn[];
  /** `driver` means the result set was described; `sample` means rows were read. */
  basis?: 'driver' | 'sample';
  /** How many records the inference looked at. Always 0 for a driver description. */
  sampled?: number;
}

/** As much of a published property as this file has an opinion about. */
export interface TargetProperty {
  /** What the load looks the field up by, as `row[name]`. */
  name: string;
  /** The source's spelling, when the two differ. Read only to explain a miss. */
  columnName?: string;
  type: ScalarType;
  nullable: boolean;
}

export interface TargetShape {
  name: string;
  properties: readonly TargetProperty[];
}

/**
 * Where the two halves come from, as lookups rather than as data.
 *
 * Lookups because neither half belongs to this module and both are optional: a
 * console may be able to see the catalog's types and know nothing about any
 * source, and `undefined` from either is a supported answer with its own
 * meaning — see the header.
 */
export interface ShapeKnowledge {
  /** What discovery said this source node reads, or nothing if nobody asked. */
  sourceShape(nodeId: string): SourceShape | undefined;
  /** The published type, or nothing if this console cannot see one by that name. */
  targetShape(typeName: string): TargetShape | undefined;
}

/** How many names a message spells out before it starts counting instead. */
const NAMED_LIMIT = 6;

export function checkShapes(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
  knowledge: ShapeKnowledge,
): WorkflowProblem[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const incoming = new Map<string, string[]>();
  for (const edge of edges) {
    incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge.from]);
  }

  const problems: WorkflowProblem[] = [];
  for (const node of nodes) {
    if (node.kind !== 'sink') continue;
    if (typeof node.targetType !== 'string' || node.targetType.trim().length === 0) continue;
    problems.push(...checkSink(node, byId, incoming, knowledge));
  }
  return problems;
}

/** Everything reported about one sink, over each of the nodes wired into it. */
function checkSink(
  sink: WorkflowSinkNode,
  byId: ReadonlyMap<string, WorkflowNode>,
  incoming: ReadonlyMap<string, string[]>,
  knowledge: ShapeKnowledge,
): WorkflowProblem[] {
  const problems: WorkflowProblem[] = [];
  const indirect: WorkflowNode[] = [];

  for (const fromId of incoming.get(sink.id) ?? []) {
    const from = byId.get(fromId);
    if (!from) continue;
    if (from.kind !== 'source') {
      // Anything that is not a source hands the sink rows it computed. Held
      // back until it is known that a shape was discovered somewhere behind it
      // — see the header on staying quiet where nobody asked.
      if (anyShapeBehind(from.id, byId, incoming, knowledge)) indirect.push(from);
      continue;
    }
    const shape = knowledge.sourceShape(from.id);
    if (shape) problems.push(...comparePair(from, sink, shape, knowledge));
  }

  if (indirect.length > 0) problems.push(notCheckable(indirect, sink));
  return problems;
}

/**
 * Does any source that can reach this node have a discovered shape?
 *
 * Backwards from the node, with a seen set. The seen set is not defensive
 * tidiness: a cyclic graph is reported by core and drawn on the canvas anyway,
 * and a traversal that hung would take the browser with it while somebody is
 * still dragging the wire that closed the loop.
 */
function anyShapeBehind(
  startId: string,
  byId: ReadonlyMap<string, WorkflowNode>,
  incoming: ReadonlyMap<string, string[]>,
  knowledge: ShapeKnowledge,
): boolean {
  const seen = new Set<string>([startId]);
  const pending = [startId];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    const node = byId.get(current);
    if (node?.kind === 'source' && knowledge.sourceShape(node.id)) return true;
    for (const previous of incoming.get(current) ?? []) {
      if (seen.has(previous)) continue;
      seen.add(previous);
      pending.push(previous);
    }
  }
  return false;
}

/** The computed-rows case: said out loud, as a warning, never as silence. */
function notCheckable(indirect: readonly WorkflowNode[], sink: WorkflowSinkNode): WorkflowProblem {
  const named = indirect.map((node) => `"${nodeName(node)}"`).join(', ');
  return {
    level: 'warning',
    code: 'shape-not-checked',
    message: `Whether what reaches "${nodeName(sink)}" fits ${sink.targetType.trim()} could not be checked: ${named} ${indirect.length === 1 ? 'sits' : 'sit'} in between, and ${indirect.length === 1 ? 'it hands' : 'they hand'} the sink rows ${indirect.length === 1 ? 'it' : 'they'} computed. What a transform emits is whatever its code returns, and what a call node emits is decided by a workflow this graph does not own — neither is knowable without running it, which this canvas does not do. The columns are compared only where a source feeds a sink directly. This is not a problem with the graph; it is the check declining to guess.`,
    nodeIds: [...indirect.map((node) => node.id), sink.id],
    // Deliberately no edge ids. The rail paints a wire red from these, and a
    // red wire for "not known" is the error styling this whole file exists to
    // keep off the uncertain answer.
    edgeIds: [],
  };
}

/** One source feeding one sink with nothing in between: the checkable case. */
function comparePair(
  source: WorkflowSourceNode,
  sink: WorkflowSinkNode,
  shape: SourceShape,
  knowledge: ShapeKnowledge,
): WorkflowProblem[] {
  const typeName = sink.targetType.trim();
  const target = knowledge.targetShape(typeName);
  if (!target) {
    return [
      {
        level: 'warning',
        code: 'shape-not-checked',
        message: `"${nodeName(source)}" reads ${shape.columns.length} column${shape.columns.length === 1 ? '' : 's'}, but there is nothing to compare them against: this console cannot see a type called ${typeName}. It may not be published yet, or it may be one this viewer is not allowed to read. The server checks it either way on save.`,
        nodeIds: [source.id, sink.id],
        edgeIds: [],
      },
    ];
  }

  const verdict = compareColumns(shape, target);
  const problems: WorkflowProblem[] = [];
  if (verdict.respelled.length > 0) {
    problems.push(respelledProblem(source, sink, target, verdict.respelled));
  }
  if (verdict.missing.length > 0) {
    problems.push(missingProblem(source, sink, target, verdict.missing));
  }
  if (verdict.unproven.length > 0) {
    problems.push(unprovenProblem(source, sink, target, verdict.unproven, shape));
  }
  return problems;
}

interface Verdict {
  /** The source has the column under its own spelling; the load asks for the property's. */
  respelled: Array<{ property: TargetProperty; spelling: string }>;
  /** The source does not produce it under any name the type knows. */
  missing: TargetProperty[];
  /** Lined up by name, and something about them could not be settled. */
  unproven: string[];
}

function compareColumns(shape: SourceShape, target: TargetShape): Verdict {
  const supplied = new Map(shape.columns.map((column) => [column.name, column]));
  const verdict: Verdict = { respelled: [], missing: [], unproven: [] };

  for (const property of target.properties) {
    const column = supplied.get(property.name);
    if (column) {
      const doubt = doubtAbout(property, column);
      if (doubt) verdict.unproven.push(doubt);
      continue;
    }
    const spelling = property.columnName;
    if (spelling && spelling !== property.name && supplied.has(spelling)) {
      verdict.respelled.push({ property, spelling });
      continue;
    }
    verdict.missing.push(property);
  }

  return verdict;
}

/**
 * Whether a property the source does supply raises a question, in one sentence.
 *
 * Everything here is a *question*, never a refusal, and the reason is `coerce`
 * in the warehouse store: it is total. It stringifies for a `string`, JSON
 * encodes for a `json`, parses a `date` and gives up as null, and returns null
 * for a number that is not finite. So a `string` column arriving at a `number`
 * property loads perfectly when every value happens to be numeric and writes
 * nulls when one is not — which is a fact about the rows, and against a driver
 * description with `sampled: 0` no rows were read. Calling that "does not fit"
 * would refuse graphs that load correctly every night.
 */
function doubtAbout(property: TargetProperty, column: SourceColumn): string | undefined {
  const label = `\`${property.name}\``;
  if (column.type === null || column.confidence === 'unknown') {
    return `${label} — discovery reached no conclusion about it${column.sourceType ? ` (the source calls it ${column.sourceType})` : ''}, and ${property.type} is what the type expects`;
  }
  if (!absorbs(property.type, column.type)) {
    return `${label} — the source reports ${column.type} and the type says ${property.type}, so each value is converted on the way in and the ones that will not convert are written as null`;
  }
  if (property.nullable === false && column.nullable === true) {
    return `${label} — the type says it is never null and the source says its column may be`;
  }
  return undefined;
}

/**
 * Whether a property's type takes a column's without a question being raised.
 *
 * `string`, `json` and `unknown` take anything, because `coerce` reaches them
 * through `String(...)` and `JSON.stringify(...)`, both of which are total.
 * `unknown` on the column side is not a type at all — it is the answer somebody
 * gave when nothing better fit — so it settles nothing and is left to the
 * caller, which reports it as a question rather than as a fit.
 */
function absorbs(property: ScalarType, column: ScalarType): boolean {
  if (property === column) return true;
  return property === 'string' || property === 'json' || property === 'unknown';
}

/**
 * The 6,905-row case, named as itself.
 *
 * Two ways out, and the cheaper one first. Renaming the PROPERTY to the source's
 * spelling is now allowed — `outputAlias` cleans a name SQL cannot take on its
 * way to a column, so `Asset Id` is a legal property name and the split these
 * types carry was a repair for a refusal that no longer exists. A transform is
 * the answer where the name genuinely cannot become a column even cleaned, which
 * is a much smaller set than the one this reports. See the file header.
 *
 * `edgeIds` is left empty here and on every problem below, and that is not an
 * omission: `edgesFor` in `validate.ts` derives the wire from the node ids for
 * exactly the codes that are about a wire, which is where every other edge id on
 * this canvas comes from. Deriving a second copy here is the drift that module
 * is written to prevent. The warnings are absent from that list on purpose — a
 * red wire is error styling, and "not known" must never wear it.
 */
function respelledProblem(
  source: WorkflowSourceNode,
  sink: WorkflowSinkNode,
  target: TargetShape,
  respelled: Verdict['respelled'],
): WorkflowProblem {
  const examples = respelled
    .slice(0, NAMED_LIMIT)
    .map(({ property, spelling }) => `\`${spelling}\` → \`${property.name}\``)
    .join(', ');
  return {
    level: 'error',
    code: 'shape-source-spelling',
    message: `"${nodeName(source)}" produces ${countOf(respelled.length, 'column')} that ${target.name} knows under a different name: ${examples}${andMore(respelled.length)}. The load looks every field up by the property's own name, and a source wired straight into a sink hands its records over exactly as they arrive — so each of these would be written as null in every row, and the load would still report the rows it read. Rename the ${respelled.length === 1 ? 'property' : 'properties'} on ${target.name} to the spelling the source uses, which publishing now accepts; where a name cannot become a column even cleaned, put a transform between them to rename the field instead.`,
    nodeIds: [source.id, sink.id],
    edgeIds: [],
  };
}

function missingProblem(
  source: WorkflowSourceNode,
  sink: WorkflowSinkNode,
  target: TargetShape,
  missing: readonly TargetProperty[],
): WorkflowProblem {
  const examples = missing
    .slice(0, NAMED_LIMIT)
    .map((property) => `\`${property.name}\``)
    .join(', ');
  return {
    level: 'error',
    code: 'shape-missing-column',
    message: `"${nodeName(source)}" does not produce ${countOf(missing.length, 'column')} that ${target.name} is made of: ${examples}${andMore(missing.length)}. Nothing between a source and a sink adds a field, so ${missing.length === 1 ? 'it' : 'each of them'} would be null in every row "${nodeName(sink)}" commits, on every run, and the run would report success.`,
    nodeIds: [source.id, sink.id],
    edgeIds: [],
  };
}

/**
 * The third outcome, with the basis stated rather than implied.
 *
 * `basis` and `sampled` are quoted because they are what makes this a warning
 * instead of an error: a driver description that read no rows can be trusted
 * completely about names and not at all about values, and a reader deciding
 * whether to go and look needs to know which of the two this is.
 */
function unprovenProblem(
  source: WorkflowSourceNode,
  sink: WorkflowSinkNode,
  target: TargetShape,
  unproven: readonly string[],
  shape: SourceShape,
): WorkflowProblem {
  const listed = unproven.slice(0, NAMED_LIMIT).join('; ');
  return {
    level: 'warning',
    code: 'shape-unproven',
    message: `${countOf(unproven.length, 'column')} between "${nodeName(source)}" and ${target.name} could not be decided from the schemas alone: ${listed}${andMore(unproven.length)}. ${describeBasis(shape)} Nothing here says the graph is wrong — it says this much of it was not proven right.`,
    nodeIds: [source.id, sink.id],
    edgeIds: [],
  };
}

/** What the discovery behind this can and cannot promise, in one sentence. */
function describeBasis(shape: SourceShape): string {
  if (shape.basis === 'sample') {
    const sampled = shape.sampled ?? 0;
    return `The types came from ${countOf(sampled, 'record')} read out of the source, so they are an inference over what was seen and not a statement about the rest.`;
  }
  if (shape.basis === 'driver') {
    return `The types came from the driver's description of the result set and no rows were read (sampled ${shape.sampled ?? 0}), so the column names are the source's own and nothing at all is known about the values.`;
  }
  return 'The discovery behind this did not say how it knows, so treat the types as unproven.';
}

function countOf(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function andMore(total: number): string {
  return total > NAMED_LIMIT ? `, and ${total - NAMED_LIMIT} more` : '';
}
