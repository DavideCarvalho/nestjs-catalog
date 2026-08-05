/**
 * What a load has to be true of before it is allowed to become the data
 * everybody reads, and the functions that decide it.
 *
 * Two failures live here, and they are the same failure seen from two ends: a
 * load that is *fresh and wrong*. Every signal this catalog publishes about a
 * type — `lastCommittedAt`, the age badge on the Model screen, a green run in
 * the runs list — reports on whether a load HAPPENED. None of them reports on
 * whether what it loaded resembles the dataset it replaced, and a snapshot
 * commit is atomic, so the moment a wrong load commits it is indistinguishable
 * from a right one until somebody counts rows by hand.
 *
 * - **Deletes.** An incremental connector asks its source for what changed
 *   since a watermark. A row physically removed from the source never changes
 *   again, so it is never returned again, so `carryForward` copies it into
 *   every subsequent snapshot forever. The catalog does not go wrong at any
 *   point; it simply never finds out. See `DeleteReconciliation`.
 * - **Collapse.** A source-side filter change, a broken `WHERE`, a partial
 *   outage: the connector returns 12 rows where it returned 40,000, the
 *   snapshot commits, and the freshness signals all say healthy — correctly,
 *   because it IS fresh. See `RowCountBound`.
 *
 * **The shapes are in `@dudousxd/nestjs-catalog` and the decisions are here.**
 * `CatalogLoadExpectations`, `LoadExpectation`, `DeleteReconciliation` and
 * `RowCountBound` are declared in `catalog.pipeline.ts` beside
 * `CatalogConnector`, for the reason `CatalogConnector` itself is: a store
 * package depends on the catalog and must not depend on this one, and
 * `StoredLoadExpectation` is a row a store now holds. They are re-exported
 * below, so an import that named this file still names it. The functions did
 * not move — a store has no business deciding whether a load commits.
 *
 * **Why a policy about a type and not a column on the connector.** Both facts
 * are statements about a *type*, not about the reader of a source. "It is
 * acceptable that `Employee` accumulates rows deleted upstream" and "`Employee`
 * must never lose half its rows in one load" stay true whether the rows arrive
 * from a connector, from a workflow sink, or from an application POSTing to the
 * publish API — and all three of those paths end at the same two methods on
 * `PublishService`, which is where these are enforced. A per-connector field
 * would have covered one of the three and would have had to be checked in three
 * places to cover the rest.
 *
 * The second reason is who should be able to change it. Accepting that a
 * dataset silently accumulates deleted rows is not a checkbox decision; it is
 * the kind of thing that should appear with a reason attached and a name against
 * it — which is why `DeleteReconciliation` makes the reason a required field,
 * and why the stored layer records who set it. See
 * {@link resolveLoadExpectation} for how the layers combine.
 */
import type {
  CatalogLoadExpectations,
  CatalogPipelineStore,
  LoadExpectation,
  RowCountBound,
  SnapshotRef,
  StoredLoadExpectation,
} from '@dudousxd/nestjs-catalog';
import { supportsLoadExpectations } from '@dudousxd/nestjs-catalog';
import {
  DELETE_RECONCILIATION_STRATEGIES,
  type LoadExpectationInput,
  type ResolvedLoadExpectation,
  isDeleteReconciliationStrategy,
} from '@dudousxd/nestjs-catalog/client';
import { BadRequestException } from '@nestjs/common';

/*
 * Re-exported rather than moved out of every importer's sight. Fourteen files
 * across three packages name these from here, and a move that renames an import
 * in all of them is a diff nobody can read for the change it is actually making.
 * The provenance shape comes from the client entry point for the same reason it
 * is declared there: the Model screen renders it, and a browser cannot import
 * this package.
 */
export type {
  CatalogLoadExpectations,
  DeleteReconciliation,
  LoadExpectation,
  RowCountBound,
  StoredLoadExpectation,
} from '@dudousxd/nestjs-catalog';
export type {
  LoadExpectationInput,
  ResolvedLoadExpectation,
} from '@dudousxd/nestjs-catalog/client';

