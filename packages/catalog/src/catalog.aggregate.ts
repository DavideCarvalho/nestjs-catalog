/**
 * The fold behind the `aggregate` node: one pass, one entry per group.
 *
 * ## The property this file exists to have
 *
 * A hash aggregate **consumes its input as a stream and holds only the groups.**
 * It never needs the row it read two rows ago, and it never needs the row it is
 * about to read. So the heap it occupies is a function of how many distinct
 * groups there are, and not of how many rows there were.
 *
 * That is the entire argument for the node, and it is worth stating with the
 * measurement that produced it. flip's `wo` derivation groups **44,720 rows into
 * 16,119 groups** with about fifty aggregates over them. Today it is a
 * whole-batch transform, and as a whole-batch transform it is one column away
 * from dying:
 *
 * - the child is handed 65.51 MiB on stdin;
 * - it answers with **one JSON line of 25.01 MiB — 78.2% of the hard 32 MiB
 *   output cap**, which the parent buffers as a single string before parsing;
 * - and before any of that, the parent materialises all 44,720 rows through
 *   `readInputs`. A standalone equivalent peaked at 237 MiB heap, 406 MiB RSS.
 *
 * At **1.28×** that file it stops working, and it stops by being killed at the
 * cap rather than by getting slower. SUBWO is already the largest file in the
 * drop it comes from. Run through this file instead, the same derivation holds
 * 16,119 accumulator rows and reads one staged batch at a time.
 *
 * ## Which is exactly why the bound is loud
 *
 * "Holds only the groups" is a *cheap* promise only while the groups are far
 * fewer than the rows. Group by something near-unique and a hash aggregate holds
 * the entire load, which is the thing being fixed rather than a corner of it. So
 * {@link AggregateTable} carries a group ceiling and **refuses** when it is
 * crossed, naming the columns it was grouping on. Peaking silently at the
 * ceiling is the failure mode this node was written about.
 *
 * ## Every arithmetic decision in one place
 *
 * The node is the model; this is the semantics. Both are here rather than in the
 * runner so that the canvas, a spec and a durable step get the same answer out
 * of the same code, and so that the decisions below have one address:
 *
 * - **Comparison order for `min`/`max` over strings** — see {@link compareValues}.
 * - **Summation error** — see {@link addToSum}.
 * - **The bound on a `join`, and what happens at it** — see {@link appendJoin}.
 * - **What makes two records the same group** — see {@link groupKeyOf}.
 *
 * None of them is inherited from MySQL, and where the answer differs from
 * MySQL's the docblock says so and says why, because the alternative is a load
 * that silently disagrees with the query it replaced.
 */

import {
  type WorkflowAggregate,
  type WorkflowAggregateNode,
  aggregateRefusals,
  unreachableAggregateFunction,
  workflowAggregateJoinMaxLength,
  workflowAggregateMaxGroups,
  workflowAggregateSeparator,
} from './catalog.pipeline';

/**
 * A refusal raised while folding, rather than a wrong answer carried forward.
 *
 * Its own class so a caller can tell "this data cannot be aggregated the way the
 * node says" from a bug, and turn the first into a 400 with the sentence intact.
 * Every message it carries names the column, the group and the values, because a
 * refusal at row ninety thousand that says only "incomparable" is a refusal
 * somebody has to reproduce before they can act on it.
 */
export class WorkflowAggregateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowAggregateError';
  }
}

/** What the fold learned on the way through, for the run log. */
export interface AggregateTableStats {
  /** Records handed to {@link AggregateTable.push}. */
  rowsIn: number;
  /** Distinct groups held. The number the memory bound is about. */
  groups: number;
  /**
   * Columns the node names that were present in **no** record of the whole run.
   *
   * Almost always a typo in a header, and the symptom otherwise is a column of
   * nulls and a green run — the same trap `renameStagePayload` reports and for
   * the same reason. Not a refusal, because a source legitimately omits a column
   * for a whole load, and `sum`/`min`/`max` over nothing answers `null` rather
   * than `0`, which is visibly different from a real zero.
   */
  unseenColumns: string[];
  /**
   * How many values a `sum` or an `avg` had to read out of a string.
   *
   * A CSV delivers every number as text, so this is usually the whole column and
   * is not a problem. It is reported because the one case that *is* a problem —
   * a column that is numbers in one source and text in another — looks identical
   * from the answer and different from here.
   */
  coercedFromString: number;
  /** The longest value any `join` produced, in characters. See {@link appendJoin}. */
  longestJoin: number;
}

