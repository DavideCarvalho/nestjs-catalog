import type {
  CatalogObjectTypeDef,
  CatalogPropertyDef,
  CatalogQueryStore,
  CatalogReadResult,
  CatalogWriteStore,
  ScalarType,
} from '@dudousxd/nestjs-catalog';
import {
  CATALOG_PROVENANCE_COLUMNS,
  isCatalogStoreCapabilities,
  isWriteStore,
  resolveObjectFilters,
  supportsCarryForward,
  supportsObjectFilters,
  supportsSnapshotStreams,
} from '@dudousxd/nestjs-catalog';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * One contract, run against every adapter that claims to implement
 * `CatalogWriteStore`.
 *
 * **Why this is shared rather than written per adapter.** The store interface is
 * the seam the whole library is built on: the pipeline, the fan-out and every
 * screen above them are written against it and against nothing else. A per-
 * adapter suite tests what each adapter's author happened to think of, which is
 * exactly the set of things that adapter already gets right — the failures that
 * matter are the ones where two adapters behind one interface disagree, and no
 * suite that only ever looks at one of them can see those. Written once and run
 * against all of them, a new adapter becomes cheap to trust: it either passes
 * the same cases the shipped ones pass, or the reason it cannot is stated out
 * loud as a skip.
 *
 * **Nothing here is mocked.** Every case runs against a real engine booted by
 * testcontainers, because the properties being pinned — a snapshot staying
 * invisible until it commits, a re-sent batch replacing rather than appending, a
 * merge that sees only the batches present when it runs — are properties of the
 * SQL each adapter emits and of what the engine does with it. A fake store
 * passes all of them by construction and proves nothing about the adapter.
 *
 * Cases that do not apply are **skipped and say why**, never quietly asserted
 * around. The core package already answers "can this store do X" with
 * `supportsCarryForward` and the capability object, so the suite asks the same
 * questions the library asks rather than keeping a second opinion that can drift
 * from it.
 */

/** What an adapter has to supply to be run through the contract. */
export interface ContractStore {
  /** How this store is named in test titles and failure messages. */
  readonly name: string;
  readonly store: CatalogWriteStore;
  /**
   * Make the type known wherever this store keeps its model, then bring its
   * physical storage in line.
   *
   * Both halves, deliberately. `ensureType` alone is enough for an adapter that
   * derives everything from the def it is handed, and is *not* enough for the
   * MikroORM store, whose `read` resolves the served snapshot through a row in
   * `catalog_object_type` — publish nothing there and the load commits, the rows
   * land, and every read comes back empty. That asymmetry is the adapter's to
   * absorb, not the contract's to work around, so it lives behind this hook.
   */
  publish(type: CatalogObjectTypeDef): Promise<void>;
  /**
   * Read the model back out of wherever the adapter keeps it.
   *
   * Absent for a store that keeps no model of its own, which is a legitimate
   * design rather than a gap — the ClickHouse adapter says so at length: saved
   * queries, connector definitions and the type model are small mutable
   * read-modify-write data, and a column store is the wrong home for them. An
   * adapter without this gets the model case skipped with {@link noModelReason}
   * printed, so the skip is a statement rather than a silence.
   */
  readBackType?(name: string): Promise<CatalogObjectTypeDef | undefined>;
  /** Why {@link readBackType} is absent. Required when it is. */
  readonly noModelReason?: string;
  /**
   * How this store's engine quotes an identifier, for the one case that has to
   * write a statement by hand.
   *
   * **This hook exists because the contract was not as engine-neutral as it read.**
   * The SQL-console case below used to embed backticks with the comment "both
   * engines quote with backticks, so one statement serves both" — true of MySQL
   * and ClickHouse, and false the moment a third adapter arrived: Postgres
   * spells it `"Asset_Id"` and answers a backtick with `syntax error at or near
   * "\`"`. The suite would have reported that as the Postgres store failing to
   * expose a column it exposes perfectly well.
   *
   * Defaulted to backticks so the two adapters that were passing keep passing on
   * a suite that has not changed for them. It is deliberately the only place the
   * contract writes SQL at all — every other case goes through the store
   * interface, which is the point.
   */
  quoteIdentifier?(value: string): string;
}

/** Every property the contract's fixture type declares, in one place. */
const FIELDS = ['id', 'label', 'score', 'active', 'seenAt'] as const;

/**
 * A whole second, on purpose.
 *
 * The MySQL adapter maps `date` to `DATETIME`, which has no fractional part,
 * where ClickHouse maps it to `DateTime64(3)`, which does. A fixture with
 * milliseconds in it would therefore fail on one adapter and pass on the other
 * for a reason that has nothing to do with the case being tested. The precision
 * difference is real and worth knowing about; it is not what these cases are
 * about, so the fixture stays on a second boundary and the divergence is left
 * where it can be seen rather than papered over with a fuzzy assertion.
 */
const SEEN_AT = '2026-01-02T03:04:05.000Z';

function property(
  name: string,
  type: ScalarType,
  order: number,
  overrides: Partial<CatalogPropertyDef> = {},
): CatalogPropertyDef {
  return {
    name,
    displayName: name,
    type,
    columnName: name,
    nullable: true,
    primary: false,
    hidden: false,
    order,
    enriched: false,
    ...overrides,
  };
}

/**
 * The fixture type, named per case.
 *
 * A distinct name per case rather than one shared type with a teardown between
 * them. Object tables are created by the store as types arrive and are named
 * `obj_<type>`, so a fresh name is a fresh table and a case cannot see the rows
 * another one left behind — including when it fails part-way, which is exactly
 * when a shared table would hand the next case a state nobody designed. It also
 * means a failing case can be re-run alone against a live container and the
 * result still means something.
 *
 * `json` is deliberately not among the properties. The two shipped adapters do
 * not agree on what a JSON column reads back as — MySQL's driver parses the
 * column into an object, ClickHouse stores it as `String` and hands back the
 * text — and pinning either answer here would bless one adapter's behaviour as
 * the contract on no authority at all.
 */
export function contractType(name: string): CatalogObjectTypeDef {
  return {
    name,
    displayName: name,
    pluralDisplayName: `${name}s`,
    description: 'Fixture for the shared catalog store contract.',
    tableName: `obj_${name.toLowerCase()}`,
    group: 'Contract',
    primaryKey: ['id'],
    enriched: true,
    properties: [
      property('id', 'string', 0, { primary: true, nullable: false }),
      property('label', 'string', 1),
      property('score', 'number', 2),
      property('active', 'boolean', 3),
      property('seenAt', 'date', 4),
    ],
    relations: [],
  };
}

export function contractRow(
  id: string,
  label: string,
  score: number,
  active = true,
): Record<string, unknown> {
  return { id, label, score, active, seenAt: SEEN_AT };
}

