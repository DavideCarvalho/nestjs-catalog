import type { ConnectorRun, SnapshotRef } from '@dudousxd/nestjs-catalog';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectorRunnerService } from './connector-runner.service';
import { SOURCES } from './sources';

/** See the note in `pipeline.module.integration.spec.ts`: the package cannot load here. */
vi.mock('@dudousxd/nestjs-durable', () => ({
  WorkflowEngine: class WorkflowEngine {},
  Step: () => (_target: unknown, _key: unknown, descriptor: unknown) => descriptor,
  Workflow: () => (target: unknown) => target,
}));

/**
 * The batch size the runner writes in.
 *
 * Restated rather than imported, and that is the point of it being here: it is
 * `private` to the runner, so a test that imported it would move whenever the
 * runner did and could never catch the runner changing it. Every assertion below
 * is written against this number as an independent claim about observed
 * behaviour.
 */
const BATCH = 500;

/** Enough rows to make "one batch" and "the whole thing" unmistakably different. */
const ROWS = 5_000;

const SPEC_KIND = 'spec-streaming';

/**
 * What the source and the writes did, in the order they did it.
 *
 * `yieldedAtWrite` is the whole test. It records, at the moment each batch write
 * *begins*, how many rows the source had handed over so far — so a runner that
 * buffers records `[5000, 5000, …]` and a runner that streams records
 * `[500, 1000, 1500, …]`. There is no way for a buffered read to produce the
 * second, which is what makes this a test of streaming rather than a test of the
 * row count coming out right.
 */
interface Observed {
  yieldedAtWrite: number[];
  batchSizes: number[];
  /** Whether the source had run to completion when the first batch was written. */
  drainedAtFirstWrite: boolean;
  transformCalls: number[];
}

interface Options {
  rows?: number;
  /** A connector that names a transform, which is what forbids streaming. */
  withTransform?: boolean;
  mode?: 'full' | 'incremental';
  /** Rows the source yields that are not objects, appended after the rest. */
  junk?: unknown[];
  /** State the source reports once its rows have run out. */
  finalState?: () => Record<string, unknown> | undefined;
  /** Runs the store already holds, so the abandoned-attempt scan has something to find. */
  existingRuns?: ConnectorRun[];
  /** A store that cannot answer the abandoned-attempt scan. */
  breakListRuns?: boolean;
}

