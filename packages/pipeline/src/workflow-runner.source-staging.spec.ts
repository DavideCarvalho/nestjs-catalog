import type {
  CatalogConnector,
  CatalogWorkflow,
  ConnectorRun,
  WorkflowNodeStepInput,
  WorkflowSourceNode,
} from '@dudousxd/nestjs-catalog';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCES, type SourceFetcher } from './sources';
import { WorkflowRunnerService } from './workflow-runner.service';

/** See the note in `pipeline.module.integration.spec.ts`: the package cannot load here. */
vi.mock('@dudousxd/nestjs-durable', () => ({
  WorkflowEngine: class WorkflowEngine {},
  Step: () => (_target: unknown, _key: unknown, descriptor: unknown) => descriptor,
  Workflow: () => (target: unknown) => target,
}));

/**
 * A source node stages what it reads **as it reads it**, and everything that
 * had to survive that.
 *
 * ## The property under test
 *
 * `runSource` used to pull the whole fetch into an array and hand it to `stage`,
 * and the comment there argued the array bought nothing to remove. It did: the
 * fetchers have handed rows over incrementally since the file and S3 sources
 * began to stream, so the array was the only thing holding a load — inside a
 * durable step, on top of whatever the parse held. `producedAtFirstWrite` is
 * what proves the array is gone: a buffering source has produced every record
 * before it writes anything, and an incremental one has produced one batch.
 *
 * ## The properties that must not change
 *
 * The batch numbers, the stale-tail sweep, and above all *when the watermark
 * moves*. Those are asserted here rather than left to the memory claim, because
 * they are the three ways staging incrementally could be quietly wrong: a
 * running count instead of a position leaves a retry writing over the wrong
 * batches, a missing sweep leaves a longer earlier attempt readable, and a
 * watermark taken before the drain promises never to re-read rows that were
 * never committed.
 *
 * ## Why this swaps a fetcher out of `SOURCES`
 *
 * Because the question is about the *runner*, and answering it needs a source
 * whose production position the test can see. `sourceKind` is a closed union, so
 * a new name is not available; the swap is of `http` — restored in `afterEach` —
 * and the shape installed is a real {@link StreamedFetchResult}, which is what
 * the file and S3 fetchers hand back. The alternative was a temp CSV, which
 * streams for real and tells the test nothing about how far it had got when a
 * batch was written.
 */

const BATCH = 500;
const RUN = 'wf-src-1';

interface Spy {
  /** How many records the fetcher had yielded, at each `writeStage`, in order. */
  producedAtWrite: number[];
  /** Whether the runner asked for the watermark, which it may only do after the drain. */
  askedState: boolean;
  /** Whether the runner asked for the parse notes, same rule. */
  askedNotes: boolean;
  produced: number;
}

/**
 * A streaming fetcher that counts what it has handed over.
 *
 * `dieAfter` is how the partial-failure case is expressed: a read that fails on
 * record *n* of *m*, which is the shape of an S3 prefix dying on the fourth of
 * ten objects.
 */
function streamingFetcher(
  spy: Spy,
  options: { rows: number; dieAfter?: number; nonObjects?: boolean },
): SourceFetcher {
  return async () => ({
    records: (async function* () {
      for (let index = 0; index < options.rows; index += 1) {
        if (options.dieAfter !== undefined && index === options.dieAfter) {
          throw new Error('The source went away half way through.');
        }
        spy.produced += 1;
        // Interleaved rather than appended at the end, so the filter that drops
        // them cannot be satisfied by a batch boundary that happens to fall
        // between the rows and the junk.
        yield options.nonObjects && index % 100 === 7 ? `junk-${index}` : { id: index };
      }
    })(),
    state: () => {
      spy.askedState = true;
      return { watermark: `row-${options.rows}` };
    },
    notes: () => {
      spy.askedNotes = true;
      return [`Skipped 3 blank lines in "spy"; they are not in the record count.`];
    },
  });
}