/**
 * The token a host binds to say all of the above.
 *
 * `@Optional()` everywhere it is injected, so a host that binds nothing still
 * boots — and then finds that its incremental loads are refused unless an
 * operator has stored an expectation for the type through the API, which is the
 * intended and documented outcome rather than an oversight. It is said out loud
 * at boot too, once: a host that bound nothing hears which token is missing and
 * what it costs, rather than meeting it as a refused load weeks later.
 *
 * **This layer is the strongest one and that is what it is for.** A type named
 * in {@link CatalogLoadExpectations.byType} cannot be overridden from the API:
 * an operator sees the value and is told this deployment fixed it in code. What
 * a host declares here it therefore owns, and what it leaves out an operator may
 * decide — see {@link resolveLoadExpectation}.
 *
 * Two ways to bind it, both supported and neither preferred. Pass a `Provider`
 * as `CatalogPipelineModule.forRoot({ expectations })` — the docblock on that
 * option is where the policy object itself is explained — or export the token
 * from a module passed in `forRoot({ imports })`, the way the store and the
 * registry arrive. A host that does both gets the one passed to `forRoot`,
 * which is Nest's ordinary precedence and not a rule this package invented.
 */
export const CATALOG_LOAD_EXPECTATIONS = Symbol('CATALOG_LOAD_EXPECTATIONS');

/**
 * What applies when nobody has said otherwise.
 *
 * `maxShrink: 0.5` is the argued number. The two failure modes of a default
 * here are opposite and both fatal: a bound that refuses real loads is switched
 * off within a week, and a bound of "never refuse" is a feature nobody turns
 * on. Half is where those meet for the datasets a catalog holds. A load that
 * legitimately halves a dataset happens — a fleet retirement, a de-duplication
 * fix — but it is *deliberate*, so somebody is watching it, and the cost of
 * being refused is one round trip. A broken `WHERE` at 03:00 is unattended, and
 * the cost of not being refused is a week of decisions made on a tenth of the
 * data.
 *
 * The looser candidate was 0.9 — "only catch a total collapse" — and it was
 * rejected because it also passes 40,000 rows arriving as 5,000, which is the
 * same bug with a less dramatic symptom and is exactly as wrong.
 *
 * `minRows: 100` is where a ratio starts meaning something. Below it the check
 * that still applies is the absolute one in {@link refuseRowCountDrift}: a load
 * of zero rows over a non-empty dataset is refused at any size.
 */
export const DEFAULT_ROW_COUNT_BOUND: RowCountBound = {
  maxShrink: 0.5,
  minRows: 100,
};

/**
 * The label a publisher sets on a snapshot to say a collapse is intended.
 *
 * The escape hatch for the case the bound cannot distinguish from a bug: a
 * deliberate truncation, a type being cut back to one base for a migration.
 * Set it in the `labels` of any batch of the load — `PublishService.appendRows`
 * passes them through to the snapshot — and the row-count bound stands down for
 * that snapshot only, which is the property that matters. Raising the bound in
 * the policy would stand it down for every load of that type until somebody
 * remembers to put it back.
 *
 * **A connector run reaches it through `ConnectorRunOptions.expectShrink`**,
 * which is a reason rather than a flag and is written here as the label's value,
 * so the snapshot itself answers why it was allowed to collapse. It is an
 * argument to one call and is stored nowhere, which is the only reliable way to
 * keep a one-time acknowledgement from becoming a standing one.
 *
 * **A scheduled run has no way to set it, deliberately.** `ConnectorRunSteps`
 * passes no options and `ConnectorRunStepInput` carries no field for them: the
 * run comes from a cron window with nobody watching, and an acknowledgement
 * that fires every night is the bound switched off in a costume. The route for
 * a refused scheduled load is to look at the source and re-run it by hand.
 *
 * What the value is checked for is only presence — `!== undefined` — so a load
 * arriving over the publish API with `"_expectShrink": ""` is still
 * acknowledged. That is the publish surface's business and it is where the
 * caller is another program; the connector path asks for a sentence because a
 * person is typing it.
 */
