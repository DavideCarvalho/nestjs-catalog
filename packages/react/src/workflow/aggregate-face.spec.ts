/**
 * What an aggregate says on the canvas without being opened.
 *
 * Runs in `node`, for the reason `rename-face.spec.ts` gives: these are pure
 * functions producing strings, and making the flakiest environment in this repo
 * responsible for a sentence would be a poor trade.
 *
 * WHAT IS PINNED HERE
 * -------------------
 * **The group-by columns are spelled out, and the aggregates are counted.** That
 * asymmetry is the point. `by workOrderId, assetId` says what one output row
 * *is*, and it is also the only thing on the canvas that can make somebody
 * suspicious of a grouping before they run it — an aggregate grouped on
 * something near-unique holds the whole load, and the column name is the tell.
 * Forty-nine function names, by contrast, do not fit on a box and the inspector
 * is one click away.
 *
 * **A half-typed node says so.** The node is born with one blank group-by column
 * and one blank aggregate, both of which the validator refuses by name — but the
 * validator's message is in the problems list and the face is what somebody is
 * looking at. The two empty states are the most destructive in the file, so the
 * face has to admit to them rather than drawing as a finished box.
 */
import type { WorkflowAggregate, WorkflowNode } from '@dudousxd/nestjs-catalog/client';
import { describe, expect, it } from 'vitest';
import { defaultLabel, toFlowNodes } from './graph';

const DESCRIBE = {
  transformName: () => undefined,
  connectionName: () => undefined,
};

function faceOf(node: WorkflowNode): { label: string; subtitle: string } {
  const [drawn] = toFlowNodes([node], [], DESCRIBE, new Map(), new Map());
  if (!drawn) throw new Error('No flow node came back');
  return { label: drawn.data.label, subtitle: drawn.data.subtitle };
}

function aggregate(groupBy: string[], aggregates: WorkflowAggregate[]): WorkflowNode {
  return {
    id: 'agg',
    name: 'Build wo',
    kind: 'aggregate',
    groupBy,
    aggregates,
    position: { x: 0, y: 0 },
  };
}

describe('an aggregate on the canvas', () => {
  it('spells the grouping out, because that is what one output row is', () => {
    expect(
      faceOf(
        aggregate(
          ['workOrderId', 'assetId'],
          [
            { as: 'cost', fn: 'sum', column: 'actualLaborCost' },
            { as: 'lines', fn: 'count' },
          ],
        ),
      ).subtitle,
    ).toBe('by workOrderId, assetId → 2 values');
  });

  it('counts one aggregate in the singular, because the commonest node has one', () => {
    expect(faceOf(aggregate(['unit'], [{ as: 'lines', fn: 'count' }])).subtitle).toBe(
      'by unit → 1 value',
    );
  });

  it('admits to the empty state that would commit exactly one row', () => {
    // What a node dropped from the palette looks like. A face that said nothing
    // here would be a box reading as complete whose run commits a single row
    // whether the source held everything or nothing.
    expect(faceOf(aggregate([''], [{ as: '', fn: 'count' }])).subtitle).toBe(
      'no columns to group on',
    );
  });

  it('admits to the empty state that would drop every other column', () => {
    // The other direction, and it is a different sentence because it is a
    // different mistake: the grouping is fine and nothing is being computed, so
    // what commits is the distinct group keys and nothing else.
    expect(faceOf(aggregate(['workOrderId'], [{ as: '', fn: 'count' }])).subtitle).toBe(
      'by workOrderId, computing nothing',
    );
  });

  it('has a name in the palette and in every message that has to point at one', () => {
    expect(defaultLabel('aggregate')).toBe('Aggregate');
  });
});
