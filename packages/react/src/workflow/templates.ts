import {
  CONNECTOR_KINDS,
  type ConnectorKind,
  type DeleteReconciliation,
  type LoadExpectationInput,
  type TransformLanguage,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowNodeKind,
  type WorkflowSinkNode,
  type WorkflowSourceNode,
  type WorkflowTransformNode,
  isSafeIdentifier,
  physicalColumn,
} from '@dudousxd/nestjs-catalog/client';

/**
 * The half-dozen graphs people actually draw, with the decisions already made.
 *
 * WHY THIS FILE EXISTS, WHICH IS NOT CONVENIENCE
 * ---------------------------------------------
 * Thirteen types were loaded into a dev catalog in one evening by hand-building
 * one pipeline per type. Six came out with **every renamed column 100% null** —
 * `Subwo` has 313,833 rows and 73 of its 84 columns empty. Nothing caught it:
 * the loads committed, the row counts were right, the runs were green. The same
 * wrong decision about property naming was simply made six times, because it was
 * being re-derived per type by somebody trying to get data in.
 *
 * A template is therefore not sugar. It is the place a decision that is easy to
 * get wrong is made **once, by somebody who thought about it**, and written down
 * where it can be reviewed. Every template here states what it assumes and what
 * it declares on the operator's behalf, and both travel with the plan it
 * produces so a screen can show them rather than bury them.
 *
 * THREE RULES EVERY TEMPLATE HERE OBEYS
 * -------------------------------------
 * **It does not hide the decision.** A plan is plain nodes, edges, transform
 * bodies and expectation payloads. There is no template object left behind in
 * the saved workflow and nothing a screen cannot render as an ordinary graph —
 * after applying one, every choice it made is an editable field. That is the
 * point: a template that produced an opaque graph would be worse than no
 * template, because the next person could not tell what had been decided for
 * them.
 *
 * **It does not claim a mode it cannot justify.** Nothing here offers
 * `incremental`. An incremental load is refused outright unless the type carries
 * a delete-reconciliation declaration, and it needs a watermark column the
 * template cannot know — so offering it would mean either shipping a graph that
 * fails at its first run or inventing a declaration on somebody's behalf.
 * {@link periodicFullReload} is the one template that touches reconciliation at
 * all, and it declares the strategy and the cadence *together*, from one input,
 * because that is exactly the pair nothing currently links.
 *
 * **It does not restate a list.** Source kinds come from {@link CONNECTOR_KINDS}
 * through {@link SOURCE_KINDS}, starter code is keyed by `TransformLanguage`,
 * nodes are built through {@link NODE_FACTORIES} keyed by `WorkflowNodeKind`,
 * and the naming rule is `isSafeIdentifier(physicalColumn(…))` from the catalog
 * itself — the same two calls, in the same order, that the DDL makes and that
 * the publish-time refusal makes. All four are exhaustive mappings over an
 * exported union, so a kind or a language added to the library without a line
 * here is a **compile error**, not a template that quietly stops covering it.
 * This codebase has been bitten repeatedly by hand-maintained lists that go
 * silent.
 *
 * THE NAMING PROBLEM, WHICH IS THE WHOLE REASON FOR THE REFUSALS
 * -------------------------------------------------------------
 * The warehouse matches records to properties **by property name** —
 * `row[property.name]`, in both the MySQL and ClickHouse stores. So on a graph
 * with no transform on the path, where a record arrives keyed by the source's
 * own column spelling, the property has to be named that spelling exactly.
 * `columnName` is display metadata; it is never a lookup key and never becomes
 * SQL, so recording the source's spelling there does not redirect anything.
 *
 * That used to make the whole class of awkward columns unloadable. A property
 * name was written verbatim as the view's output column and as the alias of
 * every read, both through `ident`, which refuses rather than escapes — so a
 * source column called `Asset Id` could be neither kept (publishing refused the
 * name) nor renamed to `Asset_Id` (the record still arrives keyed `Asset Id`,
 * the store asks for `Asset_Id`, gets `undefined`, and writes null into every
 * row of every run while reporting success). The second is the naive fix and is
 * precisely what produced the six null types.
 *
 * **`fix/view-alias-sanitised` has since landed, and it closed the first door.**
 * Both alias sites now go through `outputAlias`, which cleans a name SQL cannot
 * take and leaves one it can exactly as it is, so a property may keep the
 * source's own spelling end to end: `Asset Id` is now a perfectly good property
 * name, lands in a column called `Asset_Id`, and reads back under `Asset Id`.
 * `Asset LIN/TAMCN` likewise. Refusing those would now be refusing a graph the
 * server would happily accept, so the templates no longer do.
 *
 * **What is left is narrower and is still a trap.** The publish-time refusal
 * asks whether the name *cleans* to an identifier, not whether it is one, and a
 * name can still fail that: `2024 Total` cleans to `2024_Total`, and no store
 * will quote a column starting with a digit. For those columns both doors are
 * still shut in exactly the old way — the name is refused at publish, and the
 * rename that gets reached for instead is the one that writes nulls forever. So
 * {@link replicateTable} and {@link loadFileDrop} still **refuse**, on precisely
 * that set, and name every offending column. The refusal did not go away; its
 * subject got smaller and its reason got sharper.
 */

/* -------------------------------------------------------------------------- */
/* What a template hands back                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One decision a template made so that the operator did not have to.
 *
 * Three fields rather than one sentence, because the three are read at different
 * moments. `what` is scanned in a list before applying; `why` is the argument,
 * and is what somebody needs in order to *disagree*; `changeAt` is what they
 * need afterwards, and its existence is the promise that nothing here is
 * permanent. A declaration with no `changeAt` would be a decision the template
 * had hidden, which is the one thing a template may not do.
 */
export interface TemplateDeclaration {
  /** The decision, in one line. */
  what: string;
  /** The reasoning, addressed to somebody who may want to overrule it. */
  why: string;
  /** Where on the screen this is changed after the template is applied. */
  changeAt: string;
}

export type TemplateRefusalCode =
  /** Columns the source spells in a way that cannot become a property name. */
  | 'columns-not-identifiers'
  /** Nobody has run discovery, so the question above cannot be answered. */
  | 'columns-unknown'
  /** A required field of the template's own form was left blank. */
  | 'incomplete'
  /** Two branches of one graph aimed at the same object type. */
  | 'duplicate-target-type';

/**
 * Why a template will not produce a graph.
 *
 * A refusal, not a warning, and never a graph-with-a-note-attached. The failure
 * this whole file exists for is a load that looks successful, so a template that
 * emitted the null-producing graph alongside a caution would be reproducing it:
 * the graph would get applied and the caution would get scrolled past.
 */
export interface TemplateRefusal {
  code: TemplateRefusalCode;
  /** A full sentence, addressed to whoever chose the template. */
  message: string;
  /** The column or type names this is about, when it is about named things. */
  subjects: readonly string[];
}

/** A transform the plan needs created before its graph can run. */
export interface TemplateTransformRequest {
  /** The transform node that will point at it once it has a server id. */
  forNodeId: string;
  name: string;
  language: TransformLanguage;
  /** A function body over `records`, ready to run and meant to be edited. */
  code: string;
  /** What this code is for, in the words the editor should show above it. */
  why: string;
}

/** A per-type load expectation the template declares. */
export interface TemplateExpectation {
  typeName: string;
  input: LoadExpectationInput;
  why: string;
}

/**
 * How often the graph must run, as one object holding both halves.
 *
 * The pair is the entire point of {@link periodicFullReload}: a cron expression
 * and a `withinMs` are two statements about the same cadence, and an operator
 * setting one and forgetting the other is how a type ends up declaring a
 * reconciliation interval nothing honours. Both come from one entry of
 * {@link RELOAD_CADENCES}, so they cannot disagree.
 */
export interface TemplateSchedule {
  /** Cron-ish, in whatever `CATALOG_SCHEDULE_TZ` names. */
  cron: string;
  /** The same cadence in milliseconds, which is what `withinMs` is derived from. */
  everyMs: number;
  /** For a screen: "every six hours". */
  human: string;
}

/**
 * Everything a template produces, as data a screen applies rather than as a
 * side effect.
 *
 * Nothing in here is written anywhere by this module. A plan is a proposal: the
 * screen shows it, the operator edits it, and only then does anything get
 * POSTed. That ordering is what makes {@link declarations} meaningful — a
 * decision somebody was told about *after* it had been saved is not a decision
 * they were offered.
 */
