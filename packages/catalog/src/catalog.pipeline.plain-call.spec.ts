import { describe, expect, it } from 'vitest';
import {
  WORKFLOW_CALL_MODES,
  type WorkflowCallNode,
  type WorkflowGraph,
  type WorkflowIssueCode,
  type WorkflowNode,
  type WorkflowSinkNode,
  type WorkflowSourceNode,
  type WorkflowTransformNode,
  isWorkflowCallMode,
  isWorkflowNode,
  validateWorkflow,
  workflowCallMode,
  workflowGraphHash,
} from './catalog.pipeline';

function source(id: string, overrides: Partial<WorkflowSourceNode> = {}): WorkflowSourceNode {
  return { id, name: id, kind: 'source', sourceKind: 'inline', config: {}, ...overrides };
}

function transform(
  id: string,
  overrides: Partial<WorkflowTransformNode> = {},
): WorkflowTransformNode {
  return { id, name: id, kind: 'transform', transformId: 'tx-1', ...overrides };
}

function sink(id: string, overrides: Partial<WorkflowSinkNode> = {}): WorkflowSinkNode {
  return { id, name: id, kind: 'sink', targetType: 'Mvr', ...overrides };
}

function call(id: string, overrides: Partial<WorkflowCallNode> = {}): WorkflowCallNode {
  return {
    id,
    name: id,
    kind: 'call',
    callName: 'flip.processing',
    callVersion: '1',
    config: { proc: 'mvr' },
    ...overrides,
  };
}

/** A call that sends its config bare. The node this whole file is about. */
function plainCall(id: string, overrides: Partial<WorkflowCallNode> = {}): WorkflowCallNode {
  return call(id, { callMode: 'plain', ...overrides });
}

function graph(nodes: WorkflowNode[], edges: Array<[string, string]>): WorkflowGraph {
  return { nodes, edges: edges.map(([from, to]) => ({ from, to })) };
}

function codes(issues: Array<{ code: WorkflowIssueCode }>): WorkflowIssueCode[] {
  return issues.map((issue) => issue.code);
}

describe('the call mode vocabulary', () => {
  it.each(WORKFLOW_CALL_MODES)('accepts the mode %s', (mode) => {
    expect(isWorkflowCallMode(mode)).toBe(true);
  });

  it.each([undefined, null, '', 'Envelope', 'flat', 'bare', 0, {}, ['plain']])(
    'refuses %o as a call mode',
    (value) => {
      expect(isWorkflowCallMode(value)).toBe(false);
    },
  );

  // One default, applied in one place. A second `?? 'envelope'` somewhere else
  // is how the runner and the hash come to disagree about what a stored node is.
  it('reads an absent mode as the envelope, which is what every stored node is', () => {
    expect(workflowCallMode(call('c'))).toBe('envelope');
    expect(workflowCallMode(call('c', { callMode: 'envelope' }))).toBe('envelope');
    expect(workflowCallMode(plainCall('c'))).toBe('plain');
  });

  it('throws on a mode nothing has a rule for, naming where it was asked', () => {
    // The run-time half of the exhaustiveness guard, exercised down the path it
    // actually guards: a graph out of a JSON column, written by a build that
    // knew a mode this one does not. Parsed rather than constructed, because
    // that is precisely how such a node arrives and because the type system is
    // not what is being tested here.
    const stored: WorkflowGraph = JSON.parse(
      JSON.stringify({
        nodes: [{ ...call('c'), callMode: 'rpc' }, sink('out')],
        edges: [],
      }),
    );
    // It throws rather than falling back to the envelope, because a fallback
    // would put a payload nobody authored on the wire.
    expect(() => workflowGraphHash(stored)).toThrow(/workflowGraphHash.*"rpc"/s);
  });
});

describe('reading a call node back out of storage', () => {
  it('accepts one with no mode at all', () => {
    expect(isWorkflowNode(call('c'))).toBe(true);
  });

  it.each(WORKFLOW_CALL_MODES)('accepts one that names the mode %s', (mode) => {
    expect(isWorkflowNode(call('c', { callMode: mode }))).toBe(true);
  });

  // Refused rather than dropped. Reading an unrecognised mode back as the
  // default would wrap a config that was authored to travel bare, and the
  // callee would die on the first key it looked for inside a child run.
  it('refuses one whose mode this build has no rule for', () => {
    expect(isWorkflowNode({ ...call('c'), callMode: 'flat' })).toBe(false);
    expect(isWorkflowNode({ ...call('c'), callMode: 1 })).toBe(false);
    expect(isWorkflowNode({ ...call('c'), callMode: null })).toBe(false);
  });
});

