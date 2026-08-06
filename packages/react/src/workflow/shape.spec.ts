/**
 * Does what the source reads fit what the sink writes?
 *
 * WHAT IS PINNED HERE, AND WHY EACH ONE
 * -------------------------------------
 * **The direction of the name comparison.** A published property has two names:
 * `name`, which the load looks the field up by, and `columnName`, which is
 * lineage — how the source spells it, recorded when the property ended up called
 * something else. Publishing used to force that split on every name SQL could
 * not take verbatim, and `subwo` has 73 of those out of 84; thirteen types were
 * published that way and are still stored that way, which is why this is a check
 * and not a footnote. Comparing against `columnName` reports "fits" on the exact
 * graph that wrote 6,905 rows of null, so the test that matters is not "a
 * mismatch is caught" — it is that a source spelling the column the way
 * `columnName` records it is still reported.
 *
 * **That the three outcomes stay three.** Anything decided by the two schemas
 * alone is an error. Anything that depends on the rows — and against a real
 * deployment discovery came back `basis: "driver"`, `sampled: 0`, so there were
 * no rows — is a warning, does not block the save, and does not paint a wire
 * red. If a refactor collapses those two into one level, several tests here go
 * red at once, which is the point: a panel that shouts about what it could not
 * prove is a panel people stop reading.
 *
 * **The tension the canvas spec already guards, at this level.** A graph that
 * fits must report nothing, and a graph that does not must report something —
 * and a node nobody has finished must do neither. All three are here, because a
 * check that satisfies any two of them by giving up on the third is worthless.
 */
import type { WorkflowEdge, WorkflowNode } from '@dudousxd/nestjs-catalog/client';
import { describe, expect, it } from 'vitest';
import {
  type ShapeKnowledge,
  type SourceColumn,
  type SourceShape,
  type TargetProperty,
  type TargetShape,
  checkShapes,
} from './shape';
import { type WorkflowProblem, hasBlockingProblem, validateWorkflow } from './validate';

function source(id: string): WorkflowNode {
  return { id, name: id, kind: 'source', sourceKind: 'sql', config: {} };
}
function transform(id: string): WorkflowNode {
  return { id, name: id, kind: 'transform', transformId: 'tx-1' };
}
function call(id: string): WorkflowNode {
  return {
    id,
    name: id,
    kind: 'call',
    callName: 'billing.reconcile',
    callVersion: '1',
    config: {},
  };
}
function sink(id: string, targetType = 'Subwo'): WorkflowNode {
  return { id, name: id, kind: 'sink', targetType };
}
function wire(pairs: Array<[string, string]>): WorkflowEdge[] {
  return pairs.map(([from, to]) => ({ from, to }));
}
function codes(problems: WorkflowProblem[]): string[] {
  return problems.map((problem) => problem.code);
}

/** A driver description: types from the source, no row read. What dev returned. */
function column(name: string, overrides: Partial<SourceColumn> = {}): SourceColumn {
  return { name, type: 'string', nullable: null, confidence: 'reported', ...overrides };
}
function shape(columns: SourceColumn[], overrides: Partial<SourceShape> = {}): SourceShape {
  return { columns, basis: 'driver', sampled: 0, ...overrides };
}
function property(name: string, overrides: Partial<TargetProperty> = {}): TargetProperty {
  return { name, type: 'string', nullable: true, ...overrides };
}
function target(properties: TargetProperty[], name = 'Subwo'): TargetShape {
  return { name, properties };
}

/** Discovery for `src`, and one type. The pair the check needs to say anything. */
function knowing(shapes: Record<string, SourceShape>, types: TargetShape[]): ShapeKnowledge {
  return {
    sourceShape: (nodeId) => shapes[nodeId],
    targetShape: (typeName) => types.find((type) => type.name === typeName),
  };
}

/** src → out, the smallest graph this check has anything to say about. */
const direct = { nodes: [source('src'), sink('out')], edges: wire([['src', 'out']]) };

function check(knowledge: ShapeKnowledge, graph = direct): WorkflowProblem[] {
  return checkShapes(graph.nodes, graph.edges, knowledge);
}

