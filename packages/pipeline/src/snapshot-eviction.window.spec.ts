import type {
  CatalogObjectTypeDef,
  CatalogReadResult,
  CatalogSnapshotArchiveStore,
  CatalogStoreCapabilities,
  SnapshotRef,
} from '@dudousxd/nestjs-catalog';
import { describe, expect, it } from 'vitest';
import type { ArchiveStore } from './snapshot-archive';
import { evictSnapshot, planSnapshotEviction } from './snapshot-eviction';

/**
 * ============================================================================
 * A retention sweep must not go blind as its own tombstones accumulate.
 * ============================================================================
 *
 * ## The failure, and the door it arrives through
 *
 * `dropSnapshot` leaves a **tombstone** — the record survives, the rows go — so
 * that a `catalog_connector_run` naming that snapshot stays resolvable. That is
 * right and it is not what is under test here. What is under test is the second
 * order effect: a tombstone stays in `listSnapshots`, `listSnapshots` is
 * bounded, and a caller asking "which snapshots still hold rows" by filtering
 * that bounded result gets **the live snapshots of the newest N records**.
 *
 * Those two sets are the same set right up until the tombstones outnumber the
 * bound. Then the filtered list runs short, and then it runs empty — and empty
 * is what a sweep reads as "nothing to retire". It keeps running. It keeps
 * reporting success. The disk keeps filling. The measured trajectory on the
 * deployment this was written for was about four days: ~4.5 snapshot records an
 * hour for one type against a 500-record window.
 *
 * So the sweep asks a different question when the store can answer it —
 * `listSnapshotsWithRows`, which puts the predicate in the statement — and says
 * out loud when it could not.
 *
 * ## Why the fixtures put tombstones in the MIDDLE
 *
 * Because in production they are at the bottom, and that is precisely why the
 * defect hides: the live snapshots are the newest loads, so they sit at the top
 * of the window and every assertion anybody writes passes. Dropping snapshots
 * from the middle of the history reproduces at N=5 what a real deployment
 * reaches at N=500, which is the only way to have a case that fails today and
 * passes after the fix.
 */

const SUBWO: CatalogObjectTypeDef = {
  name: 'Subwo',
  displayName: 'Subwo',
  pluralDisplayName: 'Subwos',
  tableName: 'obj_subwo',
  group: 'ops',
  primaryKey: ['id'],
  enriched: true,
  relations: [],
  properties: [
    {
      name: 'id',
      displayName: 'id',
      type: 'string',
      columnName: 'id',
      nullable: false,
      primary: true,
      hidden: false,
      order: 0,
      enriched: false,
    },
  ],
};

/**
 * A store whose snapshot list is bounded, exactly as a real adapter's is.
 *
 * The bound is the whole point of the fake: an unbounded list would make every
 * case here pass whatever the code under test does, which is the same reason
 * the production defect was invisible to every test that existed before this
 * file.
 *
 * `live` and `exact` are constructor flags rather than subclasses so that the
 * two halves of the fix — a store that can answer the live question, and one
 * that cannot — are the same fixture with a switch, and a case can assert what
 * the degraded path does rather than leaving it untested.
 */
class WindowedStore implements CatalogSnapshotArchiveStore {
  readonly capabilities: CatalogStoreCapabilities = {
    snapshots: 'emulated',
    writable: true,
    timeTravel: true,
  };
  readonly snapshots: SnapshotRef[] = [];
  currentId: string | undefined;
  /** Every id `listSnapshotsWithRows` was asked for, with its bound. */
  readonly liveCalls: Array<number | undefined> = [];

  constructor(
    private readonly bound: number,
    capability: { live: boolean; exact: boolean },
  ) {
    if (!capability.live) this.listSnapshotsWithRows = undefined;
    if (!capability.exact) this.findSnapshot = undefined;
  }

  async read(): Promise<CatalogReadResult> {
    return { rows: [], total: 0 };
  }

  /** Newest first and bounded by RECORDS — tombstones among them. */
  async listSnapshots(): Promise<SnapshotRef[]> {
    return this.ordered().slice(0, this.bound);
  }