export const EXPECT_SHRINK_LABEL = '_expectShrink';

/**
 * The label a merging store writes on a snapshot it carried rows into.
 *
 * Read rather than written by this file, and it is a convention rather than a
 * contract: the bundled MySQL warehouse sets it (`_carriedFrom`, holding the
 * snapshot the rows came from) because it is genuinely provenance, and
 * `SnapshotRef.labels` is a public field, so it is legible to anybody. It is
 * the only way from here to tell an incremental snapshot from a full one, which
 * is what {@link refuseStaleReconciliation} needs to date the last
 * reconciliation.
 *
 * **A store that does not write it makes that one check permissive**, because
 * every snapshot then looks like a full reload and the clock never runs out.
 * The declaration requirement — the actual mechanism — is unaffected, and a
 * check that degraded to *refusing* on a store that merely records less would
 * be punishing the adapter rather than the data.
 */
export const CARRIED_FROM_LABEL = '_carriedFrom';

/**
 * The expectation for one type from the host object alone.
 *
 * Kept, unchanged in signature and in answer, because it is what a caller with
 * no store in hand asks — and because it is exactly {@link mergeLoadExpectation}
 * with the middle layer empty, which is how it is now implemented rather than
 * how it is merely described. Two copies of a precedence rule is two answers to
 * one question the first time somebody edits one of them.
 */
export function expectationFor(
  policy: CatalogLoadExpectations | undefined,
  typeName: string,
): LoadExpectation {
  return mergeLoadExpectation(policy, undefined, typeName).resolved;
}

/** The bound for one type, over the default, over {@link DEFAULT_ROW_COUNT_BOUND}. */
export function rowCountBoundFor(
  policy: CatalogLoadExpectations | undefined,
  typeName: string,
): RowCountBound {
  return rowCountBoundOf(expectationFor(policy, typeName));
}

/** The bound an already-resolved expectation means, over {@link DEFAULT_ROW_COUNT_BOUND}. */
export function rowCountBoundOf(expectation: LoadExpectation): RowCountBound {
  return { ...DEFAULT_ROW_COUNT_BOUND, ...expectation.rowCount };
}

/**
 * The three layers, merged field by field, strongest first:
 *
 * ```
 * host.byType[typeName]   >   the stored row   >   host.default
 * ```
 *
 * **Pure and synchronous, and it is the only thing that decides precedence.**
 * The layer above it fetches the stored row; the layers below it — the four
 * `refuse*` functions — take the answer and never look anything up. That split
 * is deliberate and is what keeps the rules testable against three plain
 * objects rather than against a store nobody wants to fake.
 *
 * **Why the host's own entry wins over an operator's.** That is what lets a
 * deployment lock a type down: a type somebody put in code is a type somebody
 * argued about, and an API that could quietly overrule it would make the code
 * a suggestion. Where the host is silent the operator decides, which is the
 * whole point of the stored layer — creating a connector and running it
 * incrementally should not need an engineer and a deploy.
 *
 * **`host.default` is the weakest, deliberately.** It is a house-wide statement
 * about types nobody has looked at, and a house-wide statement that beat a
 * specific decision would mean the more somebody knew about a type the less
 * their answer counted.
 *
 * `rowCount` merges key by key across all three, which is the merge
 * {@link expectationFor} already did between two: a host that sets one
 * house-wide `minRows` and an operator who raises `maxShrink` for one type both
 * get what they asked for. {@link ResolvedLoadExpectation.rowCountFrom} then
 * names the strongest layer that set anything, because a per-key provenance is
 * three more fields on a screen answering a question nobody asks.
 */