describe('a source wired straight into a sink', () => {
  it('says nothing when every column the type is made of arrives under that name', () => {
    // Half of the pair. A check that only ever finds fault is one people turn off, and this is
    // the case the canvas is in most of the time.
    const problems = check(
      knowing({ src: shape([column('id'), column('miles', { type: 'number' })]) }, [
        target([property('id'), property('miles', { type: 'number' })]),
      ]),
    );

    expect(problems).toEqual([]);
  });

  it('catches the column the source spells its own way, which is the case that wrote 6,905 rows', () => {
    // THE TEST. Publishing used to refuse `Asset Id` as a property name, so the type was stored
    // as `Asset_Id` with the source's spelling in `columnName`. The load then looks the field up
    // as `row["Asset_Id"]`, the record has `Asset Id`, and every row is null while the run
    // reports the count it read. Thirteen types are stored exactly like this.
    //
    // Matching on `columnName` — the mapping that DOES agree with the source — reports this graph
    // as fitting. That is the mutation this test exists to kill.
    const problems = check(
      knowing({ src: shape([column('Asset Id')]) }, [
        target([property('Asset_Id', { columnName: 'Asset Id' })]),
      ]),
    );

    expect(codes(problems)).toEqual(['shape-source-spelling']);
    expect(problems[0]?.level).toBe('error');
    expect(problems[0]?.message).toContain('`Asset Id` → `Asset_Id`');
    // Both ways out, in the order they cost. Renaming the property to the source's spelling is
    // now accepted by publish — `outputAlias` cleans it on the way to a column — and that is the
    // repair for almost all thirteen types. A message that only offered a transform would send
    // somebody to write code for a rename they can do in the type.
    expect(problems[0]?.message).toMatch(/Rename the property/);
    expect(problems[0]?.message).toMatch(/transform/);
    expect(problems[0]?.nodeIds).toEqual(['src', 'out']);
  });

  it('separates a column spelled differently from one the source does not have at all', () => {
    // Two different problems with two different fixes: one wants a rename, the other wants the
    // column added to the query. Reporting both as "missing" sends somebody to rewrite a source
    // that is already producing the data.
    const problems = check(
      knowing({ src: shape([column('Asset Id')]) }, [
        target([
          property('Asset_Id', { columnName: 'Asset Id' }),
          property('Closed_On', { columnName: 'Closed On' }),
        ]),
      ]),
    );

    expect(codes(problems)).toEqual(['shape-source-spelling', 'shape-missing-column']);
    expect(problems[1]?.level).toBe('error');
    expect(problems[1]?.message).toContain('`Closed_On`');
    expect(problems[1]?.message).not.toContain('`Asset_Id`');
  });

  it('reports 73 respelled columns once, naming a few and counting the rest', () => {
    // The real numbers. One problem per source→sink pair, not per column: a rail with 73 entries
    // in it is a rail nobody scrolls, and the fix for all 73 is the same one act.
    const columns = Array.from({ length: 84 }, (_, index) =>
      index < 73 ? column(`Col ${index}`) : column(`plain_${index}`),
    );
    const properties = Array.from({ length: 84 }, (_, index) =>
      index < 73
        ? property(`Col_${index}`, { columnName: `Col ${index}` })
        : property(`plain_${index}`),
    );

    const problems = check(knowing({ src: shape(columns) }, [target(properties)]));

    expect(codes(problems)).toEqual(['shape-source-spelling']);
    expect(problems[0]?.message).toContain('73 columns');
    expect(problems[0]?.message).toContain('and 67 more');
    // Counted, not spelled out. A message carrying all 73 pairs is a paragraph nobody finishes,
    // and it would push the sentence that says what to do about them off the bottom of the rail.
    expect(problems[0]?.message).toContain('`Col 5` → `Col_5`');
    expect(problems[0]?.message).not.toContain('`Col_6`');
  });
});

