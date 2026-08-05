import type {
  CatalogConnection,
  CatalogConnector,
  CatalogLoadExpectations,
  CatalogObjectTypeDef,
  CatalogPipelineStore,
  CatalogTransform,
  ConnectorRun,
  SnapshotRef,
  StoredLoadExpectation,
} from '@dudousxd/nestjs-catalog';
import { describe, expect, it, vi } from 'vitest';
import { ConnectorRunSteps } from './connector-run.steps';
import {
  CARRIED_FROM_LABEL,
  LoadExpectationError,
  expectationFor,
  hostLockedFields,
  hostOwnedFields,
  mergeLoadExpectation,
  refuseInvalidLoadExpectation,
  resolveLoadExpectation,
  rowCountBoundOf,
  storedExpectationFor,
} from './load-expectations';
import { PublishService } from './publish.service';
import { passthroughScope } from './seams';

/** See the note in `pipeline.module.integration.spec.ts`: the package cannot load here. */
vi.mock('@dudousxd/nestjs-durable', () => ({
  WorkflowEngine: class WorkflowEngine {},
  Step: () => (_target: unknown, _key: unknown, descriptor: unknown) => descriptor,
  Workflow: () => (target: unknown) => target,
}));

const DAY = 86_400_000;

const TYPE: CatalogObjectTypeDef = {
  name: 'Mvr',
  displayName: 'Mvr',
  pluralDisplayName: 'Mvrs',
  group: 'Fleet',
  tableName: 'catalog_mvr',
  primaryKey: ['id'],
  enriched: false,
  properties: [],
  relations: [],
};

/* ---------------------------------------------------------------------------
 * Three layers, each saying something DIFFERENT about the same field.
 *
 * Different on purpose, and it is the whole design of this file. A fixture where
 * two layers agree cannot tell precedence from coincidence: reverse the order
 * and the assertion still passes, so the test would be green against an
 * implementation that reads the layers backwards. Every field below is worded so
 * that the answer names which layer produced it.
 * ------------------------------------------------------------------------- */

const HOST_SAYS = { strategy: 'accepted', because: 'the host declared this in code' } as const;
const OPERATOR_SAYS = {
  strategy: 'soft-deleted-at-source',
  because: 'the operator set this through the API',
  column: 'deleted_at',
} as const;
const HOUSE_DEFAULT_SAYS = {
  strategy: 'periodic-full-reload',
  because: 'the house default applied',
  withinMs: DAY,
} as const;

function storedRow(over: Partial<StoredLoadExpectation> = {}): StoredLoadExpectation {
  return {
    typeName: 'Mvr',
    setBy: 'console#ana@example.com',
    setByActor: 'ana@example.com',
    setAt: '2026-07-01T00:00:00.000Z',
    ...over,
  };
}

/* ---------------------------------------------------------------------------
 * A pipeline store, with and without the optional members.
 *
 * Written out in full rather than faked with a partial, because
 * `supportsLoadExpectations` probes for methods: a fixture that merely claims to
 * be a store would narrow on whatever it happened to define, and the case this
 * file most needs to be exact about is the store that defines NONE of them.
 * ------------------------------------------------------------------------- */

function unreached(method: string): never {
  throw new Error(`${method} is not reached by the load-expectation paths.`);
}