export function mergeLoadExpectation(
  host: CatalogLoadExpectations | undefined,
  stored: StoredLoadExpectation | undefined,
  typeName: string,
): ResolvedLoadExpectation {
  const specific = host?.byType?.[typeName];
  const fallback = host?.default;

  const deletes = specific?.deletes ?? stored?.deletes ?? fallback?.deletes;
  const rowCount = { ...fallback?.rowCount, ...stored?.rowCount, ...specific?.rowCount };

  return {
    typeName,
    resolved: { deletes, rowCount },
    deletesFrom: specific?.deletes
      ? 'host'
      : stored?.deletes
        ? 'stored'
        : fallback?.deletes
          ? 'default'
          : 'none',
    rowCountFrom: statesRowCount(specific?.rowCount)
      ? 'host'
      : statesRowCount(stored?.rowCount)
        ? 'stored'
        : 'default',
    stored,
    hostLocked: hostLockedFields(host, typeName),
  };
}

/**
 * Which fields of a type this deployment has declared in code, per field.
 *
 * True means a stored value for that field can never apply. **Only `byType`
 * counts**: `host.default` is the weakest layer and an operator's row beats it,
 * so drawing a house-wide default as a lock would tell somebody an edit was
 * impossible when it would have worked.
 */
export function hostLockedFields(
  host: CatalogLoadExpectations | undefined,
  typeName: string,
): { deletes: boolean; rowCount: boolean } {
  const specific = host?.byType?.[typeName];
  return {
    deletes: specific?.deletes !== undefined,
    rowCount: statesRowCount(specific?.rowCount),
  };
}

/**
 * The expectation for one type across every layer, stored row included.
 *
 * The async half, and the only async thing in this file. A store that does not
 * implement the optional load-expectation members has no stored layer, and that
 * is not a degraded mode — it is exactly the behaviour of every deployment
 * before this existed, host object only. `supportsLoadExpectations` is how that
 * is asked, rather than a `try`/`catch` around a method that may not be there:
 * a probe answers "this deployment cannot store these" once, and a screen can
 * say it.
 *
 * A store that throws is left to throw. The alternative — swallowing it and
 * resolving from the host alone — would silently drop the layer that makes an
 * incremental load legal, so a database blip would show up as a refused load
 * blaming a missing declaration that is sitting in the table.
 */
export async function resolveLoadExpectation(
  host: CatalogLoadExpectations | undefined,
  store: CatalogPipelineStore | undefined,
  typeName: string,
): Promise<ResolvedLoadExpectation> {
  return mergeLoadExpectation(host, await storedExpectationFor(store, typeName), typeName);
}

/** The operator's row for a type, or nothing when this store does not keep them. */
export async function storedExpectationFor(
  store: CatalogPipelineStore | undefined,
  typeName: string,
): Promise<StoredLoadExpectation | undefined> {
  if (!store || !supportsLoadExpectations(store)) return undefined;
  return store.getLoadExpectation(typeName);
}

/** Whether a partial bound says anything at all. `{}` is not a statement. */
function statesRowCount(bound: Partial<RowCountBound> | undefined): boolean {
  if (!bound) return false;
  return Object.values(bound).some((value) => value !== undefined);
}

/**
 * Which fields of a write the host has already declared in code.
 *
 * Only `byType` counts. `host.default` is the weakest layer and an operator's
 * row beats it, so refusing a write because a house-wide default exists would
 * refuse every write on a host that set one — see {@link mergeLoadExpectation}.
 *
 * Returned as the list of field names rather than a boolean because the refusal
 * has to say WHICH field is owned: a form that sent both and was told only
 * "locked" cannot tell the operator which half of their edit would have taken.
 */
export function hostOwnedFields(
  host: CatalogLoadExpectations | undefined,
  typeName: string,
  input: LoadExpectationInput,
): Array<'deletes' | 'rowCount'> {
  const locked = hostLockedFields(host, typeName);
  const owned: Array<'deletes' | 'rowCount'> = [];
  if (input.deletes !== undefined && locked.deletes) owned.push('deletes');
  if (input.rowCount !== undefined && locked.rowCount) owned.push('rowCount');
  return owned;
}

