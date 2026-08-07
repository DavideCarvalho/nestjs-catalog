import type {
  CatalogConnector,
  CatalogPipelineStore,
  CatalogWorkflow,
} from '@dudousxd/nestjs-catalog';
import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectorScheduler } from './connector-scheduler.service';
import type { CatalogWorkflowRunInput } from './workflow-run.workflow';

vi.mock('@dudousxd/nestjs-durable', () => ({
  WorkflowEngine: class WorkflowEngine {},
  Step: () => (_target: unknown, _key: unknown, descriptor: unknown) => descriptor,
  Workflow: () => (target: unknown) => target,
}));

/** Cron is stubbed for the reason `connector-scheduler.workflows.spec.ts` states at length. */
const WINDOW_MS = Date.parse('2026-01-01T03:00:00.000Z');
vi.mock('@dudousxd/nestjs-durable-core', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  prevCronFireMs: () => WINDOW_MS,
  runSchedules: (
    engine: { start: (name: string, input: unknown, runId: string) => Promise<string> },
    schedules: Array<{ key: string; workflow: string; input: unknown }>,
  ) =>
    Promise.all(
      schedules.map((schedule) =>
        engine.start(schedule.workflow, schedule.input, `sched:${schedule.key}:${WINDOW_MS}`),
      ),
    ),
}));

/**
 * That a save is no longer a deploy.
 *
 * ## The hazard this file is the regression test for
 *
 * Before releases, `ConnectorScheduler.fire` put `workflow.version` into the run
 * payload — the version on the row, which is to say **the latest save**. A
 * `ready` graph stays ready through an edit (`saveWorkflow` deliberately refuses
 * to demote one), so there was no publish step between editing a live pipeline
 * and the next cron tick executing what had just been typed. The only gate was
 * `ready` versus `draft`, and an edit does not cross it. Someone dragging a box
 * on a canvas at 02:59 changed what ran at 03:00.
 *
 * What is asserted here is the payload — `workflowVersion` — because that is the
 * whole mechanism. The scheduler does not resolve a graph; it names a version,
 * and `WorkflowRunnerService.requireWorkflowAt` is what turns that name into
 * nodes and edges. So "which version did the window ask for" is exactly the
 * question, and it is answerable without a database.
 *
 * ## The other half: nothing changed for anybody who has not opted in
 *
 * Every case below is paired with its unpinned twin, because the promise that
 * makes this safe to ship is that a deployment which never touches releases
 * keeps behaving identically. A graph with no live version follows its head,
 * exactly as every graph does today.
 */

const LONG_AGO = '2020-01-01T00:00:00.000Z';

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
    version: 9,
    graphHash: 'hash-of-v9',
    targetType: 'Mvr',
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

/**
 * Deliberately holds **no** release members.
 *
 * The scheduler must not reach for one, and this is how that is enforced rather
 * than asserted: it names a version and leaves resolving it to the runner. A
 * loop that read the archive would be a per-graph query every thirty seconds
 * forever, which is precisely the cost `settlementOf` exists to avoid.
 */
function storeOf(workflows: CatalogWorkflow[], connectors: CatalogConnector[]) {
  return {
    listWorkflows: () => Promise.resolve(workflows),
    getWorkflow: (id: string) => Promise.resolve(workflows.find((found) => found.id === id)),
    saveWorkflow: () => Promise.reject(new Error('the scheduler writes nothing')),
    publishWorkflow: () => Promise.reject(new Error('the scheduler writes nothing')),
    saveWorkflowSchedule: () => Promise.reject(new Error('the scheduler writes nothing')),
    connectorsUsingWorkflow: (id: string) =>
      Promise.resolve(connectors.filter((found) => found.workflowId === id)),
    listConnectors: () => Promise.resolve(connectors),
  } as unknown as CatalogPipelineStore;
}

async function tick(store: CatalogPipelineStore, engine: SpyEngine): Promise<void> {
  const scheduler = new ConnectorScheduler(
    store,
    engine as unknown as ConstructorParameters<typeof ConnectorScheduler>[1],
  );
  scheduler.onApplicationBootstrap();
  await new Promise((resolve) => setImmediate(resolve));
  scheduler.onApplicationShutdown();
}

/**
 * The two fields this file is about, narrowed off the started payload.
 *
 * Narrowed rather than asserted onto {@link CatalogWorkflowRunInput}: the whole
 * point here is that one number is right, and a cast would let a payload that
 * had *lost* the field read as one carrying `undefined` — which every assertion
 * below would then compare against and fail confusingly, or pass.
 */