export interface TemplatePlan {
  templateId: WorkflowTemplateId;
  /** A suggested workflow name. Editable like everything else. */
  name: string;
  description: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  /**
   * Transforms to create first. The matching transform nodes carry
   * `transformId: ''` until they exist — see {@link attachTransformIds}, and see
   * {@link planIsRunnable} for why an unattached plan is deliberately not valid.
   */
  transforms: readonly TemplateTransformRequest[];
  expectations: readonly TemplateExpectation[];
  schedule?: TemplateSchedule;
  declarations: readonly TemplateDeclaration[];
  /** What the operator still has to fill in. Placeholders, connections, queries. */
  todo: readonly string[];
}

export type TemplateOutcome =
  | { ok: true; plan: TemplatePlan }
  | { ok: false; refusals: readonly TemplateRefusal[] };

/* -------------------------------------------------------------------------- */
/* Lists derived from the library's own, so a new kind fails the build         */
/* -------------------------------------------------------------------------- */

/**
 * What each source kind needs configured, and — the load-bearing part — whether
 * a graph reading through it can go straight into a sink.
 *
 * A `Record` over {@link ConnectorKind} rather than a list of the kinds this
 * file happens to care about. Adding a sixth kind to `CONNECTOR_KINDS` without
 * adding an entry here is a type error, which is the only way a template can be
 * trusted to still be talking about the whole set a year from now.
 *
 * `keysRecordsBySourceName` is the field the refusals turn on. Every fetcher
 * that reads a tabular source hands records over keyed by the source's own
 * column spelling, so with no transform on the path the property names have to
 * *be* those spellings — which is answerable, and is what
 * {@link refuseUnusableColumnNames} answers. `inline` is the one kind where the
 * question does not arise: the records were pasted in by whoever is authoring
 * the graph, so their keys are already whatever that person chose.
 */
interface SourceKindProfile {
  /** For a screen, and for the sentences below. */
  label: string;
  /** Config keys the fetcher requires. Shipped as placeholders and as `todo`. */
  required: readonly string[];
  /** Config keys worth offering, but which have working defaults. */
  optional: readonly string[];
  /** Whether records arrive keyed by the source's own column names. */
  keysRecordsBySourceName: boolean;
}

export const SOURCE_KINDS: Record<ConnectorKind, SourceKindProfile> = {
  http: {
    label: 'an HTTP endpoint',
    required: ['url'],
    optional: ['headers', 'path'],
    keysRecordsBySourceName: true,
  },
  sql: {
    label: 'a SQL database',
    required: ['url', 'query'],
    optional: ['watermarkColumn'],
    keysRecordsBySourceName: true,
  },
  file: {
    label: 'a file',
    required: ['path'],
    optional: ['format', 'jsonPath', 'delimiter', 'sheet', 'maxBytes', 'readIdleTimeoutMs'],
    keysRecordsBySourceName: true,
  },
  s3: {
    label: 'an object store',
    required: ['bucket'],
    optional: [
      'prefix',
      'suffix',
      'format',
      'delimiter',
      'sheet',
      'maxBytes',
      'readIdleTimeoutMs',
      'region',
      'maxObjectsPerRun',
    ],
    keysRecordsBySourceName: true,
  },
  inline: {
    label: 'records pasted into the graph',
    required: ['records'],
    optional: [],
    // The keys are whatever the author typed, so there is no source spelling to
    // disagree with a property name and nothing for the refusal to check.
    keysRecordsBySourceName: false,
  },
};

/**
 * The kinds a file drop can arrive as, derived rather than listed.
 *
 * `CONNECTOR_KINDS` filtered by what {@link SOURCE_KINDS} says about it, so a
 * new file-ish kind is picked up by having its profile filled in rather than by
 * somebody remembering this line exists.
 */
export const FILE_DROP_KINDS = CONNECTOR_KINDS.filter(
  (kind): kind is Extract<ConnectorKind, 'file' | 's3'> => kind === 'file' || kind === 's3',
);

/**
 * A node of each kind, built through one exhaustive map.
 *
 * Keyed by {@link WorkflowNodeKind} for the same reason {@link SOURCE_KINDS} is
 * keyed by `ConnectorKind`: a fourth node kind added to the library leaves this
 * object missing a property, and the build stops. Written out per kind rather
 * than as one shape with optional fields because the executable model is a
 * discriminated union — a source carries a source kind and a config, a transform
 * carries a transform, a sink carries the type it commits, and nothing carries a
 * field belonging to another kind.
 */
type NodeFactories = {
  [K in WorkflowNodeKind]: (
    id: string,
    name: string,
    init: Omit<Extract<WorkflowNode, { kind: K }>, 'id' | 'name' | 'kind'>,
  ) => Extract<WorkflowNode, { kind: K }>;
};

const NODE_FACTORIES: NodeFactories = {
  source: (id, name, init) => ({ id, name, kind: 'source', ...init }),
  transform: (id, name, init) => ({ id, name, kind: 'transform', ...init }),
  sink: (id, name, init) => ({ id, name, kind: 'sink', ...init }),
  // `call` arrived after these templates were written, and the map above is
  // exactly why: the build stopped rather than the kind going quietly missing.
  //
  // No template below builds one, and that is a statement rather than an
  // omission. A call node hands a step to a workflow this graph does not own,
  // pinned by name and version — which is a decision about somebody else's
  // code, and a template exists to make a decision once on the reader's behalf.
  // There is nothing here to decide for them, and no way to enumerate a
  // deployment's registrations to offer a choice from. The factory is complete
  // so that a template CAN build one the day a case is worth prefilling.
  call: (id, name, init) => ({ id, name, kind: 'call', ...init }),
  // `if` arrived the same way `call` did, and the map stopped the build again.
  //
  // Also unused by every template below, for a reason of its own: which
  // environment variable tells one deployment apart from another is the entire
  // content of a gate, and it is knowledge about a *deployment* rather than
  // about a pipeline shape. A template that guessed one would prefill a decision
  // that is wrong everywhere except where it was written — and a branch that is
  // wrong is a half of the graph that silently does not run, which is the one
  // failure this node had to be built not to have.
  if: (id, name, init) => ({ id, name, kind: 'if', ...init }),
  // `filter` arrived third, and the map stopped the build a third time.
  //
  // Also unused by every template below, and this one is the clearest case of
  // the three. A filter's content is a *column name and a value* — which are
  // facts about one organisation's data, not about a pipeline shape — and a
  // template that guessed `status = "OPEN"` would prefill a predicate that is
  // wrong everywhere it is opened. Worse, a prefilled filter sitting in front of
  // a sink is precisely the accident `WorkflowFilterNode.narrows` exists to make
  // impossible: the template would be shipping a graph that shrinks a published
  // type, with nobody having chosen it.
  filter: (id, name, init) => ({ id, name, kind: 'filter', ...init }),
};

/* -------------------------------------------------------------------------- */
/* Starter transform code                                                      */
/* -------------------------------------------------------------------------- */

/**
 * What every starter body has to say out loud, and why it is said in a comment
 * rather than only in a docblock nobody will be looking at.
 *
 * A transform node with several inbound edges receives its inputs **concatenated
 * in edge order, in one array, with nothing marking which record came from
 * which side**. That is the model's documented behaviour and it is what makes a
 * join expressible at all — the code can see every record at once — but it is
 * also the single most surprising thing about writing one. The obvious
 * assumption is that two inputs arrive as two arguments, or as two arrays, and
 * code written under that assumption produces a plausible-looking result from
 * the wrong half of the data.
 *
 * So the starter code partitions the batch explicitly and the comment naming the
 * behaviour sits directly above the loop that depends on it. Somebody editing
 * this a month later reads it in the editor; they do not read this file.
 */
const JOIN_NOTE = [
  'Both inbound edges arrive here as ONE array, concatenated in edge order.',
  'Nothing marks which source a record came from, so they are told apart by a',
  'field only one side carries. Change the discriminator if either shape does.',
];

/** Render a note as comment lines in the language's own syntax. */
function comment(lines: readonly string[], language: TransformLanguage): string {
  const prefix = language === 'python' ? '# ' : '// ';
  return lines.map((line) => `${prefix}${line}`).join('\n');
}

/**
 * A list literal that reads the same in all three languages.
 *
 * `JSON.stringify` on each element rather than a template with quotes around it:
 * a column called `O'Brien` would otherwise close the string and produce a
 * starter body that does not parse, which is a confusing first impression of a
 * template whose entire subject is awkward column names.
 */
