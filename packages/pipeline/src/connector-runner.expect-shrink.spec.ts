import type { ConnectorRun, SnapshotRef } from '@dudousxd/nestjs-catalog';
import { BadRequestException } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectorRunSteps } from './connector-run.steps';
import { ConnectorRunnerService } from './connector-runner.service';
import { EXPECT_SHRINK_LABEL } from './load-expectations';
import { passthroughScope } from './seams';
import { SOURCES } from './sources';

/** See the note in `pipeline.module.integration.spec.ts`: the package cannot load here. */
vi.mock('@dudousxd/nestjs-durable', () => ({
  WorkflowEngine: class WorkflowEngine {},
  Step: () => (_target: unknown, _key: unknown, descriptor: unknown) => descriptor,
  Workflow: () => (target: unknown) => target,
}));

/**
 * A deliberate truncation, in the words somebody would actually type.
 *
 * The literal is shared by every assertion below because half of what is being
 * tested is *where the sentence ends up* — on the snapshot, on the run row, and
 * nowhere that outlives either.
 */
const REASON = 'The 509th was cut back to one base for the migration.';

/**
 * A source that reports a watermark, registered for this file.
 *
 * The bundled `inline` fetcher returns bare records and therefore no state,
 * which would make the run never touch `saveConnectorState` — and one of the
 * claims here is precisely that the acknowledgement does not get written there.
 * A source that has nothing to persist cannot fail that test, so it would be a
 * test that passes for the wrong reason. Registered and removed rather than
 * faked around, because `SOURCES` is how the runner finds a fetcher at all.
 */
const SPEC_KIND = 'spec-watermark';

beforeAll(() => {
  SOURCES[SPEC_KIND] = ({ connector }) =>
    Promise.resolve({
      records: Array.isArray(connector.config.records) ? connector.config.records : [],
      state: { watermark: '2026-02-01T00:00:00.000Z' },
    });
});

afterAll(() => {
  delete SOURCES[SPEC_KIND];
});

/**
 * What the fake store is holding, reachable from the test after the run.
 *
 * Kept beside the store rather than inside it so the methods close over a
 * mutable handle: the service receives a flat copy of the store's methods (see
 * `runner`), and a test that swapped a field on the store afterwards would
 * otherwise be swapping it on an object nothing reads.
 */
interface StoreState {
  connector: Record<string, unknown>;
  runs: ConnectorRun[];
}

/**
 * A store holding its connector in memory and persisting what the runner saves.
 *
 * `saveConnectorState` really writes and `getConnector` really reads it back,
 * because "the acknowledgement does not carry into the next run" is a claim
 * about something only if the fake is capable of carrying it. A stub that
 * discarded the state would leave the second run clean no matter what the first
 * one wrote.
 */
function memoryStore(over: Record<string, unknown> = {}) {
  const state: StoreState = {
    connector: {
      id: 'c1',
      name: 'Nightly MVR',
      kind: SPEC_KIND,
      targetType: 'Mvr',
      config: { records: [{ id: 1 }, { id: 2 }] },
      state: {},
      mode: 'full',
      enabled: true,
      createdBy: 'someone',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...over,
    },
    runs: [],
  };

  const store = {
    getConnector: () => Promise.resolve(state.connector),
    saveConnectorState: (_id: string, saved: Record<string, unknown>) => {
      state.connector = { ...state.connector, state: saved };
      return Promise.resolve();
    },
    startRun: (input: { connectorId: string; snapshotId: string; principalId: string }) => {
      const run: ConnectorRun = {
        id: `run-${state.runs.length + 1}`,
        ...input,
        status: 'running',
        fetched: 0,
        written: 0,
        logs: [],
        startedAt: '2026-02-01T00:00:00.000Z',
      };
      state.runs.push(run);
      return Promise.resolve(run);
    },
    finishRun: (id: string, outcome: Partial<ConnectorRun>) => {
      const run = state.runs.find((candidate) => candidate.id === id);
      if (run) Object.assign(run, outcome);
      return Promise.resolve(run);
    },
    // Newest first, the way a real store orders it. Implemented rather than
    // omitted because the runner asks it on the way in — see
    // `closeAbandonedAttempts` — and a fake that threw would have that call
    // swallowed by its own guard, which is a test passing for want of a method.
    listRuns: (connectorId?: string, limit?: number) =>
      Promise.resolve(
        state.runs
          .filter((run) => connectorId === undefined || run.connectorId === connectorId)
          .slice()
          .reverse()
          .slice(0, limit ?? 50),
      ),
    getTransform: () => Promise.resolve(undefined),
  };

  return { state, store };
}

/** Every set of labels the run handed to the publish protocol, in order. */
interface Written {
  batches: Array<Record<string, string>>;
  merges: Array<Record<string, string>>;
}

