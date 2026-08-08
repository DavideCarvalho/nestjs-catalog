import type {
  CatalogWorkflow,
  ConnectorRun,
  SnapshotRef,
  WorkflowLookupUnmatched,
} from '@dudousxd/nestjs-catalog';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowRunnerService } from './workflow-runner.service';

/** See the note in `pipeline.module.integration.spec.ts`: the package cannot load here. */
vi.mock('@dudousxd/nestjs-durable', () => ({
  WorkflowEngine: class WorkflowEngine {},
  Step: () => (_target: unknown, _key: unknown, descriptor: unknown) => descriptor,
  Workflow: () => (target: unknown) => target,
}));

/**
 * The lookup node as it actually executes: one side held, the other streaming.
 *
 * WHAT THIS FILE IS FOR
 * ---------------------
 * Three properties, and none of them is "the join produces the right rows" —
 * that part is arithmetic and would pass under any implementation.
 *
 * **The driving side must never be held.** The obvious implementation reads both
 * inputs and joins two arrays, and it is exactly the shape the node exists to
 * replace: a whole-batch transform doing this join over 44,720 rows reached 78%
 * of a hard 32 MiB output bound. So the load-bearing case here is `writes
 * enriched rows out before it has finished reading the driving side`, which no
 * assertion about the *output* could catch — both implementations produce the
 * same rows, the same outcome and the same log, and differ only in the order they
 * touch the stage store.
 *
 * **The counts must be reported whatever the disposition.** This node was built
 * against a failure that is not a crash: flip's SUBWO reader builds the same two
 * maps and, against an unseeded reference, produces 44,720 rows with three
 * columns hard null and a green run. A zero-match join and a working one are
 * indistinguishable from outside unless somebody counts, so `matched`,
 * `unmatched` and `keyless` are asserted in the log and `rowsIn` on the outcome.
 *
 * **Two reference rows for one key must not silently pick a winner.** flip's
 * reader keeps the *last* duplicate for the plan map and the *first* for the unit
 * dictionary, forty lines apart in one file, and neither key column has a unique
 * constraint. Both cases are here: agreeing rows collapse, disagreeing rows fail.
 *
 * THE FIXTURE
 * -----------
 * The real one, reduced. `planId` → `Plan ID` is flip's own plan join, on the
 * real column spellings, and the two things it fills are the columns that came
 * out hard null when the reader was replicated.
 */

const SNAPSHOT = 'wf-run-lookup-1';

interface LookupShape {
  driving: Array<Record<string, unknown>>;
  reference: Array<Record<string, unknown>>;
  unmatched?: WorkflowLookupUnmatched;
  fields?: Record<string, string>;
  key?: string;
  referenceKey?: string;
}

/**
 * `subwo → enrich → Subwo`, with `plans` wired in as the reference.
 *
 * Two sources, because that is what the node's answer to "where does the
 * reference come from" is: another node in the graph, named by id. The reference
 * edge is drawn *second* deliberately — the node names it rather than taking the
 * first input, and a fixture that drew it first would pass under an
 * implementation that read edge order.
 */