function payloadOf(
  engine: SpyEngine,
  index = 0,
): Pick<CatalogWorkflowRunInput, 'workflowId' | 'workflowVersion'> {
  const input = engine.started[index]?.input;
  if (input === null || typeof input !== 'object') {
    throw new Error('The scheduler started nothing, so there is no payload to read.');
  }
  const version = Reflect.get(input, 'workflowVersion');
  const id = Reflect.get(input, 'workflowId');
  if (typeof version !== 'number' || typeof id !== 'string') {
    throw new Error(`The started payload names no workflow version: ${JSON.stringify(input)}`);
  }
  return { workflowId: id, workflowVersion: version };
}

describe('which version a cron window runs', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  /**
   * The backward-compatibility promise, asserted first because it is the one
   * that decides whether this can ship without a migration that changes
   * behaviour. Every existing graph is in this state.
   */
  it('runs the latest save when nothing has been released, exactly as it always has', async () => {
    const engine = new SpyEngine();
    await tick(storeOf([workflow({ version: 9 })], [connector()]), engine);

    expect(payloadOf(engine).workflowVersion).toBe(9);
  });

  it('runs the live version, not the latest save, once one is set', async () => {
    const engine = new SpyEngine();
    await tick(storeOf([workflow({ version: 9, liveVersion: 6 })], [connector()]), engine);

    expect(payloadOf(engine).workflowVersion).toBe(6);
  });

  /**
   * The maintainer's sentence, as a test.
   *
   * "cê pode criar uma nova versão, mas se tu tipo tiver um cron [...] vai
   * chamar a versão de produção" — a new version exists on the row, and the cron
   * does not care. Two graphs identical but for the head version, both live at
   * v6: the window is the same window either way.
   */
  it('does not notice a save that moved the head past the live version', async () => {
    const before = new SpyEngine();
    await tick(storeOf([workflow({ version: 6, liveVersion: 6 })], [connector()]), before);

    const after = new SpyEngine();
    await tick(storeOf([workflow({ version: 12, liveVersion: 6 })], [connector()]), after);

    expect(payloadOf(before).workflowVersion).toBe(6);
    expect(payloadOf(after).workflowVersion).toBe(6);
  });

  /**
   * Rollback, from the only angle this class can see it: the pointer moved and
   * the next window followed it. There is no separate mechanism to exercise —
   * repointing IS the rollback — so what a test can add is that the loop does
   * not hold the old answer.
   */
  it('follows the pointer backwards, which is the whole of a rollback', async () => {
    const engine = new SpyEngine();
    await tick(storeOf([workflow({ version: 12, liveVersion: 5 })], [connector()]), engine);

    expect(payloadOf(engine).workflowVersion).toBe(5);
  });

  /**
   * The settlement is the one thing this loop remembers, and it is keyed on a
   * fingerprint that must expire on anything that changes the decision. A deploy
   * is now the most important of those, so a second tick after the pointer moves
   * has to start the *new* version rather than treat the window as settled.
   *
   * Both ticks run against one scheduler instance, because the settlement lives
   * on the instance — a fresh one per tick would pass this test with the field
   * removed entirely.
   */
  it('re-decides a window it had already settled when the live version moves', async () => {
    const engine = new SpyEngine();
    const graph = workflow({ version: 12, liveVersion: 5 });
    const graphs = [graph];
    const scheduler = new ConnectorScheduler(
      storeOf(graphs, [connector()]),
      engine as unknown as ConstructorParameters<typeof ConnectorScheduler>[1],
    );

    scheduler.onApplicationBootstrap();
    await new Promise((resolve) => setImmediate(resolve));
    expect(payloadOf(engine).workflowVersion).toBe(5);

    graphs[0] = workflow({ version: 12, liveVersion: 11 });
    await scheduler.tick();
    scheduler.onApplicationShutdown();

    expect(engine.started).toHaveLength(2);
    expect(payloadOf(engine, 1).workflowVersion).toBe(11);
  });

  /**
   * A graph that is live at a version is still gated on being ready and enabled.
   *
   * Worth pinning because a live pointer is a *stronger* statement than `ready`
   * — somebody deliberately deployed this — and it would be an easy mistake for
   * it to start reading as one. It does not: unpublishing a graph disables the
   * connector it runs as, and the pointer survives so re-publishing resumes the
   * same version rather than the latest save.
   */
  it('still refuses to fire a draft, live version or not', async () => {
    const engine = new SpyEngine();
    await tick(
      storeOf([workflow({ status: 'draft', version: 12, liveVersion: 6 })], [connector()]),
      engine,
    );

    expect(engine.started).toHaveLength(0);
  });
});