/**
 * Refuse a stored expectation that could never be honoured, naming the field.
 *
 * Checked at the write rather than only at the load, and the two are not the
 * same check even where they overlap. {@link refuseUndeclaredDeletes} answers
 * "may this load proceed" for whatever is in force at 03:00; this answers "is
 * what you are typing a thing at all", to somebody who is looking at a form and
 * can fix it. A row that stored `withinMs: 0` would pass the write, sit on the
 * screen looking like a policy, and refuse every incremental load of the type
 * for a reason the editor never mentioned.
 *
 * `unknown` in, because this arrives off the wire: `strategy` is a string until
 * something checks it, and the union in the type system binds only callers that
 * compile. The empty `because` is refused as hard as an absent one, for the
 * reason `refuseUndeclaredDeletes` gives — a reason field that may be blank is a
 * reason field that is blank.
 */
export function refuseInvalidLoadExpectation(input: {
  deletes?: unknown;
  rowCount?: unknown;
}): string | undefined {
  if (input.deletes !== undefined) {
    const refusal = refuseInvalidDeletes(input.deletes);
    if (refusal) return refusal;
  }
  if (input.rowCount !== undefined) return refuseInvalidRowCount(input.rowCount);
  return undefined;
}

/** The delete half of {@link refuseInvalidLoadExpectation}. */
function refuseInvalidDeletes(deletes: unknown): string | undefined {
  if (typeof deletes !== 'object' || deletes === null) {
    return '`deletes` must be an object naming a strategy and the reason for it.';
  }
  const strategy = Reflect.get(deletes, 'strategy');
  if (!isDeleteReconciliationStrategy(strategy)) {
    return `"${String(strategy)}" is not a delete strategy. Accepted: ${DELETE_RECONCILIATION_STRATEGIES.join(', ')}. There is deliberately no fourth — a strategy nothing implements would be a dropdown with a lie in it.`;
  }
  const because = Reflect.get(deletes, 'because');
  if (typeof because !== 'string' || because.trim().length === 0) {
    return '`deletes.because` is required and may not be blank. It is the only part of this decision that is still legible in six months, when somebody is asking why the count does not match the source.';
  }
  if (strategy !== 'periodic-full-reload') return undefined;
  const withinMs = Reflect.get(deletes, 'withinMs');
  if (typeof withinMs !== 'number' || !(withinMs > 0)) {
    return '`deletes.withinMs` must be a positive number of milliseconds. Reconciling by periodic full reload with no interval polices nothing: the last full read can never be too old.';
  }
  return undefined;
}

/** The row-count half of {@link refuseInvalidLoadExpectation}. */
function refuseInvalidRowCount(rowCount: unknown): string | undefined {
  if (typeof rowCount !== 'object' || rowCount === null) {
    return '`rowCount` must be an object.';
  }
  const maxShrink = Reflect.get(rowCount, 'maxShrink');
  if (maxShrink !== undefined && !isRatio(maxShrink, 0, 1)) {
    return '`rowCount.maxShrink` is the fraction of the served snapshot a load may lose, so it must be above 0 and at most 1. Zero would refuse every load that lost a single row; above 1 is a bound no load can cross, which is the bound switched off wearing a number.';
  }
  const maxGrowth = Reflect.get(rowCount, 'maxGrowth');
  if (maxGrowth !== undefined && !isRatio(maxGrowth, 1, Number.POSITIVE_INFINITY)) {
    return '`rowCount.maxGrowth` is a ratio against the served snapshot, so it must be above 1. At 1 or below every load that grew at all — which is most of them — would be refused.';
  }
  const minRows = Reflect.get(rowCount, 'minRows');
  if (minRows !== undefined && (typeof minRows !== 'number' || !(minRows >= 0))) {
    return '`rowCount.minRows` is the size below which no ratio applies, so it cannot be negative.';
  }
  return undefined;
}

