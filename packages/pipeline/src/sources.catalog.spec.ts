import type {
  CatalogObjectTypeDef,
  CatalogReadQuery,
  CatalogReadResult,
  CatalogReadStore,
  CatalogSnapshotLocation,
  CatalogSnapshotLookupStore,
  CatalogSnapshotStreamStore,
  CatalogStoreCapabilities,
  SnapshotRef,
} from '@dudousxd/nestjs-catalog';
import { CONNECTOR_KINDS } from '@dudousxd/nestjs-catalog';
import { describe, expect, it } from 'vitest';
import { type CatalogTypeReader, SOURCES, fetchCatalog, toRecordStream } from './sources';

/**
 * What a `catalog` source refuses, and what it says while refusing.
 *
 * The case that matters — that it reads one snapshot out of a table holding four
 * — needs a real engine and lives in `sources.catalog.db.spec.ts`. Everything
 * here is the other half: the four states in which reading is **not** possible,
 * each of which would otherwise be a load that committed something plausible.
 *
 * Every one of them refuses rather than returning zero rows, and that is the
 * whole doctrine of the kind: a green run over nothing is the same failure as a
 * green run over twice too much, and the second one only got noticed because
 * somebody summed a column.
 */

const TYPE: CatalogObjectTypeDef = {
  name: 'SubwoReplica',
  displayName: 'Subwo replica',
  pluralDisplayName: 'Subwo replicas',
  tableName: 'obj_subworeplica',
  group: 'Spec',
  primaryKey: ['workOrderId'],
  enriched: true,
  relations: [],
  properties: [
    {
      name: 'workOrderId',
      displayName: 'Work order',
      type: 'string',
      columnName: 'work_order_id',
      nullable: false,
      primary: true,
      hidden: false,
      order: 0,
      enriched: true,
    },
    {
      name: 'actualLaborCost',
      displayName: 'Labor',
      type: 'number',
      columnName: 'actual_labor_cost',
      nullable: true,
      primary: false,
      hidden: false,
      order: 1,
      enriched: true,
    },
  ],
};

const EMULATED: CatalogStoreCapabilities = {
  snapshots: 'emulated',
  writable: true,
  timeTravel: true,
};

/** A store that answers `read` from a script and streams from an array. */
function store(
  answer: CatalogReadResult,
  rows?: Array<Record<string, unknown>>,
  capabilities: CatalogStoreCapabilities = EMULATED,
): CatalogReadStore {
  const base = {
    capabilities,
    async read(_type: CatalogObjectTypeDef, _fields: string[], query: CatalogReadQuery) {
      if (rows === undefined) return answer;
      const size = query.size ?? 25;
      const from = ((query.page ?? 1) - 1) * size;
      return { ...answer, rows: rows.slice(from, from + size) };
    },
  };
  if (rows === undefined) return base;
  const streaming: CatalogSnapshotStreamStore = {
    ...base,
    async *streamSnapshot() {
      for (const row of rows) yield row;
    },
  };
  return streaming;
}

/** One snapshot, as the locator reports it. */
function at(
  typeName: string,
  id: string,
  overrides: Partial<SnapshotRef> = {},
): CatalogSnapshotLocation {
  return {
    typeName,
    snapshot: {
      id,
      createdAt: '2026-08-07T23:14:44.000Z',
      rowCount: 44_720,
      principalId: 'spec',
      ...overrides,
    },
  };
}

/**
 * The same store, able to say what a snapshot id refers to.
 *
 * A separate wrapper rather than a flag on {@link store}, so the tests that
 * assert the *degraded* path — a store that cannot resolve an id — get a store
 * that genuinely cannot rather than one that has been told to pretend.
 */
function locating(
  underlying: CatalogReadStore,
  known: CatalogSnapshotLocation[],
): CatalogSnapshotLookupStore {
  return {
    ...underlying,
    async locateSnapshot(snapshotId: string) {
      return known.filter((each) => each.snapshot.id === snapshotId);
    },
  };
}

/** `null` rather than an omitted argument, so "the catalog knows no type" is expressible. */
function reader(underlying: CatalogReadStore, type: CatalogObjectTypeDef | null = TYPE) {
  const seam: CatalogTypeReader = {
    getType: (name) => (type && name === type.name ? type : undefined),
    store: underlying,
  };
  return seam;
}

