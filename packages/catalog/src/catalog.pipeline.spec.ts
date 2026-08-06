import { describe, expect, it } from 'vitest';
import {
  CONNECTOR_KINDS,
  type CallableWorkflowRef,
  type CatalogPipelineStore,
  TRANSFORM_LANGUAGES,
  WORKFLOW_EXECUTION_MODES,
  WORKFLOW_NODE_KINDS,
  type WorkflowCallNode,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowIssueCode,
  type WorkflowNode,
  type WorkflowSinkNode,
  type WorkflowSourceNode,
  type WorkflowTransformNode,
  callableWorkflowBlock,
  isConnectorKind,
  isPipelineStore,
  isTransformLanguage,
  isWorkflowEdge,
  isWorkflowExecutionMode,
  isWorkflowNode,
  isWorkflowNodeKind,
  readWorkflowCallOutput,
  supportsWorkflowStages,
  supportsWorkflows,
  validateWorkflow,
  workflowGraphHash,
  workflowRunOrder,
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
    callName: 'billing.reconcile',
    callVersion: '1',
    config: {},
    ...overrides,
  };
}

function graph(nodes: WorkflowNode[], edges: Array<[string, string]>): WorkflowGraph {
  return { nodes, edges: edges.map(([from, to]) => ({ from, to })) };
}

function codes(issues: Array<{ code: WorkflowIssueCode }>): WorkflowIssueCode[] {
  return issues.map((issue) => issue.code);
}

/** src → tx → out. The smallest graph that is actually runnable. */
const runnable = graph(
  [source('src'), transform('tx'), sink('out')],
  [
    ['src', 'tx'],
    ['tx', 'out'],
  ],
);

