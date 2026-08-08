import { describe, expect, it } from 'vitest';
import { AggregateTable, WorkflowAggregateError } from './catalog.aggregate';
import type { WorkflowAggregate, WorkflowAggregateNode } from './catalog.pipeline';

/**
 * The four arithmetic decisions, each with the measurement that forced it.
 *
 * These are not tests of "does grouping work". They are tests that this node
 * gives a **decided** answer where MySQL gives a plausible one, in the four
 * places a comparison against flip's real `wo` derivation found the two
 * disagreeing:
 *
 * - `MAX` over text, where MySQL's collation is case-insensitive and this is
 *   not — 18 of 16,119 groups for `lastUpdatedBy`, 23 for
 *   `maintenanceLocation`, measured on the real data.
 * - `SUM` over float64, where 17 of 16,119 groups differed in the last ulp
 *   purely from the order the terms were added in.
 * - `GROUP_CONCAT` past `group_concat_max_len`, where MySQL truncates and warns
 *   and the warning is not surfaced — 5 of 16,119 groups on each of two
 *   columns, at 1,700 and 1,883 characters against a limit of 1,024.
 * - Grouping on a null or missing key, where the two have to be one group or the
 *   answer depends on which stage shape a row landed in.
 *
 * The model half is `catalog.pipeline.aggregate.spec.ts`.
 */

function node(
  groupBy: string[],
  aggregates: WorkflowAggregate[],
  maxGroups?: number,
): WorkflowAggregateNode {
  return {
    id: 'agg',
    name: 'the aggregate',
    kind: 'aggregate',
    groupBy,
    aggregates,
    ...(maxGroups === undefined ? {} : { maxGroups }),
  };
}

function fold(
  spec: WorkflowAggregateNode,
  rows: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const table = new AggregateTable(spec);
  for (const row of rows) table.push(row);
  return [...table.emit()];
}

describe('what makes two records the same group', () => {
  it('groups a missing column with a null one, because they mean the same thing', () => {
    // The stage encoding is a shape dictionary, so "absent" and "null" are a
    // difference in physical layout rather than in meaning. Splitting them would
    // make a load's group count depend on which shape a row happened to land in.
    const out = fold(node(['unit'], [{ as: 'n', fn: 'count' }]), [
      { unit: null, x: 1 },
      { x: 2 },
      { unit: '21st', x: 3 },
    ]);
    expect(out).toEqual([
      { unit: null, n: 2 },
      { unit: '21st', n: 1 },
    ]);
  });

  it('keeps a number and its text spelling apart, which SQL would not', () => {
    // A decision against SQL, argued in `groupKeyOf`: merging two things the
    // source considered distinct is the worse of the two errors, and within one
    // load a column comes from one system and is one type.
    const out = fold(node(['code'], [{ as: 'n', fn: 'count' }]), [
      { code: 1 },
      { code: '1' },
      { code: 1 },
    ]);
    expect(out).toEqual([
      { code: 1, n: 2 },
      { code: '1', n: 1 },
    ]);
  });

  it('cannot be fooled by a separator inside a value', () => {
    // `["a|b", "c"]` and `["a", "b|c"]` are different groups. A naive join on a
    // delimiter merges them, and the symptom is two work orders silently
    // summed together.
    const out = fold(node(['left', 'right'], [{ as: 'n', fn: 'count' }]), [
      { left: 'a|b', right: 'c' },
      { left: 'a', right: 'b|c' },
    ]);
    expect(out.length).toBe(2);
  });

  it('refuses to group on an object rather than inventing an equality for it', () => {
    expect(() => fold(node(['blob'], [{ as: 'n', fn: 'count' }]), [{ blob: { a: 1 } }])).toThrow(
      /silently decide how many rows this load commits/,
    );
  });

  it('produces no rows at all from no records, rather than one row of nulls', () => {
    // `GROUP BY` over an empty table produces nothing. A bare aggregate with no
    // grouping produces one row, which is why `groupBy` is required.
    expect(fold(node(['unit'], [{ as: 'n', fn: 'count' }]), [])).toEqual([]);
  });
});