/** One group's state: the key as it arrived, and one accumulator per aggregate. */
interface AggregateGroup {
  /** The group-by values from the record that opened the group. */
  key: unknown[];
  /** Parallel to the node's `aggregates`. See {@link freshAccumulator}. */
  acc: unknown[];
}

/** `count`. A plain tally; nothing about it can overflow at these sizes. */
interface CountAcc {
  n: number;
}

/** `sum` and `avg`. See {@link addToSum} for why there are two numbers. */
interface SumAcc {
  /** The running total. */
  sum: number;
  /** Neumaier's compensation term: the low-order bits `sum` could not hold. */
  compensation: number;
  /** Non-null values seen. Zero means the answer is `null`, never `0`. */
  n: number;
}

/** `min` and `max`. `undefined` means nothing non-null has arrived yet. */
interface ExtremumAcc {
  value: unknown;
}

/** `join`. See {@link appendJoin} for the bound and what happens at it. */
interface JoinAcc {
  text: string;
  n: number;
}

/**
 * The fold, as an object you push records into.
 *
 * An object rather than a `reduce` because the caller is a loop over staged
 * batches with an `await` in it: the table has to survive between batches, and
 * nothing about it may scale with how many batches there were.
 *
 * Built from the node, and it refuses a node the validator would refuse rather
 * than folding under a configuration nobody could have saved — a graph can reach
 * a runner from a database written by an older build, and `aggregateRefusals` is
 * the one place that rule lives.
 */
export class AggregateTable {
  private readonly groups = new Map<string, AggregateGroup>();
  private readonly groupBy: readonly string[];
  private readonly aggregates: readonly WorkflowAggregate[];
  private readonly maxGroups: number;
  /** Named columns not yet seen in any record. Emptied as they turn up. */
  private readonly unseen: Set<string>;
  private rowsIn = 0;
  private coercedFromString = 0;
  private longestJoin = 0;

  constructor(private readonly node: WorkflowAggregateNode) {
    const refusals = aggregateRefusals(node);
    if (refusals.length > 0) {
      throw new WorkflowAggregateError(
        `Aggregate "${node.name}" (${node.id}) cannot be run as it is. ${refusals.join(' ')}`,
      );
    }
    this.groupBy = node.groupBy;
    this.aggregates = node.aggregates;
    this.maxGroups = workflowAggregateMaxGroups(node);
    this.unseen = new Set([...node.groupBy, ...aggregateInputColumns(node)]);
  }

  /**
   * Fold one record in.
   *
   * Allocates nothing per record except when a record opens a group, which is
   * the property that makes the whole thing a stream: the cost of a row is the
   * group-key encoding plus one accumulator update per aggregate.
   */
  push(row: Record<string, unknown>): void {
    this.rowsIn += 1;
    if (this.unseen.size > 0) {
      for (const column of this.unseen) {
        if (row[column] !== undefined) this.unseen.delete(column);
      }
    }

    const key: unknown[] = [];
    for (const column of this.groupBy) key.push(row[column]);
    const id = groupKeyOf(key, this.groupBy, this.node);

    let group = this.groups.get(id);
    if (group === undefined) {
      if (this.groups.size >= this.maxGroups) {
        throw new WorkflowAggregateError(
          `Aggregate "${this.node.name}" (${this.node.id}) has already held ${this.groups.size} distinct groups after ${this.rowsIn} records, which is the ceiling this node was given. A hash aggregate holds one entry per group, so grouping on ${this.groupBy.map((column) => JSON.stringify(column)).join(', ')} is holding the whole load rather than a summary of it — which is the thing this node exists to avoid. Group on fewer or coarser columns, or raise \`maxGroups\` deliberately and size the machine for it.`,
        );
      }
      group = { key, acc: this.aggregates.map((each) => freshAccumulator(each)) };
      this.groups.set(id, group);
    }

    for (let at = 0; at < this.aggregates.length; at += 1) {
      const aggregate = this.aggregates[at];
      if (aggregate === undefined) continue;
      this.accumulate(aggregate, group.acc[at], row, id);
    }
  }

