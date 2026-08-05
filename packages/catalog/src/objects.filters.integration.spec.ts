import type { INestApplication } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { CATALOG_FILTER_OPERATORS, type CatalogFilterOperator } from './catalog.filters';
import { CatalogModule } from './catalog.module';
import { InMemoryCatalogOverlayStore } from './catalog.overlay-store';
import { CatalogRegistry } from './catalog.registry.base';
import {
  CATALOG_STORE,
  type CatalogReadQuery,
  type CatalogReadResult,
  type CatalogReadStore,
  type CatalogStoreCapabilities,
} from './catalog.store';
import type { CatalogGraph, CatalogObjectTypeDef, CatalogSnapshot } from './catalog.types';

/**
 * `GET objects/:name` with filters and a snapshot, over real HTTP.
 *
 * Over HTTP rather than against the service, because half of what is under test
 * is the route: `?filter=` may appear once or many times, Express hands back a
 * string for the first case and an array for the second, and a parameter that
 * arrives as the wrong shape is a filter that silently does not apply.
 *
 * The store records what it was asked for. That is the assertion that matters
 * for a filter — not that the response is smaller, which a store returning fewer
 * rows for its own reasons would also produce, but that the predicate reached the
 * thing that reads the rows.
 */

const TYPE: CatalogObjectTypeDef = {
  name: 'Mvr',
  displayName: 'Vehicle',
  pluralDisplayName: 'Vehicles',
  group: 'Fleet',
  tableName: 'obj_mvr',
  enriched: true,
  primaryKey: ['id'],
  properties: [
    {
      name: 'id',
      displayName: 'Id',
      type: 'string',
      columnName: 'id',
      nullable: false,
      primary: true,
      hidden: false,
      order: 0,
      enriched: false,
    },
    {
      // The live case: a source column called `Asset Id` cannot be a SQL
      // identifier, so the property is `Asset_Id` and the original is kept.
      name: 'Asset_Id',
      displayName: 'Asset',
      type: 'string',
      columnName: 'Asset Id',
      nullable: true,
      primary: false,
      hidden: false,
      order: 1,
      enriched: false,
    },
    {
      name: 'miles',
      displayName: 'Miles',
      type: 'number',
      columnName: 'miles',
      nullable: true,
      primary: false,
      hidden: false,
      order: 2,
      enriched: false,
    },
    {
      name: 'operator',
      displayName: 'Operator',
      type: 'string',
      columnName: 'operator',
      nullable: true,
      primary: false,
      hidden: false,
      order: 3,
      classification: 'CUI',
      enriched: false,
    },
  ],
  relations: [],
};

@Injectable()
class StubRegistry extends CatalogRegistry {
  getSnapshot(): CatalogSnapshot {
    return {
      version: 1,
      generatedAt: new Date(0).toISOString(),
      stats: { types: 1, properties: TYPE.properties.length, relations: 0, enrichedTypes: 1 },
      types: [TYPE],
    };
  }
  getType(name: string): CatalogObjectTypeDef | undefined {
    return name === TYPE.name ? TYPE : undefined;
  }
  getGraph(): CatalogGraph {
    return { nodes: [], edges: [] };
  }
  patchType(): Promise<CatalogObjectTypeDef | undefined> {
    return Promise.resolve(TYPE);
  }
  patchProperty(): Promise<CatalogObjectTypeDef | undefined> {
    return Promise.resolve(TYPE);
  }
  resetOverlay(): Promise<void> {
    return Promise.resolve();
  }
}

/** The last query any store in this file was asked for. */
let lastQuery: CatalogReadQuery | undefined;

@Injectable()
class FilteringStore implements CatalogReadStore {
  readonly capabilities: CatalogStoreCapabilities = {
    snapshots: 'emulated',
    writable: true,
    timeTravel: true,
  };
  readonly objectFilterOperators: readonly CatalogFilterOperator[] = CATALOG_FILTER_OPERATORS;

  read(_type: CatalogObjectTypeDef, _fields: string[], query: CatalogReadQuery) {
    lastQuery = query;
    const result: CatalogReadResult = {
      rows: [{ id: 'v-1', Asset_Id: 'A-71', miles: 1200 }],
      total: 1,
      snapshot: { id: query.snapshot ?? 'run-9', current: (query.snapshot ?? 'run-9') === 'run-9' },
    };
    return Promise.resolve(result);
  }
}

/** A store that declares no filtering at all — the ClickHouse/fan-out shape. */
@Injectable()
class PlainStore implements CatalogReadStore {
  readonly capabilities: CatalogStoreCapabilities = {
    snapshots: 'none',
    writable: false,
    timeTravel: false,
  };
  read(_type: CatalogObjectTypeDef, _fields: string[], query: CatalogReadQuery) {
    lastQuery = query;
    return Promise.resolve({ rows: [{ id: 'v-1' }], total: 1 });
  }
}

