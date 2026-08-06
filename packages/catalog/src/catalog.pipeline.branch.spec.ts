import { describe, expect, it } from 'vitest';
import {
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowIfNode,
  type WorkflowIssueCode,
  type WorkflowNode,
  type WorkflowNodeOutcome,
  type WorkflowSinkNode,
  type WorkflowSourceNode,
  type WorkflowTransformNode,
  isWorkflowEdge,
  isWorkflowNode,
  validateWorkflow,
  workflowGraphHash,
  workflowNodeRuns,
  workflowRunOrder,
} from './catalog.pipeline';

/**
 * The `if` node, and the one thing a branch must never do.
 *
 * WHAT THIS FILE IS ACTUALLY GUARDING
 * -----------------------------------
 * Every failure a conditional branch introduces has the same shape: **a part of
 * the graph silently does not run.** Not a crash, not a red run — a load that
 * reports success while a sink somewhere was never reached. That is invisible in
 * every way except the data, and by the time somebody notices, the run that did
 * it is days old.
 *
 * So the cases below are weighted towards the silent ones rather than towards
 * the obvious ones. The single most important is `a node fed by both branches`:
 * the naive skip rule — "mark everything downstream of the untaken edge" — is
 * wrong on exactly that shape, produces a graph that commits nothing, and passes
 * every test anybody would write about a simple two-branch graph.
 */

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
  return { id, name: id, kind: 'sink', targetType: id, ...overrides };
}

function gate(id: string, overrides: Partial<WorkflowIfNode> = {}): WorkflowIfNode {
  return {
    id,
    name: id,
    kind: 'if',
    predicate: { kind: 'env', envVar: 'CLICKHOUSE_URL' },
    ...overrides,
  };
}

/** A gate that branches on how many rows reached it. */
function counting(id: string, atLeast = 1): WorkflowIfNode {
  return { id, name: id, kind: 'if', predicate: { kind: 'rowCount', atLeast } };
}

/** `['a', 'b']` is a plain wire; `['a', 'b', 'then']` is a branch. */
type Wire = [string, string] | [string, string, 'then' | 'else'];

function graph(nodes: WorkflowNode[], wires: Wire[]): WorkflowGraph {
  return {
    nodes,
    edges: wires.map(([from, to, branch]) => (branch ? { from, to, branch } : { from, to })),
  };
}

function codes(graphUnderTest: WorkflowGraph): WorkflowIssueCode[] {
  return validateWorkflow(graphUnderTest).map((issue) => issue.code);
}

/**
 * The shape the whole feature exists for: one read, two deployments.
 *
 * `src → gate`, then `gate --then--> warm → clickhouse` and
 * `gate --else--> cold`. A deployment with a ClickHouse loads into it; one
 * without loads into `cold` and leaves the ClickHouse type alone.
 */
const TWO_WAY = graph(
  [source('src'), gate('gate'), transform('warm'), sink('clickhouse'), sink('cold')],
  [
    ['src', 'gate'],
    ['gate', 'warm', 'then'],
    ['warm', 'clickhouse'],
    ['gate', 'cold', 'else'],
  ],
);