  /**
   * One aggregate, one record. Narrowed off the function list, never asserted.
   *
   * A dispatch and four one-function methods rather than four branches inline,
   * so each function's rule about nulls — which is the part that has to match
   * SQL and the part that is easy to get subtly wrong — sits next to its own
   * name. Ends in the exhaustiveness guard, so a seventh function is a compile
   * error here rather than a value nobody computed.
   */
  private accumulate(
    aggregate: WorkflowAggregate,
    slot: unknown,
    row: Record<string, unknown>,
    groupId: string,
  ): void {
    const fn = aggregate.fn;
    if (fn === 'count') {
      this.count(aggregate, slot, row);
      return;
    }
    if (fn === 'sum' || fn === 'avg') {
      this.total(aggregate, slot, row, groupId);
      return;
    }
    if (fn === 'min' || fn === 'max') {
      this.extremum(fn, aggregate, slot, row, groupId);
      return;
    }
    if (fn === 'join') {
      this.join(aggregate, slot, row, groupId);
      return;
    }
    unreachableAggregateFunction(fn, 'AggregateTable.accumulate');
  }

  /**
   * `COUNT(*)` with no column and `COUNT(col)` with one.
   *
   * The two differ exactly where the data is sparse, which is where somebody is
   * most likely to want to know — so both are offered rather than one being
   * picked on the reader's behalf.
   */
  private count(aggregate: WorkflowAggregate, slot: unknown, row: Record<string, unknown>): void {
    if (!isCountAcc(slot)) return;
    if (aggregate.column === undefined) {
      slot.n += 1;
      return;
    }
    const value = row[aggregate.column];
    if (value !== null && value !== undefined) slot.n += 1;
  }

  /** `sum` and `avg`, which share an accumulator and differ only at the finish. */
  private total(
    aggregate: WorkflowAggregate,
    slot: unknown,
    row: Record<string, unknown>,
    groupId: string,
  ): void {
    if (!isSumAcc(slot) || aggregate.column === undefined) return;
    const numeric = this.toNumber(row[aggregate.column], aggregate, groupId);
    if (numeric === undefined) return;
    addToSum(slot, numeric);
  }

  /** `min` and `max`. Nulls are skipped, as SQL skips them. */
  private extremum(
    fn: 'min' | 'max',
    aggregate: WorkflowAggregate,
    slot: unknown,
    row: Record<string, unknown>,
    groupId: string,
  ): void {
    if (!isExtremumAcc(slot) || aggregate.column === undefined) return;
    const value = row[aggregate.column];
    if (value === null || value === undefined) return;
    if (slot.value === undefined) {
      slot.value = value;
      return;
    }
    const order = compareValues(slot.value, value, aggregate.column, groupId);
    if (fn === 'min' ? order > 0 : order < 0) slot.value = value;
  }

  /** `join`. Nulls skipped, empty strings kept — which is what GROUP_CONCAT does. */
  private join(
    aggregate: WorkflowAggregate,
    slot: unknown,
    row: Record<string, unknown>,
    groupId: string,
  ): void {
    if (!isJoinAcc(slot) || aggregate.column === undefined) return;
    const value = row[aggregate.column];
    if (value === null || value === undefined) return;
    appendJoin(slot, joinText(value, aggregate.column, groupId), aggregate, this.node, groupId);
    if (slot.text.length > this.longestJoin) this.longestJoin = slot.text.length;
  }

