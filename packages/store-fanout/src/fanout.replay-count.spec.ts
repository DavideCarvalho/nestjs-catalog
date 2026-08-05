import type {
  CatalogObjectTypeDef,
  CatalogPropertyDef,
  CatalogReadQuery,
  CatalogReadResult,
  CatalogStoreCapabilities,
  CatalogWriteStore,
  SnapshotRef,
} from '@dudousxd/nestjs-catalog';
import { describe, expect, it } from 'vitest';
import { FanoutCatalogStore } from './fanout.store';
import { InMemoryFanoutJournal } from './journal';
import { CatalogFanoutMigration } from './migration';

/**
 * What a replay reports having repaired, against what the ledger actually did.
 *
 * **The number is the whole subject.** `FanoutReplayResult.cleared` is read by
 * one person in one situation: an operator who has just looked at `status()`,
 * seen a follower owing N steps, run the documented repair, and is deciding
 * whether the follower is fixed. The one property that makes that number usable
 * is that it reconciles — that the ledger afterwards is shorter by exactly what
 * the repair claimed. It did not. The count was a sum of what two of the
 * repair's steps reported, and the commit at the end of a replay discharges
 * entries that neither of those steps can see: the follower's own held-back
 * `commit` entry, and every entry about a snapshot the follower has now moved
 * past.
 *
 * Undercounting is the safer of the two directions and is still a number that
 * does not add up, which is a slower and more corrosive failure than an obvious
 * one: nothing breaks, the operator is quietly taught that the tool's totals are
 * approximate, and the next total — the one that matters — is not read either.
 *
 * Fakes rather than engines, for the reason the file next door gives at length:
 * every property here is a property of this package's bookkeeping, and a real
 * MySQL cannot make "how many entries left the journal" more true.
 */

// ---------------------------------------------------------------------------
// Fixtures. Deliberately a second, smaller copy rather than an import from the
// repair spec: a fake shared between two files is a fake that grows a flag for
// each of them, and the failure this file needs to stage — a follower that
// refuses writes for two loads running — is one line of setup.
// ---------------------------------------------------------------------------

const CAPABILITIES: CatalogStoreCapabilities = {
  snapshots: 'emulated',
  writable: true,
  timeTravel: true,
  atomicCutover: true,
  atomicBatchReplace: true,
  transactional: true,
};

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

/** A store that holds snapshots in a Map and can be made to refuse writes. */
class FakeStore implements CatalogWriteStore {
  readonly capabilities = CAPABILITIES;
  /** Type names whose `write` throws — a follower that is behind on rows. */
  readonly refusesWritesFor = new Set<string>();

  private readonly batches = new Map<string, Map<number, Array<Record<string, unknown>>>>();
  private readonly served = new Map<string, string>();

  async ensureType(): Promise<void> {}

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
    return { written: incoming.length };
  }

  async commit(type: CatalogObjectTypeDef, snapshotId: string): Promise<SnapshotRef> {
    this.served.set(type.name, snapshotId);
    return {
      id: snapshotId,
      createdAt: new Date(0).toISOString(),
      rowCount: this.rowsOf(type.name, snapshotId).length,
      principalId: 'loader',
    };
  }

  async dropSnapshot(type: CatalogObjectTypeDef, snapshotId: string): Promise<void> {
    if (this.served.get(type.name) === snapshotId) {
      throw new Error(`${snapshotId} is the snapshot ${type.name} is being served from`);
    }
    this.batches.delete(`${type.name}:${snapshotId}`);
  }

  async read(
    type: CatalogObjectTypeDef,
    fields: string[],
    query: CatalogReadQuery,
  ): Promise<CatalogReadResult> {
    const snapshotId = query.snapshot ?? this.served.get(type.name);
    if (snapshotId === undefined) return { rows: [], total: 0 };
    const all = [...this.rowsOf(type.name, snapshotId)].sort((a, b) =>
      String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0,
    );
    const size = query.size ?? all.length;
    const page = query.page ?? 1;
    return {
      rows: all.slice((page - 1) * size, page * size).map((row) => {
        const picked: Record<string, unknown> = {};
        for (const field of fields) picked[field] = row[field];
        return picked;
      }),
      total: all.length,
    };
  }

  async listSnapshots(): Promise<SnapshotRef[]> {
    return [];
  }

  servedSnapshot(typeName: string): string | undefined {
    return this.served.get(typeName);
  }

  private rowsOf(typeName: string, snapshotId: string): Array<Record<string, unknown>> {
    const batches = this.batches.get(`${typeName}:${snapshotId}`);
    if (!batches) return [];
    return [...batches.keys()].sort((a, b) => a - b).flatMap((batch) => batches.get(batch) ?? []);
  }
}

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

