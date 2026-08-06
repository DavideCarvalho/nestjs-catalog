import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import {
  CATALOG_EVENTS,
  type ConnectorRun,
  type WorkflowNodeOutcome,
  channelNameFor,
} from '@dudousxd/nestjs-catalog';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowRunnerService } from './workflow-runner.service';

/** See the note in `pipeline.module.integration.spec.ts`: the package cannot load here. */
vi.mock('@dudousxd/nestjs-durable', () => ({
  WorkflowEngine: class WorkflowEngine {},
  Step: () => (_target: unknown, _key: unknown, descriptor: unknown) => descriptor,
  Workflow: () => (target: unknown) => target,
}));

const SECRET_URL = 'https://svc:hunter2@vendor.example/v1/items?api_key=abc123';

/* --------------------------------------------------------------------------
 * The sinks, watched. Same recorder as the connector-runner file, and the same
 * argument for it: a spy on `emitCatalog` would pass on an event nothing
 * subscribes to, and this is about what reaches `GET catalog/events`.
 * ------------------------------------------------------------------------ */

class TestRecorder {
  readonly events: Array<{ event: string; payload: Record<string, unknown> }> = [];
  private readonly handlers = new Map<string, (message: unknown) => void>();

  constructor() {
    for (const event of CATALOG_EVENTS) {
      const channel = channelNameFor(event);
      const handler = (message: unknown): void => {
        const envelope = message && typeof message === 'object' ? message : {};
        const raw = Reflect.get(envelope, 'payload');
        const payload = raw && typeof raw === 'object' ? raw : {};
        this.events.push({ event, payload: { ...payload } });
      };
      subscribe(channel, handler);
      this.handlers.set(channel, handler);
    }
  }

  of(event: string): Array<Record<string, unknown>> {
    return this.events.filter((recorded) => recorded.event === event).map((r) => r.payload);
  }

  stop(): void {
    for (const [channel, handler] of this.handlers) unsubscribe(channel, handler);
    this.handlers.clear();
  }
}

/**
 * A store that can hold a graph and its rows, and remembers what it was asked to
 * finish a run with.
 *
 * `listWorkflows`/`getWorkflow`/`saveWorkflow` and `writeStage`/`readStage` are
 * present because `requireStore` narrows by asking for exactly those — a store
 * without them is refused before `finish` does anything, which would make this
 * a test of the capability check.
 */
function harness() {
  const finished: Array<Partial<ConnectorRun>> = [];

  const store = {
    listWorkflows: () => Promise.resolve([]),
    getWorkflow: () => Promise.resolve(undefined),
    saveWorkflow: () => Promise.resolve(undefined),
    // `supportsWorkflows` asks for this by name too: a store that can save a
    // graph but not publish one would narrow cleanly here and fail one call
    // later, mid-promotion. A stub that omits it is a stub that no longer
    // counts as a workflow store at all — which is how this spec started
    // failing when drafts landed, rather than through anything it tests.
    publishWorkflow: () => Promise.resolve(undefined),
    // Same reason as `publishWorkflow` above: `supportsWorkflows` asks for these
    // by name, so a double missing one reads as a store that cannot hold a
    // workflow at all.
    saveWorkflowSchedule: () => Promise.resolve(undefined),
    adoptConnector: () => Promise.resolve(undefined),
    writeStage: () => Promise.resolve(),
    readStage: () => Promise.resolve([]),
    dropStages: () => Promise.resolve(0),
    finishRun: (id: string, outcome: Partial<ConnectorRun>) => {
      finished.push(outcome);
      return Promise.resolve({
        id,
        connectorId: 'wf-1',
        snapshotId: 'snap-1',
        principalId: 'ana',
        status: 'failed',
        fetched: 0,
        written: 0,
        logs: [],
        startedAt: '2026-02-01T00:00:00.000Z',
        ...outcome,
      } as ConnectorRun);
    },
  };

  const service = new WorkflowRunnerService(
    Object.assign(Object.create(null), store),
    Object.assign(Object.create(null), { run: () => Promise.reject(new Error('unused')) }),
    Object.assign(Object.create(null), {}),
  );

  return { service, finished };
}

/** What `runInline` builds and hands to `finish` when a node throws. */
function failingRun(over: Record<string, unknown> = {}) {
  return {
    runRowId: 'run-1',
    snapshotId: 'snap-1',
    workflowId: 'wf-1',
    workflowName: 'Vendor items',
    connectorId: 'wf-1',
    principalId: 'ana',
    targetType: 'Mvr',
    status: 'failed' as const,
    fetched: 0,
    written: 0,
    logs: [`Read ${SECRET_URL}`],
    error: `Node "Vendor" (n1) failed: GET ${SECRET_URL} → 401`,
    nodeOutcomes: {
      n1: { status: 'failed', rows: 0, error: `GET ${SECRET_URL} → 401` },
      n2: { status: 'skipped', rows: 0 },
    } satisfies Record<string, WorkflowNodeOutcome>,
    ...over,
  };
}