describe('validateWorkflow', () => {
  it('accepts a graph that runs', () => {
    expect(validateWorkflow(runnable)).toEqual([]);
  });

  // An empty graph would commit an empty snapshot over whatever is live, which
  // is the one failure that looks like a successful run.
  it('refuses an empty graph on its own', () => {
    const issues = validateWorkflow({ nodes: [], edges: [] });
    expect(codes(issues)).toEqual(['empty']);
  });

  it('survives a graph with the arrays missing entirely', () => {
    // Graphs arrive out of a JSON column and off the wire, so the fields a
    // caller forgot must produce an issue rather than a TypeError.
    const partial: WorkflowGraph = Object.create(null);
    expect(codes(validateWorkflow(partial))).toEqual(['empty']);
  });

  describe('structural problems are reported alone', () => {
    // Reachability computed over edges that point at nothing produces a second
    // page of consequences, and the one real problem is then buried.
    it('does not report reachability once an edge names a node that is gone', () => {
      const issues = validateWorkflow(
        graph(
          [source('src'), transform('tx'), sink('out')],
          [
            ['src', 'ghost'],
            ['tx', 'out'],
          ],
        ),
      );
      expect(codes(issues)).toEqual(['edge-endpoint-missing']);
      expect(issues[0]?.message).toContain('ghost');
    });

    it('names the endpoint that is missing, not the one that is present', () => {
      const issues = validateWorkflow(graph([source('src')], [['ghost', 'src']]));
      expect(issues[0]?.message).toContain('names node "ghost"');
    });

    // A node with an unusable id is still registered, so the edges touching it
    // report ONE problem — the id — rather than sending the reader hunting for
    // a node they can plainly see on the canvas.
    it('reports an unusable node id without also calling it missing', () => {
      const issues = validateWorkflow(
        graph([source('has space'), sink('out')], [['has space', 'out']]),
      );
      expect(codes(issues)).toEqual(['invalid-node-id']);
    });

    it.each([
      ['', 'empty'],
      ['a'.repeat(65), 'longer than 64 characters'],
      ['node:1', 'a separator'],
      ['node.1', 'a dot'],
      ['nó', 'a non-ASCII letter'],
    ])('refuses the node id %o (%s)', (id) => {
      expect(codes(validateWorkflow(graph([source(id), sink('out')], [[id, 'out']])))).toContain(
        'invalid-node-id',
      );
    });

    it('accepts the full 64-character alphabet a node id may use', () => {
      const id = `${'a'.repeat(60)}_-9Z`;
      expect(codes(validateWorkflow(graph([source(id), sink('out')], [[id, 'out']])))).toEqual([]);
    });

    it('reports a duplicate node id', () => {
      const issues = validateWorkflow(graph([source('src'), sink('src')], []));
      expect(codes(issues)).toEqual(['duplicate-node-id']);
    });

    it('reports a node wired to itself', () => {
      const issues = validateWorkflow(
        graph([source('src'), transform('tx'), sink('out')], [['tx', 'tx']]),
      );
      expect(codes(issues)).toEqual(['self-edge']);
    });

    // The same wire twice would hand the downstream node the same rows twice
    // and silently double its input — no error, just wrong numbers.
    it('reports the same wire drawn twice', () => {
      const issues = validateWorkflow(
        graph(
          [source('src'), transform('tx'), sink('out')],
          [
            ['src', 'tx'],
            ['src', 'tx'],
            ['tx', 'out'],
          ],
        ),
      );
      expect(codes(issues)).toEqual(['duplicate-edge']);
    });

    it('does not mistake the reverse wire for a duplicate', () => {
      // a→b and b→a is a cycle, not a duplicate. Keying the seen-set on an
      // unordered pair would report the wrong problem.
      const issues = validateWorkflow(
        graph(
          [source('src'), transform('a'), transform('b'), sink('out')],
          [
            ['src', 'a'],
            ['a', 'b'],
            ['b', 'a'],
            ['b', 'out'],
          ],
        ),
      );
      expect(codes(issues)).toContain('cycle');
      expect(codes(issues)).not.toContain('duplicate-edge');
    });
  });

  describe('cycles', () => {
    // Kahn's algorithm leaves the loop PLUS everything downstream of it. Naming
    // the tail points at nodes that are perfectly well wired and merely stuck,
    // and a message that names the wrong node is worse than a vague one.
    it('names only the nodes on the loop, not the ones stuck behind it', () => {
      const issues = validateWorkflow(
        graph(
          [source('src'), transform('a'), transform('b'), transform('tail'), sink('out')],
          [
            ['src', 'a'],
            ['a', 'b'],
            ['b', 'a'],
            ['b', 'tail'],
            ['tail', 'out'],
          ],
        ),
      );
      const cycle = issues.find((issue) => issue.code === 'cycle');
      expect(cycle?.nodeIds.sort()).toEqual(['a', 'b']);
      expect(cycle?.nodeIds).not.toContain('tail');
      expect(cycle?.nodeIds).not.toContain('out');
    });

    // A cycle makes every node behind it look unreachable, which points at the
    // wrong boxes — so validation stops at the cycle.
    it('reports nothing about reachability once a cycle is found', () => {
      const issues = validateWorkflow(
        graph(
          [source('src'), transform('a'), transform('b'), sink('out')],
          [
            ['src', 'out'],
            ['a', 'b'],
            ['b', 'a'],
          ],
        ),
      );
      expect(codes(issues)).toEqual(['cycle']);
    });
  });

  describe('sources and sinks', () => {
    it('refuses a graph with no source', () => {
      expect(
        codes(validateWorkflow(graph([transform('tx'), sink('out')], [['tx', 'out']]))),
      ).toContain('no-source');
    });

    it('refuses a graph with no sink', () => {
      expect(
        codes(validateWorkflow(graph([source('src'), transform('tx')], [['src', 'tx']]))),
      ).toContain('no-sink');
    });

    it('refuses an inbound edge into a source', () => {
      const issues = validateWorkflow(
        graph(
          [source('src'), transform('tx'), sink('out')],
          [
            ['tx', 'src'],
            ['src', 'out'],
          ],
        ),
      );
      expect(codes(issues)).toContain('source-has-input');
    });

    it('refuses an outbound edge from a sink', () => {
      const issues = validateWorkflow(
        graph(
          [source('src'), sink('out'), transform('after')],
          [
            ['src', 'out'],
            ['out', 'after'],
          ],
        ),
      );
      expect(codes(issues)).toContain('sink-has-output');
    });

    // Several sinks are the point of having a graph: one expensive read feeding
    // several outputs. Forbidding them would mean pulling the same rows twice.
    it('allows two sinks that write different types', () => {
      const issues = validateWorkflow(
        graph(
          [source('src'), sink('mvr'), sink('subwo', { targetType: 'Subwo' })],
          [
            ['src', 'mvr'],
            ['src', 'subwo'],
          ],
        ),
      );
      expect(issues).toEqual([]);
    });

    // Two snapshots of one type in one run leaves nothing to say which of them
    // the readers should get.
    it('refuses two sinks that write the same type, naming both', () => {
      const issues = validateWorkflow(
        graph(
          [source('src'), sink('one'), sink('two')],
          [
            ['src', 'one'],
            ['src', 'two'],
          ],
        ),
      );
      const duplicate = issues.find((issue) => issue.code === 'duplicate-sink-type');
      expect(duplicate?.nodeIds.sort()).toEqual(['one', 'two']);
      expect(duplicate?.message).toContain('Mvr');
    });
  });

  it('refuses a transform node that names no transform', () => {
    const issues = validateWorkflow(
      graph(
        [source('src'), transform('tx', { transformId: '' }), sink('out')],
        [
          ['src', 'tx'],
          ['tx', 'out'],
        ],
      ),
    );
    expect(codes(issues)).toEqual(['transform-not-named']);
  });

  // A box on the canvas that silently does nothing is exactly what these two
  // checks exist to prevent.
  it('refuses a node no source reaches', () => {
    const issues = validateWorkflow(
      graph(
        [source('src'), transform('orphan'), sink('out')],
        [
          ['src', 'out'],
          ['orphan', 'out'],
        ],
      ),
    );
    expect(codes(issues)).toEqual(['unreachable']);
    expect(issues[0]?.nodeIds).toEqual(['orphan']);
  });

  it('refuses a node whose rows never reach a sink', () => {
    const issues = validateWorkflow(
      graph(
        [source('src'), transform('nowhere'), sink('out')],
        [
          ['src', 'out'],
          ['src', 'nowhere'],
        ],
      ),
    );
    expect(codes(issues)).toEqual(['dead-end']);
    expect(issues[0]?.nodeIds).toEqual(['nowhere']);
  });

  it('reports one problem per node rather than both', () => {
    // A node wired to nothing at all is unreachable AND a dead end. Saying so
    // twice about the same box is noise.
    const issues = validateWorkflow(
      graph([source('src'), transform('lonely'), sink('out')], [['src', 'out']]),
    );
    expect(codes(issues)).toEqual(['unreachable']);
  });

  it('every issue except the whole-graph ones names a node to go and look at', () => {
    const issues = validateWorkflow(
      graph(
        [source('src'), transform('tx', { transformId: '' }), sink('out')],
        [
          ['src', 'tx'],
          ['tx', 'out'],
        ],
      ),
    );
    for (const issue of issues) {
      expect(issue.nodeIds.length).toBeGreaterThan(0);
      expect(issue.message.length).toBeGreaterThan(0);
    }
  });
});

