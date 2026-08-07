import type { EntityManager } from '@mikro-orm/mysql';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ConnectorRow, WorkflowReleaseRow, WorkflowRow } from './entities/pipeline';
import { MySqlPipelineStore } from './pipeline.store';

/**
 * That editing a graph and deploying it are two different acts.
 *
 * ## What the store is on the hook for
 *
 * Three things, and they are separable, which is why they are tested separately.
 * A release must be minted only by a deliberate call — not by a save, and not by
 * publishing, which is idempotent and is what a promotion apply presses. A live
 * pointer must refuse a version nothing can produce, because a pointer accepted
 * at a number with no graph behind it stops a pipeline at its next window rather
 * than at the moment somebody typed it. And an old version must actually be
 * *retrievable*, since pinning production to v6 means nothing if v6's graph was
 * overwritten by v7.
 *
 * ## Kept out of `*.db.spec.ts`
 *
 * For the reason the draft and credential specs next door give: every rule here
 * is a refusal or a routing decision reached in this file's own code, so booting
 * MySQL to prove them would make a check that runs on every deploy depend on
 * Docker. Only the calls these methods actually make are answered — a stub that
 * invented a row for a query they do not issue would be asserting against
 * fiction.
 */

const WHEN = new Date('2020-01-01T00:00:00.000Z');

/** A source and a sink, wired. The smallest graph that validates. */
const RUNNABLE = {
  nodes: [
    { id: 'in', name: 'in', kind: 'source' as const, sourceKind: 'inline' as const, config: {} },
    { id: 'out', name: 'out', kind: 'sink' as const, targetType: 'Subwo' },
  ],
  edges: [{ from: 'in', to: 'out' }],
};

/** A different wiring, so "which graph came back" is answerable by looking. */
const REWIRED = {
  nodes: [
    { id: 'in', name: 'in', kind: 'source' as const, sourceKind: 'inline' as const, config: {} },
    { id: 'mid', name: 'mid', kind: 'transform' as const, transformId: 't1' },
    { id: 'out', name: 'out', kind: 'sink' as const, targetType: 'Subwo' },
  ],
  edges: [
    { from: 'in', to: 'mid' },
    { from: 'mid', to: 'out' },
  ],
};

function storedWorkflow(overrides: Partial<WorkflowRow> = {}): WorkflowRow {
  const row = new WorkflowRow();
  row.id = 'w1';
  row.name = 'Nightly Subwo';
  row.nodes = REWIRED.nodes;
  row.edges = REWIRED.edges;
  row.status = 'ready';
  row.version = 9;
  row.graphHash = 'hash-of-v9';
  row.targetType = 'Subwo';
  row.schedule = '0 3 * * *';
  row.enabled = true;
  row.createdBy = 'ana';
  row.createdAt = WHEN;
  row.updatedAt = WHEN;
  return Object.assign(row, overrides);
}

function storedRelease(version: number, overrides: Partial<WorkflowReleaseRow> = {}) {
  const row = new WorkflowReleaseRow();
  row.id = `w1:${version}`;
  row.workflowId = 'w1';
  row.version = version;
  row.graphHash = `hash-of-v${version}`;
  row.nodes = RUNNABLE.nodes;
  row.edges = RUNNABLE.edges;
  row.targetType = 'Subwo';
  row.releasedBy = 'ana';
  row.releasedAt = WHEN;
  return Object.assign(row, overrides);
}

/**
 * Only the reads these methods make are answered.
 *
 * `releases` is keyed by primary key because that is how both `getWorkflowAt`
 * and the idempotency check look one up — asking by `{ workflowId, version }`
 * instead would be a different query and would quietly pass a store that had
 * stopped deriving the key.
 */