/**
 * The fields of the source-spelling fixture, named the way the source names
 * them.
 *
 * Real column headings out of a real drop: `Asset Id`, `Asset LIN/TAMCN`.
 * Neither is a SQL identifier, and both are what the records a connector yields
 * are keyed by.
 *
 * `Renamed_Id` is the anti-case, and it is in the fixture on purpose. It is what
 * a publisher was told to send when a name like `Asset Id` was refused: a
 * tidied `name`, with the source's spelling parked in `columnName`. The record
 * written below carries no `Renamed_Id` key, because a source record never
 * would — so whatever that column reads back as is the answer to "does
 * `columnName` redirect the read?", asserted rather than assumed.
 */
const SOURCE_SPELLED_FIELDS = ['id', 'Asset Id', 'Asset LIN/TAMCN', 'Renamed_Id'] as const;

/** The fixture type for the source-spelling case, named per case like the rest. */
function sourceSpelledType(name: string): CatalogObjectTypeDef {
  return {
    name,
    displayName: name,
    pluralDisplayName: `${name}s`,
    description: 'Fixture for property names spelled the way a source spells them.',
    tableName: `obj_${name.toLowerCase()}`,
    group: 'Contract',
    primaryKey: ['id'],
    enriched: true,
    properties: [
      property('id', 'string', 0, { primary: true, nullable: false }),
      property('Asset Id', 'string', 1),
      property('Asset LIN/TAMCN', 'string', 2),
      property('Renamed_Id', 'string', 3, { columnName: 'Asset Id' }),
    ],
    relations: [],
  };
}

/**
 * The store as a SQL console reaches it, or nothing.
 *
 * `CatalogQueryStore` is a separate interface from `CatalogWriteStore` and an
 * adapter may implement one without the other, so the case that needs it asks
 * rather than assumes — and says so out loud when the answer is no, the same way
 * every other optional capability in this file is handled. A predicate rather
 * than a cast: the question is genuinely about the object in hand.
 */
function isQueryStore(store: CatalogWriteStore): store is CatalogWriteStore & CatalogQueryStore {
  return (
    typeof Reflect.get(store, 'runQuery') === 'function' &&
    typeof Reflect.get(store, 'queryRelations') === 'function'
  );
}

/**
 * Read the way a caller reads: the whole snapshot, in key order.
 *
 * Sorted explicitly because the two engines have different natural orders — an
 * auto-increment `_row` on MySQL, `(_batch, _row)` on ClickHouse — and a case
 * that asserted on the natural one would be asserting on an implementation
 * detail that the interface does not promise.
 */
async function readAll(
  store: CatalogWriteStore,
  type: CatalogObjectTypeDef,
  snapshot?: string,
): Promise<CatalogReadResult> {
  return store.read(type, [...FIELDS], {
    page: 1,
    size: 200,
    sort: 'id',
    dir: 'asc',
    ...(snapshot === undefined ? {} : { snapshot }),
  });
}

function idsOf(result: CatalogReadResult): string[] {
  return result.rows.map((row) => String(row.id));
}

/**
 * Read through the filters the *service* would have built, and hand back the ids.
 *
 * `resolveObjectFilters` rather than hand-written `CatalogResolvedFilter`
 * literals, so a case here exercises the coercion a real request goes through —
 * `score:gte:30` becoming the number 30 and `seenAt:gte:...` becoming a `Date` is
 * exactly where a store's predicate can be wrong in a way that still returns
 * rows. A filter the resolver itself rejects is a broken case rather than a
 * finding about the store, so the problems are asserted empty before the read.
 */
async function filteredIds(
  store: CatalogWriteStore,
  type: CatalogObjectTypeDef,
  raw: string[],
): Promise<string[]> {
  const { filters, problems } = resolveObjectFilters(type.properties, raw);
  expect(problems).toEqual([]);
  expect(filters).toHaveLength(raw.length);

  const result = await store.read(type, [...FIELDS], {
    page: 1,
    size: 200,
    sort: 'id',
    dir: 'asc',
    filters,
  });

  // The count is a second statement on both shipped adapters. A filter applied
  // to the page and not to the count is the failure with no visible symptom: a
  // screen showing three rows above the words "of 4,812". The page holds every
  // match here — `size` is far past the fixture — so the two have to agree.
  expect(result.total).toBe(result.rows.length);
  return idsOf(result);
}

/**
 * The adapter under test, assigned by the suite's `beforeAll`.
 *
 * Module scope rather than a closure inside {@link describeCatalogStoreContract},
 * so that a group of cases split into its own function — see {@link
 * describeSnapshotStreamCases} — reads the same variable rather than being handed
 * a getter for it. One suite runs per module, so there is only ever one adapter
 * for this to hold.
 */
let subject: ContractStore;

/** Publish and hand back the def, so a case is two lines of setup. */
async function ready(caseName: string): Promise<CatalogObjectTypeDef> {
  const def = contractType(caseName);
  await subject.publish(def);
  return def;
}

/**
 * Skip a case, out loud.
 *
 * Vitest's own report says only that something was skipped, which over three
 * adapters is three silences that look identical whether the case does not
 * apply, was never written, or was switched off to make a run green. The
 * reason is printed beside the store's name so a reader of the output can
 * tell those apart without opening this file.
 */
function skipping(context: { skip: () => void }, reason: string): void {
  console.log(`[contract] ${subject.name}: ${reason}`);
  context.skip();
}

/**
 * The store, if a tombstone is a thing it can have, and nothing otherwise.
 *
 * Two questions, and both have to be asked. A store that cannot time-travel has
 * no older snapshot to drop in the first place. A store that implements no
 * `listSnapshots` keeps no record a drop could leave behind — the interface says
 * so in as many words, and it is a legitimate shape rather than a gap. It is
 * also, and this is why the skip is printed rather than silent, exactly what an
 * adapter looks like just before somebody notices its drops leave holes.
 */
function tombstoneSubject(context: { skip: () => void }): CatalogWriteStore | undefined {
  if (!subject.store.capabilities.timeTravel) {
    skipping(context, 'declares timeTravel: false, so it has no older snapshot to drop.');
    return undefined;
  }
  if (!subject.store.listSnapshots) {
    skipping(
      context,
      'implements no listSnapshots(), so it keeps no record a drop could leave behind.',
    );
    return undefined;
  }
  return subject.store;
}

/**
 * A type with two committed loads, the older of which has been dropped.
 *
 * Two rows in the load that goes and one in the load that stays, so a count of 2
 * on the tombstone can be confused neither with the size of what is being served
 * nor with zero — and zero is the answer every one of these cases exists to
 * refuse.
 */