async function read(
  config: Record<string, unknown>,
  catalog: CatalogTypeReader | undefined,
): Promise<{ records: unknown[]; notes: string[] }> {
  const stream = toRecordStream(
    await fetchCatalog({
      connector: {
        id: 'src',
        name: 'Read the type',
        kind: 'catalog',
        targetType: '',
        config,
        enabled: true,
        createdBy: 'spec',
        createdAt: 'now',
        updatedAt: 'now',
      },
      state: {},
      mode: 'full',
      catalog,
    }),
  );
  const records: unknown[] = [];
  for await (const record of stream.records) records.push(record);
  return { records, notes: stream.notes() };
}

describe('the fetcher map', () => {
  it('has an entry for every kind the vocabulary declares', () => {
    // The map is typed `Record<ConnectorKind, SourceFetcher>` so this cannot
    // compile otherwise — which is the repair. This asserts the other half: that
    // no entry is present under a name the vocabulary does not have, which a
    // total record does not prevent on its own.
    expect(Object.keys(SOURCES).sort()).toEqual([...CONNECTOR_KINDS].sort());
  });
});

describe('a catalog source that cannot read', () => {
  it('refuses when the node names no type', async () => {
    await expect(read({}, reader(store({ rows: [], total: 0 })))).rejects.toThrow(
      /names no object type/,
    );
  });

  it('refuses when nothing wired a store into the read', async () => {
    // Not "there is no data" — there is no way in. Said as its own sentence
    // because the repair is a deployment one and nothing about the graph.
    await expect(read({ objectType: 'SubwoReplica' }, undefined)).rejects.toThrow(
      /nothing wired a catalog store into this read/,
    );
  });

  it('refuses a type the catalog has never heard of', async () => {
    await expect(
      read({ objectType: 'SubwoReplica' }, reader(store({ rows: [], total: 0 }), null)),
    ).rejects.toThrow(/has no type by that name/);
  });

  it('refuses a type that has never committed, and says which', async () => {
    // The store answers with no snapshot at all, which on a store that keeps
    // history means the pointer is unset: published, never loaded.
    await expect(
      read({ objectType: 'SubwoReplica' }, reader(store({ rows: [], total: 0 }))),
    ).rejects.toThrow(/"SubwoReplica" has no committed snapshot/);
  });

  it('refuses a store that cannot hand a whole snapshot over, rather than paging it', async () => {
    // A paged fallback is the thing that looks harmless: an offset walk is
    // quadratic in the size of the type, and paging is only correct under an
    // ordering `read` does not promise. Both hazards are silent, so the answer
    // is a refusal that names them.
    const cannot = store({ rows: [], total: 2, snapshot: { id: 'load-2', current: true } });
    await expect(read({ objectType: 'SubwoReplica' }, reader(cannot))).rejects.toThrow(
      /cannot hand a whole snapshot over a row at a time/,
    );
  });
});