  /**
   * A value on its way into a `sum` or an `avg`, or nothing.
   *
   * Three answers rather than two, and the middle one is the decision:
   *
   * - **null, undefined, or a string that is only whitespace** — skipped, and
   *   `n` does not move. A blank cell in a CSV is an absent number and not a
   *   zero, and SQL agrees: `SUM` over nothing but nulls is `NULL`, which is
   *   visibly different from a real total of zero.
   * - **a string that parses as a finite number** — accepted, and counted in
   *   {@link AggregateTableStats.coercedFromString}. Refusing would make the
   *   node useless on the exact data it was written for, since a CSV delivers
   *   every number as text.
   * - **anything else** — refused, naming the column, the group and the value.
   *   MySQL reads `'n/a'` as `0` and raises a warning MikroORM does not surface,
   *   which is how a total ends up quietly too small. This is that behaviour,
   *   not reproduced.
   */
  private toNumber(
    raw: unknown,
    aggregate: WorkflowAggregate,
    groupId: string,
  ): number | undefined {
    if (raw === null || raw === undefined) return undefined;
    if (typeof raw === 'number') {
      if (Number.isFinite(raw)) return raw;
      throw new WorkflowAggregateError(
        `Aggregate "${this.node.name}" (${this.node.id}) was asked to ${aggregate.fn} ${JSON.stringify(aggregate.column)} and found ${String(raw)} in the group ${describeGroup(groupId)}. There is no total that includes it, and carrying it would make every row of the group's answer ${String(raw)} without saying why.`,
      );
    }
    if (typeof raw === 'bigint') {
      this.coercedFromString += 0;
      return Number(raw);
    }
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (trimmed.length === 0) return undefined;
      const parsed = Number(trimmed);
      if (Number.isFinite(parsed)) {
        this.coercedFromString += 1;
        return parsed;
      }
    }
    throw new WorkflowAggregateError(
      `Aggregate "${this.node.name}" (${this.node.id}) was asked to ${aggregate.fn} ${JSON.stringify(aggregate.column)} and found ${describeValue(raw)} in the group ${describeGroup(groupId)}, which is not a number. MySQL would read that as 0 and raise a warning nobody sees, so the total would come out too small and the run would come out green. Normalise the column in a transform above this node, or aggregate a different one.`,
    );
  }

  /**
   * Every group, as records, in the order the groups were first seen.
   *
   * **Insertion order rather than sorted**, and that is a decision about
   * determinism rather than about cost. Sorting would need a total order over
   * heterogeneous key values — the thing {@link compareValues} refuses to invent
   * — and would buy an ordering nobody asked for. Insertion order is a function
   * of the input order, and the input is a numbered list of staged batches, so
   * two runs over the same staged rows emit the same rows in the same order.
   * What it does **not** promise is stability across a source that returns its
   * own rows in a different order; a `SELECT` without an `ORDER BY` promises
   * nothing and this node cannot promise more than it was given.
   *
   * Every record carries **every** output column — the group keys, then the
   * aggregates, in the node's order — including the ones whose answer is `null`.
   * That is what makes an aggregate's output set *exact* rather than an upper
   * bound, which is the claim `producedColumns` makes about this kind and about
   * no other.
   */
  *emit(): Generator<Record<string, unknown>> {
    for (const group of this.groups.values()) {
      const row: Record<string, unknown> = {};
      for (let at = 0; at < this.groupBy.length; at += 1) {
        const column = this.groupBy[at];
        if (column === undefined) continue;
        const value = group.key[at];
        // A record that did not carry the column grouped with the records whose
        // column was null — see `groupKeyOf` — so it has to come out as null and
        // not as absent, or the two halves of one group would disagree about
        // whether the column exists.
        row[column] = value === undefined ? null : value;
      }
      for (let at = 0; at < this.aggregates.length; at += 1) {
        const aggregate = this.aggregates[at];
        if (aggregate === undefined) continue;
        row[aggregate.as] = finishAccumulator(aggregate, group.acc[at]);
      }
      yield row;
    }
  }

  /** What the run log says. Cheap: everything here was counted on the way past. */
  stats(): AggregateTableStats {
    return {
      rowsIn: this.rowsIn,
      groups: this.groups.size,
      unseenColumns: [...this.unseen],
      coercedFromString: this.coercedFromString,
      longestJoin: this.longestJoin,
    };
  }
}

/** The columns a node's aggregates read, deduplicated, `count(*)` excluded. */
export function aggregateInputColumns(node: WorkflowAggregateNode): string[] {
  const columns = new Set<string>();
  for (const aggregate of node.aggregates ?? []) {
    if (aggregate.column !== undefined && aggregate.column.length > 0)
      columns.add(aggregate.column);
  }
  return [...columns];
}

/** An empty accumulator, per function. Ends in the exhaustiveness guard. */
function freshAccumulator(aggregate: WorkflowAggregate): unknown {
  const fn = aggregate.fn;
  if (fn === 'count') return { n: 0 };
  if (fn === 'sum' || fn === 'avg') return { sum: 0, compensation: 0, n: 0 };
  if (fn === 'min' || fn === 'max') return { value: undefined };
  if (fn === 'join') return { text: '', n: 0 };
  return unreachableAggregateFunction(fn, 'freshAccumulator');
}