function runner(pipeline: ReturnType<typeof memoryStore>) {
  const written: Written = { batches: [], merges: [] };
  const publish = {
    appendRowsAsSystem: (
      _principalId: string,
      _typeName: string,
      _snapshotId: string,
      rows: Array<Record<string, unknown>>,
      labels: Record<string, string>,
    ) => {
      written.batches.push(labels);
      return Promise.resolve({ written: rows.length });
    },
    carryForwardAsSystem: (
      _principalId: string,
      _typeName: string,
      _snapshotId: string,
      labels: Record<string, string>,
    ) => {
      written.merges.push(labels);
      return Promise.resolve({ carried: 3, total: 5, from: 'yesterday' });
    },
    commitAsSystem: (principalId: string, _typeName: string, snapshotId: string) =>
      Promise.resolve<SnapshotRef>({
        id: snapshotId,
        rowCount: 5,
        createdAt: '2026-02-01T00:00:00.000Z',
        principalId,
      }),
  };

  // The transform runner is reached only by a connector with a `transformId`,
  // and none here has one. It throws rather than answering, so a call this file
  // is not expecting fails instead of being quietly served.
  const transforms = {
    run: () => {
      throw new Error('No connector in this file names a transform.');
    },
  };

  const service = new ConnectorRunnerService(
    Object.assign(Object.create(null), pipeline.store),
    Object.assign(Object.create(null), transforms),
    Object.assign(Object.create(null), publish),
  );
  return { service, written };
}

describe('a connector run that acknowledges a deliberate shrink', () => {
  let store: ReturnType<typeof memoryStore>;

  beforeEach(() => {
    store = memoryStore();
  });

  it('carries the reason into the labels of the snapshot it writes', async () => {
    // The label is the whole mechanism: `refuseRowCountDrift` reads it off the
    // PENDING snapshot and stands the bound down for that snapshot alone.
    const { service, written } = runner(store);

    await service.run('c1', 'ana', 'snap-1', { expectShrink: REASON });

    expect(written.batches).toHaveLength(1);
    expect(written.batches[0]?.[EXPECT_SHRINK_LABEL]).toBe(REASON);
  });

  it('keeps the provenance labels it always wrote', async () => {
    const { service, written } = runner(store);

    await service.run('c1', 'ana', 'snap-1', { expectShrink: REASON });

    expect(written.batches[0]?.source).toBe('connector');
    expect(written.batches[0]?.connector).toBe('Nightly MVR');
  });

  it('puts it on the merge too, so an incremental run that fetched nothing still says it', async () => {
    // The case that decides whether this works at all. An incremental run whose
    // source returned no rows writes no batch — `appendRowsAsSystem` is never
    // reached — so the carry-forward is the only write that creates the
    // snapshot row, and an acknowledgement attached only to the batches would
    // be silently absent from exactly the load most likely to need it.
    store = memoryStore({ mode: 'incremental', config: { records: [] } });
    const { service, written } = runner(store);

    await service.run('c1', 'ana', 'snap-1', { expectShrink: REASON });

    expect(written.batches).toHaveLength(0);
    expect(written.merges[0]?.[EXPECT_SHRINK_LABEL]).toBe(REASON);
  });

  it('writes an empty batch when a FULL source returned nothing', async () => {
    // A batch is the only thing that creates the snapshot row, and a full run
    // has no carry-forward to create one instead. Without this the load left no
    // snapshot at all and the commit refused with "no snapshot has been
    // written" — an error naming the wrong event entirely, for a source that
    // answered perfectly and had nothing to say.
    //
    // The labels ride on it, which is the other half: they are how an
    // operator's acknowledgement reaches the snapshot, so the one case
    // `expectShrink` exists for was the one case it could not arrive.
    store = memoryStore({ mode: 'full', config: { records: [] } });
    const { service, written } = runner(store);

    await service.run('c1', 'ana', 'snap-1', { expectShrink: REASON });

    expect(written.batches).toHaveLength(1);
    expect(written.batches[0]?.[EXPECT_SHRINK_LABEL]).toBe(REASON);
  });

  it('does not add a batch to an incremental run that fetched nothing', async () => {
    // The asymmetry is deliberate rather than an oversight. An incremental run
    // that fetched nothing is already covered — the carry-forward writes the
    // snapshot and carries the same labels — so a batch here would be a second
    // write on a path that already has one, and a snapshot whose row count
    // arrived twice is a snapshot nobody can reason about.
    store = memoryStore({ mode: 'incremental', config: { records: [] } });
    const { service, written } = runner(store);

    await service.run('c1', 'ana', 'snap-1', { expectShrink: REASON });

    expect(written.batches).toHaveLength(0);
    expect(written.merges).toHaveLength(1);
  });

  it('says so on the run row, where somebody scanning last night reads it', async () => {
    const { service } = runner(store);

    const run = await service.run('c1', 'ana', 'snap-1', { expectShrink: REASON });

    expect(run.logs.join('\n')).toContain(REASON);
  });

  it('leaves an ordinary run unlabelled', async () => {
    const { service, written } = runner(store);

    await service.run('c1', 'ana', 'snap-1');

    expect(written.batches[0]).toEqual({ source: 'connector', connector: 'Nightly MVR' });
  });
});

