import type { CatalogWorkflow, ConnectorRun, SnapshotRef } from '@dudousxd/nestjs-catalog';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowRunnerService } from './workflow-runner.service';

/** See the note in `pipeline.module.integration.spec.ts`: the package cannot load here. */
vi.mock('@dudousxd/nestjs-durable', () => ({
  WorkflowEngine: class WorkflowEngine {},
  Step: () => (_target: unknown, _key: unknown, descriptor: unknown) => descriptor,
  Workflow: () => (target: unknown) => target,
}));

/**
 * "Only load if the read brought something back", and the snapshot it protects.
 *
 * WHAT THIS FILE IS FOR
 * ---------------------
 * The empty-source case, which is the one the row-count predicate was built for
 * and the one that is not hypothetical: an upstream system is mid-maintenance,
 * the nightly export comes back with nothing in it, and nothing is *broken* —
 * so the run succeeds, the sink commits, and committing repoints the live view
 * of the type at an empty snapshot. Yesterday's good data stops being served and
 * the run reports success while it happens.
 *
 * A gate in front of the sink turns that into a skip. The assertion is therefore
 * the same one `workflow-runner.branch.spec.ts` makes and for the same reason —
 * `commitAsSystem` watched at the publish seam, not a status read off the
 * outcomes — because a run that reported everything correctly and still called
 * commit would pass a test written against `nodeOutcomes` alone.
 *
 * The other half is the replay property. The count is read off the step's
 * checkpointed *input* rather than by counting staged rows, and the last case
 * here proves it by handing the step a count for a stage that was never written:
 * a run resumed on another pod decides from what the first attempt recorded.
 */

const VARIABLE_FREE_SNAPSHOT = 'wf-run-rows-1';

/**
 * `src → gate --then--> load`, and no else wire at all.
 *
 * The absence is deliberate: the alternative to loading here is *not loading*,
 * so there is nothing on the other side to draw. A gate with one branch is a
 * guard, and `validateWorkflow` accepts one — see the branch spec in
 * `@dudousxd/nestjs-catalog`.
 */
function workflowReading(records: Array<Record<string, unknown>>, atLeast = 1): CatalogWorkflow {
  return {
    id: 'wf-rows',
    name: 'Nightly fleet',
    nodes: [
      {
        id: 'src',
        kind: 'source',
        name: 'Fleet export',
        sourceKind: 'inline',
        config: { records },
      },
      {
        id: 'gate',
        kind: 'if',
        name: 'Anything to load',
        predicate: { kind: 'rowCount', atLeast },
      },
      { id: 'load', kind: 'sink', name: 'Into Fleet', targetType: 'Fleet' },
    ],
    edges: [
      { from: 'src', to: 'gate' },
      { from: 'gate', to: 'load', branch: 'then' },
    ],
    status: 'ready',
    enabled: true,
    version: 4,
    graphHash: 'abcdef0123456789',
    targetType: 'Fleet',
    createdBy: 'ana',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/**
 * A store and a publish seam that record rather than assert.
 *
 * `committed` is the load-bearing one: `commitAsSystem` appends to it and
 * nothing else does, so a type in that array is a type whose live view was
 * repointed. Delete the skip and no other line in this file can keep it out.
 */
function harness(workflow: CatalogWorkflow) {
  const stages = new Map<string, Array<Record<string, unknown>>>();
  const runs: ConnectorRun[] = [];
  const committed: string[] = [];
  const appended: string[] = [];

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
      stages.set(`${input.runId}/${input.nodeId}/${input.batch}`, input.rows);
      return Promise.resolve();
    },
    readStage: (input: { runId: string; nodeId: string; batch: number }) =>
      Promise.resolve(stages.get(`${input.runId}/${input.nodeId}/${input.batch}`) ?? []),
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
      typeName: string,
      _snapshotId: string,
      rows: Array<Record<string, unknown>>,
    ) => {
      appended.push(typeName);
      return Promise.resolve({ written: rows.length });
    },
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

  return { service, committed, appended };
}

/** One inline run over a source that read `records`. */
async function runOver(
  records: Array<Record<string, unknown>>,
  atLeast = 1,
): Promise<{ run: ConnectorRun; committed: string[]; appended: string[] }> {
  const workflow = workflowReading(records, atLeast);
  const { service, committed, appended } = harness(workflow);
  const run = await service.runInline({
    workflow,
    connectorId: 'conn-1',
    principalId: 'ana',
    snapshotId: VARIABLE_FREE_SNAPSHOT,
  });
  return { run, committed, appended };
}

