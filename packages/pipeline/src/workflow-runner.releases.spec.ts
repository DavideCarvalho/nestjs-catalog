import type { CatalogPipelineStore, CatalogWorkflow } from '@dudousxd/nestjs-catalog';
import {
  describeLiveVersion,
  liveWorkflowVersion,
  supportsWorkflowReleases,
} from '@dudousxd/nestjs-catalog';
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowRunnerService } from './workflow-runner.service';

vi.mock('@dudousxd/nestjs-durable', () => ({
  WorkflowEngine: class WorkflowEngine {},
  Step: () => (_target: unknown, _key: unknown, descriptor: unknown) => descriptor,
  Workflow: () => (target: unknown) => target,
}));

/**
 * That a run finishes on the graph it started on, and never on a different one.
 *
 * ## What this replaced
 *
 * Every step of a run loaded the head and called `assertSameGraph`, which failed
 * the run outright when the version had moved. That refusal was right — a run
 * must not execute half of one graph and half of another — but it was the *only*
 * answer available, because a workflow kept nothing but its latest shape. So an
 * edit landing at node three of a ten-node load killed the load.
 *
 * With releases there is a third answer between "the head still matches" and
 * "stop": produce the version the run started on. That is what makes the
 * in-flight guarantee real rather than aspirational — the run row has always
 * recorded `workflowVersion` at start, and only now can that number be turned
 * back into nodes and edges.
 *
 * ## And the refusal that must survive
 *
 * Where the archive cannot answer, nothing falls back to the head. That is the
 * same stand the version pin takes everywhere else in this codebase, in the same
 * words: running the newest thing available while the graph says otherwise is
 * exactly the substitution a pin was written down to prevent.
 */

const WHEN = '2020-01-01T00:00:00.000Z';

function workflow(overrides: Partial<CatalogWorkflow> = {}): CatalogWorkflow {
  return {
    id: 'w1',
    name: 'Nightly Subwo',
    nodes: [
      { id: 'in', name: 'in', kind: 'source', sourceKind: 'inline', config: {} },
      { id: 'out', name: 'out', kind: 'sink', targetType: 'Subwo' },
    ],
    edges: [{ from: 'in', to: 'out' }],
    status: 'ready',
    version: 9,
    graphHash: 'hash-of-v9',
    targetType: 'Subwo',
    enabled: true,
    createdBy: 'ana',
    createdAt: WHEN,
    updatedAt: WHEN,
    ...overrides,
  };
}

/**
 * A store whose archive reads are counted, so "did it consult the archive at
 * all" is assertable. The matching case must not: it is every run on every
 * deployment, and paying an extra statement per node to re-confirm the version
 * that is already in hand is the shape of cost this package is careful about.
 */
function storeOf(head: CatalogWorkflow, releases: CatalogWorkflow[] = []) {
  const reads = { getWorkflow: 0, getWorkflowAt: 0 };
  const store = {
    listWorkflows: () => Promise.resolve([head]),
    getWorkflow: (id: string) => {
      reads.getWorkflow += 1;
      return Promise.resolve(id === head.id ? head : undefined);
    },
    saveWorkflow: () => Promise.reject(new Error('unused')),
    publishWorkflow: () => Promise.reject(new Error('unused')),
    saveWorkflowSchedule: () => Promise.reject(new Error('unused')),
    connectorsUsingWorkflow: () => Promise.resolve([]),
    releaseWorkflow: () => Promise.reject(new Error('unused')),
    listWorkflowReleases: () => Promise.resolve([]),
    setLiveWorkflowVersion: () => Promise.reject(new Error('unused')),
    getWorkflowAt: (id: string, version: number) => {
      reads.getWorkflowAt += 1;
      return Promise.resolve(
        releases.find((found) => found.id === id && found.version === version),
      );
    },
    writeStage: () => Promise.resolve({ written: 0 }),
    readStage: () => Promise.resolve([]),
    dropStages: () => Promise.resolve(0),
  } as unknown as CatalogPipelineStore;
  return { store, reads };
}

/** Only the store is reached; every other dependency of the runner is unused here. */
function runnerOn(store: CatalogPipelineStore): WorkflowRunnerService {
  return new WorkflowRunnerService(
    store,
    undefined as never,
    undefined as never,
    undefined as never,
  );
}