function pipelineStore(options: {
  rows?: Map<string, StoredLoadExpectation>;
  keepsExpectations?: boolean;
}): CatalogPipelineStore {
  const rows = options.rows ?? new Map<string, StoredLoadExpectation>();
  const base: CatalogPipelineStore = {
    listConnectors: (): Promise<CatalogConnector[]> => unreached('listConnectors'),
    getConnector: (): Promise<CatalogConnector | undefined> => unreached('getConnector'),
    saveConnector: (): Promise<CatalogConnector> => unreached('saveConnector'),
    deleteConnector: (): Promise<boolean> => unreached('deleteConnector'),
    saveConnectorState: (): Promise<void> => unreached('saveConnectorState'),
    listConnections: (): Promise<CatalogConnection[]> => unreached('listConnections'),
    getConnection: (): Promise<CatalogConnection | undefined> => unreached('getConnection'),
    saveConnection: (): Promise<CatalogConnection> => unreached('saveConnection'),
    deleteConnection: (): Promise<boolean> => unreached('deleteConnection'),
    recordConnectionCheck: (): Promise<void> => unreached('recordConnectionCheck'),
    connectorsUsingConnection: (): Promise<CatalogConnector[]> =>
      unreached('connectorsUsingConnection'),
    listTransforms: (): Promise<CatalogTransform[]> => unreached('listTransforms'),
    getTransform: (): Promise<CatalogTransform | undefined> => unreached('getTransform'),
    saveTransform: (): Promise<CatalogTransform> => unreached('saveTransform'),
    deleteTransform: (): Promise<boolean> => unreached('deleteTransform'),
    startRun: (): Promise<ConnectorRun> => unreached('startRun'),
    finishRun: (): Promise<ConnectorRun | undefined> => unreached('finishRun'),
    listRuns: (): Promise<ConnectorRun[]> => unreached('listRuns'),
  };
  if (options.keepsExpectations === false) return base;
  return {
    ...base,
    listLoadExpectations: () => Promise.resolve([...rows.values()]),
    getLoadExpectation: (typeName: string) => Promise.resolve(rows.get(typeName)),
    saveLoadExpectation: (typeName, expectation, setBy, setByActor) => {
      const row: StoredLoadExpectation = {
        typeName,
        ...expectation,
        setBy,
        setByActor,
        setAt: '2026-08-05T00:00:00.000Z',
      };
      rows.set(typeName, row);
      return Promise.resolve(row);
    },
    clearLoadExpectation: (typeName: string) => Promise.resolve(rows.delete(typeName)),
  };
}

/* ---------------------------------------------------------------------------
 * Precedence: host.byType > stored > host.default, field by field.
 * ------------------------------------------------------------------------- */