function entityManager(rows: {
  workflow?: WorkflowRow;
  releases?: WorkflowReleaseRow[];
}): {
  em: EntityManager;
  flushed: Array<Record<string, unknown>>;
  deletes: Array<{ entity: unknown; where: Record<string, unknown> }>;
} {
  const flushed: Array<Record<string, unknown>> = [];
  const deletes: Array<{ entity: unknown; where: Record<string, unknown> }> = [];
  let pending: Array<Record<string, unknown>> = [];
  const releases = rows.releases ?? [];

  const fake = {
    fork: () => fake,
    findOne: (entity: unknown, where: Record<string, unknown>) => {
      if (entity === WorkflowRow) return Promise.resolve(rows.workflow ?? null);
      if (entity === WorkflowReleaseRow) {
        return Promise.resolve(releases.find((row) => row.id === where.id) ?? null);
      }
      if (entity === ConnectorRow) return Promise.resolve(null);
      throw new Error('These tests exercise no other entity.');
    },
    find: (entity: unknown) => {
      if (entity === WorkflowReleaseRow) {
        return Promise.resolve([...releases].sort((a, b) => b.version - a.version));
      }
      if (entity === ConnectorRow) return Promise.resolve([]);
      throw new Error('These tests find no other entity.');
    },
    create: (_entity: unknown, data: Record<string, unknown>) => ({ ...data }),
    nativeUpdate: () => Promise.resolve(1),
    nativeDelete: (entity: unknown, where: Record<string, unknown>) => {
      deletes.push({ entity, where });
      return Promise.resolve(1);
    },
    persist: (row: Record<string, unknown>) => {
      pending.push(row);
    },
    flush: () => {
      flushed.push(...pending);
      pending = [];
      return Promise.resolve();
    },
  };

  // Not a type assertion: `Object.create(null)` is `any`, so the merged value is
  // too, and the declared return type is what narrows it back down.
  return { em: Object.assign(Object.create(null), fake), flushed, deletes };
}

describe('releasing a workflow', () => {
  it('freezes the graph at the version the row currently holds', async () => {
    const { em, flushed } = entityManager({ workflow: storedWorkflow({ version: 9 }) });
    const store = new MySqlPipelineStore(em);

    const release = await store.releaseWorkflow('w1', 'bruno', { notes: 'the fix for SUBWO' });

    expect(release.version).toBe(9);
    expect(release.id).toBe('w1:9');
    expect(release.releasedBy).toBe('bruno');
    expect(release.notes).toBe('the fix for SUBWO');
    // The graph itself, not merely a reference to it. This is the assertion that
    // fails if a release is stored as a version number and nothing else, which
    // is the shape that makes pinning production to v6 meaningless.
    expect(release.nodes).toHaveLength(3);
    expect(release.edges).toHaveLength(2);
    expect(flushed).toHaveLength(1);
  });

  /**
   * Only a graph somebody declared finished may be released, for the reason
   * `WORKFLOW_STATUSES` gives about what a connector may point at: a release is
   * a candidate for production, and a draft is by definition not one. Publishing
   * is the step that validates, so the refusal points at it.
   */
  it('refuses a draft, and says which step is missing', async () => {
    const { em, flushed } = entityManager({ workflow: storedWorkflow({ status: 'draft' }) });
    const store = new MySqlPipelineStore(em);

    await expect(store.releaseWorkflow('w1', 'bruno')).rejects.toThrow(BadRequestException);
    await expect(store.releaseWorkflow('w1', 'bruno')).rejects.toThrow(/publish it first/);
    expect(flushed).toHaveLength(0);
  });

  /**
   * A second release of an unchanged graph is not an event, so it does not
   * become a record of one — and it must not re-attribute the first.
   *
   * The attribution half is the part worth the test. Answering with the existing
   * row is the easy behaviour to get right; leaving `releasedBy` alone is the
   * one an "upsert" would quietly break, and the cost is that the audit trail
   * names whoever pressed the button second rather than whoever shipped it.
   */
  it('is idempotent per version, and does not reassign who shipped it', async () => {
    const { em, flushed } = entityManager({
      workflow: storedWorkflow({ version: 9 }),
      releases: [storedRelease(9, { releasedBy: 'ana', notes: 'the original reason' })],
    });
    const store = new MySqlPipelineStore(em);

    const release = await store.releaseWorkflow('w1', 'bruno', { notes: 'a different reason' });

    expect(release.releasedBy).toBe('ana');
    expect(release.notes).toBe('the original reason');
    expect(flushed).toHaveLength(0);
  });

  /**
   * The counter's docblock argues that archiving per save would fill a bounded
   * table with autosaves of a canvas somebody is still dragging boxes around on.
   * That argument survives this feature only because a save writes nothing here,
   * so it is asserted rather than assumed.
   */
  it('is not what a save does', async () => {
    const { em, flushed } = entityManager({ workflow: storedWorkflow({ version: 9 }) });
    const store = new MySqlPipelineStore(em);

    await store.saveWorkflow({ id: 'w1', name: 'Nightly Subwo', ...RUNNABLE }, 'ana');

    // One row: the workflow. A release would be a second.
    expect(flushed).toHaveLength(1);
    expect(flushed.some((row) => 'releasedBy' in row)).toBe(false);
  });

  /**
   * Nor is it what publishing does, which is the less obvious half.
   *
   * Publishing is idempotent and `applyPromotion` calls it, so a release minted
   * there would appear in an environment as a side effect of somebody promoting
   * configuration into it — a release nobody in that environment chose.
   */
  it('is not what publishing does either', async () => {
    // The transform-free graph, so publishing does not go looking for a
    // `TransformRow` this fake has no answer for. What is under test is what
    // publishing *writes*, not what it validates.
    const { em, flushed } = entityManager({
      workflow: storedWorkflow({ status: 'draft', nodes: RUNNABLE.nodes, edges: RUNNABLE.edges }),
    });
    const store = new MySqlPipelineStore(em);

    await store.publishWorkflow('w1', 'ana');

    expect(flushed.some((row) => 'releasedBy' in row)).toBe(false);
  });
});