/**
 * An accumulator, read out as the value the group's record carries.
 *
 * `null` wherever nothing non-null arrived — never `0`, and never the empty
 * string. SQL agrees on all four, and the difference is the one signal that
 * tells "this column was in no record" apart from "this column really did sum to
 * nothing": an empty string is a value somebody wrote down and a null is a value
 * nobody did.
 */
function finishAccumulator(aggregate: WorkflowAggregate, slot: unknown): unknown {
  const fn = aggregate.fn;
  // Split three and three: the ones that answer with a number this node
  // computed, and the ones that answer with a value the data already held. A
  // seventh function is still a compile error — it belongs to neither union, so
  // neither call below accepts it.
  if (fn === 'count' || fn === 'sum' || fn === 'avg') return finishedNumber(fn, slot);
  return finishedValue(fn, slot);
}

/** `count`, `sum` and `avg`: a number this node derived, or null. */
function finishedNumber(fn: 'count' | 'sum' | 'avg', slot: unknown): number | null {
  if (fn === 'count') return isCountAcc(slot) ? slot.n : 0;
  const total = finishedSum(slot);
  if (total === undefined) return null;
  return fn === 'sum' ? total.sum : total.sum / total.n;
}

/** `min`, `max` and `join`: a value the data held, or null. */
function finishedValue(fn: 'min' | 'max' | 'join', slot: unknown): unknown {
  if (fn === 'min' || fn === 'max') return isExtremumAcc(slot) ? (slot.value ?? null) : null;
  if (fn === 'join') return isJoinAcc(slot) && slot.n > 0 ? slot.text : null;
  return unreachableAggregateFunction(fn, 'finishAccumulator');
}

/**
 * The total and how many terms went into it, or nothing at all.
 *
 * The compensation is added back here and nowhere else, which is the point of
 * the helper: `sum` and `avg` read the same accumulator, and one of them
 * forgetting the low-order bits would be a difference nobody could see in a
 * report and nobody could explain in a reconciliation.
 */
function finishedSum(slot: unknown): { sum: number; n: number } | undefined {
  if (!isSumAcc(slot) || slot.n === 0) return undefined;
  return { sum: slot.sum + slot.compensation, n: slot.n };
}

/* --- the four decisions -------------------------------------------------- */

/**
 * What makes two records the same group.
 *
 * The key is the group-by values, encoded into one string so a `Map` can hold
 * them. Every part is **length-prefixed and type-tagged**, which closes two
 * holes that a naive `values.join('|')` leaves open:
 *
 * - `["a|b", "c"]` and `["a", "b|c"]` are different groups and must stay
 *   different. Length prefixes make the encoding unambiguous whatever the values
 *   contain.
 * - `1` and `"1"` are different groups, and that is a **decision against SQL**,
 *   which would coerce them together. Merging them means merging two things the
 *   source considered distinct, on a rule nobody chose; within one load a column
 *   comes from one system and is one type, so the coercion buys nothing and
 *   risks a group that quietly swallowed another.
 *
 * **Missing and null are the same group**, and that is a decision *for* SQL.
 * `GROUP BY` collects all NULLs into one group, and a record that simply lacks
 * the column is a record whose column is null. The stage encoding makes "absent"
 * and "null" a difference in physical layout rather than in meaning — see the
 * shape dictionary in `catalog.stage-encoding.ts` — so grouping them apart would
 * make the answer depend on which shape a row happened to land in, which is not
 * a thing to build a load on.
 *
 * A value that is an object or an array is **refused**. Two objects are equal
 * under some rule and unequal under others, every one of those rules is
 * somebody's convention, and picking one silently decides how many rows a
 * published type ends up holding.
 */
export function groupKeyOf(
  values: readonly unknown[],
  columns: readonly string[],
  node: { id: string; name: string },
): string {
  let key = '';
  for (let at = 0; at < values.length; at += 1) {
    const part = keyPart(values[at], columns[at] ?? '', node);
    key += `${part.length} ${part}`;
  }
  return key;
}

