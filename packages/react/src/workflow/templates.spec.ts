import {
  CONNECTOR_KINDS,
  TRANSFORM_LANGUAGES,
  type TransformLanguage,
  WORKFLOW_NODE_ID_PATTERN,
  isSafeIdentifier,
  validateWorkflow as validateCoreWorkflow,
} from '@dudousxd/nestjs-catalog/client';
import { describe, expect, it } from 'vitest';
import {
  RELOAD_CADENCES,
  RELOAD_CADENCE_IDS,
  SOURCE_KINDS,
  type TemplatePlan,
  type TemplateRequest,
  WORKFLOW_TEMPLATES,
  WORKFLOW_TEMPLATE_IDS,
  attachTransformIds,
  buildWorkflowTemplate,
  enrichWithLookup,
  fanOutTypes,
  joinSources,
  loadFileDrop,
  periodicFullReload,
  planIsRunnable,
  planToWorkflowInput,
  refuseUnusableColumnNames,
  replicateTable,
  withinMsFor,
} from './templates';
import { validateWorkflow } from './validate';

/**
 * What these tests are actually for.
 *
 * A template's whole claim is that it makes a decision correctly so that nobody
 * has to make it again. So the assertions are about the *decisions*, not about
 * the shape: that the graph a template produces is one the server would accept,
 * that the code it ships genuinely joins, that the two halves of a periodic
 * reload agree by construction, and — most of all — that the templates which
 * would have to guess about column naming refuse instead.
 *
 * A test that passed whether or not the template filled in a field would be
 * worthless, so nothing here asserts merely that a key exists. Every check
 * pins a value, executes the shipped code, or asserts a refusal that a wrong
 * implementation would not produce.
 */

/** Every request the picker can make, with options that should succeed. */
const WORKING_REQUESTS: Record<(typeof WORKFLOW_TEMPLATE_IDS)[number], TemplateRequest> = {
  'replicate-table': {
    templateId: 'replicate-table',
    options: { targetType: 'Mvr', sourceColumns: ['asset_id', 'serial_no'] },
  },
  'load-file-drop': {
    templateId: 'load-file-drop',
    options: { targetType: 'Subwo', kind: 's3', sourceColumns: ['wo_number', 'base'] },
  },
  'fan-out-types': {
    templateId: 'fan-out-types',
    options: {
      sourceKind: 'sql',
      language: 'javascript',
      targets: [
        { targetType: 'Mvr', properties: ['asset_id', 'serial_no'] },
        { targetType: 'Subwo', properties: ['asset_id', 'wo_number'] },
      ],
    },
  },
  'join-sources': {
    templateId: 'join-sources',
    options: {
      targetType: 'Mvr',
      language: 'javascript',
      discriminator: 'wo_number',
      leftKey: 'unit_raw',
      rightKey: 'unit_raw',
      leftSourceKind: 'sql',
      rightSourceKind: 'sql',
    },
  },
  'enrich-with-lookup': {
    templateId: 'enrich-with-lookup',
    options: {
      targetType: 'Subwo',
      language: 'javascript',
      discriminator: 'wo_number',
      leftKey: 'unit_raw',
      rightKey: 'unit_raw',
      leftSourceKind: 'sql',
      rightSourceKind: 'sql',
    },
  },
  'periodic-full-reload': {
    templateId: 'periodic-full-reload',
    options: {
      targetType: 'Mvr',
      sourceKind: 'sql',
      cadence: 'daily',
      because: 'The upstream ingest deletes and reinserts per base every night.',
      sourceColumns: ['asset_id'],
    },
  },
};

/** A plan with every transform pointed at code, as a screen would have left it. */
function applied(plan: TemplatePlan): TemplatePlan {
  return attachTransformIds(
    plan,
    new Map(plan.transforms.map((request, index) => [request.forNodeId, `transform-${index}`])),
  );
}

function planFor(id: (typeof WORKFLOW_TEMPLATE_IDS)[number]): TemplatePlan {
  const outcome = buildWorkflowTemplate(WORKING_REQUESTS[id]);
  if (!outcome.ok) throw new Error(`${id} refused: ${outcome.refusals[0]?.message}`);
  return outcome.plan;
}

