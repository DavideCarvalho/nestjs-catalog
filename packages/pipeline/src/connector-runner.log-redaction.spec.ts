import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { CATALOG_EVENTS, type ConnectorRun, type SnapshotRef } from '@dudousxd/nestjs-catalog';
import { channelNameFor } from '@dudousxd/nestjs-catalog';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectorRunnerService } from './connector-runner.service';
import { SOURCES } from './sources';

/** See the note in `pipeline.module.integration.spec.ts`: the package cannot load here. */
vi.mock('@dudousxd/nestjs-durable', () => ({
  WorkflowEngine: class WorkflowEngine {},
  Step: () => (_target: unknown, _key: unknown, descriptor: unknown) => descriptor,
  Workflow: () => (target: unknown) => target,
}));

/**
 * The failure `fetchHttp` actually throws, with a real credential in it.
 *
 * Written out here rather than constructed, because the point of this file is
 * what happens to this *exact* string once it leaves the fetcher — `GET ${url} →
 * ${status}` is the template, and the URL in it is whatever the connector was
 * pointed at.
 */
const SECRET_URL = 'https://svc:hunter2@vendor.example/v1/items?api_key=abc123';
const FETCH_FAILURE = `GET ${SECRET_URL} → 401`;

/**
 * Two kinds registered for this file: one that fails the way a source fails, and
 * one that succeeds while logging a URL.
 *
 * Registered rather than faked around, because `SOURCES` is how the runner finds
 * a fetcher at all — and the second kind matters as much as the first. The leak
 * is usually described as an error-message problem, and a run that succeeds can
 * put a URL into `logs` just as readily.
 */
const FAILING_KIND = 'spec-failing-http';
const NOISY_KIND = 'spec-noisy';

beforeAll(() => {
  SOURCES[FAILING_KIND] = () => Promise.reject(new Error(FETCH_FAILURE));
  SOURCES[NOISY_KIND] = () => Promise.resolve([{ id: 1 }]);
});

afterAll(() => {
  delete SOURCES[FAILING_KIND];
  delete SOURCES[NOISY_KIND];
});

/* --------------------------------------------------------------------------
 * The two sinks, watched.
 * ------------------------------------------------------------------------ */

interface Recorded {
  event: string;
  payload: Record<string, unknown>;
}

/**
 * The shipped recorder's contract: subscribe to every name in `CATALOG_EVENTS`,
 * keep the payload.
 *
 * Through a subscriber rather than a spy on `emitCatalog`, for the reason
 * `catalog.reset-audit.spec.ts` gives: a spy would pass on an event nothing
 * subscribes to. What reaches here is what reaches `GET catalog/events`, which
 * is the sink this file is about.
 */
