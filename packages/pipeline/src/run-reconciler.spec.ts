import type { CatalogConnector, ConnectorRun } from '@dudousxd/nestjs-catalog';
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeRunsTheEngineHasFinished, engineRunView } from './abandoned-runs';
import { AbandonedRunReconciler } from './run-reconciler.service';

/** See the note in `pipeline.module.integration.spec.ts`: the package cannot load here. */
vi.mock('@dudousxd/nestjs-durable', () => ({
  WorkflowEngine: class WorkflowEngine {},
  Step: () => (_target: unknown, _key: unknown, descriptor: unknown) => descriptor,
  Workflow: () => (target: unknown) => target,
}));

const SNAPSHOT = 'wf-run-9';

/**
 * The row the incident leaves behind, on the path the next-attempt rule cannot
 * reach: a durable run that died without ever reaching its finish step.
 *
 * `executionMode: 'durable'` is not decoration here — it is the allow-list this
 * whole rule turns on, so every fixture that wants to be reconciled has to carry
 * it and the ones below that leave it off are testing exactly that.
 */
function openRun(over: Partial<ConnectorRun> = {}): ConnectorRun {
  return {
    id: 'run-open',
    connectorId: 'conn-1',
    snapshotId: SNAPSHOT,
    principalId: 'scheduler',
    status: 'running',
    fetched: 0,
    written: 0,
    logs: ['Fetched 0 records from sql.'],
    startedAt: '2026-02-01T00:00:00.000Z',
    executionMode: 'durable',
    ...over,
  };
}

interface Options {
  runs?: ConnectorRun[];
  /**
   * The engine's answer per durable run id. A key that is absent is `null` —
   * "the engine has no record of this" — which is the real engine's answer for a
   * run it has never held or has since pruned.
   */
  engineRuns?: Record<string, { status: string }>;
  /** An engine whose store cannot be reached at all. */
  engineThrows?: boolean;
  /** Rows to swap in between the two reads of the run list. See the race test. */
  afterFirstRead?: (runs: ConnectorRun[]) => void;
  connectors?: CatalogConnector[];
}

/**
 * A store that really holds runs, and an engine that really answers.
 *
 * **Nothing in here closes a run**, and nothing in here decides whether the
 * engine was asked. `finishRun` writes exactly the outcome it is handed onto
 * exactly the row named; `asked` records every id the engine was given. That
 * pair is what makes the claims below claims about the rule: delete the engine
 * call and the "gone" test still has to fail, because the store will not close
 * anything on its own.
 */
function harness(options: Options = {}) {
  const runs: ConnectorRun[] = (options.runs ?? []).map((run) => ({ ...run }));
  const asked: string[] = [];
  const warnings: string[] = [];
  const logs: string[] = [];
  let reads = 0;

  const store = {
    listConnectors: () => Promise.resolve(options.connectors ?? []),
    listRuns: (connectorId?: string, limit?: number) => {
      reads += 1;
      const answer = runs
        .filter((run) => connectorId === undefined || run.connectorId === connectorId)
        .map((run) => ({ ...run }))
        .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
        .slice(0, limit ?? 50);
      // The hook fires strictly BETWEEN the two reads, so the second one sees a
      // world the first did not. That is the finishing race, reproduced rather
      // than described.
      if (reads === 1) options.afterFirstRead?.(runs);
      return Promise.resolve(answer);
    },
    finishRun: (id: string, outcome: Partial<ConnectorRun>) => {
      const run = runs.find((candidate) => candidate.id === id);
      if (run) Object.assign(run, outcome, { finishedAt: '2026-02-01T05:00:00.000Z' });
      return Promise.resolve(run);
    },
  };

  const engine = {
    getRun: (runId: string) => {
      asked.push(runId);
      if (options.engineThrows) return Promise.reject(new Error('durable store unreachable'));
      return Promise.resolve(options.engineRuns?.[runId] ?? null);
    },
  };

  const logger = {
    warn: (message: string) => warnings.push(message),
    log: (message: string) => logs.push(message),
  };

  return { store, engine, runs, asked, warnings, logs, logger, reads: () => reads };
}

