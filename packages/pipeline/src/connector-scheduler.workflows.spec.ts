import type {
  CatalogConnector,
  CatalogPipelineStore,
  CatalogWorkflow,
} from '@dudousxd/nestjs-catalog';
import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectorScheduler } from './connector-scheduler.service';
import { CATALOG_WORKFLOW_RUN } from './workflow-run.workflow';

vi.mock('@dudousxd/nestjs-durable', () => ({
  WorkflowEngine: class WorkflowEngine {},
  Step: () => (_target: unknown, _key: unknown, descriptor: unknown) => descriptor,
  Workflow: () => (target: unknown) => target,
}));

/**
 * Cron itself is stubbed, and the reason is worth stating rather than hiding.
 *
 * `prevCronFireMs` is backed by `cron-parser`, an **optional** peer dependency
 * this repo does not install — so against the real implementation every
 * expression here throws and this file would assert that nothing ever fires,
 * which is indistinguishable from the bug it exists to catch. That optionality
 * is itself the incident's root: a deployment missing the package got a
 * scheduler that announced it was watching and parsed nothing.
 *
 * So the parse is stubbed to a fixed window and an explicit refusal for one
 * sentinel expression, and what is asserted is everything this loop does
 * *around* the parse — which is all of the behaviour that moved.
 */
const WINDOW_MS = Date.parse('2026-01-01T03:00:00.000Z');
vi.mock('@dudousxd/nestjs-durable-core', async (importOriginal) => ({
  // Spread the real module so only the two cron functions are stubbed. A mock
  // that replaced the module wholesale fails the *collection* of every file in
  // the import graph that reaches for anything else — `FatalError`,
  // `isWorkflowControlFlowSignal` — and vitest reports that as "no tests",
  // which reads like the file was deleted rather than broken.
  ...((await importOriginal()) as Record<string, unknown>),
  prevCronFireMs: (cron: string) => {
    if (cron === 'not a cron') throw new Error(`Unrecognised expression "${cron}"`);
    return WINDOW_MS;
  },
  runSchedules: (
    engine: { start: (name: string, input: unknown, runId: string) => Promise<string> },
    schedules: Array<{ key: string; workflow: string; input: unknown }>,
  ) =>
    Promise.all(
      schedules.map((schedule) =>
        // The real one derives the run id from the key and the fire time, which
        // is what makes a duplicate start a no-op. Same shape here, so a test
        // asserting on the key is asserting on what the engine really receives.
        engine.start(schedule.workflow, schedule.input, `sched:${schedule.key}:${WINDOW_MS}`),
      ),
    ),
}));

/**
 * That a schedule authored on a graph is a schedule something actually reads.
 *
 * **This file exists because of a live incident.** Cron was silently broken for
 * every scheduled connector on a dev deployment, and the symptom was this loop
 * logging "Watching connector schedules every 30000ms" while parsing nothing at
 * all — a line that reads exactly like health. There was no test on this class
 * at the time, which is why nothing caught it, and moving the schedule off the
 * connector and onto the workflow is precisely the kind of change that could
 * re-create it: the loop keeps ticking, keeps announcing, and reads a column
 * nobody writes any more.
 *
 * So what is asserted here is not "the code path runs". It is that a run is
 * started **for the right thing, keyed on the right id**, and that every way a
 * schedule can exist and not fire is said out loud rather than skipped.
 *
 * The engine is a spy, because what is under test is what this loop asks the
 * engine for, not what the engine does about it.
 */

class SpyEngine {
  readonly started: Array<{ name: string; input: unknown; runId: string }> = [];
  start(name: string, input: unknown, runId: string) {
    this.started.push({ name, input, runId });
    return Promise.resolve(runId);
  }
  workflowBody() {
    return undefined;
  }
}

const LONG_AGO = '2020-01-01T00:00:00.000Z';

function workflow(overrides: Partial<CatalogWorkflow> = {}): CatalogWorkflow {
  return {
    id: 'w1',
    name: 'Nightly Mvr',
    nodes: [
      { id: 'in', name: 'in', kind: 'source', sourceKind: 'inline', config: { records: [] } },
      { id: 'out', name: 'out', kind: 'sink', targetType: 'Mvr' },
    ],
    edges: [{ from: 'in', to: 'out' }],
    status: 'ready',
    version: 3,
    graphHash: 'hash',
    targetType: 'Mvr',
    // Every minute, so a window is always open and the test never waits.
    schedule: '* * * * *',
    enabled: true,
    createdBy: 'ana',
    createdAt: LONG_AGO,
    updatedAt: LONG_AGO,
    ...overrides,
  };
}

function connector(overrides: Partial<CatalogConnector> = {}): CatalogConnector {
  return {
    id: 'c1',
    name: 'Nightly Mvr',
    kind: 'inline',
    targetType: 'Mvr',
    config: {},
    workflowId: 'w1',
    enabled: true,
    createdBy: 'ana',
    createdAt: LONG_AGO,
    updatedAt: LONG_AGO,
    ...overrides,
  };
}

/** Only the members the loop reaches; anything else is a call it must not make. */
function storeOf(workflows: CatalogWorkflow[], connectors: CatalogConnector[]) {
  return {
    listWorkflows: () => Promise.resolve(workflows),
    getWorkflow: (id: string) => Promise.resolve(workflows.find((w) => w.id === id)),
    saveWorkflow: () => Promise.reject(new Error('the scheduler writes nothing')),
    publishWorkflow: () => Promise.reject(new Error('the scheduler writes nothing')),
    saveWorkflowSchedule: () => Promise.reject(new Error('the scheduler writes nothing')),
    connectorsUsingWorkflow: (id: string) =>
      Promise.resolve(connectors.filter((c) => c.workflowId === id)),
    listConnectors: () => Promise.resolve(connectors),
  } as unknown as CatalogPipelineStore;
}