describe('a catalog source that names a snapshot it cannot read', () => {
  const rows = [{ workOrderId: 'a', actualLaborCost: 1 }];
  const serving = { rows: [], total: 1, snapshot: { id: 'load-2', current: true } };

  it('refuses an id that no type in the catalog has', async () => {
    // The first of the three, and the one that would otherwise be silent: a
    // pinned read of an id nothing carries returns zero rows, which is
    // indistinguishable from a snapshot that is genuinely empty. Existence
    // cannot be read off a count, so it is asked.
    await expect(
      read(
        { objectType: 'SubwoReplica', objectSnapshot: 'load-nope' },
        reader(locating(store(serving, rows), [at('SubwoReplica', 'load-1')])),
      ),
    ).rejects.toThrow(/Snapshot load-nope of "SubwoReplica" cannot be found/);
  });

  it('refuses an id that belongs to another type, and says which', async () => {
    // The second, and the mistake somebody actually makes: an id copied out of
    // one type's history and pasted under another. "Not found" would send them
    // looking for a snapshot that is sitting one type along.
    await expect(
      read(
        { objectType: 'SubwoReplica', objectSnapshot: 'wf-02a60bd6' },
        reader(locating(store(serving, rows), [at('AfFleetReplica', 'wf-02a60bd6')])),
      ),
    ).rejects.toThrow(/is not a snapshot of "SubwoReplica" — it belongs to "AfFleetReplica"/);
  });

  it('refuses a tombstoned snapshot with its date, rather than reading nothing', async () => {
    // The third. The rows are gone and the record is kept on purpose, which is
    // exactly what makes this reachable — and an empty read here would be
    // indistinguishable from a load that collapsed.
    await expect(
      read(
        { objectType: 'SubwoReplica', objectSnapshot: 'load-1' },
        reader(
          locating(store(serving, rows), [
            at('SubwoReplica', 'load-1', { droppedAt: '2026-08-08T02:00:00.000Z' }),
          ]),
        ),
      ),
    ).rejects.toThrow(/dropped on 2026-08-08T02:00:00.000Z/);
  });

  it('says where an evicted snapshot went, rather than only that it is gone', async () => {
    // Not in this release's scope to read one back — and that is precisely why
    // the refusal has to name the archive. "The rows are gone" would send
    // somebody to re-run a load whose data is sitting in a bucket.
    await expect(
      read(
        { objectType: 'SubwoReplica', objectSnapshot: 'load-1' },
        reader(
          locating(store(serving, rows), [
            at('SubwoReplica', 'load-1', {
              droppedAt: '2026-08-08T02:00:00.000Z',
              archive: {
                format: 'parquet',
                disk: 'cold',
                path: 's3://catalog-archive/SubwoReplica/load-1',
                rowCount: 44_720,
                bytes: 12_000_000,
                checksum: 'sha256:abc',
                writtenAt: '2026-08-08T01:00:00.000Z',
                verifiedAt: '2026-08-08T01:05:00.000Z',
              },
            }),
          ]),
        ),
      ),
    ).rejects.toThrow(/s3:\/\/catalog-archive\/SubwoReplica\/load-1.*"cold" disk/s);
  });

  it('refuses a relative reference at the moment of the read, not only on the canvas', async () => {
    // A connector config is a JSON column: a row can be written by curl, by an
    // older build, or by a newer one. The validator refusing it is not the same
    // thing as it being impossible.
    await expect(
      read(
        { objectType: 'SubwoReplica', objectSnapshot: 'previous' },
        reader(locating(store(serving, rows), [at('SubwoReplica', 'load-1')])),
      ),
    ).rejects.toThrow(/not a snapshot id, it is a way of describing one/);
  });

  it('refuses a store that would silently ignore the snapshot it was given', async () => {
    // `CatalogReadQuery.snapshot` is documented as ignored where `timeTravel` is
    // false, and "ignored" is the dangerous word: the read succeeds against the
    // current load and reports the id it was asked for.
    const flat = store({ rows: [], total: 1 }, rows, {
      snapshots: 'none',
      writable: true,
      timeTravel: false,
    });
    await expect(
      read({ objectType: 'SubwoReplica', objectSnapshot: 'load-1' }, reader(flat)),
    ).rejects.toThrow(/cannot read a snapshot other than the one it is serving/);
  });

  it('refuses a store that cannot say what the id refers to at all', async () => {
    // No locator and no snapshot list. Reading anyway would be reading an id
    // nothing has vouched for, and a wrong one comes back as zero rows.
    await expect(
      read({ objectType: 'SubwoReplica', objectSnapshot: 'load-1' }, reader(store(serving, rows))),
    ).rejects.toThrow(/cannot say what that id refers to/);
  });

  it('falls back to the type’s own history when the store cannot look across types', async () => {
    // The degraded path, and the refusal admits what it did not check rather
    // than implying it looked everywhere.
    const listing: CatalogReadStore = {
      ...store(serving, rows),
      async listSnapshots() {
        return [at('SubwoReplica', 'load-1').snapshot];
      },
    };
    await expect(
      read({ objectType: 'SubwoReplica', objectSnapshot: 'load-9' }, reader(listing)),
    ).rejects.toThrow(/only be asked about one type at a time/);
    // …and it still separates a tombstone from a missing id on that path.
    const tombstoned: CatalogReadStore = {
      ...store(serving, rows),
      async listSnapshots() {
        return [at('SubwoReplica', 'load-1', { droppedAt: '2026-08-08T02:00:00.000Z' }).snapshot];
      },
    };
    await expect(
      read({ objectType: 'SubwoReplica', objectSnapshot: 'load-1' }, reader(tombstoned)),
    ).rejects.toThrow(/dropped on 2026-08-08T02:00:00.000Z/);
  });
});