describe('choosing which version is live', () => {
  it('points the graph at a released version', async () => {
    const row = storedWorkflow({ version: 9 });
    const { em } = entityManager({ workflow: row, releases: [storedRelease(6)] });
    const store = new MySqlPipelineStore(em);

    const saved = await store.setLiveWorkflowVersion('w1', 6, 'bruno');

    expect(saved.liveVersion).toBe(6);
    // The head is untouched. A deploy chooses which version runs; it does not
    // rewrite the graph somebody is editing.
    expect(saved.version).toBe(9);
  });

  /**
   * Rollback, and the point of the test is that it is *this* call. There is no
   * `rollbackWorkflow`, and there should not be: the older graph is still in the
   * archive, so repointing is sufficient, and a second method would be a second
   * implementation of one act.
   */
  it('rolls back by pointing at a smaller number, with no second mechanism', async () => {
    const row = storedWorkflow({ version: 12, liveVersion: 11 });
    const { em } = entityManager({
      workflow: row,
      releases: [storedRelease(11), storedRelease(6)],
    });
    const store = new MySqlPipelineStore(em);

    const rolled = await store.setLiveWorkflowVersion('w1', 6, 'bruno');

    expect(rolled.liveVersion).toBe(6);
  });

  /**
   * A pointer at a version nothing can produce would be a pipeline that stops at
   * its next window — found by a load failing rather than by the person who
   * typed it. The refusal names what there is, because "no release at v7" with
   * no list is a message that sends somebody to the database.
   */
  it('refuses a version with no release, naming the ones there are', async () => {
    const { em } = entityManager({
      workflow: storedWorkflow(),
      releases: [storedRelease(6), storedRelease(3)],
    });
    const store = new MySqlPipelineStore(em);

    await expect(store.setLiveWorkflowVersion('w1', 7, 'bruno')).rejects.toThrow(
      BadRequestException,
    );
    await expect(store.setLiveWorkflowVersion('w1', 7, 'bruno')).rejects.toThrow(/v6, v3/);
  });

  it('says so plainly when there are no releases at all', async () => {
    const { em } = entityManager({ workflow: storedWorkflow(), releases: [] });
    const store = new MySqlPipelineStore(em);

    await expect(store.setLiveWorkflowVersion('w1', 1, 'bruno')).rejects.toThrow(
      /no releases at all yet/,
    );
  });

  /**
   * Clearing is allowed, and it is the one call here that hands the hazard back:
   * from that moment editing the graph changes what the next window runs.
   * Refusing it would strand every graph that had ever gone live, which is worse
   * — but it is a decision, so it is pinned.
   */
  it('can be cleared, taking the graph back to following its latest save', async () => {
    const row = storedWorkflow({ version: 12, liveVersion: 6 });
    const { em } = entityManager({ workflow: row });
    const store = new MySqlPipelineStore(em);

    const cleared = await store.setLiveWorkflowVersion('w1', undefined, 'bruno');

    expect(cleared.liveVersion).toBeUndefined();
  });

  it('refuses a workflow that does not exist rather than inventing a row', async () => {
    const { em } = entityManager({});
    const store = new MySqlPipelineStore(em);

    await expect(store.setLiveWorkflowVersion('w1', 6, 'bruno')).rejects.toThrow(NotFoundException);
  });
});

