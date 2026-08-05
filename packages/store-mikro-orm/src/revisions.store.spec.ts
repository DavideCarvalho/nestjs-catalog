import { CATALOG_REVISION_LIMIT } from '@dudousxd/nestjs-catalog';
import type { EntityManager } from '@mikro-orm/mysql';
import { describe, expect, it } from 'vitest';
import { TransformRow } from './entities/pipeline';
import { RevisionRow, SavedQueryRow, revisionKey } from './entities/workspace';
import { MySqlPipelineStore } from './pipeline.store';
import { MySqlWorkspaceStore } from './workspace.store';

/**
 * That a version number names code somebody can still read.
 *
 * The defect this covers was quiet and expensive. `TransformRow` holds one row
 * per transform and overwrites it, bumping `version` when the code differs;
 * `ConnectorRunRow.transformVersion` records which version ran; the console
 * renders that as `code v3`. So an operator investigating a load was shown a
 * version number, read it as a reference to something retrievable, and every
 * version but the newest had been gone since the moment somebody pressed save.
 * A saved query had not even the number.
 *
 * The test that matters most is the first one below, and it is the whole feature
 * in six lines: a run recorded v2, the transform is now at v4, and v2 still
 * comes back with the code that produced those rows.
 *
 * ## Why a fake EntityManager and not testcontainers
 *
 * Everything under test here is a decision the store makes before or around a
 * statement — which versions get written, which get left alone, which get
 * dropped — and none of it is a MySQL behaviour. `*.db.spec.ts` boots a real
 * engine and is excluded from the default suite, so proving a rule that runs on
 * every save through one would make it depend on Docker. The fake answers only
 * the calls these methods actually make, and it models the revision table for
 * real — insert, ordered read, bounded read, delete-below-a-version — because a
 * stub that returned a fixed list would make the retention tests assert against
 * fiction.
 */

interface Tables {
  transforms: Map<string, TransformRow>;
  savedQueries: Map<string, SavedQueryRow>;
  revisions: Map<string, RevisionRow>;
}

function tables(): Tables {
  return { transforms: new Map(), savedQueries: new Map(), revisions: new Map() };
}

/** The `{ subjectKind, subjectId }` half of a revision query. */
function subjectOf(where: Record<string, unknown>): { kind: unknown; id: unknown } {
  return { kind: where.subjectKind, id: where.subjectId };
}

/** `{ version: { $lt: n } }`, which is the only operator the prune uses. */
function versionFloor(where: Record<string, unknown>): number | undefined {
  const version = where.version;
  if (typeof version !== 'object' || version === null) return undefined;
  const lt = Reflect.get(version, '$lt');
  return typeof lt === 'number' ? lt : undefined;
}

/** The prune's one delete: this subject's revisions below a version. */
function dropRevisions(store: Tables, where: Record<string, unknown>): number {
  const { kind, id } = subjectOf(where);
  const floor = versionFloor(where);
  let deleted = 0;
  for (const [key, row] of store.revisions) {
    if (row.subjectKind !== kind || row.subjectId !== id) continue;
    if (floor !== undefined && row.version >= floor) continue;
    store.revisions.delete(key);
    deleted += 1;
  }
  return deleted;
}

