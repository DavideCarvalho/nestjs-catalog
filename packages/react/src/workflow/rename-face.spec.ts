/**
 * What a rename says on the canvas without being opened.
 *
 * Runs in `node`, for the reason `filter-face.spec.ts` gives: these are pure
 * functions producing strings, and making the flakiest environment in this repo
 * responsible for a sentence would be a poor trade.
 *
 * WHAT IS PINNED HERE
 * -------------------
 * **The disposition is on the face.** A rename that also *deletes* every column
 * it does not name is a different node from one that does not, and a canvas
 * where the two look identical is a canvas where a column disappears from a
 * published type with nothing to point at. So `drops the rest` is part of the
 * subtitle rather than something you find in the inspector.
 *
 * **A half-typed node says so.** The node is born with one blank row, which the
 * validator refuses by name — but the validator's message is in the problems
 * list, and the face is what somebody is looking at. It has to admit that it is
 * not configured rather than drawing as a finished box that does nothing.
 */
import type { WorkflowNode } from '@dudousxd/nestjs-catalog/client';
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

function rename(columns: Record<string, string>, unnamed?: 'keep' | 'drop'): WorkflowNode {
  return { id: 'r', name: 'Headers', kind: 'rename', columns, unnamed, position: { x: 0, y: 0 } };
}

describe('a rename on the canvas', () => {
  it('spells the one rename out, because that is the whole content of it', () => {
    expect(faceOf(rename({ 'Mgmt Cd': 'mgmtCd' })).subtitle).toBe('Mgmt Cd → mgmtCd');
  });

  it('counts them once there are several', () => {
    expect(faceOf(rename({ 'Mgmt Cd': 'mgmtCd', 'Reg Number': 'regNumber' })).subtitle).toBe(
      'renames 2 columns',
    );
  });

  it('says out loud when it is also dropping everything else', () => {
    // The difference between a rename and a projection, on the face, because
    // the second one removes columns from what a sink commits.
    expect(faceOf(rename({ 'Mgmt Cd': 'mgmtCd' }, 'drop')).subtitle).toBe(
      'Mgmt Cd → mgmtCd, drops the rest',
    );
  });

  it('admits it is not configured rather than drawing as finished', () => {
    // What a node dropped from the palette looks like: one blank row. A face
    // that said nothing here would be a box that reads as complete and either
    // does nothing or deletes every column, depending on the disposition.
    expect(faceOf(rename({ '': '' })).subtitle).toBe('no columns named');
  });

  it('has a name in the palette and in every message that has to point at one', () => {
    expect(defaultLabel('rename')).toBe('Rename');
  });
});