  /** Newest first and bounded by LIVE snapshots — the predicate applied first. */
  listSnapshotsWithRows?: (type: CatalogObjectTypeDef, limit?: number) => Promise<SnapshotRef[]> =
    async (_type, limit) => {
      this.liveCalls.push(limit);
      return this.ordered()
        .filter((snapshot) => snapshot.droppedAt === undefined)
        .slice(0, limit ?? this.bound);
    };

  /** Exact, and unaffected by any window. */
  findSnapshot?: (
    type: CatalogObjectTypeDef,
    snapshotId: string,
  ) => Promise<SnapshotRef | undefined> = async (_type, snapshotId) =>
    this.snapshots.find((snapshot) => snapshot.id === snapshotId);

  async currentSnapshot(): Promise<SnapshotRef | undefined> {
    return this.snapshots.find((snapshot) => snapshot.id === this.currentId);
  }

  async ensureType(): Promise<void> {}

  async write(): Promise<{ written: number }> {
    return { written: 0 };
  }

  async commit(_type: CatalogObjectTypeDef, snapshotId: string): Promise<SnapshotRef> {
    this.currentId = snapshotId;
    const snapshot = this.snapshots.find((each) => each.id === snapshotId);
    if (!snapshot) throw new Error(`no snapshot ${snapshotId}`);
    return snapshot;
  }

  async dropSnapshot(): Promise<void> {}

  async recordSnapshotArchive(): Promise<void> {}

  seed(id: string, createdAt: string, dropped = false): void {
    this.snapshots.push({
      id,
      createdAt,
      rowCount: 100,
      principalId: 'spec',
      ...(dropped ? { droppedAt: '2026-08-11T00:00:00.000Z' } : {}),
    });
  }

  private ordered(): SnapshotRef[] {
    return [...this.snapshots].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }
}

/**
 * `count` loads, newest last, with the ids in `dropped` tombstoned.
 *
 * The newest is the served one, which is what a type that is still being
 * published into looks like, and which keeps the fixtures honest about the
 * served snapshot occupying one of the `keep` slots.
 */
function history(
  bound: number,
  capability: { live: boolean; exact: boolean },
  count: number,
  dropped: number[],
): WindowedStore {
  const store = new WindowedStore(bound, capability);
  for (let n = 1; n <= count; n += 1) {
    store.seed(
      `load-${n}`,
      `2026-08-${String(n).padStart(2, '0')}T00:00:00.000Z`,
      dropped.includes(n),
    );
  }
  store.currentId = `load-${count}`;
  return store;
}

/**
 * An archive store every method of which is a failed assertion.
 *
 * Both eviction cases below are about the LOOKUP that happens before an archive
 * is touched, so reaching object storage at all would mean the case got past the
 * point it is testing. A real store here — even a local one — would let that
 * happen quietly; this turns it into the loudest failure in the file.
 */
function unreachableArchives(): ArchiveStore {
  const refuse = (method: string): never => {
    throw new Error(`archives.${method}() was reached, and no case in this file should get there.`);
  };
  return {
    open: () => refuse('open'),
    read: () => refuse('read'),
    put: () => refuse('put'),
  };
}