function entityManager(store: Tables): EntityManager {
  let pending: object[] = [];

  const fake = {
    fork: () => fake,

    findOne: (entity: unknown, where: Record<string, unknown>) => {
      const id = String(where.id);
      if (entity === TransformRow) return Promise.resolve(store.transforms.get(id) ?? null);
      if (entity === SavedQueryRow) return Promise.resolve(store.savedQueries.get(id) ?? null);
      if (entity === RevisionRow) return Promise.resolve(store.revisions.get(id) ?? null);
      throw new Error('These tests exercise no other entity.');
    },

    // Only revisions are ever listed by these paths, and only ever by subject,
    // newest first, bounded.
    find: (
      entity: unknown,
      where: Record<string, unknown>,
      options?: { limit?: number; orderBy?: { version?: string } },
    ): Promise<RevisionRow[]> => {
      if (entity !== RevisionRow) throw new Error('These tests find no other entity.');
      const { kind, id } = subjectOf(where);
      // The direction is read rather than assumed. Sorting descending whatever
      // was asked for would make "newest first" a property of this fake, and the
      // spec below would pass against a store that ordered the other way — which
      // is a promise the contract makes to a screen drawing a history.
      const descending = options?.orderBy?.version !== 'asc';
      const rows = [...store.revisions.values()]
        .filter((row) => row.subjectKind === kind && row.subjectId === id)
        .sort((left, right) =>
          descending ? right.version - left.version : left.version - right.version,
        );
      return Promise.resolve(options?.limit ? rows.slice(0, options.limit) : rows);
    },

    // `new entity()` rather than a spread, so what comes back is a real row with
    // real methods — `toRevision` reads `authoredAt.toISOString()` off one.
    create: (entity: new () => object, data: Record<string, unknown>) =>
      Object.assign(new entity(), data),

    persist: (row: object) => {
      pending.push(row);
    },

    flush: () => {
      for (const row of pending) {
        if (row instanceof RevisionRow) {
          // The primary key, modelled. A revision is only ever *created* — the
          // store never re-persists one it read back — so an insert onto an id
          // that is already there is the duplicate-key error MySQL would raise,
          // and swallowing it here would make "an already-recorded version is
          // left alone" a rule this fake could not tell had been dropped.
          if (store.revisions.has(row.id)) {
            throw new Error(`Duplicate entry '${row.id}' for key 'catalog_revision.PRIMARY'`);
          }
          store.revisions.set(row.id, row);
        }
        if (row instanceof TransformRow) store.transforms.set(row.id, row);
        if (row instanceof SavedQueryRow) store.savedQueries.set(row.id, row);
      }
      pending = [];
      return Promise.resolve();
    },

    nativeDelete: (entity: unknown, where: Record<string, unknown>) => {
      // `deleteTransform` reaches this too, and answering it is the point of one
      // of the tests below: what it must NOT take with it is the revisions.
      if (entity === TransformRow) {
        return Promise.resolve(store.transforms.delete(String(where.id)) ? 1 : 0);
      }
      if (entity !== RevisionRow) throw new Error('These tests delete no other entity.');
      return Promise.resolve(dropRevisions(store, where));
    },
  };

  // Not a type assertion: `Object.create(null)` is `any`, so the merged value is
  // too, and the declared return type is what narrows it back down.
  return Object.assign(Object.create(null), fake);
}

/**
 * A transform as it sits in a database that predates `catalog_revision`: a
 * version number, code, and nothing recorded anywhere.
 */
function storedTransform(version: number, code: string): TransformRow {
  const row = new TransformRow();
  row.id = 't1';
  row.name = 'Normalise';
  row.language = 'javascript';
  row.code = code;
  row.version = version;
  row.createdBy = 'ana';
  row.createdAt = new Date('2020-01-01T00:00:00.000Z');
  row.updatedAt = new Date('2021-06-01T09:30:00.000Z');
  return row;
}

function pipelineStore(store: Tables): MySqlPipelineStore {
  return new MySqlPipelineStore(entityManager(store));
}

function workspaceStore(store: Tables): MySqlWorkspaceStore {
  return new MySqlWorkspaceStore(entityManager(store));
}

async function saveCode(pipeline: MySqlPipelineStore, id: string | undefined, code: string) {
  return pipeline.saveTransform({ id, name: 'Normalise', language: 'javascript', code }, 'ana');
}

