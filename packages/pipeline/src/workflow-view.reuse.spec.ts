import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { toGraph } from './workflow-view';

/**
 * What the HTTP boundary does with a version pin and a reusable reference.
 *
 * Checked here as well as in `validateWorkflow` because a **draft is stored
 * without validating** — that is the point of drafts — so this is the only gate
 * an unfinished graph passes through. It is the same argument `toCallNode` makes
 * one function up about a call saved with an empty version, pointed at the two
 * fields that arrived with reusable nodes.
 *
 * The failure being avoided is specifically a *silent* one. A dropped `useId`
 * stores a node that looks identical and is not the same node: the graph keeps
 * running, and it stops appearing in the count of what uses that reusable node —
 * so the next person editing it is told nobody is downstream.
 */

const SINK = { id: 'sink', name: 'Mvr', kind: 'sink', targetType: 'Mvr' };
const SOURCE = {
  id: 'src',
  name: 'Warehouse',
  kind: 'source',
  sourceKind: 'sql',
  config: { query: 'select 1' },
};
const TRANSFORM = { id: 'shape', name: 'Shape', kind: 'transform', transformId: 'tx-1' };

describe('a graph arriving over HTTP', () => {
  it('carries neither key when nothing pins and nothing is shared', () => {
    const { nodes } = toGraph({ nodes: [SOURCE, TRANSFORM, SINK] });

    // Absent keys rather than present-and-undefined, because this array is
    // JSON-stringified into a column: `{ useId: undefined }` and `{}` are the
    // same object to the validator and different bytes on disk.
    for (const node of nodes) {
      expect(Object.hasOwn(node, 'useId')).toBe(false);
      expect(Object.hasOwn(node, 'useVersion')).toBe(false);
    }
    expect(Object.hasOwn(nodes[1] ?? {}, 'transformVersion')).toBe(true);
    expect(nodes[1]).toMatchObject({ transformId: 'tx-1', transformVersion: undefined });
  });

  it('keeps a reference that follows the latest, and one that is pinned', () => {
    const { nodes } = toGraph({
      nodes: [
        { ...SOURCE, useId: 'lib-1' },
        { ...SINK, useId: 'lib-2', useVersion: 3 },
      ],
    });

    expect(nodes[0]).toMatchObject({ useId: 'lib-1' });
    expect(Object.hasOwn(nodes[0] ?? {}, 'useVersion')).toBe(false);
    expect(nodes[1]).toMatchObject({ useId: 'lib-2', useVersion: 3 });
  });

  it('keeps a transform pin, so a graph cannot be saved having lost one', () => {
    const { nodes } = toGraph({ nodes: [{ ...TRANSFORM, transformVersion: 4 }] });

    expect(nodes[0]).toMatchObject({ transformId: 'tx-1', transformVersion: 4 });
  });

  it('refuses a pin that arrived as a string, rather than coercing it', () => {
    // What an unparsed form field sends. Coerced, it would work; dropped, the
    // node would silently follow the latest. Refused, somebody fixes the field.
    expect(() => toGraph({ nodes: [{ ...TRANSFORM, transformVersion: '4' }] })).toThrow(
      BadRequestException,
    );
    expect(() => toGraph({ nodes: [{ ...SINK, useId: 'lib-2', useVersion: '3' }] })).toThrow(
      /a version is a whole number of at least 1/,
    );
  });

  it('refuses a zero and a fraction, which name no stored version either', () => {
    expect(() => toGraph({ nodes: [{ ...TRANSFORM, transformVersion: 0 }] })).toThrow(
      BadRequestException,
    );
    expect(() => toGraph({ nodes: [{ ...SOURCE, useId: 'lib-1', useVersion: 1.5 }] })).toThrow(
      BadRequestException,
    );
  });

  it('refuses a version pinned against no reference at all', () => {
    expect(() => toGraph({ nodes: [{ ...SOURCE, useVersion: 2 }] })).toThrow(
      /names no reusable node/,
    );
  });

  it('treats null as absent, which is what a round trip of an unset field is', () => {
    const { nodes } = toGraph({
      nodes: [
        { ...TRANSFORM, transformVersion: null },
        { ...SINK, useId: null, useVersion: null },
      ],
    });

    expect(nodes[0]).toMatchObject({ transformVersion: undefined });
    expect(Object.hasOwn(nodes[1] ?? {}, 'useId')).toBe(false);
  });
});
