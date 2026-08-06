import type { EntityManager } from '@mikro-orm/mysql';
import { describe, expect, it } from 'vitest';
import { ConnectorRow, TransformRow, WorkflowRow } from './entities/pipeline';
import { MySqlPipelineStore } from './pipeline.store';

/**
 * That removing the ability to author a connector does not orphan the ones that
 * already exist.
 *
 * A dev deployment has thirteen connectors and twelve serve real data. They were
 * created through `POST connectors`, which is gone — so without this they would
 * be running loads with no screen, no route and no way to change them. "They
 * still run, you just cannot touch them" is orphaning them with extra steps.
 *
 * The chosen outcome is **migration**: each is wrapped into the graph it always
 * was — one source, optionally one transform, one sink — because that shape was
 * already exactly representable and nothing has to be invented. What these tests
 * pin is the part that would be silently wrong if it broke, because every one of
 * these is invisible at a glance and expensive later:
 *
 * - the connector **id** survives, so the run history, the singleton mutex key
 *   and the watermark stay attached to the same pipeline;
 * - the watermark is **re-keyed** under the new source node, so the first run
 *   after an upgrade does not re-read an incremental source from the beginning;
 * - `transformId` is **cleared**, because it is a node now and leaving it would
 *   be a second answer to what shapes this data;
 * - the schedule moves to the graph, which is where it is read from;
 * - and it is **idempotent**, which is what makes it safe to run at every boot.
 *
 * Kept out of `*.db.spec.ts` for the reason the neighbouring store specs give:
 * what is under test is which rows this method writes and what it puts in them,
 * and booting MySQL to see that would make a boot-time migration depend on
 * Docker.
 */
function entityManager(rows: {
  connector?: ConnectorRow;
  transform?: TransformRow;
}): {
  em: EntityManager;
  flushed: Array<Record<string, unknown>>;
  updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>;
} {
  const flushed: Array<Record<string, unknown>> = [];
  const updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  let pending: Array<Record<string, unknown>> = [];
  // Whatever `saveWorkflow` created, so `publishWorkflow` and the re-point can
  // find it afterwards — the ordering this method depends on is exactly what a
  // stub answering `null` forever would hide.
  let workflow: WorkflowRow | undefined;

  const fake = {
    fork: () => fake,
    findOne: (entity: unknown) => {
      if (entity === WorkflowRow) return Promise.resolve(workflow ?? null);
      if (entity === ConnectorRow) return Promise.resolve(rows.connector ?? null);
      if (entity === TransformRow) return Promise.resolve(rows.transform ?? null);
      throw new Error('These tests exercise no other entity.');
    },
    find: (entity: unknown) => {
      if (entity === TransformRow) return Promise.resolve(rows.transform ? [rows.transform] : []);
      if (entity === ConnectorRow) return Promise.resolve(rows.connector ? [rows.connector] : []);
      throw new Error('These tests find no other entity.');
    },
    create: (entity: unknown, data: Record<string, unknown>) => {
      const created = { ...data };
      if (entity === WorkflowRow) workflow = created as unknown as WorkflowRow;
      return created;
    },
    persist: (row: Record<string, unknown>) => {
      pending.push(row);
    },
    nativeUpdate: (
      _entity: unknown,
      where: Record<string, unknown>,
      data: Record<string, unknown>,
    ) => {
      updates.push({ where, data });
      return Promise.resolve(1);
    },
    flush: () => {
      flushed.push(...pending);
      pending = [];
      return Promise.resolve();
    },
  };

  return { em: Object.assign(Object.create(null), fake), flushed, updates };
}

function connectorRow(overrides: Partial<ConnectorRow> = {}): ConnectorRow {
  return Object.assign(new ConnectorRow(), {
    id: 'c1',
    name: 'Nightly Mvr',
    kind: 'sql',
    targetType: 'Mvr',
    config: { url: 'postgres://warehouse/db', query: 'SELECT * FROM vehicles' },
    secretEnvVar: 'WAREHOUSE_PASSWORD',
    mode: 'full',
    state: {},
    enabled: true,
    createdBy: 'ana',
    createdAt: new Date('2020-01-01T00:00:00.000Z'),
    updatedAt: new Date('2020-01-01T00:00:00.000Z'),
    ...overrides,
  });
}