describe('a transform version names code that can still be read', () => {
  it('answers with the code a run recorded, two versions after it stopped being current', async () => {
    // The whole point of the feature. A load ran at `transformVersion: 2`, three
    // people have edited since, and the question — "what did the code that
    // produced these rows say" — has an answer.
    const store = tables();
    const pipeline = pipelineStore(store);

    const created = await saveCode(pipeline, undefined, 'rows => rows');
    await saveCode(pipeline, created.id, 'rows => rows.filter(Boolean)');
    await saveCode(pipeline, created.id, 'rows => rows.map(trim)');
    const current = await saveCode(pipeline, created.id, 'rows => rows.map(trim).filter(Boolean)');

    expect(current.version).toBe(4);
    const revisions = await pipeline.listTransformRevisions(created.id);
    expect(revisions.find((revision) => revision.version === 2)?.body).toBe(
      'rows => rows.filter(Boolean)',
    );
  });

  it('returns them newest first, which is the order the contract promises', async () => {
    const store = tables();
    const pipeline = pipelineStore(store);

    const created = await saveCode(pipeline, undefined, 'one');
    await saveCode(pipeline, created.id, 'two');
    await saveCode(pipeline, created.id, 'three');

    const revisions = await pipeline.listTransformRevisions(created.id);
    expect(revisions.map((revision) => revision.version)).toEqual([3, 2, 1]);
    expect(revisions.map((revision) => revision.body)).toEqual(['three', 'two', 'one']);
  });

  it('records the first code at create, so a history never starts at v2', async () => {
    const store = tables();
    const pipeline = pipelineStore(store);

    const created = await saveCode(pipeline, undefined, 'rows => rows');

    const revisions = await pipeline.listTransformRevisions(created.id);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({ version: 1, body: 'rows => rows', authoredBy: 'ana' });
  });

  it('writes nothing when the code did not change, so a rename cannot evict history', async () => {
    // The existing rule for the version counter, followed rather than diverged
    // from — and it earns more under a bounded archive than it did as a bare
    // counter: a revision per save would let renames push real code off the end.
    const store = tables();
    const pipeline = pipelineStore(store);

    const created = await saveCode(pipeline, undefined, 'rows => rows');
    const again = await pipeline.saveTransform(
      { id: created.id, name: 'Renamed', language: 'javascript', code: 'rows => rows' },
      'ben',
    );

    expect(again.version).toBe(1);
    expect(await pipeline.listTransformRevisions(created.id)).toHaveLength(1);
  });

  it('leaves an already-recorded version exactly as it was', async () => {
    // History a later save can rewrite is not history. The reachable version of
    // this is the backfill: on the second edit it names v2, which the first edit
    // already recorded, and it must not overwrite it with the current code.
    const store = tables();
    const pipeline = pipelineStore(store);

    const created = await saveCode(pipeline, undefined, 'one');
    await saveCode(pipeline, created.id, 'two');
    await saveCode(pipeline, created.id, 'three');

    const revisions = await pipeline.listTransformRevisions(created.id);
    expect(revisions.find((revision) => revision.version === 2)?.body).toBe('two');
  });
});

describe('a transform that predates the revision table', () => {
  it('backfills the version that was live, so the upgrade loses nothing readable', async () => {
    // The row is at v3 with code nobody recorded. The moment it is edited, that
    // code is about to be overwritten and this is the last chance to keep it.
    const store = tables();
    store.transforms.set('t1', storedTransform(3, 'the code that has been running'));
    const pipeline = pipelineStore(store);

    await saveCode(pipeline, 't1', 'something new');

    const revisions = await pipeline.listTransformRevisions('t1');
    expect(revisions.map((revision) => revision.version)).toEqual([4, 3]);
    expect(revisions.find((revision) => revision.version === 3)?.body).toBe(
      'the code that has been running',
    );
  });

  it('attributes the backfill to the row, not to whoever is editing now', async () => {
    // `ben` demonstrably did not write the code being superseded. `ana` created
    // the transform, which is the only actor the row keeps.
    const store = tables();
    store.transforms.set('t1', storedTransform(3, 'ana wrote this'));
    const pipeline = pipelineStore(store);

    await pipeline.saveTransform(
      { id: 't1', name: 'Normalise', language: 'javascript', code: 'ben wrote this' },
      'ben',
    );

    const revisions = await pipeline.listTransformRevisions('t1');
    expect(revisions.find((revision) => revision.version === 3)).toMatchObject({
      authoredBy: 'ana',
      authoredAt: new Date('2021-06-01T09:30:00.000Z').toISOString(),
    });
    expect(revisions.find((revision) => revision.version === 4)?.authoredBy).toBe('ben');
  });

  it('answers with its live code before anybody edits, rather than with nothing', async () => {
    // Otherwise the feature is empty on every existing deployment until somebody
    // happens to save — which is the deployment where somebody is asking.
    const store = tables();
    store.transforms.set('t1', storedTransform(3, 'the code that has been running'));
    const pipeline = pipelineStore(store);

    const revisions = await pipeline.listTransformRevisions('t1');

    expect(revisions).toEqual([
      {
        id: revisionKey('transform', 't1', 3),
        subjectId: 't1',
        version: 3,
        body: 'the code that has been running',
        authoredBy: 'ana',
        authoredAt: new Date('2021-06-01T09:30:00.000Z').toISOString(),
      },
    ]);
  });

  it('does not write that answer down, because a read that writes can fail a read', async () => {
    const store = tables();
    store.transforms.set('t1', storedTransform(3, 'the code that has been running'));
    const pipeline = pipelineStore(store);

    await pipeline.listTransformRevisions('t1');

    expect(store.revisions.size).toBe(0);
  });

  it('synthesises exactly what the next save will store, so the list does not move', async () => {
    // Two code paths — read-side synthesis and save-side backfill — producing one
    // revision. If they ever disagree, a screen showing history would change
    // under somebody the first time an unrelated edit was saved.
    const store = tables();
    store.transforms.set('t1', storedTransform(3, 'the code that has been running'));
    const pipeline = pipelineStore(store);

    const synthesised = await pipeline.listTransformRevisions('t1');
    await saveCode(pipeline, 't1', 'something new');
    const backfilled = await pipeline.listTransformRevisions('t1');

    expect(backfilled.find((revision) => revision.version === 3)).toEqual(synthesised[0]);
  });

  it('answers an id that names nothing with an empty list', async () => {
    const store = tables();

    expect(await pipelineStore(store).listTransformRevisions('gone')).toEqual([]);
  });
});

