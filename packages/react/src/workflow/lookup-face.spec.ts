/**
 * What a lookup says on the canvas without being opened.
 *
 * Runs in `node`, for the reason `rename-face.spec.ts` gives: these are pure
 * functions producing strings.
 *
 * WHAT IS PINNED HERE
 * -------------------
 * **The key pair gets the room, not the field list.** A lookup that is wrong is
 * almost never wrong about which columns it wanted — it is wrong about the two
 * columns it matches on, because those are the ones that have to agree between
 * two systems that have never met. `planId = Plan ID` readable off the canvas is
 * the difference between spotting that and opening every node in the graph.
 *
 * **A disposition that removes rows is on the face.** `drop` means this node also
 * filters, and a box that removes rows without saying so is the accident
 * `WorkflowFilterNode.narrows` exists about, one kind over.
 *
 * **A half-typed node says so**, rather than drawing as a finished box that
 * matches nothing.
 */
import type { WorkflowLookupUnmatched, WorkflowNode } from '@dudousxd/nestjs-catalog/client';
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

function lookup(
  fields: Record<string, string>,
  unmatched?: WorkflowLookupUnmatched,
  key = 'planId',
  referenceKey = 'Plan ID',
): WorkflowNode {
  return {
    id: 'l',
    name: 'Plan names',
    kind: 'lookup',
    reference: 'plans',
    key,
    referenceKey,
    fields,
    unmatched,
    position: { x: 0, y: 0 },
  };
}

describe('a lookup on the canvas', () => {
  it('spells the key pair out, and names the one field it brings across', () => {
    expect(faceOf(lookup({ 'Plan Name': 'planName' })).subtitle).toBe('planId = Plan ID +planName');
  });

  it('counts the fields once there are several, but never the keys', () => {
    // The keys stay spelled out at every size. They are the part that goes wrong.
    expect(
      faceOf(lookup({ 'Plan Name': 'planName', 'Plan Desc': 'planDescription' })).subtitle,
    ).toBe('planId = Plan ID +2 fields');
  });

  it('says out loud when it is also dropping rows', () => {
    expect(faceOf(lookup({ 'Plan Name': 'planName' }, 'drop')).subtitle).toBe(
      'planId = Plan ID +planName, drops misses',
    );
  });

  it('says out loud when a missing reference row stops the run', () => {
    expect(faceOf(lookup({ 'Plan Name': 'planName' }, 'fail')).subtitle).toBe(
      'planId = Plan ID +planName, fails on a miss',
    );
  });

  it('admits it has no key rather than drawing as finished', () => {
    // What a node dropped from the palette looks like: every field blank. A face
    // that said nothing here would read as complete and match nothing on every
    // row, which is the failure this node kind exists to end.
    expect(faceOf(lookup({ '': '' }, undefined, '', '')).subtitle).toBe('no key chosen');
  });

  it('says it has a key but nothing to bring across, which is the other blank half', () => {
    expect(faceOf(lookup({ '': '' })).subtitle).toBe('planId = Plan ID, no fields');
  });

  it('has a name in the palette and in every message that has to point at one', () => {
    expect(defaultLabel('lookup')).toBe('Lookup');
  });
});