let recorder: TestRecorder;

beforeEach(() => {
  recorder = new TestRecorder();
});

afterEach(() => {
  recorder.stop();
  vi.restoreAllMocks();
});

/* --------------------------------------------------------------------------
 * The claims.
 * ------------------------------------------------------------------------ */

describe('finishing a workflow run that failed against a credential-bearing URL', () => {
  // Three carriers, and each reaches `finish` by a different route: `runInline`
  // wraps the node's message into `error`, `record` folds a node's own logging
  // into `logs`, and `recordFailure` puts the raw message onto the outcome.
  // Redacting at any one of those would have left the other two.
  it('keeps the password out of every field the run row carries', async () => {
    const { service, finished } = harness();

    await service.finish(failingRun());

    const written = JSON.stringify(finished[0]);
    expect(written).not.toContain('hunter2');
    expect(written).not.toContain('abc123');
  });

  it('redacts the per-node outcome, which the run row carries beside the error', async () => {
    const { service, finished } = harness();

    await service.finish(failingRun());

    const outcomes = finished[0]?.nodeOutcomes ?? {};
    expect(outcomes.n1?.error).toContain('REDACTED');
    expect(outcomes.n1?.error).not.toContain('hunter2');
  });

  it('leaves the counters and the status of an outcome exactly alone', async () => {
    const { service, finished } = harness();

    await service.finish(failingRun());

    // There is no credential in a row count, and the status of a skipped node is
    // the first thing an operator reads off a failed graph.
    expect(finished[0]?.nodeOutcomes?.n2).toEqual({ status: 'skipped', rows: 0 });
    expect(finished[0]?.nodeOutcomes?.n1?.status).toBe('failed');
  });

  it('redacts the event payload, which is served at the same scope as the run', async () => {
    const { service } = harness();

    await service.finish(failingRun());

    const [event] = recorder.of('connector.run.finished');
    expect(String(event?.error)).not.toContain('hunter2');
    expect(String(event?.error)).toContain('vendor.example');
  });

  it('does not edit the input it was handed, which is a durable checkpoint', async () => {
    const { service } = harness();
    const input = failingRun();

    await service.finish(input);

    // On the durable path this object IS the finish step's checkpointed input.
    // Editing it in place would make the step's recorded input stop matching
    // what the engine delivered, and a replay would read back something the
    // engine never sent.
    expect(input.nodeOutcomes.n1.error).toContain('hunter2');
    expect(input.logs[0]).toContain('hunter2');
  });

  it('leaves the part of the URL that says which source refused', async () => {
    const { service, finished } = harness();

    await service.finish(failingRun());

    expect(finished[0]?.error).toContain('vendor.example');
    expect(finished[0]?.error).toContain('Vendor');
  });
});

describe('finishing a workflow run that succeeded', () => {
  it('redacts the logs on the path where nothing failed', async () => {
    const { service, finished } = harness();

    await service.finish(failingRun({ status: 'succeeded', error: undefined }));

    expect(JSON.stringify(finished[0]?.logs)).not.toContain('hunter2');
  });

  it('leaves a run with nothing to hide untouched', async () => {
    const { service, finished } = harness();

    await service.finish(
      failingRun({
        status: 'succeeded',
        error: undefined,
        logs: ['Committed snapshot snap-1: 1,200 rows, 1,200 of them from this run.'],
        nodeOutcomes: {},
      }),
    );

    expect(finished[0]?.logs).toEqual([
      'Committed snapshot snap-1: 1,200 rows, 1,200 of them from this run.',
    ]);
  });
});

describe('folding a node’s output into the run', () => {
  // `record` is where a node's logs enter the run, and on the durable path they
  // travel from here into the finish step's *input* checkpoint —
  // `durable_step_checkpoints`, a second copy of every log line, covered by
  // nothing at the HTTP boundary. Redacting only at `finish` would leave that
  // store holding what the run row refused.
  it('redacts before the lines can reach a durable checkpoint', () => {
    const { service } = harness();
    const progress = service.emptyProgress();

    service.record(
      progress,
      { id: 'n1', kind: 'source' },
      {
        nodeId: 'n1',
        rows: 3,
        elapsedMs: 4,
        logs: [`Read ${SECRET_URL}`],
      },
    );

    expect(progress.logs.join('\n')).not.toContain('hunter2');
    expect(progress.logs.join('\n')).toContain('vendor.example');
  });

  it('still bounds both axes of what it folds in', () => {
    const { service } = harness();
    const progress = service.emptyProgress();

    service.record(
      progress,
      { id: 'n1', kind: 'source' },
      {
        nodeId: 'n1',
        rows: 3,
        elapsedMs: 4,
        logs: [`Received: ${'row-1234567890,'.repeat(20_000)}`],
      },
    );

    expect(progress.logs[0]?.length).toBeLessThan(500);
  });
});