describe('what the archive costs', () => {
  it('keeps the newest CATALOG_REVISION_LIMIT and drops what falls past it', async () => {
    // The cap, and the loss it causes, asserted rather than described: the
    // earliest code is genuinely gone, and a run that recorded v1 can no longer
    // be opened. That is the trade the constant's docblock argues for.
    const store = tables();
    const pipeline = pipelineStore(store);

    const created = await saveCode(pipeline, undefined, 'body 1');
    for (let version = 2; version <= CATALOG_REVISION_LIMIT + 3; version += 1) {
      await saveCode(pipeline, created.id, `body ${version}`);
    }

    // The TABLE, not just the answer. The read is bounded too, so asserting only
    // on what comes back would pass just as happily with nothing ever pruned —
    // which is the difference between a cap and a paging limit, and the whole of
    // what the retention decision claims.
    expect(store.revisions.size).toBe(CATALOG_REVISION_LIMIT);

    const revisions = await pipeline.listTransformRevisions(created.id);
    expect(revisions).toHaveLength(CATALOG_REVISION_LIMIT);
    expect(revisions[0]?.version).toBe(CATALOG_REVISION_LIMIT + 3);
    expect(revisions.at(-1)?.version).toBe(4);
    expect(revisions.some((revision) => revision.version === 1)).toBe(false);
  });

  it('drops nothing while a subject is under the cap', async () => {
    const store = tables();
    const pipeline = pipelineStore(store);

    const created = await saveCode(pipeline, undefined, 'body 1');
    for (let version = 2; version <= CATALOG_REVISION_LIMIT; version += 1) {
      await saveCode(pipeline, created.id, `body ${version}`);
    }

    const revisions = await pipeline.listTransformRevisions(created.id);
    expect(store.revisions.size).toBe(CATALOG_REVISION_LIMIT);
    expect(revisions).toHaveLength(CATALOG_REVISION_LIMIT);
    expect(revisions.at(-1)?.version).toBe(1);
  });

  it('bounds each subject on its own, so a busy transform cannot evict a quiet one', async () => {
    const store = tables();
    const pipeline = pipelineStore(store);

    const quiet = await saveCode(pipeline, undefined, 'quiet 1');
    const busy = await saveCode(pipeline, undefined, 'busy 1');
    for (let version = 2; version <= CATALOG_REVISION_LIMIT + 5; version += 1) {
      await saveCode(pipeline, busy.id, `busy ${version}`);
    }

    expect(await pipeline.listTransformRevisions(quiet.id)).toHaveLength(1);
  });

  it('keeps a deleted transform’s revisions, because a run still names them', async () => {
    // Not a cascade, deliberately: throwing away the last copy of code that a
    // recorded run executed, because somebody tidied up the editor, would make
    // `transformVersion` mean less than it did before revisions existed.
    const store = tables();
    const pipeline = pipelineStore(store);

    const created = await saveCode(pipeline, undefined, 'rows => rows');
    await saveCode(pipeline, created.id, 'rows => rows.filter(Boolean)');
    await pipeline.deleteTransform(created.id);

    expect(store.revisions.size).toBe(2);
  });
});