/**
 * The rule, run over the harness, with the store narrowed the way Nest does.
 *
 * `names` is handed over as the thunk the interface now takes, and {@link asked}
 * counts the calls: the whole reason it became a function is that a pass which
 * closes nothing must not pay for it, and a spec that resolved the map itself
 * would not be able to see the difference.
 */
function reconcile(kit: ReturnType<typeof harness>, names?: ReadonlyMap<string, string>) {
  return closeRunsTheEngineHasFinished(
    Object.assign(Object.create(null), kit.store),
    kit.engine,
    kit.logger,
    names ? { names: () => Promise.resolve(names) } : {},
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/* --------------------------------------------------------------------------
 * The row nothing else revisits — the whole point of asking the engine.
 * ------------------------------------------------------------------------ */

describe('a durable run that died before reaching its finish step', () => {
  it('is closed as failed when the engine has no record of the run', async () => {
    const kit = harness({ runs: [openRun()] });

    const outcome = await reconcile(kit);

    // Both halves, and the second is the one that makes the first mean
    // something: the engine WAS asked, by the snapshot id, and the row was
    // closed on the strength of what it said.
    expect(kit.asked).toEqual([SNAPSHOT]);
    expect(kit.runs[0].status).toBe('failed');
    expect(outcome).toMatchObject({ examined: 1, closed: 1, alive: 0, unanswerable: 0 });
  });

  it('is closed when the engine reports the run in any terminal state', async () => {
    for (const status of ['completed', 'failed', 'cancelled', 'dead']) {
      const kit = harness({ runs: [openRun()], engineRuns: { [SNAPSHOT]: { status } } });

      await reconcile(kit);

      expect(kit.runs[0].status, `engine said ${status}`).toBe('failed');
      expect(kit.runs[0].error, `engine said ${status}`).toContain(`reached "${status}"`);
    }
  });

  it('says which run the engine was asked about, and where the rest of it is', async () => {
    const kit = harness({
      runs: [openRun()],
      engineRuns: { [SNAPSHOT]: { status: 'cancelled' } },
    });

    await reconcile(kit, new Map([['conn-1', 'Nightly fleet']]));

    const error = kit.runs[0].error ?? '';
    expect(error).toContain('Nightly fleet');
    expect(error).toContain(SNAPSHOT);
    expect(error).toContain('durable_step_checkpoints');
  });

  it('says something different when the engine has never heard of the run', async () => {
    // The two answers send a reader to different places: a terminal run has a
    // row and a step history to read; a pruned or unknown one has nothing.
    const kit = harness({ runs: [openRun()] });

    await reconcile(kit);

    expect(kit.runs[0].error).toContain('no record of durable run');
    expect(kit.runs[0].error).toContain('pruned');
  });

  it('keeps what the run had already logged, and adds the reason to it', async () => {
    const kit = harness({ runs: [openRun()] });

    await reconcile(kit);

    expect(kit.runs[0].logs[0]).toBe('Fetched 0 records from sql.');
    expect(kit.runs[0].logs.at(-1)).toContain('still marked running');
  });

  it('names the connector when it was given a name, and the id when it was not', async () => {
    const named = harness({ runs: [openRun()] });
    await reconcile(named, new Map([['conn-1', 'Nightly fleet']]));
    expect(named.runs[0].error).toContain('"Nightly fleet"');

    const unnamed = harness({ runs: [openRun()] });
    await reconcile(unnamed);
    expect(unnamed.runs[0].error).toContain('"conn-1"');
  });

  /**
   * The reason `names` is a function rather than a map.
   *
   * This library mounts inside somebody else's application and this pass runs
   * every five minutes whether or not anybody is using it. Reading the connector
   * table to decorate a warning is defensible; reading it on the pass that has
   * no warning to write — which is every pass on a deployment where nothing is
   * wrong — is a tax on an idle host, and it was being paid twelve times an hour
   * forever.
   */
  it('does not read the connector names on a pass that closes nothing', async () => {
    // A run the engine says is alive: examined, and left exactly as it was.
    const kit = harness({
      runs: [openRun()],
      engineRuns: { [SNAPSHOT]: { status: 'running' } },
    });
    let asked = 0;

    const outcome = await closeRunsTheEngineHasFinished(
      Object.assign(Object.create(null), kit.store),
      kit.engine,
      kit.logger,
      {
        names: () => {
          asked += 1;
          return Promise.resolve(new Map());
        },
      },
    );

    expect(outcome).toMatchObject({ closed: 0, alive: 1 });
    expect(asked).toBe(0);
  });

  it('reads them once, however many rows one pass closes', async () => {
    const kit = harness({
      runs: [openRun({ id: 'run-a', snapshotId: 'wf-a' }), openRun({ id: 'run-b' })],
    });
    let asked = 0;

    await closeRunsTheEngineHasFinished(
      Object.assign(Object.create(null), kit.store),
      kit.engine,
      kit.logger,
      {
        names: () => {
          asked += 1;
          return Promise.resolve(new Map([['conn-1', 'Nightly fleet']]));
        },
      },
    );

    expect(kit.runs.map((run) => run.status)).toEqual(['failed', 'failed']);
    expect(asked).toBe(1);
  });
});

/* --------------------------------------------------------------------------
 * The answer that must never be got wrong.
 * ------------------------------------------------------------------------ */

describe('a run the engine says is still going', () => {
  it('is left exactly as it was, on every non-terminal status the engine has', async () => {
    // `blocked` and `cancelling` are the interesting two: both were added to the
    // engine's status union after the first of these rules was written, and both
    // are non-terminal. A rule that enumerated "dead" statuses by hand rather
    // than asking what is terminal would have closed a live run on either.
    for (const status of ['pending', 'running', 'suspended', 'cancelling', 'blocked']) {
      const kit = harness({ runs: [openRun()], engineRuns: { [SNAPSHOT]: { status } } });

      const outcome = await reconcile(kit);

      expect(kit.asked, `engine said ${status}`).toEqual([SNAPSHOT]);
      expect(kit.runs[0].status, `engine said ${status}`).toBe('running');
      expect(kit.runs[0].error, `engine said ${status}`).toBeUndefined();
      expect(outcome, `engine said ${status}`).toMatchObject({ closed: 0, alive: 1 });
    }
  });

  it('is left alone on a status this build has never heard of', async () => {
    // A status the engine gains later is not terminal until it says so, and the
    // safe direction for an unrecognised one is "alive": leaving a dead row open
    // is the status quo, closing a live one forges an outcome.
    const kit = harness({
      runs: [openRun()],
      engineRuns: { [SNAPSHOT]: { status: 'hibernating' } },
    });

    await reconcile(kit);

    expect(kit.runs[0].status).toBe('running');
  });

  /**
   * The mutation this file exists to kill. If the engine call were deleted and
   * the rule closed everything it found at `running`, every test above would
   * still pass — a row would be closed, the message would still be written, the
   * counters would still add up. This is the one that goes red.
   */
  it('survives a pass in which another run of the same connector is closed', async () => {
    const kit = harness({
      runs: [
        openRun({ id: 'run-live', snapshotId: 'wf-live' }),
        openRun({ id: 'run-dead', snapshotId: 'wf-dead' }),
      ],
      engineRuns: { 'wf-live': { status: 'running' } },
    });

    const outcome = await reconcile(kit);

    expect(kit.runs.find((run) => run.id === 'run-live')?.status).toBe('running');
    expect(kit.runs.find((run) => run.id === 'run-dead')?.status).toBe('failed');
    expect(outcome).toMatchObject({ examined: 2, closed: 1, alive: 1 });
  });
});

/* --------------------------------------------------------------------------
 * When the engine cannot be asked. A guess here forges a governance record.
 * ------------------------------------------------------------------------ */

describe('an engine that cannot answer', () => {
  it('leaves the row running and says which run it could not ask about', async () => {
    const kit = harness({ runs: [openRun()], engineThrows: true });

    const outcome = await reconcile(kit);

    expect(kit.runs[0].status).toBe('running');
    expect(outcome).toMatchObject({ closed: 0, unanswerable: 1 });
    expect(kit.warnings.join('\n')).toContain(SNAPSHOT);
    expect(kit.warnings.join('\n')).toContain('durable store unreachable');
  });

  it('is not read as "gone" — a throw and a null are opposite facts', async () => {
    // The conflation worth guarding: both are "the engine did not hand back a
    // run", and a store that timed out is the case where the load is MOST
    // likely still executing.
    const thrown = harness({ runs: [openRun()], engineThrows: true });
    await reconcile(thrown);

    const missing = harness({ runs: [openRun()] });
    await reconcile(missing);

    expect(thrown.runs[0].status).toBe('running');
    expect(missing.runs[0].status).toBe('failed');
  });

  it('does not let one unanswerable run stop the others being reconciled', async () => {
    let calls = 0;
    const kit = harness({
      runs: [
        openRun({ id: 'run-a', snapshotId: 'wf-a' }),
        openRun({ id: 'run-b', snapshotId: 'wf-b' }),
      ],
    });
    kit.engine.getRun = (runId: string) => {
      kit.asked.push(runId);
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('one timed out')) : Promise.resolve(null);
    };

    const outcome = await reconcile(kit);

    expect(outcome).toMatchObject({ examined: 2, closed: 1, unanswerable: 1 });
  });

  it('does not throw when the run list itself cannot be read', async () => {
    const kit = harness();
    kit.store.listRuns = () => Promise.reject(new Error('the runs table is unreachable'));

    const outcome = await reconcile(kit);

    expect(outcome).toMatchObject({ examined: 0, closed: 0 });
    expect(kit.warnings.join('\n')).toContain('the runs table is unreachable');
  });
});

/* --------------------------------------------------------------------------
 * The allow-list. Asking the engine about a row it never owned is the same
 * mistake as not asking it at all.
 * ------------------------------------------------------------------------ */

describe('the rows it will not have an opinion about', () => {
  it('never asks the engine about an inline run, and never closes one', async () => {
    // An inline run has no durable run at all, so `getRun` would answer "gone"
    // for a load that is running perfectly. Not asking is the fix; not closing
    // is only the symptom of it.
    const kit = harness({ runs: [openRun({ executionMode: 'inline' })] });

    const outcome = await reconcile(kit);

    expect(kit.asked).toEqual([]);
    expect(kit.runs[0].status).toBe('running');
    expect(outcome.examined).toBe(0);
  });

  it('never asks about a row that does not say how it executed', async () => {
    // `ConnectorRunnerService` opens its rows without the field. Absence is not
    // evidence of durability, and guessing it from a missing column is exactly
    // the inference this rule refuses to make.
    const kit = harness({ runs: [openRun({ executionMode: undefined })] });

    await reconcile(kit);

    expect(kit.asked).toEqual([]);
    expect(kit.runs[0].status).toBe('running');
  });

  it('never asks about a run that already recorded an outcome', async () => {
    const kit = harness({
      runs: [
        openRun({ id: 'run-done', status: 'succeeded', fetched: 40, written: 40 }),
        openRun({ id: 'run-bad', status: 'failed', error: 'the source refused' }),
      ],
    });

    await reconcile(kit);

    expect(kit.asked).toEqual([]);
    expect(kit.runs.find((run) => run.id === 'run-done')?.status).toBe('succeeded');
    expect(kit.runs.find((run) => run.id === 'run-bad')?.error).toBe('the source refused');
  });
});

/* --------------------------------------------------------------------------
 * The race the second read exists for.
 * ------------------------------------------------------------------------ */

describe('a run that finishes while the engine is being asked', () => {
  it('keeps its own outcome rather than being overwritten', async () => {
    // The engine reports terminal — truthfully; the finish step ran — and the
    // finish step's write lands before this one would. Its outcome is worth more
    // than this rule's: it is the one that knows what the load did.
    const kit = harness({
      runs: [openRun()],
      engineRuns: { [SNAPSHOT]: { status: 'completed' } },
      afterFirstRead: (runs) => {
        Object.assign(runs[0], {
          status: 'succeeded',
          fetched: 981_000,
          written: 981_000,
          finishedAt: '2026-02-01T02:00:00.000Z',
        });
      },
    });

    const outcome = await reconcile(kit);

    expect(kit.runs[0].status).toBe('succeeded');
    expect(kit.runs[0].error).toBeUndefined();
    expect(outcome).toMatchObject({ examined: 1, closed: 0 });
  });

  it('reads the run list a second time only when it has something to close', async () => {
    const nothing = harness({
      runs: [openRun()],
      engineRuns: { [SNAPSHOT]: { status: 'running' } },
    });
    await reconcile(nothing);
    expect(nothing.reads()).toBe(1);

    const something = harness({ runs: [openRun()] });
    await reconcile(something);
    expect(something.reads()).toBe(2);
  });
});

/* --------------------------------------------------------------------------
 * Whether the engine can be asked at all.
 * ------------------------------------------------------------------------ */

describe('deciding whether there is an engine to ask', () => {
  it('answers no for nothing at all', () => {
    expect(engineRunView(undefined)).toBeUndefined();
    expect(engineRunView(null)).toBeUndefined();
  });

  it('answers no for the start-only facade a thin worker is given', () => {
    // `DurableStartClient` is bound under the `WorkflowEngine` token on a tenant
    // worker and has `start` and nothing that reads a run. A declared dependency
    // on the class would compile and be `undefined` at the call.
    class DurableStartClient {
      start(): Promise<void> {
        return Promise.resolve();
      }
    }

    expect(engineRunView(new DurableStartClient())).toBeUndefined();
  });

  it('answers yes for an engine that can read a run, and keeps it bound to itself', async () => {
    // Bound, because `getRun` is a method reading `this.store` — a bare function
    // reference would throw on `this` at the first call.
    class Engine {
      private readonly answer = { status: 'running' };
      getRun(_runId: string): Promise<{ status: string } | null> {
        return Promise.resolve(this.answer);
      }
    }
    const view = engineRunView(new Engine());

    expect(view).toBeDefined();
    await expect(view?.getRun('wf-1')).resolves.toEqual({ status: 'running' });
  });
});

/* --------------------------------------------------------------------------
 * The trigger, which is the part that decides whether any of this ever runs.
 * ------------------------------------------------------------------------ */

describe('the process that runs the passes', () => {
  function reconciler(kit: ReturnType<typeof harness>, engine: object | undefined, enabled = true) {
    return new AbandonedRunReconciler(
      Object.assign(Object.create(null), kit.store),
      // Handed in as the plain object it is. The service declares this parameter
      // `object` rather than `WorkflowEngine` precisely so that the facade case
      // below is expressible without pretending it is an engine.
      engine,
      enabled,
    );
  }

  it('closes a lost row on the pass it runs at boot', async () => {
    vi.useFakeTimers();
    const kit = harness({
      runs: [openRun()],
      connectors: [connector('conn-1', 'Nightly fleet')],
    });
    const service = reconciler(kit, kit.engine);

    service.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    service.onApplicationShutdown();

    expect(kit.asked).toEqual([SNAPSHOT]);
    expect(kit.runs[0].status).toBe('failed');
    expect(kit.runs[0].error).toContain('Nightly fleet');
  });

  it('keeps running passes on a timer, because the run dies mid-afternoon', async () => {
    // A boot-only pass would leave a row abandoned at 14:00 marked running until
    // the pod is next restarted, which is the same silence on a longer clock.
    vi.useFakeTimers();
    const kit = harness({ runs: [] });
    const service = reconciler(kit, kit.engine);

    service.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    kit.runs.push(openRun());
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    service.onApplicationShutdown();

    expect(kit.runs[0].status).toBe('failed');
  });

  it('stops when the process does', async () => {
    vi.useFakeTimers();
    const kit = harness({ runs: [] });
    const service = reconciler(kit, kit.engine);

    service.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    service.onApplicationShutdown();
    kit.runs.push(openRun());
    await vi.advanceTimersByTimeAsync(60 * 60_000);

    expect(kit.runs[0].status).toBe('running');
  });

  it('does nothing at all on a process that was told not to', async () => {
    vi.useFakeTimers();
    const kit = harness({ runs: [openRun()] });
    const service = reconciler(kit, kit.engine, false);

    service.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    service.onApplicationShutdown();

    expect(kit.asked).toEqual([]);
    expect(kit.runs[0].status).toBe('running');
  });

  it('writes nothing when no engine resolved, and does not treat that as a fault', async () => {
    vi.useFakeTimers();
    const kit = harness({ runs: [openRun()] });
    const service = reconciler(kit, undefined);
    const said = record();

    service.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    service.onApplicationShutdown();

    expect(kit.runs[0].status).toBe('running');
    expect(said.warn).toEqual([]);
    expect(said.log.join('\n')).toContain('No durable engine resolved here');
  });

  it('warns, and writes nothing, when the engine bound here cannot read a run', async () => {
    // The thin-worker facade. Durable runs exist on this deployment; this pod
    // simply cannot see any of them — which is a warning rather than a shrug,
    // because the rows will accumulate and somebody has to move this pass.
    vi.useFakeTimers();
    class DurableStartClient {
      start(): Promise<void> {
        return Promise.resolve();
      }
    }
    const kit = harness({ runs: [openRun()] });
    const service = reconciler(kit, new DurableStartClient());
    const said = record();

    service.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    service.onApplicationShutdown();

    expect(kit.runs[0].status).toBe('running');
    expect(said.warn.join('\n')).toContain('DurableStartClient');
    expect(said.warn.join('\n')).toContain('start-only facade');
  });

  it('falls back to the connector id when the names cannot be read', async () => {
    const kit = harness({ runs: [openRun()] });
    kit.store.listConnectors = () => Promise.reject(new Error('connectors unreadable'));
    const service = reconciler(kit, kit.engine);

    await service.pass();

    expect(kit.runs[0].status).toBe('failed');
    expect(kit.runs[0].error).toContain('"conn-1"');
  });

  it('says nothing on a pass that found nothing wrong', async () => {
    // A line every five minutes reporting health is how the line reporting a
    // failure stops being read.
    const kit = harness({ runs: [openRun({ status: 'succeeded' })] });
    const service = reconciler(kit, kit.engine);
    const said = record();

    await service.pass();

    expect(said.log).toEqual([]);
    expect(said.warn).toEqual([]);
  });
});

function connector(id: string, name: string): CatalogConnector {
  return {
    id,
    name,
    kind: 'sql',
    targetType: 'Mvr',
    config: {},
    mode: 'full',
    enabled: true,
    createdBy: 'ana',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/**
 * Capture what the service said, without reading a log.
 *
 * Through `Logger.prototype`, because the service builds its own logger the way
 * every other class in this package does — and a constructor parameter added so
 * a test could pass one in would be a seam that exists for the test rather than
 * for a host.
 */
function record(): { warn: string[]; log: string[] } {
  const said = { warn: [] as string[], log: [] as string[] };
  vi.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
    said.warn.push(String(message));
  });
  vi.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
    said.log.push(String(message));
  });
  return said;
}
