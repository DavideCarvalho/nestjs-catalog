/**
 * What a filter says on the canvas, and what it says about a run.
 *
 * Runs in `node`, deliberately: both functions here are pure, and pulling in
 * jsdom to check a string would make the flakiest environment in this repo
 * responsible for the two sentences a filter exists to produce.
 *
 * WHAT IS PINNED HERE
 * -------------------
 * **The drop is only reported when it was measured.** `rowsIn` is optional — no
 * other node kind sets it, and a filter that ran before the server recorded it
 * has none — so `describeDrop` keys off its *presence*. Subtracting from a
 * defaulted zero instead would make every source and every sink in a run panel
 * claim to have thrown away everything it produced, which is a worse lie than
 * saying nothing.
 *
 * **The face and the inspector describe one filter one way.** They share
 * `describeFilterPredicate`, and on a screen whose entire job is making a
 * silent subtraction visible, two descriptions of one predicate would be worse
 * than a bad one.
 */
import type { WorkflowFilterPredicate } from '@dudousxd/nestjs-catalog/client';
import { describe, expect, it } from 'vitest';
import { describeDrop, describeFilterPredicate } from './graph';

describe('a predicate as a sentence', () => {
  it('shows the value, not only the column', () => {
    // Unlike an `if`, which stores the *name* of an environment variable and
    // never its contents because that is where a credential would be. A
    // filter's value is a business constant somebody typed into the graph.
    const open: WorkflowFilterPredicate = {
      kind: 'compare',
      column: 'status',
      operator: 'equals',
      value: 'OPEN',
    };

    expect(describeFilterPredicate(open)).toBe('status = "OPEN"');
  });

  it('quotes text and does not quote numbers', () => {
    // The quotes are the only thing on the face that says which test this is —
    // a string "10" never equals a number 10 here, and that mismatch is exactly
    // what the run reports as an incomparable value.
    const numeric: WorkflowFilterPredicate = {
      kind: 'compare',
      column: 'qty',
      operator: 'greaterThan',
      value: 10,
    };

    expect(describeFilterPredicate(numeric)).toBe('qty > 10');
  });

  it('joins a group with its own word and parenthesises only when nested', () => {
    const nested: WorkflowFilterPredicate = {
      kind: 'all',
      children: [
        { kind: 'compare', column: 'status', operator: 'equals', value: 'OPEN' },
        {
          kind: 'any',
          children: [
            { kind: 'compare', column: 'qty', operator: 'greaterThan', value: 0 },
            { kind: 'present', column: 'backorder', operator: 'isNotNull' },
          ],
        },
      ],
    };

    expect(describeFilterPredicate(nested)).toBe(
      'status = "OPEN" and (qty > 0 or backorder has a value)',
    );
  });

  it('reads a list as membership', () => {
    const oneOf: WorkflowFilterPredicate = {
      kind: 'oneOf',
      column: 'base',
      operator: 'notIn',
      values: ['21st', '509th'],
    };

    expect(describeFilterPredicate(oneOf)).toBe('base is none of "21st", "509th"');
  });
});

describe('what a run panel says a filter removed', () => {
  it('reports the pair and the share', () => {
    expect(describeDrop({ nodeId: 'keep', status: 'succeeded', rows: 96, rowsIn: 7637 })).toBe(
      '7637 rows in, 96 out — 7541 dropped (98.7%)',
    );
  });

  it('says so plainly when nothing was dropped', () => {
    expect(describeDrop({ nodeId: 'keep', status: 'succeeded', rows: 10, rowsIn: 10 })).toBe(
      '10 rows in, none dropped',
    );
  });

  it('says nothing at all for a node that never reported an input count', () => {
    // THE ONE THAT MATTERS. Every source, sink, transform and gate lands here,
    // and so does a filter from before this was recorded. Answering for them
    // would put "dropped 100%" on a node that dropped nothing.
    expect(describeDrop({ nodeId: 'src', status: 'succeeded', rows: 7637 })).toBeUndefined();
    expect(describeDrop({ nodeId: 'keep', status: 'skipped', rowsIn: 10 })).toBeUndefined();
  });
});