describe('a node that calls another workflow', () => {
  // The half people leave blank, and the half that decides which code runs.
  it('refuses a call that names a workflow but no version', () => {
    const issues = validateWorkflow(
      graph([call('c', { callVersion: '' }), sink('out')], [['c', 'out']]),
    );
    expect(codes(issues)).toEqual(['call-not-named']);
    expect(issues[0].message).toContain('version');
    expect(issues[0].nodeIds).toEqual(['c']);
  });

  it('refuses a call that names no workflow at all', () => {
    const issues = validateWorkflow(
      graph([call('c', { callName: '' }), sink('out')], [['c', 'out']]),
    );
    expect(codes(issues)).toEqual(['call-not-named']);
  });

  // A called workflow may itself read from a system, so `call → sink` is a real
  // pipeline. Reporting `no-source` on it would be false, and would send
  // somebody to add a source node they do not need.
  it('counts as something that reads, so it can be the start of a graph', () => {
    expect(validateWorkflow(graph([call('c'), sink('out')], [['c', 'out']]))).toEqual([]);
  });

  // The other half of counting as a root: everything downstream of a call is
  // reachable. Leaving calls out of the root set would flag a perfectly wired
  // graph as unreachable at every node after the call.
  it('makes what it feeds reachable', () => {
    expect(
      validateWorkflow(
        graph(
          [call('c'), transform('tx'), sink('out')],
          [
            ['c', 'tx'],
            ['tx', 'out'],
          ],
        ),
      ),
    ).toEqual([]);
  });

  // What is NOT weakened: a graph still needs something that reads and
  // something that commits.
  it('does not make a graph of transforms alone runnable', () => {
    expect(codes(validateWorkflow(graph([transform('tx'), sink('out')], [['tx', 'out']])))).toEqual(
      ['no-source'],
    );
  });

  it('may sit mid-graph, taking rows in and passing rows on', () => {
    expect(
      validateWorkflow(
        graph(
          [source('src'), call('c'), sink('out')],
          [
            ['src', 'c'],
            ['c', 'out'],
          ],
        ),
      ),
    ).toEqual([]);
  });
});