describe('the third outcome: not known well enough to say', () => {
  it('does not call a type difference wrong, because coerce decides it on the values', () => {
    // `string` into a `number` property loads perfectly when every value is numeric and writes
    // nulls when one is not. Discovery read no rows, so nothing here knows which. Calling it an
    // error refuses graphs that load correctly every night.
    const problems = check(
      knowing({ src: shape([column('miles', { type: 'string' })]) }, [
        target([property('miles', { type: 'number' })]),
      ]),
    );

    expect(codes(problems)).toEqual(['shape-unproven']);
    expect(problems[0]?.level).toBe('warning');
    expect(problems[0]?.message).toContain('`miles`');
    expect(hasBlockingProblem(problems)).toBe(false);
  });

  it('takes anything into a string property, because String() is total', () => {
    // The other side of the rule above: this one really does fit, and reporting it as unproven
    // would put an amber line on most graphs in existence.
    const problems = check(
      knowing({ src: shape([column('when', { type: 'date' })]) }, [
        target([property('when', { type: 'string' })]),
      ]),
    );

    expect(problems).toEqual([]);
  });

  it('says so when discovery reached no conclusion about a column', () => {
    // `null` is not the `unknown` scalar and is not a guess — it is the absence of a decision,
    // and the honest report of it is a question rather than either verdict.
    const problems = check(
      knowing(
        {
          src: shape([
            column('odd', { type: null, confidence: 'unknown', sourceType: 'GEOMETRY' }),
          ]),
        },
        [target([property('odd')])],
      ),
    );

    expect(codes(problems)).toEqual(['shape-unproven']);
    expect(problems[0]?.message).toContain('GEOMETRY');
  });

  it('raises the two sides disagreeing about null as a question, not a refusal', () => {
    // The type says the field is never absent, the source says its column may be. Both are
    // declarations; neither is a row. The warehouse column is nullable in the DDL either way, so
    // nothing fails — the reader who trusts `nullable: false` is the one who is misled.
    const problems = check(
      knowing({ src: shape([column('id', { nullable: true })]) }, [
        target([property('id', { nullable: false })]),
      ]),
    );

    expect(codes(problems)).toEqual(['shape-unproven']);
    expect(problems[0]?.level).toBe('warning');
  });

  it('says nothing about a nullable column the type also lets be null', () => {
    const problems = check(
      knowing({ src: shape([column('id', { nullable: true })]) }, [
        target([property('id', { nullable: true })]),
      ]),
    );

    expect(problems).toEqual([]);
  });

  it('states the basis, because a driver description proves names and not values', () => {
    // `basis: "driver"` with `sampled: 0` is what the real deployment answered. A reader deciding
    // whether to go and look at the data needs to know that is what is behind the warning.
    const driver = check(
      knowing({ src: shape([column('miles', { type: 'string' })]) }, [
        target([property('miles', { type: 'number' })]),
      ]),
    );
    const sampled = check(
      knowing(
        {
          src: shape([column('miles', { type: 'string', confidence: 'inferred' })], {
            basis: 'sample',
            sampled: 40,
          }),
        },
        [target([property('miles', { type: 'number' })])],
      ),
    );

    expect(driver[0]?.message).toContain('no rows were read (sampled 0)');
    expect(sampled[0]?.message).toContain('40 records');
  });
});

describe('anything that computes its rows on the path', () => {
  const throughTransform = {
    nodes: [source('src'), transform('tx'), sink('out')],
    edges: wire([
      ['src', 'tx'],
      ['tx', 'out'],
    ]),
  };

  it('says the check could not be made, rather than passing it quietly', () => {
    // What a transform emits is whatever its TypeScript returns, and knowing that means
    // compiling and running it. Silence here would read as "these columns fit", which is a claim
    // nothing in this package is in a position to make.
    const problems = check(
      knowing({ src: shape([column('Asset Id')]) }, [
        target([property('Asset_Id', { columnName: 'Asset Id' })]),
      ]),
      throughTransform,
    );

    expect(codes(problems)).toEqual(['shape-not-checked']);
    expect(problems[0]?.level).toBe('warning');
    expect(problems[0]?.message).toContain('"tx"');
    expect(problems[0]?.nodeIds).toEqual(['tx', 'out']);
  });

  it('says the same about a call node, which is further out of reach still', () => {
    // A `call` node hands the step to a durable workflow this graph does not own — possibly
    // written in another language — and the graph holds nothing but its name and a pinned
    // version. The branch is on "not a source" rather than on the kind, so a fourth kind lands in
    // the honest answer by default instead of falling through the comparison.
    const problems = check(
      knowing({ src: shape([column('Asset Id')]) }, [
        target([property('Asset_Id', { columnName: 'Asset Id' })]),
      ]),
      {
        nodes: [source('src'), call('fanout'), sink('out')],
        edges: wire([
          ['src', 'fanout'],
          ['fanout', 'out'],
        ]),
      },
    );

    expect(codes(problems)).toEqual(['shape-not-checked']);
    expect(problems[0]?.level).toBe('warning');
    expect(problems[0]?.message).toContain('"fanout"');
    expect(problems[0]?.message).toMatch(/call node/);
  });

  it('does not guess, even when the columns behind the transform would not have fitted', () => {
    // The same graph as above, whose source→sink form is an error. Reporting that error through
    // a transform would be inventing a fact about code nobody read.
    const problems = check(
      knowing({ src: shape([column('Asset Id')]) }, [
        target([property('Asset_Id', { columnName: 'Asset Id' })]),
      ]),
      throughTransform,
    );

    expect(codes(problems)).not.toContain('shape-source-spelling');
    expect(codes(problems)).not.toContain('shape-missing-column');
  });

  it('stays silent when nothing behind the transform has a discovered shape', () => {
    // "Could not be checked" is worth saying about a question somebody asked. A deployment that
    // has never run discovery would otherwise carry a permanent amber line on every graph, which
    // is the same noise by another route.
    const problems = check(knowing({}, [target([property('Asset_Id')])]), throughTransform);

    expect(problems).toEqual([]);
  });

  it('terminates on a graph that already loops', () => {
    // The walk backwards from a transform looks for a source with a shape. Core reports the
    // cycle, but the canvas still draws the graph and still runs these checks, and a traversal
    // that hung would take the browser with it mid-drag.
    const looped = {
      nodes: [source('src'), transform('a'), transform('b'), sink('out')],
      edges: wire([
        ['src', 'a'],
        ['a', 'b'],
        ['b', 'a'],
        ['b', 'out'],
      ]),
    };

    expect(codes(check(knowing({ src: shape([column('id')]) }, [target([])]), looped))).toEqual([
      'shape-not-checked',
    ]);
  });
});

