import type {
  CatalogFilterOperator,
  CatalogObjectTypeDef,
  CatalogPropertyDef,
  CatalogReadQuery,
  CatalogReadResult,
  CatalogResolvedFilter,
  CatalogStoreCapabilities,
  CatalogWriteStore,
  SnapshotRef,
} from '@dudousxd/nestjs-catalog';
import { CATALOG_FILTER_OPERATORS, supportsObjectFilters } from '@dudousxd/nestjs-catalog';
import { describe, expect, it } from 'vitest';
import { FanoutCatalogStore } from './fanout.store';
import { InMemoryFanoutJournal } from './journal';

/**
 * Whether this store's answer to "can you filter?" is one it can keep.
 *
 * **The declaration is the whole subject, and it is load-bearing in a way a
 * boolean rarely is.** The core service offers a screen exactly the operators its
 * store reports and refuses any filter naming an operator outside that set, so
 * the report is not advice — it decides both which controls exist and which
 * requests are answered at all. A store that reports too little offers no filter
 * controls, which is a visible, complainable absence. A store that reports too
 * much returns a full page of rows dressed as the matching ones, which is the
 * failure with no symptom: nothing errors, the count agrees with the rows, and
 * the reader concludes their filter matched everything.
 *
 * The fan-out is where that report is easiest to get wrong, because it does not
 * do the filtering — {@link FanoutCatalogStore.read} hands the query to the
 * primary and returns what comes back. So its answer is only as true as the
 * primary's, which is what every case here is about: that it says yes exactly
 * when the primary would, that the property is genuinely *absent* rather than
 * present-and-empty when the primary cannot filter, and that the one read path
 * which does not go to the primary refuses rather than answers.
 *
 * **Fakes rather than engines, and deliberately.** Whether a predicate returns
 * the right rows is a property of the adapter's SQL, and it is pinned where it
 * can only be pinned — the shared store contract, against a real MySQL and a real
 * ClickHouse, which runs against a fan-out too. What is left is this package's
 * own wiring, and a real database cannot make "is the field there" more true.
 */

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

const LABEL = property('label', false);

const TYPE: CatalogObjectTypeDef = {
  name: 'Widget',
  displayName: 'Widget',
  pluralDisplayName: 'Widgets',
  tableName: 'obj_widget',
  group: 'Test',
  primaryKey: ['id'],
  enriched: false,
  properties: [property('id', true), LABEL],
  relations: [],
};

const ROWS = [
  { id: 'a', label: 'alpha' },
  { id: 'b', label: 'bravo' },
];

/** The filter every case sends: `label` equals `alpha`, as the service resolves one. */
const LABEL_IS_ALPHA: CatalogResolvedFilter[] = [{ property: LABEL, op: 'eq', value: 'alpha' }];

const QUERY: CatalogReadQuery = { page: 1, size: 10, sort: 'id', dir: 'asc' };

/**
 * A store holding two rows, which filters only if it was told it can.
 *
 * The filtering is real rather than a recorded call, so a case can assert on the
 * rows that come back. That matters most for the negative store: a fake that
 * ignored filters silently would make "the fan-out refused" and "the fan-out
 * asked and got everything" produce the same green test, which is precisely the
 * confusion the declaration exists to remove.
 */
class FakeStore implements CatalogWriteStore {
  readonly capabilities = CAPABILITIES;
  readonly objectFilterOperators?: readonly CatalogFilterOperator[];
  /** Every query this store was actually asked, in order. */
  readonly seen: CatalogReadQuery[] = [];

  constructor(operators?: readonly CatalogFilterOperator[]) {
    // Assigned only when there is something to declare, so the property is
    // absent rather than undefined — the same distinction the fan-out itself
    // has to keep, since `supportsObjectFilters` asks by looking for it.
    if (operators) this.objectFilterOperators = operators;
  }

  async ensureType(): Promise<void> {}

  async write(): Promise<{ written: number }> {
    return { written: 0 };
  }

  async commit(): Promise<SnapshotRef> {
    return { id: 'snap', createdAt: new Date(0).toISOString(), rowCount: 2, principalId: 'test' };
  }

  async dropSnapshot(): Promise<void> {}

  async read(
    _type: CatalogObjectTypeDef,
    _fields: string[],
    query: CatalogReadQuery,
  ): Promise<CatalogReadResult> {
    this.seen.push(query);
    const rows = ROWS.filter((row) =>
      (query.filters ?? []).every((filter) => {
        if (!this.objectFilterOperators) return true;
        return Reflect.get(row, filter.property.name) === filter.value;
      }),
    );
    return { rows: rows.map((row) => ({ ...row })), total: rows.length };
  }
}

function wire(primary: CatalogWriteStore, follower: CatalogWriteStore): FanoutCatalogStore {
  return new FanoutCatalogStore(
    { name: 'primary', store: primary },
    [{ name: 'follower', store: follower, strictness: 'recorded' }],
    new InMemoryFanoutJournal(),
  );
}

// ---------------------------------------------------------------------------