function workflowLookingUp(shape: LookupShape): CatalogWorkflow {
  return {
    id: 'wf-lookup',
    name: 'SUBWO with plan names',
    nodes: [
      {
        id: 'subwo',
        kind: 'source',
        name: 'SUBWO drop',
        sourceKind: 'inline',
        config: { records: shape.driving },
      },
      {
        id: 'plans',
        kind: 'source',
        name: 'Work plans',
        sourceKind: 'inline',
        config: { records: shape.reference },
      },
      {
        id: 'enrich',
        kind: 'lookup',
        name: 'Plan names',
        reference: 'plans',
        key: shape.key ?? 'planId',
        referenceKey: shape.referenceKey ?? 'Plan ID',
        fields: shape.fields ?? { 'Plan Name': 'planName', 'Plan Desc': 'planDescription' },
        unmatched: shape.unmatched,
      },
      { id: 'load', kind: 'sink', name: 'Into Subwo', targetType: 'Subwo' },
    ],
    edges: [
      { from: 'subwo', to: 'enrich' },
      { from: 'plans', to: 'enrich' },
      { from: 'enrich', to: 'load' },
    ],
    status: 'ready',
    enabled: true,
    version: 3,
    graphHash: 'abcdef0123456789',
    targetType: 'Subwo',
    createdBy: 'ana',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/**
 * A store that records every stage read and write, in order.
 *
 * `ops` is the load-bearing one, for the reason `workflow-runner.filter.spec.ts`
 * gives about the same array: the counts alone cannot tell a streaming
 * implementation from a buffering one, because both read each batch exactly once.
 * What differs is *when* the first write lands.
 */
function harness(workflow: CatalogWorkflow) {
  const stages = new Map<string, Array<Record<string, unknown>>>();
  const runs: ConnectorRun[] = [];
  const committed: string[] = [];
  const writes: Array<{ key: string; rows: number }> = [];
  const ops: string[] = [];

  const store = {
    listWorkflows: () => Promise.resolve([workflow]),
    getWorkflow: () => Promise.resolve(workflow),
    saveWorkflow: () => Promise.resolve(workflow),
    publishWorkflow: () => Promise.resolve(workflow),
    saveWorkflowSchedule: () => Promise.resolve(workflow),
    adoptConnector: () => Promise.resolve(undefined),
    connectorsUsingWorkflow: () => Promise.resolve([]),
    getConnector: () => Promise.resolve(undefined),
    getConnection: () => Promise.resolve(undefined),
    getTransform: () => Promise.resolve(undefined),
    saveConnectorState: () => Promise.resolve(),

    writeStage: (input: {
      runId: string;
      nodeId: string;
      batch: number;
      rows: Array<Record<string, unknown>>;
    }) => {
      const key = `${input.runId}/${input.nodeId}/${input.batch}`;
      writes.push({ key, rows: input.rows.length });
      ops.push(`write ${key}`);
      stages.set(key, input.rows);
      return Promise.resolve();
    },
    readStage: (input: { runId: string; nodeId: string; batch: number }) => {
      const key = `${input.runId}/${input.nodeId}/${input.batch}`;
      ops.push(`read ${key}`);
      return Promise.resolve(stages.get(key) ?? []);
    },
    dropStages: () => Promise.resolve(0),

    startRun: (input: { connectorId: string; snapshotId: string; principalId: string }) => {
      const run: ConnectorRun = {
        id: `run-${runs.length + 1}`,
        ...input,
        status: 'running',
        fetched: 0,
        written: 0,
        logs: [],
        startedAt: '2026-02-01T02:00:00.000Z',
      };
      runs.push(run);
      return Promise.resolve(run);
    },
    finishRun: (id: string, outcome: Partial<ConnectorRun>) => {
      const run = runs.find((candidate) => candidate.id === id);
      if (run) Object.assign(run, outcome, { finishedAt: '2026-02-01T03:00:00.000Z' });
      return Promise.resolve(run);
    },
    listRuns: () => Promise.resolve([...runs]),
  };

  const publish = {
    appendRowsAsSystem: (
      _principalId: string,
      _typeName: string,
      _snapshotId: string,
      rows: Array<Record<string, unknown>>,
    ) => Promise.resolve({ written: rows.length }),
    carryForwardAsSystem: () => Promise.resolve({ carried: 0, total: 0, from: undefined }),
    commitAsSystem: (principalId: string, typeName: string, snapshotId: string) => {
      committed.push(typeName);
      return Promise.resolve<SnapshotRef>({
        id: snapshotId,
        rowCount: 0,
        createdAt: '2026-02-01T03:00:00.000Z',
        principalId,
      });
    },
  };

  const service = new WorkflowRunnerService(
    Object.assign(Object.create(null), store),
    Object.assign(Object.create(null), {
      run: () => Promise.reject(new Error('No node in this file names a transform.')),
    }),
    Object.assign(Object.create(null), publish),
  );

  return { service, stages, committed, writes, ops };
}

async function runOver(shape: LookupShape) {
  const workflow = workflowLookingUp(shape);
  const kit = harness(workflow);
  const run = await kit.service.runInline({
    workflow,
    connectorId: 'conn-1',
    principalId: 'ana',
    snapshotId: SNAPSHOT,
  });
  return { ...kit, run };
}

/** Everything this node staged, in order, across however many batches it wrote. */
function enriched(stages: Map<string, Array<Record<string, unknown>>>) {
  const rows: Array<Record<string, unknown>> = [];
  for (let batch = 1; ; batch += 1) {
    const staged = stages.get(`${SNAPSHOT}/enrich/${batch}`);
    if (staged === undefined) return rows;
    rows.push(...staged);
  }
}

/** The two real plan codes, with the two columns the replica could not fill. */
const PLANS = [
  { 'Plan ID': '43AA', 'Plan Name': 'VEHICLE MAINTENANCE', 'Plan Desc': 'Scheduled vehicle work' },
  { 'Plan ID': '34AA', 'Plan Name': 'FACILITY REPAIR', 'Plan Desc': 'Building repair' },
];

/** `count` SUBWO rows, cycling three plan codes of which one is not in `PLANS`. */
function subwo(count: number): Array<Record<string, unknown>> {
  const codes = ['43AA', '34AA', '99ZZ'];
  return Array.from({ length: count }, (_, index) => ({
    subWorkOrderId: index,
    planId: codes[index % codes.length],
  }));
}

describe('what a lookup brings across', () => {
  it('fills the columns the replica could not, on the rows that matched', async () => {
    // The flip case, reduced to three rows: `planName` and `planDescription` are
    // two of the three columns that came out hard null when the SUBWO reader was
    // replicated, and this is them arriving with no author code anywhere.
    const { run, stages } = await runOver({ driving: subwo(3), reference: PLANS });

    expect(run.status).toBe('succeeded');
    expect(enriched(stages)).toEqual([
      {
        subWorkOrderId: 0,
        planId: '43AA',
        planName: 'VEHICLE MAINTENANCE',
        planDescription: 'Scheduled vehicle work',
      },
      {
        subWorkOrderId: 1,
        planId: '34AA',
        planName: 'FACILITY REPAIR',
        planDescription: 'Building repair',
      },
      { subWorkOrderId: 2, planId: '99ZZ', planName: null, planDescription: null },
    ]);
  });

  it('takes its reference from the node it names rather than from the first edge', async () => {
    // The reference edge is drawn *second* in the fixture. An implementation that
    // read edge order would hold the SUBWO rows and stream the plans past them,
    // which produces a completely different — and much larger — result.
    const { stages } = await runOver({ driving: subwo(3), reference: PLANS });

    // Three rows out, not two: what streamed is the driving side.
    expect(enriched(stages)).toHaveLength(3);
  });

  it('compares keys as text, exactly as written', async () => {
    // A number on one side and a string on the other is the same key — the two
    // sides routinely come from different engines. Whitespace is not, and that is
    // the deliberate limit: deciding `"43AA "` and `"43AA"` are the same value is
    // a rule about somebody's data.
    const { stages } = await runOver({
      driving: [{ planId: 43 }, { planId: ' 43AA' }],
      reference: [
        { 'Plan ID': '43', 'Plan Name': 'COERCED' },
        { 'Plan ID': '43AA', 'Plan Name': 'NOT TRIMMED' },
      ],
      fields: { 'Plan Name': 'planName' },
    });

    expect(enriched(stages)).toEqual([
      { planId: 43, planName: 'COERCED' },
      { planId: ' 43AA', planName: null },
    ]);
  });
});

describe('how it gets through the data', () => {
  it('writes enriched rows out before it has finished reading the driving side', async () => {
    // THE ONE THAT MATTERS. The assertion is about *order* rather than counts,
    // because a buffering implementation reads each batch exactly once too — it
    // simply cannot write anything before the last read, having not joined a row
    // yet. 3,000 driving rows is six staged batches of 500.
    const { ops } = await runOver({ driving: subwo(3000), reference: PLANS });

    const firstWrite = ops.findIndex((op) => op.startsWith(`write ${SNAPSHOT}/enrich/`));
    const lastRead = ops.reduce(
      (found, op, index) => (op.startsWith(`read ${SNAPSHOT}/subwo/`) ? index : found),
      -1,
    );

    expect(firstWrite).toBeGreaterThan(-1);
    expect(firstWrite).toBeLessThan(lastRead);
  });

  it('reads the whole reference before it reads any driving row', async () => {
    // The other half of the same property, and the one that says which side is
    // held: the map has to be complete before the first driving row is looked up,
    // or a row would miss a reference entry that arrives later in the same run.
    const { ops } = await runOver({ driving: subwo(3000), reference: PLANS });

    // Measured over the ops *after* both sources have finished writing, because a
    // source's own stale-tail sweep reads one batch past its last — a read of
    // `subwo/7` that happens before this node starts and is not a driving read.
    const sourcesDone = ops.reduce(
      (found, op, index) =>
        op.startsWith(`write ${SNAPSHOT}/subwo/`) || op.startsWith(`write ${SNAPSHOT}/plans/`)
          ? index
          : found,
      -1,
    );
    const tail = ops.slice(sourcesDone + 1);
    const lastReferenceRead = tail.reduce(
      (found, op, index) => (op.startsWith(`read ${SNAPSHOT}/plans/`) ? index : found),
      -1,
    );
    const firstDrivingRead = tail.findIndex((op) => op.startsWith(`read ${SNAPSHOT}/subwo/`));

    expect(lastReferenceRead).toBeGreaterThan(-1);
    expect(firstDrivingRead).toBeGreaterThan(-1);
    expect(lastReferenceRead).toBeLessThan(firstDrivingRead);
  });

  it('coalesces its output into full batches rather than one per input batch', async () => {
    // Under `drop` the output is not the input's shape, which is the whole reason
    // batch numbering is a running count here rather than a position. 1,200 in,
    // two thirds of them matching, so 800 out: 500 and 300.
    const { writes } = await runOver({
      driving: subwo(1200),
      reference: PLANS,
      unmatched: 'drop',
    });

    const written = writes.filter((write) => write.key.includes('/enrich/'));
    expect(written.map((write) => write.rows)).toEqual([500, 300]);
  });

  it('empties a longer previous attempt’s tail rather than leaving it under this node', async () => {
    // The same sweep every staging node does, reached through the same helper.
    const workflow = workflowLookingUp({ driving: subwo(3), reference: PLANS });
    const kit = harness(workflow);
    kit.stages.set(`${SNAPSHOT}/enrich/2`, [{ subWorkOrderId: 99 }]);

    await kit.service.runInline({
      workflow,
      connectorId: 'conn-1',
      principalId: 'ana',
      snapshotId: SNAPSHOT,
    });

    expect(kit.stages.get(`${SNAPSHOT}/enrich/2`)).toEqual([]);
  });
});

describe('what the run says the lookup did', () => {
  it('counts matched, unmatched and keyless separately', async () => {
    // Three numbers, not one, and the third is the point of contention: flip's
    // reader folds "no key on this row" and "key the reference does not hold"
    // into the same NULL, and they have different causes and different fixes.
    const { run } = await runOver({
      driving: [{ planId: '43AA' }, { planId: '99ZZ' }, { planId: null }, {}, { planId: '' }],
      reference: PLANS,
    });

    const logs = run.logs.join('\n');
    expect(logs).toContain('matched 1 of them');
    expect(logs).toContain('1 had a key that matched nothing');
    expect(logs).toContain('3 had no key at all');
  });

  it('names a few of the keys the reference did not hold', async () => {
    // What turns "nothing matched" into a diagnosis in one glance: if these look
    // like they ought to have matched, the two sides differ in type or spacing.
    const { run } = await runOver({ driving: subwo(3), reference: PLANS });

    expect(run.logs.join('\n')).toContain('"99ZZ"');
  });

  it('reports rows in as well as rows out on the outcome', async () => {
    // Under `drop` the two differ, which is the case a single number cannot
    // describe — a lookup that dropped nine tenths of a load looks exactly like a
    // source that read a tenth as much.
    const { run } = await runOver({ driving: subwo(9), reference: PLANS, unmatched: 'drop' });

    expect(run.nodeOutcomes?.enrich).toMatchObject({ status: 'succeeded', rows: 6, rowsIn: 9 });
  });

  it('says so loudly when nothing matched at all, and says the reference was empty', async () => {
    // The whole reason this node exists. An unseeded reference table is flip's
    // actual production state — `vscos_work_plan` and `unit_dictionary` are both
    // empty in the environment this was replicated against — and today it
    // produces enriched-with-null rows and a green run.
    const { run } = await runOver({ driving: subwo(3), reference: [] });

    const logs = run.logs.join('\n');
    expect(logs).toContain('matched nothing at all');
    expect(logs).toContain('the reference side produced no rows');
  });

  it('distinguishes an empty reference from one that simply shares no key', async () => {
    // Two different diagnoses with the same symptom, and the fix for each is in a
    // different place: seed the table, or fix the column names.
    const { run } = await runOver({
      driving: subwo(3),
      reference: [{ 'Plan ID': 'NOTHING', 'Plan Name': 'x', 'Plan Desc': 'y' }],
    });

    expect(run.logs.join('\n')).toContain('the reference was not empty');
  });

  it('says how many distinct keys it indexed, so an empty map is visible', async () => {
    const { run } = await runOver({ driving: subwo(3), reference: PLANS });

    expect(run.logs.join('\n')).toContain('indexed 2 distinct keys');
  });
});

describe('a key that matches nothing', () => {
  it('nulls the enriched fields by default, and passes the row on', async () => {
    const { stages } = await runOver({
      driving: [{ planId: '99ZZ' }],
      reference: PLANS,
      fields: { 'Plan Name': 'planName' },
    });

    expect(enriched(stages)).toEqual([{ planId: '99ZZ', planName: null }]);
  });

  it('drops the row when asked to, and says so', async () => {
    const { stages, run } = await runOver({
      driving: subwo(3),
      reference: PLANS,
      unmatched: 'drop',
    });

    expect(enriched(stages)).toHaveLength(2);
    expect(run.logs.join('\n')).toContain('were dropped rather than passed on');
  });

  it('fails the node when asked to, naming the key it could not find', async () => {
    // For a reference that is a documented prerequisite — which is not
    // hypothetical: flip's docs make seeding the unit dictionary a prerequisite
    // of MEL, MVR and SUBWO, and an unseeded one yields unnormalized rows.
    const { run } = await runOver({ driving: subwo(3), reference: PLANS, unmatched: 'fail' });

    expect(run.status).toBe('failed');
    expect(run.nodeOutcomes?.enrich?.error).toContain('"99ZZ"');
  });

  it('writes null rather than leaving the column off the row', async () => {
    // A column present on some rows and absent on others multiplies the shapes in
    // the staged batch — the encoding is a dictionary of distinct key-sets — and
    // a sink looks every property up as `row[name]`, so absent and null are the
    // same commit with different costs.
    const { stages } = await runOver({
      driving: [{ planId: '99ZZ' }],
      reference: PLANS,
      fields: { 'Plan Name': 'planName' },
    });

    expect(Object.hasOwn(enriched(stages)[0] ?? {}, 'planName')).toBe(true);
  });
});

describe('two reference rows for one key', () => {
  it('collapses them when they agree about every field it brings across', async () => {
    // Nothing is chosen over anything: the answer is the same either way. This is
    // what a real reference table looks like when it has one row per key *and*
    // something else — which is the common case, and refusing it would make the
    // node unusable against the data it was built for.
    const { run, stages } = await runOver({
      driving: [{ planId: '43AA' }],
      reference: [
        { 'Plan ID': '43AA', 'Plan Name': 'VEHICLE MAINTENANCE', 'Work Plan Type Cd': 'A' },
        { 'Plan ID': '43AA', 'Plan Name': 'VEHICLE MAINTENANCE', 'Work Plan Type Cd': 'B' },
      ],
      fields: { 'Plan Name': 'planName' },
    });

    expect(run.status).toBe('succeeded');
    expect(enriched(stages)).toEqual([{ planId: '43AA', planName: 'VEHICLE MAINTENANCE' }]);
    expect(run.logs.join('\n')).toContain('Nothing was chosen over anything');
  });

  it('fails when they disagree, naming the key, the field and both values', async () => {
    // flip keeps the *last* duplicate for the plan map and the *first* for the
    // unit dictionary, forty lines apart in one file. Neither was chosen, and
    // neither key column has a unique constraint to prevent the case arising.
    const { run } = await runOver({
      driving: [{ planId: '43AA' }],
      reference: [
        { 'Plan ID': '43AA', 'Plan Name': 'VEHICLE MAINTENANCE' },
        { 'Plan ID': '43AA', 'Plan Name': 'SOMETHING ELSE' },
      ],
      fields: { 'Plan Name': 'planName' },
    });

    expect(run.status).toBe('failed');
    const error = run.nodeOutcomes?.enrich?.error ?? '';
    expect(error).toContain('"43AA"');
    expect(error).toContain('"Plan Name"');
    expect(error).toContain('VEHICLE MAINTENANCE');
    expect(error).toContain('SOMETHING ELSE');
  });

  it('fails before it has written anything, not at row ninety thousand', async () => {
    // The map is built before the first driving row is read, so a conflicted
    // reference stops the node rather than half-loading a snapshot.
    const { writes } = await runOver({
      driving: subwo(3000),
      reference: [
        { 'Plan ID': '43AA', 'Plan Name': 'ONE' },
        { 'Plan ID': '43AA', 'Plan Name': 'TWO' },
      ],
      fields: { 'Plan Name': 'planName' },
    });

    expect(writes.filter((write) => write.key.includes('/enrich/'))).toEqual([]);
  });

  it('does not care when they differ only in a column it does not bring across', async () => {
    // The rule is decided over the named fields only, because nothing about the
    // other columns reaches the output — so there is no winner to pick.
    const { run } = await runOver({
      driving: [{ planId: '43AA' }],
      reference: [
        { 'Plan ID': '43AA', 'Plan Name': 'VEHICLE MAINTENANCE', 'Plan Desc': 'one' },
        { 'Plan ID': '43AA', 'Plan Name': 'VEHICLE MAINTENANCE', 'Plan Desc': 'two' },
      ],
      fields: { 'Plan Name': 'planName' },
    });

    expect(run.status).toBe('succeeded');
  });
});

describe('a reference row with no key', () => {
  it('is not indexed, and is counted', async () => {
    // A real work-plan table has them: flip writes `planId: row.planId ?? ""`
    // when a load has no code, so the empty-string key is in the table by
    // construction. Indexing it would make one keyless reference row the answer
    // for every keyless driving row.
    const { run, stages } = await runOver({
      driving: [{ planId: '43AA' }, {}],
      reference: [
        { 'Plan ID': '', 'Plan Name': 'WOULD MATCH EVERYTHING' },
        { 'Plan ID': '43AA', 'Plan Name': 'VEHICLE MAINTENANCE' },
      ],
      fields: { 'Plan Name': 'planName' },
    });

    expect(enriched(stages)).toEqual([
      { planId: '43AA', planName: 'VEHICLE MAINTENANCE' },
      { planName: null },
    ]);
    expect(run.logs.join('\n')).toContain('1 reference rows had no value in "Plan ID"');
  });
});

describe('a column collision', () => {
  it('fails naming both rather than overwriting one', async () => {
    // Two columns, one name, and every rule for picking a winner is a rule about
    // which of somebody's data survives — the sentence `renameColumnRefusals`
    // says about the same problem arriving from the other direction.
    const { run } = await runOver({
      driving: [{ planId: '43AA', planName: 'ALREADY HERE' }],
      reference: PLANS,
      fields: { 'Plan Name': 'planName' },
    });

    expect(run.status).toBe('failed');
    expect(run.nodeOutcomes?.enrich?.error).toContain('already carry a column called "planName"');
  });
});

describe('the bound on the side that is held', () => {
  it('is checked against the announced row count, before a row is read', async () => {
    // The refusal is free: a staged input announces its `rowCount`, so this
    // happens before anything is held. A bound discovered by allocating until it
    // hurts has already done the damage — and the damage is a pod killed by the
    // kernel, which produces no run log at all.
    const workflow = workflowLookingUp({ driving: subwo(3), reference: PLANS });
    const kit = harness(workflow);

    // The reference stage, claimed to be far larger than it is. Nothing else in
    // the run changes, so a failure here is the bound and not the data.
    const output = kit.service.executeNode({
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      runId: SNAPSHOT,
      nodeId: 'enrich',
      principalId: 'ana',
      inputs: [
        { runId: SNAPSHOT, nodeId: 'subwo', batches: 1, rowCount: 3 },
        { runId: SNAPSHOT, nodeId: 'plans', batches: 1, rowCount: 5_000_000 },
      ],
    });

    await expect(output).rejects.toThrow(/would hold 5000000 reference rows/);
    expect(kit.ops).toEqual([]);
  });
});
