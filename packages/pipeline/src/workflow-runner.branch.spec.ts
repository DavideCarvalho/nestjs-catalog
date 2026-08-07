import type { CatalogWorkflow, ConnectorRun, SnapshotRef } from '@dudousxd/nestjs-catalog';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowRunnerService } from './workflow-runner.service';

/** See the note in `pipeline.module.integration.spec.ts`: the package cannot load here. */
vi.mock('@dudousxd/nestjs-durable', () => ({
  WorkflowEngine: class WorkflowEngine {},
  Step: () => (_target: unknown, _key: unknown, descriptor: unknown) => descriptor,
  Workflow: () => (target: unknown) => target,
}));

/**
 * A branch, run end to end, and the one outcome that would destroy data.
 *
 * WHAT THIS FILE IS FOR
 * ---------------------
 * **A sink on the branch that was not taken must not commit.** The snapshot
 * model repoints the live view of a type at whatever the run committed, so a
 * sink that ran with nothing in it and committed anyway would replace a good
 * dataset with an empty one — and the run would report success while doing it.
 * That is not a hypothetical shape: it is what "the else branch does not load
 * into ClickHouse" would mean if skipping were implemented as "run the sink with
 * no rows" rather than as "do not run the sink".
 *
 * So the central assertion is about `commitAsSystem` being **called for one type
 * and not the other**, watched at the publish seam rather than inferred from a
 * status. A run that reported everything correctly and still called commit would
 * pass a test written against `nodeOutcomes` alone.
 *
 * The graph is walked for real — `runInline` really visits every node, the taken
 * sink really commits through the publish stub, the run really finishes — for
 * the reason `workflow-runner.abandoned.spec.ts` gives about its own fixture: a
 * harness that stopped short could not tell "the branch skipped it" from "the
 * run never got that far".
 */

const SNAPSHOT = 'wf-run-branch-1';
const VARIABLE = 'CATALOG_TEST_CLICKHOUSE_URL';

/**
 * `src → gate`, then `--then--> warm → Clickhouse` and `--else--> Mysql`.
 *
 * Two sinks committing two different types, which is what makes the assertion
 * possible at all: with one sink there is nothing to compare "did not commit"
 * against, and a test that only checked the count of commits would pass for a
 * run that committed the wrong one.
 */
