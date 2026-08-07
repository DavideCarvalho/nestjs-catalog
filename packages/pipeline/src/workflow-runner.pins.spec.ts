import type {
  CatalogReusableNode,
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
 * What a run does with a version pin and a reusable reference.
 *
 * WHAT THIS FILE IS FOR
 * ---------------------
 * One property, stated three ways: **a pin that cannot be honoured stops the
 * load, and never falls back to the latest.**
 *
 * The fall-back is the tempting implementation and it is the one that makes the
 * whole feature a lie. A pin exists because somebody decided their graph should
 * keep running the code it was tested against; a runner that quietly used the
 * newest available version when the pinned one had aged out of the archive would
 * do exactly what the pin was written down to prevent, at three in the morning,
 * with nothing in the graph's diff and nothing in the run history to explain it.
 * That is the argument `WorkflowRunSteps.checkCall` makes about a call's version
 * — "a pin nobody checked is not a pin" — and this is the same stand for the two
 * references that arrived with reusable nodes.
 *
 * The second property is the counterweight, and it is asserted first: **an
 * unpinned node still follows the latest.** Every transform node in the
 * deployment this ships to is unpinned, so a release that changed what they run
 * would be a behaviour change dressed as a feature.
 */

const SNAPSHOT = 'wf-run-pins-1';

const TRANSFORM_AT: Record<number, CatalogTransform> = {
  3: transform(3, 'return records.map((r) => ({ ...r, v: 3 }));'),
  5: transform(5, 'return records.map((r) => ({ ...r, v: 5 }));'),
};

function transform(version: number, code: string): CatalogTransform {
  return {
    id: 'tx-1',
    name: 'Shape',
    language: 'javascript',
    code,
    version,
    createdBy: 'ana',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function workflowOf(nodes: WorkflowNode[]): CatalogWorkflow {
  return {
    id: 'wf-pins',
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

/** `src → shape → Mvr`, with the transform node's pin as given. */
function graphPinning(transformVersion?: number): CatalogWorkflow {
  return workflowOf([
    {
      id: 'src',
      kind: 'source',
      name: 'Rows',
      sourceKind: 'inline',
      config: { records: [{ id: 1 }] },
    },
    { id: 'shape', kind: 'transform', name: 'Shape', transformId: 'tx-1', transformVersion },
    { id: 'load', kind: 'sink', name: 'Into Mvr', targetType: 'Mvr' },
  ]);
}

/** The same graph with a source that is an instance of a reusable node. */
function graphUsing(useId: string, useVersion?: number): CatalogWorkflow {
  return workflowOf([
    {
      id: 'src',
      kind: 'source',
      name: 'Rows',
      // The CACHE the store folded on at save time. If the runner trusted it
      // instead of re-reading, an edit to the reusable node would never reach a
      // graph that follows it — which is the whole point of following.
      sourceKind: 'inline',
      config: { records: [{ id: 'stale' }] },
      useId,
      useVersion,
    },
    { id: 'shape', kind: 'transform', name: 'Shape', transformId: 'tx-1', transformVersion: 3 },
    { id: 'load', kind: 'sink', name: 'Into Mvr', targetType: 'Mvr' },
  ]);
}

interface Held {
  reusable?: Record<string, CatalogReusableNode>;
  /** Whether this deployment's store can resolve a pin or a reference at all. */
  archive?: boolean;
  library?: boolean;
}

function harness(workflow: CatalogWorkflow, held: Held = {}) {
  const stages = new Map<string, Array<Record<string, unknown>>>();
  const runs: ConnectorRun[] = [];
  const ran: number[] = [];

  const base = {
    listWorkflows: () => Promise.resolve([workflow]),
    getWorkflow: () => Promise.resolve(workflow),
    saveWorkflow: () => Promise.resolve(workflow),
    publishWorkflow: () => Promise.resolve(workflow),
    saveWorkflowSchedule: () => Promise.resolve(workflow),
    connectorsUsingWorkflow: () => Promise.resolve([]),
    getConnector: () => Promise.resolve(undefined),
    getConnection: () => Promise.resolve(undefined),
    saveConnectorState: () => Promise.resolve(),
    // The current row, which is what an unpinned node reads.
    getTransform: () => Promise.resolve(TRANSFORM_AT[5]),

    writeStage: (input: {
      runId: string;
      nodeId: string;
      batch: number;
      rows: Array<Record<string, unknown>>;
    }) => {
      stages.set(`${input.runId}/${input.nodeId}/${input.batch}`, input.rows);
      return Promise.resolve();
    },
    readStage: (input: { runId: string; nodeId: string; batch: number }) =>
      Promise.resolve(stages.get(`${input.runId}/${input.nodeId}/${input.batch}`) ?? []),
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

  // Spread conditionally rather than defined-and-undefined, because the
  // capability probes narrow on `typeof x === 'function'` — a store that "cannot
  // hold reusable nodes" has to be a store with no such method, which is what a
  // deployment on an older store actually looks like.
  const archive = held.archive
    ? {
        getTransformAt: (_id: string, version: number) =>
          Promise.resolve(TRANSFORM_AT[version] ?? undefined),
      }
    : {};
  const library = held.library
    ? {
        listReusableNodes: () => Promise.resolve(Object.values(held.reusable ?? {})),
        getReusableNode: (id: string) => Promise.resolve(held.reusable?.[id]),
        getReusableNodeAt: (id: string, version: number) => {
          const node = held.reusable?.[id];
          return Promise.resolve(node && node.version === version ? node : undefined);
        },
        saveReusableNode: () => Promise.reject(new Error('not under test')),
        deleteReusableNode: () => Promise.resolve(false),
        reusableNodeUses: () => Promise.resolve([]),
      }
    : {};

  const publish = {
    appendRowsAsSystem: (
      _principalId: string,
      _typeName: string,
      _snapshotId: string,
      rows: Array<Record<string, unknown>>,
    ) => Promise.resolve({ written: rows.length }),
    carryForwardAsSystem: () => Promise.resolve({ carried: 0, total: 0, from: undefined }),
    commitAsSystem: (principalId: string, _typeName: string, snapshotId: string) =>
      Promise.resolve<SnapshotRef>({
        id: snapshotId,
        rowCount: 0,
        createdAt: '2026-02-01T03:00:00.000Z',
        principalId,
      }),
  };

  const service = new WorkflowRunnerService(
    Object.assign(Object.create(null), base, archive, library),
    Object.assign(Object.create(null), {
      // Records which version's code actually executed, which is the only thing
      // any of these tests is really asking.
      run: (used: CatalogTransform) => {
        ran.push(used.version);
        return Promise.resolve({ rows: [{ id: 1 }], logs: [], elapsedMs: 1 });
      },
    }),
    Object.assign(Object.create(null), publish),
  );

  return { service, stages, ran };
}

async function run(workflow: CatalogWorkflow, held?: Held) {
  const kit = harness(workflow, held);
  const outcome = await kit.service.runInline({
    workflow,
    connectorId: 'conn-1',
    principalId: 'ana',
    snapshotId: SNAPSHOT,
  });
  return { ...kit, run: outcome };
}

describe('a transform node that pins nothing', () => {
  it('runs the current version, exactly as it always has', async () => {
    const { run: outcome, ran } = await run(graphPinning(), { archive: true });

    expect(outcome.status).toBe('succeeded');
    expect(ran).toEqual([5]);
  });

  it('runs on a deployment whose store keeps no archive at all', async () => {
    // The upgrade case. A store that predates `getTransformAt` still runs every
    // graph it ran yesterday, because every one of them is unpinned.
    const { run: outcome, ran } = await run(graphPinning(), { archive: false });

    expect(outcome.status).toBe('succeeded');
    expect(ran).toEqual([5]);
  });
});

describe('a transform node that pins a version', () => {
  it('runs that version, not the current one', async () => {
    const { run: outcome, ran } = await run(graphPinning(3), { archive: true });

    expect(outcome.status).toBe('succeeded');
    expect(ran).toEqual([3]);
  });

  it('fails when the archive can no longer produce it, rather than using the latest', async () => {
    // The load-bearing assertion of this file. `ran` being empty is the whole
    // point: no code executed at all, so nothing was written under a version
    // nobody chose.
    const { run: outcome, ran } = await run(graphPinning(2), { archive: true });

    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/pinned to v2 .* can no longer be produced/s);
    expect(ran).toEqual([]);
  });

  it('fails when the store cannot resolve a pin at all, and says which pin', async () => {
    const { run: outcome, ran } = await run(graphPinning(3), { archive: false });

    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/keeps no history/);
    expect(ran).toEqual([]);
  });
});

describe('a source that is an instance of a reusable node', () => {
  const live: CatalogReusableNode = {
    id: 'lib-1',
    name: 'the nightly warehouse pull',
    kind: 'source',
    body: { kind: 'source', sourceKind: 'inline', config: { records: [{ id: 'fresh' }] } },
    version: 2,
    createdBy: 'ana',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('reads the library’s body, not the copy cached on the node', async () => {
    // What "follows the latest" has to mean to be worth anything: an edit to a
    // shared body reaches this graph on its next run, without the graph being
    // opened, re-saved, or even known about.
    const { run: outcome, stages } = await run(graphUsing('lib-1'), {
      archive: true,
      library: true,
      reusable: { 'lib-1': live },
    });

    expect(outcome.status).toBe('succeeded');
    expect(stages.get(`${SNAPSHOT}/src/1`)).toEqual([{ id: 'fresh' }]);
  });

  it('reads the pinned version when it names one', async () => {
    const { run: outcome, stages } = await run(graphUsing('lib-1', 2), {
      archive: true,
      library: true,
      reusable: { 'lib-1': live },
    });

    expect(outcome.status).toBe('succeeded');
    expect(stages.get(`${SNAPSHOT}/src/1`)).toEqual([{ id: 'fresh' }]);
  });

  it('fails on a pin the archive lost, rather than reading the current body', async () => {
    const { run: outcome, stages } = await run(graphUsing('lib-1', 1), {
      archive: true,
      library: true,
      reusable: { 'lib-1': live },
    });

    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/pinned to v1 of reusable node lib-1/);
    expect(stages.get(`${SNAPSHOT}/src/1`)).toBeUndefined();
  });

  it('fails when the reusable node is gone, rather than running the stale cache', async () => {
    const { run: outcome, stages } = await run(graphUsing('lib-1'), {
      archive: true,
      library: true,
      reusable: {},
    });

    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/which is gone/);
    expect(stages.get(`${SNAPSHOT}/src/1`)).toBeUndefined();
  });

  it('fails on a store that cannot hold reusable nodes, rather than running the cache', async () => {
    // The subtlest of the five, and the reason it is a refusal: the node still
    // carries a perfectly runnable copy. Running it would mean a load driven by
    // a configuration nobody can see, edit, or count the users of.
    const { run: outcome } = await run(graphUsing('lib-1'), { archive: true, library: false });

    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/cannot hold reusable nodes/);
  });
});