async function boot(store: typeof FilteringStore | typeof PlainStore) {
  const moduleRef = await Test.createTestingModule({
    imports: [
      CatalogModule.forRoot({
        registry: { provide: CatalogRegistry, useClass: StubRegistry },
        store: { provide: CATALOG_STORE, useClass: store },
        overlayStore: new InMemoryCatalogOverlayStore(),
      }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

describe('reading objects with filters', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    lastQuery = undefined;
  });

  it('tells the caller what each column may be filtered with', async () => {
    app = await boot(FilteringStore);

    const response = await request(app.getHttpServer()).get('/api/catalog/objects/Mvr').expect(200);
    const columns: Array<{ name: string; filterOperators: string[]; columnName?: string }> =
      response.body.columns;

    // Derived per column from its type — no list of filterable columns exists
    // anywhere for a new property to be missing from.
    expect(columns.find((c) => c.name === 'miles')?.filterOperators).toContain('gte');
    expect(columns.find((c) => c.name === 'Asset_Id')?.filterOperators).toContain('contains');
    // Classified: filterable-looking and deliberately not offered.
    expect(columns.find((c) => c.name === 'operator')?.filterOperators).toEqual([]);
  });

  it('carries the source spelling beside the property name', async () => {
    app = await boot(FilteringStore);

    const response = await request(app.getHttpServer()).get('/api/catalog/objects/Mvr').expect(200);
    const asset = response.body.columns.find((c: { name: string }) => c.name === 'Asset_Id');

    // Both, because they are for different people: the property name is what a
    // filter must carry, the source spelling is what the person holding the
    // spreadsheet recognises.
    expect(asset).toMatchObject({ name: 'Asset_Id', columnName: 'Asset Id' });
  });

  it('passes one filter to the store, resolved to the type’s own property', async () => {
    app = await boot(FilteringStore);

    await request(app.getHttpServer())
      .get('/api/catalog/objects/Mvr?filter=Asset_Id:contains:71')
      .expect(200);

    expect(lastQuery?.filters).toHaveLength(1);
    expect(lastQuery?.filters?.[0].op).toBe('contains');
    // The definition, not the string that arrived: this is what stops a caller's
    // text from ever being a column name.
    expect(lastQuery?.filters?.[0].property).toBe(
      TYPE.properties.find((p) => p.name === 'Asset_Id'),
    );
  });

  it('accepts the repeated form, which is how a range is expressed', async () => {
    app = await boot(FilteringStore);

    await request(app.getHttpServer())
      .get('/api/catalog/objects/Mvr?filter=miles:gte:1000&filter=miles:lte:5000')
      .expect(200);

    // Express hands back an array here and a bare string above. Both have to
    // arrive as filters or the second one silently does nothing.
    expect(lastQuery?.filters?.map((filter) => [filter.op, filter.value])).toEqual([
      ['gte', 1000],
      ['lte', 5000],
    ]);
  });

  it('refuses a filter on a column the read would not return', async () => {
    app = await boot(FilteringStore);

    const response = await request(app.getHttpServer())
      .get('/api/catalog/objects/Mvr?filter=operator:eq:Smith')
      .expect(400);

    expect(response.body.message).toContain('operator');
    // Nothing reached the store: a refusal, not a read with the filter dropped.
    expect(lastQuery).toBeUndefined();
  });

  it('refuses a value that is not of the column’s type', async () => {
    app = await boot(FilteringStore);

    const response = await request(app.getHttpServer())
      .get('/api/catalog/objects/Mvr?filter=miles:gte:abc')
      .expect(400);

    expect(response.body.message).toContain('not a number');
    expect(lastQuery).toBeUndefined();
  });

  it('refuses rather than answering unfiltered on a store that cannot filter', async () => {
    app = await boot(PlainStore);

    const response = await request(app.getHttpServer())
      .get('/api/catalog/objects/Mvr?filter=miles:gte:1000')
      .expect(400);

    // The failure being prevented: this store ignores `filters`, so the read
    // would have come back whole and been drawn as the matching rows.
    expect(response.body.message).toContain('does not filter');
    expect(lastQuery).toBeUndefined();
  });

  it('offers no filter controls at all on a store that cannot filter', async () => {
    app = await boot(PlainStore);

    const response = await request(app.getHttpServer()).get('/api/catalog/objects/Mvr').expect(200);

    // Which is why the refusal above is not something a console can trip into:
    // it was never offered a control.
    for (const column of response.body.columns) {
      expect(column.filterOperators).toEqual([]);
    }
  });
});

describe('reading objects as of a snapshot', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    lastQuery = undefined;
  });

  it('reads the current load when no snapshot is asked for', async () => {
    app = await boot(FilteringStore);

    const response = await request(app.getHttpServer()).get('/api/catalog/objects/Mvr').expect(200);

    expect(lastQuery?.snapshot).toBeUndefined();
    // The default has to be current, and the page has to say so — a screen with
    // no way to tell would have to assume, and assuming is the failure.
    expect(response.body.snapshot).toEqual({ id: 'run-9', current: true });
  });

  it('says out loud that an earlier load is not the current one', async () => {
    app = await boot(FilteringStore);

    const response = await request(app.getHttpServer())
      .get('/api/catalog/objects/Mvr?snapshot=run-4')
      .expect(200);

    expect(lastQuery?.snapshot).toBe('run-4');
    expect(response.body.snapshot).toEqual({ id: 'run-4', current: false });
  });

  it('refuses a snapshot on a store that keeps no history', async () => {
    app = await boot(PlainStore);

    // Answering with current state would give a reader who believes they are
    // looking at last Tuesday a page that looks exactly like last Tuesday's.
    await request(app.getHttpServer()).get('/api/catalog/objects/Mvr?snapshot=run-4').expect(400);
  });

  it('says nothing about snapshots when the store keeps none', async () => {
    app = await boot(PlainStore);

    const response = await request(app.getHttpServer()).get('/api/catalog/objects/Mvr').expect(200);

    expect(response.body.snapshot).toBeUndefined();
  });
});