function quoteList(values: readonly string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(', ')}]`;
}

interface JoinCodeOptions {
  discriminator: string;
  leftKey: string;
  rightKey: string;
  /** Whether a left record with no match survives. */
  keepUnmatched: boolean;
}

/**
 * A keyed join over the concatenated batch, per language.
 *
 * Keyed by {@link TransformLanguage} so a language added to the library without
 * a body here is a type error rather than a transform that saves empty and fails
 * at run time — the same argument `IDENTITY_TRANSFORM` in the canvas makes.
 *
 * `keepUnmatched` is the one genuinely contested choice and it is why enrichment
 * and joining are separate templates over identical code. Enriching against a
 * lookup keeps a row whose key is not in the dictionary, because dropping it
 * would mean a load silently loses every record the lookup has not heard of yet
 * — which is the null-shaped failure this file exists for, wearing a different
 * hat. Joining two feeds into one type drops it, because a record with no
 * counterpart is not a record of the joined thing.
 */
const JOIN_CODE: Record<TransformLanguage, (options: JoinCodeOptions) => string> = {
  javascript: (options) => javascriptJoin(options),
  // Deliberately the same body. The runner strips types and never checks them,
  // so a TypeScript transform is JavaScript with annotations allowed; shipping
  // an annotated copy would be two bodies to fix when the logic is wrong.
  typescript: (options) => javascriptJoin(options),
  python: (options) => pythonJoin(options),
};

function javascriptJoin(options: JoinCodeOptions): string {
  const { discriminator, leftKey, rightKey, keepUnmatched } = options;
  const miss = keepUnmatched
    ? '    // No match: the row is kept as it arrived, with nothing added.\n    if (!found) return record;'
    : '    // No match: this row is not a record of the joined thing, so it is dropped.\n    if (!found) return undefined;';
  return `${comment(JOIN_NOTE, 'javascript')}
const left = [];
const right = [];
for (const record of records) {
  (Object.hasOwn(record, ${JSON.stringify(discriminator)}) ? left : right).push(record);
}

// A missing key is not a key, so a record without one is never indexed. Left it
// in and every row that is ALSO missing the key would join to it: a full result
// set, a plausible row count, entirely wrong rows. Skipping it here covers both
// sides at once — nothing is stored under a missing key, so nothing can be
// looked up by one either.
const byKey = new Map();
for (const record of right) {
  const key = record[${JSON.stringify(rightKey)}];
  if (key === undefined || key === null) continue;
  byKey.set(key, record);
}

return left
  .map((record) => {
    const found = byKey.get(record[${JSON.stringify(leftKey)}]);
${miss}
    // The left record wins on any field both sides carry: it is the record this
    // row is about, and the lookup is only filling in what it did not know.
    return { ...found, ...record };
  })
  .filter((record) => record !== undefined);`;
}

function pythonJoin(options: JoinCodeOptions): string {
  const { discriminator, leftKey, rightKey, keepUnmatched } = options;
  const miss = keepUnmatched
    ? '        # No match: the row is kept as it arrived, with nothing added.\n        out.append(record)\n        continue'
    : '        # No match: this row is not a record of the joined thing, so it is dropped.\n        continue';
  return `${comment(JOIN_NOTE, 'python')}
left = []
right = []
for record in records:
    (left if ${JSON.stringify(discriminator)} in record else right).append(record)

# A missing key is not a key, so a record without one is never indexed. Left it
# in and every row that is ALSO missing the key would join to it: a full result
# set, a plausible row count, entirely wrong rows. Skipping it here covers both
# sides at once — nothing is stored under a missing key, so nothing can be
# looked up by one either.
by_key = {}
for record in right:
    key = record.get(${JSON.stringify(rightKey)})
    if key is None:
        continue
    by_key[key] = record

out = []
for record in left:
    found = by_key.get(record.get(${JSON.stringify(leftKey)}))
    if found is None:
${miss}
    # The left record wins on any field both sides carry: it is the record this
    # row is about, and the lookup is only filling in what it did not know.
    merged = dict(found)
    merged.update(record)
    out.append(merged)
return out`;
}

/**
 * Narrow one shared batch down to the columns a single type commits.
 *
 * Every branch of a fan-out reads the **same** rows — a node with two outbound
 * edges is read by both successors — so each branch has to do its own narrowing.
 * A fan-out wired straight from one source into several sinks would commit
 * identical wide rows into every type, which is not what anybody drawing that
 * shape means.
 */
const PROJECT_CODE: Record<
  TransformLanguage,
  (typeName: string, keep: readonly string[]) => string
> = {
  javascript: (typeName, keep) => javascriptProject(typeName, keep),
  typescript: (typeName, keep) => javascriptProject(typeName, keep),
  python: (typeName, keep) => `${comment(projectNote(typeName), 'python')}
keep = ${quoteList(keep)}
return [{key: record.get(key) for key in keep} for record in records]`,
};

function projectNote(typeName: string): readonly string[] {
  return [
    `Keep only the columns ${typeName} commits.`,
    'Every branch of this graph reads the SAME source rows, so each one narrows',
    'them itself. These names are property names, and the warehouse looks each',
    'field up by property name — so what this returns has to be keyed by them.',
  ];
}

function javascriptProject(typeName: string, keep: readonly string[]): string {
  return `${comment(projectNote(typeName), 'javascript')}
const keep = ${quoteList(keep)};
return records.map((record) =>
  Object.fromEntries(keep.map((key) => [key, record[key]])),
);`;
}

/* -------------------------------------------------------------------------- */
/* The identifier refusal                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Whether a column name could be published as a property name at all.
 *
 * `isSafeIdentifier(physicalColumn(name))` — the same two calls, in the same
 * order, that `identifierRefusal` makes at publish time and that every store
 * makes on the way to a column. Both come from `@dudousxd/nestjs-catalog/client`
 * and are the functions themselves, not a copy of either: a canvas whose idea of
 * a legal name differs from the server's by one character is a canvas that
 * promises a load the publisher then refuses, or refuses one it would have
 * taken.
 *
 * **It is the composition and not `isSafeIdentifier` alone**, and getting that
 * wrong in either direction is a real failure rather than a nicety. Asking only
 * `isSafeIdentifier(name)` is the obsolete, stricter question — it refuses
 * `Asset Id`, which now works end to end, and the operator sent away by that
 * refusal is being sent to do the rename that writes nulls. Asking only whether
 * the cleaning *ran* would pass everything, since `physicalColumn` always
 * returns something. What has to be asked is whether what it returns is a name a
 * store can create.
 *
 * **Which is a narrow set, and worth naming exactly so nobody re-derives it.**
 * The cleaning already guarantees the character set and the length, so the only
 * things left for `isSafeIdentifier` to reject are a cleaned form that starts
 * with a digit and one that is empty. In practice: `2024 Total` → `2024_Total`
 * is refused; `FY24 Hours` → `FY24_Hours` is not, because the digits are not
 * first; `#Rank` → `_Rank` is not, because punctuation becomes an underscore and
 * an underscore may lead; `Asset LIN/TAMCN` → `Asset_LIN_TAMCN` is not. A column
 * named with the empty string is the other refusal, and a source producing one
 * has a problem this template is not the right place to explain.
 */
function canBePropertyName(column: string): boolean {
  return isSafeIdentifier(physicalColumn(column));
}

/**
 * Refuse the column names that cannot become property names, or say nothing.
 *
 * The single most important function in this file, and the one place the naming
 * rule is applied. See the header for the full argument; the short version is
 * that with no transform on the path a record arrives keyed by the source's own
 * spelling and the store asks for `row[property.name]`, so the two have to be
 * the same string — and while that string no longer has to be a SQL identifier
 * itself, it still has to *clean* to one.
 *
 * Three outcomes rather than two, and the third is not a formality:
 *
 * - Every column is usable — nothing is returned. This is now the answer for
 *   `Asset Id` and `Asset LIN/TAMCN`, which it was not before
 *   `fix/view-alias-sanitised` landed.
 * - Some are not — a refusal naming every one of them. All of them, not the
 *   first, because a legacy export is usually wrong about forty columns in the
 *   same way and one refusal per attempt would make fixing it a morning.
 * - **Nobody knows what the columns are** — also a refusal, with its own code,
 *   and it survived the alias fix on purpose. The set it protects against got
 *   much smaller and did not empty: a source with a `2024 Total` column, applied
 *   without anybody looking, still ends with that property refused at publish,
 *   renamed to `2024_Total` by the obvious next move, and loading null into
 *   every row of every run while reporting success. That is the original
 *   disaster, still reachable, one column narrower. A template that proceeded on
 *   an unknown column list would be asserting the names are fine because nobody
 *   looked. Silence is not a pass.
 */
