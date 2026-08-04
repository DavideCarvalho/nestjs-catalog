import type { WorkflowStageRef } from '@dudousxd/nestjs-catalog';
import { describe, expect, it } from 'vitest';
import { capLines, newSnapshotId, stageRefsFor } from './workflow-runner.service';

function ref(nodeId: string, overrides: Partial<WorkflowStageRef> = {}): WorkflowStageRef {
  return { runId: 'run-1', nodeId, batches: 2, rowCount: 900, ...overrides };
}

describe('stageRefsFor', () => {
  it('hands back the refs its upstream nodes produced', () => {
    const stages = new Map([
      ['a', ref('a')],
      ['b', ref('b')],
    ]);
    expect(stageRefsFor(['a', 'b'], stages, 'run-1')).toEqual([ref('a'), ref('b')]);
  });

  // The order of `inputs` is edge order — what a merge node reads its inputs
  // in. Iterating the stage map instead would produce insertion order, which is
  // the order the nodes finished rather than the order they were wired.
  it('follows the edge order it was given, not the order the stages arrived', () => {
    const stages = new Map([
      ['a', ref('a')],
      ['b', ref('b')],
    ]);
    expect(stageRefsFor(['b', 'a'], stages, 'run-1').map((r) => r.nodeId)).toEqual(['b', 'a']);
  });

  // A node whose upstream produced nothing gets an empty ref rather than being
  // left out: dropping it would shift every later input by one position, and a
  // merge would read the wrong branch with no error anywhere.
  it('keeps the position of an upstream node that produced nothing', () => {
    const stages = new Map([['c', ref('c')]]);
    const refs = stageRefsFor(['a', 'c'], stages, 'run-7');
    expect(refs).toHaveLength(2);
    expect(refs[0]).toEqual({ runId: 'run-7', nodeId: 'a', batches: 0, rowCount: 0 });
    expect(refs[1]).toEqual(ref('c'));
  });

  it('stamps the placeholder with the run it belongs to', () => {
    // The ref is an address in the stage store; a wrong run id would point at
    // another run's rows rather than at nothing.
    const [placeholder] = stageRefsFor(['a'], new Map(), 'run-9');
    expect(placeholder?.runId).toBe('run-9');
  });

  it('gives a source node no inputs to read', () => {
    expect(stageRefsFor([], new Map(), 'run-1')).toEqual([]);
  });
});

describe('capLines', () => {
  // Both axes, and that is the point: capping the count alone still let a
  // single line naming every record it received put ~10KB into a step's output
  // checkpoint — and it grew with the data, which is what a step boundary must
  // never do.
  it('drops the lines past the cap', () => {
    expect(capLines(['a', 'b', 'c'], 2)).toEqual(['a', 'b']);
  });

  it('leaves a shorter run of lines alone', () => {
    expect(capLines(['a', 'b'], 5)).toEqual(['a', 'b']);
    expect(capLines([], 5)).toEqual([]);
  });

  it('truncates a long line and says by how much', () => {
    const capped = capLines(['x'.repeat(30)], 5, 10);
    expect(capped[0]).toBe(`${'x'.repeat(10)}… (20 more characters)`);
  });

  // A line that was silently cut looks like a transform that stopped
  // mid-sentence, which is a bug report about the wrong thing.
  it('says nothing about a line that fits exactly', () => {
    expect(capLines(['x'.repeat(10)], 5, 10)).toEqual(['x'.repeat(10)]);
  });

  it('truncates a line one character over the limit', () => {
    expect(capLines(['x'.repeat(11)], 5, 10)).toEqual([`${'x'.repeat(10)}… (1 more characters)`]);
  });

  it('applies both caps at once', () => {
    const capped = capLines(['x'.repeat(30), 'y'.repeat(30), 'z'], 2, 10);
    expect(capped).toHaveLength(2);
    expect(capped[0]).toContain('more characters');
  });

  it('has a default line length, so a caller cannot forget the second axis', () => {
    const capped = capLines(['x'.repeat(1000)], 5);
    expect(capped[0]?.length).toBeLessThan(500);
  });
});

describe('newSnapshotId', () => {
  it('keeps the prefix, so a run id says what produced it', () => {
    expect(newSnapshotId('wf-42')).toMatch(/^wf-42-[0-9a-f]{8}$/);
  });

  it('is different every time — a reused id would address another run’s stages', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newSnapshotId('wf')));
    expect(ids.size).toBe(200);
  });
});
