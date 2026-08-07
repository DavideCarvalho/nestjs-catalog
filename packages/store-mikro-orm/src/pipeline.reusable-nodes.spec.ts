import type { ReusableNodeBody } from '@dudousxd/nestjs-catalog';
import type { EntityManager } from '@mikro-orm/mysql';
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ReusableNodeRow, TransformRow, WorkflowRow } from './entities/pipeline';
import { RevisionRow, revisionKey } from './entities/workspace';
import { MySqlPipelineStore } from './pipeline.store';

/**
 * Reusable nodes: what a save does to the version, what a graph that references
 * one is refused for, and how the usage count is arrived at.
 *
 * Kept out of `*.db.spec.ts` for the reason the draft spec next door gives:
 * every rule here is a decision reached before or around a statement rather than
 * a property of MySQL, so booting a container to prove them would make checks
 * that run on every save depend on Docker. Only the calls these methods actually
 * make are answered — a stub inventing a row for a query they do not run would
 * be asserting against fiction.
 */

interface Rows {
  reusable?: ReusableNodeRow | null;
  reusableByName?: ReusableNodeRow | null;
  revision?: RevisionRow | null;
  transform?: TransformRow | null;
  workflows?: WorkflowRow[];
}

function entityManager(rows: Rows): {
  em: EntityManager;
  flushed: Array<Record<string, unknown>>;
} {
  const flushed: Array<Record<string, unknown>> = [];
  let pending: Array<Record<string, unknown>> = [];

  const fake = {
    fork: () => fake,
    findOne: (entity: unknown, where: Record<string, unknown>) => {
      if (entity === ReusableNodeRow) {
        // The two lookups `saveReusableNode` makes are told apart by what they
        // ask on, which is also the difference that matters: one is "am I
        // editing something" and the other is "is this name taken".
        return Promise.resolve(
          'name' in where ? (rows.reusableByName ?? null) : (rows.reusable ?? null),
        );
      }
      if (entity === RevisionRow) return Promise.resolve(rows.revision ?? null);
      if (entity === TransformRow) return Promise.resolve(rows.transform ?? null);
      throw new Error('These tests exercise no other entity.');
    },
    find: (entity: unknown) => {
      if (entity === WorkflowRow) return Promise.resolve(rows.workflows ?? []);
      if (entity === ReusableNodeRow) return Promise.resolve(rows.reusable ? [rows.reusable] : []);
      if (entity === RevisionRow) return Promise.resolve(rows.revision ? [rows.revision] : []);
      throw new Error('These tests find no other entity.');
    },
    create: (_entity: unknown, data: Record<string, unknown>) => ({ ...data }),
    nativeDelete: () => Promise.resolve(1),
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
  return { em: Object.assign(Object.create(null), fake), flushed };
}

function store(rows: Rows): MySqlPipelineStore {
  const { em } = entityManager(rows);
  return new MySqlPipelineStore(em);
}

function reusableRow(overrides: Partial<ReusableNodeRow> = {}): ReusableNodeRow {
  const row = new ReusableNodeRow();
  row.id = 'lib-1';
  row.name = 'flip db sink';
  row.kind = 'sink';
  row.body = { kind: 'sink', targetType: 'Mvr', mode: 'full' };
  row.version = 1;
  row.createdBy = 'ana';
  row.createdAt = new Date('2026-01-01T00:00:00.000Z');
  row.updatedAt = new Date('2026-01-01T00:00:00.000Z');
  return Object.assign(row, overrides);
}

function workflowRow(nodes: unknown[], overrides: Partial<WorkflowRow> = {}): WorkflowRow {
  const row = new WorkflowRow();
  row.id = 'wf-1';
  row.name = 'Nightly MVR';
  row.nodes = nodes;
  row.edges = [];
  row.status = 'ready';
  row.version = 1;
  row.graphHash = 'abc';
  row.targetType = 'Mvr';
  row.enabled = true;
  row.createdBy = 'ana';
  row.createdAt = new Date();
  row.updatedAt = new Date();
  return Object.assign(row, overrides);
}

describe('saving a reusable node', () => {
  it('creates one at version 1 and archives its body', async () => {
    const { em, flushed } = entityManager({});

    const saved = await new MySqlPipelineStore(em).saveReusableNode(
      { name: 'flip db sink', body: { kind: 'sink', targetType: 'Mvr', mode: 'full' } },
      'ana',
    );

    expect(saved.version).toBe(1);
    expect(saved.kind).toBe('sink');
    const revision = flushed.find((row) => row instanceof RevisionRow || 'subjectKind' in row);
    expect(revision).toMatchObject({ subjectKind: 'reusable-node', version: 1 });
  });

  it('does NOT bump the version when only the name changed', async () => {
    // The rule a pin depends on. A version inflated by renames is a version
    // nothing can usefully pin to, and this is the same rule `saveTransform`
    // follows for code.
    const existing = reusableRow();
    const { em } = entityManager({ reusable: existing });

    const saved = await new MySqlPipelineStore(em).saveReusableNode(
      {
        id: 'lib-1',
        name: 'flip Mvr sink',
        body: { kind: 'sink', targetType: 'Mvr', mode: 'full' },
      },
      'bea',
    );

    expect(saved.version).toBe(1);
    expect(saved.name).toBe('flip Mvr sink');
  });

  it('bumps the version when the body changed, and does not when only key order did', async () => {
    const { em } = entityManager({ reusable: reusableRow() });
    const changed = await new MySqlPipelineStore(em).saveReusableNode(
      { id: 'lib-1', name: 'flip db sink', body: { kind: 'sink', targetType: 'Mvr' } },
      'bea',
    );
    expect(changed.version).toBe(2);

    const { em: same } = entityManager({ reusable: reusableRow() });
    const unchanged = await new MySqlPipelineStore(same).saveReusableNode(
      // The same body with its keys written the other way round, which is what a
      // console that rebuilt the object sends. A version bumped for that would
      // move under every graph that pinned it, for no reason anybody authored.
      {
        id: 'lib-1',
        name: 'flip db sink',
        body: { mode: 'full', targetType: 'Mvr', kind: 'sink' },
      },
      'bea',
    );
    expect(unchanged.version).toBe(1);
  });

  it('refuses a name another reusable node already holds, naming it', async () => {
    const taken = reusableRow({ id: 'lib-other' });

    await expect(
      store({ reusableByName: taken }).saveReusableNode(
        { name: 'flip db sink', body: { kind: 'sink', targetType: 'Mvr' } },
        'ana',
      ),
    ).rejects.toThrow(/already a reusable node called "flip db sink" \(lib-other\)/);
  });

  it('refuses a body this build cannot execute', async () => {
    // Parsed rather than written inline and asserted past the type, which is
    // also how it would actually arrive: this refusal exists for a payload that
    // came over HTTP or a row written by a different version of the package, and
    // both are `JSON.parse` of something. A filter is not a reusable kind, so
    // there is no body shape for it and there never was one.
    const unreadable: ReusableNodeBody = JSON.parse('{"kind":"filter","predicate":{}}');

    await expect(
      store({}).saveReusableNode({ name: 'anything', body: unreadable }, 'ana'),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('reading a body at one version', () => {
  it('answers the current row when the version is the current one', async () => {
    const held = await store({ reusable: reusableRow({ version: 4 }) }).getReusableNodeAt(
      'lib-1',
      4,
    );

    expect(held?.version).toBe(4);
    expect(held?.body).toMatchObject({ kind: 'sink', targetType: 'Mvr' });
  });

  it('answers the archive for an older version', async () => {
    const revision = new RevisionRow();
    revision.id = revisionKey('reusable-node', 'lib-1', 2);
    revision.subjectKind = 'reusable-node';
    revision.subjectId = 'lib-1';
    revision.version = 2;
    revision.body = JSON.stringify({ kind: 'sink', targetType: 'Mvr', mode: 'incremental' });
    revision.authoredBy = 'ana';
    revision.authoredAt = new Date();

    const held = await store({ reusable: reusableRow({ version: 5 }), revision }).getReusableNodeAt(
      'lib-1',
      2,
    );

    expect(held?.version).toBe(2);
    expect(held?.body).toMatchObject({ mode: 'incremental' });
  });

  it('answers nothing for a version the archive can no longer produce', async () => {
    // `undefined`, and never a fall-back to the latest. The runner turns this
    // into a failed node, which is the whole contract of a pin.
    const held = await store({
      reusable: reusableRow({ version: 60 }),
      revision: null,
    }).getReusableNodeAt('lib-1', 2);

    expect(held).toBeUndefined();
  });
});

describe('counting the places a reusable node is used', () => {
  const referencing = workflowRow([
    { id: 'src', name: 'Warehouse', kind: 'source', sourceKind: 'sql', config: {}, useId: 'lib-1' },
    { id: 'sink', name: 'Mvr', kind: 'sink', targetType: 'Mvr', useId: 'lib-1', useVersion: 2 },
    { id: 'other', name: 'Other', kind: 'sink', targetType: 'Subwo', useId: 'lib-2' },
  ]);

  it('reports one entry per node, not one per graph', async () => {
    // Deliberately unlike `connections/:id/workflows`, which reports a graph
    // once because deleting a connection breaks it once. Whoever reads this is
    // about to edit a body, and three nodes in one graph are three places it
    // lands.
    const uses = await store({ workflows: [referencing] }).reusableNodeUses('lib-1');

    expect(uses).toHaveLength(2);
    expect(uses.map((use) => use.nodeId)).toEqual(['src', 'sink']);
    expect(uses[0]).toMatchObject({ workflowId: 'wf-1', workflowName: 'Nightly MVR' });
  });

  it('says which of them are pinned, which is what makes the count a decision', async () => {
    const uses = await store({ workflows: [referencing] }).reusableNodeUses('lib-1');

    expect(uses[0]?.pinnedVersion).toBeUndefined();
    expect(uses[1]?.pinnedVersion).toBe(2);
  });

  it('counts nothing for a body nobody references', async () => {
    expect(await store({ workflows: [referencing] }).reusableNodeUses('lib-9')).toEqual([]);
  });

  it('refuses to delete one while a graph still uses it, naming the graph', async () => {
    await expect(store({ workflows: [referencing] }).deleteReusableNode('lib-1')).rejects.toThrow(
      /"Nightly MVR" \(node "Warehouse"\)/,
    );
  });

  it('deletes one nothing references', async () => {
    expect(await store({ workflows: [referencing] }).deleteReusableNode('lib-9')).toBe(true);
  });
});

describe('saving a graph that references a reusable node', () => {
  const node = {
    id: 'sink',
    name: 'Commit',
    kind: 'sink' as const,
    targetType: 'Mvr',
    useId: 'lib-1',
  };

  it('refuses one whose reusable node does not exist', async () => {
    await expect(
      store({ reusable: null }).saveWorkflow({ name: 'Nightly', nodes: [node], edges: [] }, 'ana'),
    ).rejects.toThrow(/uses reusable node lib-1, which does not exist/);
  });

  it('refuses a pin the archive can no longer produce', async () => {
    await expect(
      store({ reusable: reusableRow({ version: 9 }), revision: null }).saveWorkflow(
        { name: 'Nightly', nodes: [{ ...node, useVersion: 2 }], edges: [] },
        'ana',
      ),
    ).rejects.toThrow(/pinned to v2 of reusable node "flip db sink"/);
  });

  it('refuses a body whose target type has moved away from the graph’s', async () => {
    // The grant hole, closed. The graph was checked against `Mvr`; a shared sink
    // that could repoint it would load into a type nobody here was granted.
    await expect(
      store({
        reusable: reusableRow({ body: { kind: 'sink', targetType: 'Subwo' } }),
      }).saveWorkflow({ name: 'Nightly', nodes: [node], edges: [] }, 'ana'),
    ).rejects.toThrow(/commits Mvr, and the reusable node it uses now commits Subwo/);
  });
});