export function refuseUnusableColumnNames(
  columns: readonly string[] | undefined,
  context: { what: string; remedy: string },
): TemplateRefusal | undefined {
  if (columns === undefined) {
    return {
      code: 'columns-unknown',
      subjects: [],
      message: `Nobody has said which columns ${context.what} produces, so this template cannot check the one thing that would make it commit nulls. With no transform on the path a record arrives keyed by the source's own column spelling and the warehouse looks every field up by property name, so the two have to match exactly — and while a property name may now be spelled however the source spells it, it still has to clean to something a store can create as a column. Run schema discovery on the source first, or ${context.remedy}`,
    };
  }

  const offenders = columns.filter((column) => !canBePropertyName(column));
  if (offenders.length === 0) return undefined;

  return {
    code: 'columns-not-identifiers',
    subjects: offenders,
    message: `${offenders.length === 1 ? 'One column' : `${offenders.length} columns`} of ${context.what} ${offenders.length === 1 ? 'is' : 'are'} spelled in a way that cannot be a property name: ${offenders.map((name) => `${JSON.stringify(name)} (cleans to ${JSON.stringify(physicalColumn(name))})`).join(', ')}. A property name does not have to be a SQL identifier — a store cleans it, so \`Asset Id\` is a perfectly good name and lands in \`Asset_Id\` — but what the cleaning produces still has to be one, and ${offenders.length === 1 ? 'this one is not' : 'these are not'}. Publishing refuses the name, and the rename reached for instead is the trap: the warehouse matches records to properties by name, so a property called \`${physicalColumn(offenders[0])}\` while the record still arrives keyed \`${offenders[0]}\` writes null into that column on every run and reports success. That is what happened to six types in one evening, so this template refuses rather than guessing which way you meant. ${context.remedy}`,
  };
}

/** The remedy sentence, which is the same one every no-transform template gives. */
const RENAME_REMEDY =
  "Put a transform between the source and the sink whose job is to rename the record keys to the property names — the model's own answer, and the reason `columnName` exists is to record what the source called it. For these columns the rename is genuinely unavoidable, which is why it is worth writing rather than a chore: there is no spelling that is both what the source sends and something a store can create.";

/* -------------------------------------------------------------------------- */
/* Cadences                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The cadences a periodic full reload may run at, each carrying both halves.
 *
 * **This closed list is the template.** A cron expression and a `withinMs` are
 * two statements about one cadence, and today nothing links them: an operator
 * sets a schedule on one screen and a reconciliation interval on another, and
 * nothing anywhere notices when they stop agreeing. `withinMs` is only honest if
 * the schedule really does reload that often — once the newest full load of a
 * type is older than it, incremental loads of that type stop committing — so a
 * `withinMs` larger than the real cadence is a guard that never fires and a
 * smaller one is a guard that fires constantly.
 *
 * Deriving both from one entry makes disagreement impossible. Somebody wanting a
 * cadence that is not here has to add it here, in code, where both halves are on
 * the same line and a reviewer sees them together — which is the whole doctrine
 * of this file applied to itself.
 *
 * The cron is evaluated in whatever `CATALOG_SCHEDULE_TZ` names and `everyMs` is
 * wall-clock, so the two drift by an hour twice a year across a DST boundary.
 * The slack in {@link withinMsFor} absorbs that; it is called out here because a
 * reader comparing `86_400_000` against `0 2 * * *` deserves to know it is not
 * an exact identity.
 */
export const RELOAD_CADENCES = {
  hourly: { cron: '0 * * * *', everyMs: 3_600_000, human: 'every hour' },
  'six-hourly': { cron: '0 */6 * * *', everyMs: 21_600_000, human: 'every six hours' },
  daily: { cron: '0 2 * * *', everyMs: 86_400_000, human: 'every day at 02:00' },
  weekly: { cron: '0 2 * * 0', everyMs: 604_800_000, human: 'every Sunday at 02:00' },
} as const satisfies Record<string, TemplateSchedule>;

export type ReloadCadence = keyof typeof RELOAD_CADENCES;

export const RELOAD_CADENCE_IDS = Object.keys(RELOAD_CADENCES) as readonly ReloadCadence[];

/**
 * How stale a type may get before its reconciliation claim stops being true.
 *
 * Twice the cadence, and the factor is a decision rather than a round number.
 * At exactly the cadence, any run that starts a minute late — or simply takes a
 * few minutes, since the age is measured from the snapshot's creation — makes
 * the type stale and stops incremental loads of it committing. A guard that
 * fires on an ordinary Tuesday is a guard somebody switches off, taking the real
 * failure with it.
 *
 * Twice means one missed cycle is tolerated and the second consecutive miss is
 * refused, which is the smallest slack that distinguishes "late" from "not
 * happening". It also covers the DST hour noted on {@link RELOAD_CADENCES}.
 */
export function withinMsFor(cadence: ReloadCadence): number {
  return RELOAD_CADENCES[cadence].everyMs * 2;
}

/* -------------------------------------------------------------------------- */
/* Node construction                                                           */
/* -------------------------------------------------------------------------- */

/**
 * A node id that is stable across re-applications of the same template.
 *
 * Deliberately derived from what the node is *for* rather than randomised. A
 * node id becomes a durable step name and part of the key its staged rows are
 * stored under, so an id that changes between one application and the next
 * re-executes work a replay would otherwise have skipped. The canvas randomises
 * ids for nodes somebody draws by hand, which is right for those — there is no
 * meaning to preserve — and wrong for these.
 *
 * `WORKFLOW_NODE_ID_PATTERN` allows letters, digits, underscore and hyphen up to
 * 64 characters; anything else is folded to `_` and the whole thing is bounded,
 * with an ordinal appended so that two types whose names differ only outside the
 * alphabet cannot collide into one id.
 */
function nodeId(prefix: string, subject: string, ordinal: number): string {
  const cleaned = subject.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40);
  return `${prefix}_${cleaned}_${ordinal}`.slice(0, 64);
}

/** Placeholder config for a source kind, from the profile rather than by hand. */
function placeholderConfig(kind: ConnectorKind): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const key of SOURCE_KINDS[kind].required) config[key] = '';
  return config;
}