describe('reading a graph back at a version', () => {
  /**
   * The assertion that makes a live pointer worth having. `v6`'s wiring is two
   * nodes; the row currently holds three. Getting the two back is the difference
   * between a version somebody can run and a number in a column.
   */
  it('answers with the graph as released, not the graph as it stands now', async () => {
    const { em } = entityManager({
      workflow: storedWorkflow({ version: 9 }),
      releases: [storedRelease(6)],
    });
    const store = new MySqlPipelineStore(em);

    const at = await store.getWorkflowAt('w1', 6);

    expect(at?.version).toBe(6);
    expect(at?.graphHash).toBe('hash-of-v6');
    expect(at?.nodes.map((node) => node.id)).toEqual(['in', 'out']);
  });

  /**
   * The other half of the same answer: the operational fields are the row's,
   * because they were never released. A cron somebody changed this morning
   * governs the version that is live — the alternative would resurrect whatever
   * schedule happened to be on the row the day it was frozen, which is a change
   * nobody made taking effect on a rollback.
   */
  it('carries the row’s present schedule and name, not the ones at release time', async () => {
    const { em } = entityManager({
      workflow: storedWorkflow({ version: 9, schedule: '*/5 * * * *', name: 'Renamed' }),
      releases: [storedRelease(6)],
    });
    const store = new MySqlPipelineStore(em);

    const at = await store.getWorkflowAt('w1', 6);

    expect(at?.schedule).toBe('*/5 * * * *');
    expect(at?.name).toBe('Renamed');
  });

  /**
   * `undefined`, and callers must not read it as "use the latest" — which is why
   * `requireWorkflowAt` turns it into a failed run. Asserted here so the store's
   * half of that contract is pinned independently of the runner's.
   */
  it('answers undefined for a version that was never released', async () => {
    const { em } = entityManager({
      workflow: storedWorkflow({ version: 9 }),
      releases: [storedRelease(6)],
    });
    const store = new MySqlPipelineStore(em);

    expect(await store.getWorkflowAt('w1', 7)).toBeUndefined();
  });
});

describe('deleting a workflow', () => {
  /**
   * The releases go, and this is the opposite of the call `deleteTransform`
   * makes about revisions. The rule is the same in both places — an archive
   * outlives its subject exactly as long as something can still cite it — and it
   * lands differently because `deleteWorkflow` takes the run history with it,
   * where deleting a transform leaves the runs that ran it behind.
   */
  it('takes the releases with it, since nothing that could cite them survives', async () => {
    const { em, deletes } = entityManager({
      workflow: storedWorkflow(),
      releases: [storedRelease(6)],
    });
    const store = new MySqlPipelineStore(em);

    await store.deleteWorkflow('w1');

    expect(deletes.map((entry) => entry.entity)).toContain(WorkflowReleaseRow);
  });
});

describe('what a promotion into this environment does to the live version', () => {
  /**
   * Nothing, and that is the property that matters most about promoting.
   *
   * `applyPromotion` carries a graph in with `saveWorkflow` followed by
   * `publishWorkflow`. Neither touches `liveVersion`, so a target already
   * running v4 keeps running v4 while the promoted graph lands as a newer save
   * beside it. **Promoting configuration must not silently deploy in the
   * target** — somebody there presses release and live, deliberately, once they
   * have looked at what arrived.
   *
   * The failure this stops is the worst one this feature could have: a colleague
   * promoting an unrelated transform, and production's pipeline changing shape
   * as a side effect.
   */
  it('leaves a target that is already live at a version running that version', async () => {
    const row = storedWorkflow({
      version: 4,
      liveVersion: 4,
      nodes: RUNNABLE.nodes,
      edges: RUNNABLE.edges,
    });
    const { em } = entityManager({ workflow: row, releases: [storedRelease(4)] });
    const store = new MySqlPipelineStore(em);

    // What an apply does, in order. A transform-free graph that differs from the
    // stored one, so the hash moves and the version bumps without this fake
    // needing to answer for a `TransformRow`.
    const arrived = {
      nodes: [
        {
          id: 'in2',
          name: 'in2',
          kind: 'source' as const,
          sourceKind: 'inline' as const,
          config: {},
        },
        { id: 'out', name: 'out', kind: 'sink' as const, targetType: 'Subwo' },
      ],
      edges: [{ from: 'in2', to: 'out' }],
    };
    const saved = await store.saveWorkflow(
      { id: 'w1', name: 'Nightly Subwo', ...arrived },
      'promotion',
    );
    await store.publishWorkflow('w1', 'promotion');

    // The graph moved on; what runs did not.
    expect(saved.version).toBe(5);
    expect(saved.liveVersion).toBe(4);
  });

  /**
   * And a graph arriving in an environment for the first time follows the latest
   * save there, exactly as a newly drawn one does — it does not inherit a
   * pointer from the environment it came from, where the number meant a
   * different graph entirely.
   */
  it('leaves a newly arrived graph following the latest save', async () => {
    const { em } = entityManager({});
    const store = new MySqlPipelineStore(em);

    const saved = await store.saveWorkflow({ name: 'Nightly Subwo', ...RUNNABLE }, 'promotion');

    expect(saved.liveVersion).toBeUndefined();
  });
});