describe('min and max, and the collation this deliberately is not', () => {
  it('compares text by code point, which differs from a case-insensitive collation', () => {
    // MySQL under `utf8mb4_0900_ai_ci` answers 'Banana' here, because it folds
    // case before comparing. This answers 'apple', because 'a' is 97 and 'B' is
    // 66. On the real SUBWO data the two disagree on 18 of 16,119 groups for
    // `lastUpdatedBy` and 23 for `maintenanceLocation`. Being *near* a
    // collation is worse than being clearly different: an answer that agrees
    // 99.8% of the time is one nobody checks.
    const out = fold(node(['g'], [{ as: 'top', fn: 'max', column: 'who' }]), [
      { g: 1, who: 'Banana' },
      { g: 1, who: 'apple' },
    ]);
    expect(out[0]?.top).toBe('apple');
  });

  it('orders dates by instant, and skips the nulls the way SQL does', () => {
    const early = new Date('2026-01-02T00:00:00.000Z');
    const late = new Date('2026-06-02T00:00:00.000Z');
    const out = fold(
      node(
        ['g'],
        [
          { as: 'first', fn: 'min', column: 'day' },
          { as: 'last', fn: 'max', column: 'day' },
        ],
      ),
      [{ g: 1, day: late }, { g: 1, day: null }, { g: 1, day: early }, { g: 1 }],
    );
    expect(out[0]?.first).toBe(early);
    expect(out[0]?.last).toBe(late);
  });

  it('answers null for a group whose values were all null, and never a zero or an empty string', () => {
    // The one signal that says "this column was in no record" rather than "this
    // column summed to nothing", and the reason a wholly-missing column is a
    // loud log line and not a crash.
    const out = fold(
      node(
        ['g'],
        [
          { as: 'top', fn: 'max', column: 'missing' },
          { as: 'total', fn: 'sum', column: 'missing' },
          { as: 'all', fn: 'join', column: 'missing' },
          { as: 'mean', fn: 'avg', column: 'missing' },
          { as: 'n', fn: 'count', column: 'missing' },
        ],
      ),
      [{ g: 1 }, { g: 1, missing: null }],
    );
    expect(out[0]).toEqual({ g: 1, top: null, total: null, all: null, mean: null, n: 0 });
  });

  it('refuses a column holding two types rather than picking a coercion', () => {
    // MySQL would coerce and answer something. Whichever this picked, the answer
    // would depend on which record arrived first and the run would still be
    // green — which is the exact shape of failure this node was written about.
    expect(() =>
      fold(node(['g'], [{ as: 'top', fn: 'max', column: 'qty' }]), [
        { g: 1, qty: 12 },
        { g: 1, qty: '12' },
      ]),
    ).toThrow(/no order between them that is not somebody's coercion rule/);
  });

  it('names the column and the group when it refuses, so nobody has to reproduce it', () => {
    try {
      fold(node(['wo', 'asset'], [{ as: 'top', fn: 'max', column: 'qty' }]), [
        { wo: 'W1', asset: 'A9', qty: 12 },
        { wo: 'W1', asset: 'A9', qty: 'x' },
      ]);
      expect.unreachable('the fold should have refused');
    } catch (error) {
      if (!(error instanceof WorkflowAggregateError)) throw error;
      expect(error.message).toContain('"qty"');
      expect(error.message).toContain('"W1", "A9"');
    }
  });
});

describe('sum, and the seventeen groups that were off by an ulp', () => {
  it('gets the answer plain addition gets wrong, which is the whole reason for the second float', () => {
    // The measured case, reduced: a comparison against flip's `wo` found 17 of
    // 16,119 groups differing in the last float64 ulp — `6442.999999999999`
    // against `6443` — purely from summation order. These are four ordinary
    // two-decimal labour costs; naive `+=` over them lands on
    // 21593.800000000003 and Neumaier's compensation lands on the decimal sum.
    const terms = [1234.56, 7890.12, 3456.78, 9012.34];
    let naive = 0;
    for (const term of terms) naive += term;
    expect(naive).toBe(21593.800000000003);

    const out = fold(
      node(['g'], [{ as: 'total', fn: 'sum', column: 'cost' }]),
      terms.map((cost) => ({ g: 1, cost })),
    );
    expect(out[0]?.total).toBe(21593.8);
  });

  it('reads a number out of text, because a CSV has no other way to deliver one', () => {
    const out = fold(node(['g'], [{ as: 'total', fn: 'sum', column: 'cost' }]), [
      { g: 1, cost: '1200.50' },
      { g: 1, cost: '  300.25  ' },
      { g: 1, cost: '' },
    ]);
    // The blank is an absent number and not a zero, which is what a blank cell
    // in a CSV means and what SQL agrees it means.
    expect(out[0]?.total).toBe(1500.75);
  });

  it('refuses text that is not a number, where MySQL would answer zero and warn', () => {
    // `SUM('n/a')` is 0 in MySQL with a warning MikroORM does not surface, which
    // is how a total ends up quietly too small.
    expect(() =>
      fold(node(['g'], [{ as: 'total', fn: 'sum', column: 'cost' }]), [{ g: 1, cost: 'n/a' }]),
    ).toThrow(/MySQL would read that as 0 and raise a warning nobody sees/);
  });

  it('averages the non-null values and nothing else', () => {
    const out = fold(node(['g'], [{ as: 'mean', fn: 'avg', column: 'hours' }]), [
      { g: 1, hours: 4 },
      { g: 1, hours: null },
      { g: 1, hours: 8 },
    ]);
    expect(out[0]?.mean).toBe(6);
  });

  it('counts records with no column and non-null values with one, which differ where the data is sparse', () => {
    const out = fold(
      node(
        ['g'],
        [
          { as: 'records', fn: 'count' },
          { as: 'withDate', fn: 'count', column: 'closed' },
        ],
      ),
      [{ g: 1, closed: new Date(0) }, { g: 1 }, { g: 1, closed: null }],
    );
    expect(out[0]).toEqual({ g: 1, records: 3, withDate: 1 });
  });
});

describe('join, and the five groups production has been truncating', () => {
  it('joins in input order with the separator it was given', () => {
    const out = fold(node(['g'], [{ as: 'all', fn: 'join', column: 'service', separator: '; ' }]), [
      { g: 1, service: 'oil change' },
      { g: 1, service: null },
      { g: 1, service: 'brake' },
    ]);
    // Nulls skipped, exactly as GROUP_CONCAT skips them.
    expect(out[0]?.all).toBe('oil change; brake');
  });

  it('refuses at its bound rather than truncating, naming the group and the length', () => {
    // flip's deployment has `group_concat_max_len = 1024`, real values reach
    // 1,883 characters, and 5 of 16,119 groups exceed it on each of two columns.
    // MySQL truncates and raises a warning MikroORM does not surface. This is
    // that behaviour, not reproduced.
    const rows = Array.from({ length: 20 }, () => ({ g: 'W1', service: 'x'.repeat(100) }));
    try {
      fold(node(['g'], [{ as: 'all', fn: 'join', column: 'service', maxLength: 1024 }]), rows);
      expect.unreachable('the fold should have refused');
    } catch (error) {
      if (!(error instanceof WorkflowAggregateError)) throw error;
      expect(error.message).toContain('against a limit of 1024');
      expect(error.message).toContain('"W1"');
      expect(error.message).toContain('refused rather than truncated');
    }
  });

  it('lets the real flip values through untouched at the shipped default', () => {
    // 1,883 characters is 2.9% of 65,535, so the derivation this node was
    // written for runs without anyone having to think about the bound — and
    // would have refused loudly at 35× the data rather than quietly at 1.5×.
    const rows = Array.from({ length: 19 }, () => ({ g: 1, service: 'y'.repeat(99) }));
    const out = fold(node(['g'], [{ as: 'all', fn: 'join', column: 'service' }]), rows);
    expect(String(out[0]?.all).length).toBe(19 * 99 + 18 * 2);
  });
});

describe('the memory bound', () => {
  it('refuses once a grouping has held more groups than the ceiling, naming the columns', () => {
    // The thing the node exists to avoid, arrived at from the other direction: a
    // hash aggregate holding one entry per row is the whole-batch behaviour it
    // replaces, with nothing on the canvas to point at. So it stops.
    const spec = node(['id'], [{ as: 'n', fn: 'count' }], 3);
    try {
      fold(
        spec,
        Array.from({ length: 10 }, (_, at) => ({ id: `row-${at}` })),
      );
      expect.unreachable('the fold should have refused');
    } catch (error) {
      if (!(error instanceof WorkflowAggregateError)) throw error;
      expect(error.message).toContain('"id"');
      expect(error.message).toContain('holding the whole load rather than a summary of it');
    }
  });

  it('holds groups rather than records, which is the only claim the node actually makes', () => {
    const table = new AggregateTable(node(['unit'], [{ as: 'n', fn: 'count' }]));
    for (let at = 0; at < 50_000; at += 1) table.push({ unit: `u-${at % 12}`, at });
    expect(table.stats().rowsIn).toBe(50_000);
    expect(table.stats().groups).toBe(12);
  });
});

describe('what the pass reports afterwards', () => {
  it('names a column that was in no record at all', () => {
    // Almost always a typo in a header, and the symptom otherwise is a column of
    // nulls and a green run.
    const table = new AggregateTable(
      node(['unit'], [{ as: 'total', fn: 'sum', column: 'actuallLaborCost' }]),
    );
    table.push({ unit: '21st', actualLaborCost: 5 });
    expect(table.stats().unseenColumns).toEqual(['actuallLaborCost']);
  });

  it('counts the values it had to read out of text, and the longest thing it joined', () => {
    const table = new AggregateTable(
      node(
        ['g'],
        [
          { as: 'total', fn: 'sum', column: 'cost' },
          { as: 'all', fn: 'join', column: 'note' },
        ],
      ),
    );
    table.push({ g: 1, cost: '10', note: 'abc' });
    table.push({ g: 1, cost: 20, note: 'de' });
    expect(table.stats().coercedFromString).toBe(1);
    expect(table.stats().longestJoin).toBe('abc, de'.length);
  });

  it('refuses a node the validator would have refused, before a record is read', () => {
    expect(() => new AggregateTable(node([], [{ as: 'n', fn: 'count' }]))).toThrow(
      /cannot be run as it is/,
    );
  });
});

describe('the order it emits in', () => {
  it('emits groups in the order they were first seen, so two runs over one input agree', () => {
    const rows = [{ g: 'b' }, { g: 'a' }, { g: 'b' }, { g: 'c' }];
    const spec = node(['g'], [{ as: 'n', fn: 'count' }]);
    expect(fold(spec, rows).map((row) => row.g)).toEqual(['b', 'a', 'c']);
    expect(fold(spec, rows)).toEqual(fold(spec, rows));
  });

  it('writes every output column on every record, which is what makes the set exact', () => {
    // No record here carries `cost`, and the column still comes out — holding
    // null. That is why `producedColumns` can call an aggregate's output set
    // exact rather than an upper bound, which no other node kind can claim.
    const out = fold(
      node(
        ['g'],
        [
          { as: 'total', fn: 'sum', column: 'cost' },
          { as: 'n', fn: 'count' },
        ],
      ),
      [{ g: 1 }],
    );
    expect(Object.keys(out[0] ?? {})).toEqual(['g', 'total', 'n']);
  });
});