describe('what a graph with a branch is allowed to look like', () => {
  it('accepts a gate with a then and an else', () => {
    expect(validateWorkflow(TWO_WAY)).toEqual([]);
  });

  it('refuses a wire out of a gate that names no branch', () => {
    // The silent one. An unlabelled wire belongs to neither side, so nothing
    // would ever take it — the subtree behind it would be skipped on every run
    // of every deployment, on a graph that draws perfectly.
    const unlabelled = graph(
      [source('src'), gate('gate'), sink('out')],
      [
        ['src', 'gate'],
        ['gate', 'out'],
      ],
    );

    expect(codes(unlabelled)).toContain('branch-not-labelled');
  });

  it('refuses a branch label on a wire that leaves something which does not branch', () => {
    // The mirror image, and just as quiet: a decision somebody wrote down that
    // nothing reads, drawn on the canvas as though it were being honoured.
    const mislabelled = graph(
      [source('src'), transform('t'), sink('out')],
      [
        ['src', 't'],
        ['t', 'out', 'then'],
      ],
    );

    expect(codes(mislabelled)).toContain('branch-on-plain-edge');
  });

  it('refuses a gate fed by two nodes', () => {
    // A gate hands its successors the ref of the stage it was given rather than
    // a copy, and one ref cannot name two inputs — so a second inbound wire
    // would be dropped without a word.
    const merging = graph(
      [source('a'), source('b'), gate('gate'), sink('out')],
      [
        ['a', 'gate'],
        ['b', 'gate'],
        ['gate', 'out', 'then'],
      ],
    );

    expect(codes(merging)).toContain('if-needs-one-input');
  });

  it('refuses a gate that names no variable', () => {
    const blank = graph(
      [source('src'), gate('gate', { predicate: { kind: 'env', envVar: '' } }), sink('out')],
      [
        ['src', 'gate'],
        ['gate', 'out', 'then'],
      ],
    );

    expect(codes(blank)).toContain('if-not-named');
  });

  it('accepts a gate that branches on how many rows reached it', () => {
    // The shape the row-count predicate exists for: a sink behind a gate that
    // only opens when the read brought something back. There is no `else` wire
    // at all, which is the point — the alternative to loading is not loading.
    const guarded = graph(
      [source('src'), counting('any'), sink('out')],
      [
        ['src', 'any'],
        ['any', 'out', 'then'],
      ],
    );

    expect(validateWorkflow(guarded)).toEqual([]);
  });

  it('refuses a row-count gate whose threshold can only answer one way', () => {
    // A threshold of zero passes on every run including an empty one, so the
    // else side never executes on any deployment. That is the same silent
    // half-graph an unlabelled wire produces, reached by typing a number.
    const always = graph(
      [source('src'), counting('any', 0), sink('out')],
      [
        ['src', 'any'],
        ['any', 'out', 'then'],
      ],
    );

    expect(codes(always)).toContain('if-threshold-invalid');
  });

  it('refuses a row-count threshold that is not a whole number', () => {
    // `NaN` is what an unparsed form field arrives as, and every comparison
    // against it is false — a `then` branch that silently never runs again.
    const nonsense = graph(
      [source('src'), counting('any', Number.NaN), sink('out')],
      [
        ['src', 'any'],
        ['any', 'out', 'then'],
      ],
    );

    expect(codes(nonsense)).toContain('if-threshold-invalid');
  });

  it('refuses a row-count gate fed by two nodes, like any other gate', () => {
    // Doubly important for this predicate: with two inbound stages there is no
    // single answer to "how many rows reached it", so the count tested would be
    // one of two streams picked by array order.
    const merging = graph(
      [source('a'), source('b'), counting('any'), sink('out')],
      [
        ['a', 'any'],
        ['b', 'any'],
        ['any', 'out', 'then'],
      ],
    );

    expect(codes(merging)).toContain('if-needs-one-input');
  });

  it('lets one branch feed several nodes', () => {
    // Fan-out that happens to be conditional. What is refused is two wires
    // between the same pair, which was already a duplicate edge.
    const fanned = graph(
      [source('src'), gate('gate'), sink('one'), sink('two'), sink('other')],
      [
        ['src', 'gate'],
        ['gate', 'one', 'then'],
        ['gate', 'two', 'then'],
        ['gate', 'other', 'else'],
      ],
    );

    expect(validateWorkflow(fanned)).toEqual([]);
  });
});