describe('mergeLoadExpectation: which layer wins', () => {
  it('lets the host entry for the type beat the operator and the house default', () => {
    const resolved = mergeLoadExpectation(
      { default: { deletes: HOUSE_DEFAULT_SAYS }, byType: { Mvr: { deletes: HOST_SAYS } } },
      storedRow({ deletes: OPERATOR_SAYS }),
      'Mvr',
    );

    // The sentence names the layer, so a reversed precedence cannot pass this.
    expect(resolved.resolved.deletes).toEqual(HOST_SAYS);
    expect(resolved.deletesFrom).toBe('host');
    expect(resolved.hostLocked.deletes).toBe(true);
  });

  it('lets the operator beat the house default where the host said nothing about the type', () => {
    const resolved = mergeLoadExpectation(
      { default: { deletes: HOUSE_DEFAULT_SAYS } },
      storedRow({ deletes: OPERATOR_SAYS }),
      'Mvr',
    );

    expect(resolved.resolved.deletes).toEqual(OPERATOR_SAYS);
    expect(resolved.deletesFrom).toBe('stored');
    // Not locked: the house default is the weakest layer, and drawing it as a
    // lock would tell somebody an edit was impossible when it just worked.
    expect(resolved.hostLocked.deletes).toBe(false);
  });

  it('falls to the house default when nobody said anything about the type', () => {
    const resolved = mergeLoadExpectation(
      { default: { deletes: HOUSE_DEFAULT_SAYS } },
      undefined,
      'Mvr',
    );

    expect(resolved.resolved.deletes).toEqual(HOUSE_DEFAULT_SAYS);
    expect(resolved.deletesFrom).toBe('default');
  });

  it("says 'none' when no layer declares deletes at all", () => {
    // The state that refuses every incremental load of the type, and the one a
    // screen most needs to be able to name rather than draw as a blank.
    const resolved = mergeLoadExpectation(undefined, undefined, 'Mvr');

    expect(resolved.resolved.deletes).toBeUndefined();
    expect(resolved.deletesFrom).toBe('none');
    expect(resolved.hostLocked).toEqual({ deletes: false, rowCount: false });
  });

  it("does not let a host entry about ROW COUNTS lock somebody else's deletes", () => {
    // Field by field is the contract, and this is the case that proves it is not
    // "whichever layer spoke first wins the whole object".
    const resolved = mergeLoadExpectation(
      { byType: { Mvr: { rowCount: { maxShrink: 0.1 } } } },
      storedRow({ deletes: OPERATOR_SAYS }),
      'Mvr',
    );

    expect(resolved.resolved.deletes).toEqual(OPERATOR_SAYS);
    expect(resolved.deletesFrom).toBe('stored');
    expect(resolved.hostLocked).toEqual({ deletes: false, rowCount: true });
  });

  it('merges the row-count bound key by key across all three layers', () => {
    const resolved = mergeLoadExpectation(
      {
        default: { rowCount: { minRows: 10, maxShrink: 0.9 } },
        byType: { Mvr: { rowCount: { maxShrink: 0.1 } } },
      },
      storedRow({ rowCount: { maxShrink: 0.4, maxGrowth: 3 } }),
      'Mvr',
    );

    expect(resolved.resolved.rowCount).toEqual({
      // The host's, over the operator's, over the house default's.
      maxShrink: 0.1,
      // Nobody above the operator mentioned growth, so the operator's stands.
      maxGrowth: 3,
      // Only the house default mentioned the floor, so it survives untouched.
      minRows: 10,
    });
    expect(resolved.rowCountFrom).toBe('host');
  });

  it('names the operator as the source when only the operator bounded the count', () => {
    const resolved = mergeLoadExpectation(
      { default: { rowCount: { minRows: 10 } } },
      storedRow({ rowCount: { maxShrink: 0.4 } }),
      'Mvr',
    );

    expect(resolved.rowCountFrom).toBe('stored');
    expect(rowCountBoundOf(resolved.resolved)).toEqual({ maxShrink: 0.4, minRows: 10 });
  });

  it('treats an empty rowCount object as saying nothing, so it locks nothing', () => {
    // `{}` reaching a host entry through a spread is not a statement, and a lock
    // on it would pin a field nobody set.
    const resolved = mergeLoadExpectation(
      { byType: { Mvr: { rowCount: {} } } },
      storedRow({ rowCount: { maxShrink: 0.4 } }),
      'Mvr',
    );

    expect(resolved.rowCountFrom).toBe('stored');
    expect(resolved.hostLocked.rowCount).toBe(false);
  });

  it('carries the stored row back whether or not it won anything', () => {
    // The screen prints who set it and when even when the host has overruled it,
    // which is the difference between "your edit is not applying" and silence.
    const stored = storedRow({ deletes: OPERATOR_SAYS });
    const resolved = mergeLoadExpectation(
      { byType: { Mvr: { deletes: HOST_SAYS } } },
      stored,
      'Mvr',
    );

    expect(resolved.stored).toEqual(stored);
    expect(resolved.typeName).toBe('Mvr');
  });

  it('is what expectationFor answers, with the middle layer empty', () => {
    // The host-only helper is not a second implementation of the rule; it is
    // this one with nothing stored. If it ever stops being that, this fails.
    const host: CatalogLoadExpectations = {
      default: { rowCount: { minRows: 10 } },
      byType: { Mvr: { deletes: HOST_SAYS } },
    };

    expect(expectationFor(host, 'Mvr')).toEqual(
      mergeLoadExpectation(host, undefined, 'Mvr').resolved,
    );
  });
});

/* ---------------------------------------------------------------------------
 * Sourcing: the async half, and the store that keeps none of it.
 * ------------------------------------------------------------------------- */