/**
 * Run a shipped JavaScript starter body the way the runner would.
 *
 * The runner splices `code` into `async (records) => { … }`. Reproducing that
 * here is the difference between asserting the template emits a string and
 * asserting it emits a join that works.
 */
function runStarter(code: string, records: Array<Record<string, unknown>>): unknown {
  return new Function('records', code)(records);
}

describe('the catalogue', () => {
  it('has metadata and a builder for every id, and builds them all', () => {
    expect(WORKFLOW_TEMPLATE_IDS).toHaveLength(6);
    for (const id of WORKFLOW_TEMPLATE_IDS) {
      expect(WORKFLOW_TEMPLATES[id].id).toBe(id);
      expect(WORKFLOW_TEMPLATES[id].assumes.length).toBeGreaterThan(0);
      expect(buildWorkflowTemplate(WORKING_REQUESTS[id]).ok).toBe(true);
    }
  });

  it('describes every source kind the library has, so a new kind cannot go missing', () => {
    // The point of `SOURCE_KINDS` being a Record over `ConnectorKind`. If this
    // ever fails, the type system failed first — which is the guarantee.
    expect(Object.keys(SOURCE_KINDS).sort()).toEqual([...CONNECTOR_KINDS].sort());
    for (const kind of CONNECTOR_KINDS) {
      expect(SOURCE_KINDS[kind].required.length).toBeGreaterThan(0);
    }
  });
});

