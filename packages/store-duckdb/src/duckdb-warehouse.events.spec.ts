import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CatalogObjectTypeDef } from '@dudousxd/nestjs-catalog';
import { CATALOG_EVENTS, channelNameFor } from '@dudousxd/nestjs-catalog';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contractRow, contractType } from '../../../test/catalog-store-contract';
import { DuckDbWarehouseStore } from './duckdb-warehouse.store';

/**
 * That a load through this store reaches a subscriber, and says the same things the MikroORM
 * sibling's does.
 *
 * The store interface does not carry event emission, so nothing in the type system pairs an
 * adapter with the trail it owes. That gap is what these cases close for this adapter: a host
 * that develops against `store-mikro-orm` and deploys on this one gets the same events, and a
 * `snapshot.committed` subscriber driving retention fires on both.
 *
 * Asserted through a real `node:diagnostics_channel` subscriber rather than a spy on
 * `emitCatalog`, for the reason the core package's audit specs give: a spy passes on an event
 * name nothing subscribes to, which is a trail that reaches nobody. {@link Recorder} below
 * subscribes exactly the way the shipped `CatalogAuditRecorder` does — by iterating
 * `CATALOG_EVENTS` — so an event emitted under a name absent from that list arrives here
 * exactly as it would arrive in production: not at all.
 */

interface Recorded {
  event: string;
  payload: Record<string, unknown>;
}

/** The shipped recorder's contract restated: subscribe to every name in `CATALOG_EVENTS`. */
class Recorder {
  readonly events: Recorded[] = [];
  private readonly handlers = new Map<string, (message: unknown) => void>();

  constructor() {
    for (const event of CATALOG_EVENTS) {
      const channel = channelNameFor(event);
      const handler = (message: unknown): void => {
        const envelope = message && typeof message === 'object' ? message : {};
        const raw = Reflect.get(envelope, 'payload');
        const payload = raw && typeof raw === 'object' ? raw : {};
        this.events.push({ event, payload: { ...payload } });
      };
      subscribe(channel, handler);
      this.handlers.set(channel, handler);
    }
  }

  of(event: string): Array<Record<string, unknown>> {
    return this.events.filter((recorded) => recorded.event === event).map((each) => each.payload);
  }

  stop(): void {
    for (const [channel, handler] of this.handlers) unsubscribe(channel, handler);
    this.handlers.clear();
  }
}

let root: string;
let store: DuckDbWarehouseStore;
let recorder: Recorder;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'catalog-duckdb-events-'));
  store = new DuckDbWarehouseStore({ root });
  recorder = new Recorder();
});

afterEach(async () => {
  recorder.stop();
  await store.close();
  rmSync(root, { recursive: true, force: true });
});

/** One batch of `rows` staged under `snapshotId`, with the type made known first. */
async function load(
  name: string,
  snapshotId: string,
  ids: string[],
  batch = 0,
): Promise<CatalogObjectTypeDef> {
  const type = contractType(name);
  await store.ensureType(type);
  await store.write(
    type,
    ids.map((id, index) => contractRow(id, id.toUpperCase(), index)),
    { snapshotId, principalId: 'tester', batch },
  );
  return type;
}

describe('snapshot.written', () => {
  it('fires per batch, carrying the rows that batch took', async () => {
    // Per batch and not per load, matching the event's declared meaning in the core package
    // ("fires per batch, so a large load emits many") and the MikroORM sibling's placement.
    // The counts are each call's own, never the snapshot's running total — a subscriber
    // summing these across a load has to arrive at the load's size.
    const type = await load('WrittenPerBatch', 'run-1', ['a']);
    await store.write(type, [contractRow('b', 'B', 1), contractRow('c', 'C', 2)], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 1,
    });

    expect(recorder.of('snapshot.written')).toEqual([
      { typeName: 'WrittenPerBatch', snapshotId: 'run-1', principalId: 'tester', rows: 1 },
      { typeName: 'WrittenPerBatch', snapshotId: 'run-1', principalId: 'tester', rows: 2 },
    ]);
  });

  it('fires for a batch of no rows, which is a write that happened', async () => {
    // An empty batch still produces a Parquet object here — see `write`'s own docblock on why
    // the empty case is not special-cased — so the trail says a batch landed. A subscriber
    // reconstructing a load from these must not have the object on disk and the trail
    // disagreeing about whether anything was written.
    const type = contractType('WrittenEmpty');
    await store.ensureType(type);
    await store.write(type, [], { snapshotId: 'run-1', principalId: 'tester' });

    expect(recorder.of('snapshot.written')).toEqual([
      { typeName: 'WrittenEmpty', snapshotId: 'run-1', principalId: 'tester', rows: 0 },
    ]);
  });

  it('is also what a carry-forward reports, carrying the rows it merged in', async () => {
    // `snapshot.written` rather than an event of its own, which is the MikroORM sibling's own
    // choice and its stated reason: rows landed in a snapshot, which is what the event means.
    // The count is the carried rows alone — not the snapshot's total afterwards — so a
    // lineage feed can say how much of an incremental load came from the previous one.
    // The previous snapshot holds three rows and the incremental batch replaces one of them,
    // so the merge carries two. Those numbers are chosen to differ: with a one-row previous
    // snapshot the carry-forward's event and the batch's own event have byte-identical
    // payloads, and the case then passes with the carry-forward emitting nothing at all.
    const previous = await load('WrittenCarried', 'run-1', ['a', 'b', 'c']);
    await store.commit(previous, 'run-1');
    await store.write(previous, [contractRow('a', 'A2', 9)], {
      snapshotId: 'run-2',
      principalId: 'tester',
    });

    const merged = await store.carryForward(previous, 'run-2', { principalId: 'tester' });

    expect(merged.carried).toBe(2);
    // The whole list, so a missing carry-forward event cannot hide behind the batch's.
    expect(recorder.of('snapshot.written')).toEqual([
      { typeName: 'WrittenCarried', snapshotId: 'run-1', principalId: 'tester', rows: 3 },
      { typeName: 'WrittenCarried', snapshotId: 'run-2', principalId: 'tester', rows: 1 },
      { typeName: 'WrittenCarried', snapshotId: 'run-2', principalId: 'tester', rows: 2 },
    ]);
  });
});