describe('resolveLoadExpectation: reaching the stored layer', () => {
  it('reads the row the operator stored', async () => {
    const rows = new Map([['Mvr', storedRow({ deletes: OPERATOR_SAYS })]]);

    const resolved = await resolveLoadExpectation(undefined, pipelineStore({ rows }), 'Mvr');

    expect(resolved.deletesFrom).toBe('stored');
    expect(resolved.resolved.deletes).toEqual(OPERATOR_SAYS);
  });

  it('behaves exactly as before on a store that keeps none of them', async () => {
    const store = pipelineStore({ keepsExpectations: false });

    const withStore = await resolveLoadExpectation(
      { default: { deletes: HOUSE_DEFAULT_SAYS } },
      store,
      'Mvr',
    );
    const withoutStore = await resolveLoadExpectation(
      { default: { deletes: HOUSE_DEFAULT_SAYS } },
      undefined,
      'Mvr',
    );

    expect(withStore).toEqual(withoutStore);
    expect(withStore.deletesFrom).toBe('default');
    expect(await storedExpectationFor(store, 'Mvr')).toBeUndefined();
  });

  it('answers with no stored layer when no store was bound at all', async () => {
    const resolved = await resolveLoadExpectation(undefined, undefined, 'Mvr');

    expect(resolved.deletesFrom).toBe('none');
    expect(resolved.stored).toBeUndefined();
  });
});

/* ---------------------------------------------------------------------------
 * What a write may say, and which fields the host owns.
 * ------------------------------------------------------------------------- */

describe('hostOwnedFields / hostLockedFields', () => {
  it('names only the fields the host declared for that very type', () => {
    const host: CatalogLoadExpectations = {
      byType: { Mvr: { deletes: HOST_SAYS } },
    };

    expect(hostOwnedFields(host, 'Mvr', { deletes: OPERATOR_SAYS })).toEqual(['deletes']);
    expect(hostOwnedFields(host, 'Mvr', { rowCount: { maxShrink: 0.4 } })).toEqual([]);
    expect(hostOwnedFields(host, 'Subwo', { deletes: OPERATOR_SAYS })).toEqual([]);
  });

  it('does not let a house-wide default own anything', () => {
    // The default is the weakest layer, so refusing a write because one exists
    // would refuse every write on a host that set one.
    const host: CatalogLoadExpectations = { default: { deletes: HOUSE_DEFAULT_SAYS } };

    expect(hostOwnedFields(host, 'Mvr', { deletes: OPERATOR_SAYS })).toEqual([]);
    expect(hostLockedFields(host, 'Mvr')).toEqual({ deletes: false, rowCount: false });
  });
});

describe('refuseInvalidLoadExpectation', () => {
  it('admits a complete declaration', () => {
    expect(
      refuseInvalidLoadExpectation({ deletes: OPERATOR_SAYS, rowCount: { maxShrink: 0.4 } }),
    ).toBeUndefined();
  });

  it('admits a write that only bounds the row count', () => {
    expect(refuseInvalidLoadExpectation({ rowCount: { maxGrowth: 10 } })).toBeUndefined();
  });

  it('refuses a strategy with no reason, naming the field', () => {
    const refusal = refuseInvalidLoadExpectation({
      deletes: { strategy: 'accepted', because: '   ' },
    });

    expect(refusal).toContain('because');
  });

  it('refuses a strategy outside the three', () => {
    const refusal = refuseInvalidLoadExpectation({
      deletes: { strategy: 'tombstones', because: 'off a change feed' },
    });

    expect(refusal).toContain('tombstones');
    expect(refusal).toContain('accepted');
  });

  it('refuses a periodic full reload with no interval', () => {
    const refusal = refuseInvalidLoadExpectation({
      deletes: { strategy: 'periodic-full-reload', because: 'nightly', withinMs: 0 },
    });

    expect(refusal).toContain('withinMs');
  });

  it('refuses a shrink bound outside (0, 1]', () => {
    expect(refuseInvalidLoadExpectation({ rowCount: { maxShrink: 0 } })).toContain('maxShrink');
    expect(refuseInvalidLoadExpectation({ rowCount: { maxShrink: 1.5 } })).toContain('maxShrink');
    expect(refuseInvalidLoadExpectation({ rowCount: { maxShrink: 1 } })).toBeUndefined();
  });

  it('refuses a growth bound of 1 or below', () => {
    expect(refuseInvalidLoadExpectation({ rowCount: { maxGrowth: 1 } })).toContain('maxGrowth');
    expect(refuseInvalidLoadExpectation({ rowCount: { maxGrowth: 1.1 } })).toBeUndefined();
  });

  it('refuses a body whose fields are not objects at all', () => {
    // It arrives off the wire, so the union in the type system binds nobody.
    expect(refuseInvalidLoadExpectation({ deletes: 'accepted' })).toContain('deletes');
    expect(refuseInvalidLoadExpectation({ rowCount: 0.5 })).toContain('rowCount');
  });
});

