import type {
  CatalogObjectTypeDef,
  CatalogReadQuery,
  CatalogReadResult,
  CatalogReadStore,
  CatalogSnapshotStreamStore,
  CatalogStoreCapabilities,
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