describe('a catalog source that can read', () => {
  const rows = [
    { workOrderId: 'a', actualLaborCost: 1 },
    { workOrderId: 'b', actualLaborCost: 2 },
  ];

  it('streams the snapshot the store says it is currently serving', async () => {
    const answered = await read(
      { objectType: 'SubwoReplica' },
      reader(store({ rows: [], total: 2, snapshot: { id: 'load-2', current: true } }, rows)),
    );
    expect(answered.records).toEqual(rows);
    expect(answered.notes[0]).toMatch(/Read snapshot load-2 of "SubwoReplica"/);
    expect(answered.notes[0]).toMatch(/resolved when this node ran/);
  });

  it('trims the type name, so a trailing space does not become a type nobody published', async () => {
    const answered = await read(
      { objectType: '  SubwoReplica ' },
      reader(store({ rows: [], total: 2, snapshot: { id: 'load-2', current: true } }, rows)),
    );
    expect(answered.records).toHaveLength(2);
  });

  it('says so when the two counts of one snapshot disagree', async () => {
    // `total` and the streamed count come off different statements over the same
    // committed snapshot, and a committed snapshot is immutable — so they agree,
    // and the only thing that would make them differ is a predicate that stopped
    // matching what the count matched. Which is the defect this kind exists for,
    // so it is said out loud on the run rather than left to be inferred.
    const answered = await read(
      { objectType: 'SubwoReplica' },
      reader(store({ rows: [], total: 9, snapshot: { id: 'load-2', current: true } }, rows)),
    );
    expect(answered.notes.join(' ')).toMatch(/reported 9 rows and 2 were read/);
  });

  it('reads the snapshot the node names, and says it is not the one being served', async () => {
    const answered = await read(
      { objectType: 'SubwoReplica', objectSnapshot: 'load-1' },
      reader(
        locating(store({ rows: [], total: 2, snapshot: { id: 'load-1', current: false } }, rows), [
          at('SubwoReplica', 'load-1'),
          at('SubwoReplica', 'load-2'),
        ]),
      ),
    );
    expect(answered.records).toEqual(rows);
    expect(answered.notes[0]).toMatch(/Read snapshot load-1 of "SubwoReplica"/);
    expect(answered.notes[0]).toMatch(/named on this node/);
    expect(answered.notes[0]).toMatch(/NOT the one the catalog is currently serving/);
    // The pin is the name. Said out loud because the whole objection to a
    // relative reference is that it would not be.
    expect(answered.notes[0]).toMatch(/the id is the pin/);
  });

  it('says when the snapshot named happens to be the one being served', async () => {
    const answered = await read(
      { objectType: 'SubwoReplica', objectSnapshot: 'load-2' },
      reader(
        locating(store({ rows: [], total: 2, snapshot: { id: 'load-2', current: true } }, rows), [
          at('SubwoReplica', 'load-2'),
        ]),
      ),
    );
    expect(answered.notes[0]).toMatch(/it is also the one the catalog is currently serving/);
  });

  it('reads a store that keeps no history without pinning, and says it could not', async () => {
    // The one case where an absent snapshot is not a refusal: there is no
    // snapshot to have, so the rows are the current state. The note is the whole
    // of what is lost — an empty type and a never-loaded one are the same thing
    // to such a store, and nothing here can tell them apart.
    const flat = store({ rows: [], total: 2 }, rows, {
      snapshots: 'none',
      writable: true,
      timeTravel: false,
    });
    const answered = await read({ objectType: 'SubwoReplica' }, reader(flat));
    expect(answered.records).toEqual(rows);
    expect(answered.notes.join(' ')).toMatch(/keeps no history/);
  });
});
