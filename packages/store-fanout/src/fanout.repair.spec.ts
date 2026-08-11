import type {
  CarryForwardResult,
  CatalogObjectTypeDef,
  CatalogPropertyDef,
  CatalogQueryRelation,
  CatalogQueryRequest,
  CatalogQueryResult,
  CatalogReadQuery,
  CatalogReadResult,
  CatalogStoreCapabilities,
  CatalogWriteStore,
  SnapshotRef,
} from '@dudousxd/nestjs-catalog';
import { describe, expect, it } from 'vitest';
import { composeCapabilities, explainCapabilities } from './capabilities';
import { CatalogFanoutError, FanoutCatalogStore, PROBED_STORE_METHODS } from './fanout.store';
import { FANOUT_SCHEMA_SCOPE, InMemoryFanoutJournal } from './journal';
import { CatalogFanoutMigration } from './migration';

/**
 * The three repairs, checked without an engine underneath.
 *
 * **Why fakes here, when the contract suite insists on real databases.** The
 * `*.db.spec.ts` beside this file runs the fan-out over two MySQL schemas, and it
 * is right to: the properties it pins — a snapshot staying invisible until it
 * commits, a re-sent batch replacing rather than appending — are properties of
 * the SQL an adapter emits, and a fake passes them by construction.
 *
 * Nothing in this file is such a property. What is checked here is the fan-out's
 * own bookkeeping: which journal entries a repair discharges, which optional
 * methods it forwards, and what it composes out of two capability objects. A
 * real engine cannot make any of those more true, and it can make two of them
 * impossible to set up — the schema failure this file turns on and off at will
 * is, against MySQL, a table dropped out from under a store that caches which
 * tables it has reconciled, which is a one-way door per process.
 */

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

function property(name: string, primary: boolean): CatalogPropertyDef {
  return {
    name,
    displayName: name,
    type: 'string',
    columnName: name,
    nullable: false,
    primary,
    hidden: false,
    order: primary ? 0 : 1,
    enriched: false,
  };
}

function fixtureType(name: string): CatalogObjectTypeDef {
  return {
    name,
    displayName: name,
    pluralDisplayName: `${name}s`,
    tableName: `obj_${name.toLowerCase()}`,
    group: 'Test',
    primaryKey: ['id'],
    enriched: false,
    properties: [property('id', true), property('label', false)],
    relations: [],
  };
}

function rows(...ids: string[]): Array<Record<string, unknown>> {
  return ids.map((id) => ({ id, label: `${id}-label` }));
}

const FULL_CAPABILITIES: CatalogStoreCapabilities = {
  snapshots: 'emulated',
  writable: true,
  timeTravel: true,
  atomicCutover: true,
  atomicBatchReplace: true,
  transactional: true,
};

/**
 * A store that holds snapshots in a Map and can be made to refuse a schema.
 *
 * `ensureType` and `write` fail independently, which is the combination the
 * schema scope exists for: a follower whose table is a column short takes a load
 * that happens not to touch that column, so the writes succeed and the only
 * record that anything is wrong is the schema-scoped journal entry.
 */
class FakeCatalogStore implements CatalogWriteStore {
  readonly capabilities: CatalogStoreCapabilities;
  /** Type names whose `ensureType` throws until the operator "fixes" the store. */
  readonly refusesSchemaFor = new Set<string>();
  /** Type names whose `write` throws — a follower that is behind on rows only. */
  readonly refusesWritesFor = new Set<string>();

  /** `type:snapshot` -> batch -> rows. */
  private readonly batches = new Map<string, Map<number, Array<Record<string, unknown>>>>();
  private readonly meta = new Map<string, { createdAt: string; principalId: string }>();
  private readonly served = new Map<string, string>();
  /** Snapshot ids per type, oldest first, so `listSnapshots` can answer newest first. */
  private readonly order = new Map<string, string[]>();

  constructor(capabilities: Partial<CatalogStoreCapabilities> = {}) {
    this.capabilities = { ...FULL_CAPABILITIES, ...capabilities };
  }

  async ensureType(type: CatalogObjectTypeDef): Promise<void> {
    if (this.refusesSchemaFor.has(type.name)) {
      throw new Error(`no column "label" on ${type.tableName}`);
    }
  }