function keyPart(value: unknown, column: string, node: { id: string; name: string }): string {
  if (value === null || value === undefined) return '~';
  if (typeof value === 'string') return `s${value}`;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new WorkflowAggregateError(
        `Aggregate "${node.name}" (${node.id}) groups on ${JSON.stringify(column)} and found ${String(value)} in it. It is not a value two records can be judged equal on, so it cannot name a group.`,
      );
    }
    return `n${value}`;
  }
  if (typeof value === 'boolean') return `b${value ? 1 : 0}`;
  if (typeof value === 'bigint') return `n${value}`;
  if (value instanceof Date) {
    const time = value.getTime();
    if (Number.isNaN(time)) {
      throw new WorkflowAggregateError(
        `Aggregate "${node.name}" (${node.id}) groups on ${JSON.stringify(column)} and found an invalid date in it. Every invalid date is equal to no other date including itself, so it cannot name a group.`,
      );
    }
    return `d${time}`;
  }
  throw new WorkflowAggregateError(
    `Aggregate "${node.name}" (${node.id}) groups on ${JSON.stringify(column)} and found ${describeValue(value)} in it. Two of those are equal under some rule and unequal under others, and picking one here would silently decide how many rows this load commits. Group on a column of plain values, or flatten it in a transform above this node.`,
  );
}

/**
 * The order `min` and `max` compare in, and the one place it is decided.
 *
 * ## Strings compare by **code point**, and that is not MySQL's answer
 *
 * The column this node most often replaces sits in MySQL under
 * `utf8mb4_0900_ai_ci` — case-insensitive and accent-insensitive — where
 * `'apple' > 'Banana'` is false. JavaScript's `<` compares UTF-16 code points,
 * where `'B'` is 66 and `'a'` is 97, so `'apple' > 'Banana'` is true. On the real
 * SUBWO data the two answers agree on most columns and **differ on two**: 18 of
 * 16,119 groups for `lastUpdatedBy` and 23 for `maintenanceLocation`, both of
 * which hold mixed-case usernames and location codes.
 *
 * Code point order is implemented anyway, deliberately:
 *
 * - It is **total, stable and machine-independent.** The same rows produce the
 *   same answer on every Node build, in every locale, with no ICU data loaded.
 * - The alternative is not "MySQL's answer" — it is *an approximation of one
 *   deployment's collation*. `Intl.Collator` implements the Unicode collation
 *   algorithm, MySQL implements its own table per collation, and a graph can
 *   read from a source that is not MySQL at all. Matching would mean carrying a
 *   collation name on the node and reimplementing it, which is a database inside
 *   a pipeline node.
 * - Being *near* MySQL is worse than being clearly different. A comparison that
 *   agrees 99.8% of the time is one nobody checks and everybody trusts.
 *
 * So it is code point order, it is written down here, and the run log says
 * nothing about it because there is nothing conditional to report — what a
 * reader needs is this paragraph, which is why it is this long.
 *
 * ## Types are not compared across classes
 *
 * Numbers with numbers, strings with strings, dates with dates, booleans with
 * booleans. A `max` over a column holding both `12` and `"12"` is **refused**,
 * naming the column, the group and both values. There is no ordering between a
 * number and a string that is not somebody's coercion rule, and every such rule
 * produces a maximum that depends on which row arrived first — a wrong answer
 * that reports success, which is the shape of failure this node was written
 * about. The fix is one node upstream: normalise the column in a transform.
 */
export function compareValues(
  left: unknown,
  right: unknown,
  column: string,
  groupId: string,
): number {
  if (typeof left === 'number' && typeof right === 'number') return sign(left, right);
  // Code point order. See the docblock: not MySQL's collation, on purpose.
  if (typeof left === 'string' && typeof right === 'string') return sign(left, right);
  if (left instanceof Date && right instanceof Date) return sign(left.getTime(), right.getTime());
  if (typeof left === 'boolean' && typeof right === 'boolean') {
    return sign(left ? 1 : 0, right ? 1 : 0);
  }
  if (typeof left === 'bigint' && typeof right === 'bigint') return sign(left, right);
  throw new WorkflowAggregateError(
    `Column ${JSON.stringify(column)} holds ${describeValue(left)} and ${describeValue(right)} in the group ${describeGroup(groupId)}, and there is no order between them that is not somebody's coercion rule. Whichever this node picked, the answer would depend on which record arrived first and the run would still report success. Normalise the column in a transform above this node.`,
  );
}