function harness(options: Options = {}) {
  const rows = options.rows ?? ROWS;
  const observed: Observed = {
    yieldedAtWrite: [],
    batchSizes: [],
    drainedAtFirstWrite: false,
    transformCalls: [],
  };

  let yielded = 0;
  let drained = false;

  // A generator, so the rows genuinely do not exist until they are asked for.
  // An array with a counter around it would count the pulls and prove nothing
  // about what is in memory.
  async function* records(): AsyncGenerator<unknown> {
    for (let index = 0; index < rows; index += 1) {
      yielded += 1;
      yield { id: index, at: `2026-02-01T00:00:${String(index % 60).padStart(2, '0')}.000Z` };
    }
    for (const value of options.junk ?? []) {
      yielded += 1;
      yield value;
    }
    drained = true;
  }

  SOURCES[SPEC_KIND] = () =>
    Promise.resolve(
      options.finalState === undefined
        ? { records: records() }
        : { records: records(), state: options.finalState },
    );

  const connector: Record<string, unknown> = {
    id: 'c1',
    name: 'Nightly MVR',
    kind: SPEC_KIND,
    targetType: 'Mvr',
    config: {},
    state: {},
    mode: options.mode ?? 'full',
    enabled: true,
    createdBy: 'ana',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...(options.withTransform ? { transformId: 't1' } : {}),
  };

  const runs: ConnectorRun[] = [...(options.existingRuns ?? [])];
  const savedState: Array<Record<string, unknown>> = [];

  const store = {
    getConnector: () => Promise.resolve(connector),
    getTransform: () =>
      Promise.resolve({
        id: 't1',
        name: 'Normalise',
        language: 'javascript',
        version: 7,
        code: '',
        createdBy: 'ana',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    saveConnectorState: (_id: string, state: Record<string, unknown>) => {
      savedState.push(state);
      return Promise.resolve();
    },
    startRun: (input: { connectorId: string; snapshotId: string; principalId: string }) => {
      const run: ConnectorRun = {
        id: `run-${runs.length + 1}`,
        ...input,
        status: 'running',
        fetched: 0,
        written: 0,
        logs: [],
        startedAt: '2026-02-01T00:00:00.000Z',
      };
      runs.push(run);
      return Promise.resolve(run);
    },
    finishRun: (id: string, outcome: Partial<ConnectorRun>) => {
      const run = runs.find((candidate) => candidate.id === id);
      if (run) Object.assign(run, outcome);
      return Promise.resolve(run);
    },
    listRuns: (connectorId?: string, limit?: number) =>
      options.breakListRuns === true
        ? Promise.reject(new Error('the runs table is unreachable'))
        : Promise.resolve(
            runs
              .filter((run) => connectorId === undefined || run.connectorId === connectorId)
              .slice()
              .reverse()
              .slice(0, limit ?? 50),
          ),
  };

  const publish = {
    appendRowsAsSystem: (
      _principalId: string,
      _typeName: string,
      _snapshotId: string,
      batch: Array<Record<string, unknown>>,
    ) => {
      if (observed.yieldedAtWrite.length === 0) observed.drainedAtFirstWrite = drained;
      observed.yieldedAtWrite.push(yielded);
      observed.batchSizes.push(batch.length);
      return Promise.resolve({ written: batch.length });
    },
    carryForwardAsSystem: () => Promise.resolve({ carried: 0, total: rows, from: undefined }),
    commitAsSystem: (principalId: string, _typeName: string, snapshotId: string) =>
      Promise.resolve<SnapshotRef>({
        id: snapshotId,
        rowCount: rows,
        createdAt: '2026-02-01T00:00:00.000Z',
        principalId,
      }),
  };

  const transforms = {
    run: (_transform: unknown, given: unknown[]) => {
      observed.transformCalls.push(given.length);
      return Promise.resolve({ rows: given.filter(isObject), logs: [], elapsedMs: 3 });
    },
  };

  const service = new ConnectorRunnerService(
    Object.assign(Object.create(null), store),
    Object.assign(Object.create(null), transforms),
    Object.assign(Object.create(null), publish),
  );

  return { service, observed, runs, savedState, yielded: () => yielded };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The most rows the source had got ahead of the writes at any point.
 *
 * `yielded - written-so-far` at each write. It is the size of what the pipeline
 * was holding, which is the quantity the whole change is about, and it is
 * measured rather than asserted about indirectly.
 */
function maxOutstanding(observed: Observed): number {
  let written = 0;
  let worst = 0;
  observed.yieldedAtWrite.forEach((yielded, index) => {
    worst = Math.max(worst, yielded - written);
    written += observed.batchSizes[index] ?? 0;
  });
  return worst;
}

afterEach(() => {
  delete SOURCES[SPEC_KIND];
});

describe('a connector reading a source that streams', () => {
  it('writes its first batch before the source has finished reading', async () => {
    // The claim in one line. A buffered read cannot write anything until the
    // last row is in hand, so this is false for it and true for nothing else.
    const { service, observed } = harness();

    await service.run('c1', 'ana', 'snap-1');

    expect(observed.drainedAtFirstWrite).toBe(false);
    expect(observed.yieldedAtWrite[0]).toBe(BATCH);
  });

  it('never holds more than one batch, however many rows the source has', async () => {
    // The bound itself, measured at every write rather than inferred from the
    // first. A read that streamed for a while and then buffered the rest would
    // pass the test above and fail this one.
    const { service, observed } = harness();

    await service.run('c1', 'ana', 'snap-1');

    expect(maxOutstanding(observed)).toBeLessThanOrEqual(BATCH);
    expect(observed.yieldedAtWrite).toHaveLength(ROWS / BATCH);
  });

  it('writes the same batches a buffered read would have', async () => {
    // Bounding the memory is worth nothing if it changed what got written. Ten
    // full batches, and every row accounted for.
    const { service, observed } = harness();

    const run = await service.run('c1', 'ana', 'snap-1');

    expect(observed.batchSizes).toEqual(Array.from({ length: ROWS / BATCH }, () => BATCH));
    expect(run.fetched).toBe(ROWS);
    expect(run.written).toBe(ROWS);
    expect(run.status).toBe('succeeded');
  });

  it('counts what arrived and writes only what could be a row', async () => {
    // `fetched` has always been what the source handed over and `written` what
    // survived the filter, and the difference between them is how a load that
    // came out short gets noticed. Streaming applies the filter one record at a
    // time instead of once over an array; the two numbers must not move.
    const { service } = harness({ rows: 10, junk: ['a string', 42, ['an array'], null] });

    const run = await service.run('c1', 'ana', 'snap-1');

    expect(run.fetched).toBe(14);
    expect(run.written).toBe(10);
  });

  it('still writes one empty batch when a full load read nothing', async () => {
    // A batch is the only thing that creates the snapshot row, so a full load of
    // zero rows that wrote none would fail its own commit with "no snapshot has
    // been written". The array path had this; the streamed path has to have it
    // for the same reason.
    const { service, observed } = harness({ rows: 0 });

    await service.run('c1', 'ana', 'snap-1');

    expect(observed.batchSizes).toEqual([0]);
  });

  it('writes no batch at all for an incremental load that read nothing', async () => {
    // The carry-forward writes the snapshot on that path, and a batch here would
    // be a second write on a path that already has one.
    const { service, observed } = harness({ rows: 0, mode: 'incremental' });

    await service.run('c1', 'ana', 'snap-1');

    expect(observed.batchSizes).toEqual([]);
  });
});

describe('a connector that names a transform', () => {
  /*
   * The deliberate non-streaming path.
   *
   * `CatalogTransform.code` says the code is "the body of a function over one
   * batch ... a transform that needs to look up, deduplicate or aggregate cannot
   * do it one row at a time". Chunking the calls would silently redefine that
   * batch as five hundred rows, and an aggregating transform would then commit
   * wrong numbers without failing. These are the tests that keep somebody from
   * "fixing" the buffering later.
   */

  it('receives every record in a single call', async () => {
    const { service, observed } = harness({ withTransform: true });

    await service.run('c1', 'ana', 'snap-1');

    expect(observed.transformCalls).toEqual([ROWS]);
  });

  it('drains the whole source before it writes anything', async () => {
    // The cost of the decision, asserted rather than left implicit: this is the
    // one path where the read is not bounded, and it must be visible in a test
    // so that a change to it is a change to a test.
    const { service, observed } = harness({ withTransform: true });

    await service.run('c1', 'ana', 'snap-1');

    expect(observed.drainedAtFirstWrite).toBe(true);
    expect(observed.yieldedAtWrite[0]).toBe(ROWS);
  });

  it('says on the run why the read was held in memory', async () => {
    // An operator looking at a connector that exhausted the heap should be able
    // to read the reason off the run rather than deduce it from the fact that
    // the connector happens to have a transform attached.
    const { service } = harness({ withTransform: true });

    const run = await service.run('c1', 'ana', 'snap-1');

    expect(run.logs.join('\n')).toContain(`Held all ${ROWS} records in memory`);
    expect(run.logs.join('\n')).toContain('function over the whole batch');
  });

  it('says nothing of the kind when the source was an array anyway', async () => {
    // The line is about a read that could have been bounded and was not. An http
    // or inline source was never going to stream, so saying it there would be a
    // warning on every run of most connectors — which is how the ones that
    // matter become invisible.
    const { service } = harness({ withTransform: true });
    SOURCES[SPEC_KIND] = () => Promise.resolve([{ id: 1 }, { id: 2 }]);

    const run = await service.run('c1', 'ana', 'snap-1');

    expect(run.logs.join('\n')).not.toContain('records in memory');
    expect(run.fetched).toBe(2);
  });
});

describe('the watermark a streamed read reports', () => {
  it('is asked for only once every row has gone past, and is then saved', async () => {
    // A streamed watermark is a running maximum, so it is not final until the
    // last row. A `state` read before then would store a value naming a row in
    // the middle of the result set and skip everything after it forever.
    // The FIRST ask, and the number of asks. Recording the last one would let a
    // runner that peeked at the state before reading and then asked again
    // afterwards pass — which is exactly the mistake this is guarding, since the
    // damage is done by the early read and the later one looks correct.
    const asks: number[] = [];
    // A holder, because the counter the assertion reads belongs to the harness
    // and the harness needs the callback that reads it.
    const probe: { yielded?: () => number } = {};

    const built = harness({
      mode: 'incremental',
      rows: 1_000,
      finalState: () => {
        asks.push(probe.yielded?.() ?? -1);
        return { watermark: '2026-02-01T00:00:59.000Z' };
      },
    });
    probe.yielded = built.yielded;

    await built.service.run('c1', 'ana', 'snap-1');

    expect(asks).toEqual([1_000]);
    expect(built.savedState).toEqual([{ watermark: '2026-02-01T00:00:59.000Z' }]);
  });

  it('is not saved when the source reports nothing new', async () => {
    const { service, savedState } = harness({
      mode: 'incremental',
      rows: 10,
      finalState: () => undefined,
    });

    await service.run('c1', 'ana', 'snap-1');

    expect(savedState).toEqual([]);
  });
});

describe('a run left open by an attempt that never came back', () => {
  /*
   * The silence this change is also about.
   *
   * A step whose lease expires is re-dispatched while the attempt holding it is
   * still inside `run`, so that attempt never reaches `finishRun` and its row
   * sits at `running`, `fetched = 0`, error empty, for good. The only record of
   * what happened was `durable_step_checkpoints`.
   */

  function orphan(over: Partial<ConnectorRun> = {}): ConnectorRun {
    return {
      id: 'run-abandoned',
      connectorId: 'c1',
      snapshotId: 'snap-1',
      principalId: 'scheduler',
      status: 'running',
      fetched: 0,
      written: 0,
      logs: ['Fetched 0 records from spec-streaming.'],
      startedAt: '2026-02-01T00:00:00.000Z',
      ...over,
    };
  }

  it('is closed as failed by the attempt that follows it', async () => {
    const { service, runs } = harness({ rows: 10, existingRuns: [orphan()] });

    await service.run('c1', 'ana', 'snap-1');

    const closed = runs.find((run) => run.id === 'run-abandoned');
    expect(closed?.status).toBe('failed');
  });

  it('says what that state means, and where the other half of it is recorded', async () => {
    // The message is the whole feature. A row flipped to `failed` with no
    // explanation would be a second thing for somebody to work out.
    const { service, runs } = harness({ rows: 10, existingRuns: [orphan()] });

    await service.run('c1', 'ana', 'snap-1');

    const closed = runs.find((run) => run.id === 'run-abandoned');
    expect(closed?.error).toContain('lease expired');
    expect(closed?.error).toContain('durable_step_checkpoints');
    expect(closed?.error).toContain('snap-1');
  });

  it('keeps what the abandoned run had already logged', async () => {
    const { service, runs } = harness({ rows: 10, existingRuns: [orphan()] });

    await service.run('c1', 'ana', 'snap-1');

    const closed = runs.find((run) => run.id === 'run-abandoned');
    expect(closed?.logs[0]).toBe('Fetched 0 records from spec-streaming.');
  });

  it('is named on the run that closed it, so a durable step reports it too', async () => {
    // `ConnectorRunSteps` copies `run.logs` onto the step, so a line here is
    // also a line on the durable run an operator was already looking at. That is
    // the existing channel rather than a second one.
    const { service } = harness({ rows: 10, existingRuns: [orphan()] });

    const run = await service.run('c1', 'ana', 'snap-1');

    expect(run.logs.join('\n')).toContain('Closed run run-abandoned');
  });

  it('leaves a run of the same connector at a different snapshot alone', async () => {
    // The reason this is keyed on the snapshot id rather than on age. A
    // concurrent run of the same connector — somebody pressing the button while
    // a schedule is mid-flight — has a different snapshot and is untouched. An
    // age threshold could not tell the two apart, because the loads this is
    // about are the slow ones.
    const { service, runs } = harness({
      rows: 10,
      existingRuns: [orphan({ id: 'run-elsewhere', snapshotId: 'snap-other' })],
    });

    await service.run('c1', 'ana', 'snap-1');

    expect(runs.find((run) => run.id === 'run-elsewhere')?.status).toBe('running');
  });

  it('leaves an attempt that already finished exactly as it was', async () => {
    const { service, runs } = harness({
      rows: 10,
      existingRuns: [orphan({ id: 'run-ok', status: 'succeeded', fetched: 40, written: 40 })],
    });

    await service.run('c1', 'ana', 'snap-1');

    const done = runs.find((run) => run.id === 'run-ok');
    expect(done?.status).toBe('succeeded');
    expect(done?.error).toBeUndefined();
  });

  it('does not fail the load when the store cannot answer the scan', async () => {
    // Bookkeeping about a run that is already over must not take out the load in
    // front of it.
    const { service } = harness({ rows: 10, breakListRuns: true });

    const run = await service.run('c1', 'ana', 'snap-1');

    expect(run.status).toBe('succeeded');
    expect(run.written).toBe(10);
  });
});
