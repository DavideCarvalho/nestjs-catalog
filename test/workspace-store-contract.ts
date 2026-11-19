import {
  CATALOG_REVISION_LIMIT,
  type CatalogOverlay,
  type CatalogOverlayStore,
  type CatalogWorkspaceStore,
  supportsSavedQueryBatch,
  supportsSavedQueryRevisions,
} from '@dudousxd/nestjs-catalog';
import { describe, expect, it } from 'vitest';

/**
 * One contract for every `CatalogWorkspaceStore`: saved queries, dashboards,
 * their revisions and the audit trail.
 *
 * Written once and run against each store, for the reason
 * `catalog-store-contract.ts` gives about warehouse stores: the failures that
 * matter are the ones where two stores behind one interface disagree, and a
 * suite that looks at one store cannot see those. Every case runs against a
 * real database.
 *
 * Each case names its own rows (a unique prefix per run) and never assumes the
 * tables start empty, so the suite can share a database with other suites.
 */
export interface WorkspaceContractStore {
  readonly name: string;
  readonly store: CatalogWorkspaceStore;
}

let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${process.pid}-${Date.now().toString(36)}-${counter}`;
}

export function describeWorkspaceStoreContract(boot: () => WorkspaceContractStore): void {
  describe('saved queries', () => {
    it('saves a query and reads it back with every field', async () => {
      const { store } = boot();
      const name = unique('q');
      const saved = await store.saveQuery(
        {
          name,
          sql: 'SELECT 1',
          description: 'one',
          folder: 'reports',
          cacheTtlSeconds: 30,
          shared: true,
          visualization: { kind: 'bar', labelColumn: 'a', valueColumns: ['b'], library: 'x' },
        },
        'alice',
      );
      expect(saved).toMatchObject({
        name,
        sql: 'SELECT 1',
        description: 'one',
        folder: 'reports',
        createdBy: 'alice',
        cacheTtlSeconds: 30,
        shared: true,
        visualization: { kind: 'bar', labelColumn: 'a', valueColumns: ['b'], library: 'x' },
      });
      expect(Number.isNaN(Date.parse(saved.createdAt))).toBe(false);
      expect(await store.getSavedQuery(saved.id)).toEqual(saved);
    });

    it('defaults what the input leaves out', async () => {
      const { store } = boot();
      const saved = await store.saveQuery({ name: unique('q'), sql: 'SELECT 2' }, 'bob');
      expect(saved.cacheTtlSeconds).toBe(0);
      expect(saved.shared).toBe(false);
      expect(saved.visualization.kind).toBe('table');
      expect(saved.description ?? undefined).toBeUndefined();
      expect(saved.folder ?? undefined).toBeUndefined();
    });

    it('answers undefined for an id that names nothing', async () => {
      const { store } = boot();
      expect(await store.getSavedQuery(unique('missing'))).toBeUndefined();
      expect(await store.updateSavedQuery(unique('missing'), { name: 'x' })).toBeUndefined();
      expect(await store.deleteSavedQuery(unique('missing'))).toBe(false);
    });

    it('lists by folder, then name, and the summaries in the same order', async () => {
      const { store } = boot();
      const folder = unique('folder');
      const b = await store.saveQuery({ name: 'b', sql: 'SELECT 1', folder }, 'a');
      const a = await store.saveQuery({ name: 'a', sql: 'SELECT 1', folder }, 'a');
      const listed = (await store.listSavedQueries()).filter((q) => q.folder === folder);
      expect(listed.map((q) => q.id)).toEqual([a.id, b.id]);

      if (store.listSavedQuerySummaries) {
        const summaries = (await store.listSavedQuerySummaries()).filter(
          (q) => q.folder === folder,
        );
        expect(summaries.map((q) => q.id)).toEqual([a.id, b.id]);
        expect(Object.keys(summaries[0] ?? {}).sort()).toEqual(
          expect.arrayContaining(['id', 'name']),
        );
        expect(summaries[0]).not.toHaveProperty('sql');
      }
    });

    it('reads several by id in one call, and none for no ids', async () => {
      const { store } = boot();
      if (!supportsSavedQueryBatch(store)) return;
      const one = await store.saveQuery({ name: unique('q'), sql: 'SELECT 1' }, 'a');
      const two = await store.saveQuery({ name: unique('q'), sql: 'SELECT 2' }, 'a');
      const found = await store.getSavedQueries([one.id, two.id, unique('missing')]);
      expect(found.map((q) => q.id).sort()).toEqual([one.id, two.id].sort());
      expect(await store.getSavedQueries([])).toEqual([]);
    });

    it('deletes a query', async () => {
      const { store } = boot();
      const saved = await store.saveQuery({ name: unique('q'), sql: 'SELECT 1' }, 'a');
      expect(await store.deleteSavedQuery(saved.id)).toBe(true);
      expect(await store.getSavedQuery(saved.id)).toBeUndefined();
    });

    it('normalises a stored visualization it does not recognise to a table', async () => {
      const { store } = boot();
      const saved = await store.saveQuery(
        {
          name: unique('q'),
          sql: 'SELECT 1',
          visualization: { kind: 'pie' as 'table', valueColumns: ['a', 3 as unknown as string] },
        },
        'a',
      );
      const read = await store.getSavedQuery(saved.id);
      expect(read?.visualization.kind).toBe('table');
      expect(read?.visualization.valueColumns).toEqual(['a']);
    });
  });

  describe('saved query revisions', () => {
    it('records the first statement as version 1, keyed by subject and version', async () => {
      const { store } = boot();
      if (!supportsSavedQueryRevisions(store)) return;
      const saved = await store.saveQuery({ name: unique('q'), sql: 'SELECT 1' }, 'alice');
      const revisions = await store.listSavedQueryRevisions(saved.id);
      expect(revisions).toHaveLength(1);
      expect(revisions[0]).toMatchObject({
        id: `saved-query:${saved.id}:1`,
        subjectId: saved.id,
        version: 1,
        body: 'SELECT 1',
        authoredBy: 'alice',
      });
    });

    it('bumps the version and archives the old SQL only when the SQL changes', async () => {
      const { store } = boot();
      if (!supportsSavedQueryRevisions(store)) return;
      const saved = await store.saveQuery({ name: unique('q'), sql: 'SELECT 1' }, 'alice');

      await store.updateSavedQuery(saved.id, { name: unique('renamed'), cacheTtlSeconds: 5 });
      expect((await store.listSavedQueryRevisions(saved.id)).map((r) => r.version)).toEqual([1]);

      await store.updateSavedQuery(saved.id, { sql: 'SELECT 1' });
      expect((await store.listSavedQueryRevisions(saved.id)).map((r) => r.version)).toEqual([1]);

      const updated = await store.updateSavedQuery(saved.id, { sql: 'SELECT 2' });
      expect(updated?.sql).toBe('SELECT 2');
      expect(updated?.cacheTtlSeconds).toBe(5);
      const revisions = await store.listSavedQueryRevisions(saved.id);
      expect(revisions.map((r) => [r.version, r.body])).toEqual([
        [2, 'SELECT 2'],
        [1, 'SELECT 1'],
      ]);
      expect(revisions.every((r) => r.authoredBy === 'alice')).toBe(true);
    });

    it(`keeps the newest ${CATALOG_REVISION_LIMIT} revisions of a query`, async () => {
      const { store } = boot();
      if (!supportsSavedQueryRevisions(store)) return;
      const saved = await store.saveQuery({ name: unique('q'), sql: 'SELECT 0' }, 'a');
      for (let i = 1; i <= CATALOG_REVISION_LIMIT + 2; i += 1) {
        await store.updateSavedQuery(saved.id, { sql: `SELECT ${i}` });
      }
      const revisions = await store.listSavedQueryRevisions(saved.id);
      expect(revisions).toHaveLength(CATALOG_REVISION_LIMIT);
      expect(revisions[0]?.version).toBe(CATALOG_REVISION_LIMIT + 3);
      expect(revisions.at(-1)?.version).toBe(4);
    });

    it('answers an empty history for an id that names nothing', async () => {
      const { store } = boot();
      if (!supportsSavedQueryRevisions(store)) return;
      expect(await store.listSavedQueryRevisions(unique('missing'))).toEqual([]);
    });
  });

  describe('dashboards', () => {
    it('saves, reads, updates and deletes a dashboard, cards included', async () => {
      const { store } = boot();
      const name = unique('d');
      const saved = await store.saveDashboard(
        {
          name,
          description: 'desc',
          shared: true,
          cards: [
            { id: 'c1', savedQueryId: 'q1', width: 3, position: 0, title: 'T', library: 'lib' },
          ],
        },
        'alice',
      );
      expect(saved).toMatchObject({ name, description: 'desc', shared: true, createdBy: 'alice' });
      expect(saved.cards).toEqual([
        { id: 'c1', savedQueryId: 'q1', width: 3, position: 0, title: 'T', library: 'lib' },
      ]);
      expect(await store.getDashboard(saved.id)).toEqual(saved);

      const updated = await store.updateDashboard(saved.id, {
        cards: [{ id: 'c2', savedQueryId: 'q2', width: 9 as 1, position: 4 }],
      });
      expect(updated?.name).toBe(name);
      expect(updated?.cards).toMatchObject([
        { id: 'c2', savedQueryId: 'q2', width: 2, position: 4 },
      ]);

      expect(await store.deleteDashboard(saved.id)).toBe(true);
      expect(await store.getDashboard(saved.id)).toBeUndefined();
      expect(await store.deleteDashboard(saved.id)).toBe(false);
      expect(await store.updateDashboard(saved.id, { name: 'x' })).toBeUndefined();
    });

    it('lists dashboards by name, and the summaries without cards', async () => {
      const { store } = boot();
      const tag = unique('d');
      const z = await store.saveDashboard({ name: `${tag}-z` }, 'a');
      const a = await store.saveDashboard({ name: `${tag}-a` }, 'a');
      const listed = (await store.listDashboards()).filter((d) => d.name.startsWith(tag));
      expect(listed.map((d) => d.id)).toEqual([a.id, z.id]);
      if (store.listDashboardSummaries) {
        const summaries = (await store.listDashboardSummaries()).filter((d) =>
          d.name.startsWith(tag),
        );
        expect(summaries.map((d) => d.id)).toEqual([a.id, z.id]);
        expect(summaries[0]).not.toHaveProperty('cards');
      }
    });
  });

  describe('audit events', () => {
    it('records events and lists them newest first, filtered', async () => {
      const { store } = boot();
      const typeName = unique('type');
      const base = Date.parse('2026-01-01T00:00:00.000Z');
      for (let i = 0; i < 3; i += 1) {
        await store.recordEvent({
          event: i === 2 ? 'type.curated' : 'snapshot.committed',
          typeName,
          principalId: 'p1',
          snapshotId: `s${i}`,
          detail: { i },
          occurredAt: new Date(base + i * 5).toISOString(),
        });
      }
      const all = await store.listEvents({ typeName });
      expect(all.map((e) => e.detail.i)).toEqual([2, 1, 0]);
      expect(all[0]?.occurredAt).toBe(new Date(base + 10).toISOString());

      const committed = await store.listEvents({ typeName, event: 'snapshot.committed' });
      expect(committed.map((e) => e.snapshotId)).toEqual(['s1', 's0']);

      const since = await store.listEvents({ typeName, since: new Date(base + 5).toISOString() });
      expect(since).toHaveLength(2);

      expect(await store.listEvents({ typeName, limit: 1 })).toHaveLength(1);
      expect(await store.listEvents({ typeName, limit: 0 })).toHaveLength(1);
    });

    it('never throws when an event cannot be stored', async () => {
      const { store } = boot();
      await expect(
        store.recordEvent({
          event: 'x'.repeat(10_000),
          detail: {},
          occurredAt: new Date().toISOString(),
        }),
      ).resolves.toBeUndefined();
    });
  });
}

/** One contract for every `CatalogOverlayStore` that persists. */
export function describeOverlayStoreContract(boot: () => CatalogOverlayStore): void {
  describe('overlay', () => {
    it('saves an overlay and loads it back', async () => {
      const store = boot();
      const overlay: CatalogOverlay = {
        types: { order: { displayName: 'Order', properties: { id: { hidden: true } } } },
      };
      await store.save(overlay);
      expect(await store.load()).toEqual(overlay);
    });

    it('hands out copies at both ends', async () => {
      const store = boot();
      const overlay: CatalogOverlay = { types: { a: { displayName: 'A' } } };
      await store.save(overlay);
      const entry = overlay.types.a;
      if (entry) entry.displayName = 'changed after save';
      const loaded = await store.load();
      expect(loaded.types.a?.displayName).toBe('A');
      const loadedEntry = loaded.types.a;
      if (loadedEntry) loadedEntry.displayName = 'changed after load';
      expect((await store.load()).types.a?.displayName).toBe('A');
    });

    it('replaces the overlay on every save', async () => {
      const store = boot();
      await store.save({ types: { a: { displayName: 'A' } } });
      await store.save({ types: { b: { displayName: 'B' } } });
      expect(await store.load()).toEqual({ types: { b: { displayName: 'B' } } });
    });
  });
}