  async write(
    type: CatalogObjectTypeDef,
    incoming: Array<Record<string, unknown>>,
    options: { snapshotId: string; principalId: string; batch?: number },
  ): Promise<{ written: number }> {
    if (this.refusesWritesFor.has(type.name)) {
      throw new Error(`no table ${type.tableName}`);
    }
    const key = `${type.name}:${options.snapshotId}`;
    const existing = this.batches.get(key) ?? new Map<number, Array<Record<string, unknown>>>();
    existing.set(
      options.batch ?? 0,
      incoming.map((row) => ({ ...row })),
    );
    this.batches.set(key, existing);
    if (!this.meta.has(key)) {
      this.meta.set(key, {
        createdAt: new Date().toISOString(),
        principalId: options.principalId,
      });
      const ids = this.order.get(type.name) ?? [];
      ids.push(options.snapshotId);
      this.order.set(type.name, ids);
    }
    return { written: incoming.length };
  }

  async commit(type: CatalogObjectTypeDef, snapshotId: string): Promise<SnapshotRef> {
    this.served.set(type.name, snapshotId);
    return this.refFor(type.name, snapshotId);
  }

  async dropSnapshot(type: CatalogObjectTypeDef, snapshotId: string): Promise<void> {
    if (this.served.get(type.name) === snapshotId) {
      throw new Error(`${snapshotId} is the snapshot ${type.name} is being served from`);
    }
    this.batches.delete(`${type.name}:${snapshotId}`);
    this.meta.delete(`${type.name}:${snapshotId}`);
    this.order.set(
      type.name,
      (this.order.get(type.name) ?? []).filter((id) => id !== snapshotId),
    );
  }

  async currentSnapshot(type: CatalogObjectTypeDef): Promise<SnapshotRef | undefined> {
    const snapshotId = this.served.get(type.name);
    if (snapshotId === undefined) return undefined;
    return this.refFor(type.name, snapshotId);
  }

  async listSnapshots(type: CatalogObjectTypeDef): Promise<SnapshotRef[]> {
    return [...(this.order.get(type.name) ?? [])]
      .reverse()
      .map((snapshotId) => this.refFor(type.name, snapshotId));
  }

  async read(
    type: CatalogObjectTypeDef,
    fields: string[],
    query: CatalogReadQuery,
  ): Promise<CatalogReadResult> {
    const snapshotId = query.snapshot ?? this.served.get(type.name);
    if (snapshotId === undefined) return { rows: [], total: 0 };
    const all = this.rowsOf(type.name, snapshotId);
    const sort = query.sort;
    const sorted = sort === undefined ? all : [...all].sort((a, b) => compare(a[sort], b[sort]));
    if (query.dir === 'desc') sorted.reverse();
    const size = query.size ?? sorted.length;
    const page = query.page ?? 1;
    const window = sorted.slice((page - 1) * size, page * size);
    return {
      rows: window.map((row) => project(row, fields)),
      total: sorted.length,
    };
  }

  /** Whatever this store is serving, for an assertion that reads like the screen. */
  servedSnapshot(typeName: string): string | undefined {
    return this.served.get(typeName);
  }

  /** Force a rollback: serve a snapshot that is not the newest one written. */
  serveSnapshot(typeName: string, snapshotId: string): void {
    this.served.set(typeName, snapshotId);
  }

  private rowsOf(typeName: string, snapshotId: string): Array<Record<string, unknown>> {
    const batches = this.batches.get(`${typeName}:${snapshotId}`);
    if (!batches) return [];
    return [...batches.keys()].sort((a, b) => a - b).flatMap((batch) => batches.get(batch) ?? []);
  }

  private refFor(typeName: string, snapshotId: string): SnapshotRef {
    const meta = this.meta.get(`${typeName}:${snapshotId}`);
    return {
      id: snapshotId,
      createdAt: meta?.createdAt ?? new Date(0).toISOString(),
      rowCount: this.rowsOf(typeName, snapshotId).length,
      principalId: meta?.principalId ?? 'unknown',
    };
  }
}

/**
 * A store implementing every optional method the ecosystem probes for.
 *
 * Composition rather than a subclass with the extras bolted on, so the plain
 * fake stays exactly as capable as it looks.
 */
class RichCatalogStore implements CatalogWriteStore {
  readonly capabilities: CatalogStoreCapabilities;

