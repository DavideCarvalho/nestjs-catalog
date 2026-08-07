import type {
  CatalogTransform,
  CatalogWorkflow,
  ConnectorRun,
  SnapshotRef,
  WorkflowNode,
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
 * What a per-record transform node does to a graph, and what it must not change.
 *
 * ## The property under test
 *
 * `readInputs` materialises a node's whole input, and the batch path's own
 * comment says so. The claim here is that a `'record'` node never calls it: it
 * pulls one staged batch, feeds it through, writes what comes out, and asks for
 * the next. `readAtFirstWrite` is what proves it — a buffering node has read
 * every input batch before it writes anything, and a streaming one has read one.
 *
 * ## The property that must not change
 *
 * Everything else. The same rows, in the same order, in the same full batches,
 * with the same stale-tail sweep behind them. A node that halves the memory and
 * writes the rows in a different shape has moved the problem into the sink.
 */

const SNAPSHOT = 'wf-stream-1';
const BATCH = 500;
/** Enough staged batches that "read one" and "read all" cannot be confused. */
const ROWS = 3_000;

function transformRow(mode?: 'batch' | 'record'): CatalogTransform {
  return {
    id: 'tx-1',
    name: 'Rename',
    language: 'javascript',
    code: 'export default function transform({ record }) { return { id: record.id }; }',
    ...(mode === undefined ? {} : { mode }),
    version: 4,
    createdBy: 'ana',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function graph(): CatalogWorkflow {
  const nodes: WorkflowNode[] = [
    {
      id: 'src',
      kind: 'source',
      name: 'Rows',
      sourceKind: 'inline',
      config: { records: Array.from({ length: ROWS }, (_, id) => ({ id, junk: 'x' })) },
    },
    { id: 'shape', kind: 'transform', name: 'Rename', transformId: 'tx-1' },
    { id: 'load', kind: 'sink', name: 'Into Mvr', targetType: 'Mvr' },
  ];
  return {
    id: 'wf-stream',
    name: 'Nightly MVR',
    nodes,
    edges: [
      { from: 'src', to: 'shape' },
      { from: 'shape', to: 'load' },
    ],
    status: 'ready',
    enabled: true,
    version: 1,
    graphHash: 'abcdef0123456789',
    targetType: 'Mvr',
    createdBy: 'ana',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

interface Observed {
  /**
   * Stage reads that came back with rows, in order, as `nodeId/batch`.
   *
   * Empty ones are excluded deliberately: `clearStaleTail` probes past the end
   * of every node it writes, so the source's own sweep puts a `src/7` read on
   * the record before the transform node has done anything. Counting it would
   * make "how many input batches had been read" off by one for a reason that
   * has nothing to do with what is under test.
   */
  reads: string[];
  /** Stage writes by the transform node, in order, with their sizes. */
  writes: Array<{ batch: number; rows: number }>;
  /** How many stages had been read when the transform node made its first write. */
  readAtFirstWrite: number;
  /** How many records each call to the code was handed. */
  calls: number[];
}

function harness(mode?: 'batch' | 'record', canStream = true) {
  const workflow = graph();
  const stages = new Map<string, Array<Record<string, unknown>>>();
  const runs: ConnectorRun[] = [];
  const observed: Observed = { reads: [], writes: [], readAtFirstWrite: -1, calls: [] };

  const store = {
    listWorkflows: () => Promise.resolve([workflow]),
    getWorkflow: () => Promise.resolve(workflow),
    saveWorkflow: () => Promise.resolve(workflow),
    publishWorkflow: () => Promise.resolve(workflow),
    saveWorkflowSchedule: () => Promise.resolve(workflow),
    connectorsUsingWorkflow: () => Promise.resolve([]),
    getConnector: () => Promise.resolve(undefined),
    getConnection: () => Promise.resolve(undefined),
    saveConnectorState: () => Promise.resolve(),
    getTransform: () => Promise.resolve(transformRow(mode)),

    writeStage: (input: {
      runId: string;
      nodeId: string;
      batch: number;
      rows: Array<Record<string, unknown>>;
    }) => {
      if (input.nodeId === 'shape') {
        if (observed.writes.length === 0) {
          observed.readAtFirstWrite = observed.reads.filter((r) => r.startsWith('src/')).length;
        }
        observed.writes.push({ batch: input.batch, rows: input.rows.length });
      }
      stages.set(`${input.runId}/${input.nodeId}/${input.batch}`, input.rows);
      return Promise.resolve();
    },
    readStage: (input: { runId: string; nodeId: string; batch: number }) => {
      const rows = stages.get(`${input.runId}/${input.nodeId}/${input.batch}`) ?? [];
      if (rows.length > 0) observed.reads.push(`${input.nodeId}/${input.batch}`);
      return Promise.resolve(rows);
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

  let committed = 0;
  const publish = {
    appendRowsAsSystem: (
      _principalId: string,
      _typeName: string,
      _snapshotId: string,
      rows: Array<Record<string, unknown>>,
    ) => {
      committed += rows.length;
      return Promise.resolve({ written: rows.length });
    },
    carryForwardAsSystem: () => Promise.resolve({ carried: 0, total: 0, from: undefined }),
    commitAsSystem: (principalId: string, _typeName: string, snapshotId: string) =>
      Promise.resolve<SnapshotRef>({
        id: snapshotId,
        rowCount: committed,
        createdAt: '2026-02-01T03:00:00.000Z',
        principalId,
      }),
  };

  // The batch half of the runner, recording the one number that distinguishes
  // it: how many records reached the code in a single call.
  const run = (_transform: unknown, given: unknown[]) => {
    observed.calls.push(given.length);
    return Promise.resolve({
      rows: given.map((record) => ({ id: (record as { id: number }).id })),
      logs: ['batched'],
      elapsedMs: 1,
    });
  };

  // A lazy stand-in for the subprocess, for the reason the connector runner's
  // spec gives: one that collected `given` first would let a buffering runner
  // pass every assertion here.
  const runStream = (_transform: unknown, given: AsyncIterable<unknown>) => {
    let recordsIn = 0;
    let rowsOut = 0;
    async function* rows(): AsyncGenerator<Record<string, unknown>> {
      for await (const record of given) {
        recordsIn += 1;
        observed.calls.push(1);
        rowsOut += 1;
        yield { id: (record as { id: number }).id };
      }
    }
    return Promise.resolve({
      rows: rows(),
      summary: () => ({ recordsIn, rowsOut, logs: ['streamed'], elapsedMs: 1 }),
    });
  };

  const service = new WorkflowRunnerService(
    Object.assign(Object.create(null), store),
    Object.assign(Object.create(null), canStream ? { run, runStream } : { run }),
    Object.assign(Object.create(null), publish),
  );

  return { service, workflow, observed, stages };
}

async function runGraph(mode?: 'batch' | 'record', canStream = true) {
  const kit = harness(mode, canStream);
  const outcome = await kit.service.runInline({
    workflow: kit.workflow,
    connectorId: 'conn-1',
    principalId: 'ana',
    snapshotId: SNAPSHOT,
  });
  return { ...kit, outcome };
}

/** Everything the run wrote down, as one string to read assertions against. */
function transcript(run: ConnectorRun): string {
  return run.logs.join('\n');
}

describe('a per-record transform node', () => {
  it('writes its first batch after reading one input stage, not all of them', async () => {
    // The claim in one line. The batch path cannot produce this, because
    // `readInputs` has to finish before the transform is called at all.
    const { observed } = await runGraph('record');

    expect(observed.readAtFirstWrite).toBe(1);
  });

  it('calls the code once per record rather than once with everything', async () => {
    const streamed = await runGraph('record');
    const buffered = await runGraph('batch');

    expect(streamed.observed.calls).toHaveLength(ROWS);
    expect(new Set(streamed.observed.calls)).toEqual(new Set([1]));
    expect(buffered.observed.calls).toEqual([ROWS]);
  });

  it('stages the same rows, in the same full batches, as the batch path', async () => {
    // A faster node that changed the batch shape would move the problem into the
    // sink, which reads `1..batches` off the ref this node returns.
    const streamed = await runGraph('record');
    const buffered = await runGraph('batch');

    expect(streamed.observed.writes).toEqual(buffered.observed.writes);
    expect(streamed.observed.writes).toEqual(
      Array.from({ length: ROWS / BATCH }, (_, index) => ({ batch: index + 1, rows: BATCH })),
    );
    expect(streamed.stages.get(`${SNAPSHOT}/shape/1`)?.[0]).toEqual({ id: 0 });
    expect(streamed.stages.get(`${SNAPSHOT}/shape/6`)?.[499]).toEqual({ id: ROWS - 1 });
  });

  it('commits the same rows and succeeds, exactly as the batch path does', async () => {
    const streamed = await runGraph('record');
    const buffered = await runGraph('batch');

    expect(streamed.outcome.status).toBe('succeeded');
    expect(streamed.outcome.written).toBe(ROWS);
    expect(streamed.outcome.written).toBe(buffered.outcome.written);
  });

  it('records the transform version, exactly as the batch path does', async () => {
    // The version is what ties a surprising load to code, and a second execution
    // path is exactly where it gets dropped.
    const { outcome } = await runGraph('record');

    expect(transcript(outcome)).toContain('v4');
  });

  it('says on the run that it streamed, and carries what the code logged', async () => {
    const { outcome } = await runGraph('record');

    expect(transcript(outcome)).toContain('ran per record over a stream');
    expect(transcript(outcome)).toContain("Nothing held the node's whole input");
    expect(transcript(outcome)).toContain('streamed');
  });

  it('empties a longer previous attempt’s tail, as `stage` does', async () => {
    // The sweep `clearStaleTail` exists for. A retry that is shorter than the
    // attempt before it leaves batches under this node's name, and the next
    // thing to read a stage by iteration would silently include them.
    const kit = harness('record');
    kit.stages.set(`${SNAPSHOT}/shape/7`, [{ id: 'left over' }]);
    kit.stages.set(`${SNAPSHOT}/shape/8`, [{ id: 'left over' }]);

    await kit.service.runInline({
      workflow: kit.workflow,
      connectorId: 'conn-1',
      principalId: 'ana',
      snapshotId: SNAPSHOT,
    });

    expect(kit.stages.get(`${SNAPSHOT}/shape/7`)).toEqual([]);
    expect(kit.stages.get(`${SNAPSHOT}/shape/8`)).toEqual([]);
  });

  it('falls back to the buffered call when the bound runner cannot stream', async () => {
    // A deployment that swapped `TransformRunner` for a container still runs the
    // transform — under the per-record contract it declared, through whatever
    // that runner does with it — rather than failing on a method nobody promised.
    const { observed, outcome } = await runGraph('record', false);

    expect(observed.calls).toEqual([ROWS]);
    expect(outcome.written).toBe(ROWS);
  });
});