/** A number in `(above, orBelow]`. `NaN` fails every comparison, which is the intent. */
function isRatio(value: unknown, above: number, orBelow: number): boolean {
  return typeof value === 'number' && value > above && value <= orBelow;
}

/**
 * Refuse an incremental load of a type nobody has said anything about.
 *
 * **This is the mechanism**, and everything else in this file about deletes is
 * decoration on it. An incremental load is delete-blind by construction; the
 * only question is whether somebody knows. The answer this asks for is cheap to
 * give and impossible to give by accident, which is the correct shape for a
 * question whose wrong answer is silent.
 *
 * Returns the sentence to refuse with, or nothing when the load may proceed.
 * A `string | undefined` rather than a thrown error because the same decision
 * is made in two places at two different costs — before a connector fetches
 * anything, and again at the merge for every other path into it — and the
 * caller chooses what kind of failure that is.
 *
 * The empty `because` is refused as hard as an absent strategy. A reason field
 * that may be blank is a reason field that is blank.
 */
export function refuseUndeclaredDeletes(
  typeName: string,
  expectation: LoadExpectation,
): string | undefined {
  const deletes = expectation.deletes;
  if (!deletes) {
    return `${typeName} is being loaded incrementally and nothing says how rows deleted at the source reach it. An incremental read asks for what changed since a watermark, and a row that was deleted never changes again — so it is never returned again, and every later snapshot carries it forward indefinitely. Declare a strategy for ${typeName} under CATALOG_LOAD_EXPECTATIONS: "accepted" if this source never deletes or stale rows are tolerable, "soft-deleted-at-source" if deletions arrive as changes the watermark can see, or "periodic-full-reload" with the interval between full reads. Or run this connector in "full" mode, which has the problem by definition.`;
  }
  if (deletes.because.trim().length === 0) {
    return `${typeName} declares "${deletes.strategy}" for deleted rows with no reason attached. The reason is required because it is the only part of this decision that is still legible in six months, when somebody is asking why the count does not match the source.`;
  }
  if (deletes.strategy === 'periodic-full-reload' && !(deletes.withinMs > 0)) {
    return `${typeName} reconciles deletes by periodic full reload but names no interval, so nothing would ever be out of date and the strategy would police nothing. Set withinMs to how long ${typeName} may go between full reads.`;
  }
  return undefined;
}

/**
 * Refuse an incremental load of a type whose last full read is too old.
 *
 * The half that makes `periodic-full-reload` a mechanism rather than a note.
 * Once the newest full snapshot is older than the declared interval, every
 * incremental load of the type stops committing — so the interval is visible
 * in the only way an interval ever is, which is by running out.
 *
 * A full snapshot is one whose labels do not carry {@link CARRIED_FROM_LABEL}.
 * Two known imprecisions, both stated where they can be read rather than
 * discovered: a store that does not write the label makes every snapshot look
 * full and this check permissive, and a full load that was written and never
 * committed still resets the clock — it is dated by `createdAt`, and
 * `SnapshotRef` does not carry whether it committed.
 *
 * `snapshots` is whatever the store reports, newest first is not assumed. When
 * it contains no full snapshot at all the load is refused, because the truthful
 * statement is "the last reconciliation is at least as old as everything this
 * store can still see", and that is worse than the interval rather than better.
 *
 * **Dated by the parsed instant, never by comparing the two strings.**
 * `createdAt` is a string on the wire, and two of them sort chronologically
 * only while every store writes the same UTC ISO-8601 shape — which this cannot
 * check and which did not hold. A timestamp this cannot read at all was the
 * expensive case: `"unknown"`, or anything else beginning past a digit, sorted
 * above every real timestamp, won the comparison for newest, and produced a
 * `NaN` age that no `>` is ever true of. One unreadable row in a list whose
 * other rows could have dated the type perfectly well switched the check off,
 * and nothing said so. An offset other than `Z` was the cheaper case, wrong in
 * the safe direction: it mis-ordered by up to a day and refused slightly more
 * than it should.
 */