describe('MySqlPipelineStore.adoptConnector: the upgrade path', () => {
  it('wraps a plain connector into a source and a sink, and publishes it', async () => {
    const { em } = entityManager({ connector: connectorRow() });
    const store = new MySqlPipelineStore(em);

    const result = await store.adoptConnector('c1', 'adoption');

    expect(result?.workflow.status).toBe('ready');
    expect(result?.workflow.targetType).toBe('Mvr');
    expect(result?.workflow.nodes.map((node) => node.kind)).toEqual(['source', 'sink']);
    expect(result?.workflow.edges).toEqual([{ from: 'source', to: 'sink' }]);
  });

  it('carries the source configuration across rather than inventing one', async () => {
    const { em } = entityManager({ connector: connectorRow() });
    const store = new MySqlPipelineStore(em);

    const result = await store.adoptConnector('c1', 'adoption');
    const source = result?.workflow.nodes.find((node) => node.kind === 'source');

    expect(source).toMatchObject({
      sourceKind: 'sql',
      config: { url: 'postgres://warehouse/db', query: 'SELECT * FROM vehicles' },
      secretEnvVar: 'WAREHOUSE_PASSWORD',
    });
  });

  it('puts a connector transform in the middle, as a node', async () => {
    const transform = Object.assign(new TransformRow(), { id: 't1', name: 'Shape' });
    const { em } = entityManager({
      connector: connectorRow({ transformId: 't1' }),
      transform,
    });
    const store = new MySqlPipelineStore(em);

    const result = await store.adoptConnector('c1', 'adoption');

    expect(result?.workflow.nodes.map((node) => node.kind)).toEqual([
      'source',
      'transform',
      'sink',
    ]);
    expect(result?.workflow.edges).toEqual([
      { from: 'source', to: 'transform' },
      { from: 'transform', to: 'sink' },
    ]);
  });

  /**
   * The one that matters most, and the one with no symptom if it breaks.
   *
   * The id is the singleton mutex key, the owner of every `ConnectorRun` and the
   * holder of the watermark. Minting a fresh connector and leaving the old one
   * would split one pipeline's history in two — with nothing serialising the
   * halves against each other, so both could load the same type at once.
   */
  it('keeps the connector id, so the history and the mutex key survive', async () => {
    const row = connectorRow({ id: 'the-original' });
    const { em } = entityManager({ connector: row });
    const store = new MySqlPipelineStore(em);

    const result = await store.adoptConnector('the-original', 'adoption');

    expect(result?.connector.id).toBe('the-original');
    expect(row.workflowId).toBe(result?.workflow.id);
  });

  /**
   * A plain connector kept a flat `state`; a graph keys it by source-node id.
   * Carried across unchanged, the new source node would have no watermark at all
   * and the first run after the upgrade would re-read from the beginning — not
   * data loss, but hours of surprise on a large source.
   */
  it('re-keys the watermark under the source node it just created', async () => {
    const row = connectorRow({ state: { committed: { since: '2026-01-01' } } });
    const { em } = entityManager({ connector: row });
    const store = new MySqlPipelineStore(em);

    await store.adoptConnector('c1', 'adoption');

    expect(row.state).toEqual({ source: { committed: { committed: { since: '2026-01-01' } } } });
  });

  it('leaves an empty state empty rather than inventing a watermark', async () => {
    const row = connectorRow({ state: {} });
    const { em } = entityManager({ connector: row });
    const store = new MySqlPipelineStore(em);

    await store.adoptConnector('c1', 'adoption');

    expect(row.state).toEqual({});
  });

  it('clears transformId, so nothing carries two answers to what shapes the data', async () => {
    const transform = Object.assign(new TransformRow(), { id: 't1', name: 'Shape' });
    const row = connectorRow({ transformId: 't1' });
    const { em } = entityManager({ connector: row, transform });
    const store = new MySqlPipelineStore(em);

    await store.adoptConnector('c1', 'adoption');

    // Left set, this would trip the both-transform-and-workflow refusal on the
    // next `saveConnector` — and would be the ambiguity that refusal exists for.
    expect(row.transformId).toBeUndefined();
  });

  it('moves the schedule onto the graph, which is where it is read from now', async () => {
    const { em } = entityManager({ connector: connectorRow({ schedule: '0 3 * * *' }) });
    const store = new MySqlPipelineStore(em);

    const result = await store.adoptConnector('c1', 'adoption');

    expect(result?.workflow.schedule).toBe('0 3 * * *');
  });

  it('carries a disabled connector across as a disabled graph', async () => {
    const { em } = entityManager({ connector: connectorRow({ enabled: false }) });
    const store = new MySqlPipelineStore(em);

    const result = await store.adoptConnector('c1', 'adoption');

    // Adoption must not switch a load back on. Somebody turned this off.
    expect(result?.workflow.enabled).toBe(false);
  });

  /**
   * Idempotence is what makes running this at every boot safe rather than
   * merely tolerable. Without it, the second boot wraps an already-wrapped
   * connector into a second graph and the deployment gains one orphan per
   * restart.
   */
  it('leaves a connector that already runs a graph completely alone', async () => {
    const { em, flushed } = entityManager({
      connector: connectorRow({ workflowId: 'already-wrapped' }),
    });
    const store = new MySqlPipelineStore(em);

    expect(await store.adoptConnector('c1', 'adoption')).toBeUndefined();
    expect(flushed).toEqual([]);
  });

  /**
   * Adoption publishes as `ready` without a person having declared the graph
   * finished — which is the right trade against an upgrade that silently stops
   * twelve loads, but only because the wrap is validated first.
   *
   * Refusing leaves the connector exactly as it was, still running. Adoption
   * never leaves a pipeline in a worse state than it found it, so the failure
   * mode is "this one could not be wrapped, and it is still loading" rather than
   * a graph in `ready` that nobody could have drawn.
   */
  it('refuses to publish a wrap that does not validate, and changes nothing', async () => {
    const row = connectorRow({ targetType: '' });
    const { em, flushed } = entityManager({ connector: row });
    const store = new MySqlPipelineStore(em);

    await expect(store.adoptConnector('c1', 'adoption')).rejects.toThrow(/cannot be wrapped/);
    expect(flushed).toEqual([]);
    expect(row.workflowId).toBeUndefined();
  });

  it('answers undefined for a connector that is not there, rather than throwing', async () => {
    const { em } = entityManager({});
    const store = new MySqlPipelineStore(em);

    expect(await store.adoptConnector('gone', 'adoption')).toBeUndefined();
  });
});