describe('planSnapshotEviction', () => {
  it('sees candidates the bounded record list has already pushed out', async () => {
    // Ten loads, a window of four records, and the six in the middle dropped.
    // The newest four RECORDS are loads 10, 9, 8 and 7 — one live and three
    // tombstones — so a plan filtering that window finds a single live snapshot,
    // keeps it, and reports nothing to do. Loads 1, 2 and 3 still hold their
    // rows and are exactly what retention exists to retire.
    const store = history(4, { live: true, exact: true }, 10, [4, 5, 6, 7, 8, 9]);

    const plan = await planSnapshotEviction({
      type: SUBWO,
      store,
      retention: { keep: 2 },
      limit: 10,
    });

    // Oldest first, and load-10 is served so it fills one of the two slots;
    // load-3 fills the other.
    expect(plan.candidates.map((candidate) => candidate.id)).toEqual(['load-1', 'load-2']);
    expect(plan.live).toBe(4);
    expect(plan.answeredLiveInStatement).toBe(true);
    expect(plan.listTruncated).toBe(false);
  });

  it('reports a full live window as truncated, because there may be more to retire', async () => {
    const store = history(100, { live: true, exact: true }, 10, []);

    const plan = await planSnapshotEviction({
      type: SUBWO,
      store,
      retention: { keep: 2 },
      limit: 5,
    });

    // Five live snapshots asked for, five returned. That is the one case where
    // there may be more, and the caller has to be able to tell it from a type
    // with nothing left — the two are otherwise the same short list.
    expect(plan.live).toBe(5);
    expect(plan.listTruncated).toBe(true);
    expect(plan.limit).toBe(5);
    expect(store.liveCalls).toEqual([5]);
  });

  it('degrades to the record list, and refuses to call the answer complete', async () => {
    // The same history, against a store with no live query. The plan is a
    // PREFIX of the truth — sound as far as it goes — and the difference from
    // the case above is that it says so.
    const store = history(4, { live: false, exact: true }, 10, [4, 5, 6, 7, 8, 9]);

    const plan = await planSnapshotEviction({
      type: SUBWO,
      store,
      retention: { keep: 2 },
      limit: 10,
      listBound: 4,
    });

    expect(plan.answeredLiveInStatement).toBe(false);
    // Four records came back against a bound of four, so live snapshots may be
    // sitting outside the window — and here three of them are.
    expect(plan.listTruncated).toBe(true);
    expect(plan.candidates).toEqual([]);
  });

  it('cannot prove a degraded answer complete when it is not told the store’s bound', async () => {
    // Ten records, a window of a hundred: this list IS the whole history, and
    // there is still no way to know that from in here. Pessimistic is the honest
    // answer, and the escape hatch is a caller that knows its adapter.
    const store = history(100, { live: false, exact: true }, 10, []);

    const blind = await planSnapshotEviction({ type: SUBWO, store, retention: { keep: 2 } });
    expect(blind.listTruncated).toBe(true);

    const told = await planSnapshotEviction({
      type: SUBWO,
      store,
      retention: { keep: 2 },
      listBound: 100,
    });
    expect(told.listTruncated).toBe(false);
    expect(told.candidates.map((candidate) => candidate.id)).toEqual([
      'load-1',
      'load-2',
      'load-3',
      'load-4',
      'load-5',
      'load-6',
      'load-7',
      'load-8',
    ]);
  });
});

describe('evictSnapshot', () => {
  it('resolves a candidate older than the record window instead of calling it unknown', async () => {
    const store = history(4, { live: true, exact: true }, 10, [4, 5, 6, 7, 8, 9]);

    // load-1 is outside the four-record window, so the old lookup — scan the
    // list, fail if it is not there — would refuse this with "an id that
    // resolves to nothing was never a load of this type", which is false. It
    // gets far enough to refuse for the RIGHT reason instead: there is no
    // archive, and eviction without one is the thing this package will not do.
    const refusal = await evictSnapshot({
      type: SUBWO,
      snapshotId: 'load-1',
      store,
      archives: unreachableArchives(),
    }).then(
      () => undefined,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    expect(refusal).toContain('no archive of it is recorded');
    expect(refusal).not.toContain('was never a load of this type');
  });

  it('says which question it could not answer when the store has no lookup by id', async () => {
    const store = history(4, { live: true, exact: false }, 10, [4, 5, 6, 7, 8, 9]);

    const refusal = await evictSnapshot({
      type: SUBWO,
      snapshotId: 'load-1',
      store,
      archives: unreachableArchives(),
    }).then(
      () => undefined,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    // Not "there is no such snapshot". The store cannot tell the difference, so
    // neither may the sentence: a reason that names the wrong cause sends
    // somebody to look for a deleted load that is sitting in the table.
    expect(refusal).toContain('most recent snapshot record(s) this store will list');
    expect(refusal).toContain('findSnapshot');
    expect(refusal).toContain('Nothing has been deleted.');
  });
});