describe('the acknowledgement is spent by the load it was given for', () => {
  // The failure mode this whole feature is one bad decision away from: a gate
  // that opens once and stays open. Every test here runs the SAME service
  // against the SAME stored connector twice, because that is the only shape in
  // which "permanent" is observable at all.

  it('does not carry into the next run of the same connector', async () => {
    const store = memoryStore();
    const { service, written } = runner(store);

    await service.run('c1', 'ana', 'snap-1', { expectShrink: REASON });
    await service.run('c1', 'ana', 'snap-2');

    expect(written.batches).toHaveLength(2);
    expect(written.batches[0]?.[EXPECT_SHRINK_LABEL]).toBe(REASON);
    expect(written.batches[1]?.[EXPECT_SHRINK_LABEL]).toBeUndefined();
  });

  it('does not carry into the next run of a second connector either', async () => {
    // The service is a singleton and every connector in the deployment runs
    // through this one instance. An acknowledgement remembered on `this` would
    // stand the bound down for a type nobody said anything about.
    const store = memoryStore();
    const { service, written } = runner(store);

    await service.run('c1', 'ana', 'snap-1', { expectShrink: REASON });
    store.state.connector = { ...store.state.connector, id: 'c2', name: 'Hourly MEL' };
    await service.run('c2', 'ana', 'snap-2');

    expect(written.batches[1]?.[EXPECT_SHRINK_LABEL]).toBeUndefined();
    expect(written.batches[1]?.connector).toBe('Hourly MEL');
  });

  it('is not written into the connector, which is where a run persists things', async () => {
    // `saveConnectorState` is the one place a run writes back to the connector
    // row, and the runner really reaches it here — the source reports a
    // watermark. A reason that landed in `state` would be read by every later
    // run of this connector and would have turned one acknowledgement into a
    // standing exemption.
    const store = memoryStore();
    const { service } = runner(store);

    await service.run('c1', 'ana', 'snap-1', { expectShrink: REASON });

    expect(store.state.connector.state).toEqual({ watermark: '2026-02-01T00:00:00.000Z' });
    expect(JSON.stringify(store.state.connector)).not.toContain(REASON);
  });
});

describe('an acknowledgement with nothing behind it', () => {
  it('is refused, rather than treated as an acknowledgement', async () => {
    const store = memoryStore();
    const { service } = runner(store);

    await expect(
      service.run('c1', 'ana', 'snap-1', { expectShrink: '   ' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('opens no run row, so nothing is left half-started', async () => {
    const store = memoryStore();
    const { service } = runner(store);

    await service.run('c1', 'ana', 'snap-1', { expectShrink: '' }).catch(() => undefined);

    expect(store.state.runs).toHaveLength(0);
  });

  it('names what is missing rather than the row count', async () => {
    const store = memoryStore();
    const { service } = runner(store);

    const error = await service
      .run('c1', 'ana', 'snap-1', { expectShrink: '' })
      .catch((thrown: unknown) => thrown);

    expect(error instanceof Error && error.message).toContain('reason');
    expect(error instanceof Error && error.message).toContain('Nightly MVR');
  });
});

describe('the scheduled path cannot acknowledge anything', () => {
  /**
   * The exclusion that keeps the bound meaningful.
   *
   * A run reaching this step came from a cron window and a synthetic
   * `scheduler` principal — nobody typed anything, and nobody is watching. An
   * acknowledgement supplied here would be given once and honoured on every
   * window after it, which is the bound switched off wearing a reason.
   */
  it('runs the connector with no options at all', async () => {
    const run = vi.fn(() =>
      Promise.resolve<Partial<ConnectorRun>>({
        id: 'r1',
        status: 'succeeded',
        logs: [],
        fetched: 1,
        written: 1,
      }),
    );
    const steps = new ConnectorRunSteps(
      Object.assign(Object.create(null), { run }),
      passthroughScope,
    );

    await steps.runConnector({ connectorId: 'c1', principalId: 'scheduler', snapshotId: 'snap-1' });

    // Exactly three arguments. `toHaveBeenCalledWith` fails on a fourth even
    // when it is `undefined`, which is the assertion wanted: the step passes no
    // options object for a later edit to start filling in.
    expect(run).toHaveBeenCalledWith('c1', 'scheduler', 'snap-1');
  });
});