describe('what it declines to answer', () => {
  it('says nothing at all about a source nobody has discovered', () => {
    expect(check(knowing({}, [target([property('Asset_Id')])]))).toEqual([]);
  });

  it('says it cannot see the type, rather than reporting every column as missing', () => {
    // A type this console cannot see is not a type with no columns. Comparing against an empty
    // property list would report a fit; comparing against nothing at all would be an error about
    // a graph that may be perfect.
    const problems = check(knowing({ src: shape([column('id')]) }, []));

    expect(codes(problems)).toEqual(['shape-not-checked']);
    expect(problems[0]?.level).toBe('warning');
    expect(problems[0]?.message).toContain('Subwo');
  });

  it('says nothing about a sink that has not been told what it writes', () => {
    // The other half of the canvas's INCOMPLETE/WRONG pair, at this level: a sink dropped from
    // the palette has no type yet, `sink-has-no-type` already says so, and a second complaint
    // about columns it cannot have is how somebody learns to scroll past the panel.
    const unfinished = { nodes: [source('src'), sink('out', '')], edges: wire([['src', 'out']]) };

    expect(check(knowing({ src: shape([column('id')]) }, [target([])]), unfinished)).toEqual([]);
  });

  it('says nothing about a sink nothing is wired into yet', () => {
    const unwired = { nodes: [source('src'), sink('out')], edges: [] };

    expect(
      check(knowing({ src: shape([column('id')]) }, [target([property('nope')])]), unwired),
    ).toEqual([]);
  });

  it('checks each source feeding one sink on its own', () => {
    // Inbound edges are concatenated, so every source has to supply the columns — one of them
    // being complete does not excuse the other, and one problem naming both would name the wrong
    // box for whoever has to fix it.
    const merged = {
      nodes: [source('a'), source('b'), sink('out')],
      edges: wire([
        ['a', 'out'],
        ['b', 'out'],
      ]),
    };
    const problems = check(
      knowing({ a: shape([column('id')]), b: shape([column('other')]) }, [
        target([property('id')]),
      ]),
      merged,
    );

    expect(codes(problems)).toEqual(['shape-missing-column']);
    expect(problems[0]?.nodeIds).toEqual(['b', 'out']);
  });
});

describe('through validateWorkflow', () => {
  const spelling = knowing({ src: shape([column('Asset Id')]) }, [
    target([property('Asset_Id', { columnName: 'Asset Id' })]),
  ]);
  const unproven = knowing({ src: shape([column('miles', { type: 'string' })]) }, [
    target([property('miles', { type: 'number' })]),
  ]);
  const allTransforms = { transformIds: new Set(['tx-1']) };

  it('runs nothing at all when the caller supplied no shapes', () => {
    // The default, and the reason every existing caller is unaffected. Absent is not empty: a
    // caller with nothing to say has not learned that the graph is fine.
    const problems = validateWorkflow(direct, allTransforms);

    expect(codes(problems)).toEqual([]);
  });

  it('paints the wire red for an error and leaves it alone for a warning', () => {
    // Edge ids come from `edgesFor`, which keys off the code — the same derivation core's issues
    // go through, rather than a second copy. A warning that painted a wire red would be wearing
    // error styling, which is the whole thing this level distinction is for.
    const wrong = validateWorkflow(direct, { ...allTransforms, shapes: spelling });
    const unsure = validateWorkflow(direct, { ...allTransforms, shapes: unproven });

    expect(wrong[0]?.edgeIds).toEqual(['src->out']);
    expect(unsure[0]?.edgeIds).toEqual([]);
  });

  it('blocks the save on a mismatch and never on a question', () => {
    expect(
      hasBlockingProblem(validateWorkflow(direct, { ...allTransforms, shapes: spelling })),
    ).toBe(true);
    expect(
      hasBlockingProblem(validateWorkflow(direct, { ...allTransforms, shapes: unproven })),
    ).toBe(false);
  });

  it('reports the columns alongside the wiring rather than instead of it', () => {
    // Same rule as every other canvas-only check: gating one behind another makes somebody fix a
    // problem only to be told about the next.
    const orphaned = {
      nodes: [...direct.nodes, transform('stray')],
      edges: direct.edges,
    };

    const problems = validateWorkflow(orphaned, { ...allTransforms, shapes: spelling });

    expect(codes(problems)).toEqual(
      expect.arrayContaining(['unreachable', 'shape-source-spelling']),
    );
  });
});