function configTodo(kind: ConnectorKind, nodeName: string): string {
  const profile = SOURCE_KINDS[kind];
  return `"${nodeName}" reads ${profile.label} and needs ${profile.required
    .map((key) => `\`${key}\``)
    .join(' and ')} filled in — the template ships ${
    profile.required.length === 1 ? 'it' : 'them'
  } blank on purpose, because a placeholder that looks like a real address is worse than an empty one.`;
}

/**
 * The declaration every template here makes about load mode, stated once.
 *
 * Shared rather than repeated because it is the same decision for the same
 * reason in all six, and a reader comparing two templates should be able to see
 * that it is literally the same sentence rather than having to diff two
 * paraphrases.
 */
const FULL_MODE_DECLARATION: TemplateDeclaration = {
  what: 'This graph reads and commits in `full` mode.',
  why: 'An incremental load is blind to deletes — a row removed at the source never changes again, so it is never returned again and is carried forward into every later snapshot indefinitely, with nothing going wrong at any single step. Because that failure is silent the pipeline refuses an incremental load of a type that has not declared how deletes reach it, and it also needs a watermark column no template can know. Offering `incremental` here would mean shipping a graph that fails at its first run, or inventing a declaration on your behalf.',
  changeAt: 'The `mode` field on the source node and on the sink node.',
};

/* -------------------------------------------------------------------------- */
/* The templates                                                               */
/* -------------------------------------------------------------------------- */

export type WorkflowTemplateId =
  | 'replicate-table'
  | 'load-file-drop'
  | 'fan-out-types'
  | 'join-sources'
  | 'enrich-with-lookup'
  | 'periodic-full-reload';

/**
 * What a picker shows before anything is filled in.
 *
 * `assumes` is separate from the declarations on a plan, and the split matters.
 * A declaration is something the template *did* and can be undone; an assumption
 * is something it takes as given and cannot check, so somebody for whom it is
 * false should pick a different template rather than apply this one and edit it.
 */
export interface WorkflowTemplateMeta {
  id: WorkflowTemplateId;
  title: string;
  summary: string;
  assumes: readonly string[];
}

/**
 * The catalogue, keyed by id so that a new id without metadata fails the build.
 *
 * Shipped by the library rather than stored per deployment, deliberately: these
 * are decisions, decisions belong in code where they are reviewed and carry
 * their reasoning, and a template stored in a database is one nobody reviews.
 * Per-deployment templates are a store concern and a separate change, and this
 * sentence is here so that the absence reads as a decision rather than an
 * oversight.
 */
export const WORKFLOW_TEMPLATES: Record<WorkflowTemplateId, WorkflowTemplateMeta> = {
  'replicate-table': {
    id: 'replicate-table',
    title: 'Replicate a table',
    summary: 'One SQL query straight into one object type, with no transform in between.',
    assumes: [
      'The query returns one row per record of the type, already shaped the way the type wants it.',
      'Every column it returns is spelled in a way that can be a property name — which allows `Asset Id`, and not `2024 Total`. The template checks this and refuses if not.',
    ],
  },
  'load-file-drop': {
    id: 'load-file-drop',
    title: 'Load a file drop',
    summary: 'A CSV, NDJSON or JSON drop — on disk or in an object store — into one object type.',
    assumes: [
      'The drop is a full extract each time, not a delta.',
      'Its header row is spelled in a way that can be a property name — which allows `Asset LIN/TAMCN`, and not a column headed with a year. The template checks this and refuses if not.',
    ],
  },
  'fan-out-types': {
    id: 'fan-out-types',
    title: 'Fan one source into several types',
    summary: 'One expensive read, narrowed by a transform per type into a sink per type.',
    assumes: [
      'The source is worth reading once rather than once per type — that is the entire reason for this shape.',
      'Each type is a projection of the same rows. A type needing different rows needs its own source.',
    ],
  },
  'join-sources': {
    id: 'join-sources',
    title: 'Join two sources into one type',
    summary: 'Two reads, joined on a key inside one transform, committed as a single type.',
    assumes: [
      'One field tells the two sides apart, because the runner concatenates them into one untagged batch.',
      'The whole of both sides fits in memory at once — the transform contract is set-wise by design.',
    ],
  },
  'enrich-with-lookup': {
    id: 'enrich-with-lookup',
    title: 'Enrich against a lookup table',
    summary: 'A main feed plus a dictionary, joined so that unmatched rows survive.',
    assumes: [
      'The lookup is small enough to hold beside the feed it enriches.',
      'A row whose key is not in the lookup is still a row worth keeping. That is the difference from a join.',
    ],
  },
  'periodic-full-reload': {
    id: 'periodic-full-reload',
    title: 'Periodic full reload',
    summary:
      'A full read on a schedule, with the matching delete-reconciliation declared from the same cadence.',
    assumes: [
      'A full read is the right mode here rather than a stepping stone to an incremental one.',
      'The source can be read in its entirety at the chosen cadence without hurting it.',
    ],
  },
};

export const WORKFLOW_TEMPLATE_IDS = Object.keys(
  WORKFLOW_TEMPLATES,
) as readonly WorkflowTemplateId[];

/* --- 1. Replicate a table -------------------------------------------------- */

export interface ReplicateTableOptions {
  /** The object type the sink commits. */
  targetType: string;
  /**
   * The columns the query returns, as the source spells them.
   *
   * `undefined` means nobody has run discovery, which is a refusal rather than a
   * pass — see {@link refuseUnusableColumnNames}.
   */
  sourceColumns?: readonly string[];
  /** An existing connection to read through, when there is one. */
  connectionId?: string;
  /** A starting query. Shipped blank when absent, never guessed. */
  query?: string;
  workflowName?: string;
}

/**
 * SQL straight into a type — the named case, and the one that produced the
 * nulls.
 *
 * The shape is trivial and the value is entirely in the refusal. Two nodes and
 * one edge is not something anybody needs help drawing; what they need help with
 * is knowing that this shape is only correct when every column the query returns
 * can be a property name, and that when it is not, the graph still saves, still
 * runs, still commits and still reports the right row count while writing null
 * into most of the columns.
 *
 * So this template checks, and refuses, and names every offending column. It
 * does **not** offer to sanitise them: that is the naive fix and it is what was
 * done six times in one evening. For the columns that now reach this refusal
 * there is no spelling that is both the key the record arrives under and a name
 * a store can create, so the rename has to be paired with a transform that
 * renames the record's keys — which is a decision about the data rather than a
 * shape, and belongs to whoever knows the data.
 *
 * **What it no longer refuses.** `Asset Id` and `Asset LIN/TAMCN` pass now.
 * `fix/view-alias-sanitised` made the view's output alias and the read's lookup
 * key clean together, so a property keeps the source's spelling end to end and a
 * two-node graph over those columns is simply correct. Refusing them would be
 * this template sending somebody off to do the exact rename that caused the
 * incident it exists to prevent. See the header.
 */
export function replicateTable(options: ReplicateTableOptions): TemplateOutcome {
  const targetType = options.targetType.trim();
  if (targetType.length === 0) {
    return {
      ok: false,
      refusals: [
        {
          code: 'incomplete',
          subjects: [],
          message:
            'This template needs the object type the sink will commit. The type is chosen on the sink because the sink is the node that commits.',
        },
      ],
    };
  }

  const refusal = refuseUnusableColumnNames(options.sourceColumns, {
    what: 'the query',
    remedy: RENAME_REMEDY,
  });
  if (refusal) return { ok: false, refusals: [refusal] };

  const source = NODE_FACTORIES.source(nodeId('source', targetType, 1), `${targetType} query`, {
    sourceKind: 'sql',
    config: { ...placeholderConfig('sql'), ...(options.query ? { query: options.query } : {}) },
    ...(options.connectionId ? { connectionId: options.connectionId } : {}),
    mode: 'full',
  });
  const sink = NODE_FACTORIES.sink(nodeId('sink', targetType, 1), targetType, {
    targetType,
    mode: 'full',
  });

  return {
    ok: true,
    plan: {
      templateId: 'replicate-table',
      name: options.workflowName?.trim() || `Replicate ${targetType}`,
      description: `Reads ${targetType} from a SQL source in one query and commits it whole.`,
      nodes: [source, sink],
      edges: [{ from: source.id, to: sink.id }],
      transforms: [],
      expectations: [],
      declarations: [
        FULL_MODE_DECLARATION,
        {
          what: 'No transform sits between the source and the sink.',
          why: 'Every column the query returns was checked with the same two calls the store and the publish API make — cleaning the name, then asking whether the result is an identifier — and all of them can be property names, so the records arrive keyed exactly as the type will ask for them. Name the properties as the query spells them; a column called `Asset Id` wants a property called `Asset Id`, not `Asset_Id`. Had any column failed, this template would have refused instead of adding a transform, because the rename it would have to write is a decision about your data rather than a shape.',
          changeAt: 'Add a transform node on the edge if the mapping ever stops being one-to-one.',
        },
      ],
      todo: [
        configTodo('sql', source.name),
        `The sink commits \`${targetType}\`. Publish that type first if it does not exist — a sink naming a type nobody has published fails at the commit, after the whole source has been read.`,
      ],
    },
  };
}

/* --- 2. Load a file drop --------------------------------------------------- */

export interface FileDropOptions {
  targetType: string;
  /** `file` for a path or URL, `s3` for a bucket. Both parse the same formats. */
  kind: (typeof FILE_DROP_KINDS)[number];
  /** The header row, as the drop spells it. `undefined` refuses — see below. */
  sourceColumns?: readonly string[];
  connectionId?: string;
  workflowName?: string;
}

/**
 * A DoD/DPAS-style drop into a type.
 *
 * Structurally the same two nodes as {@link replicateTable} and separated from
 * it because the config, the assumptions and the failure mode differ enough that
 * one template covering both would have to hedge every sentence. A drop is a
 * full extract that lands on a schedule somebody else controls, its columns come
 * from a spreadsheet header rather than a `SELECT` list, and a spreadsheet header
 * is overwhelmingly the most likely place to meet a column headed `2024 Total`
 * or `2024 Q1 Hours` — which is why the same refusal matters more here, not less.
 *
 * `Asset LIN/TAMCN`, the header this template was written around, is no longer
 * one of them: it cleans to `Asset_LIN_TAMCN` and is published under its own
 * spelling. Nor is `FY24 Hours`, which cleans to `FY24_Hours` — the year has to
 * be at the *front* to be a problem. What is refused is a header whose cleaned
 * form starts with a digit, and that really does need a transform.
 */