/* ---------------------------------------------------------------------------
 * The gates: both enforcement sites read all three layers.
 * ------------------------------------------------------------------------- */

function snapshot(over: Partial<SnapshotRef> & { id: string }): SnapshotRef {
  return {
    createdAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    rowCount: 0,
    principalId: 'ingest',
    ...over,
  };
}

function publisher(
  store: Record<string, unknown>,
  expectations: CatalogLoadExpectations | undefined,
  pipeline: CatalogPipelineStore | undefined,
): PublishService {
  const registry = { reload: () => Promise.resolve(), getType: () => TYPE };
  return new PublishService(
    () => {
      throw new Error('No EntityManager is needed on these paths.');
    },
    registry,
    Object.assign(Object.create(null), store),
    expectations,
    pipeline,
  );
}

function writeStore(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    capabilities: { snapshots: 'emulated', writable: true, timeTravel: true },
    write: vi.fn(),
    ensureType: vi.fn(),
    commit: vi.fn(() => Promise.resolve(snapshot({ id: 'today', rowCount: 1 }))),
    dropSnapshot: vi.fn(),
    read: vi.fn(),
    carryForward: vi.fn(() => Promise.resolve({ carried: 0, total: 0 })),
    listSnapshots: vi.fn(() => Promise.resolve([])),
    currentSnapshot: vi.fn(() => Promise.resolve(undefined)),
    ...over,
  };
}

describe('PublishService reads the stored layer at the deletes gate', () => {
  it('carries a snapshot forward once an operator has declared a strategy', async () => {
    // The whole point of the feature: nothing in code declares `Mvr`, and the
    // incremental load is legal because somebody said why through the API.
    const store = writeStore();
    const rows = new Map([['Mvr', storedRow({ deletes: OPERATOR_SAYS })]]);

    await publisher(store, undefined, pipelineStore({ rows })).carryForwardAsSystem(
      'ingest',
      'Mvr',
      'today',
      { source: 'connector' },
    );

    expect(store.carryForward).toHaveBeenCalledTimes(1);
  });

  it('still refuses when the stored row bounds row counts and says nothing about deletes', async () => {
    const store = writeStore();
    const rows = new Map([['Mvr', storedRow({ rowCount: { maxShrink: 0.4 } })]]);

    await expect(
      publisher(store, undefined, pipelineStore({ rows })).carryForwardAsSystem(
        'ingest',
        'Mvr',
        'today',
        { source: 'connector' },
      ),
    ).rejects.toBeInstanceOf(LoadExpectationError);
    expect(store.carryForward).not.toHaveBeenCalled();
  });

  it('enforces a host strategy over a stored one, interval and all', async () => {
    // The host says periodic-full-reload and the last full read is five days
    // old; the operator's stored `accepted` would have waved the load through.
    // The load is refused, which is the lock doing its job.
    const store = writeStore({
      listSnapshots: vi.fn(() =>
        Promise.resolve([
          snapshot({
            id: 'inc-1',
            createdAt: new Date(Date.now() - 5 * DAY).toISOString(),
            labels: { [CARRIED_FROM_LABEL]: 'inc-0' },
          }),
        ]),
      ),
    });
    const rows = new Map([['Mvr', storedRow({ deletes: OPERATOR_SAYS })]]);

    await expect(
      publisher(
        store,
        { byType: { Mvr: { deletes: HOUSE_DEFAULT_SAYS } } },
        pipelineStore({ rows }),
      ).carryForwardAsSystem('ingest', 'Mvr', 'today', { source: 'connector' }),
    ).rejects.toThrow(/full reload/);
    expect(store.carryForward).not.toHaveBeenCalled();
  });

  it('is unchanged on a store that keeps no expectations', async () => {
    const store = writeStore();

    await expect(
      publisher(store, undefined, pipelineStore({ keepsExpectations: false })).carryForwardAsSystem(
        'ingest',
        'Mvr',
        'today',
        { source: 'connector' },
      ),
    ).rejects.toBeInstanceOf(LoadExpectationError);
  });
});