/**
 * Add one value to a running total, with the low-order bits kept.
 *
 * ## The measurement this is here for
 *
 * A prior comparison of flip's `wo` derivation against a JavaScript
 * reimplementation found **17 of 16,119 groups differing in the last float64
 * ulp** — `6442.999999999999` against `6443` — purely from the order the terms
 * were added in. The grand totals reconciled exactly (212,192,113 on both
 * sides), so the difference was tolerable. It was also nobody's decision, and
 * that is the part worth fixing: a load that is off by an ulp because of an
 * accident is one nobody can reason about the next time it is off by more.
 *
 * ## What is implemented, and what it does and does not promise
 *
 * **Neumaier summation.** One extra float per accumulator carries the bits the
 * running total could not hold, and they are added back once at the end. On
 * decimal money and hours — which is what every column this node sums actually
 * is — the result is the correctly-rounded sum, so `6443` comes out as `6443`.
 *
 * What it promises:
 *
 * - The answer is **far** closer to the exact sum than `+=` is, and for values
 *   with a couple of decimal places it is the exact sum rounded once.
 * - It costs one number per accumulator and two floating-point operations per
 *   row. At 44,720 rows that is unmeasurable.
 *
 * What it does **not** promise:
 *
 * - **Order independence.** Nothing short of exact arithmetic gives that, and
 *   exact arithmetic means holding a big decimal per accumulator, which trades
 *   the property the node is built on for a rounding difference nobody can
 *   observe in a report.
 * - **Bit-for-bit agreement with MySQL.** MySQL sums in its own order and, for a
 *   `DECIMAL` column, not in binary floating point at all. Where the source
 *   column is `DECIMAL` the honest answer is that these are two different
 *   arithmetics and the difference is bounded by one rounding, not that they
 *   agree.
 */
export function addToSum(slot: SumAcc, value: number): void {
  const total = slot.sum + value;
  // Neumaier's refinement of Kahan: whichever of the two was larger in
  // magnitude keeps its bits, and the other's lost low-order bits go to the
  // compensation term. This is the branch Kahan's original gets wrong when the
  // incoming value is the larger of the two.
  slot.compensation +=
    Math.abs(slot.sum) >= Math.abs(value) ? slot.sum - total + value : value - total + slot.sum;
  slot.sum = total;
  slot.n += 1;
}

/**
 * Append one value to a joined string, and refuse rather than truncate.
 *
 * ## The behaviour this is designed against, which is live today
 *
 * flip's `wo` derivation uses `GROUP_CONCAT(... SEPARATOR '; ')`. In that
 * deployment `group_concat_max_len` is **1024**. Real values reach **1,700 and
 * 1,883 characters**, and **5 of 16,119 groups exceed the limit on each of two
 * columns**. MySQL truncates at the limit and raises a warning, and MikroORM
 * does not surface the warning. So five rows per column have been silently
 * missing their tail, in committed data, with a green run every time.
 *
 * That is not a MySQL bug and it is not a configuration slip anybody would
 * notice: the default is 1024, the query does not mention it, and a truncated
 * string is a perfectly plausible string.
 *
 * ## What this does instead
 *
 * **Refuses, at the bound, naming the group and the length.** Not truncation
 * with a log line, and not an unbounded string.
 *
 * - Truncating loudly was the other candidate and it loses on the same argument
 *   as everything else here: the run would go green, the snapshot would commit,
 *   and the log line would be one of twenty on a node nobody reads unless
 *   something already went wrong. The value would still be wrong in the
 *   warehouse.
 * - Unbounded loses on the node's own thesis. A `join` is the one accumulator
 *   whose size is not bounded by the group count, so an unbounded one is a hole
 *   straight through "holds only the groups".
 *
 * The default bound is {@link WORKFLOW_AGGREGATE_JOIN_MAX_LENGTH} — 65,535
 * characters, which is what one MySQL `TEXT` column holds, because a value the
 * target column cannot store is the same defect one layer further down. flip's
 * real maximum of 1,883 is 2.9% of it, so the derivation this node was written
 * for runs untouched and would have refused loudly at 35× the data instead of
 * quietly at 1.5×.
 *
 * An author may lower it (a column that should never exceed 200 characters is
 * worth saying so about) or raise it up to a hard ceiling, which is on
 * {@link workflowAggregateJoinMaxLength}.
 */
