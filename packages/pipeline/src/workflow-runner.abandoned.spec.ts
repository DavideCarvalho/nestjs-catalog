import type { CatalogWorkflow, ConnectorRun, SnapshotRef } from '@dudousxd/nestjs-catalog';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowRunnerService } from './workflow-runner.service';

/** See the note in `pipeline.module.integration.spec.ts`: the package cannot load here. */
vi.mock('@dudousxd/nestjs-durable', () => ({
  WorkflowEngine: class WorkflowEngine {},
  Step: () => (_target: unknown, _key: unknown, descriptor: unknown) => descriptor,
  Workflow: () => (target: unknown) => target,
}));

const SNAPSHOT = 'wf-run-7';

/**
 * A source → sink graph, which is the smallest thing that is a whole run.
 *
 * Small on purpose but not stubbed: `runInline` really walks it, the sink really
 * commits through the publish stub, and the run really finishes. What is being
 * asserted is a side effect of *opening* the run, and a fixture that stopped
 * short of finishing could not tell "the scan closed the old row" from "the run
 * never got far enough to touch it".
 */
const workflow: CatalogWorkflow = {
  id: 'wf-1',
  name: 'Nightly fleet',
  nodes: [
    {
      id: 'n-source',
      kind: 'source',
      name: 'Fleet export',
      // A real fetcher over records the fixture holds, rather than a kind
      // registered into `SOURCES` for the duration of the file: the run has to
      // genuinely reach a source and stage what it read, and a fetcher installed
      // by the test is one more thing that could be what the assertions are
      // actually measuring.
      sourceKind: 'inline',
      config: { records: [{ id: 1 }, { id: 2 }] },
    },
    { id: 'n-sink', kind: 'sink', name: 'Into Mvr', targetType: 'Mvr' },
  ],
  edges: [{ from: 'n-source', to: 'n-sink' }],
  status: 'ready',
  enabled: true,
  version: 3,
  graphHash: 'abcdef0123456789',
  targetType: 'Mvr',
  createdBy: 'ana',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

/**
 * A run row an attempt left behind: `running`, nothing fetched, no error.
 *
 * This is the shape the incident produced — the row a 981k-row load left three
 * times over two hours, where the only record of what had happened was a rising
 * `attempts` against an empty error in `durable_step_checkpoints`.
 */
function orphan(over: Partial<ConnectorRun> = {}): ConnectorRun {
  return {
    id: 'run-abandoned',
    connectorId: 'conn-1',
    snapshotId: SNAPSHOT,
    principalId: 'scheduler',
    status: 'running',
    fetched: 0,
    written: 0,
    logs: ['Fetched 0 records from inline.'],
    startedAt: '2026-02-01T00:00:00.000Z',
    ...over,
  };
}

interface Options {
  /** Runs the store already holds, so the scan has something to find. */
  existingRuns?: ConnectorRun[];
  /** A store that cannot answer the scan at all. */
  breakListRuns?: boolean;
  /** Staged batches the store already holds, keyed by run id. */
  stages?: Record<string, number>;
}

/**
 * A store that really holds runs and stages, and changes only when it is told to.
 *
 * **Nothing in here closes a run.** `finishRun` writes exactly the outcome it is
 * handed onto exactly the row named, and `startRun` only ever appends a
 * `running` one. That is what makes the central claim below a claim about the
 * runner: if the scan is deleted, no other line in this file can turn
 * `run-abandoned` into `failed`.
 */
function harness(options: Options = {}) {
  const runs: ConnectorRun[] = [...(options.existingRuns ?? [])];
  const stages = new Map<string, Array<Record<string, unknown>>>();
  const dropped: string[] = [];
  const committed: string[] = [];

  for (const [snapshotId, batches] of Object.entries(options.stages ?? {})) {
    for (let batch = 1; batch <= batches; batch += 1) {
      stages.set(`${snapshotId}/staged/${batch}`, [{ id: batch }]);
    }
  }

  const store = {
    // `requireStore` narrows by asking for these by name — a store missing one
    // is refused before a run does anything, which would make this a test of the
    // capability check rather than of the scan.
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
    dropStages: (runId: string) => {
      dropped.push(runId);
      let count = 0;
      for (const key of [...stages.keys()]) {
        if (key.startsWith(`${runId}/`)) {
          stages.delete(key);
          count += 1;
        }
      }
      return Promise.resolve(count);
    },

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
    listRuns: (connectorId?: string, limit?: number) => {
      if (options.breakListRuns) return Promise.reject(new Error('the runs table is unreachable'));
      return Promise.resolve(
        runs
          .filter((run) => connectorId === undefined || run.connectorId === connectorId)
          .slice()
          // `ORDER BY started_at DESC`, the way the real store does it — and a
          // *stable* sort, so two rows carrying the same instant come back in
          // insertion order. That tie is not contrived: the column's stored
          // precision is seconds, so an attempt closed and an attempt opened in
          // the same second genuinely have nothing to order them by.
          .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
          .slice(0, limit ?? 50),
      );
    },
  };

  const publish = {
    appendRowsAsSystem: (
      _principalId: string,
      _typeName: string,
      _snapshotId: string,
      rows: Array<Record<string, unknown>>,
    ) => Promise.resolve({ written: rows.length }),
    carryForwardAsSystem: () => Promise.resolve({ carried: 0, total: 0, from: undefined }),
    commitAsSystem: (principalId: string, _typeName: string, snapshotId: string) => {
      committed.push(snapshotId);
      return Promise.resolve<SnapshotRef>({
        id: snapshotId,
        rowCount: 2,
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

  return { service, runs, stages, dropped, committed };
}

/** One inline run of the graph at the snapshot the orphan sits on. */
function runAt(service: WorkflowRunnerService, snapshotId = SNAPSHOT): Promise<ConnectorRun> {
  return service.runInline({
    workflow,
    connectorId: 'conn-1',
    principalId: 'ana',
    snapshotId,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

/* --------------------------------------------------------------------------
 * The run that vanished, on the graph path.
 * ------------------------------------------------------------------------ */

describe('a workflow run left open by an attempt that never came back', () => {
  it('is closed as failed by the attempt that follows it at the same snapshot', async () => {
    const { service, runs } = harness({ existingRuns: [orphan()] });

    await runAt(service);

    const closed = runs.find((run) => run.id === 'run-abandoned');
    expect(closed?.status).toBe('failed');
  });

  it('says what that state means, and where the other half of it is recorded', async () => {
    // The message is the whole feature. A row flipped to `failed` with no
    // explanation would be a second thing for somebody to work out.
    const { service, runs } = harness({ existingRuns: [orphan()] });

    await runAt(service);

    const closed = runs.find((run) => run.id === 'run-abandoned');
    expect(closed?.error).toContain('lease expired');
    expect(closed?.error).toContain('durable_step_checkpoints');
    expect(closed?.error).toContain(SNAPSHOT);
  });

  it('names the workflow, which is what this path calls the thing that ran', async () => {
    const { service, runs } = harness({ existingRuns: [orphan()] });

    await runAt(service);

    expect(runs.find((run) => run.id === 'run-abandoned')?.error).toContain('Nightly fleet');
  });

  it('keeps what the abandoned run had already logged', async () => {
    const { service, runs } = harness({ existingRuns: [orphan()] });

    await runAt(service);

    const closed = runs.find((run) => run.id === 'run-abandoned');
    expect(closed?.logs[0]).toBe('Fetched 0 records from inline.');
  });

  /**
   * The row was adopted before this change: `beginRun` found it and reported
   * into it, so the run that replaced an abandoned attempt looked exactly like a
   * run with nothing behind it. One row per attempt is what makes the closing
   * visible at all.
   */
  it('is a different row from the one the attempt that closed it reports into', async () => {
    const { service, runs } = harness({ existingRuns: [orphan()] });

    const run = await runAt(service);

    expect(run.id).not.toBe('run-abandoned');
    expect(runs.filter((candidate) => candidate.snapshotId === SNAPSHOT)).toHaveLength(2);
    expect(run.status).toBe('succeeded');
  });

  it('is named on the log of the run that closed it', async () => {
    // On the run rather than only on the row that was closed: the runs list is
    // where somebody scanning last night's loads is looking, and a closure
    // recorded only on the vanished row is one they have to already suspect.
    const { service } = harness({ existingRuns: [orphan()] });

    const run = await runAt(service);

    expect(run.logs.join('\n')).toContain('Closed run run-abandoned');
  });

  it('says it before the first node’s output, so a failed run reads in order', async () => {
    const { service } = harness({ existingRuns: [orphan()] });

    const run = await runAt(service);

    expect(run.logs[0]).toContain('Closed run run-abandoned');
  });
});

/* --------------------------------------------------------------------------
 * What it must not touch. The keying is the whole design.
 * ------------------------------------------------------------------------ */

describe('what the scan leaves alone', () => {
  it('leaves a run of the same connector at a different snapshot alone', async () => {
    // The reason this is keyed on the snapshot id rather than on age. A
    // concurrent run of the same connector — somebody pressing the button while
    // a schedule is mid-flight — has a different snapshot and is untouched. An
    // age threshold could not tell the two apart, because the loads this is
    // about are the slow ones.
    const { service, runs } = harness({
      existingRuns: [orphan({ id: 'run-elsewhere', snapshotId: 'wf-run-other' })],
    });

    await runAt(service);

    expect(runs.find((run) => run.id === 'run-elsewhere')?.status).toBe('running');
  });

  it('leaves an attempt that already finished exactly as it was', async () => {
    const { service, runs } = harness({
      existingRuns: [
        orphan({
          id: 'run-ok',
          status: 'succeeded',
          fetched: 40,
          written: 40,
          finishedAt: '2026-02-01T01:00:00.000Z',
        }),
      ],
    });

    await runAt(service);

    const done = runs.find((run) => run.id === 'run-ok');
    expect(done?.status).toBe('succeeded');
    expect(done?.error).toBeUndefined();
  });

  it('does not fail the load when the store cannot answer the scan', async () => {
    // Bookkeeping about a run that is already over must not take out the load in
    // front of it.
    const { service } = harness({ breakListRuns: true });

    const run = await runAt(service);

    expect(run.status).toBe('succeeded');
    expect(run.written).toBe(2);
  });
});

/* --------------------------------------------------------------------------
 * The durable entrance, which is the one the incident came in through.
 * ------------------------------------------------------------------------ */

describe('the planning step', () => {
  it('closes the earlier attempt and reports into its own row', async () => {
    const { service, runs } = harness({ existingRuns: [orphan()] });

    const plan = await service.plan({
      workflowId: 'wf-1',
      workflowVersion: 3,
      snapshotId: SNAPSHOT,
      connectorId: 'conn-1',
      principalId: 'ana',
      mode: 'durable',
    });

    expect(runs.find((run) => run.id === 'run-abandoned')?.status).toBe('failed');
    expect(plan.runRowId).not.toBe('run-abandoned');
  });

  /**
   * The note has to survive a replay, and the plan step's output is the only
   * thing on this path that does. A line pushed onto the run row here would be
   * overwritten by the finish step's `logs`, and one held in memory would not
   * outlive the process — which is the exact thing being recorded.
   */
  it('carries the closure through the checkpoint the body replays from', async () => {
    const { service } = harness({ existingRuns: [orphan()] });

    const plan = await service.plan({
      workflowId: 'wf-1',
      workflowVersion: 3,
      snapshotId: SNAPSHOT,
      connectorId: 'conn-1',
      principalId: 'ana',
      mode: 'durable',
    });

    expect(plan.notes?.join('\n')).toContain('Closed run run-abandoned');
  });

  it('has nothing to say about a snapshot nothing was left open at', async () => {
    const { service } = harness();

    const plan = await service.plan({
      workflowId: 'wf-1',
      workflowVersion: 3,
      snapshotId: SNAPSHOT,
      connectorId: 'conn-1',
      principalId: 'ana',
      mode: 'durable',
    });

    expect(plan.notes).toEqual([]);
  });
});

/* --------------------------------------------------------------------------
 * The row a poll answers with, once a snapshot can carry two.
 * ------------------------------------------------------------------------ */

describe('finding the run of a snapshot that has more than one', () => {
  it('answers with the attempt still being written, not the one that was closed', async () => {
    // `WorkflowLauncher.awaitRun` polls this and reports the first non-running
    // answer to whoever pressed Run. Answering with the abandoned attempt would
    // report its failure as the outcome of the run that had just replaced it.
    //
    // The orphan is given the same `startedAt` the new row will get, which is
    // the case the ordering cannot separate — see the fake's `listRuns`.
    const { service, runs } = harness({
      existingRuns: [orphan({ startedAt: '2026-02-01T02:00:00.000Z' })],
    });

    await service.plan({
      workflowId: 'wf-1',
      workflowVersion: 3,
      snapshotId: SNAPSHOT,
      connectorId: 'conn-1',
      principalId: 'ana',
      mode: 'durable',
    });
    const found = await service.findRun('conn-1', SNAPSHOT);

    expect(runs).toHaveLength(2);
    expect(found?.status).toBe('running');
    expect(found?.id).not.toBe('run-abandoned');
  });

  it('answers with the outcome recorded last once nothing is running', async () => {
    const { service } = harness({
      existingRuns: [
        orphan({ id: 'run-first', status: 'failed', finishedAt: '2026-02-01T01:00:00.000Z' }),
        orphan({ id: 'run-second', status: 'succeeded', finishedAt: '2026-02-01T04:00:00.000Z' }),
      ],
    });

    // Newest-first ordering puts `run-second` first anyway; the claim is that
    // the answer comes from when they finished rather than from list order, so
    // the fixture deliberately makes the *later* finish the *earlier* row.
    const found = await service.findRun('conn-1', SNAPSHOT);

    expect(found?.id).toBe('run-second');
  });
});

/* --------------------------------------------------------------------------
 * The stale-stage sweep, which is a different rule on the same list.
 * ------------------------------------------------------------------------ */

describe('the stale-stage sweep beside it', () => {
  /**
   * Two rules, one read, and genuinely different jobs — the sweep takes runs
   * that FAILED, at OTHER snapshots, longer ago than the retention window, and
   * drops staged rows; the scan takes runs still RUNNING, at THIS snapshot, at
   * any age, and writes an outcome. This is the clause that separates them, and
   * it is also why they compose: staged rows are only ever collected from a
   * failed run, so an abandoned `running` row kept its stages for good until
   * something closed it.
   */
  it('will not drop the stages of a run still marked running', async () => {
    const { service, stages } = harness({
      existingRuns: [
        orphan({
          id: 'run-stuck',
          snapshotId: 'wf-run-old',
          startedAt: '2020-01-01T00:00:00.000Z',
        }),
      ],
      stages: { 'wf-run-old': 2 },
    });

    await runAt(service);

    expect(stages.has('wf-run-old/staged/1')).toBe(true);
  });

  it('drops them once that run has been given an outcome and aged out', async () => {
    const { service, stages } = harness({
      existingRuns: [
        orphan({
          id: 'run-closed',
          snapshotId: 'wf-run-old',
          status: 'failed',
          finishedAt: '2020-01-01T00:00:00.000Z',
        }),
      ],
      stages: { 'wf-run-old': 2 },
    });

    await runAt(service);

    expect(stages.has('wf-run-old/staged/1')).toBe(false);
  });

  it('keeps the stages of a failure that is still inside the retention window', async () => {
    const { service, stages } = harness({
      existingRuns: [
        orphan({
          id: 'run-recent',
          snapshotId: 'wf-run-old',
          status: 'failed',
          finishedAt: new Date().toISOString(),
        }),
      ],
      stages: { 'wf-run-old': 2 },
    });

    await runAt(service);

    expect(stages.has('wf-run-old/staged/1')).toBe(true);
  });
});

/* --------------------------------------------------------------------------
 * The refs the graph itself moves, so the fixture is not lying about the run.
 * ------------------------------------------------------------------------ */

describe('the run that did the closing', () => {
  it('still loads and commits, which is what makes the rest of this file mean anything', async () => {
    const { service, committed } = harness({ existingRuns: [orphan()] });

    const run = await runAt(service);

    expect(committed).toEqual([SNAPSHOT]);
    expect(run.fetched).toBe(2);
    expect(run.written).toBe(2);
  });

  it('reaches its own staged rows, which the sweep beside the scan did not take', async () => {
    // The sweep runs before the first node and the source stages into the same
    // store: a sweep that took this run's own snapshot would leave the sink with
    // nothing to read and the run would refuse an empty commit rather than fail
    // visibly here. It committed two rows above, so it read the two it staged.
    const { service, dropped } = harness({ existingRuns: [orphan()] });

    await runAt(service);

    // The one drop is `finish`'s, after the commit — the stages are scratch
    // space and this is the only path that is allowed to collect them early.
    expect(dropped).toEqual([SNAPSHOT]);
  });
});