describe('the scheduled run reads the stored layer too', () => {
  const connector = {
    id: 'c1',
    name: 'Nightly MVR',
    kind: 'sql' as const,
    targetType: 'Mvr',
    config: {},
    mode: 'incremental' as const,
    enabled: true,
    createdBy: 'someone',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  function steps(store: CatalogPipelineStore) {
    const run = vi.fn(() =>
      Promise.resolve({ id: 'r1', status: 'succeeded', logs: [], fetched: 1, written: 1 }),
    );
    const pipeline = { ...store, getConnector: () => Promise.resolve(connector) };
    const subject = new ConnectorRunSteps(
      Object.assign(Object.create(null), { run }),
      passthroughScope,
      pipeline,
      undefined,
    );
    return { subject, run };
  }

  const input = { connectorId: 'c1', principalId: 'scheduler', snapshotId: 'snap-1' };

  it('lets a nightly run proceed on a strategy an operator stored', async () => {
    // The preflight is the cheap gate before the source is read, and it is the
    // one a scheduled run meets first. Reading only the host object here would
    // refuse every night while the answer sat in the table the operator wrote
    // it to — the feature working everywhere except where it is used.
    const rows = new Map([['Mvr', storedRow({ deletes: OPERATOR_SAYS })]]);
    const { subject, run } = steps(pipelineStore({ rows }));

    await subject.runConnector(input);

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('still refuses it when nothing anywhere declares one', async () => {
    const { subject, run } = steps(pipelineStore({}));

    await expect(subject.runConnector(input)).rejects.toThrow(/deleted at the source/);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('PublishService reads the stored layer at the row-count gate', () => {
  const collapsing = (pending: number) =>
    writeStore({
      currentSnapshot: vi.fn(() => Promise.resolve(snapshot({ id: 'yesterday', rowCount: 1_000 }))),
      listSnapshots: vi.fn(() => Promise.resolve([snapshot({ id: 'today', rowCount: pending })])),
    });

  it('applies a bound an operator stored, where the built-in default would have admitted the load', async () => {
    // 400 of 1,000 is a 60% loss: past the operator's 0.2 and inside the
    // built-in 0.5, so a commit that goes through proves the stored layer was
    // never read.
    const store = collapsing(400);
    const rows = new Map([['Mvr', storedRow({ rowCount: { maxShrink: 0.2 } })]]);

    await expect(
      publisher(store, undefined, pipelineStore({ rows })).commitAsSystem('ingest', 'Mvr', 'today'),
    ).rejects.toBeInstanceOf(LoadExpectationError);
    expect(store.commit).not.toHaveBeenCalled();
  });

  it('lets a bound an operator relaxed admit a load the built-in default would refuse', async () => {
    // 100 of 1,000 is a 90% loss, refused at the built-in 0.5 and admitted at
    // the stored 0.95 — the other direction, so neither test can pass by the
    // bound simply being ignored.
    const store = collapsing(100);
    const rows = new Map([['Mvr', storedRow({ rowCount: { maxShrink: 0.95 } })]]);

    await publisher(store, undefined, pipelineStore({ rows })).commitAsSystem(
      'ingest',
      'Mvr',
      'today',
    );

    expect(store.commit).toHaveBeenCalledTimes(1);
  });

  it('lets the host bound beat the stored one', async () => {
    const store = collapsing(100);
    const rows = new Map([['Mvr', storedRow({ rowCount: { maxShrink: 0.95 } })]]);

    await expect(
      publisher(
        store,
        { byType: { Mvr: { rowCount: { maxShrink: 0.5 } } } },
        pipelineStore({ rows }),
      ).commitAsSystem('ingest', 'Mvr', 'today'),
    ).rejects.toBeInstanceOf(LoadExpectationError);
    expect(store.commit).not.toHaveBeenCalled();
  });
});