function sourceNode(connectorId?: string): WorkflowSourceNode {
  return {
    id: 'src',
    kind: 'source',
    name: 'Fleet export',
    sourceKind: 'http',
    // `connectorId` lives in `config`, which is where `resolveSourceNode` looks
    // for it — and the connector is what a watermark belongs to, so a node
    // without one has nowhere to keep state at all.
    config: {
      url: 'https://example.invalid/fleet',
      ...(connectorId === undefined ? {} : { connectorId }),
    },
    ...(connectorId === undefined ? {} : { mode: 'incremental' }),
  };
}

function graph(connectorId?: string): CatalogWorkflow {
  return {
    id: 'wf-src',
    name: 'Nightly fleet',
    nodes: [
      sourceNode(connectorId),
      { id: 'load', kind: 'sink', name: 'Into Fleet', targetType: 'Fleet' },
    ],
    edges: [{ from: 'src', to: 'load' }],
    status: 'ready',
    enabled: true,
    version: 1,
    graphHash: 'abcdef0123456789',
    targetType: 'Fleet',
    createdBy: 'ana',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function owningConnector(state?: Record<string, unknown>): CatalogConnector {
  return {
    id: 'conn-1',
    name: 'Fleet drop',
    kind: 'http',
    targetType: 'Fleet',
    config: { url: 'https://example.invalid/fleet' },
    mode: 'incremental',
    enabled: true,
    ...(state === undefined ? {} : { state }),
    createdBy: 'ana',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function harness(spy: Spy, connector?: CatalogConnector) {
  const workflow = graph(connector?.id);
  const stages = new Map<string, Array<Record<string, unknown>>>();
  const saved: Array<Record<string, unknown>> = [];
  const runs: ConnectorRun[] = [];

  const store = {
    listWorkflows: () => Promise.resolve([workflow]),
    getWorkflow: () => Promise.resolve(workflow),
    saveWorkflow: () => Promise.resolve(workflow),
    publishWorkflow: () => Promise.resolve(workflow),
    saveWorkflowSchedule: () => Promise.resolve(workflow),
    adoptConnector: () => Promise.resolve(undefined),
    connectorsUsingWorkflow: () => Promise.resolve([]),
    getConnector: () => Promise.resolve(connector),
    getConnection: () => Promise.resolve(undefined),
    getTransform: () => Promise.resolve(undefined),
    saveConnectorState: (_id: string, state: Record<string, unknown>) => {
      saved.push(state);
      return Promise.resolve();
    },

    writeStage: (input: {
      runId: string;
      nodeId: string;
      batch: number;
      rows: Array<Record<string, unknown>>;
    }) => {
      spy.producedAtWrite.push(spy.produced);
      stages.set(`${input.runId}/${input.nodeId}/${input.batch}`, input.rows);
      return Promise.resolve({ written: input.rows.length });
    },
    readStage: (ref: { runId: string; nodeId: string; batch: number }) =>
      Promise.resolve(stages.get(`${ref.runId}/${ref.nodeId}/${ref.batch}`) ?? []),
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
    finishRun: () => Promise.resolve(undefined),
    listRuns: () => Promise.resolve([...runs]),
  };

  const service = new WorkflowRunnerService(
    Object.assign(Object.create(null), store),
    Object.assign(Object.create(null), {
      run: () => Promise.reject(new Error('No node in this file names a transform.')),
    }),
    Object.assign(Object.create(null), {
      appendRowsAsSystem: () => Promise.resolve({ written: 0 }),
      carryForwardAsSystem: () => Promise.resolve({ carried: 0, total: 0, from: undefined }),
      commitAsSystem: () => Promise.reject(new Error('No test here commits.')),
    }),
  );

  const step: WorkflowNodeStepInput = {
    workflowId: workflow.id,
    workflowVersion: 1,
    runId: RUN,
    nodeId: 'src',
    principalId: 'ana',
    inputs: [],
  };

  return { service, step, stages, saved };
}

function newSpy(): Spy {
  return { producedAtWrite: [], askedState: false, askedNotes: false, produced: 0 };
}

const original = SOURCES.http;

beforeEach(() => {
  SOURCES.http = original;
});
afterEach(() => {
  SOURCES.http = original;
});

describe('a source node over a streaming fetcher', () => {
  it('writes its first batch while the fetcher is still producing', async () => {
    const spy = newSpy();
    SOURCES.http = streamingFetcher(spy, { rows: 3_000 });
    const { service, step } = harness(spy);

    const out = await service.executeNode(step);

    // The whole claim, in one number. Buffered, the first write happens after
    // record 3,000; incremental, after record 500.
    expect(spy.producedAtWrite[0]).toBe(BATCH);
    // And it keeps up all the way down: batch n is written at record n * 500.
    expect(spy.producedAtWrite.slice(0, 6)).toEqual([500, 1000, 1500, 2000, 2500, 3000]);
    expect(out.output).toEqual({ runId: RUN, nodeId: 'src', batches: 6, rowCount: 3_000 });
  });

  it('numbers a batch by its position, so a retry writes over itself', async () => {
    const first = newSpy();
    SOURCES.http = streamingFetcher(first, { rows: 1_200 });
    const one = harness(first);
    const before = await one.service.executeNode(one.step);

    // The same node, the same run id, read again — which is what a durable step
    // retry is. A running count that skipped an empty batch, or a numbering that
    // started from where the last attempt stopped, would show up here.
    const second = newSpy();
    SOURCES.http = streamingFetcher(second, { rows: 1_200 });
    const two = harness(second);
    const after = await two.service.executeNode(two.step);

    expect(after.output).toEqual(before.output);
    expect([...two.stages.keys()]).toEqual([
      `${RUN}/src/1`,
      `${RUN}/src/2`,
      `${RUN}/src/3`,
      // `clearStaleTail` probes one past the end and finds nothing.
    ]);
    expect(two.stages.get(`${RUN}/src/1`)?.[0]).toEqual({ id: 0 });
    expect(two.stages.get(`${RUN}/src/2`)?.[0]).toEqual({ id: 500 });
    expect(two.stages.get(`${RUN}/src/3`)?.length).toBe(200);
  });

  it('keeps the batch boundaries the buffered path had when records are dropped', async () => {
    const spy = newSpy();
    // 1,200 records, of which 12 are strings: the surviving 1,188 rows fall into
    // batches of 500, 500, 188 — the boundaries of the *kept* rows, which is
    // what the buffered path produced by filtering before it sliced.
    SOURCES.http = streamingFetcher(spy, { rows: 1_200, nonObjects: true });
    const { service, step, stages } = harness(spy);

    const out = await service.executeNode(step);

    expect(out.output).toEqual({ runId: RUN, nodeId: 'src', batches: 3, rowCount: 1_188 });
    expect(stages.get(`${RUN}/src/1`)?.length).toBe(500);
    expect(stages.get(`${RUN}/src/2`)?.length).toBe(500);
    expect(stages.get(`${RUN}/src/3`)?.length).toBe(188);
    expect(out.logs).toContain(
      'Fetched 1200 records from http, 12 of which were not objects and were dropped.',
    );
  });

  it('empties what a longer earlier attempt left past its end', async () => {
    const long = newSpy();
    SOURCES.http = streamingFetcher(long, { rows: 3_000 });
    const first = harness(long);
    await first.service.executeNode(first.step);

    // The same run id and the same staged batches, read a second time and
    // shorter. Batches 3 to 6 belong to the attempt before and must not stay
    // readable under this node's name. The stage map is carried over rather than
    // the harness reused, because what makes this a second *attempt* is the
    // rows, not the service instance.
    const short = newSpy();
    SOURCES.http = streamingFetcher(short, { rows: 800 });
    const again = harness(short);
    for (const [key, rows] of first.stages) again.stages.set(key, rows);
    const out = await again.service.executeNode(again.step);

    expect(out.output).toEqual({ runId: RUN, nodeId: 'src', batches: 2, rowCount: 800 });
    expect(again.stages.get(`${RUN}/src/3`)).toEqual([]);
    expect(again.stages.get(`${RUN}/src/6`)).toEqual([]);
    expect(out.logs).toContain(
      'Cleared 4 stale staged batches left by an earlier, longer attempt at this node.',
    );
  });
});

describe('a streamed source that dies part way through', () => {
  it('advances no watermark, however many batches it had already staged', async () => {
    const spy = newSpy();
    // Seven full batches in, twenty short of the truth.
    SOURCES.http = streamingFetcher(spy, { rows: 10_000, dieAfter: 3_500 });
    const { service, step, stages, saved } = harness(spy, owningConnector());

    await expect(service.executeNode(step)).rejects.toThrow(
      'The source went away half way through',
    );

    // Seven batches are staged and unreadable — no ref covers them, the next
    // attempt overwrites them, and the sweep collects them a retention window
    // after the run is given up on.
    expect(stages.size).toBe(7);
    // The two that matter. Nothing was written as `pending`, so the sink has
    // nothing to promote and the next run reads the same rows again.
    expect(saved).toEqual([]);
    // And the watermark was never even *computed*, which is the stronger half:
    // a fetcher's `state()` is a claim about a read that finished.
    expect(spy.askedState).toBe(false);
    expect(spy.askedNotes).toBe(false);
  });

  it('writes the watermark as pending, and only after the last batch, when it does finish', async () => {
    const spy = newSpy();
    SOURCES.http = streamingFetcher(spy, { rows: 1_200 });
    const { service, step, saved } = harness(spy, owningConnector());

    const out = await service.executeNode(step);

    expect(spy.askedState).toBe(true);
    expect(saved).toEqual([{ src: { pending: { watermark: 'row-1200' } } }]);
    expect(out.logs).toContain(
      'Staged a new watermark for "Fleet export" (watermark); it is promoted only if this run commits.',
    );
  });
});

describe('what a streamed source says about itself', () => {
  it('reports the parse notes it could only know once the stream had drained', async () => {
    const spy = newSpy();
    SOURCES.http = streamingFetcher(spy, { rows: 600 });
    const { service, step } = harness(spy);

    const out = await service.executeNode(step);

    const count = out.logs.indexOf('Fetched 600 records from http.');
    const note = out.logs.findIndex((line) => line.startsWith('Skipped 3 blank lines'));
    expect(count).toBeGreaterThanOrEqual(0);
    // Immediately under the count they do not agree with, exactly as they were
    // when the count was known before the write rather than after it.
    expect(note).toBe(count + 1);
    expect(out.logs).toContain(
      '"Fleet export" staged its 2 batches as they arrived; nothing held the whole read.',
    );
  });

  it('claims no bound it does not have when the fetcher handed back an array', async () => {
    const spy = newSpy();
    SOURCES.http = async () => [{ id: 1 }, { id: 2 }];
    const { service, step } = harness(spy);

    const out = await service.executeNode(step);

    expect(out.output).toEqual({ runId: RUN, nodeId: 'src', batches: 1, rowCount: 2 });
    expect(out.logs.some((line) => line.includes('as they arrived'))).toBe(false);
  });

  it('stages nothing at all, and says so, when the stream is empty', async () => {
    const spy = newSpy();
    SOURCES.http = streamingFetcher(spy, { rows: 0 });
    const { service, step, stages } = harness(spy);

    const out = await service.executeNode(step);

    expect(out.output).toEqual({ runId: RUN, nodeId: 'src', batches: 0, rowCount: 0 });
    expect(stages.size).toBe(0);
    expect(out.logs).toContain('"Fleet export" read nothing this run.');
  });
});