export function loadFileDrop(options: FileDropOptions): TemplateOutcome {
  const targetType = options.targetType.trim();
  if (targetType.length === 0) {
    return {
      ok: false,
      refusals: [
        {
          code: 'incomplete',
          subjects: [],
          message: 'This template needs the object type the sink will commit.',
        },
      ],
    };
  }

  const refusal = refuseUnusableColumnNames(options.sourceColumns, {
    what: "the drop's header row",
    remedy: RENAME_REMEDY,
  });
  if (refusal) return { ok: false, refusals: [refusal] };

  const source = NODE_FACTORIES.source(nodeId('source', targetType, 1), `${targetType} drop`, {
    sourceKind: options.kind,
    config: placeholderConfig(options.kind),
    ...(options.connectionId ? { connectionId: options.connectionId } : {}),
    mode: 'full',
  });
  const sink = NODE_FACTORIES.sink(nodeId('sink', targetType, 1), targetType, {
    targetType,
    mode: 'full',
  });

  return {
    ok: true,
    plan: {
      templateId: 'load-file-drop',
      name: options.workflowName?.trim() || `Load ${targetType} drop`,
      description: `Reads a ${targetType} drop from ${SOURCE_KINDS[options.kind].label} and commits it whole.`,
      nodes: [source, sink],
      edges: [{ from: source.id, to: sink.id }],
      transforms: [],
      expectations: [],
      declarations: [
        FULL_MODE_DECLARATION,
        {
          what: 'Each run treats the drop as the complete dataset.',
          why: 'A drop is replaced rather than appended to, and a full commit repoints the view atomically, so a run that reads a short file replaces the good data with the short file. That is the failure worth knowing about here — the row-count bound on the type is what catches it, and it is worth setting before this runs unattended.',
          changeAt: "The type's load expectation, on the Model screen.",
        },
      ],
      todo: [
        configTodo(options.kind, source.name),
        options.kind === 's3'
          ? 'Set `prefix` and `suffix` so a run reads only the drop and not everything else in the bucket. Without them every object under the bucket is read on every run.'
          : 'Set `format` if the extension does not say — a `.txt` holding CSV is parsed as JSON and yields nothing.',
      ],
    },
  };
}

/* --- 3. Fan one source into several types ---------------------------------- */

export interface FanOutTarget {
  targetType: string;
  /** The property names this type commits. Also what the projection keeps. */
  properties: readonly string[];
}

export interface FanOutOptions {
  sourceKind: ConnectorKind;
  targets: readonly FanOutTarget[];
  language: TransformLanguage;
  connectionId?: string;
  workflowName?: string;
}

/**
 * One expensive read feeding several types.
 *
 * The reason the model allows several sinks at all: pulling ten million rows
 * once and deriving vehicles and work orders from them, rather than pulling
 * twice. The validator endorses it explicitly and guards the one genuinely
 * ambiguous case — two sinks writing the *same* type, which would be two
 * snapshots of one type in one run with nothing to say which readers should get.
 * This template refuses that up front rather than letting the canvas report it,
 * because at the point of choosing it is a typo and after applying it is a graph
 * to unpick.
 *
 * **A transform per branch, not one shared transform.** A node with two outbound
 * edges is read by both successors, so a single transform feeding two sinks
 * would commit identical wide rows into both types. The narrowing has to happen
 * per branch, which is what makes this a fan-*out* rather than a duplication.
 */
export function fanOutTypes(options: FanOutOptions): TemplateOutcome {
  const refusals: TemplateRefusal[] = [];
  const targets = options.targets.filter((target) => target.targetType.trim().length > 0);

  if (targets.length < 2) {
    refusals.push({
      code: 'incomplete',
      subjects: [],
      message:
        'This template needs at least two object types. With one type it is a plain source-to-sink graph, and "Replicate a table" is that graph with a check this one cannot make.',
    });
  }

  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const target of targets) {
    const name = target.targetType.trim();
    if (seen.has(name)) duplicated.add(name);
    seen.add(name);
  }
  if (duplicated.size > 0) {
    refusals.push({
      code: 'duplicate-target-type',
      subjects: [...duplicated],
      message: `Two branches both commit ${[...duplicated].map((name) => JSON.stringify(name)).join(', ')}. Two snapshots of one type in a single run leaves nothing to say which one readers should get, so the graph would be refused — send them to different types, or narrow them in one branch instead of two.`,
    });
  }

  for (const target of targets) {
    const refusal = refuseUnusableColumnNames(target.properties, {
      what: `the properties of ${target.targetType.trim()}`,
      remedy:
        "A property name is cleaned into the column a store creates for it, and what the cleaning produces has to be an identifier — so publishing refuses this one. Rename it in the type, and record the source spelling in that property's `columnName`. This branch already has a transform on it, so make that transform emit the new key too.",
    });
    if (refusal) refusals.push(refusal);
  }

  if (refusals.length > 0) return { ok: false, refusals };

  const source = NODE_FACTORIES.source(nodeId('source', 'shared', 1), 'Shared read', {
    sourceKind: options.sourceKind,
    config: placeholderConfig(options.sourceKind),
    ...(options.connectionId ? { connectionId: options.connectionId } : {}),
    mode: 'full',
  });

  const nodes: WorkflowNode[] = [source];
  const edges: WorkflowEdge[] = [];
  const transforms: TemplateTransformRequest[] = [];

  targets.forEach((target, index) => {
    const typeName = target.targetType.trim();
    const transform = NODE_FACTORIES.transform(
      nodeId('transform', typeName, index + 1),
      `Narrow to ${typeName}`,
      { transformId: '' },
    );
    const sink = NODE_FACTORIES.sink(nodeId('sink', typeName, index + 1), typeName, {
      targetType: typeName,
      mode: 'full',
    });
    nodes.push(transform, sink);
    edges.push({ from: source.id, to: transform.id }, { from: transform.id, to: sink.id });
    transforms.push({
      forNodeId: transform.id,
      name: `Narrow to ${typeName}`,
      language: options.language,
      code: PROJECT_CODE[options.language](typeName, target.properties),
      why: `Keeps only the columns ${typeName} commits, out of the rows every branch of this graph shares.`,
    });
  });

  return {
    ok: true,
    plan: {
      templateId: 'fan-out-types',
      name:
        options.workflowName?.trim() ||
        `Split into ${targets.map((t) => t.targetType.trim()).join(', ')}`,
      description: `Reads once and derives ${targets.length} types from the same rows.`,
      nodes,
      edges,
      transforms,
      expectations: [],
      declarations: [
        FULL_MODE_DECLARATION,
        {
          what: 'Each type gets its own transform, rather than sharing one.',
          why: 'Both successors of the source read the same rows, so one shared transform would commit identical wide rows into every type. Narrowing per branch is what makes this a fan-out and not a duplication.',
          changeAt: 'The code on each transform node, in the editor.',
        },
        {
          what: 'Each sink commits independently.',
          why: 'There is no distributed transaction across sinks and the model does not pretend otherwise: a run that commits one type and fails on another is a failed run that has nonetheless written something. That is the price of the single read, and it is the same thing two separate connectors would do today.',
          changeAt: 'Split into one workflow per type if a partial commit is unacceptable.',
        },
      ],
      todo: [
        configTodo(options.sourceKind, source.name),
        `${transforms.length} transforms have to be created before this graph will run — their nodes name no code until they exist.`,
        'Check each projection against what the type actually publishes: a property name in the list that the type does not have writes a column nobody reads, and one the type has that is missing from the list is committed as null.',
      ],
    },
  };
}

/* --- 4 & 5. Join, and enrich ----------------------------------------------- */

export interface JoinOptions {
  targetType: string;
  language: TransformLanguage;
  /** A field only the left-hand side carries. How the batch is split. */
  discriminator: string;
  /** The field on each side the join matches on. */
  leftKey: string;
  rightKey: string;
  leftSourceKind: ConnectorKind;
  rightSourceKind: ConnectorKind;
  leftName?: string;
  rightName?: string;
  workflowName?: string;
}

export type EnrichOptions = JoinOptions;

/**
 * Two reads into one type, joined inside the transform.
 *
 * Expressible only because the transform contract is set-wise: the code is a
 * function over a whole batch precisely so that it can deduplicate, aggregate
 * and join, none of which can be done a row at a time.
 *
 * **The decision this template exists to make is what the batch looks like.** A
 * node with several inbound edges receives its inputs *concatenated in edge
 * order, in one array, with nothing marking which record came from which side*.
 * The natural assumption is two arrays or two arguments, and code written under
 * that assumption silently processes the wrong half. So the starter body
 * partitions the batch explicitly, with the reason in a comment directly above
 * the loop, and the template asks for the discriminator up front rather than
 * leaving somebody to discover the problem from a result that is merely odd.
 *
 * Edge order is not decoration: it is what decides which side is left, and it is
 * part of the graph fingerprint, so swapping the two inputs is a new version of
 * the graph. The left source is added first, deliberately and stably.
 */
