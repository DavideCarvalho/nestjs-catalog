import type { EntityManager } from '@mikro-orm/mysql';
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ConnectorRow, TransformRow, WorkflowRow } from './entities/pipeline';
import { MySqlPipelineStore } from './pipeline.store';

/**
 * That validation is the gate on *publishing* and no longer the gate on saving.
 *
 * Kept out of `*.db.spec.ts` for the reason the credential spec next door gives:
 * every rule under test is a refusal reached before a statement is issued, so
 * booting MySQL to prove it would make a check that runs on every save depend on
 * Docker. Only the calls these methods actually make are answered — a stub that
 * invented a row for a query they do not run would be asserting against fiction.
 *
 * The one that matters most is the first: **a graph you have not finished has to
 * be storable.** Before this, `saveWorkflow` ran `validateWorkflow` and threw on
 * any issue, so a canvas with one unwired node could not be written down at all
 * and closing the tab lost the work. That is also why "+ Sink" answered with
 * "is not reachable from any source" one second after the click — both true,
 * both useless, and both the normal state of a node that has just been added.
 */
function entityManager(rows: {
  workflow?: WorkflowRow;
  connector?: ConnectorRow;
  transform?: TransformRow;
  usingConnectors?: ConnectorRow[];
}): {
  em: EntityManager;
  flushed: Array<Record<string, unknown>>;
  updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>;
} {
  const flushed: Array<Record<string, unknown>> = [];
  const updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  let pending: Array<Record<string, unknown>> = [];

  const fake = {
    fork: () => fake,
    findOne: (entity: unknown) => {
      if (entity === WorkflowRow) return Promise.resolve(rows.workflow ?? null);
      if (entity === ConnectorRow) return Promise.resolve(rows.connector ?? null);
      if (entity === TransformRow) return Promise.resolve(rows.transform ?? null);
      throw new Error('These tests exercise no other entity.');
    },
    // Only `connectorsUsingWorkflow` reaches this, which is what makes the
    // unpublish refusal assertable without a database.
    find: (entity: unknown) => {
      if (entity === ConnectorRow) return Promise.resolve(rows.usingConnectors ?? []);
      throw new Error('These tests find no other entity.');
    },
    create: (_entity: unknown, data: Record<string, unknown>) => ({ ...data }),
    // Reached by `unpublishWorkflow` (disabling the connector the graph ran as)
    // and by `publishWorkflow` through `mintConnectorFor`. Recorded rather than
    // ignored so a test can assert the cascade happened, which is the whole of
    // what changed about unpublishing.
    nativeUpdate: (
      _entity: unknown,
      where: Record<string, unknown>,
      data: Record<string, unknown>,
    ) => {
      updates.push({ where, data });
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
  return { em: Object.assign(Object.create(null), fake), flushed, updates };
}

/** A source and a sink, wired. The smallest graph that validates. */
const RUNNABLE = {
  nodes: [
    { id: 'in', name: 'in', kind: 'source' as const, sourceKind: 'inline' as const, config: {} },
    { id: 'out', name: 'out', kind: 'sink' as const, targetType: 'Subwo' },
  ],
  edges: [{ from: 'in', to: 'out' }],
};

/**
 * Exactly what pressing "+ Sink" leaves on the canvas: one node, unwired, and
 * naming no type. `validateWorkflow` has at least one complaint about it, which
 * is the point — this is the graph that used to be unsaveable.
 */
const HALF_DRAWN = {
  nodes: [{ id: 'out', name: 'out', kind: 'sink' as const, targetType: '' }],
  edges: [],
};

/**
 * A graph with no sink at all — the first thing on the canvas, before anywhere
 * to put the rows has been chosen.
 *
 * Distinct from {@link HALF_DRAWN} on purpose: that one *has* a sink naming the
 * empty string, so it never exercises the "no sink to derive from" branch.
 */
const SOURCE_ONLY = {
  nodes: [
    { id: 'in', name: 'in', kind: 'source' as const, sourceKind: 'inline' as const, config: {} },
  ],
  edges: [],
};

function storedWorkflow(status: string, graph = RUNNABLE): WorkflowRow {
  const row = new WorkflowRow();
  row.id = 'w1';
  row.name = 'Nightly Subwo';
  row.nodes = graph.nodes;
  row.edges = graph.edges;
  row.status = status;
  row.version = 3;
  row.graphHash = 'hash-of-something-else';
  row.targetType = 'Subwo';
  row.createdBy = 'ana';
  row.createdAt = new Date('2020-01-01T00:00:00.000Z');
  row.updatedAt = new Date('2020-01-01T00:00:00.000Z');
  return row;
}

function usingConnector(): ConnectorRow {
  const row = new ConnectorRow();
  row.id = 'c1';
  row.name = 'Nightly';
  row.kind = 'sql';
  row.targetType = 'Subwo';
  row.config = {};
  row.workflowId = 'w1';
  row.enabled = true;
  row.createdBy = 'ana';
  row.createdAt = new Date('2020-01-01T00:00:00.000Z');
  row.updatedAt = new Date('2020-01-01T00:00:00.000Z');
  return row;
}

describe('MySqlPipelineStore.saveWorkflow: a draft is stored as drawn', () => {
  it('saves a half-drawn graph instead of refusing it', async () => {
    const { em, flushed } = entityManager({});
    const store = new MySqlPipelineStore(em);

    const saved = await store.saveWorkflow({ name: 'Half drawn', ...HALF_DRAWN }, 'ana');

    // The assertion that fails on the unfixed store, where this threw
    // `"Half drawn" cannot run as drawn.` before reaching the database.
    expect(saved.status).toBe('draft');
    expect(flushed).toHaveLength(1);
  });

  it('carries no target type until a sink names one', async () => {
    // `targetType` is a stored, indexed column, and a draft is allowed to carry
    // it empty precisely because a draft is allowed to have no sink at all.
    // Publishing is the moment that stops being allowed.
    //
    // The graph here has *no sink node*, deliberately, and that is the case this
    // pins: a mutation that fabricates a type for a sinkless draft survives a
    // fixture whose sink merely names the empty string, because that one never
    // reaches the fallback.
    const { em } = entityManager({});
    const store = new MySqlPipelineStore(em);

    const saved = await store.saveWorkflow({ name: 'Just a source', ...SOURCE_ONLY }, 'ana');

    expect(saved.targetType).toBe('');
    expect(saved.status).toBe('draft');
  });

  it('keeps a published graph published, and refuses an edit that would break it', async () => {
    const { em, flushed } = entityManager({ workflow: storedWorkflow('ready') });
    const store = new MySqlPipelineStore(em);

    await expect(
      store.saveWorkflow({ id: 'w1', name: 'Nightly Subwo', ...HALF_DRAWN }, 'ana'),
    ).rejects.toBeInstanceOf(BadRequestException);

    // Refused, not demoted — and the distinction is the whole decision. A save
    // that silently dropped this to `draft` would stop every connector running
    // it, on a schedule, with nothing said to anybody.
    expect(flushed).toHaveLength(0);
  });

  it('still validates a published graph that stays runnable', async () => {
    const { em, flushed } = entityManager({ workflow: storedWorkflow('ready') });
    const store = new MySqlPipelineStore(em);

    const saved = await store.saveWorkflow({ id: 'w1', name: 'Renamed', ...RUNNABLE }, 'ana');

    expect(saved.status).toBe('ready');
    expect(flushed).toHaveLength(1);
  });
});

describe('MySqlPipelineStore.publishWorkflow: the gate, moved', () => {
  it('refuses a draft that cannot run, and says why', async () => {
    const { em, flushed } = entityManager({ workflow: storedWorkflow('draft', HALF_DRAWN) });
    const store = new MySqlPipelineStore(em);

    await expect(store.publishWorkflow('w1', 'ana')).rejects.toThrow(/cannot run as drawn/);
    expect(flushed).toHaveLength(0);
  });

  it('publishes a runnable draft and derives the target type from the sink', async () => {
    const row = storedWorkflow('draft');
    row.targetType = '';
    const { em, flushed } = entityManager({ workflow: row });
    const store = new MySqlPipelineStore(em);

    const published = await store.publishWorkflow('w1', 'ana');

    expect(published.status).toBe('ready');
    // Re-derived at this instant rather than trusted from the row: the row's
    // copy was written by a save that may have had no sink at all.
    expect(published.targetType).toBe('Subwo');
    // Two, and the second is the point: publishing is what mints the connector
    // the graph runs as. There is no `POST connectors` any more, so if this
    // flush stopped happening a published graph would have nothing to key a run,
    // a watermark or the singleton mutex on, and the only symptom would be a
    // schedule that never fires.
    expect(flushed).toHaveLength(2);
    const minted = flushed[1];
    expect(minted.workflowId).toBe('w1');
    expect(minted.targetType).toBe('Subwo');
  });

  it('updates the connector it already minted rather than making a second one', async () => {
    const existing = usingConnector();
    const { em, flushed } = entityManager({
      workflow: storedWorkflow('ready'),
      connector: existing,
    });
    const store = new MySqlPipelineStore(em);

    await store.publishWorkflow('w1', 'ana');

    // Found by `workflowId`, so a re-publish keeps the id every run, watermark
    // and mutex key hangs off. Minting a second row here would silently start a
    // fresh pipeline beside the old one, with both on the same cron.
    expect(flushed.filter((row) => row.workflowId === 'w1')).toHaveLength(1);
    expect(flushed.some((row) => row.id === existing.id)).toBe(true);
  });
});

describe('MySqlPipelineStore.unpublishWorkflow: cascades, but only as far as disabling', () => {
  /**
   * This used to refuse while a connector still ran the graph. It cannot any
   * more and the reason is structural rather than a loosening: a published graph
   * now runs as exactly one connector, its own, so the old check would refuse
   * every unpublish there is — and "point those connectors elsewhere first" is
   * advice about a route that no longer exists.
   */
  it('takes the graph back to draft and disables what it ran as', async () => {
    const { em, updates } = entityManager({
      workflow: storedWorkflow('ready'),
      usingConnectors: [usingConnector()],
    });
    const store = new MySqlPipelineStore(em);

    expect((await store.unpublishWorkflow('w1', 'ana')).status).toBe('draft');
    expect(updates).toEqual([{ where: { workflowId: 'w1' }, data: { enabled: false } }]);
  });

  it('disables rather than deletes, so re-publishing resumes the same pipeline', async () => {
    const { em, updates } = entityManager({
      workflow: storedWorkflow('ready'),
      usingConnectors: [usingConnector()],
    });
    const store = new MySqlPipelineStore(em);

    await store.unpublishWorkflow('w1', 'ana');

    // The id, the run history and the watermark all survive an unpublish. A
    // delete here would make parking a graph for an afternoon cost its history.
    expect(updates.every((update) => update.data.enabled === false)).toBe(true);
    expect(updates.some((update) => 'id' in update.where)).toBe(false);
  });
});

describe('MySqlPipelineStore.saveConnector: a draft is refused at save', () => {
  it('refuses a connector pointing at a draft workflow', async () => {
    // The decision under test: the error reaches whoever wired it, rather than a
    // scheduled run at 3am.
    const { em, flushed } = entityManager({ workflow: storedWorkflow('draft') });
    const store = new MySqlPipelineStore(em);

    await expect(
      store.saveConnector(
        {
          name: 'Nightly',
          kind: 'sql',
          targetType: 'Subwo',
          config: {},
          workflowId: 'w1',
          mode: 'full',
          state: {},
          enabled: true,
        },
        'ana',
      ),
    ).rejects.toThrow(/still a draft/);
    expect(flushed).toHaveLength(0);
  });

  it('accepts one pointing at a published workflow', async () => {
    const { em, flushed } = entityManager({ workflow: storedWorkflow('ready') });
    const store = new MySqlPipelineStore(em);

    await store.saveConnector(
      {
        name: 'Nightly',
        kind: 'sql',
        targetType: 'Subwo',
        config: {},
        workflowId: 'w1',
        mode: 'full',
        state: {},
        enabled: true,
      },
      'ana',
    );

    expect(flushed).toHaveLength(1);
  });
});