describe('what a replay reports having cleared', () => {
  it('counts the held-back commit it discharges, not only the rows it supplied', async () => {
    // The plain case, and the one the old arithmetic got wrong every time it
    // ran. A follower that failed a write is *also* held back from the commit —
    // `commit` records that as an entry of its own, deliberately, so that a
    // follower serving a snapshot it holds only part of is impossible. So a
    // single failed load leaves two entries, the operator sees two on the status
    // screen, the replay repairs both, and the count said one.
    const type = fixtureType('Widget');
    const primary = new FakeStore();
    const follower = new FakeStore();
    follower.refusesWritesFor.add(type.name);
    const { journal, fanout, migration } = wire(primary, follower);

    await fanout.ensureType(type);
    await fanout.write(type, rows('a', 'b'), { snapshotId: 's1', principalId: 'loader' });
    await fanout.commit(type, 's1');

    const owed = await journal.outstanding({ follower: 'follower' });
    expect(owed.map((entry) => entry.stage).sort()).toEqual(['commit', 'write']);

    follower.refusesWritesFor.delete(type.name);
    const replayed = await migration.replay(type, 's1', 'follower');

    // Two entries were on the screen, two came off it, and the number says two.
    expect(replayed.cleared).toBe(2);
    expect(replayed.committed).toBe(true);
    expect(await journal.outstanding()).toEqual([]);
    expect(follower.servedSnapshot(type.name)).toBe('s1');
  });

  it('counts the entries about older snapshots the commit closes, and says they were closed', async () => {
    // The larger gap, and the one an operator is most likely to meet: a follower
    // that has been failing for more than one load. Committing the replayed
    // snapshot on it supersedes every entry about the loads it missed — the
    // follower serves the complete state of the type, so an entry saying it once
    // missed an older snapshot no longer describes anything a reader of it can
    // encounter. Four lines leave the ledger and the count said one.
    //
    // They are counted and then distinguished in a note, rather than left out.
    // "Entries that were on the screen and are not now" is the question the
    // number answers; whether data moved for each of them is a different
    // question, and the note is where it is answered — closing an entry about
    // s0 is not the same act as replaying s1, and an operator reading four
    // should not have to guess which of them were which.
    const type = fixtureType('Gadget');
    const primary = new FakeStore();
    const follower = new FakeStore();
    follower.refusesWritesFor.add(type.name);
    const { journal, fanout, migration } = wire(primary, follower);

    await fanout.ensureType(type);
    for (const snapshotId of ['s0', 's1']) {
      await fanout.write(type, rows('a', 'b'), { snapshotId, principalId: 'loader' });
      await fanout.commit(type, snapshotId);
    }
    expect(await journal.outstanding({ follower: 'follower' })).toHaveLength(4);

    follower.refusesWritesFor.delete(type.name);
    const replayed = await migration.replay(type, 's1', 'follower');

    expect(replayed.cleared).toBe(4);
    expect(await journal.outstanding()).toEqual([]);

    const note = replayed.notes.find((line) => line.includes('closed rather than repaired'));
    expect(note).toBeDefined();
    expect(note).toContain('2 of the 4');
    expect(note).toContain('s0');
  });

  it('counts only what a staged replay actually discharged, not everything that was owed', async () => {
    // The guard on the other side of the fix, and the reason the count is taken
    // by reading the ledger rather than by assuming the repair worked. A replay
    // that stages without committing — the default whenever the snapshot is not
    // the one the primary is serving, and what `commit: false` asks for
    // explicitly — supplies the rows and nothing else: the follower's own
    // held-back `commit` entry stays owed, and so does everything about the loads
    // it missed, because nothing superseded them.
    //
    // This one passes on the unfixed code too. It is here because "count what
    // this follower owed when we started" and "count what actually left the
    // ledger" agree on every replay that runs to a commit, and part company
    // exactly here — so without it, the cheapest wrong fix for the undercount is
    // indistinguishable from the right one, and it overstates a staged repair by
    // three quarters.
    const type = fixtureType('Staged');
    const primary = new FakeStore();
    const follower = new FakeStore();
    follower.refusesWritesFor.add(type.name);
    const { journal, fanout, migration } = wire(primary, follower);

    await fanout.ensureType(type);
    for (const snapshotId of ['s0', 's1']) {
      await fanout.write(type, rows('a', 'b'), { snapshotId, principalId: 'loader' });
      await fanout.commit(type, snapshotId);
    }
    expect(await journal.outstanding({ follower: 'follower' })).toHaveLength(4);

    follower.refusesWritesFor.delete(type.name);
    const replayed = await migration.replay(type, 's1', 'follower', { commit: false });

    expect(replayed.committed).toBe(false);
    expect(replayed.cleared).toBe(1);
    // And the three it did not: the commit it declined to make, and both entries
    // about s0 that only a commit on this follower could have closed.
    expect(await journal.outstanding({ follower: 'follower' })).toHaveLength(3);
    expect(replayed.notes.join(' ')).not.toContain('closed rather than repaired');
  });

  it('reports nothing cleared when the follower owed nothing', async () => {
    // The other way a count lies, pinned so that fixing the undercount does not
    // buy an overcount. A replay announces every step it takes to the journal
    // before attempting it — that is what makes a crash mid-repair legible — so
    // entries appear and vanish during a replay of a follower that was never
    // behind. A count that looked at what the journal did rather than at what
    // the follower owed would report those transients as repairs, and a repair
    // claiming to have fixed three things on a healthy follower is worse than
    // one that undercounts: it invents a fault.
    const type = fixtureType('Sprocket');
    const primary = new FakeStore();
    const follower = new FakeStore();
    const { journal, fanout, migration } = wire(primary, follower);

    // Two clean loads, and the older one replayed: a follower that is up to date
    // will not let go of the snapshot it is serving, so re-sending the current
    // one to a healthy follower is not a thing that can happen. Backfilling an
    // older snapshot is, and it is the same question — a repair run against a
    // follower that owed nothing must say it repaired nothing.
    await fanout.ensureType(type);
    for (const snapshotId of ['s1', 's2']) {
      await fanout.write(type, rows('a'), { snapshotId, principalId: 'loader' });
      await fanout.commit(type, snapshotId);
    }
    expect(await journal.outstanding()).toEqual([]);

    const replayed = await migration.replay(type, 's1', 'follower');

    expect(replayed.cleared).toBe(0);
    expect(replayed.notes.join(' ')).not.toContain('closed rather than repaired');
    expect(await journal.outstanding()).toEqual([]);
  });
});