const workflow: CatalogWorkflow = {
  id: 'wf-1',
  name: 'Nightly fleet',
  nodes: [
    {
      id: 'src',
      kind: 'source',
      name: 'Fleet export',
      // A real fetcher over records the fixture holds, for the reason the
      // abandoned-runs fixture gives: a kind registered by the test is one more
      // thing that could be what the assertions are actually measuring.
      sourceKind: 'inline',
      config: { records: [{ id: 1 }, { id: 2 }] },
    },
    {
      id: 'gate',
      kind: 'if',
      name: 'Has ClickHouse',
      predicate: { kind: 'env', envVar: VARIABLE },
    },
    { id: 'warm', kind: 'sink', name: 'Into Clickhouse', targetType: 'Clickhouse' },
    { id: 'cold', kind: 'sink', name: 'Into Mysql', targetType: 'Mysql' },
  ],
  edges: [
    { from: 'src', to: 'gate' },
    { from: 'gate', to: 'warm', branch: 'then' },
    { from: 'gate', to: 'cold', branch: 'else' },
  ],
  status: 'ready',
  enabled: true,
  version: 3,
  graphHash: 'abcdef0123456789',
  targetType: 'Clickhouse',
  createdBy: 'ana',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

/**
 * A store and a publish seam that record rather than assert.
 *
 * `committed` is the load-bearing one: it is appended to by `commitAsSystem` and
 * by nothing else, so a type that appears in it is a type whose live view was
 * repointed. If the skip is deleted, no other line in this file can keep a type
 * out of that array.
 */
function harness() {
  const stages = new Map<string, Array<Record<string, unknown>>>();
  const runs: ConnectorRun[] = [];
  const committed: string[] = [];
  const appended: string[] = [];

  const store = {
    // `requireStore` narrows by asking for these by name; a store missing one is
    // refused before the run does anything.
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

  return { service, committed, appended };
}

/** One inline run with the variable set, or deliberately absent. */
async function runWith(value: string | undefined): Promise<{
  run: ConnectorRun;
  committed: string[];
  appended: string[];
}> {
  const { service, committed, appended } = harness();
  if (value === undefined) {
    delete process.env[VARIABLE];
  } else {
    process.env[VARIABLE] = value;
  }
  const run = await service.runInline({
    workflow,
    connectorId: 'conn-1',
    principalId: 'ana',
    snapshotId: SNAPSHOT,
  });
  return { run, committed, appended };
}

afterEach(() => {
  delete process.env[VARIABLE];
  vi.restoreAllMocks();
});

describe('a sink on the branch that was not taken', () => {
  it('does not commit, and the sink on the taken branch does', async () => {
    // THE ONE THAT MATTERS. `commitAsSystem` repoints the live view of a type;
    // a skipped sink reaching it would publish an empty snapshot over whatever
    // is serving, and the run would still report success.
    const { committed } = await runWith('http://clickhouse:8123');

    expect(committed).toEqual(['Clickhouse']);
  });

  it('writes no rows into the type it would have written', async () => {
    // Belt and braces at the other end of the publish seam: a sink that never
    // ran did not append either, so there is nothing half-written left behind
    // under this snapshot for a later commit to pick up.
    const { appended } = await runWith(undefined);

    expect(appended).toEqual(['Mysql']);
  });

  it('takes the other branch when the variable is not set', async () => {
    const { committed } = await runWith(undefined);

    expect(committed).toEqual(['Mysql']);
  });

  it('is a successful run, not a failed one', async () => {
    // A branch standing a sink down is the graph working as drawn. Reporting it
    // as failed would train everybody to ignore a red run on this pipeline,
    // which is worse than the thing being signalled.
    const { run } = await runWith('http://clickhouse:8123');

    expect(run.status).toBe('succeeded');
  });
});

describe('what the run records about the decision', () => {
  it('says which branch the gate took', async () => {
    const { run } = await runWith('http://clickhouse:8123');

    expect(run.nodeOutcomes?.gate).toMatchObject({ status: 'succeeded', branch: 'then' });
  });

  it('tells a branch skip apart from a run that stopped short', async () => {
    // The distinction the run panel is built on. `skipped` with this reason is a
    // node that correctly did nothing; `skipped` with no reason is a node that
    // was stranded by a failure. Rendering them the same would answer "why is
    // there no fresh data in Mysql" with the same shrug for both.
    const { run } = await runWith('http://clickhouse:8123');

    expect(run.nodeOutcomes?.cold).toEqual({
      status: 'skipped',
      rows: 0,
      skippedBecause: 'branch-not-taken',
    });
  });

  it('says in the run log that the skipped sink committed nothing and left the data alone', async () => {
    // A sink quietly missing from a load is the failure this whole feature has
    // to avoid, so the run says it out loud where somebody looking for "why did
    // nothing load into Mysql" will actually read it.
    const { run } = await runWith('http://clickhouse:8123');
    const said = run.logs.join('\n');

    expect(said).toContain('Into Mysql');
    expect(said).toContain('Nothing was committed for Mysql');
    expect(said).toContain('still live');
  });

  it('never writes the value of the variable into the run', async () => {
    // The predicate reads a variable that, in the motivating case, holds a
    // connection URL with a password in it. Only "set" or "not set" is recorded
    // — a run's logs and outcomes are served at the softest scope in the system.
    const secret = 'http://user:hunter2@clickhouse:8123';
    const { run } = await runWith(secret);

    expect(JSON.stringify({ logs: run.logs, outcomes: run.nodeOutcomes })).not.toContain('hunter2');
  });

  it('passes the rows through the gate rather than restaging them', async () => {
    // A gate that copied its input would pay for the whole dataset to make a
    // decision that reads none of it. It reports what came through and hands on
    // the ref it was given, so the sink behind it still sees two rows.
    const { run } = await runWith('http://clickhouse:8123');

    expect(run.nodeOutcomes?.gate?.rows).toBe(2);
    expect(run.nodeOutcomes?.warm).toMatchObject({ status: 'succeeded', rows: 2 });
  });
});
