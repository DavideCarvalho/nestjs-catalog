import type {
  CatalogObjectTypeDef,
  CatalogPropertyDef,
  CatalogQueryStore,
  CatalogReadResult,
  CatalogWriteStore,
  ScalarType,
} from '@dudousxd/nestjs-catalog';
import {
  isCatalogStoreCapabilities,
  isWriteStore,
  supportsCarryForward,
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
 * Run the contract.
 *
 * `boot` is a getter rather than the store itself because the engine is started
 * in the spec file's own `beforeAll`, which vitest runs before this suite's —
 * so the container is up by the time any case asks for it, and the suite is
 * still declared at collection time where the reporter can see it.
 */
export function describeCatalogStoreContract(boot: () => ContractStore): void {
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
      // Both engines quote with backticks, so one statement serves both.
      const result = await store.runQuery({
        sql: `SELECT \`Asset_Id\` FROM \`${current?.name}\``,
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
