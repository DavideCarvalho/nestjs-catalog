import type { CatalogObjectTypeDef, CatalogPrincipal, SnapshotRef } from '@dudousxd/nestjs-catalog';
import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ConnectorRunSteps } from './connector-run.steps';
import {
  CARRIED_FROM_LABEL,
  type CatalogLoadExpectations,
  DEFAULT_ROW_COUNT_BOUND,
  EXPECT_SHRINK_LABEL,
  LoadExpectationError,
  expectationFor,
  refuseRowCountDrift,
  refuseStaleReconciliation,
  refuseUndeclaredDeletes,
  rowCountBoundFor,
} from './load-expectations';
import { PublishService } from './publish.service';
import { passthroughScope } from './seams';

/** See the note in `pipeline.module.integration.spec.ts`: the package cannot load here. */
vi.mock('@dudousxd/nestjs-durable', () => ({
  WorkflowEngine: class WorkflowEngine {},
  Step: () => (_target: unknown, _key: unknown, descriptor: unknown) => descriptor,
  Workflow: () => (target: unknown) => target,
}));

const TYPE: CatalogObjectTypeDef = {
  name: 'Mvr',
  displayName: 'Mvr',
  pluralDisplayName: 'Mvrs',
  group: 'Fleet',
  tableName: 'catalog_mvr',
  primaryKey: ['id'],
  enriched: false,
  properties: [],
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function snapshot(over: Partial<SnapshotRef> & { id: string }): SnapshotRef {
  return {
    createdAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    rowCount: 0,
    principalId: 'ingest',
    ...over,
  };
}

/* ---------------------------------------------------------------------------
 * The declaration gate. The mechanism itself: an incremental load of a type
 * nobody has said anything about does not happen.
 * ------------------------------------------------------------------------- */

describe('refuseUndeclaredDeletes', () => {
  it('refuses a type nothing has been declared about', () => {
    const refusal = refuseUndeclaredDeletes('Mvr', expectationFor(undefined, 'Mvr'));

    expect(refusal).toContain('Mvr');
    expect(refusal).toContain('deleted');
  });

  it('admits "accepted" with a reason', () => {
    expect(
      refuseUndeclaredDeletes('Mvr', {
        deletes: { strategy: 'accepted', because: 'This ledger never deletes rows.' },
      }),
    ).toBeUndefined();
  });

  it('admits "soft-deleted-at-source" with a reason', () => {
    expect(
      refuseUndeclaredDeletes('Mvr', {
        deletes: {
          strategy: 'soft-deleted-at-source',
          because: 'deleted_at moves, so the watermark sees it',
          column: 'deleted_at',
        },
      }),
    ).toBeUndefined();
  });

  it('admits "periodic-full-reload" with an interval', () => {
    expect(
      refuseUndeclaredDeletes('Mvr', {
        deletes: { strategy: 'periodic-full-reload', because: 'nightly full read', withinMs: DAY },
      }),
    ).toBeUndefined();
  });

  // A reason field that may be blank is a reason field that is blank, and the
  // whole value of the declaration is that it is still legible in six months.
  it('refuses a declaration whose reason is only whitespace', () => {
    const refusal = refuseUndeclaredDeletes('Mvr', {
      deletes: { strategy: 'accepted', because: '   ' },
    });

    expect(refusal).toContain('no reason attached');
  });

  // Otherwise `periodic-full-reload` would be the loosest of the three rather
  // than the strictest: an interval of zero never runs out.
  it('refuses a periodic full reload that names no interval', () => {
    const refusal = refuseUndeclaredDeletes('Mvr', {
      deletes: { strategy: 'periodic-full-reload', because: 'nightly', withinMs: 0 },
    });

    expect(refusal).toContain('no interval');
  });
});

/* ---------------------------------------------------------------------------
 * The half that makes the declared interval a mechanism rather than a note.
 * ------------------------------------------------------------------------- */

describe('refuseStaleReconciliation', () => {
  const expectation = {
    deletes: { strategy: 'periodic-full-reload', because: 'nightly', withinMs: DAY },
  } as const;
  const now = Date.parse('2026-01-10T00:00:00.000Z');

  it('refuses once the last full snapshot is older than the interval', () => {
    const refusal = refuseStaleReconciliation(
      'Mvr',
      expectation,
      [
        snapshot({ id: 'full-1', createdAt: new Date(now - 3 * DAY).toISOString() }),
        snapshot({
          id: 'inc-9',
          createdAt: new Date(now - HOUR).toISOString(),
          labels: { [CARRIED_FROM_LABEL]: 'inc-8' },
        }),
      ],
      now,
    );

    expect(refusal).toContain('full-1');
    expect(refusal).toContain('refused');
  });

  it('admits while the last full snapshot is inside the interval', () => {
    expect(
      refuseStaleReconciliation(
        'Mvr',
        expectation,
        [
          snapshot({ id: 'full-2', createdAt: new Date(now - 2 * HOUR).toISOString() }),
          snapshot({
            id: 'inc-9',
            createdAt: new Date(now - HOUR).toISOString(),
            labels: { [CARRIED_FROM_LABEL]: 'full-2' },
          }),
        ],
        now,
      ),
    ).toBeUndefined();
  });

  // The newest full one, not the first one found: the store's ordering is not
  // something this can assume, and taking the wrong end of the list would
  // refuse a type that reconciles every night.
  it('dates the interval from the newest full snapshot, whatever the list order', () => {
    expect(
      refuseStaleReconciliation(
        'Mvr',
        expectation,
        [
          snapshot({ id: 'full-old', createdAt: new Date(now - 9 * DAY).toISOString() }),
          snapshot({ id: 'full-new', createdAt: new Date(now - HOUR).toISOString() }),
        ],
        now,
      ),
    ).toBeUndefined();
  });

  it('refuses when every snapshot the store still reports was carried forward', () => {
    const refusal = refuseStaleReconciliation(
      'Mvr',
      expectation,
      [
        snapshot({
          id: 'inc-8',
          createdAt: new Date(now - 2 * HOUR).toISOString(),
          labels: { [CARRIED_FROM_LABEL]: 'inc-7' },
        }),
      ],
      now,
    );

    expect(refusal).toContain('none of the 1 snapshots');
  });

  // The first load of a type has no history and cannot have reconciled. That is
  // `carryForward`'s own case — it commits the run as the whole dataset — and
  // refusing it here would make a fresh type impossible to load incrementally.
  it('admits a type with no snapshots at all', () => {
    expect(refuseStaleReconciliation('Mvr', expectation, [], now)).toBeUndefined();
  });

  it('has nothing to say about the other two strategies', () => {
    expect(
      refuseStaleReconciliation(
        'Mvr',
        { deletes: { strategy: 'accepted', because: 'append-only' } },
        [
          snapshot({
            id: 'inc-1',
            createdAt: new Date(now - 900 * DAY).toISOString(),
            labels: { [CARRIED_FROM_LABEL]: 'inc-0' },
          }),
        ],
        now,
      ),
    ).toBeUndefined();
  });
});

/* ---------------------------------------------------------------------------
 * The bound on how far one load may move a type.
 * ------------------------------------------------------------------------- */

describe('refuseRowCountDrift', () => {
  const bound = DEFAULT_ROW_COUNT_BOUND;
  const previous = snapshot({ id: 'yesterday', rowCount: 40_000 });

  const drift = (over: Partial<Parameters<typeof refuseRowCountDrift>[0]>) =>
    refuseRowCountDrift({
      typeName: 'Mvr',
      snapshotId: 'today',
      previous,
      pending: 40_000,
      pendingLabels: undefined,
      bound,
      ...over,
    });

  it('refuses the load that started returning 12 rows where it returned 40,000', () => {
    const refusal = drift({ pending: 12 });

    expect(refusal).toContain('12 rows');
    expect(refusal).toContain('40000');
    expect(refusal).toContain('yesterday');
  });

  // The less dramatic symptom of the same bug, and the reason the bound is 0.5
  // rather than 0.9.
  it('refuses a load that keeps an eighth of the dataset', () => {
    expect(drift({ pending: 5_000 })).toBeDefined();
  });

  it('admits a load that lost a little', () => {
    expect(drift({ pending: 39_000 })).toBeUndefined();
  });

  // Exactly at the bound is inside it. A bound somebody set to 0.5 meaning
  // "half may go" that refuses at half is a bound that reads as off by one.
  it('admits a load sitting exactly on the bound', () => {
    expect(drift({ pending: 20_000 })).toBeUndefined();
  });

  it('admits growth, because growth and collapse are not the same event', () => {
    expect(drift({ pending: 400_000 })).toBeUndefined();
  });

  it('refuses growth once a type asks for a growth bound', () => {
    expect(drift({ pending: 400_000, bound: { ...bound, maxGrowth: 5 } })).toBeDefined();
    expect(drift({ pending: 120_000, bound: { ...bound, maxGrowth: 5 } })).toBeUndefined();
  });

  it('has nothing to compare the first load of a type against', () => {
    expect(drift({ previous: undefined, pending: 3 })).toBeUndefined();
  });

  // A percentage of a small number is noise, and a bound that fires on a
  // four-row lookup table is a bound somebody switches off for everything.
  it('leaves a small dataset alone', () => {
    expect(
      drift({ previous: snapshot({ id: 'yesterday', rowCount: 40 }), pending: 4 }),
    ).toBeUndefined();
  });

  // …but zero over anything is never right, at any size, below any floor.
  it('refuses an empty snapshot over a non-empty one whatever the floor says', () => {
    const refusal = drift({ previous: snapshot({ id: 'yesterday', rowCount: 40 }), pending: 0 });

    expect(refusal).toContain('no rows');
  });

  it('admits an acknowledged truncation', () => {
    expect(
      drift({ pending: 12, pendingLabels: { [EXPECT_SHRINK_LABEL]: 'migration' } }),
    ).toBeUndefined();
  });

  // A durable run whose commit succeeded and then replayed re-commits the
  // snapshot that is already being served. The counts are asserted apart on
  // purpose: the served pointer and the snapshot list are two reads, a store
  // is free to answer them from different places, and if they disagree about
  // one snapshot the difference is not a load that lost rows — it is the same
  // load, seen twice. Equal counts would have let the identity check be
  // deleted without a test noticing.
  it('admits a replayed commit of the snapshot already being served', () => {
    expect(
      drift({ previous: snapshot({ id: 'today', rowCount: 40_000 }), pending: 12 }),
    ).toBeUndefined();
  });
});

describe('expectationFor / rowCountBoundFor', () => {
  const policy: CatalogLoadExpectations = {
    default: { rowCount: { maxShrink: 0.2 } },
    byType: {
      Mvr: {
        deletes: { strategy: 'accepted', because: 'append-only' },
        rowCount: { minRows: 5 },
      },
      Subwo: { rowCount: { maxShrink: 0.9 } },
    },
  };

  it('lets a type keep the house default for the fields it does not set', () => {
    expect(rowCountBoundFor(policy, 'Mvr')).toEqual({ maxShrink: 0.2, minRows: 5 });
  });

  // The two objects in the test above set disjoint fields, so either merge
  // order produces it. This is the one that says which wins: a type that sets a
  // field the house default also sets has to beat it, or a per-type bound is
  // decoration.
  it('lets a type beat the house default on a field they both set', () => {
    expect(rowCountBoundFor(policy, 'Subwo').maxShrink).toBe(0.9);
  });

  it('gives a type nobody mentioned the house default over the built-in one', () => {
    expect(rowCountBoundFor(policy, 'Mel')).toEqual({
      maxShrink: 0.2,
      minRows: DEFAULT_ROW_COUNT_BOUND.minRows,
    });
  });

  it('falls all the way back to the built-in bound with no policy at all', () => {
    expect(rowCountBoundFor(undefined, 'Mel')).toEqual(DEFAULT_ROW_COUNT_BOUND);
  });

  it('does not hand one type another type’s delete declaration', () => {
    expect(expectationFor(policy, 'Subwo').deletes).toBeUndefined();
  });
});

/* ---------------------------------------------------------------------------
 * The gates in place: PublishService is the one path every load ends at.
 * ------------------------------------------------------------------------- */

interface FakeStore {
  capabilities: { snapshots: string; writable: boolean; timeTravel: boolean };
  write: ReturnType<typeof vi.fn>;
  ensureType: ReturnType<typeof vi.fn>;
  commit: ReturnType<typeof vi.fn>;
  dropSnapshot: ReturnType<typeof vi.fn>;
  read: ReturnType<typeof vi.fn>;
  carryForward: ReturnType<typeof vi.fn>;
  listSnapshots?: ReturnType<typeof vi.fn>;
  currentSnapshot?: ReturnType<typeof vi.fn>;
}

function fakeStore(over: Partial<FakeStore> = {}): FakeStore {
  return {
    capabilities: { snapshots: 'emulated', writable: true, timeTravel: true },
    write: vi.fn(),
    ensureType: vi.fn(),
    commit: vi.fn(async () => snapshot({ id: 'today', rowCount: 1 })),
    dropSnapshot: vi.fn(),
    read: vi.fn(),
    carryForward: vi.fn(async () => ({ carried: 0, total: 0 })),
    listSnapshots: vi.fn(async () => []),
    currentSnapshot: vi.fn(async () => undefined),
    ...over,
  };
}

function publisher(store: FakeStore, expectations?: CatalogLoadExpectations): PublishService {
  const registry = { reload: vi.fn(async () => undefined), getType: () => TYPE };
  return new PublishService(
    () => {
      throw new Error('No EntityManager is needed on these paths.');
    },
    registry,
    // The store arrives through `CATALOG_STORE`, whose declared type is the
    // full write-store interface; the fake implements the members these paths
    // touch and nothing else, deliberately, so a call this test is not
    // expecting fails rather than being quietly answered.
    Object.assign(Object.create(null), store),
    expectations,
  );
}

const DECLARED: CatalogLoadExpectations = {
  byType: { Mvr: { deletes: { strategy: 'accepted', because: 'append-only ledger' } } },
};

describe('PublishService: an incremental load nobody has declared anything about', () => {
  it('refuses to carry a snapshot forward', async () => {
    const store = fakeStore();

    await expect(
      publisher(store).carryForwardAsSystem('ingest', 'Mvr', 'today', { source: 'connector' }),
    ).rejects.toBeInstanceOf(LoadExpectationError);
    expect(store.carryForward).not.toHaveBeenCalled();
  });

  it('carries it forward once somebody has declared one', async () => {
    const store = fakeStore();

    await publisher(store, DECLARED).carryForwardAsSystem('ingest', 'Mvr', 'today', {
      source: 'connector',
    });

    expect(store.carryForward).toHaveBeenCalledTimes(1);
  });

  it('still refuses when the declared full reload has gone stale', async () => {
    const store = fakeStore({
      listSnapshots: vi.fn(async () => [
        snapshot({
          id: 'inc-1',
          createdAt: new Date(Date.now() - 5 * DAY).toISOString(),
          labels: { [CARRIED_FROM_LABEL]: 'inc-0' },
        }),
      ]),
    });
    const service = publisher(store, {
      byType: {
        Mvr: {
          deletes: { strategy: 'periodic-full-reload', because: 'nightly', withinMs: DAY },
        },
      },
    });

    await expect(
      service.carryForwardAsSystem('ingest', 'Mvr', 'today', { source: 'connector' }),
    ).rejects.toThrow(/full reload/);
    expect(store.carryForward).not.toHaveBeenCalled();
  });
});

describe('PublishService: a load that collapsed', () => {
  const collapsing = (pending = 12, over: Partial<FakeStore> = {}) =>
    fakeStore({
      currentSnapshot: vi.fn(async () => snapshot({ id: 'yesterday', rowCount: 40_000 })),
      listSnapshots: vi.fn(async () => [snapshot({ id: 'today', rowCount: pending })]),
      ...over,
    });

  it('is not committed, so readers keep the snapshot that was serving', async () => {
    const store = collapsing();

    await expect(publisher(store).commitAsSystem('ingest', 'Mvr', 'today')).rejects.toBeInstanceOf(
      LoadExpectationError,
    );
    expect(store.commit).not.toHaveBeenCalled();
  });

  it('says which expectation was not met, so a caller can tell it apart from a failure', async () => {
    const error = await publisher(collapsing())
      .commitAsSystem('ingest', 'Mvr', 'today')
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(LoadExpectationError);
    expect(error instanceof LoadExpectationError && error.expectation).toBe('row-count');
    expect(error instanceof LoadExpectationError && error.typeName).toBe('Mvr');
  });

  it('is committed when the type says a loss that size is allowed', async () => {
    // 39,950 of 40,000 gone: past the house bound of 0.5 and inside the 0.999
    // this type asked for, so the override is what decides it rather than the
    // number happening to be extreme enough to escape both.
    const store = collapsing(50);

    await publisher(store, { byType: { Mvr: { rowCount: { maxShrink: 0.999 } } } }).commitAsSystem(
      'ingest',
      'Mvr',
      'today',
    );

    expect(store.commit).toHaveBeenCalledWith(TYPE, 'today');
  });

  it('gates the HTTP publish path by the same rule', async () => {
    const store = collapsing();
    const principal: CatalogPrincipal = {
      id: 'app',
      scopes: ['catalog:write'],
      writeTypes: ['*'],
    };

    await expect(publisher(store).commit(principal, 'Mvr', 'today')).rejects.toBeInstanceOf(
      LoadExpectationError,
    );
    expect(store.commit).not.toHaveBeenCalled();
  });

  it('lets an ordinary load through untouched', async () => {
    const store = fakeStore({
      currentSnapshot: vi.fn(async () => snapshot({ id: 'yesterday', rowCount: 40_000 })),
      listSnapshots: vi.fn(async () => [snapshot({ id: 'today', rowCount: 41_200 })]),
    });

    await publisher(store).commitAsSystem('ingest', 'Mvr', 'today');

    expect(store.commit).toHaveBeenCalledTimes(1);
  });

  // The gap is real and is declared rather than pretended away: without a
  // `currentSnapshot` there is no baseline, and `catalog.store.ts` is explicit
  // that reconstructing one from the snapshot list names the wrong row exactly
  // when somebody has rolled a load back.
  it('commits and warns when the store cannot say what it is serving', async () => {
    // The "and warns" half used to be a claim in the title with nothing behind
    // it — the body asserted only that the commit happened, which is also what
    // a silent stand-down looks like. The warning IS the feature here: a host
    // that configured a bound has no other way to learn it is decorative on
    // this adapter.
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const store = collapsing(12, { currentSnapshot: undefined });

    await publisher(store).commitAsSystem('ingest', 'Mvr', 'today');

    expect(store.commit).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/cannot be enforced/);
    warn.mockRestore();
  });

  it('commits and warns when the store does not list the snapshot being committed', async () => {
    // The other branch of the same method, which stood down in total silence
    // while its sibling warned. Whether the snapshot exists is still `commit`'s
    // question; that the bound is not being applied is this method's, and it
    // said nothing.
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const store = collapsing(12, { listSnapshots: () => Promise.resolve([]) });

    await publisher(store).commitAsSystem('ingest', 'Mvr', 'today');

    expect(store.commit).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/standing down/);
    warn.mockRestore();
  });
});