describe('what a fan-out says it can filter', () => {
  it('offers what the primary offers, and the ordinary read really is narrowed', async () => {
    const primary = new FakeStore(CATALOG_FILTER_OPERATORS);
    const fanout = wire(primary, new FakeStore());

    expect(supportsObjectFilters(fanout)).toBe(true);
    expect(fanout.objectFilterOperators).toEqual(CATALOG_FILTER_OPERATORS);

    // The assertion that matters, and the one a flag cannot make: the rows come
    // back narrowed. A fan-out that declared the operators and dropped `filters`
    // on the way through would satisfy every expectation above this line.
    const result = await fanout.read(TYPE, ['id', 'label'], {
      ...QUERY,
      filters: LABEL_IS_ALPHA,
    });
    expect(result.rows.map((row) => row.id)).toEqual(['a']);
    expect(result.total).toBe(1);
    expect(primary.seen.at(-1)?.filters).toEqual(LABEL_IS_ALPHA);
  });

  it('offers a subset when the primary offers a subset, rather than the whole contract', () => {
    // A store may honour some operators and not others — a key-value backing that
    // can match and cannot compare, say. The fan-out has to carry the subset
    // through unchanged: widening it to the contract's list would put controls on
    // the screen that the primary then refuses, and narrowing it would hide
    // controls that work.
    const narrow: readonly CatalogFilterOperator[] = ['eq', 'ne'];
    const fanout = wire(new FakeStore(narrow), new FakeStore());
    expect(fanout.objectFilterOperators).toEqual(narrow);
  });

  it('says nothing at all when the primary says nothing, and absence is not an empty list', () => {
    const fanout = wire(new FakeStore(), new FakeStore(CATALOG_FILTER_OPERATORS));

    // `supportsObjectFilters` asks whether the property is an array, so a fan-out
    // that always carried the field — as `[]`, or as `undefined` — would answer
    // the question differently from a store that genuinely cannot filter. `in`
    // rather than a truthiness check, because that is the distinction: `declare`
    // emits no field, and an unassigned one has to be genuinely missing.
    expect('objectFilterOperators' in fanout).toBe(false);
    expect(supportsObjectFilters(fanout)).toBe(false);

    // And it is the *primary* that decides. The follower here filters perfectly
    // well and nothing routes an ordinary read to it, so borrowing its answer
    // would be the fan-out promising on behalf of a store it never reads.
    expect(fanout.objectFilterOperators).toBeUndefined();
  });
});

describe('reading a named follower with filters', () => {
  it('refuses when that follower cannot filter, instead of returning every row', async () => {
    // The one read path that does not go to the primary, which is why the check
    // is on it. `objectFilterOperators` reports the primary's answer; a follower
    // that filters nothing would hand back its whole table, and the operator
    // comparing follower against primary before a flip would read that as the
    // follower holding extra rows — the exact wrong conclusion, at the exact
    // moment it is most expensive.
    const follower = new FakeStore();
    const fanout = wire(new FakeStore(CATALOG_FILTER_OPERATORS), follower);

    await expect(
      fanout.readFrom('follower', TYPE, ['id', 'label'], { ...QUERY, filters: LABEL_IS_ALPHA }),
    ).rejects.toThrow(/does not filter object reads/i);

    // Refused before the read, not after it. A store that was asked and had its
    // answer discarded would still have run the scan.
    expect(follower.seen).toEqual([]);
  });

  it('names the operators it does apply when the follower filters, but not that far', async () => {
    const fanout = wire(new FakeStore(CATALOG_FILTER_OPERATORS), new FakeStore(['contains']));

    await expect(
      fanout.readFrom('follower', TYPE, ['id', 'label'], { ...QUERY, filters: LABEL_IS_ALPHA }),
    ).rejects.toThrow(/cannot filter with eq.*applies contains/i);
  });

  it('reads the follower, narrowed, when it can honour what was asked', async () => {
    const follower = new FakeStore(CATALOG_FILTER_OPERATORS);
    const fanout = wire(new FakeStore(CATALOG_FILTER_OPERATORS), follower);

    const result = await fanout.readFrom('follower', TYPE, ['id', 'label'], {
      ...QUERY,
      filters: LABEL_IS_ALPHA,
    });
    expect(result.rows.map((row) => row.id)).toEqual(['a']);
    expect(follower.seen.at(-1)?.filters).toEqual(LABEL_IS_ALPHA);
  });

  it('leaves an unfiltered comparison alone, whatever the follower declares', async () => {
    // The ordinary verification read. Nothing about a follower that cannot filter
    // should stop somebody looking at what it holds — the refusal above is about
    // a filter that would not be applied, not about the follower.
    const follower = new FakeStore();
    const fanout = wire(new FakeStore(CATALOG_FILTER_OPERATORS), follower);

    const result = await fanout.readFrom('follower', TYPE, ['id', 'label'], QUERY);
    expect(result.rows.map((row) => row.id)).toEqual(['a', 'b']);
  });
});