describe('snapshot.committed', () => {
  it('fires once with the snapshot the commit returned', async () => {
    // The payload is asserted against the returned ref rather than against literals, because
    // the two are the same fact and a subscriber that disagrees with the caller about a
    // snapshot's size is worse than one that reports nothing.
    const type = await load('CommittedOnce', 'run-1', ['a', 'b', 'c']);

    const ref = await store.commit(type, 'run-1');

    expect(recorder.of('snapshot.committed')).toEqual([
      {
        typeName: 'CommittedOnce',
        snapshotId: 'run-1',
        principalId: ref.principalId,
        rowCount: ref.rowCount,
      },
    ]);
    expect(ref.rowCount).toBe(3);
  });

  it('does not fire for a commit this store refused', async () => {
    // The event means "a load became the one readers get", not "a commit was attempted". Both
    // refusals `commit` can raise are covered by this one: a subscriber must never see a
    // snapshot announced as serving that no read will ever be served from.
    const type = await load('CommittedRefused', 'run-1', ['a']);
    await store.commit(type, 'run-1');
    await store.write(type, [contractRow('b', 'B', 1)], {
      snapshotId: 'run-2',
      principalId: 'tester',
    });
    await store.carryForward(type, 'run-2', { principalId: 'tester' });
    // A batch after the merge, which leaves the snapshot marked stale and `commit` refusing.
    await store.write(type, [contractRow('c', 'C', 2)], {
      snapshotId: 'run-2',
      principalId: 'tester',
      batch: 1,
    });

    await expect(store.commit(type, 'run-2')).rejects.toThrow(/carried rows forward/);

    expect(recorder.of('snapshot.committed')).toEqual([
      { typeName: 'CommittedRefused', snapshotId: 'run-1', principalId: 'tester', rowCount: 1 },
    ]);
  });
});

describe('snapshot.dropped', () => {
  it('fires when a snapshot is dropped', async () => {
    const type = await load('DroppedOnce', 'run-1', ['a']);
    await store.commit(type, 'run-1');
    await load('DroppedOnce', 'run-2', ['b']);
    await store.commit(type, 'run-2');

    await store.dropSnapshot(type, 'run-1');

    expect(recorder.of('snapshot.dropped')).toEqual([
      { typeName: 'DroppedOnce', snapshotId: 'run-1' },
    ]);
  });

  it('does not fire a second time for a snapshot already dropped', async () => {
    // `dropSnapshot` returns early on an existing tombstone, and that early return is a
    // no-op, not a drop. A retention sweep re-reaching a snapshot it already evicted must not
    // put a second eviction in the trail for rows that were gone before it ran.
    const type = await load('DroppedTwice', 'run-1', ['a']);
    await store.commit(type, 'run-1');
    await load('DroppedTwice', 'run-2', ['b']);
    await store.commit(type, 'run-2');
    await store.dropSnapshot(type, 'run-1');

    await store.dropSnapshot(type, 'run-1');

    expect(recorder.of('snapshot.dropped')).toHaveLength(1);
  });

  it('does not fire when the drop was refused', async () => {
    const type = await load('DroppedRefused', 'run-1', ['a']);
    await store.commit(type, 'run-1');

    await expect(store.dropSnapshot(type, 'run-1')).rejects.toThrow(/currently serving/);

    expect(recorder.of('snapshot.dropped')).toEqual([]);
  });
});

describe('schema.changed', () => {
  it('is never emitted, because this store applies no DDL', async () => {
    // Not an omission. The event's payload names a `table` and the `addedColumns` a DDL
    // statement put on it; this store has neither — every batch is a Parquet object carrying
    // its own schema, and `ensureType` only validates the def it is handed. Emitting it here
    // would mean inventing a table name and reporting a column addition that no storage
    // performed. The case exists so that stays a decision rather than a silence.
    const type = await load('SchemaSilent', 'run-1', ['a']);
    await store.commit(type, 'run-1');

    expect(recorder.of('schema.changed')).toEqual([]);
  });
});