export function refuseStaleReconciliation(
  typeName: string,
  expectation: LoadExpectation,
  snapshots: readonly SnapshotRef[],
  now: number,
): string | undefined {
  const deletes = expectation.deletes;
  if (deletes?.strategy !== 'periodic-full-reload') return undefined;
  if (!(deletes.withinMs > 0)) return undefined;

  const full = snapshots.filter((snapshot) => snapshot.labels?.[CARRIED_FROM_LABEL] === undefined);
  if (full.length === 0) {
    // Nothing to date it by. Refusing on an empty list would also refuse the
    // very first load of a type, which has no snapshots at all and cannot
    // possibly have reconciled — so an empty list means "no history yet" and is
    // left to `carryForward`, which handles that case by definition.
    if (snapshots.length === 0) return undefined;
    return `${typeName} reconciles deletes by a full reload every ${describeInterval(deletes.withinMs)}, and none of the ${snapshots.length} snapshots this store still reports is one. The last full read is therefore at least as old as the oldest of them, so this incremental load is refused rather than carrying forward rows that may have been deleted upstream months ago. Run this connector in "full" mode once.`;
  }

  // Parsed once, and the unreadable ones dropped BEFORE the newest is chosen
  // rather than after — see the docblock. Choosing first and parsing second is
  // what let a single `createdAt` this cannot read decide the answer for the
  // whole list.
  const dated = full
    .map((snapshot) => ({ snapshot, at: Date.parse(snapshot.createdAt) }))
    .filter((candidate) => Number.isFinite(candidate.at));

  // Full snapshots exist and not one of them carries a timestamp this can read.
  // Admitted, on the same reasoning as {@link CARRIED_FROM_LABEL}: a check that
  // refused because the store recorded less than the bundled one would be
  // punishing the adapter rather than the data, and there is nothing here to
  // refuse ON — every comparison available is against `NaN`. This is narrower
  // than the branch it replaces, which needed only ONE unreadable timestamp
  // anywhere in the list to reach the same silence.
  if (dated.length === 0) return undefined;

  const newest = dated.reduce((left, right) => (left.at >= right.at ? left : right));
  const age = now - newest.at;
  if (!(age > deletes.withinMs)) return undefined;

  return `${typeName} reconciles deletes by a full reload every ${describeInterval(deletes.withinMs)}, and the last one — snapshot ${newest.snapshot.id} — was ${describeInterval(age)} ago. Every incremental load since then has carried forward rows that may no longer exist at the source, so this one is refused. Run this connector in "full" mode, then resume.`;
}

/**
 * Refuse a snapshot that is too far from the one it would replace.
 *
 * Called with the snapshot's own row count, before the commit, because the
 * commit is atomic and there is nothing to inspect afterwards that is not
 * already being served.
 *
 * Order of the checks is the order of how sure they are:
 *
 * 1. **An acknowledgement wins outright.** {@link EXPECT_SHRINK_LABEL} on the
 *    pending snapshot means somebody said this load is meant to be smaller.
 * 2. **Zero rows over a non-empty dataset is always refused**, at any size and
 *    below any `minRows`. A source that is briefly empty and a transform that
 *    quietly returned `[]` both look exactly like this, and committing it
 *    repoints the live view at nothing.
 * 3. **The ratios**, once the previous snapshot is big enough for a ratio to
 *    mean anything.
 *
 * `previous` absent means the type has never committed — the first load of a
 * type, and the first load after somebody dropped its history — and there is
 * nothing to deviate from. That is not a hole to be closed by inventing a
 * baseline; the honest position is that the first load defines the baseline.
 */