class TestRecorder {
  readonly events: Recorded[] = [];
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

/** The run rows as the store holds them — which is what `GET pipeline/runs` serves. */
function harness(over: Record<string, unknown> = {}) {
  const runs: ConnectorRun[] = [];
  const connector = {
    id: 'c1',
    name: 'Vendor items',
    kind: FAILING_KIND,
    targetType: 'Mvr',
    config: {},
    state: {},
    mode: 'full',
    enabled: true,
    createdBy: 'ana',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };

  const store = {
    getConnector: () => Promise.resolve(connector),
    getTransform: () =>
      Promise.resolve({
        id: 't1',
        name: 'Normalise',
        language: 'javascript',
        version: 3,
        code: '',
        createdBy: 'ana',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    saveConnectorState: () => Promise.resolve(),
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
  };

  const publish = {
    appendRowsAsSystem: (
      _principalId: string,
      _typeName: string,
      _snapshotId: string,
      rows: Array<Record<string, unknown>>,
    ) => Promise.resolve({ written: rows.length }),
    carryForwardAsSystem: () => Promise.resolve({ carried: 0, total: 1, from: undefined }),
    commitAsSystem: (principalId: string, _typeName: string, snapshotId: string) =>
      Promise.resolve<SnapshotRef>({
        id: snapshotId,
        rowCount: 1,
        createdAt: '2026-02-01T00:00:00.000Z',
        principalId,
      }),
  };

  const transformLogs: string[] = [];
  const transforms = {
    run: () => Promise.resolve({ rows: [{ id: 1 }], elapsedMs: 4, logs: [...transformLogs] }),
  };

  const service = new ConnectorRunnerService(
    Object.assign(Object.create(null), store),
    Object.assign(Object.create(null), transforms),
    Object.assign(Object.create(null), publish),
  );

  return { service, runs, transformLogs };
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

describe('a connector run that fails against a credential-bearing URL', () => {
  it('does not put the password into the run row a catalog:read may fetch', async () => {
    const { service, runs } = harness();

    await service.run('c1', 'ana', 'snap-1');

    // Asserted on what reached the STORE, not on what the fetcher threw. The
    // leak is at the sink: `GET pipeline/runs` returns `logs` and `error`
    // verbatim, at the softest scope in the system.
    const written = JSON.stringify(runs[0]);
    expect(written).not.toContain('hunter2');
    expect(written).not.toContain('abc123');
  });

  it('leaves the part of the URL that says which source refused', async () => {
    const { service, runs } = harness();

    await service.run('c1', 'ana', 'snap-1');

    // A redaction that removed the whole URL would be a deletion, and the run
    // list would stop being able to answer "which source?" — which is the first
    // thing anybody reading a failed run wants.
    expect(runs[0]?.error).toContain('vendor.example');
    expect(runs[0]?.error).toContain('svc:');
    expect(runs[0]?.error).toContain('401');
  });

  it('redacts the same message on the event payload, which is served at the same scope', async () => {
    const { service } = harness();

    await service.run('c1', 'ana', 'snap-1');

    const [finished] = recorder.of('connector.run.finished');
    expect(finished?.status).toBe('failed');
    expect(String(finished?.error)).not.toContain('hunter2');
    expect(String(finished?.error)).not.toContain('abc123');
    expect(String(finished?.error)).toContain('REDACTED');
  });

  it('redacts the copy that went into logs as well as the one in error', async () => {
    const { service, runs } = harness();

    await service.run('c1', 'ana', 'snap-1');

    // Two carriers, one message. Redacting `error` and forgetting the `Failed:`
    // line pushed into `logs` would leave the leak intact in the field a console
    // actually renders.
    const failed = runs[0]?.logs?.find((line) => line.startsWith('Failed:'));
    expect(failed).toBeDefined();
    expect(failed).not.toContain('hunter2');
  });
});

describe('a connector run that succeeds', () => {
  it('redacts a URL a transform logged, on the path where nothing failed', async () => {
    const { service, runs, transformLogs } = harness({
      kind: NOISY_KIND,
      transformId: 't1',
    });
    transformLogs.push(`Read ${SECRET_URL}`);

    const run = await service.run('c1', 'ana', 'snap-1');

    expect(run.status).toBe('succeeded');
    expect(JSON.stringify(runs[0])).not.toContain('hunter2');
    expect(JSON.stringify(runs[0])).not.toContain('abc123');
  });

  it('leaves a log line with nothing to hide exactly as it was', async () => {
    const { service, runs } = harness({ kind: NOISY_KIND });

    await service.run('c1', 'ana', 'snap-1');

    expect(runs[0]?.logs).toContain(`Fetched 1 records from ${NOISY_KIND}.`);
  });
});

describe('a transform that logs enormous lines', () => {
  // The second half of the report. The connector path capped its transform logs
  // on the line axis only — `.slice(0, 50)` — so one line naming every record a
  // transform received wrote megabytes into a run row, and it grew with the
  // data. `workflow-runner.service.ts` had capped both axes since it was
  // measured there; this path was simply missed.
  it('bounds each line, not only the number of them', async () => {
    const { service, runs, transformLogs } = harness({
      kind: NOISY_KIND,
      transformId: 't1',
    });
    transformLogs.push(`Received: ${'row-1234567890,'.repeat(20_000)}`);

    await service.run('c1', 'ana', 'snap-1');

    const written = runs[0]?.logs ?? [];
    expect(written.every((line) => line.length < 500)).toBe(true);
    expect(written.some((line) => line.includes('more characters'))).toBe(true);
  });

  it('still drops the lines past the count it always dropped them at', async () => {
    const { service, runs, transformLogs } = harness({
      kind: NOISY_KIND,
      transformId: 't1',
    });
    for (let index = 0; index < 120; index += 1) transformLogs.push(`line ${index}`);

    await service.run('c1', 'ana', 'snap-1');

    const written = runs[0]?.logs ?? [];
    expect(written.filter((line) => line.startsWith('line '))).toHaveLength(50);
  });
});