describe('a sink behind a gate that counts what arrived', () => {
  it('does not commit when the read brought back nothing', async () => {
    // THE ONE THAT MATTERS. An empty snapshot committed here replaces whatever
    // is being served with nothing, and reports success while doing it.
    const { committed, appended } = await runOver([]);

    expect(committed).toEqual([]);
    expect(appended).toEqual([]);
  });

  it('commits when the read brought back rows', async () => {
    const { committed } = await runOver([{ id: 1 }, { id: 2 }]);

    expect(committed).toEqual(['Fleet']);
  });

  it('is a successful run when it stood the sink down, not a failed one', async () => {
    // An empty upstream is not a broken pipeline. Reporting it as failed trains
    // everybody to ignore a red run on this connector, which is worse than the
    // thing being signalled — and the data it was protecting is still served.
    const { run } = await runOver([]);

    expect(run.status).toBe('succeeded');
  });

  it('holds the sink below a threshold larger than one', async () => {
    // "A full export is never legitimately this small, so treat it as a broken
    // upstream rather than as data" — the same guard, at a number somebody who
    // knows the pipeline chose.
    const { committed } = await runOver([{ id: 1 }, { id: 2 }], 5);

    expect(committed).toEqual([]);
  });
});

describe('what the run says about a count it branched on', () => {
  it('records the branch on the gate and the reason on the sink', async () => {
    const { run } = await runOver([]);

    expect(run.nodeOutcomes?.gate).toMatchObject({ status: 'succeeded', rows: 0, branch: 'else' });
    // Not the same `skipped` a failure leaves behind: this sink was right not to
    // run, and the panel has to be able to say so.
    expect(run.nodeOutcomes?.load).toEqual({
      status: 'skipped',
      rows: 0,
      skippedBecause: 'branch-not-taken',
    });
  });

  it('says the count and the threshold in the run log', async () => {
    // "0 rows, against a threshold of 1" beside "nothing was committed" is the
    // whole answer to "why was Fleet not refreshed last night", in one place.
    const { run } = await runOver([]);
    const said = run.logs.join('\n');

    expect(said).toContain('counted what reached it: 0 rows');
    expect(said).toContain('threshold of 1');
    expect(said).toContain('still live');
  });
});

describe('where the count comes from', () => {
  it('reads it off the step input rather than counting staged rows', async () => {
    // THE REPLAY PROPERTY, as a test. The step is handed a stage ref claiming
    // seven rows for a stage this harness never wrote — so any implementation
    // that went and counted the rows would answer "else". Reading the number the
    // run already recorded is what makes a resumed run on another pod reproduce
    // the first attempt's decision.
    const workflow = workflowReading([], 5);
    const { service } = harness(workflow);

    const output = await service.executeNode({
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      runId: VARIABLE_FREE_SNAPSHOT,
      nodeId: 'gate',
      principalId: 'ana',
      inputs: [{ runId: VARIABLE_FREE_SNAPSHOT, nodeId: 'src', batches: 1, rowCount: 7 }],
    });

    expect(output.branch).toBe('then');
    expect(output.rows).toBe(7);
  });

  it('hands on the ref it was given rather than staging a copy', async () => {
    const workflow = workflowReading([], 1);
    const { service } = harness(workflow);

    const output = await service.executeNode({
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      runId: VARIABLE_FREE_SNAPSHOT,
      nodeId: 'gate',
      principalId: 'ana',
      inputs: [{ runId: VARIABLE_FREE_SNAPSHOT, nodeId: 'src', batches: 2, rowCount: 7 }],
    });

    expect(output.output).toEqual({
      runId: VARIABLE_FREE_SNAPSHOT,
      nodeId: 'src',
      batches: 2,
      rowCount: 7,
    });
  });

  it('refuses to decide when it was handed no stage at all', async () => {
    // A graph that validated cannot get here — a gate with no inbound edge is
    // unreachable from any source. Reaching it means the graph was edited under
    // the run, and "no rows arrived" would silently be the answer forever.
    const workflow = workflowReading([], 1);
    const { service } = harness(workflow);

    await expect(
      service.executeNode({
        workflowId: workflow.id,
        workflowVersion: workflow.version,
        runId: VARIABLE_FREE_SNAPSHOT,
        nodeId: 'gate',
        principalId: 'ana',
        inputs: [],
      }),
    ).rejects.toThrow(/one/);
  });
});