export function refuseRowCountDrift(input: {
  typeName: string;
  snapshotId: string;
  /** The snapshot currently being served, or nothing when none ever was. */
  previous: SnapshotRef | undefined;
  /** Rows in the snapshot about to be committed. */
  pending: number;
  /** Its labels, for the acknowledgement. */
  pendingLabels: Record<string, string> | undefined;
  bound: RowCountBound;
}): string | undefined {
  const { typeName, snapshotId, previous, pending, pendingLabels, bound } = input;
  if (!previous) return undefined;
  if (pendingLabels?.[EXPECT_SHRINK_LABEL] !== undefined) return undefined;
  // A durable run whose commit succeeded and which then replays re-commits the
  // snapshot that is already being served. Comparing it against itself is
  // meaningless rather than wrong, and refusing a replay of a commit that
  // already happened would strand the run.
  if (previous.id === snapshotId) return undefined;

  const before = previous.rowCount;
  if (before <= 0) return undefined;

  if (pending === 0) {
    return `Snapshot ${snapshotId} of ${typeName} holds no rows, and ${previous.id} — the one being served — holds ${before}. Committing it would repoint every reader at an empty dataset, and a source that was briefly empty, a filter that matched nothing and a transform that returned [] all arrive here looking exactly like this. Left uncommitted, so ${previous.id} keeps serving.`;
  }

  // Below the floor a ratio says nothing, and only the absolute check above
  // applies. After it, deliberately: zero rows over four is still zero rows.
  if (before < bound.minRows) return undefined;

  const shrink = (before - pending) / before;
  if (shrink > bound.maxShrink) {
    return `Snapshot ${snapshotId} of ${typeName} holds ${pending} rows where ${previous.id} — the one being served — holds ${before}: a loss of ${percent(shrink)}, past the ${percent(bound.maxShrink)} this type allows in one load. This is what a source-side filter change, a broken WHERE and a partial outage all look like, and the data would be fresh and wrong, which no staleness signal can report. Left uncommitted, so ${previous.id} keeps serving. If the load is right, set "${EXPECT_SHRINK_LABEL}" in its labels or raise rowCount.maxShrink for ${typeName}.`;
  }

  if (bound.maxGrowth !== undefined && pending > before * bound.maxGrowth) {
    return `Snapshot ${snapshotId} of ${typeName} holds ${pending} rows where ${previous.id} — the one being served — holds ${before}, which is more than the ${bound.maxGrowth}× this type allows in one load. A join that lost its condition and a source that was read twice both produce a number like this. Left uncommitted, so ${previous.id} keeps serving.`;
  }

  return undefined;
}

/**
 * What a refused load throws.
 *
 * `BadRequestException` because that is what the publish controller turns into
 * a 400 and what the existing refusals in this area already are — the store's
 * own "you carried forward and then wrote another batch" is one. A class of its
 * own so a caller can tell a refused load from a load that failed, which are
 * opposite facts: the first means the pipeline worked and said no.
 *
 * **There is deliberately no new event.** A refusal from a connector run is
 * reported the way every other failure of a connector run is reported —
 * `connector.run.finished` with `status: 'failed'` and this message as `error`,
 * one event name for both outcomes because anybody watching for failures has to
 * watch the successes anyway to notice the runs that never finished. Adding a
 * `load.refused` channel would put the one failure people most need to see on
 * the one feed nobody is subscribed to yet.
 */
export class LoadExpectationError extends BadRequestException {
  constructor(
    readonly typeName: string,
    /** Which expectation was not met, for a caller keying off it. */
    readonly expectation: 'deletes' | 'row-count',
    message: string,
  ) {
    super(message);
  }
}

/** `1.5 days`, `4 hours`, `20 minutes` — whichever unit leaves a readable number. */
function describeInterval(ms: number): string {
  const units: Array<[number, string]> = [
    [86_400_000, 'day'],
    [3_600_000, 'hour'],
    [60_000, 'minute'],
    [1_000, 'second'],
  ];
  for (const [size, name] of units) {
    if (ms < size) continue;
    const value = Math.round((ms / size) * 10) / 10;
    return `${value} ${value === 1 ? name : `${name}s`}`;
  }
  return `${Math.max(0, Math.round(ms))} ms`;
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 1000) / 10}%`;
}