describe('resolving the graph a run executes', () => {
  it('hands back the head when nothing has moved, without touching the archive', async () => {
    const { store, reads } = storeOf(workflow({ version: 9 }));

    const at = await runnerOn(store).requireWorkflowAt('w1', 9);

    expect(at.version).toBe(9);
    expect(reads.getWorkflowAt).toBe(0);
  });

  /**
   * The in-flight decision, stated as a test: a promotion at node three does not
   * swap the graph underneath a run that is already going.
   */
  it('produces the version the run started on after the head has moved past it', async () => {
    const { store } = storeOf(workflow({ version: 12 }), [
      workflow({ version: 6, graphHash: 'hash-of-v6', name: 'Nightly Subwo' }),
    ]);

    const at = await runnerOn(store).requireWorkflowAt('w1', 6);

    expect(at.version).toBe(6);
    expect(at.graphHash).toBe('hash-of-v6');
  });

  /**
   * No fallback, and the message has to say which two versions are involved —
   * "the graph changed" without the numbers sends somebody to the database to
   * find out what they are looking at.
   */
  it('stops rather than running the head when the started version was never released', async () => {
    const { store } = storeOf(workflow({ version: 12 }), []);

    await expect(runnerOn(store).requireWorkflowAt('w1', 6)).rejects.toThrow(BadRequestException);
    await expect(runnerOn(store).requireWorkflowAt('w1', 6)).rejects.toThrow(/now v12.*on v6/s);
  });

  /**
   * A store that cannot hold releases at all reaches the same refusal rather
   * than a `TypeError`, which is the whole reason the capability is a predicate
   * instead of an assumption. This is the state every deployment is in before it
   * upgrades, and the behaviour it gets — a run refused when the graph moved
   * mid-flight — is exactly what it had before this change.
   */
  it('refuses identically on a store with no archive, rather than failing on a missing method', async () => {
    const store = {
      listWorkflows: () => Promise.resolve([]),
      getWorkflow: () => Promise.resolve(workflow({ version: 12 })),
      saveWorkflow: () => Promise.reject(new Error('unused')),
      publishWorkflow: () => Promise.reject(new Error('unused')),
      saveWorkflowSchedule: () => Promise.reject(new Error('unused')),
      connectorsUsingWorkflow: () => Promise.resolve([]),
      writeStage: () => Promise.resolve({ written: 0 }),
      readStage: () => Promise.resolve([]),
    } as unknown as CatalogPipelineStore;

    expect(supportsWorkflowReleases(store)).toBe(false);
    await expect(runnerOn(store).requireWorkflowAt('w1', 6)).rejects.toThrow(BadRequestException);
  });
});

/**
 * The one implementation of "which version does this graph run", shared by the
 * scheduler and the run route so the cron and the button beside it cannot
 * disagree. Trivial by design; pinned because the whole feature is that one
 * `??`, and a console reimplementing it is how the two come apart.
 */
describe('liveWorkflowVersion', () => {
  it('follows the head when nothing is live, which is where every graph starts', () => {
    expect(liveWorkflowVersion(workflow({ version: 9 }))).toBe(9);
  });

  it('names the live version once one is set, however far the head has moved', () => {
    expect(liveWorkflowVersion(workflow({ version: 40, liveVersion: 6 }))).toBe(6);
  });
});

/**
 * The wording a console renders, shared with the node-level pin rather than
 * invented beside it.
 *
 * The labels are the point: `describeVersionPin` says "follows the latest" and
 * "pinned to vN" about a transform node, and a graph that used different words
 * for the same idea would leave the reader working out whether they meant the
 * same thing. What differs is the detail, and only where the facts differ — a
 * graph's live version is never evicted, so this copy must never grow the
 * eviction caveat the node's carries.
 */
describe('describeLiveVersion', () => {
  it('warns that editing is deploying while a graph follows its latest save', () => {
    const copy = describeLiveVersion(workflow({ version: 9 }));

    expect(copy.pinned).toBe(false);
    expect(copy.label).toBe('follows the latest');
    expect(copy.detail).toContain('same act as deploying');
  });

  it('names the released version, and the saves that are stored and not running', () => {
    const copy = describeLiveVersion(workflow({ version: 12, liveVersion: 6 }));

    expect(copy.pinned).toBe(true);
    expect(copy.label).toBe('running v6');
    expect(copy.detail).toContain('latest save is v12');
    expect(copy.detail).toContain('rollback');
  });

  /**
   * Never, in either branch. A cap that could evict the graph production is
   * running would stop a working pipeline to enforce a storage policy, which is
   * exactly why releases live in their own table rather than in
   * `catalog_revision` — so copy implying otherwise would be a promise this
   * feature does not make.
   */
  it('makes no eviction caveat, because a release is never evicted', () => {
    for (const graph of [workflow(), workflow({ liveVersion: 6 })]) {
      expect(describeLiveVersion(graph).detail).not.toMatch(/superseded|no longer be produced/);
    }
  });
});