describe('which nodes a decision leaves running', () => {
  /** The order, keyed by node id, so a case can ask about one entry. */
  function ordered(graphUnderTest: WorkflowGraph) {
    return new Map(workflowRunOrder(graphUnderTest).map((entry) => [entry.node.id, entry]));
  }

  /** A gate that took `branch`, as the run would have recorded it. */
  function took(branch: 'then' | 'else'): WorkflowNodeOutcome {
    return { status: 'succeeded', rows: 3, branch };
  }

  const ran: WorkflowNodeOutcome = { status: 'succeeded', rows: 3 };
  const skipped: WorkflowNodeOutcome = { status: 'skipped', rows: 0 };

  it('runs the taken side and skips the other', () => {
    const order = ordered(TWO_WAY);
    const outcomes = { src: ran, gate: took('then') };

    expect(workflowNodeRuns(order.get('warm') ?? { inputs: [] }, outcomes)).toBe(true);
    expect(workflowNodeRuns(order.get('cold') ?? { inputs: [] }, outcomes)).toBe(false);
  });

  it('carries the skip on down the untaken side', () => {
    const order = ordered(TWO_WAY);
    // `warm` was skipped, so the sink it feeds is reached by nothing live.
    const outcomes = { src: ran, gate: took('else'), warm: skipped };

    expect(workflowNodeRuns(order.get('clickhouse') ?? { inputs: [] }, outcomes)).toBe(false);
  });

  it('still runs a node the taken branch also reaches', () => {
    // THE CASE THE OBVIOUS RULE GETS WRONG.
    //
    //      ┌ then → warm ┐
    // gate ┤             ├→ join → out
    //      └ else → cold ┘
    //
    // `join` is downstream of `cold`, so "skip every descendant of the untaken
    // edge" skips it — and with it the only sink in the graph, which commits
    // nothing while the run reports success. Reachability from the *taken*
    // edges reaches `join` through `warm`, which is the right answer.
    const diamond = graph(
      [
        source('src'),
        gate('gate'),
        transform('warm'),
        transform('cold'),
        transform('join'),
        sink('out'),
      ],
      [
        ['src', 'gate'],
        ['gate', 'warm', 'then'],
        ['gate', 'cold', 'else'],
        ['warm', 'join'],
        ['cold', 'join'],
        ['join', 'out'],
      ],
    );
    const order = ordered(diamond);
    const outcomes = { src: ran, gate: took('then'), warm: ran, cold: skipped };

    expect(workflowNodeRuns(order.get('join') ?? { inputs: [] }, outcomes)).toBe(true);
  });

  it('runs everything in a graph that has no branch at all', () => {
    // The regression that matters most to existing deployments: every stored
    // graph has unlabelled wires, and every one of them must stay unconditional.
    const plain = graph(
      [source('src'), transform('t'), sink('out')],
      [
        ['src', 't'],
        ['t', 'out'],
      ],
    );
    const order = ordered(plain);

    expect(workflowNodeRuns(order.get('t') ?? { inputs: [] }, { src: ran })).toBe(true);
    expect(workflowNodeRuns(order.get('out') ?? { inputs: [] }, { src: ran, t: ran })).toBe(true);
  });

  it('reads the branch off the record and never off a predicate', () => {
    // The replay property, stated as a test: the same order and the same node,
    // asked twice with two different recorded decisions, answers differently.
    // Nothing here consults an environment, which is why a replay on another pod
    // reproduces the first run's decision rather than making a new one.
    const order = ordered(TWO_WAY);
    const entry = order.get('warm') ?? { inputs: [] };

    expect(workflowNodeRuns(entry, { src: ran, gate: took('then') })).toBe(true);
    expect(workflowNodeRuns(entry, { src: ran, gate: took('else') })).toBe(false);
  });
});

describe('the plan a branch is executed from', () => {
  it('keys each wire’s label by the node it comes from', () => {
    const order = workflowRunOrder(TWO_WAY);
    const cold = order.find((entry) => entry.node.id === 'cold');

    expect(cold?.inputBranches).toEqual({ gate: 'else' });
  });

  it('leaves a plain wire out of the map rather than writing undefined into it', () => {
    // Not a stylistic point. This map travels through a durable checkpoint as
    // JSON, and an array with an `undefined` hole comes back as `null` — which
    // compares unequal to every branch label and would make a plain wire look
    // dead on replay only. A key that is simply absent round-trips.
    const order = workflowRunOrder(TWO_WAY);
    const warm = order.find((entry) => entry.node.id === 'clickhouse');

    expect(warm?.inputBranches).toEqual({});
    expect(JSON.parse(JSON.stringify(warm?.inputBranches))).toEqual({});
  });
});