describe('validateWorkflow refuses a plain call anything downstream', () => {
  // The rule, and the reason the whole feature is safe to have: a plain call is
  // told no run id and no node id, so it can never stage rows — and every node
  // that can sit downstream of a call consumes rows and nothing else.
  it('refuses a plain call wired into a sink', () => {
    const issues = validateWorkflow(
      graph(
        [source('src'), sink('out'), plainCall('c')],
        [
          ['src', 'out'],
          ['c', 'out'],
        ],
      ),
    );
    expect(codes(issues)).toContain('call-plain-has-output');
  });

  it('refuses a plain call wired into a transform', () => {
    const issues = validateWorkflow(
      graph(
        [source('src'), transform('tx'), sink('out'), plainCall('c')],
        [
          ['src', 'tx'],
          ['tx', 'out'],
          ['c', 'tx'],
        ],
      ),
    );
    expect(codes(issues)).toContain('call-plain-has-output');
  });

  it('names the node, everything it feeds, and why it cannot', () => {
    const issues = validateWorkflow(
      graph(
        [source('src'), transform('tx'), sink('out'), plainCall('c', { name: 'Run processing' })],
        [
          ['src', 'out'],
          ['c', 'tx'],
          ['tx', 'out'],
        ],
      ),
    );
    const refusal = issues.find((issue) => issue.code === 'call-plain-has-output');
    expect(refusal?.nodeIds).toEqual(['c', 'tx']);
    // A message that only said no would leave the author to guess whether the
    // fix is a different wire, a different workflow or a different mode.
    expect(refusal?.message).toContain('Run processing');
    expect(refusal?.message).toContain('"tx"');
    expect(refusal?.message).toContain('no run id and no node id');
    expect(refusal?.message).toContain('zero');
    expect(refusal?.message).toContain('envelope');
  });

  // The failure this exists to stop, stated as a test: without the refusal the
  // graph below saves, publishes, runs, reports success and commits nothing.
  it('refuses a graph whose only thing that reads is a plain call', () => {
    const issues = validateWorkflow(graph([plainCall('c'), sink('out')], [['c', 'out']]));
    expect(codes(issues)).toContain('call-plain-has-output');
    // And it would still be refused with the wiring rule deleted, because a
    // plain call is no longer something that reads.
    expect(codes(validateWorkflow(graph([plainCall('c'), sink('out')], [])))).toContain(
      'no-source',
    );
  });

  it('still lets an envelope call be the thing that reads', () => {
    // Unchanged, and the reason `originatesRows` had to be split rather than
    // narrowed: the workflow an envelope call hands off to may itself read.
    expect(validateWorkflow(graph([call('c'), sink('out')], [['c', 'out']]))).toEqual([]);
  });
});

describe('validateWorkflow accepts the shapes a plain call is for', () => {
  it('accepts one hanging off a source that also reaches the sink', () => {
    // The ordering shape: the effect runs after the source, and the source is
    // what the load actually commits.
    expect(
      validateWorkflow(
        graph(
          [source('src'), sink('out'), plainCall('c')],
          [
            ['src', 'out'],
            ['src', 'c'],
          ],
        ),
      ),
    ).toEqual([]);
  });

  it('accepts one with nothing wired to it at all', () => {
    // It sits at in-degree zero and is dispatched like anything else, so
    // reporting it as never running would simply be untrue. This is why the
    // reachability root set is `runsWithoutInput` and not `originatesRows`.
    expect(
      validateWorkflow(graph([source('src'), sink('out'), plainCall('c')], [['src', 'out']])),
    ).toEqual([]);
  });

  it('does not report it as a dead end for reaching no sink', () => {
    const issues = validateWorkflow(
      graph([source('src'), sink('out'), plainCall('c')], [['src', 'out']]),
    );
    expect(codes(issues)).not.toContain('dead-end');
  });

  // The exemption is one node wide. A source whose only outbound edge is a
  // plain call really would fetch rows and drop them, and that is still refused
  // — pointed at the source, which is the box to go and look at.
  it('still refuses a source whose only route out is a plain call', () => {
    const issues = validateWorkflow(
      graph(
        [source('src'), source('other'), sink('out'), plainCall('c')],
        [
          ['src', 'c'],
          ['other', 'out'],
        ],
      ),
    );
    const deadEnd = issues.find((issue) => issue.code === 'dead-end');
    expect(deadEnd?.nodeIds).toEqual(['src']);
  });

  it('still refuses a graph of plain calls with no sink', () => {
    expect(codes(validateWorkflow(graph([plainCall('c')], [])))).toContain('no-sink');
  });
});

describe('workflowGraphHash and the stored graphs it must not renumber', () => {
  // The whole backward-compatibility claim, pinned to a literal. These two
  // strings were computed from `origin/main` before any of this existed; a
  // deployment picking up this release must not see a single graph's version
  // move, and a hash component appended unconditionally would move all of them.
  it.each<[string, string, WorkflowGraph]>([
    [
      'a call into a sink',
      '88f84591b4986fd3',
      graph(
        [
          {
            id: 'c',
            name: 'c',
            kind: 'call',
            callName: 'billing.reconcile',
            callVersion: '1',
            config: {},
          },
          sink('out'),
        ],
        [['c', 'out']],
      ),
    ],
    [
      'a source through a transform into a sink',
      '45d5af32d8af3680',
      graph(
        [source('src'), transform('tx'), sink('out')],
        [
          ['src', 'tx'],
          ['tx', 'out'],
        ],
      ),
    ],
  ])('hashes %s to exactly what it always did', (_what, expected, stored) => {
    expect(workflowGraphHash(stored)).toBe(expected);
  });

  // Two spellings of one behaviour. A canvas that normalises the field must not
  // make a graph nobody edited look edited — the opposite choice from
  // `canonicalReuse`, where absent and present genuinely differ.
  it('does not change when an envelope call says so out loud', () => {
    const implicit = graph([call('c'), sink('out')], [['c', 'out']]);
    const explicit = graph([call('c', { callMode: 'envelope' }), sink('out')], [['c', 'out']]);
    expect(workflowGraphHash(explicit)).toBe(workflowGraphHash(implicit));
  });

  it('changes when a call is switched to plain', () => {
    // It changes what the child receives, so it is a new version of the graph
    // and the runs that used the old one stay identifiable.
    const before = graph([call('c'), sink('out')], [['c', 'out']]);
    const after = graph([plainCall('c'), sink('out')], [['c', 'out']]);
    expect(workflowGraphHash(after)).not.toBe(workflowGraphHash(before));
  });

  it('survives the JSON round trip a stored graph makes', () => {
    const revived: WorkflowGraph = JSON.parse(
      JSON.stringify(graph([plainCall('c'), sink('out')], [])),
    );
    expect(workflowGraphHash(revived)).toBe(
      workflowGraphHash(graph([plainCall('c'), sink('out')], [])),
    );
  });
});