export function appendJoin(
  slot: JoinAcc,
  text: string,
  aggregate: WorkflowAggregate,
  node: { id: string; name: string },
  groupId: string,
): void {
  const separator = workflowAggregateSeparator(aggregate);
  const addition = slot.n === 0 ? text : separator + text;
  const limit = workflowAggregateJoinMaxLength(aggregate);
  const would = slot.text.length + addition.length;
  if (would > limit) {
    throw new WorkflowAggregateError(
      `Aggregate "${node.name}" (${node.id}) joins ${JSON.stringify(aggregate.column)} into ${JSON.stringify(aggregate.as)}, and the group ${describeGroup(groupId)} has reached ${would} characters against a limit of ${limit}. It is refused rather than truncated: MySQL's GROUP_CONCAT truncates at group_concat_max_len and raises a warning most drivers never surface, which is how a committed column ends up quietly missing its tail. Raise \`maxLength\` on this aggregate if the whole value is wanted, or count the rows instead of joining them.`,
    );
  }
  slot.text += addition;
  slot.n += 1;
}

/**
 * The order of two values of one type, as -1, 0 or 1.
 *
 * Generic over the comparable primitives rather than taking `unknown`, so
 * {@link compareValues} does the narrowing once per class and this cannot be
 * called on a pair whose comparison would be a coercion.
 */
function sign<T extends number | bigint | string>(left: T, right: T): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** One value on its way into a `join`. Refuses what has no obvious spelling. */
function joinText(value: unknown, column: string, groupId: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return value.toISOString();
  throw new WorkflowAggregateError(
    `Column ${JSON.stringify(column)} holds ${describeValue(value)} in the group ${describeGroup(groupId)}, and there is no one spelling of it to join. MySQL would render it as whatever its own cast produced; this node would rather be told which text was meant, in a transform above it.`,
  );
}

/* --- narrowing, so nothing here is a type assertion ---------------------- */

function isCountAcc(slot: unknown): slot is CountAcc {
  return typeof slot === 'object' && slot !== null && typeof Reflect.get(slot, 'n') === 'number';
}

function isSumAcc(slot: unknown): slot is SumAcc {
  if (typeof slot !== 'object' || slot === null) return false;
  return (
    typeof Reflect.get(slot, 'sum') === 'number' &&
    typeof Reflect.get(slot, 'compensation') === 'number' &&
    typeof Reflect.get(slot, 'n') === 'number'
  );
}

function isExtremumAcc(slot: unknown): slot is ExtremumAcc {
  return typeof slot === 'object' && slot !== null && 'value' in slot;
}

function isJoinAcc(slot: unknown): slot is JoinAcc {
  if (typeof slot !== 'object' || slot === null) return false;
  return (
    typeof Reflect.get(slot, 'text') === 'string' && typeof Reflect.get(slot, 'n') === 'number'
  );
}

/* --- sentences ----------------------------------------------------------- */

/**
 * A group key, back in something a person can look up.
 *
 * The key is a length-prefixed encoding, which is unreadable on purpose and
 * useless in an error message. This walks it back into the values it was built
 * from, so a refusal names the row somebody has to go and find.
 */
export function describeGroup(key: string): string {
  const parts: string[] = [];
  let at = 0;
  while (at < key.length) {
    const boundary = key.indexOf(' ', at);
    if (boundary < 0) break;
    const length = Number(key.slice(at, boundary));
    if (!Number.isInteger(length) || length < 0) break;
    const part = key.slice(boundary + 1, boundary + 1 + length);
    at = boundary + 1 + length;
    parts.push(part === '~' ? 'null' : JSON.stringify(part.slice(1)));
  }
  return parts.length === 0 ? '(unreadable)' : `(${parts.join(', ')})`;
}

/** A value, short enough for an error message and honest about its type. */
export function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'nothing';
  if (typeof value === 'string') {
    const shown = value.length > 40 ? `${value.slice(0, 40)}…` : value;
    return `the text ${JSON.stringify(shown)}`;
  }
  if (typeof value === 'number' || typeof value === 'bigint') return `the number ${String(value)}`;
  if (typeof value === 'boolean') return `the boolean ${String(value)}`;
  if (value instanceof Date) return `the date ${value.toISOString()}`;
  if (Array.isArray(value)) return `a list of ${value.length}`;
  return 'an object';
}