describe('workflowRunOrder', () => {
  // A partial order over a broken graph is a load that half-happens, which is
  // harder to recover from than one that never started.
  it('refuses an invalid graph instead of returning a best effort', () => {
    expect(() => workflowRunOrder(graph([transform('tx')], []))).toThrow(
      /Refusing to order an invalid workflow/,
    );
  });

  it('puts every node after everything wired into it', () => {
    const diamond = graph(
      [source('src'), transform('left'), transform('right'), transform('merge'), sink('out')],
      [
        ['src', 'left'],
        ['src', 'right'],
        ['left', 'merge'],
        ['right', 'merge'],
        ['merge', 'out'],
      ],
    );
    const order = workflowRunOrder(diamond).map((entry) => entry.node.id);
    for (const [from, to] of [
      ['src', 'left'],
      ['src', 'right'],
      ['left', 'merge'],
      ['right', 'merge'],
      ['merge', 'out'],
    ]) {
      expect(order.indexOf(String(from))).toBeLessThan(order.indexOf(String(to)));
    }
    expect(order).toHaveLength(5);
    expect(order[0]).toBe('src');
    expect(order.at(-1)).toBe('out');
  });

  // The load-bearing one. A merge node concatenates its inputs in EDGE order,
  // so ordering `inputs` by anything else — node order, insertion order, sorted
  // — changes what the transform is handed without changing the graph.
  it('hands a merge node its inputs in edge order, not node order', () => {
    const merged = graph(
      [source('a'), source('b'), transform('merge'), sink('out')],
      [
        // `b` is wired in first even though `a` is declared first.
        ['b', 'merge'],
        ['a', 'merge'],
        ['merge', 'out'],
      ],
    );
    const merge = workflowRunOrder(merged).find((entry) => entry.node.id === 'merge');
    expect(merge?.inputs).toEqual(['b', 'a']);
  });

  it('gives a source no inputs at all', () => {
    const entry = workflowRunOrder(runnable).find((step) => step.node.id === 'src');
    expect(entry?.inputs).toEqual([]);
  });

  it('carries the node itself, not just its id', () => {
    const entry = workflowRunOrder(runnable).find((step) => step.node.id === 'out');
    expect(entry?.node.kind).toBe('sink');
  });
});