describe('a saved query’s SQL', () => {
  it('is archived from the moment the query exists', async () => {
    const store = tables();
    const workspace = workspaceStore(store);

    const saved = await workspace.saveQuery({ name: 'Sales', sql: 'select 1' }, 'ana');

    expect(await workspace.listSavedQueryRevisions(saved.id)).toMatchObject([
      { version: 1, body: 'select 1', authoredBy: 'ana' },
    ]);
  });

  it('keeps what it used to be after an edit', async () => {
    // The half of the defect that had no version number at all: the previous
    // statement was overwritten with nothing recorded anywhere.
    const store = tables();
    const workspace = workspaceStore(store);

    const saved = await workspace.saveQuery({ name: 'Sales', sql: 'select 1' }, 'ana');
    await workspace.updateSavedQuery(saved.id, { sql: 'select 2' });

    const revisions = await workspace.listSavedQueryRevisions(saved.id);
    expect(revisions.map((revision) => revision.version)).toEqual([2, 1]);
    expect(revisions.map((revision) => revision.body)).toEqual(['select 2', 'select 1']);
  });

  it('records nothing for an edit that leaves the statement alone', async () => {
    const store = tables();
    const workspace = workspaceStore(store);

    const saved = await workspace.saveQuery({ name: 'Sales', sql: 'select 1' }, 'ana');
    await workspace.updateSavedQuery(saved.id, { name: 'Sales by region', cacheTtlSeconds: 60 });

    expect(await workspace.listSavedQueryRevisions(saved.id)).toHaveLength(1);
    expect(store.savedQueries.get(saved.id)?.version).toBe(1);
  });

  it('backfills the statement a pre-upgrade query was running', async () => {
    const store = tables();
    const workspace = workspaceStore(store);
    const row = new SavedQueryRow();
    row.id = 'q1';
    row.name = 'Sales';
    row.sql = 'select the old thing';
    row.version = 1;
    row.createdBy = 'ana';
    row.cacheTtlSeconds = 0;
    row.visualization = { kind: 'table' };
    row.shared = false;
    row.createdAt = new Date('2020-01-01T00:00:00.000Z');
    row.updatedAt = new Date('2021-06-01T09:30:00.000Z');
    store.savedQueries.set(row.id, row);

    await workspace.updateSavedQuery('q1', { sql: 'select the new thing' });

    const revisions = await workspace.listSavedQueryRevisions('q1');
    expect(revisions.map((revision) => revision.body)).toEqual([
      'select the new thing',
      'select the old thing',
    ]);
  });
});

describe('the two subjects share a table and never each other’s history', () => {
  it('keeps them apart when a transform and a saved query carry the same id', async () => {
    // Ids for both come out of the same generator and land in one table, so the
    // key is the subject AND the id. Keying on the id alone would let one
    // subject's history answer for the other.
    const store = tables();
    const pipeline = pipelineStore(store);
    const workspace = workspaceStore(store);

    await pipeline.saveTransform(
      { id: 'shared-id', name: 'Normalise', language: 'javascript', code: 'the code' },
      'ana',
    );
    const query = new SavedQueryRow();
    query.id = 'shared-id';
    query.name = 'Sales';
    query.sql = 'the sql';
    query.version = 1;
    query.createdBy = 'ana';
    query.cacheTtlSeconds = 0;
    query.visualization = { kind: 'table' };
    query.shared = false;
    query.createdAt = new Date('2020-01-01T00:00:00.000Z');
    query.updatedAt = new Date('2020-01-01T00:00:00.000Z');
    store.savedQueries.set(query.id, query);
    await workspace.updateSavedQuery('shared-id', { sql: 'the new sql' });

    expect((await pipeline.listTransformRevisions('shared-id')).map((r) => r.body)).toEqual([
      'the code',
    ]);
    expect((await workspace.listSavedQueryRevisions('shared-id')).map((r) => r.body)).toEqual([
      'the new sql',
      'the sql',
    ]);
  });
});