async function droppedFixture(
  store: CatalogWriteStore,
  caseName: string,
): Promise<CatalogObjectTypeDef> {
  const def = await ready(caseName);
  await store.write(def, [contractRow('a', 'alpha', 1), contractRow('b', 'bravo', 2)], {
    snapshotId: 'load-a',
    principalId: 'contract',
    batch: 0,
  });
  await store.commit(def, 'load-a');
  await store.write(def, [contractRow('c', 'charlie', 3)], {
    snapshotId: 'load-b',
    principalId: 'contract',
    batch: 0,
  });
  await store.commit(def, 'load-b');

  const list = store.listSnapshots;
  if (list) {
    // Asserted before the drop, so a store that reports `droppedAt` on
    // everything — which would pass every assertion below — is caught here
    // rather than mistaken for one that got this right.
    const before = await list.call(store, def);
    expect(before.find((ref) => ref.id === 'load-a')?.droppedAt).toBeUndefined();
  }

  await store.dropSnapshot(def, 'load-a');
  return def;
}

/**
 * Both provenance columns arrived, without saying which instant `_loaded_at`
 * holds.
 *
 * The value is asserted present rather than compared, and the reason is the same
 * second-boundary problem {@link SEEN_AT} is on: MySQL maps `_loaded_at` to
 * `DATETIME`, which has no fractional part, so two writes inside one second are
 * genuinely indistinguishable and a case that compared them would flake on a
 * fast machine and pass on a slow one. That the column *arrives* is what a copy
 * of a snapshot depends on; which instant it holds is the engine's business and
 * is pinned by the adapters' own suites.
 */
function expectProvenance(row: Record<string, unknown>): void {
  for (const column of CATALOG_PROVENANCE_COLUMNS) {
    expect(row[column]).toBeDefined();
    expect(row[column]).not.toBeNull();
  }
}

/**
 * And absent unless asked for.
 *
 * Every caller that existed before the option reads a snapshot in order to write
 * it into another type, and would otherwise find two reserved names among the
 * fields it is about to load — names a publisher is not allowed to give a
 * property, so nothing downstream has anywhere to put them.
 */
function expectNoProvenance(row: Record<string, unknown>): void {
  for (const column of CATALOG_PROVENANCE_COLUMNS) expect(column in row).toBe(false);
}

/**
 * The snapshot-stream cases, declared from their own function.
 *
 * Split out of {@link describeCatalogStoreContract} for a mechanical reason
 * worth stating so the next case does not get folded back in: the linter caps
 * cognitive complexity per function, and every `it` in this file nests into
 * whichever one declares it. The suite's one function was already near the cap,
 * so a group of cases that each open with a capability guard is a group that has
 * to be declared somewhere else. The seam is otherwise arbitrary — these cases
 * are the contract exactly as much as the ones beside them.
 *
 * Reads `subject` and the two helpers from module scope, which is where they
 * moved so that this split cost nothing at the call site. `subject` is assigned
 * in the suite's `beforeAll`, so nothing here may touch it before a case runs.
 */
function describeSnapshotStreamCases(): void {
  it('streams one whole snapshot, in order, and nothing from the loads beside it', async (context) => {
    const store = subject.store;
    if (!supportsSnapshotStreams(store)) {
      // A real answer rather than a gap, and the interface says so at length:
      // a store fronting an API, or one on a driver that buffers a result set
      // before resolving, cannot stream honestly, and a shim that collected
      // every row and yielded them back would satisfy the type while doing the
      // one thing the type exists to avoid. The caller refuses out loud rather
      // than falling back to a paged read.
      skipping(
        context,
        'implements no streamSnapshot, so a workflow reading a whole snapshot out of it is refused rather than paged.',
      );
      return;
    }
    const def = await ready('ContractSnapshotStream');
    const fields = [...FIELDS];

    await store.write(def, [contractRow('a', 'first', 1), contractRow('b', 'second', 2)], {
      snapshotId: 'streamed',
      principalId: 'contract',
      batch: 0,
    });
    await store.commit(def, 'streamed');

    // A second load, so the physical table holds both. A stream that read the
    // table instead of the snapshot returns three rows here and a plausible
    // file everywhere else.
    await store.write(def, [contractRow('c', 'later', 3)], {
      snapshotId: 'streamed-2',
      principalId: 'contract',
      batch: 0,
    });
    await store.commit(def, 'streamed-2');

    const streamed: Array<Record<string, unknown>> = [];
    for await (const row of store.streamSnapshot(def, fields, 'streamed')) streamed.push(row);

    expect(streamed.map((row) => row.id)).toEqual(['a', 'b']);
    // Keyed by property name, the same vocabulary `read` hands out, so rows
    // read out of one type can be written into another with no translation.
    expect(streamed[0]?.label).toBe('first');
    expect(streamed[0]?.score).toBe(1);
  });

  it('carries the loading principal on each streamed row, and a carried row keeps the older one', async (context) => {
    const store = subject.store;
    if (!supportsSnapshotStreams(store)) {
      skipping(context, 'implements no streamSnapshot, so it has no stream to put provenance on.');
      return;
    }
    if (!supportsCarryForward(store)) {
      skipping(
        context,
        'is not a CatalogMergeStore, so no row is ever carried rather than loaded.',
      );
      return;
    }
    const def = await ready('ContractStreamProvenance');
    const fields = [...FIELDS];

    // **The case that decides what an archive has to hold.** `carryForward`
    // copies `_principal_id` and `_loaded_at` off the previous snapshot
    // untouched — deliberately, because a carried row is not a new load of that
    // row and restamping it would erase the one thing those columns are good
    // for. So a snapshot produced by an incremental run holds *two* answers to
    // "who loaded this and when", and neither is recoverable from the snapshot
    // row, which records only the run that committed it.
    //
    // That is the whole argument for a copy of a snapshot carrying these two
    // columns: without them a restored snapshot answers "whoever ran the
    // restore, whenever it ran" for every row, and the next incremental load
    // carries *that* forward, and the one after it, indefinitely.
    await store.write(def, [contractRow('a', 'alpha', 1), contractRow('b', 'bravo', 2)], {
      snapshotId: 'base',
      principalId: 'first-loader',
      batch: 0,
    });
    await store.commit(def, 'base');

    await store.write(def, [contractRow('b', 'bravo-updated', 20)], {
      snapshotId: 'incremental',
      principalId: 'second-loader',
      batch: 0,
    });
    const merged = await store.carryForward(def, 'incremental', {
      principalId: 'second-loader',
    });
    expect(merged.carried).toBe(1);
    await store.commit(def, 'incremental');

    const rows = new Map<string, Record<string, unknown>>();
    for await (const row of store.streamSnapshot(def, fields, 'incremental', {
      provenance: true,
    })) {
      rows.set(String(row.id), row);
    }
    expect([...rows.keys()].sort()).toEqual(['a', 'b']);

    // `a` was not in the incremental run at all — it was carried — so it still
    // names the run that actually loaded it. `b` was, so it names this one.
    // The store that dropped these on the way through the stream would return
    // two identical values here, or none.
    expect(rows.get('a')?._principal_id).toBe('first-loader');
    expect(rows.get('b')?._principal_id).toBe('second-loader');

    for (const row of rows.values()) expectProvenance(row);

    for await (const row of store.streamSnapshot(def, fields, 'incremental')) {
      expectNoProvenance(row);
    }
  });
}