describe('workflowGraphHash', () => {
  it('is two concatenated 32-bit passes', () => {
    // Sixteen hex characters. Dropping the second pass would halve the space
    // and still pass every "it changed" test below.
    expect(workflowGraphHash(runnable)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('does not change when the nodes are listed in a different order', () => {
    const reordered = graph(
      [sink('out'), transform('tx'), source('src')],
      [
        ['src', 'tx'],
        ['tx', 'out'],
      ],
    );
    expect(workflowGraphHash(reordered)).toBe(workflowGraphHash(runnable));
  });

  // Edges are deliberately NOT sorted: swapping two inputs to a merge changes
  // what the load produces, so it has to be a new version of the graph.
  it('changes when two inbound edges swap places', () => {
    const nodes = [source('a'), source('b'), transform('merge'), sink('out')];
    const ab = graph(nodes, [
      ['a', 'merge'],
      ['b', 'merge'],
      ['merge', 'out'],
    ]);
    const ba = graph(nodes, [
      ['b', 'merge'],
      ['a', 'merge'],
      ['merge', 'out'],
    ]);
    expect(workflowGraphHash(ba)).not.toBe(workflowGraphHash(ab));
  });

  // A version number inflated by cosmetic edits is useless for the one question
  // it exists to answer.
  it('does not change when a box is renamed or moved', () => {
    const cosmetic = graph(
      [
        source('src', { name: 'Nightly pull', position: { x: 10, y: 20 } }),
        transform('tx', { name: 'Reshape' }),
        sink('out', { name: 'Publish', position: { x: 400, y: 20 } }),
      ],
      [
        ['src', 'tx'],
        ['tx', 'out'],
      ],
    );
    expect(workflowGraphHash(cosmetic)).toBe(workflowGraphHash(runnable));
  });

  it('does not change when a config object is written key-first or key-last', () => {
    const one = graph(
      [source('src', { config: { url: 'u', path: 'p' } }), sink('out')],
      [['src', 'out']],
    );
    const other = graph(
      [source('src', { config: { path: 'p', url: 'u' } }), sink('out')],
      [['src', 'out']],
    );
    expect(workflowGraphHash(other)).toBe(workflowGraphHash(one));
  });

  it('changes when a config value changes', () => {
    const before = graph([source('src', { config: { url: 'a' } }), sink('out')], [['src', 'out']]);
    const after = graph([source('src', { config: { url: 'b' } }), sink('out')], [['src', 'out']]);
    expect(workflowGraphHash(after)).not.toBe(workflowGraphHash(before));
  });

  it.each<[string, WorkflowNode]>([
    ['sourceKind', source('src', { sourceKind: 'http' })],
    ['connectionId', source('src', { connectionId: 'conn-2' })],
    ['secretEnvVar', source('src', { secretEnvVar: 'TOKEN' })],
    ['mode', source('src', { mode: 'incremental' })],
  ])("changes when a source's %s changes", (_field, node) => {
    const before = graph([source('src'), sink('out')], [['src', 'out']]);
    const after = graph([node, sink('out')], [['src', 'out']]);
    expect(workflowGraphHash(after)).not.toBe(workflowGraphHash(before));
  });

  // An omitted mode and an explicit "full" run identically, so they must hash
  // identically — otherwise a canvas that fills in the default would look like
  // it edited the graph.
  it('reads an omitted mode as the default it actually runs with', () => {
    const implicit = graph([source('src'), sink('out')], [['src', 'out']]);
    const explicit = graph(
      [source('src', { mode: 'full' }), sink('out', { mode: 'full' })],
      [['src', 'out']],
    );
    expect(workflowGraphHash(explicit)).toBe(workflowGraphHash(implicit));
  });

  it('changes when a transform node points at different code', () => {
    const before = graph(
      [source('src'), transform('tx'), sink('out')],
      [
        ['src', 'tx'],
        ['tx', 'out'],
      ],
    );
    const after = graph(
      [source('src'), transform('tx', { transformId: 'tx-2' }), sink('out')],
      [
        ['src', 'tx'],
        ['tx', 'out'],
      ],
    );
    expect(workflowGraphHash(after)).not.toBe(workflowGraphHash(before));
  });

  it.each<[string, WorkflowNode]>([
    ['targetType', sink('out', { targetType: 'Subwo' })],
    ['mode', sink('out', { mode: 'incremental' })],
  ])("changes when a sink's %s changes", (_field, node) => {
    const before = graph([source('src'), sink('out')], [['src', 'out']]);
    const after = graph([source('src'), node], [['src', 'out']]);
    expect(workflowGraphHash(after)).not.toBe(workflowGraphHash(before));
  });

  it('changes when a node id changes, even with the same wiring shape', () => {
    const before = graph([source('src'), sink('out')], [['src', 'out']]);
    const after = graph([source('src2'), sink('out')], [['src2', 'out']]);
    expect(workflowGraphHash(after)).not.toBe(workflowGraphHash(before));
  });

  it('changes when an edge is added', () => {
    const before = graph([source('a'), source('b'), sink('out')], [['a', 'out']]);
    const after = graph(
      [source('a'), source('b'), sink('out')],
      [
        ['a', 'out'],
        ['b', 'out'],
      ],
    );
    expect(workflowGraphHash(after)).not.toBe(workflowGraphHash(before));
  });

  // The version a call pins is part of what the graph DOES, which is the
  // opposite of the rule for a transform's version above — repointing a node
  // at somebody else's newer code changes the load as surely as rewiring it
  // does, and the run that used the old one has to stay identifiable.
  it.each<[string, WorkflowNode]>([
    ['name', call('c', { callName: 'billing.other' })],
    ['version', call('c', { callVersion: '2' })],
    ['parameters', call('c', { config: { region: 'gov-west' } })],
  ])("changes when a call's %s changes", (_field, node) => {
    const before = graph([call('c'), sink('out')], [['c', 'out']]);
    const after = graph([node, sink('out')], [['c', 'out']]);
    expect(workflowGraphHash(after)).not.toBe(workflowGraphHash(before));
  });

  it('does not change when a call node is merely renamed or moved', () => {
    const before = graph([call('c'), sink('out')], [['c', 'out']]);
    const after = graph(
      [call('c', { name: 'Reconcile the ledger', position: { x: 40, y: 90 } }), sink('out')],
      [['c', 'out']],
    );
    expect(workflowGraphHash(after)).toBe(workflowGraphHash(before));
  });

  it('is the same on both sides of a serialisation round trip', () => {
    // The canvas hashes a draft and the server hashes what arrived; a hash that
    // depended on object identity or key insertion would disagree across JSON.
    const revived: WorkflowGraph = JSON.parse(JSON.stringify(runnable));
    expect(workflowGraphHash(revived)).toBe(workflowGraphHash(runnable));
  });
});

describe('the type guards over the exported vocabularies', () => {
  // The point of deriving each type from its list: a second, hand-maintained
  // copy of these names is what turns "the kind you chose" into "the kind that
  // happened to be first".
  it.each(CONNECTOR_KINDS)('accepts the connector kind %s', (kind) => {
    expect(isConnectorKind(kind)).toBe(true);
  });

  it.each(TRANSFORM_LANGUAGES)('accepts the transform language %s', (language) => {
    expect(isTransformLanguage(language)).toBe(true);
  });

  it.each(WORKFLOW_NODE_KINDS)('accepts the node kind %s', (kind) => {
    expect(isWorkflowNodeKind(kind)).toBe(true);
  });

  it.each(WORKFLOW_EXECUTION_MODES)('accepts the execution mode %s', (mode) => {
    expect(isWorkflowExecutionMode(mode)).toBe(true);
  });

  it.each([undefined, null, '', 'HTTP', 'ftp', 0, {}, ['http']])(
    'refuses %o as a connector kind',
    (value) => {
      expect(isConnectorKind(value)).toBe(false);
    },
  );

  it('refuses a near-miss rather than coercing it', () => {
    expect(isTransformLanguage('js')).toBe(false);
    expect(isWorkflowNodeKind('sinks')).toBe(false);
    expect(isWorkflowExecutionMode('off')).toBe(false);
  });
});

describe('isWorkflowNode', () => {
  it('accepts each of the four shapes', () => {
    expect(isWorkflowNode(source('src'))).toBe(true);
    expect(isWorkflowNode(transform('tx'))).toBe(true);
    expect(isWorkflowNode(sink('out'))).toBe(true);
    expect(isWorkflowNode(call('c'))).toBe(true);
  });

  // A stored call node missing its version would run whichever version is
  // registered on the day, which is the substitution the pin exists to prevent.
  // Narrowing it as valid and letting the empty string through would put that
  // decision back where nobody can see it.
  it.each([
    ['a call with no name', { id: 'a', name: 'n', kind: 'call', callVersion: '1', config: {} }],
    ['a call with no version', { id: 'a', name: 'n', kind: 'call', callName: 'w', config: {} }],
    [
      'a call whose version is a number',
      { id: 'a', name: 'n', kind: 'call', callName: 'w', callVersion: 1, config: {} },
    ],
    [
      'a call with no config',
      { id: 'a', name: 'n', kind: 'call', callName: 'w', callVersion: '1' },
    ],
  ])('refuses %s', (_why, value) => {
    expect(isWorkflowNode(value)).toBe(false);
  });

  // Dropping an unknown node silently changes what the workflow does, so a
  // stored node that does not narrow has to be refused rather than skipped.
  it.each([
    ['no id', { name: 'n', kind: 'source', sourceKind: 'http', config: {} }],
    ['no name', { id: 'a', kind: 'source', sourceKind: 'http', config: {} }],
    ['an unknown kind', { id: 'a', name: 'n', kind: 'filter' }],
    ['a transform with no transformId', { id: 'a', name: 'n', kind: 'transform' }],
    ['a sink with no targetType', { id: 'a', name: 'n', kind: 'sink' }],
    [
      'a source with an unknown sourceKind',
      { id: 'a', name: 'n', kind: 'source', sourceKind: 'ftp', config: {} },
    ],
    ['a source with no config', { id: 'a', name: 'n', kind: 'source', sourceKind: 'http' }],
    [
      'a source with a null config',
      { id: 'a', name: 'n', kind: 'source', sourceKind: 'http', config: null },
    ],
    ['a non-object', 'source'],
    ['null', null],
  ])('refuses %s', (_why, value) => {
    expect(isWorkflowNode(value)).toBe(false);
  });
});

describe('readWorkflowCallOutput', () => {
  it('reads the two counts a callee reports for the rows it staged', () => {
    expect(readWorkflowCallOutput({ batches: 3, rowCount: 1200 })).toEqual({
      batches: 3,
      rowCount: 1200,
    });
  });

  it('ignores whatever else the callee happened to return alongside them', () => {
    expect(readWorkflowCallOutput({ batches: 0, rowCount: 0, ok: true, took: '4s' })).toEqual({
      batches: 0,
      rowCount: 0,
    });
  });

  // A workflow called for its effect answers however it likes, and that is an
  // ordinary outcome rather than a fault. The caller says so in its logs and
  // passes on nothing.
  it.each([
    ['nothing', undefined],
    ['null', null],
    ['a bare acknowledgement', { ok: true }],
    ['a string', 'done'],
    ['a number', 7],
  ])('reads %s as a call that staged no rows', (_why, value) => {
    expect(readWorkflowCallOutput(value)).toBeUndefined();
  });

  // Half a contract is a bug in the callee. Reading it as "no rows" would turn
  // that bug into a load that quietly came out short.
  it.each([
    ['only one of the two counts', { batches: 2 }],
    ['a row count with no batches', { rowCount: 10 }],
    ['a fractional batch count', { batches: 1.5, rowCount: 10 }],
    ['a negative row count', { batches: 1, rowCount: -1 }],
    ['counts as strings', { batches: '1', rowCount: '10' }],
  ])('refuses %s, naming what it saw', (_why, value) => {
    expect(() => readWorkflowCallOutput(value)).toThrow(/batches=|rowCount=/);
  });
});

describe('isWorkflowEdge', () => {
  it('accepts a wire', () => {
    const edge: WorkflowEdge = { from: 'a', to: 'b' };
    expect(isWorkflowEdge(edge)).toBe(true);
  });

  it.each([null, undefined, {}, { from: 'a' }, { to: 'b' }, { from: 1, to: 2 }, 'a>b'])(
    'refuses %o',
    (value) => {
      expect(isWorkflowEdge(value)).toBe(false);
    },
  );
});

describe('store capability checks', () => {
  const bare: CatalogPipelineStore = Object.create(null);

  it('reads a store with no workflow methods as one that cannot hold workflows', () => {
    expect(supportsWorkflows(bare)).toBe(false);
    expect(supportsWorkflowStages(bare)).toBe(false);
  });

  it('accepts a store that has them', () => {
    const full: CatalogPipelineStore = Object.assign(Object.create(null), {
      listWorkflows: async () => [],
      getWorkflow: async () => undefined,
      saveWorkflow: async () => undefined,
      // Asked for by name like the rest: promotion publishes what it saves, so a
      // store with the save and not the transition would narrow cleanly and then
      // fail one call into an apply that has already written types.
      publishWorkflow: async () => undefined,
      // Asked for by name too, and for a sharper reason than the rest: a store
      // that narrowed without it would accept a cron and then throw on writing
      // one, which is the shape of a scheduling failure this codebase has had.
      saveWorkflowSchedule: async () => undefined,
      writeStage: async () => ({ written: 0 }),
      readStage: async () => [],
    });
    expect(supportsWorkflows(full)).toBe(true);
    expect(supportsWorkflowStages(full)).toBe(true);
  });

  // "A flag is a claim and a method is the thing itself": a store carrying a
  // truthy non-function would otherwise pass the check and TypeError halfway
  // through a load.
  it('refuses a store that merely claims the methods', () => {
    const claimant: CatalogPipelineStore = Object.assign(Object.create(null), {
      listWorkflows: true,
      getWorkflow: true,
      saveWorkflow: true,
      writeStage: 'yes',
      readStage: 'yes',
    });
    expect(supportsWorkflows(claimant)).toBe(false);
    expect(supportsWorkflowStages(claimant)).toBe(false);
  });

  it('refuses a store missing only one of the workflow methods', () => {
    const partial: CatalogPipelineStore = Object.assign(Object.create(null), {
      listWorkflows: async () => [],
      getWorkflow: async () => undefined,
    });
    expect(supportsWorkflows(partial)).toBe(false);
  });

  it.each([null, undefined, {}, 'store', { listConnectors: true }])(
    'refuses %o as a pipeline store',
    (value) => {
      expect(isPipelineStore(value)).toBe(false);
    },
  );

  it('accepts anything that can actually list connectors', () => {
    expect(isPipelineStore({ listConnectors: async () => [] })).toBe(true);
  });
});

/**
 * The rule that decides whether an announced workflow may be committed onto a
 * call node.
 *
 * Here rather than in the canvas because the picker and anything server-side
 * reasoning about the same list have to apply the SAME rule — a picker with its
 * own copy is one that eventually offers an entry the rest of the system will
 * not accept, which is the drift `validateWorkflow` living here already
 * prevents for graphs.
 *
 * Both refusals exist because committing the entry would write a node whose
 * meaning nobody can state, and neither is a style preference: a name with no
 * version follows whatever gets deployed next, and a name claimed from two
 * groups could be two different bodies on two different queues.
 */
describe('whether an announced workflow can be pinned onto a call node', () => {
  function ref(overrides: Partial<CallableWorkflowRef> = {}): CallableWorkflowRef {
    return { name: 'billing.reconcile', version: '2', group: 'billing', ...overrides };
  }

  it('accepts an entry the fleet agrees on', () => {
    expect(callableWorkflowBlock(ref())).toBeUndefined();
  });

  it('refuses a bare name, because a name with no version cannot be pinned', () => {
    const block = callableWorkflowBlock(ref({ version: undefined, group: undefined }));

    expect(block?.code).toBe('no-version');
    expect(block?.message).toContain('billing.reconcile');
    // It says what to do instead, because the workflow is real and callable —
    // what cannot be done is choosing it in one click.
    expect(block?.message).toContain('type the name and the version you mean');
  });

  it('refuses a version that is present but blank, which is the same non-answer', () => {
    expect(callableWorkflowBlock(ref({ version: '   ' }))?.code).toBe('no-version');
  });

  it('refuses an entry two groups claim, rather than choosing one of them', () => {
    const block = callableWorkflowBlock(
      ref({
        group: undefined,
        disagreements: [{ axis: 'group', values: ['billing', 'billing-legacy'] }],
      }),
    );

    expect(block?.code).toBe('ambiguous-group');
    // Both named. A refusal that says "the groups disagree" without saying which
    // leaves somebody to go and read the descriptors themselves.
    expect(block?.message).toContain('billing');
    expect(block?.message).toContain('billing-legacy');
  });

  it('does not refuse a disagreement about origin or requires', () => {
    // Worth showing — two packages declaring one name is a mess — but it does
    // not change which queue the run goes to, and refusing on it would block a
    // pin that is otherwise exactly determined.
    expect(
      callableWorkflowBlock(
        ref({ disagreements: [{ axis: 'origin', values: ['@acme/a', '@acme/b'] }] }),
      ),
    ).toBeUndefined();
    expect(
      callableWorkflowBlock(
        ref({ disagreements: [{ axis: 'requires', values: ['gpu', 'large-memory'] }] }),
      ),
    ).toBeUndefined();
  });

  it('reports the missing version first when an entry has both problems', () => {
    // Ordered deliberately: no version is the more fundamental refusal, and a
    // message about groups on an entry that could never be pinned anyway would
    // send somebody to fix the wrong thing.
    const block = callableWorkflowBlock(
      ref({
        version: undefined,
        group: undefined,
        disagreements: [{ axis: 'group', values: ['a', 'b'] }],
      }),
    );

    expect(block?.code).toBe('no-version');
  });
});