export function joinSources(options: JoinOptions): TemplateOutcome {
  return buildJoin(options, 'join-sources');
}

/**
 * A feed plus a dictionary, where a row the dictionary has not heard of
 * survives.
 *
 * The same graph and the same code as {@link joinSources} with one flag flipped,
 * and it is a separate template because that flag is the decision. Enriching
 * against a lookup and joining two feeds look identical on a canvas and differ
 * entirely in what happens to a record with no counterpart: dropping unmatched
 * rows from an enrichment means a load silently loses every record whose key the
 * dictionary has not caught up with yet — a load that succeeds, reports a
 * plausible row count, and is missing data. That is the same shape of failure as
 * the null columns, and it is the reason the two are offered as two choices
 * rather than one template with a checkbox nobody reads.
 *
 * Concretely useful here: this deployment has a `unit_dictionary` type and a
 * unit-normalisation problem it was built for.
 */
export function enrichWithLookup(options: EnrichOptions): TemplateOutcome {
  return buildJoin(options, 'enrich-with-lookup');
}

/**
 * The fields a join cannot be built without, in the words the refusal uses.
 *
 * Split out so that adding a field is one line in one list rather than another
 * branch in a function that is already deciding four other things — and so that
 * the refusal names *every* blank field at once. A form that reports its
 * required fields one round trip at a time is a form people abandon.
 */
function missingJoinFields(options: JoinOptions): string[] {
  const required: Array<[value: string, described: string]> = [
    [options.targetType, 'the object type the sink commits'],
    [options.discriminator, 'the field that tells the two sides apart'],
    [options.leftKey, 'the key on the left-hand side'],
    [options.rightKey, 'the key on the right-hand side'],
  ];
  return required.filter(([value]) => value.trim().length === 0).map(([, described]) => described);
}

function buildJoin(
  options: JoinOptions,
  templateId: Extract<WorkflowTemplateId, 'join-sources' | 'enrich-with-lookup'>,
): TemplateOutcome {
  const enriching = templateId === 'enrich-with-lookup';
  const targetType = options.targetType.trim();
  const missing = missingJoinFields(options);

  if (missing.length > 0) {
    return {
      ok: false,
      refusals: [
        {
          code: 'incomplete',
          subjects: missing,
          message: `This template still needs ${missing.join(', ')}. The discriminator especially is not optional: the runner hands both inputs to the transform as one concatenated array with nothing marking which side a record came from, so without a field that only one side carries there is no way for the code to tell them apart — and code that guesses produces a plausible result from the wrong half of the data.`,
        },
      ],
    };
  }

  const leftName = options.leftName?.trim() || (enriching ? 'Main feed' : 'Left source');
  const rightName = options.rightName?.trim() || (enriching ? 'Lookup' : 'Right source');

  const left = NODE_FACTORIES.source(nodeId('source', 'left', 1), leftName, {
    sourceKind: options.leftSourceKind,
    config: placeholderConfig(options.leftSourceKind),
    mode: 'full',
  });
  const right = NODE_FACTORIES.source(nodeId('source', 'right', 2), rightName, {
    sourceKind: options.rightSourceKind,
    config: placeholderConfig(options.rightSourceKind),
    mode: 'full',
  });
  const transform = NODE_FACTORIES.transform(
    nodeId('transform', targetType, 1),
    enriching ? `Enrich ${targetType}` : `Join into ${targetType}`,
    { transformId: '' },
  );
  const sink = NODE_FACTORIES.sink(nodeId('sink', targetType, 1), targetType, {
    targetType,
    mode: 'full',
  });

  const code = JOIN_CODE[options.language]({
    discriminator: options.discriminator.trim(),
    leftKey: options.leftKey.trim(),
    rightKey: options.rightKey.trim(),
    keepUnmatched: enriching,
  });

  return {
    ok: true,
    plan: {
      templateId,
      name:
        options.workflowName?.trim() ||
        (enriching ? `Enrich ${targetType}` : `Join into ${targetType}`),
      description: enriching
        ? `Reads ${leftName} and ${rightName}, fills each row in from the lookup, and commits ${targetType}.`
        : `Reads ${leftName} and ${rightName}, joins them on a key, and commits ${targetType}.`,
      nodes: [left, right, transform, sink],
      // Left first. Edge order decides which side is which and is part of the
      // graph fingerprint, so this ordering is load-bearing rather than tidy.
      edges: [
        { from: left.id, to: transform.id },
        { from: right.id, to: transform.id },
        { from: transform.id, to: sink.id },
      ],
      transforms: [
        {
          forNodeId: transform.id,
          name: enriching ? `Enrich ${targetType}` : `Join into ${targetType}`,
          language: options.language,
          code,
          why: enriching
            ? `Splits the concatenated batch, indexes ${rightName} by \`${options.rightKey.trim()}\`, and fills in each ${leftName} row. A row with no match is kept.`
            : `Splits the concatenated batch, indexes ${rightName} by \`${options.rightKey.trim()}\`, and joins. A row with no match is dropped.`,
        },
      ],
      expectations: [],
      declarations: [
        FULL_MODE_DECLARATION,
        {
          what: `Both inputs are read into one batch and told apart by \`${options.discriminator.trim()}\`.`,
          why: 'A transform node receives its inbound edges concatenated in edge order, in one array, with nothing marking the origin of a record. That is what makes a join possible at all — the code can see everything at once — but it means the split has to be written explicitly, and a discriminator chosen by somebody who knows both shapes is the only reliable way to do it.',
          changeAt: 'The partition at the top of the transform body.',
        },
        enriching
          ? {
              what: 'A row whose key is not in the lookup is kept, unenriched.',
              why: 'Dropping it would mean the load silently loses every record the dictionary has not caught up with — a run that succeeds, reports a plausible count and is quietly missing data. If an unmatched row genuinely is not a record of this type, use "Join two sources" instead, which drops it and says so.',
              changeAt: 'The `if (!found)` branch in the transform body.',
            }
          : {
              what: 'A row whose key has no counterpart is dropped.',
              why: 'A record with nothing on the other side is not a record of the joined thing. If it is — if the right-hand side is a dictionary rather than a second feed — use "Enrich against a lookup table" instead, which keeps it.',
              changeAt: 'The `if (!found)` branch in the transform body.',
            },
        {
          what: 'The left record wins where both sides carry the same field.',
          why: 'The left side is the record the row is about; the other side is filling in what it did not know. The reverse would let a stale dictionary overwrite live values, which is unrecoverable once committed.',
          changeAt: 'The spread order on the last line of the transform body.',
        },
      ],
      todo: [
        configTodo(options.leftSourceKind, left.name),
        configTodo(options.rightSourceKind, right.name),
        'The transform has to be created before this graph will run — its node names no code until it exists.',
        `Both sides are held in memory at once while the transform runs. That is inherent to a set-wise contract, but it means ${rightName} wants to be the smaller of the two.`,
      ],
    },
  };
}

/* --- 6. Periodic full reload ----------------------------------------------- */

export interface PeriodicFullReloadOptions {
  targetType: string;
  sourceKind: ConnectorKind;
  cadence: ReloadCadence;
  /** Why this cadence reconciles deletes acceptably. Required, and not by accident. */
  because: string;
  sourceColumns?: readonly string[];
  connectionId?: string;
  workflowName?: string;
}

/**
 * A full read on a schedule, with the reconciliation it implies declared from
 * the same input.
 *
 * The template most worth having, because the two things it produces are the two
 * that must agree and that nothing currently links. A `periodic-full-reload`
 * strategy says deletions reach this type because it is fully reloaded every
 * `withinMs`; a schedule says how often it is actually reloaded. An operator
 * sets one on the Model screen and the other on the connector, and nothing
 * anywhere notices when they drift apart — at which point the type carries a
 * declaration that reads as a guarantee and polices nothing.
 *
 * Here they come from one {@link RELOAD_CADENCES} entry, so they cannot
 * disagree, and `withinMs` gets its slack from {@link withinMsFor} rather than
 * from whatever somebody typed.
 *
 * **`because` is required and is not decoration.** `refuseUndeclaredDeletes`
 * rejects a declaration whose reason is blank, on every strategy, because the
 * control was never "it must be in code" — it is that somebody chose a strategy
 * and wrote down why. A template that supplied a default reason would be
 * defeating exactly the mechanism it is here to satisfy.
 *
 * **Where the schedule goes, and why the plan does not say.** The plan carries
 * the cadence as data — {@link TemplatePlan.schedule} — and leaves *placing* it
 * to whatever applies the plan. That was a deliberate bet, and it paid.
 *
 * When this was written, a workflow was put on a timer by a connector that
 * pointed at it with `workflowId` and carried the `schedule` string. A template
 * that had written that hop into its plan or its `todo` would have had to be
 * rewritten when the workflow became the only authored object: connectors stopped
 * being authored at all, and a schedule now lives on the workflow, set through
 * `PUT workflows/:id/schedule`. Because the plan only ever declared "this runs
 * `0 2 * * *`" and never "create a connector that says so", the move cost this
 * template nothing — the same plan, rebased with no conflict, describes the new
 * arrangement as accurately as it described the old one.
 *
 * What did not change, and is the part worth stating: only a `ready` graph is
 * scheduled. A schedule written against a draft is stored and does not fire.
 */