/**
 * Run the contract.
 *
 * `boot` is a getter rather than the store itself because the engine is started
 * in the spec file's own `beforeAll`, which vitest runs before this suite's —
 * so the container is up by the time any case asks for it, and the suite is
 * still declared at collection time where the reporter can see it.
 */
export function describeCatalogStoreContract(boot: () => ContractStore): void {
  describe('catalog store contract', () => {
    beforeAll(() => {
      subject = boot();
    });

    it('declares capabilities the core package can read, and is writable', () => {
      // The capability object arrives through an injection token in production,
      // and a token can be bound to anything: the fan-out and the dashboard both
      // narrow it before using it. An adapter whose capabilities do not satisfy
      // the core package's own predicate is one those callers will refuse at
      // boot, which is a failure worth having here rather than there.
      expect(isCatalogStoreCapabilities(subject.store.capabilities)).toBe(true);
      expect(isWriteStore(subject.store)).toBe(true);
      expect(subject.store.capabilities.writable).toBe(true);
    });

    it('keeps a load invisible until it commits', async () => {
      // The single most load-bearing promise of the interface. Without it a
      // crash mid-load is indistinguishable from a completed load that happened
      // to lose rows — the readers see a plausible, short dataset either way,
      // and nothing in the system is able to tell which happened.
      const def = await ready('ContractCommitVisibility');

      const first = await subject.store.write(
        def,
        [contractRow('a', 'alpha', 1), contractRow('b', 'bravo', 2)],
        { snapshotId: 'load-1', principalId: 'contract', batch: 0 },
      );
      expect(first.written).toBe(2);

      const beforeCommit = await readAll(subject.store, def);
      expect(beforeCommit.total).toBe(0);
      expect(beforeCommit.rows).toEqual([]);

      const ref = await subject.store.commit(def, 'load-1');
      expect(ref.id).toBe('load-1');
      expect(ref.rowCount).toBe(2);
      expect(ref.principalId).toBe('contract');

      const afterCommit = await readAll(subject.store, def);
      expect(afterCommit.total).toBe(2);
      expect(idsOf(afterCommit)).toEqual(['a', 'b']);
    });

    it('leaves a snapshot that failed halfway unreadable, and the last good one served', async () => {
      // The case the append-only model exists for. A load writes batch 0, the
      // process dies, and nothing ever calls commit. Readers must still be on
      // the previous load — not on a mixture, and not on a snapshot holding half
      // of the new one. A store that served the partial rows would turn a crash
      // into silent data loss with a healthy-looking row count.
      const def = await ready('ContractHalfWritten');

      await subject.store.write(def, [contractRow('a', 'alpha', 1), contractRow('b', 'bravo', 2)], {
        snapshotId: 'good',
        principalId: 'contract',
        batch: 0,
      });
      await subject.store.commit(def, 'good');

      // The load that dies: one batch of two lands, the second never arrives,
      // and commit is never reached.
      await subject.store.write(def, [contractRow('c', 'charlie', 3)], {
        snapshotId: 'crashed',
        principalId: 'contract',
        batch: 0,
      });

      const served = await readAll(subject.store, def);
      expect(idsOf(served)).toEqual(['a', 'b']);
      expect(served.rows.some((row) => row.id === 'c')).toBe(false);

      if (subject.store.capabilities.timeTravel) {
        // The half-written rows do exist — they are addressed by their snapshot
        // id and that is what makes a retry able to replace them rather than
        // append beside them. Asserting it here keeps "invisible" precise: it
        // means nothing routes a *default* read to them, not that they were
        // thrown away.
        const partial = await readAll(subject.store, def, 'crashed');
        expect(idsOf(partial)).toEqual(['c']);
      }
    });

    it('replaces a re-sent batch, so three attempts load the data once', async () => {
      // What a durable retry actually does: a step that fails restarts from the
      // top and re-sends every batch it already sent. An append-only write turns
      // that into a silently tripled dataset whose only symptom is a row count
      // that looks merely large.
      const def = await ready('ContractIdempotentBatches');

      const batchOne = [contractRow('a', 'alpha', 1), contractRow('b', 'bravo', 2)];
      const batchTwo = [contractRow('c', 'charlie', 3)];

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const one = await subject.store.write(def, batchOne, {
          snapshotId: 'retried',
          principalId: 'contract',
          batch: 0,
        });
        const two = await subject.store.write(def, batchTwo, {
          snapshotId: 'retried',
          principalId: 'contract',
          batch: 1,
        });
        // `written` is rows-accepted-by-this-call and never rows-in-the-
        // snapshot. The interface says so at length, and two things depend on
        // it: a caller summing across batches to report what a load produced,
        // and the fan-out comparing a follower's number against the primary's to
        // catch a batch that landed short. Under the other reading the sum grows
        // with every retry and the fan-out reports a mismatch on every load.
        expect(one.written).toBe(2);
        expect(two.written).toBe(1);
      }

      const ref = await subject.store.commit(def, 'retried');
      expect(ref.rowCount).toBe(3);

      const rows = await readAll(subject.store, def);
      expect(rows.total).toBe(3);
      expect(idsOf(rows)).toEqual(['a', 'b', 'c']);
    });

    it('narrows a read to the rows every declared operator matches', async (context) => {
      const store = subject.store;
      if (!supportsObjectFilters(store)) {
        // The core package's own predicate, like every other capability question
        // in this file. A store that declares nothing is offered no filter
        // controls and refuses a hand-built filter, which is the correct
        // behaviour and not a contract failure — what it is not allowed to do is
        // declare the operators and then not apply them, which is what every
        // case below is here to catch.
        skipping(
          context,
          'declares no objectFilterOperators, so the service offers no filter controls and refuses a filter rather than reading unfiltered.',
        );
        return;
      }
      const def = await ready('ContractObjectFilters');

      // Distinct values per column so a wrong predicate cannot coincide with the
      // right answer, and one row whose `label` is blank — written as `''`,
      // which both adapters coerce to NULL on the way in — because `empty`,
      // `notEmpty` and `ne` are the three that are wrong if NULL is handled
      // naively, and there is nothing to be wrong about without such a row.
      await store.write(
        def,
        [
          { id: 'a', label: 'alpha', score: 10, active: true, seenAt: '2026-01-01T00:00:00.000Z' },
          { id: 'b', label: 'bravo', score: 20, active: false, seenAt: '2026-02-01T00:00:00.000Z' },
          {
            id: 'c',
            label: 'charlie',
            score: 30,
            active: true,
            seenAt: '2026-03-01T00:00:00.000Z',
          },
          { id: 'd', label: '', score: 40, active: false, seenAt: '2026-04-01T00:00:00.000Z' },
        ],
        { snapshotId: 'filters', principalId: 'contract', batch: 0 },
      );
      await store.commit(def, 'filters');
      expect(idsOf(await readAll(store, def))).toEqual(['a', 'b', 'c', 'd']);

      const declared = store.objectFilterOperators;
      /** Assert a filter only when the store said it applies that operator. */
      async function whenDeclared(raw: string[], expected: string[]): Promise<void> {
        const wanted = raw.map((entry) => entry.split(':')[1]);
        if (!wanted.every((op) => declared.some((each) => each === op))) return;
        expect(await filteredIds(store, def, raw)).toEqual(expected);
      }

      await whenDeclared(['label:eq:alpha'], ['a']);
      // Includes `d`, whose label is NULL. `<>` is never true of NULL in SQL, so
      // the naive translation drops every row with no value at all — and a
      // reader of "label is not alpha" would conclude those rows say alpha.
      await whenDeclared(['label:ne:alpha'], ['b', 'c', 'd']);
      await whenDeclared(['label:contains:rav'], ['b']);
      await whenDeclared(['label:empty'], ['d']);
      await whenDeclared(['label:notEmpty'], ['a', 'b', 'c']);
      await whenDeclared(['score:gte:30'], ['c', 'd']);
      await whenDeclared(['score:lt:20'], ['a']);
      await whenDeclared(['active:eq:true'], ['a', 'c']);
      await whenDeclared(['seenAt:gte:2026-03-01T00:00:00.000Z'], ['c', 'd']);
      // Two filters at once, which is the form a person actually builds: the
      // contract says *every* filter must be applied, so they conjoin. A store
      // that applied the last one and dropped the rest would pass every case
      // above and fail only here.
      await whenDeclared(['score:gt:10', 'score:lte:30'], ['b', 'c']);
      await whenDeclared(['active:eq:false', 'score:lt:40'], ['b']);
    });

    it('refuses a filter on a column the same read declined to return', async (context) => {
      const store = subject.store;
      if (!supportsObjectFilters(store)) {
        skipping(context, 'declares no objectFilterOperators, so it has no filter to refuse.');
        return;
      }
      const def = await ready('ContractFilterOutsideRead');

      await store.write(def, [contractRow('a', 'alpha', 1), contractRow('b', 'bravo', 2)], {
        snapshotId: 'narrow',
        principalId: 'contract',
        batch: 0,
      });
      await store.commit(def, 'narrow');

      // A predicate over a column the same request did not select is how a
      // hidden or classified value leaks out through row membership — `gte` and
      // `lte` let a reader binary-search a value they may not see, in as many
      // requests as it takes. The service resolves filters against the visible
      // columns, so only a caller building the query itself gets here, and it
      // has to be a refusal rather than an unfiltered page.
      const { filters } = resolveObjectFilters(def.properties, ['label:eq:alpha']);
      await expect(
        store.read(def, ['id'], { page: 1, size: 200, sort: 'id', dir: 'asc', filters }),
      ).rejects.toThrow(/label/i);
    });

    it('round-trips every scalar it was given', async () => {
      // Each adapter maps the catalog's coarse scalars onto its engine's types
      // and back, and the mapping is lossy in both directions if it is written
      // carelessly: a boolean stored as TINYINT reads back as 0, a number stored
      // as DOUBLE reads back as a string, a date reads back in the server's
      // timezone. All three produce data that is wrong rather than absent, in a
      // consumer several layers away.
      const def = await ready('ContractScalars');

      await subject.store.write(
        def,
        [
          { id: 'x', label: 'ok', score: 3.5, active: true, seenAt: SEEN_AT },
          { id: 'y', label: 'off', score: -2, active: false, seenAt: SEEN_AT },
        ],
        { snapshotId: 'scalars', principalId: 'contract', batch: 0 },
      );
      await subject.store.commit(def, 'scalars');

      const [first, second] = (await readAll(subject.store, def)).rows;
      expect(first?.id).toBe('x');
      expect(first?.label).toBe('ok');
      expect(first?.score).toBe(3.5);
      expect(first?.active).toBe(true);
      expect(second?.active).toBe(false);
      expect(second?.score).toBe(-2);

      // **The date is compared after normalising the separator, and that is a
      // finding rather than a convenience.** The two shipped adapters agree on
      // the instant and disagree on how they render it: ClickHouse returns
      // `2026-01-02T03:04:05.000Z`, because its `normalise` has an explicit
      // branch that turns the server's `YYYY-MM-DD hh:mm:ss` into ISO — added,
      // its comment says, precisely so that "two adapters behind one interface
      // returning two date formats" cannot happen. MySQL has no such branch:
      // MikroORM's MySQL connection sets `dateStrings = true` unconditionally,
      // so a `DATETIME` never arrives as a `Date`, the `value instanceof Date`
      // arm of that store's `normalise` is unreachable for date columns, and the
      // raw `2026-01-02 03:04:05` is handed straight through. That string has no
      // zone, so `new Date(...)` reads it as *local* — the same row read through
      // the two adapters yields two different instants on any machine that is
      // not on UTC.
      //
      // Asserting either rendering here would bless one adapter's behaviour on
      // no authority. What both genuinely promise, and what this pins, is the
      // value: same date, same wall clock, no silent shift.
      const seenAt = String(first?.seenAt)
        .replace('T', ' ')
        .replace(/(\.\d+)?Z?$/, '');
      expect(seenAt).toBe('2026-01-02 03:04:05');
    });

    it('loads and returns a property named the way the source spells it', async () => {
      // **The case this suite was missing when six real types loaded empty.**
      //
      // A store matches a source's record to a property by property NAME — it
      // reads `row[property.name]` — and nothing on the write path consults
      // `columnName`. But the name was also written verbatim as the output alias
      // of the committed view and of every read, through an `ident` that refuses
      // rather than escapes, so a property could not be *called* `Asset Id` at
      // all. Publishers therefore did the only thing left: renamed the property
      // to `Asset_Id` and put the source's spelling in `columnName`. Thirteen
      // types went in that way and six came out with most of their columns NULL,
      // 313,833 rows on the largest of them, every run green.
      //
      // Written as a round trip and not as an assertion about SQL, because the
      // whole failure was invisible in the SQL: the statements were all
      // well-formed, the loads all committed, and the only observable was a cell.
      const def = sourceSpelledType('ContractSourceSpelling');
      await subject.publish(def);

      // Keyed exactly as a connector's records are keyed, and carrying nothing
      // called `Renamed_Id` — which is the point of that property being here.
      const written = await subject.store.write(
        def,
        [
          { id: 'a', 'Asset Id': 'A-71', 'Asset LIN/TAMCN': 'T-9' },
          { id: 'b', 'Asset Id': 'A-72', 'Asset LIN/TAMCN': 'T-4' },
        ],
        { snapshotId: 'spelled', principalId: 'contract', batch: 0 },
      );
      expect(written.written).toBe(2);

      // The commit is half the case on its own: it refreshes the view, and the
      // view is where the verbatim alias lived. Against the old code this line
      // threw `Refusing to use "Asset Id" as a SQL identifier`.
      await subject.store.commit(def, 'spelled');

      const read = await subject.store.read(def, [...SOURCE_SPELLED_FIELDS], {
        page: 1,
        size: 200,
        sort: 'id',
        dir: 'asc',
      });
      expect(read.total).toBe(2);

      const [first, second] = read.rows;
      // Out under the property's own name, with the value that went in. NULL
      // here is the bug, and a store that silently dropped the field would fail
      // on exactly this line.
      expect(first?.['Asset Id']).toBe('A-71');
      expect(first?.['Asset LIN/TAMCN']).toBe('T-9');
      expect(second?.['Asset Id']).toBe('A-72');

      // And the anti-case, pinned so nobody rebuilds the belief that caused all
      // this: `columnName` does NOT redirect a read. `Renamed_Id` declares
      // `columnName: 'Asset Id'`, the record above holds an `Asset Id` key, and
      // the column is still empty — because the load looked for `Renamed_Id` and
      // the record has no such field. That is the whole incident in one
      // assertion.
      expect(first?.Renamed_Id).toBeNull();
    });

    it('exposes that property to the SQL console under its cleaned name', async (context) => {
      if (!isQueryStore(subject.store)) {
        skipping(context, 'implements no CatalogQueryStore, so it serves no SQL console.');
        return;
      }
      const store = subject.store;
      const def = sourceSpelledType('ContractSpelledView');
      await subject.publish(def);

      await store.write(def, [{ id: 'a', 'Asset Id': 'A-71', 'Asset LIN/TAMCN': 'T-9' }], {
        snapshotId: 'spelled-view',
        principalId: 'contract',
        batch: 0,
      });
      await store.commit(def, 'spelled-view');

      // The schema panel first, because a console offers what this returns. A
      // relation that advertised `Asset Id` would be offering an autocompletion
      // that cannot be typed into a statement.
      const relations = await store.queryRelations();
      // Matched case-insensitively, because an adapter that answers this from
      // the database rather than from a registry only has the lowercased table
      // name to reconstruct the type from — a real difference between the two
      // shipped stores, and not the one this case is about.
      const current = relations.find(
        (relation) =>
          relation.kind === 'current' &&
          relation.objectType.toLowerCase() === def.name.toLowerCase(),
      );
      expect(current).toBeDefined();
      const columns = (current?.columns ?? []).map((column) => column.name);
      expect(columns).toContain('Asset_Id');
      expect(columns).toContain('Asset_LIN_TAMCN');

      // And then the view itself, selected from by the name the panel just gave.
      // Quoted through the adapter, because the engines do not agree — see
      // {@link ContractStore.quoteIdentifier}.
      const quote = subject.quoteIdentifier ?? ((value: string) => `\`${value}\``);
      const result = await store.runQuery({
        sql: `SELECT ${quote('Asset_Id')} FROM ${quote(String(current?.name))}`,
      });
      expect(result.rowCount).toBe(1);
      expect(result.rows[0]?.Asset_Id).toBe('A-71');
    });

    it('serves an older snapshot when asked, and refuses to drop the one it is serving', async (context) => {
      if (!subject.store.capabilities.timeTravel) {
        // Legitimately absent rather than unimplemented: a store over tables
        // somebody else owns, or one that keeps only current state, cannot
        // answer this and says so in its capabilities. The library reads that
        // flag before offering a snapshot picker, so a store that reports false
        // here is consistent rather than broken.
        skipping(context, 'declares timeTravel: false, so there is no older snapshot to ask for.');
        return;
      }
      const def = await ready('ContractTimeTravel');

      await subject.store.write(def, [contractRow('a', 'first', 1)], {
        snapshotId: 'older',
        principalId: 'contract',
        batch: 0,
      });
      await subject.store.commit(def, 'older');

      await subject.store.write(def, [contractRow('a', 'second', 9), contractRow('b', 'new', 4)], {
        snapshotId: 'newer',
        principalId: 'contract',
        batch: 0,
      });
      await subject.store.commit(def, 'newer');

      const current = await readAll(subject.store, def);
      expect(idsOf(current)).toEqual(['a', 'b']);
      expect(current.rows[0]?.label).toBe('second');

      const historical = await readAll(subject.store, def, 'older');
      expect(idsOf(historical)).toEqual(['a']);
      expect(historical.rows[0]?.label).toBe('first');

      // Dropping the served snapshot would leave the type pointing at rows that
      // no longer exist — a name that resolves to nothing, which reads as an
      // empty dataset rather than as a mistake.
      await expect(subject.store.dropSnapshot(def, 'newer')).rejects.toThrow();
      // An unserved one is free to go, and taking it must not disturb what is
      // being served.
      await subject.store.dropSnapshot(def, 'older');
      expect(idsOf(await readAll(subject.store, def))).toEqual(['a', 'b']);
    });

    it('keeps a dropped snapshot in its list, with the size it held and the date', async (context) => {
      const store = tombstoneSubject(context);
      if (!store) return;
      const list = store.listSnapshots;
      if (!list) return;
      const def = await droppedFixture(store, 'ContractTombstoneRecord');

      // The whole of the change: the record is still there, still attributable,
      // and still says how large the load was. A store that deleted it would
      // leave every connector run naming `load-a` pointing at nothing.
      const tombstone = (await list.call(store, def)).find((ref) => ref.id === 'load-a');
      expect(tombstone).toBeDefined();
      expect(tombstone?.droppedAt).toBeDefined();
      expect(tombstone?.principalId).toBe('contract');
      // The count it held, taken before the rows went. Never a fresh one: a
      // fresh count of a tombstone is zero, which reports a load that held
      // millions of rows as one that held none.
      expect(tombstone?.rowCount).toBe(2);

      // And none of it disturbed what is being served.
      expect(idsOf(await readAll(store, def))).toEqual(['c']);

      // Idempotent. A durable step that replays must not rewrite the date to
      // the moment of its retry — the drop happened once, and when it happened
      // is the fact a run history is being kept for.
      await store.dropSnapshot(def, 'load-a');
      const replayed = (await list.call(store, def)).find((ref) => ref.id === 'load-a');
      expect(replayed?.droppedAt).toBe(tombstone?.droppedAt);
      expect(replayed?.rowCount).toBe(2);
    });

    it('bounds the snapshots that still hold rows by the live ones, not by the records', async (context) => {
      const store = tombstoneSubject(context);
      if (!store) return;
      const live = store.listSnapshotsWithRows;
      if (!live) {
        skipping(
          context,
          'implements no listSnapshotsWithRows(), so a caller asking which snapshots still hold ' +
            'rows has to filter a bounded list and gets the live ones OF THAT WINDOW.',
        );
        return;
      }
      const def = await ready('ContractLiveWindow');

      // Five loads, and then the two in the MIDDLE are dropped — so the
      // tombstones are newer than two live snapshots rather than older than all
      // of them. That ordering is the whole case. A store that applies its bound
      // to the records and filters afterwards answers a `limit: 3` here with
      // `[load-5]`: the newest three records are 5, 4 and 3, and two of those
      // are tombstones. A store with the predicate in the statement answers
      // `[load-5, load-2, load-1]`.
      //
      // In production the tombstones are the OLD ones, which is why the defect
      // hides: the live snapshots sit at the top of the window and the answer
      // looks right for as long as the window is bigger than the history. It
      // stops looking right when the tombstones outnumber the window, and by
      // then it is a sweep reporting nothing to do while a disk fills.
      for (const n of [1, 2, 3, 4, 5]) {
        await store.write(def, [contractRow(`r${n}`, `row ${n}`, n)], {
          snapshotId: `load-${n}`,
          principalId: 'contract',
          batch: 0,
        });
        await store.commit(def, `load-${n}`);
      }
      await store.dropSnapshot(def, 'load-3');
      await store.dropSnapshot(def, 'load-4');

      const bounded = await live.call(store, def, 3);
      expect(bounded.map((ref) => ref.id)).toEqual(['load-5', 'load-2', 'load-1']);
      // Nothing dropped comes back at all, at any bound. A caller that has to
      // check `droppedAt` itself has not been given the answer it asked for.
      expect(bounded.every((ref) => ref.droppedAt === undefined)).toBe(true);

      const all = await live.call(store, def);
      expect(all.map((ref) => ref.id)).toEqual(['load-5', 'load-2', 'load-1']);
      // And a bound below the number of live snapshots still truncates, which is
      // the signal a caller reads completeness off: short means complete, full
      // means there may be more.
      expect((await live.call(store, def, 2)).map((ref) => ref.id)).toEqual(['load-5', 'load-2']);
    });

    it('finds one snapshot by id whatever its age, tombstone included', async (context) => {
      const store = tombstoneSubject(context);
      if (!store) return;
      const find = store.findSnapshot;
      if (!find) {
        skipping(
          context,
          'implements no findSnapshot(), so an id older than the newest window cannot be told ' +
            'apart from an id that never named a load of this type.',
        );
        return;
      }
      const def = await droppedFixture(store, 'ContractFindSnapshot');

      // The tombstone, by name. This is the read an eviction makes to learn the
      // row count and the archive ref of a candidate it decided on hours ago,
      // and the candidate's id came off a checkpoint rather than off a list — so
      // it has to resolve without recency having anything to do with it.
      const tombstone = await find.call(store, def, 'load-a');
      expect(tombstone?.droppedAt).toBeDefined();
      expect(tombstone?.rowCount).toBe(2);
      expect(tombstone?.principalId).toBe('contract');

      const live = await find.call(store, def, 'load-b');
      expect(live?.droppedAt).toBeUndefined();
      expect(live?.rowCount).toBe(1);

      // Absent means absent, and it has to stay distinguishable from a tombstone:
      // one of them says "that data was deleted on the 8th" and the other says
      // "no load of this type was ever called that".
      expect(await find.call(store, def, 'load-never')).toBeUndefined();
    });

    it('refuses to read a dropped snapshot, and refuses to commit one', async (context) => {
      const store = tombstoneSubject(context);
      if (!store) return;
      const list = store.listSnapshots;
      if (!list) return;
      const def = await droppedFixture(store, 'ContractTombstoneRefusal');
      const tombstone = (await list.call(store, def)).find((ref) => ref.id === 'load-a');

      // Refused with a sentence, not answered with an empty page. An empty page
      // here is indistinguishable from a filter that matched nothing and from a
      // load that collapsed, which is the confusion this whole field exists to
      // prevent — so the message has to carry enough to act on: which snapshot,
      // of which type, how large it was, and when somebody dropped it.
      const refusal = await readAll(store, def, 'load-a').then(
        () => undefined,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      expect(refusal).toBeDefined();
      expect(refusal).toContain('load-a');
      expect(refusal).toContain(def.name);
      expect(refusal).toContain('2 row');
      expect(refusal).toContain(String(tombstone?.droppedAt));

      // The refusal that matters most. `commit` is how a rollback names an
      // older snapshot, and committing a tombstone points a published type at a
      // load holding nothing — silently, because a store recounting the rows
      // finds zero and an empty load is a thing that legitimately happens.
      await expect(store.commit(def, 'load-a')).rejects.toThrow(/dropped on/i);
      expect(idsOf(await readAll(store, def))).toEqual(['c']);
    });

    it('does not merge an incremental load onto a snapshot whose rows were dropped', async (context) => {
      if (!supportsCarryForward(subject.store)) {
        skipping(context, 'is not a CatalogMergeStore, so there is no merge to point anywhere.');
        return;
      }
      if (!subject.store.capabilities.timeTravel) {
        skipping(context, 'declares timeTravel: false, so there is no older snapshot to roll to.');
        return;
      }
      const store = subject.store;
      const def = await ready('ContractMergeOntoTombstone');

      // The ordinary cleanup after a bad load: roll back to the good snapshot,
      // then drop the bad one. Reachable only because the record now survives
      // the drop — which is what makes "the newest committed snapshot" and "a
      // snapshot that still has rows" two different things for the first time.
      await store.write(def, [contractRow('a', 'alpha', 1), contractRow('b', 'bravo', 2)], {
        snapshotId: 'load-a',
        principalId: 'contract',
        batch: 0,
      });
      await store.commit(def, 'load-a');
      await store.write(def, [contractRow('a', 'wrong', 99)], {
        snapshotId: 'load-b',
        principalId: 'contract',
        batch: 0,
      });
      await store.commit(def, 'load-b');
      await store.commit(def, 'load-a');
      await store.dropSnapshot(def, 'load-b');

      // The ids are chosen so that a store ordering by `(createdAt, snapshotId)`
      // descending would pick the tombstone on a tie: `load-b` sorts above
      // `load-a`. A case whose two snapshots landed in the same millisecond
      // would otherwise pass for the wrong reason.
      await store.write(def, [contractRow('c', 'charlie', 3)], {
        snapshotId: 'load-c',
        principalId: 'contract',
        batch: 0,
      });
      const merged = await store.carryForward(def, 'load-c', { principalId: 'contract' });

      // Merged onto the newest committed snapshot that still holds rows, which
      // is also the one being served. Merging onto the tombstone would have
      // copied nothing and committed a full replacement wearing an incremental
      // load's name — a dataset silently reduced to whatever this run fetched.
      expect(merged.from).toBe('load-a');
      expect(merged.carried).toBe(2);
      expect(merged.total).toBe(3);

      await store.commit(def, 'load-c');
      expect(idsOf(await readAll(store, def))).toEqual(['a', 'b', 'c']);
    });

    it('names the snapshot it is actually serving, including after a rollback', async (context) => {
      const current = subject.store.currentSnapshot;
      if (!current) {
        // Optional on the interface, and the fallback a caller is left with —
        // "newest snapshot in the list" — is a guess. Skipped rather than
        // emulated here, because emulating it would be writing the guess down as
        // if it were the answer.
        skipping(
          context,
          'implements no currentSnapshot(), so a caller is left guessing "newest in the list".',
        );
        return;
      }
      const def = await ready('ContractCurrentSnapshot');

      expect(await current.call(subject.store, def)).toBeUndefined();

      await subject.store.write(def, [contractRow('a', 'first', 1)], {
        snapshotId: 'v1',
        principalId: 'contract',
        batch: 0,
      });
      await subject.store.commit(def, 'v1');
      expect((await current.call(subject.store, def))?.id).toBe('v1');

      await subject.store.write(def, [contractRow('a', 'bad', 99)], {
        snapshotId: 'v2',
        principalId: 'contract',
        batch: 0,
      });
      await subject.store.commit(def, 'v2');
      expect((await current.call(subject.store, def))?.id).toBe('v2');

      // The case this method exists for. Rolling a bad load back means
      // committing an *older* snapshot again, after which "newest committed
      // snapshot" and "the one being served" are different rows — and a caller
      // reconstructing current from a list would confidently name the load that
      // was just rolled back.
      await subject.store.commit(def, 'v1');
      expect((await current.call(subject.store, def))?.id).toBe('v1');
      expect((await readAll(subject.store, def)).rows[0]?.label).toBe('first');
    });

    it('carries the previous snapshot forward, letting the incoming rows win', async (context) => {
      if (!supportsCarryForward(subject.store)) {
        // Asked through the core package's own predicate rather than by looking
        // for the method here, so the suite agrees with the library about what
        // "can merge" means instead of keeping a second opinion. A store that
        // cannot merge produces a refusal at the connector, which is the correct
        // outcome and not a contract failure.
        skipping(
          context,
          'is not a CatalogMergeStore, so incremental loads are refused rather than merged.',
        );
        return;
      }
      const store = subject.store;
      const def = await ready('ContractCarryForward');

      await store.write(
        def,
        [
          contractRow('a', 'alpha', 1),
          contractRow('b', 'bravo', 2),
          contractRow('c', 'charlie', 3),
        ],
        { snapshotId: 'full', principalId: 'contract', batch: 0 },
      );
      await store.commit(def, 'full');

      // An incremental run: one row changed, one is new, and the source said
      // nothing at all about the other two.
      await store.write(
        def,
        [contractRow('b', 'bravo-updated', 20), contractRow('d', 'delta', 4)],
        {
          snapshotId: 'incremental',
          principalId: 'contract',
          batch: 0,
        },
      );

      const merged = await store.carryForward(def, 'incremental', {
        principalId: 'contract',
      });
      expect(merged.from).toBe('full');
      expect(merged.carried).toBe(2);
      expect(merged.total).toBe(4);

      // Safe to call twice with the same arguments, and not as a nicety: the
      // same durable retry that re-sends every batch re-runs this too. A second
      // call that added to the first would double every carried row, and the
      // snapshot would still commit.
      const again = await store.carryForward(def, 'incremental', {
        principalId: 'contract',
      });
      expect(again).toEqual(merged);

      await store.commit(def, 'incremental');
      const rows = await readAll(store, def);
      expect(rows.total).toBe(4);
      expect(idsOf(rows)).toEqual(['a', 'b', 'c', 'd']);
      expect(rows.rows.map((row) => row.label)).toEqual([
        'alpha',
        'bravo-updated',
        'charlie',
        'delta',
      ]);
      expect(rows.rows.map((row) => row.score)).toEqual([1, 20, 3, 4]);
    });

    it('refuses to commit a merge a later batch invalidated', async (context) => {
      if (!supportsCarryForward(subject.store)) {
        skipping(context, 'is not a CatalogMergeStore, so it has no merge to invalidate.');
        return;
      }
      const store = subject.store;
      const def = await ready('ContractStaleMerge');

      await store.write(def, [contractRow('a', 'alpha', 1), contractRow('b', 'bravo', 2)], {
        snapshotId: 'full',
        principalId: 'contract',
        batch: 0,
      });
      await store.commit(def, 'full');

      await store.write(def, [contractRow('a', 'alpha-2', 10)], {
        snapshotId: 'late',
        principalId: 'contract',
        batch: 0,
      });
      await store.carryForward(def, 'late', { principalId: 'contract' });

      // The batch that arrives after the merge. It has nothing to displace —
      // the merge already decided which of the previous snapshot's rows survive
      // — so the old version of every row it touches is still sitting there,
      // carried, and the snapshot now holds both under one primary key.
      await store.write(def, [contractRow('b', 'bravo-2', 20)], {
        snapshotId: 'late',
        principalId: 'contract',
        batch: 1,
      });

      await expect(store.commit(def, 'late')).rejects.toThrow(/carr/i);

      // And the documented repair: merge again, then commit — in that order.
      await store.carryForward(def, 'late', { principalId: 'contract' });
      await store.commit(def, 'late');
      const rows = await readAll(store, def);
      expect(idsOf(rows)).toEqual(['a', 'b']);
      expect(rows.rows.map((row) => row.label)).toEqual(['alpha-2', 'bravo-2']);
    });

    describeSnapshotStreamCases();

    it('hands a published type and its properties back as they were written', async (context) => {
      const readBack = subject.readBackType;
      if (!readBack) {
        // A store that keeps no model of its own. Stated rather than silent:
        // the deployment shape it implies is a real one — this adapter for the
        // rows, something else for the model — and a reader of this output
        // should be able to tell that apart from a case nobody wrote.
        expect(subject.noModelReason ?? '').not.toBe('');
        skipping(context, `keeps no model of its own. ${subject.noModelReason}`);
        return;
      }
      const def = await ready('ContractModelRoundTrip');

      const stored = await readBack.call(subject, def.name);
      expect(stored).toBeDefined();
      expect(stored?.name).toBe(def.name);
      expect(stored?.displayName).toBe(def.displayName);
      expect(stored?.pluralDisplayName).toBe(def.pluralDisplayName);
      expect(stored?.group).toBe(def.group);
      expect(stored?.primaryKey).toEqual(['id']);
      // Compared property by property rather than by deep-equalling the def:
      // `enriched` is *computed* on the way out from whether anybody wrote a
      // description, a unit or a classification, so it is a derived field and
      // asserting it against the input would be asserting that the store failed
      // to derive anything.
      expect(
        stored?.properties.map((each) => ({
          name: each.name,
          type: each.type,
          primary: each.primary,
          nullable: each.nullable,
          hidden: each.hidden,
          order: each.order,
        })),
      ).toEqual(
        def.properties.map((each) => ({
          name: each.name,
          type: each.type,
          primary: each.primary,
          nullable: each.nullable,
          hidden: each.hidden,
          order: each.order,
        })),
      );
    });
  });
}