describe('what every template produces', () => {
  it.each(WORKFLOW_TEMPLATE_IDS)('%s produces a graph core accepts', (id) => {
    const plan = applied(planFor(id));
    // Core's own validator, not a paraphrase of it: this is the function the
    // store runs before it will save anything.
    expect(validateCoreWorkflow({ nodes: plan.nodes, edges: plan.edges })).toEqual([]);
    // And the canvas's, which adds the checks core cannot make.
    expect(
      validateWorkflow(
        { nodes: plan.nodes, edges: plan.edges },
        { transformIds: new Set(plan.transforms.map((_, index) => `transform-${index}`)) },
      ),
    ).toEqual([]);
    expect(planIsRunnable(plan)).toBe(true);
  });

  it.each(WORKFLOW_TEMPLATE_IDS)('%s gives every node a usable id', (id) => {
    for (const node of planFor(id).nodes) {
      expect(WORKFLOW_NODE_ID_PATTERN.test(node.id)).toBe(true);
    }
  });

  it('keeps node ids usable even when the type name cannot be one', () => {
    // A node id becomes a durable step name, so a type called `Asset LIN/TAMCN`
    // must not produce an id the server refuses — reported as a validation
    // error about a field nobody typed.
    const outcome = replicateTable({
      targetType: 'Asset LIN/TAMCN',
      sourceColumns: ['asset_id'],
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    for (const node of outcome.plan.nodes) {
      expect(WORKFLOW_NODE_ID_PATTERN.test(node.id)).toBe(true);
    }
  });

  it.each(WORKFLOW_TEMPLATE_IDS)('%s never claims incremental', (id) => {
    // The second rule: no template offers a mode it cannot justify. An
    // incremental load is refused outright without a delete declaration and
    // needs a watermark column no template can know.
    for (const node of planFor(id).nodes) {
      if (node.kind === 'transform') continue;
      expect(node.mode).toBe('full');
    }
  });

  it.each(WORKFLOW_TEMPLATE_IDS)('%s says where each decision can be changed', (id) => {
    // The first rule: a template must not hide the decision. A declaration with
    // no `changeAt` is a decision somebody cannot undo.
    const plan = planFor(id);
    expect(plan.declarations.length).toBeGreaterThan(0);
    for (const declaration of plan.declarations) {
      expect(declaration.what.trim().length).toBeGreaterThan(0);
      expect(declaration.why.trim().length).toBeGreaterThan(0);
      expect(declaration.changeAt.trim().length).toBeGreaterThan(0);
    }
  });

  it('ships source config blank rather than plausible', () => {
    // A placeholder that looks like a real address is worse than an empty one:
    // it is the kind of thing that gets saved unread.
    const plan = planFor('replicate-table');
    const source = plan.nodes.find((node) => node.kind === 'source');
    expect(source?.kind === 'source' && source.config).toEqual({ url: '', query: '' });
    expect(plan.todo.length).toBeGreaterThan(0);
  });
});

describe('a plan whose transforms do not exist yet', () => {
  it('is refused by core until the transforms are attached', () => {
    const plan = planFor('fan-out-types');
    expect(plan.transforms).toHaveLength(2);

    // Deliberately not valid. A transform node pointing at no code cannot run,
    // and a template that pretended otherwise would push the failure to the
    // first load.
    const before = validateCoreWorkflow({ nodes: plan.nodes, edges: plan.edges });
    expect(before.map((issue) => issue.code)).toEqual([
      'transform-not-named',
      'transform-not-named',
    ]);
    expect(planIsRunnable(plan)).toBe(false);

    expect(validateCoreWorkflow(applied(plan))).toEqual([]);
  });

  it('leaves a node alone when its transform was not created', () => {
    // A partial failure part-way through creating three transforms must leave a
    // graph that still says which node is unfinished.
    const plan = planFor('fan-out-types');
    const half = attachTransformIds(plan, new Map([[plan.transforms[0].forNodeId, 'made-it']]));
    expect(planIsRunnable(half)).toBe(false);
    expect(validateCoreWorkflow(half).map((issue) => issue.code)).toEqual(['transform-not-named']);
  });
});

describe('the identifier refusal', () => {
  it('refuses the column names that produced the null columns, and names each one', () => {
    const outcome = replicateTable({
      targetType: 'Subwo',
      sourceColumns: ['wo_number', 'Asset Id', 'base', 'Asset LIN/TAMCN'],
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusals).toHaveLength(1);
    expect(outcome.refusals[0].code).toBe('columns-not-identifiers');
    // All of them, not the first: a legacy export is wrong about forty columns
    // in the same way and one refusal per attempt would make it a morning.
    expect(outcome.refusals[0].subjects).toEqual(['Asset Id', 'Asset LIN/TAMCN']);
    expect(outcome.refusals[0].message).toContain('"Asset Id"');
    expect(outcome.refusals[0].message).toContain('"Asset LIN/TAMCN"');
  });

  it('refuses when nobody has said what the columns are', () => {
    // Silence is not a pass. Proceeding on an unknown column list is asserting
    // the names are fine because nobody looked, which is how the six types were
    // built.
    const outcome = replicateTable({ targetType: 'Subwo' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusals[0].code).toBe('columns-unknown');
  });

  it('refuses a file drop header the same way', () => {
    // The header of a DPAS-style spreadsheet is the most likely place to meet
    // this, so the drop template must not be the lenient one.
    const outcome = loadFileDrop({
      targetType: 'Mel',
      kind: 'file',
      sourceColumns: ['Asset LIN/TAMCN'],
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusals[0].code).toBe('columns-not-identifiers');
  });

  it('agrees with the catalog rule exactly, rather than with a copy of it', () => {
    // If these two ever disagree the canvas is promising a load the publisher
    // would refuse, which is the drift the shared function exists to prevent.
    const names = [
      'asset_id',
      'Asset Id',
      'AssetId',
      '_leading',
      '1leading',
      'Asset LIN/TAMCN',
      'total-rows',
      'a.b',
      'año',
      'x'.repeat(63),
      'x'.repeat(64),
      '',
    ];
    for (const name of names) {
      const refusal = refuseUnusableColumnNames([name], { what: 'it', remedy: '' });
      expect(refusal === undefined).toBe(isSafeIdentifier(name));
    }
  });

  it('says nothing when every column is already usable', () => {
    expect(refuseUnusableColumnNames(['a', 'b_c'], { what: 'it', remedy: '' })).toBeUndefined();
    // An empty list is a source that was discovered and reported no columns,
    // which is a different fact from nobody having asked.
    expect(refuseUnusableColumnNames([], { what: 'it', remedy: '' })).toBeUndefined();
  });

  it('checks the property names a fan-out would write, not just source columns', () => {
    const outcome = fanOutTypes({
      sourceKind: 'sql',
      language: 'javascript',
      targets: [
        { targetType: 'Mvr', properties: ['asset_id'] },
        { targetType: 'Subwo', properties: ['Asset Id'] },
      ],
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusals[0].code).toBe('columns-not-identifiers');
    expect(outcome.refusals[0].subjects).toEqual(['Asset Id']);
  });
});

describe('fanning one source into several types', () => {
  it('gives each type its own transform, so branches do not commit identical rows', () => {
    const plan = planFor('fan-out-types');
    const transforms = plan.nodes.filter((node) => node.kind === 'transform');
    const sinks = plan.nodes.filter((node) => node.kind === 'sink');
    const sources = plan.nodes.filter((node) => node.kind === 'source');
    expect(sources).toHaveLength(1);
    expect(transforms).toHaveLength(2);
    expect(sinks).toHaveLength(2);
    // One read feeding both branches is the entire reason for the shape.
    expect(plan.edges.filter((edge) => edge.from === sources[0].id)).toHaveLength(2);
  });

  it('narrows to exactly the properties the type commits', () => {
    const plan = planFor('fan-out-types');
    const mvr = plan.transforms.find((request) => request.name.includes('Mvr'));
    expect(mvr).toBeDefined();
    if (!mvr) return;
    const rows = runStarter(mvr.code, [
      { asset_id: 'A1', serial_no: 'S1', wo_number: 'W1', extra: 'drop me' },
    ]);
    expect(rows).toEqual([{ asset_id: 'A1', serial_no: 'S1' }]);
  });

  it('refuses two branches aimed at one type, which core would also refuse', () => {
    const outcome = fanOutTypes({
      sourceKind: 'sql',
      language: 'javascript',
      targets: [
        { targetType: 'Mvr', properties: ['asset_id'] },
        { targetType: 'Mvr', properties: ['serial_no'] },
      ],
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusals.map((refusal) => refusal.code)).toContain('duplicate-target-type');

    // The refusal is not the template being fussy: the same graph built by hand
    // is one core rejects. This is what makes the early refusal worth having —
    // at the point of choosing it is a typo, afterwards it is a graph to unpick.
    const byHand = {
      nodes: [
        { id: 'src', name: 's', kind: 'source' as const, sourceKind: 'sql' as const, config: {} },
        { id: 'a', name: 'a', kind: 'sink' as const, targetType: 'Mvr' },
        { id: 'b', name: 'b', kind: 'sink' as const, targetType: 'Mvr' },
      ],
      edges: [
        { from: 'src', to: 'a' },
        { from: 'src', to: 'b' },
      ],
    };
    expect(validateCoreWorkflow(byHand).map((issue) => issue.code)).toContain(
      'duplicate-sink-type',
    );
  });

  it('refuses a single type, which is a different template', () => {
    const outcome = fanOutTypes({
      sourceKind: 'sql',
      language: 'javascript',
      targets: [{ targetType: 'Mvr', properties: ['asset_id'] }],
    });
    expect(outcome.ok).toBe(false);
  });
});

describe('joining and enriching', () => {
  const feed = [
    { wo_number: 'W1', unit_raw: '21 LRS', hours: 4 },
    { wo_number: 'W2', unit_raw: 'NOT IN DICTIONARY', hours: 9 },
  ];
  const lookup = [{ unit_raw: '21 LRS', unit: '21st Logistics Readiness Squadron' }];

  it('puts the left source first, because edge order decides which side is which', () => {
    const plan = planFor('join-sources');
    const transform = plan.nodes.find((node) => node.kind === 'transform');
    const inbound = plan.edges.filter((edge) => edge.to === transform?.id);
    expect(inbound).toHaveLength(2);
    const names = inbound.map((edge) => plan.nodes.find((node) => node.id === edge.from)?.name);
    // Edge order is part of the graph fingerprint, so this ordering is
    // load-bearing rather than tidy: swapping it is a new version of the graph.
    expect(names).toEqual(['Left source', 'Right source']);
  });

  it('splits the concatenated batch and joins it, dropping what has no counterpart', () => {
    const plan = planFor('join-sources');
    // Exactly what the runner hands over: both inputs in one array, in edge
    // order, with nothing marking which side a record came from.
    const rows = runStarter(plan.transforms[0].code, [...feed, ...lookup]);
    expect(rows).toEqual([
      { wo_number: 'W1', unit_raw: '21 LRS', hours: 4, unit: '21st Logistics Readiness Squadron' },
    ]);
  });

  it('keeps an unmatched row when enriching, because dropping it loses data silently', () => {
    const plan = planFor('enrich-with-lookup');
    const rows = runStarter(plan.transforms[0].code, [...feed, ...lookup]);
    // The difference between the two templates, and the reason they are two.
    expect(rows).toEqual([
      { wo_number: 'W1', unit_raw: '21 LRS', hours: 4, unit: '21st Logistics Readiness Squadron' },
      { wo_number: 'W2', unit_raw: 'NOT IN DICTIONARY', hours: 9 },
    ]);
  });

  it('lets the left record win where both sides carry a field', () => {
    const plan = planFor('join-sources');
    const rows = runStarter(plan.transforms[0].code, [
      { wo_number: 'W1', unit_raw: '21 LRS', owner: 'live value' },
      { unit_raw: '21 LRS', owner: 'stale dictionary value' },
    ]);
    // A stale dictionary overwriting live values is unrecoverable once
    // committed, so the spread order is a decision and is pinned here.
    expect(rows).toEqual([{ wo_number: 'W1', unit_raw: '21 LRS', owner: 'live value' }]);
  });

  it('does not join two records that are both missing the key', () => {
    // Found by running the shipped code rather than by reading it. Indexing a
    // record under `undefined` makes every keyless row on the left match the
    // last keyless row on the right — which returns a full result set with a
    // plausible row count and entirely wrong rows, the exact shape of failure
    // this whole file exists for.
    const plan = planFor('join-sources');
    const rows = runStarter(plan.transforms[0].code, [
      { wo_number: 'W1', hours: 4 },
      { unit: 'should not be joined to anything' },
    ]);
    expect(rows).toEqual([]);

    // Enriching keeps the row, but still unenriched rather than wrongly filled.
    const enriched = runStarter(planFor('enrich-with-lookup').transforms[0].code, [
      { wo_number: 'W1', hours: 4 },
      { unit: 'should not be joined to anything' },
    ]);
    expect(enriched).toEqual([{ wo_number: 'W1', hours: 4 }]);
  });

  it('refuses without a discriminator, because guessing reads the wrong half', () => {
    const outcome = joinSources({
      targetType: 'Mvr',
      language: 'javascript',
      discriminator: '   ',
      leftKey: 'a',
      rightKey: 'a',
      leftSourceKind: 'sql',
      rightSourceKind: 'sql',
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusals[0].code).toBe('incomplete');
    expect(outcome.refusals[0].subjects).toEqual(['the field that tells the two sides apart']);
  });

  it('names every blank field at once rather than one per attempt', () => {
    const outcome = joinSources({
      targetType: '',
      language: 'javascript',
      discriminator: '',
      leftKey: '',
      rightKey: '',
      leftSourceKind: 'sql',
      rightSourceKind: 'sql',
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusals[0].subjects).toHaveLength(4);
  });

  it('emits a body in every language the library has', () => {
    for (const language of TRANSFORM_LANGUAGES) {
      const outcome = enrichWithLookup({
        targetType: 'Subwo',
        language,
        discriminator: 'wo_number',
        leftKey: 'unit_raw',
        rightKey: 'unit_raw',
        leftSourceKind: 'sql',
        rightSourceKind: 'sql',
      });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      const request = outcome.plan.transforms[0];
      expect(request.language).toBe(language);
      // The discriminator has to reach the code, or the split it documents is
      // not the split it performs.
      expect(request.code).toContain('"wo_number"');
      expect(request.code).toContain('return');
    }
  });

  it('quotes a column name that would otherwise break the body it is written into', () => {
    // A template whose entire subject is awkward column names must not itself
    // emit a body that does not parse.
    const outcome = fanOutTypes({
      sourceKind: 'sql',
      language: 'javascript',
      targets: [
        { targetType: 'A', properties: ['a_1'] },
        { targetType: 'B', properties: ['b_1'] },
      ],
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    for (const request of outcome.plan.transforms) {
      expect(() => new Function('records', request.code)).not.toThrow();
    }
  });
});

describe('the periodic full reload', () => {
  it('derives the schedule and the interval from one cadence, for every cadence', () => {
    // The single reason this template is worth having. If these two could be set
    // apart they would drift, and a `withinMs` that does not match the schedule
    // is a declaration that polices nothing.
    for (const cadence of RELOAD_CADENCE_IDS) {
      const outcome = periodicFullReload({
        targetType: 'Mvr',
        sourceKind: 'sql',
        cadence,
        because: 'The upstream ingest deletes and reinserts per base.',
        sourceColumns: ['asset_id'],
      });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;

      const { schedule, expectations } = outcome.plan;
      expect(schedule?.cron).toBe(RELOAD_CADENCES[cadence].cron);
      expect(schedule?.everyMs).toBe(RELOAD_CADENCES[cadence].everyMs);

      expect(expectations).toHaveLength(1);
      const deletes = expectations[0].input.deletes;
      expect(deletes?.strategy).toBe('periodic-full-reload');
      // The link, pinned: one missed cycle tolerated, the second refused.
      expect(deletes && 'withinMs' in deletes && deletes.withinMs).toBe(
        RELOAD_CADENCES[cadence].everyMs * 2,
      );
      expect(withinMsFor(cadence)).toBe(RELOAD_CADENCES[cadence].everyMs * 2);
    }
  });

  it('declares the expectation against the type the sink commits', () => {
    const plan = planFor('periodic-full-reload');
    const sink = plan.nodes.find((node) => node.kind === 'sink');
    expect(sink?.kind === 'sink' && sink.targetType).toBe('Mvr');
    expect(plan.expectations[0].typeName).toBe('Mvr');
  });

  it('carries the operator reason through rather than inventing one', () => {
    const outcome = periodicFullReload({
      targetType: 'Mvr',
      sourceKind: 'sql',
      cadence: 'hourly',
      because: 'Base 21 reloads hourly and the table is small.',
      sourceColumns: ['asset_id'],
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const deletes = outcome.plan.expectations[0].input.deletes;
    expect(deletes?.because).toBe('Base 21 reloads hourly and the table is small.');
  });

  it('refuses a blank reason, because the pipeline refuses one too', () => {
    // `refuseUndeclaredDeletes` rejects a declaration whose reason is blank on
    // every strategy. Supplying a default here would defeat the mechanism.
    const outcome = periodicFullReload({
      targetType: 'Mvr',
      sourceKind: 'sql',
      cadence: 'daily',
      because: '   ',
      sourceColumns: ['asset_id'],
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusals[0].code).toBe('incomplete');
  });

  it('applies the same column check as the other no-transform graphs', () => {
    const outcome = periodicFullReload({
      targetType: 'Mvr',
      sourceKind: 'sql',
      cadence: 'daily',
      because: 'reason',
      sourceColumns: ['Asset Id'],
    });
    expect(outcome.ok).toBe(false);
  });

  it('is the only template that declares an expectation', () => {
    for (const id of WORKFLOW_TEMPLATE_IDS) {
      const plan = planFor(id);
      expect(plan.expectations.length).toBe(id === 'periodic-full-reload' ? 1 : 0);
      expect(plan.schedule === undefined).toBe(id !== 'periodic-full-reload');
    }
  });
});

describe('handing a plan to the save endpoint', () => {
  it('sends only the authored fields', () => {
    const input = planToWorkflowInput(applied(planFor('replicate-table')));
    // `version`, `graphHash`, `status`, `targetType` and the timestamps are
    // consequences the server writes; a body that could send them would let a
    // client claim a version it did not produce.
    expect(Object.keys(input).sort()).toEqual(['description', 'edges', 'name', 'nodes']);
    expect(input.name).toBe('Replicate Mvr');
    expect(input.edges).toEqual([{ from: input.nodes[0].id, to: input.nodes[1].id }]);
  });

  it('lets the caller name the workflow', () => {
    const outcome = replicateTable({
      targetType: 'Mvr',
      sourceColumns: ['asset_id'],
      workflowName: 'Nightly MVR',
    });
    expect(outcome.ok && outcome.plan.name).toBe('Nightly MVR');
  });
});
