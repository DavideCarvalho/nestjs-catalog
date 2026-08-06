import type {
  CatalogWorkflow,
  ConnectorRun,
  SnapshotRef,
  WorkflowFilterPredicate,
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
 * The filter node as it actually executes: batched, and loud about what it took.
 *
 * WHAT THIS FILE IS FOR
 * ---------------------
 * Two properties, and neither is about whether the predicate works — that is
 * `catalog.pipeline.filter.spec.ts`'s job, over a pure function.
 *
 * **It must never hold the dataset.** The obvious implementation of this node is
 * `readInputs()` then `.filter()`, and it is exactly the shape that spent a day
 * of this project's life stalling everything sharing a database: one synchronous
 * pass over millions of objects holds the event loop for its whole duration. So
 * the load-bearing case here is `writes survivors out before it has finished
 * reading its input`, which is a property no assertion about the *output* could
 * ever catch: both implementations produce the same rows, the same outcome and
 * the same log, and differ only in the order they touch the stage store.
 *
 * **Its effect must be reportable.** A filter that drops nine tenths of a load
 * and reports one number is indistinguishable from a source that read a tenth as
 * much. `rowsIn` beside `rows` is the whole reason this is a node rather than a
 * transform returning a subset, so it is asserted on the step output, on the
 * recorded outcome, and in the run log.
 */

const SNAPSHOT = 'wf-run-filter-1';

const OPEN: WorkflowFilterPredicate = {
  kind: 'compare',
  column: 'status',
  operator: 'equals',
  value: 'OPEN',
};

/**
 * `src → keep → Orders`, with the shrink acknowledged.
 *
 * Acknowledged because the graph would not otherwise validate — a filter that is
 * the only thing feeding a full sink has to name the type it narrows — and
 * because the acknowledgement is itself something the run has to say out loud.
 */
function workflowFiltering(
  records: Array<Record<string, unknown>>,
  predicate: WorkflowFilterPredicate = OPEN,
  narrows: string[] | undefined = ['Orders'],
): CatalogWorkflow {
  return {
    id: 'wf-filter',
    name: 'Open orders',
    nodes: [
      {
        id: 'src',
        kind: 'source',
        name: 'Orders export',
        sourceKind: 'inline',
        config: { records },
      },
      { id: 'keep', kind: 'filter', name: 'Only the open ones', predicate, narrows },
      { id: 'load', kind: 'sink', name: 'Into Orders', targetType: 'Orders' },
    ],
    edges: [
      { from: 'src', to: 'keep' },
      { from: 'keep', to: 'load' },
    ],
    status: 'ready',
    enabled: true,
    version: 3,
    graphHash: 'abcdef0123456789',
    targetType: 'Orders',
    createdBy: 'ana',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/**
 * A store that records every stage read and write.
 *
 * `reads` is the load-bearing one: it is how "read one batch at a time" is
 * asserted at all. An implementation that materialised every batch first would
 * produce identical rows, an identical outcome and an identical log, and would
 * differ only in the shape of this array.
 */
function harness(workflow: CatalogWorkflow) {
  const stages = new Map<string, Array<Record<string, unknown>>>();
  const runs: ConnectorRun[] = [];
  const committed: string[] = [];
  const reads: string[] = [];
  const writes: Array<{ key: string; rows: number }> = [];
  /**
   * Every stage read and write, in the order they happened.
   *
   * The counts alone cannot tell the two implementations apart — `readInputs()`
   * loops the batches too, so it also reads each one once. What differs is
   * *when*: a buffering filter does every read before any write, and a batched
   * one writes as it goes. Only an ordered log can see that.
   */
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
      reads.push(key);
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

  return { service, stages, committed, reads, writes, ops };
}

/** One inline run over a source that read `records`. */
async function runOver(
  records: Array<Record<string, unknown>>,
  predicate?: WorkflowFilterPredicate,
  narrows?: string[],
) {
  const workflow = workflowFiltering(records, predicate, narrows);
  const kit = harness(workflow);
  const run = await kit.service.runInline({
    workflow,
    connectorId: 'conn-1',
    principalId: 'ana',
    snapshotId: SNAPSHOT,
  });
  return { ...kit, run };
}

/** `count` rows, alternating between the two statuses, so exactly half survive. */
function orders(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => ({
    id: index,
    status: index % 2 === 0 ? 'OPEN' : 'CLOSED',
  }));
}

describe('what a filter passes on', () => {
  it('keeps the rows that match and drops the rest', async () => {
    const { run, stages } = await runOver([
      { id: 1, status: 'OPEN' },
      { id: 2, status: 'CLOSED' },
      { id: 3, status: 'OPEN' },
    ]);

    expect(run.status).toBe('succeeded');
    expect(stages.get(`${SNAPSHOT}/keep/1`)).toEqual([
      { id: 1, status: 'OPEN' },
      { id: 3, status: 'OPEN' },
    ]);
  });

  it('leaves the sink to refuse an empty full snapshot when nothing matched', async () => {
    // Not a failure of the filter: matching nothing is an ordinary outcome. What
    // must not happen is a commit, because committing an empty full snapshot
    // repoints the live view of Orders at no rows.
    const { run, committed } = await runOver([{ id: 1, status: 'CLOSED' }]);

    expect(committed).toEqual([]);
    expect(run.status).toBe('failed');
    expect(run.logs.join('\n')).toContain('passed nothing at all');
  });
});

describe('how it gets through the data', () => {
  it('writes survivors out before it has finished reading its input', async () => {
    // THE ONE THAT MATTERS, and the assertion has to be about *order* rather
    // than about counts: `readInputs()` loops the batches too, so a buffering
    // filter reads each one exactly once as well. What it cannot do is write
    // anything before the last read, because it has not looked at a row yet.
    //
    // 3,000 rows is six staged batches of 500, half of them open, so the carry
    // buffer fills after every second batch and a write lands between reads.
    const { ops } = await runOver(orders(3000));

    const firstWrite = ops.findIndex((op) => op.startsWith(`write ${SNAPSHOT}/keep/`));
    const lastRead = ops.reduce(
      (found, op, index) => (op.startsWith(`read ${SNAPSHOT}/src/`) ? index : found),
      -1,
    );

    expect(firstWrite).toBeGreaterThan(-1);
    expect(firstWrite).toBeLessThan(lastRead);
  });

  it('coalesces the survivors into full batches rather than one per input batch', async () => {
    // 1,200 in, half of them open, so 600 out: two batches of 500 and 100 rather
    // than three ragged ones. A filter keeping a small share would otherwise
    // write a stage row per input batch — fifteen thousand rows of five for a
    // seven-million-row table.
    const { writes } = await runOver(orders(1200));

    const written = writes.filter((write) => write.key.includes('/keep/'));
    expect(written.map((write) => write.rows)).toEqual([500, 100]);
  });

  it('empties a longer previous attempt’s tail rather than leaving it under this node', async () => {
    // The same sweep a source's staging does, reached through the same helper.
    // Orphaned batches are not a wrong answer today — a downstream node reads
    // `1..batches` off the ref — but they are rows sitting under this node's name
    // that the next thing to iterate a stage would silently include.
    const workflow = workflowFiltering(orders(4));
    const kit = harness(workflow);
    kit.stages.set(`${SNAPSHOT}/keep/2`, [{ id: 99, status: 'OPEN' }]);

    await kit.service.runInline({
      workflow,
      connectorId: 'conn-1',
      principalId: 'ana',
      snapshotId: SNAPSHOT,
    });

    expect(kit.stages.get(`${SNAPSHOT}/keep/2`)).toEqual([]);
  });
});

describe('what the run says the filter did', () => {
  it('reports rows in as well as rows out, on the step and on the outcome', async () => {
    // The whole reporting contract, and the second of the three reasons this is
    // a node at all. One number cannot distinguish a filter that dropped nine
    // tenths of a load from a source that read a tenth as much.
    const { run } = await runOver(orders(10));

    expect(run.nodeOutcomes?.keep).toMatchObject({ status: 'succeeded', rows: 5, rowsIn: 10 });
  });

  it('leaves rowsIn absent on every node that is not a filter', async () => {
    // Absent and zero are different facts: a panel that subtracts from a
    // defaulted zero would report every source in the run as having dropped
    // everything it produced.
    const { run } = await runOver(orders(10));

    expect(run.nodeOutcomes?.src?.rowsIn).toBeUndefined();
    expect(run.nodeOutcomes?.load?.rowsIn).toBeUndefined();
  });

  it('says what it was given, what it passed, and what it dropped', async () => {
    const { run } = await runOver(orders(10));
    const said = run.logs.join('\n');

    expect(said).toContain('was given 10 rows and passed 5');
    expect(said).toContain('5 did not match');
  });

  it('names the type whose snapshot it is acknowledged to narrow', async () => {
    // The acknowledgement is on the node and is therefore invisible on a run
    // unless the run repeats it. "Orders now holds only what this filter kept"
    // is the sentence somebody needs when they go looking for missing rows.
    const { run } = await runOver(orders(10));

    expect(run.logs.join('\n')).toContain('acknowledged to narrow Orders');
  });

  it('counts the rows it could not judge, by column, rather than dropping them silently', async () => {
    // The one way a filter is wrong without being broken: the predicate is fine
    // and the data is a different type from what it compares against, so every
    // one of those rows quietly failed. A count here turns "the load came out
    // short" into "the load came out short because qty is text".
    const numeric: WorkflowFilterPredicate = {
      kind: 'compare',
      column: 'qty',
      operator: 'greaterThan',
      value: 0,
    };
    const { run } = await runOver(
      [
        { id: 1, qty: 5 },
        { id: 2, qty: 'n/a' },
        { id: 3, qty: 'unknown' },
      ],
      numeric,
    );
    const said = run.logs.join('\n');

    expect(said).toContain('2 rows held a value in "qty"');
    expect(run.nodeOutcomes?.keep).toMatchObject({ rows: 1, rowsIn: 3 });
  });
});

describe('the node in isolation', () => {
  it('is a pure function of the stage refs it was handed, so a retry writes the same batches', async () => {
    // Batch numbers are a running count over `input.inputs`, which is
    // checkpointed — so a retried filter replaces its own batches rather than
    // shifting by one and leaving the previous attempt's tail in the data.
    const workflow = workflowFiltering([]);
    const kit = harness(workflow);
    kit.stages.set(`${SNAPSHOT}/src/1`, orders(4));

    const step = {
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      runId: SNAPSHOT,
      nodeId: 'keep',
      principalId: 'ana',
      inputs: [{ runId: SNAPSHOT, nodeId: 'src', batches: 1, rowCount: 4 }],
    };

    const first = await kit.service.executeNode(step);
    const second = await kit.service.executeNode(step);

    expect(first.output).toEqual({ runId: SNAPSHOT, nodeId: 'keep', batches: 1, rowCount: 2 });
    expect(second.output).toEqual(first.output);
    expect(second.rowsIn).toBe(4);
  });

  it('concatenates several inbound edges in edge order', async () => {
    // A filter stages its own rows rather than handing on the ref it was given,
    // which is what lets it take more than one input — unlike an `if`, which
    // carries one stream and refuses a second wire.
    const workflow = workflowFiltering([]);
    const kit = harness(workflow);
    kit.stages.set(`${SNAPSHOT}/left/1`, [{ id: 1, status: 'OPEN' }]);
    kit.stages.set(`${SNAPSHOT}/right/1`, [
      { id: 2, status: 'CLOSED' },
      { id: 3, status: 'OPEN' },
    ]);

    const output = await kit.service.executeNode({
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      runId: SNAPSHOT,
      nodeId: 'keep',
      principalId: 'ana',
      inputs: [
        { runId: SNAPSHOT, nodeId: 'left', batches: 1, rowCount: 1 },
        { runId: SNAPSHOT, nodeId: 'right', batches: 1, rowCount: 2 },
      ],
    });

    expect(output.rowsIn).toBe(3);
    expect(kit.stages.get(`${SNAPSHOT}/keep/1`)).toEqual([
      { id: 1, status: 'OPEN' },
      { id: 3, status: 'OPEN' },
    ]);
  });
});