async function tick(store: CatalogPipelineStore, engine?: SpyEngine): Promise<void> {
  const scheduler = new ConnectorScheduler(
    store,
    engine as unknown as ConstructorParameters<typeof ConnectorScheduler>[1],
  );
  scheduler.onApplicationBootstrap();
  // The bootstrap fires one tick immediately and then sets an interval; the
  // interval is cleared so a test cannot leak a timer into the next one.
  await new Promise((resolve) => setImmediate(resolve));
  scheduler.onApplicationShutdown();
}

describe('the scheduler reads the schedule off the workflow', () => {
  let warnings: string[];
  let logs: string[];

  beforeEach(() => {
    warnings = [];
    logs = [];
    vi.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
      warnings.push(String(message));
    });
    vi.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
      logs.push(String(message));
    });
    vi.spyOn(Logger.prototype, 'error').mockImplementation((message: unknown) => {
      warnings.push(String(message));
    });
  });

  it('starts a workflow run for a ready, enabled, scheduled graph', async () => {
    const engine = new SpyEngine();
    await tick(storeOf([workflow()], [connector()]), engine);

    expect(engine.started).toHaveLength(1);
    expect(engine.started[0].name).toBe(CATALOG_WORKFLOW_RUN);
  });

  /**
   * The key is half the run id and the run id is the snapshot id, so it has to
   * be the connector's — that is what a run history, a watermark and the
   * singleton mutex all hang off. Keying on the workflow id would make every
   * scheduled pipeline's next window look like a run it had never done before.
   */
  it('keys the run on the connector, not on the workflow', async () => {
    const engine = new SpyEngine();
    await tick(storeOf([workflow()], [connector({ id: 'c-real' })]), engine);

    expect(engine.started[0].runId).toContain('connector:c-real');
    expect(engine.started[0].runId).not.toContain('w1');
  });

  it('carries the version the window started against, so a mid-run edit fails loudly', async () => {
    const engine = new SpyEngine();
    await tick(storeOf([workflow({ version: 7 })], [connector()]), engine);

    expect(engine.started[0].input).toMatchObject({
      workflowId: 'w1',
      workflowVersion: 7,
      connectorId: 'c1',
    });
  });

  /**
   * The rule with the sharpest consequence, and the one a future edit is most
   * likely to break by being helpful. A cron window is unattended, so an
   * acknowledgement given once and honoured every night is the row-count bound
   * switched off wearing a reason.
   */
  it('never acknowledges a shrink on an unattended window', async () => {
    const engine = new SpyEngine();
    await tick(storeOf([workflow()], [connector()]), engine);

    expect(engine.started[0].input).not.toHaveProperty('expectShrink');
  });

  describe('every way a schedule can exist and not fire is said out loud', () => {
    it('says so when the graph carrying it is still a draft', async () => {
      const engine = new SpyEngine();
      await tick(storeOf([workflow({ status: 'draft' })], [connector()]), engine);

      expect(engine.started).toHaveLength(0);
      expect(warnings.join(' ')).toMatch(/still a draft/);
      expect(warnings.join(' ')).toContain('Nightly Mvr');
    });

    it('says so when the graph is disabled', async () => {
      const engine = new SpyEngine();
      await tick(storeOf([workflow({ enabled: false })], [connector()]), engine);

      expect(engine.started).toHaveLength(0);
      expect(warnings.join(' ')).toMatch(/disabled/);
    });

    it('says so when a ready graph has no connector to key a run on', async () => {
      const engine = new SpyEngine();
      await tick(storeOf([workflow()], []), engine);

      expect(engine.started).toHaveLength(0);
      // Naming the repair matters: this state should not exist, and "publish it
      // again" is the one action that fixes it.
      expect(warnings.join(' ')).toMatch(/no enabled connector/);
    });

    it('says so when the cron cannot be parsed, and does not stop the others', async () => {
      const engine = new SpyEngine();
      await tick(
        storeOf(
          [workflow({ id: 'bad', name: 'Broken', schedule: 'not a cron' }), workflow()],
          [connector({ id: 'c-bad', workflowId: 'bad' }), connector()],
        ),
        engine,
      );

      expect(warnings.join(' ')).toContain('Broken');
      // The good one still ran. A single unparseable expression taking every
      // other pipeline down with it is how one typo becomes an outage.
      expect(engine.started).toHaveLength(1);
    });

    /**
     * The announcement is the line the incident was read as health from, so it
     * has to distinguish "watching six" from "watching six, firing none".
     */
    it('announces how many will actually fire, not just how many carry a cron', async () => {
      const engine = new SpyEngine();
      await tick(storeOf([workflow({ status: 'draft' })], [connector()]), engine);

      expect(logs.join(' ')).toMatch(/0 of 1/);
    });
  });

  it('refuses out loud when the store cannot hold a workflow at all', async () => {
    const engine = new SpyEngine();
    const store = { listConnectors: () => Promise.resolve([]) } as unknown as CatalogPipelineStore;
    await tick(store, engine);

    expect(engine.started).toHaveLength(0);
    expect(warnings.join(' ')).toMatch(/cannot hold workflows/);
  });

  it('does not read the copy of the schedule left on the connector', async () => {
    const engine = new SpyEngine();
    // The authority says nothing; the stale copy says every minute. A loop
    // reading the copy would fire, which is exactly the disagreement having two
    // columns invites.
    await tick(
      storeOf([workflow({ schedule: undefined })], [connector({ schedule: '* * * * *' })]),
      engine,
    );

    expect(engine.started).toHaveLength(0);
  });
});