describe('what a branch does to a graph’s identity', () => {
  it('leaves the fingerprint of a graph without branches exactly as it was', () => {
    // A feature that renumbered the version of every stored graph would make
    // every run recorded before it unidentifiable. The branch is folded into the
    // hash only when there is one.
    const plain = graph([source('src'), sink('out')], [['src', 'out']]);

    expect(workflowGraphHash(plain)).toBe(
      workflowGraphHash({ nodes: plain.nodes, edges: [{ from: 'src', to: 'out' }] }),
    );
  });

  it('changes the fingerprint when a wire moves to the other branch', () => {
    // Swapping then and else inverts which half of the pipeline runs, so it is a
    // new version of the graph in every sense that matters.
    const swapped: WorkflowEdge[] = TWO_WAY.edges.map((edge) =>
      edge.branch === undefined
        ? edge
        : { ...edge, branch: edge.branch === 'then' ? 'else' : 'then' },
    );

    expect(workflowGraphHash({ nodes: TWO_WAY.nodes, edges: swapped })).not.toBe(
      workflowGraphHash(TWO_WAY),
    );
  });

  it('tells "set to anything" apart from "set to nothing"', () => {
    // `equals: undefined` and `equals: ''` are different tests, and a hash that
    // folded them together would let one be edited into the other with no new
    // version and no way to tell which one a past run used.
    const isSet = graph(
      [gate('g'), source('s'), sink('o')],
      [
        ['s', 'g'],
        ['g', 'o', 'then'],
      ],
    );
    const isBlank = graph(
      [
        gate('g', { predicate: { kind: 'env', envVar: 'CLICKHOUSE_URL', equals: '' } }),
        source('s'),
        sink('o'),
      ],
      [
        ['s', 'g'],
        ['g', 'o', 'then'],
      ],
    );

    expect(workflowGraphHash(isSet)).not.toBe(workflowGraphHash(isBlank));
  });

  it('tells a gate that reads a variable apart from one that counts rows', () => {
    // Switching which *kind* of test a gate makes changes which half of the
    // pipeline runs on every deployment. A hash that folded the two together
    // would leave two runs claiming the same graph version having taken
    // different branches, which is the one question the version answers.
    const wires: Wire[] = [
      ['s', 'g'],
      ['g', 'o', 'then'],
    ];
    const byVariable = graph([gate('g'), source('s'), sink('o')], wires);
    const byRows = graph([counting('g'), source('s'), sink('o')], wires);

    expect(workflowGraphHash(byVariable)).not.toBe(workflowGraphHash(byRows));
  });

  it('changes the fingerprint when the threshold changes', () => {
    const wires: Wire[] = [
      ['s', 'g'],
      ['g', 'o', 'then'],
    ];
    const any = graph([counting('g', 1), source('s'), sink('o')], wires);
    const many = graph([counting('g', 1000), source('s'), sink('o')], wires);

    expect(workflowGraphHash(any)).not.toBe(workflowGraphHash(many));
  });
});

describe('reading a stored branch back', () => {
  it('narrows a gate that names a variable', () => {
    expect(
      isWorkflowNode({ id: 'g', name: 'g', kind: 'if', predicate: { kind: 'env', envVar: 'X' } }),
    ).toBe(true);
    expect(
      isWorkflowNode({
        id: 'g',
        name: 'g',
        kind: 'if',
        predicate: { kind: 'env', envVar: 'X', equals: 'local' },
      }),
    ).toBe(true);
  });

  it('refuses a gate with no variable and one whose expectation is not text', () => {
    expect(isWorkflowNode({ id: 'g', name: 'g', kind: 'if' })).toBe(false);
    expect(
      isWorkflowNode({
        id: 'g',
        name: 'g',
        kind: 'if',
        predicate: { kind: 'env', envVar: 'X', equals: 3 },
      }),
    ).toBe(false);
    // The flat shape the node used to have. Refused rather than adapted: a gate
    // whose test has to be guessed from which fields are present is exactly the
    // ambiguity the predicate union removed.
    expect(isWorkflowNode({ id: 'g', name: 'g', kind: 'if', envVar: 'X' })).toBe(false);
  });

  it('narrows a gate that counts rows, and refuses one whose threshold is not a number', () => {
    expect(
      isWorkflowNode({
        id: 'g',
        name: 'g',
        kind: 'if',
        predicate: { kind: 'rowCount', atLeast: 1 },
      }),
    ).toBe(true);
    // A threshold that arrived as text — an unparsed form field — compares
    // false against every count, so the `then` side would never run again and
    // nothing would say why. Refused on the way out of the column instead.
    expect(
      isWorkflowNode({
        id: 'g',
        name: 'g',
        kind: 'if',
        predicate: { kind: 'rowCount', atLeast: '5' },
      }),
    ).toBe(false);
    expect(
      isWorkflowNode({
        id: 'g',
        name: 'g',
        kind: 'if',
        predicate: { kind: 'rowCount', atLeast: Number.NaN },
      }),
    ).toBe(false);
  });

  it('refuses a predicate whose kind is not one this build can evaluate', () => {
    // The forward-compatibility case: a graph written by a newer build that has
    // a third predicate kind. Refusing is the point — running it would mean
    // guessing a branch, and a guessed branch is half a load nobody chose.
    expect(
      isWorkflowNode({ id: 'g', name: 'g', kind: 'if', predicate: { kind: 'code', body: '...' } }),
    ).toBe(false);
  });

  it('refuses a wire whose branch is not one of the two labels', () => {
    // Dropping it instead would silently turn a labelled wire into a plain one,
    // which either runs a subtree a branch stood down or strands one that should
    // have run. Both are the failure this whole file is about.
    expect(isWorkflowEdge({ from: 'a', to: 'b' })).toBe(true);
    expect(isWorkflowEdge({ from: 'a', to: 'b', branch: 'then' })).toBe(true);
    expect(isWorkflowEdge({ from: 'a', to: 'b', branch: 'thn' })).toBe(false);
  });
});