  constructor(private readonly inner = new FakeCatalogStore()) {
    this.capabilities = inner.capabilities;
  }

  ensureType(type: CatalogObjectTypeDef): Promise<void> {
    return this.inner.ensureType(type);
  }
  write(
    type: CatalogObjectTypeDef,
    incoming: Array<Record<string, unknown>>,
    options: { snapshotId: string; principalId: string; batch?: number },
  ): Promise<{ written: number }> {
    return this.inner.write(type, incoming, options);
  }
  commit(type: CatalogObjectTypeDef, snapshotId: string): Promise<SnapshotRef> {
    return this.inner.commit(type, snapshotId);
  }
  dropSnapshot(type: CatalogObjectTypeDef, snapshotId: string): Promise<void> {
    return this.inner.dropSnapshot(type, snapshotId);
  }
  read(
    type: CatalogObjectTypeDef,
    fields: string[],
    query: CatalogReadQuery,
  ): Promise<CatalogReadResult> {
    return this.inner.read(type, fields, query);
  }
  listSnapshots(type: CatalogObjectTypeDef): Promise<SnapshotRef[]> {
    return this.inner.listSnapshots(type);
  }
  async listSnapshotsWithRows(type: CatalogObjectTypeDef, limit?: number): Promise<SnapshotRef[]> {
    const live = (await this.inner.listSnapshots(type)).filter(
      (snapshot) => snapshot.droppedAt === undefined,
    );
    return limit === undefined ? live : live.slice(0, limit);
  }
  async findSnapshot(
    type: CatalogObjectTypeDef,
    snapshotId: string,
  ): Promise<SnapshotRef | undefined> {
    return (await this.inner.listSnapshots(type)).find((snapshot) => snapshot.id === snapshotId);
  }
  currentSnapshot(type: CatalogObjectTypeDef): Promise<SnapshotRef | undefined> {
    return this.inner.currentSnapshot(type);
  }
  async carryForward(): Promise<CarryForwardResult> {
    return { carried: 0, total: 0 };
  }
  async runQuery(_request: CatalogQueryRequest): Promise<CatalogQueryResult> {
    return { columns: [], rows: [], rowCount: 0, truncated: false, elapsedMs: 0 };
  }
  async queryRelations(): Promise<CatalogQueryRelation[]> {
    return [];
  }
  async *streamQuery(): AsyncGenerator<Record<string, unknown>> {
    yield { n: 1 };
  }
}

/** A store offering nothing beyond the required members. */
class BareCatalogStore implements CatalogWriteStore {
  readonly capabilities: CatalogStoreCapabilities;

  constructor(private readonly inner = new FakeCatalogStore()) {
    this.capabilities = inner.capabilities;
  }

  ensureType(type: CatalogObjectTypeDef): Promise<void> {
    return this.inner.ensureType(type);
  }
  write(
    type: CatalogObjectTypeDef,
    incoming: Array<Record<string, unknown>>,
    options: { snapshotId: string; principalId: string; batch?: number },
  ): Promise<{ written: number }> {
    return this.inner.write(type, incoming, options);
  }
  commit(type: CatalogObjectTypeDef, snapshotId: string): Promise<SnapshotRef> {
    return this.inner.commit(type, snapshotId);
  }
  dropSnapshot(type: CatalogObjectTypeDef, snapshotId: string): Promise<void> {
    return this.inner.dropSnapshot(type, snapshotId);
  }
  read(
    type: CatalogObjectTypeDef,
    fields: string[],
    query: CatalogReadQuery,
  ): Promise<CatalogReadResult> {
    return this.inner.read(type, fields, query);
  }
}

function project(row: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const field of fields) picked[field] = row[field];
  return picked;
}