export function periodicFullReload(options: PeriodicFullReloadOptions): TemplateOutcome {
  const targetType = options.targetType.trim();
  const because = options.because.trim();
  const missing: string[] = [];
  if (targetType.length === 0) missing.push('the object type the sink commits');
  if (because.length === 0) missing.push('a reason this cadence reconciles deletes acceptably');

  if (missing.length > 0) {
    return {
      ok: false,
      refusals: [
        {
          code: 'incomplete',
          subjects: missing,
          message: `This template still needs ${missing.join(' and ')}. The reason is not optional and is not rhetorical: a delete-reconciliation declaration with a blank reason is refused by the pipeline on every strategy, because what makes the declaration worth anything is that somebody chose it and wrote down why. Supplying a default here would defeat the mechanism this template exists to satisfy.`,
        },
      ],
    };
  }

  const refusal = refuseUnusableColumnNames(options.sourceColumns, {
    what: 'the source',
    remedy: RENAME_REMEDY,
  });
  if (refusal) return { ok: false, refusals: [refusal] };

  const schedule: TemplateSchedule = RELOAD_CADENCES[options.cadence];
  const withinMs = withinMsFor(options.cadence);

  const source = NODE_FACTORIES.source(nodeId('source', targetType, 1), `${targetType} full read`, {
    sourceKind: options.sourceKind,
    config: placeholderConfig(options.sourceKind),
    ...(options.connectionId ? { connectionId: options.connectionId } : {}),
    mode: 'full',
  });
  const sink = NODE_FACTORIES.sink(nodeId('sink', targetType, 1), targetType, {
    targetType,
    mode: 'full',
  });

  const deletes: DeleteReconciliation = {
    strategy: 'periodic-full-reload',
    because,
    withinMs,
  };

  return {
    ok: true,
    plan: {
      templateId: 'periodic-full-reload',
      name: options.workflowName?.trim() || `Reload ${targetType} ${schedule.human}`,
      description: `Reads ${targetType} whole ${schedule.human} and commits it, reconciling deletes by replacement.`,
      nodes: [source, sink],
      edges: [{ from: source.id, to: sink.id }],
      transforms: [],
      expectations: [
        {
          typeName: targetType,
          input: { deletes },
          why: `Declares that deletions reach ${targetType} by full replacement within ${withinMs}ms, which is twice the ${schedule.human} cadence this same template set.`,
        },
      ],
      schedule,
      declarations: [
        {
          what: `The schedule is \`${schedule.cron}\` and the reconciliation interval is ${withinMs}ms. Both come from one choice.`,
          why: 'A `withinMs` is only honest if the schedule really does reload that often — once the newest full load of a type is older than it, incremental loads of that type stop committing. Set separately, the two drift and the declaration becomes a sentence that polices nothing. Derived from one cadence, they cannot.',
          changeAt:
            'Re-apply with a different cadence, or edit the schedule and the expectation together.',
        },
        {
          what: 'The interval is twice the cadence rather than equal to it.',
          why: 'At exactly the cadence, any run that starts a minute late — or simply takes a few minutes, since the age is measured from the snapshot — makes the type stale and blocks loads of it. A guard that fires on an ordinary Tuesday is a guard somebody switches off, taking the real failure with it. Twice tolerates one missed cycle and refuses the second, and covers the hour a DST boundary moves.',
          changeAt: "The type's load expectation, on the Model screen.",
        },
        {
          what: 'The graph reads and commits in `full` mode, and that is the point rather than a stepping stone.',
          why: 'This is the mode the reconciliation strategy describes. An incremental read here would be blind to deletes, which is the exact hole the declaration is claiming to have closed — and where the upstream ingest deletes and reinserts per base, every row gets a fresh timestamp in one batch anyway, so an incremental read returns the whole table while still missing the deletions.',
          changeAt: 'The `mode` field on the source node and on the sink node.',
        },
      ],
      todo: [
        configTodo(options.sourceKind, source.name),
        `The schedule is part of this plan but is not part of the graph: send \`${schedule.cron}\` to \`PUT workflows/:id/schedule\` once the workflow exists, and publish it first — a schedule on a draft is stored and never fires.`,
        `The expectation is a separate write against \`${targetType}\`. Applying the graph without it leaves the type undeclared, which is the state this template exists to avoid.`,
      ],
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Applying a plan                                                             */
/* -------------------------------------------------------------------------- */

export type TemplateRequest =
  | { templateId: 'replicate-table'; options: ReplicateTableOptions }
  | { templateId: 'load-file-drop'; options: FileDropOptions }
  | { templateId: 'fan-out-types'; options: FanOutOptions }
  | { templateId: 'join-sources'; options: JoinOptions }
  | { templateId: 'enrich-with-lookup'; options: EnrichOptions }
  | { templateId: 'periodic-full-reload'; options: PeriodicFullReloadOptions };

/**
 * Build whichever template was asked for, with the options that template needs.
 *
 * A discriminated request rather than one options bag with everything optional,
 * so asking for a join without a discriminator is a type error at the call site
 * instead of a refusal at run time. The refusals still exist because a form
 * hands over strings a user typed, and an empty string satisfies `string`.
 */
export function buildWorkflowTemplate(request: TemplateRequest): TemplateOutcome {
  switch (request.templateId) {
    case 'replicate-table':
      return replicateTable(request.options);
    case 'load-file-drop':
      return loadFileDrop(request.options);
    case 'fan-out-types':
      return fanOutTypes(request.options);
    case 'join-sources':
      return joinSources(request.options);
    case 'enrich-with-lookup':
      return enrichWithLookup(request.options);
    case 'periodic-full-reload':
      return periodicFullReload(request.options);
  }
}

/**
 * Point each transform node at the transform that was created for it.
 *
 * Separate from building the plan, and pure, because the ids do not exist until
 * a server has stored the code — a template cannot invent them and must not
 * pretend to. Until this has run, a plan carrying transforms is deliberately
 * **not** a valid graph: `validateWorkflow` reports `transform-not-named` for
 * every node with an empty `transformId`, which is the correct answer, because a
 * node pointing at no code cannot run. See {@link planIsRunnable}.
 *
 * Nodes whose id is absent from the map are left exactly as they were, so a
 * partial failure part-way through creating three transforms leaves a graph that
 * still says which node is unfinished rather than one that silently claims to be
 * complete.
 */
export function attachTransformIds(
  plan: TemplatePlan,
  transformIdByNodeId: ReadonlyMap<string, string>,
): TemplatePlan {
  return {
    ...plan,
    nodes: plan.nodes.map((node) => {
      if (node.kind !== 'transform') return node;
      const id = transformIdByNodeId.get(node.id);
      return id === undefined ? node : { ...node, transformId: id };
    }),
  };
}

/** The authored half of a plan, in the shape `saveWorkflow` takes. */
export function planToWorkflowInput(plan: TemplatePlan): {
  name: string;
  description: string;
  nodes: WorkflowNode[];
  edges: Array<{ from: string; to: string }>;
} {
  return {
    name: plan.name,
    description: plan.description,
    nodes: plan.nodes,
    edges: plan.edges.map((edge) => ({ from: edge.from, to: edge.to })),
  };
}

/**
 * Whether every transform node in the plan has been pointed at real code.
 *
 * The one question a screen has to ask between creating the transforms and
 * saving the graph. Named rather than left as an inline `.every`, because "the
 * plan is ready to save" and "the plan validates" are different questions and
 * conflating them is how a save gets attempted with an empty `transformId` and
 * comes back as a validation error about a field nobody typed.
 */
export function planIsRunnable(plan: TemplatePlan): boolean {
  return plan.nodes.every((node) => node.kind !== 'transform' || node.transformId.length > 0);
}