/* ---------------------------------------------------------------------------
 * The same question, asked before a source is read.
 * ------------------------------------------------------------------------- */

describe('ConnectorRunSteps: the preflight', () => {
  const connector = (mode: 'full' | 'incremental') => ({
    id: 'c1',
    name: 'Nightly MVR',
    kind: 'sql' as const,
    targetType: 'Mvr',
    config: {},
    mode,
    enabled: true,
    createdBy: 'someone',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  const input = { connectorId: 'c1', principalId: 'p1', snapshotId: 'snap-1' };

  function steps(mode: 'full' | 'incremental', expectations?: CatalogLoadExpectations) {
    const run = vi.fn(async () => ({
      id: 'r1',
      status: 'succeeded',
      logs: [],
      fetched: 1,
      written: 1,
    }));
    const pipeline = { getConnector: vi.fn(async () => connector(mode)) };
    const subject = new ConnectorRunSteps(
      Object.assign(Object.create(null), { run }),
      passthroughScope,
      Object.assign(Object.create(null), pipeline),
      expectations,
    );
    return { subject, run };
  }

  it('refuses an undeclared incremental connector without reading the source', async () => {
    const { subject, run } = steps('incremental');

    await expect(subject.runConnector(input)).rejects.toThrow(/deleted at the source/);
    expect(run).not.toHaveBeenCalled();
  });

  // A missing declaration will be exactly as missing in fifteen minutes, and
  // three attempts at an unattended schedule is fifteen minutes of noise
  // standing between somebody and the real failures.
  it('tells the engine not to retry it', async () => {
    const { subject } = steps('incremental');

    const error = await subject.runConnector(input).catch((thrown: unknown) => thrown);

    expect(error instanceof Error && Reflect.get(error, 'retryable')).toBe(false);
    expect(error instanceof Error && Reflect.get(error, 'code')).toBe('load_expectation_unmet');
  });

  it('runs it once the type has a declaration', async () => {
    const { subject, run } = steps('incremental', DECLARED);

    await subject.runConnector(input);

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('says nothing about a full connector, which has the problem by definition', async () => {
    const { subject, run } = steps('full');

    await subject.runConnector(input);

    expect(run).toHaveBeenCalledTimes(1);
  });
});