function compare(a: unknown, b: unknown): number {
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

/** Primary, one `recorded` follower, a journal and a migration over them. */
function wire(primary: CatalogWriteStore, follower: CatalogWriteStore) {
  const journal = new InMemoryFanoutJournal();
  const fanout = new FanoutCatalogStore(
    { name: 'primary', store: primary },
    [{ name: 'follower', store: follower, strictness: 'recorded' }],
    journal,
  );
  return { journal, fanout, migration: new CatalogFanoutMigration(fanout) };
}

// ---------------------------------------------------------------------------
// 1. A schema failure the documented repair could never clear.
// ---------------------------------------------------------------------------

describe('a follower that refused a schema change', () => {
  it('is unblocked by a replay, and takes the next load it is offered', async () => {
    // The whole failure, end to end, from the operator's side. A follower that
    // failed `ensureType` owes an entry under the schema scope; `outstandingFor`
    // folds that scope into every snapshot, so the follower is held back from
    // every commit from then on. The documented repair is a replay — and the
    // replay called `ensureType` on the follower directly, outside the journal,
    // so the one call that could have discharged the entry was the one that
    // bypassed the ledger. `cleared` came back as a number, the operator read it
    // as progress, and the very next load held the follower back again.
    const type = fixtureType('Widget');
    const primary = new FakeCatalogStore();
    const follower = new FakeCatalogStore();
    follower.refusesSchemaFor.add(type.name);
    const { journal, fanout, migration } = wire(primary, follower);

    await fanout.ensureType(type);
    const schemaDebt = await journal.outstanding({ follower: 'follower' });
    expect(schemaDebt.map((entry) => entry.stage)).toEqual(['ensureType']);
    expect(schemaDebt[0]?.snapshotId).toBe(FANOUT_SCHEMA_SCOPE);

    // The load itself lands on both stores — this type's rows do not touch the
    // column the follower is missing — so the schema entry is the only thing
    // standing between the follower and the commit.
    await fanout.write(type, rows('a', 'b'), { snapshotId: 's1', principalId: 'loader' });
    await fanout.commit(type, 's1');
    expect(primary.servedSnapshot(type.name)).toBe('s1');
    expect(follower.servedSnapshot(type.name)).toBeUndefined();

    // The operator fixes the follower and runs the documented repair.
    follower.refusesSchemaFor.delete(type.name);
    const replayed = await migration.replay(type, 's1', 'follower');

    // Two debts: the schema one, and the commit this follower was held back
    // from because of it. Before the schema fix this was zero — the count was
    // honest and the repair did nothing. It then read one for a while, which was
    // the schema debt counted and the held-back commit not, because the count
    // was a sum of what two of the repair's steps reported and the commit is a
    // third step that reported nothing. See `fanout.replay-count.spec.ts`.
    expect(replayed.cleared).toBe(2);
    expect(replayed.committed).toBe(true);
    expect(replayed.comparison.matches).toBe(true);
    expect(await journal.outstanding()).toEqual([]);

    // And the proof that the repair *repaired* something, rather than that a
    // number changed: the next load commits on the follower. Deliberately
    // without another `ensureType`, because a loader that publishes its schema
    // once at boot never calls it again — and if it did, the schema debt would
    // clear itself and the replay would not be the thing under test.
    await fanout.write(type, rows('a', 'b', 'c'), { snapshotId: 's2', principalId: 'loader' });
    await fanout.commit(type, 's2');
    expect(follower.servedSnapshot(type.name)).toBe('s2');

    const gate = await migration.verify({ types: [type] });
    expect(gate.reasons).toEqual([]);
    expect(gate.ready).toBe(true);
  });

  it('writes the repair down when it fails, and clears nothing', async () => {
    // The other half of the same seam. A replay whose `ensureType` still fails
    // has learnt something — the follower is still refusing the schema, on this
    // attempt, at this time — and going through the journal is what makes that a
    // record instead of a stack trace in somebody's terminal. It also refuses in
    // this package's own error type, which is what a caller catches.
    const type = fixtureType('Gadget');
    const primary = new FakeCatalogStore();
    const follower = new FakeCatalogStore();
    follower.refusesSchemaFor.add(type.name);
    const { journal, fanout, migration } = wire(primary, follower);

    await fanout.ensureType(type);
    await fanout.write(type, rows('a'), { snapshotId: 's1', principalId: 'loader' });
    await fanout.commit(type, 's1');

    await expect(migration.replay(type, 's1', 'follower')).rejects.toThrow(CatalogFanoutError);

    const owed = await journal.outstanding({ follower: 'follower' });
    const schema = owed.find((entry) => entry.stage === 'ensureType');
    expect(schema?.status).toBe('failed');
    // Two attempts: the original load's and the repair's. A repair that leaves
    // the count at one is a repair that did not happen as far as the ledger is
    // concerned, and "this follower has refused the same schema nine times" is a
    // different situation from "it refused once".
    expect(schema?.attempts).toBe(2);
  });

  it('does not count a schema debt the follower never owed', async () => {
    // The other way a repair lies. This one is not hypothetical either: the
    // count is what an operator reads before deciding a follower is fixed, so a
    // repair that adds to its own total on the strength of having run is a
    // repair whose total cannot be used for anything. This follower took the
    // schema and only missed the rows, so a replay has exactly one debt to
    // discharge — and the schema call it makes on the way past has nothing to
    // report.
    const type = fixtureType('RowsOnly');
    const primary = new FakeCatalogStore();
    const follower = new FakeCatalogStore();
    follower.refusesWritesFor.add(type.name);
    const { journal, fanout, migration } = wire(primary, follower);

    await fanout.ensureType(type);
    await fanout.write(type, rows('a', 'b'), { snapshotId: 's1', principalId: 'loader' });
    await fanout.commit(type, 's1');
    expect((await journal.outstanding()).map((entry) => entry.stage).sort()).toEqual([
      'commit',
      'write',
    ]);

    follower.refusesWritesFor.delete(type.name);
    const replayed = await migration.replay(type, 's1', 'follower');

    // Two, and neither of them the schema: the failed write, and the commit the
    // follower was held back from because of it — which are exactly the two
    // entries asserted on above. The schema call this replay makes on the way
    // past still has nothing to report, which is what this case is about.
    expect(replayed.cleared).toBe(2);
    expect(replayed.notes.join(' ')).not.toContain('failed schema change');
    expect(await journal.outstanding()).toEqual([]);
  });

  it('does not let clearDebt discharge a schema entry on the strength of copied rows', async () => {
    // The repair that was not taken, pinned so it is not taken later. Widening
    // `clearDebt` to sweep the schema scope would have made the symptom go away
    // and left the follower with a table that is still a column short — and the
    // next load would write into it happily. A journal that can be cleared
    // without the evidence having arrived is a journal whose entries mean
    // nothing.
    const type = fixtureType('Sprocket');
    const primary = new FakeCatalogStore();
    const follower = new FakeCatalogStore();
    follower.refusesSchemaFor.add(type.name);
    const { journal, fanout } = wire(primary, follower);

    await fanout.ensureType(type);
    const cleared = await fanout.clearDebt(type.name, 's1', 'follower', [
      'ensureType',
      'write',
      'carryForward',
    ]);

    expect(cleared).toBe(0);
    expect((await journal.outstanding()).map((entry) => entry.stage)).toEqual(['ensureType']);
  });
});

// ---------------------------------------------------------------------------
// 2. The capability fields a fan-out used to drop on the floor.
// ---------------------------------------------------------------------------

describe('composed capabilities', () => {
  const named = (name: string, capabilities: Partial<CatalogStoreCapabilities>) => ({
    name,
    capabilities: { ...FULL_CAPABILITIES, ...capabilities },
  });

  it('carries the atomicity fields through when every store declares them', () => {
    // The plain omission. Both real adapters populate all three; a fan-out that
    // returns only `{ snapshots, writable, timeTravel }` reports the other three
    // as absent, and the contract says absent must be read as false. So a caller
    // doing exactly what it was told got the pessimistic answer with nothing to
    // blame for it.
    const composed = composeCapabilities(named('mysql', {}), [named('clickhouse', {})]);

    expect(composed.atomicCutover).toBe(true);
    expect(composed.atomicBatchReplace).toBe(true);
    expect(composed.transactional).toBe(true);
  });

  it('takes the weakest answer, and says which follower cost it', () => {
    const primary = named('clickhouse', {});
    const follower = named('mysql', { atomicBatchReplace: false });
    const composed = composeCapabilities(primary, [follower]);

    expect(composed.atomicBatchReplace).toBe(false);
    expect(composed.atomicCutover).toBe(true);

    const reasons = explainCapabilities(primary, [follower], composed);
    const sentence = reasons.find((reason) => reason.startsWith('Atomic batch replace'));
    expect(sentence).toBeDefined();
    expect(sentence).toContain('mysql (declares it does not)');
    expect(sentence).toContain('clickhouse');
  });

  it('keeps "nobody said" apart from "measured, and it does not hold"', () => {
    // Three values, not two. Composing an unstated field down to `false` would
    // write a guess into the same shape a measurement lives in, which is the
    // mistake the core package's docblock is about — and there is no way back
    // from it for whoever composes these next.
    const primary = named('mysql', {});
    const follower = named('legacy', {
      atomicCutover: undefined,
      atomicBatchReplace: undefined,
      transactional: undefined,
    });
    const composed = composeCapabilities(primary, [follower]);

    expect('atomicCutover' in composed).toBe(false);
    expect(composed.atomicCutover).toBeUndefined();

    const reasons = explainCapabilities(primary, [follower], composed);
    const sentence = reasons.find((reason) => reason.startsWith('Atomic cutover'));
    expect(sentence).toContain('not stated');
    expect(sentence).toContain('legacy (does not say)');
  });

  it('says nothing at boot when no follower cost anything', () => {
    const primary = named('mysql', {});
    const composed = composeCapabilities(primary, [named('clickhouse', {})]);
    expect(explainCapabilities(primary, [named('clickhouse', {})], composed)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. The optional methods a fan-out forwards, and the ones it must not invent.
// ---------------------------------------------------------------------------

describe('optional methods behind a fan-out', () => {
  it('forwards every method the ecosystem probes for, when the primary has it', async () => {
    // Driven by the list the type checker keeps complete, so a method added to
    // `CatalogWriteStore` tomorrow is checked here without anybody remembering
    // to add it. `currentSnapshot` was the one missing: a MySQL primary, which
    // implements it, reported through a fan-out that it could not say which
    // snapshot it was serving — and the replay's fallback for that is a guess
    // the core package calls "not survivable".
    const { fanout } = wire(new RichCatalogStore(), new FakeCatalogStore());

    for (const method of PROBED_STORE_METHODS) {
      expect(typeof Reflect.get(fanout, method)).toBe('function');
    }
  });

  it('answers currentSnapshot from the primary, because the primary decides', async () => {
    const type = fixtureType('Pointer');
    const primary = new FakeCatalogStore();
    const follower = new FakeCatalogStore();
    const { fanout } = wire(primary, follower);

    await fanout.ensureType(type);
    await fanout.write(type, rows('a'), { snapshotId: 's1', principalId: 'loader' });
    await fanout.commit(type, 's1');

    expect((await fanout.currentSnapshot?.(type))?.id).toBe('s1');
  });

  it('offers none of them when the primary offers none of them', () => {
    // The absence is load-bearing in the other direction. The core package asks
    // whether a store can do these things by looking for the method, so a fan-out
    // that always carried them would answer yes on behalf of a primary that
    // cannot, and the refusal that belongs at the connector would surface as an
    // engine error underneath.
    const { fanout } = wire(new BareCatalogStore(), new BareCatalogStore());

    for (const method of PROBED_STORE_METHODS) {
      expect(method in fanout).toBe(false);
    }
  });

  it('asks the primary which snapshot it serves rather than guessing the newest', async () => {
    // The consequence of the omission, at the place that suffers it. With no
    // commit mark — a fan-out installed over an existing catalog — the default
    // snapshot fell straight through to newest-in-`listSnapshots`. That is the
    // right answer until somebody rolls a bad load back by committing an older
    // snapshot again, which is precisely the situation a comparison is being run
    // in.
    const type = fixtureType('RolledBack');
    const primary = new FakeCatalogStore();
    const follower = new FakeCatalogStore();

    for (const snapshotId of ['old', 'bad']) {
      await primary.write(type, rows('a'), { snapshotId, principalId: 'loader' });
      await follower.write(type, rows('a'), { snapshotId, principalId: 'loader' });
      await primary.commit(type, snapshotId);
      await follower.commit(type, snapshotId);
    }
    primary.serveSnapshot(type.name, 'old');
    follower.serveSnapshot(type.name, 'old');
    expect((await primary.listSnapshots(type))[0]?.id).toBe('bad');

    // A journal that has never seen a commit, which is the whole point: this is
    // the path taken when the fan-out cannot answer from its own records.
    const { migration } = wire(primary, follower);
    const [comparison] = await migration.compare(type);

    expect(comparison?.snapshotId).toBe('old');
  });
});
