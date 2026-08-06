import { type IncomingMessage, get as httpGet } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DynamicModule, INestApplication } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { CatalogModule } from './catalog.module';
import { InMemoryCatalogOverlayStore } from './catalog.overlay-store';
import type {
  CatalogQueryRelation,
  CatalogQueryRequest,
  CatalogQueryResult,
  CatalogQueryStreamRequest,
} from './catalog.query';
import { CatalogRegistry } from './catalog.registry.base';
import { CATALOG_STORE, type CatalogReadResult, type CatalogReadStore } from './catalog.store';
import type { CatalogGraph, CatalogObjectTypeDef, CatalogSnapshot } from './catalog.types';
import {
  CATALOG_WORKSPACE_STORE,
  type CatalogAuditEvent,
  type CatalogWorkspaceStore,
  type Dashboard,
  type SavedQuery,
} from './catalog.workspace';

/**
 * `GET saved-queries/:id/export.csv`, over a real socket.
 *
 * The claim under test is not "a CSV comes out" — the old implementation, which
 * ran the query, held the result, built the whole string and then answered,
 * produced a perfectly good CSV. The claim is that **nothing holds the file**,
 * and there are exactly two halves to it:
 *
 * 1. rows reach the client while the source is still producing, and
 * 2. a client that stops reading stops the source, rather than the rows piling
 *    up in this process.
 *
 * Neither is observable through supertest, which buffers the whole body before
 * it resolves — a buffered export and a streamed one look identical to it. So
 * these boot a listening server and drive a raw `http.get`, where the socket is
 * available to pause.
 *
 * The gate is what makes the first assertion mean something: the source stops
 * partway and stays stopped, so "the client has bytes" can only be true if the
 * response began before the query finished. A test that merely compared the
 * final body would pass whether or not anything streamed.
 */

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const SAVED_QUERY: SavedQuery = {
  id: 'q-1',
  name: 'Fleet posture',
  sql: 'select * from vehicle',
  createdBy: 'console',
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  cacheTtlSeconds: 60,
  visualization: { kind: 'table' },
  shared: false,
};

@Injectable()
class StubRegistry extends CatalogRegistry {
  getSnapshot(): CatalogSnapshot {
    return {
      version: 1,
      generatedAt: new Date(0).toISOString(),
      stats: { types: 0, properties: 0, relations: 0, enrichedTypes: 0 },
      types: [],
    };
  }
  getType(): CatalogObjectTypeDef | undefined {
    return undefined;
  }
  getGraph(): CatalogGraph {
    return { nodes: [], edges: [] };
  }
  patchType(): Promise<CatalogObjectTypeDef | undefined> {
    return Promise.resolve(undefined);
  }
  patchProperty(): Promise<CatalogObjectTypeDef | undefined> {
    return Promise.resolve(undefined);
  }
  resetOverlay(): Promise<void> {
    return Promise.resolve();
  }
}

/** A gate a generator can be stopped at, and the test can open later. */
function gate(): { closed: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const closed = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  return { closed, open };
}

/** Wide enough that a handful of rows exceed any socket's idea of "not worth sending yet". */
function wideRow(index: number): Record<string, unknown> {
  return { n: index, payload: `${index}`.padStart(512, 'x') };
}

/**
 * A store that streams, and says how far it has been asked to go.
 *
 * `produced` is the count of rows the generator has actually yielded, which is
 * the only number that answers "did the consumer read ahead". A row is counted
 * as it leaves, so `produced` never runs ahead of what the consumer pulled.
 */
class StreamingStore implements CatalogReadStore {
  readonly capabilities = { snapshots: 'none', writable: false, timeTravel: false } as const;

  produced = 0;
  /** Set in the generator's `finally`, so an abandoned iteration is visible. */
  closed = false;
  readonly ran: CatalogQueryStreamRequest[] = [];
  readonly buffered: CatalogQueryRequest[] = [];

  constructor(
    private readonly total: number,
    private readonly stopAt?: { after: number; until: Promise<void> },
  ) {}

  read(): Promise<CatalogReadResult> {
    return Promise.resolve({ rows: [], total: 0 });
  }

  runQuery(request: CatalogQueryRequest): Promise<CatalogQueryResult> {
    this.buffered.push(request);
    throw new Error('The export must not fall back to the buffered read on a streaming store.');
  }

  queryRelations(): Promise<CatalogQueryRelation[]> {
    return Promise.resolve([]);
  }

  async *streamQuery(request: CatalogQueryStreamRequest): AsyncGenerator<Record<string, unknown>> {
    this.ran.push(request);
    try {
      for (let index = 0; index < this.total; index += 1) {
        if (this.stopAt && index === this.stopAt.after) await this.stopAt.until;
        this.produced += 1;
        yield wideRow(index);
      }
    } finally {
      this.closed = true;
    }
  }
}

/** A store with no `streamQuery` at all — the fallback path. */
class BufferedStore implements CatalogReadStore {
  readonly capabilities = { snapshots: 'none', writable: false, timeTravel: false } as const;
  readonly ran: CatalogQueryRequest[] = [];

  constructor(private readonly rows: Array<Record<string, unknown>> = [{ n: 1 }]) {}

  read(): Promise<CatalogReadResult> {
    return Promise.resolve({ rows: [], total: 0 });
  }
  runQuery(request: CatalogQueryRequest): Promise<CatalogQueryResult> {
    this.ran.push(request);
    return Promise.resolve({
      columns: Object.keys(this.rows[0] ?? {}),
      rows: this.rows,
      rowCount: this.rows.length,
      truncated: false,
      elapsedMs: 0,
    });
  }
  queryRelations(): Promise<CatalogQueryRelation[]> {
    return Promise.resolve([]);
  }
}

/** A store with no SQL at all — neither shape of query. */
class NoQueryStore implements CatalogReadStore {
  readonly capabilities = { snapshots: 'none', writable: false, timeTravel: false } as const;

  read(): Promise<CatalogReadResult> {
    return Promise.resolve({ rows: [], total: 0 });
  }
}

/** Streams a few rows and then breaks, which is the case a status code cannot express. */
class FailingStore implements CatalogReadStore {
  readonly capabilities = { snapshots: 'none', writable: false, timeTravel: false } as const;

  constructor(private readonly failAt: number) {}

  read(): Promise<CatalogReadResult> {
    return Promise.resolve({ rows: [], total: 0 });
  }
  runQuery(): Promise<CatalogQueryResult> {
    throw new Error('not used');
  }
  queryRelations(): Promise<CatalogQueryRelation[]> {
    return Promise.resolve([]);
  }
  async *streamQuery(): AsyncGenerator<Record<string, unknown>> {
    for (let index = 0; index < this.failAt; index += 1) {
      if (index === this.failAt - 1) throw new Error('the engine dropped the connection');
      yield wideRow(index);
    }
  }
}

class StubWorkspace implements CatalogWorkspaceStore {
  constructor(private readonly query: SavedQuery = SAVED_QUERY) {}

  listSavedQueries(): Promise<SavedQuery[]> {
    return Promise.resolve([this.query]);
  }
  getSavedQuery(): Promise<SavedQuery | undefined> {
    return Promise.resolve(this.query);
  }
  saveQuery(): Promise<SavedQuery> {
    return Promise.resolve(this.query);
  }
  updateSavedQuery(): Promise<SavedQuery | undefined> {
    return Promise.resolve(this.query);
  }
  deleteSavedQuery(): Promise<boolean> {
    return Promise.resolve(true);
  }
  listDashboards(): Promise<Dashboard[]> {
    return Promise.resolve([]);
  }
  getDashboard(): Promise<Dashboard | undefined> {
    return Promise.resolve(undefined);
  }
  saveDashboard(): Promise<Dashboard> {
    throw new Error('not used');
  }
  updateDashboard(): Promise<Dashboard | undefined> {
    return Promise.resolve(undefined);
  }
  deleteDashboard(): Promise<boolean> {
    return Promise.resolve(true);
  }
  listEvents(): Promise<CatalogAuditEvent[]> {
    return Promise.resolve([]);
  }
  recordEvent(): Promise<void> {
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Booting, and talking to it without a buffering client.
// ---------------------------------------------------------------------------

function workspaceModule(workspace: CatalogWorkspaceStore): DynamicModule {
  return {
    module: class WorkspaceModule {},
    providers: [{ provide: CATALOG_WORKSPACE_STORE, useValue: workspace }],
    exports: [CATALOG_WORKSPACE_STORE],
  };
}

async function boot(store: CatalogReadStore, query?: SavedQuery): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      CatalogModule.forRoot({
        path: 'api/catalog',
        guards: [],
        imports: [workspaceModule(new StubWorkspace(query))],
        registry: { provide: CatalogRegistry, useClass: StubRegistry },
        store: { provide: CATALOG_STORE, useValue: store },
        overlayStore: new InMemoryCatalogOverlayStore(),
      }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  await app.listen(0);
  return app;
}

function portOf(app: INestApplication): number {
  const address = app.getHttpServer().address();
  if (address === null || typeof address === 'string') {
    throw new Error('The test server is not listening on a TCP port.');
  }
  return (address as AddressInfo).port;
}

/** The response object, as soon as its headers arrive — body still in flight. */
function open(app: INestApplication, path = '/api/catalog/saved-queries/q-1/export.csv') {
  return new Promise<IncomingMessage>((resolve, reject) => {
    const request = httpGet({ host: '127.0.0.1', port: portOf(app), path }, resolve);
    request.on('error', reject);
  });
}

/** Everything left on a response, as text. */
function drain(response: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => {
      text += chunk;
    });
    response.on('end', () => resolve(text));
    response.on('error', reject);
  });
}

/** The first chunk of body, and nothing after it. */
function firstChunk(response: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    response.setEncoding('utf8');
    response.once('data', (chunk: string) => resolve(chunk));
    response.once('error', reject);
  });
}

/** A promise that resolves to `false` if it has not settled by `ms`. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | false> {
  return Promise.race([
    promise,
    new Promise<false>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);
}

function idle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------

describe('exporting a saved query as CSV', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('sends rows to the client while the query is still producing them', async () => {
    // THE case. The source stops at row 200 and stays stopped; if the handler
    // still built the file before answering, nothing at all would have reached
    // the client by the time this assertion runs.
    const stop = gate();
    const store = new StreamingStore(5_000, { after: 200, until: stop.closed });
    app = await boot(store);

    const response = await open(app);
    const chunk = await within(firstChunk(response), 2_000);

    expect(chunk).not.toBe(false);
    expect(typeof chunk === 'string' && chunk.startsWith('n,payload\r\n')).toBe(true);
    // The source is demonstrably not finished: it is parked at the gate.
    expect(store.produced).toBe(200);

    stop.open();
    await drain(response);
    expect(store.produced).toBe(5_000);
  });

  it('stops pulling rows when the client stops reading them', async () => {
    // The other half of "memory stays flat". Arriving early is worthless if the
    // process then races ahead of a slow client and holds the rows it has not
    // managed to send: back-pressure has to reach from the socket, through the
    // pipe and the readable, into the generator.
    const store = new StreamingStore(200_000);
    app = await boot(store);

    const response = await open(app);
    response.pause();
    await idle(300);

    const parked = store.produced;
    expect(parked).toBeGreaterThan(0);
    // Bounded by the buffers between the generator and the socket, which are
    // measured in kilobytes. 20,000 rows of 512 bytes is ten megabytes — an
    // order of magnitude past anything those buffers hold, and still a tenth of
    // the table, so this fails loudly on a pipeline that ignores back-pressure
    // without being sensitive to what any one buffer is sized at.
    expect(parked).toBeLessThan(20_000);

    await idle(200);
    // Still parked: the generator did not creep on while nobody was reading.
    expect(store.produced).toBe(parked);

    response.destroy();
  });

  it('releases the source when the client abandons the download', async () => {
    const store = new StreamingStore(200_000);
    app = await boot(store);

    const response = await open(app);
    await firstChunk(response);
    response.destroy();

    // The generator's `finally` runs, which is what a store implementation puts
    // its ROLLBACK and its connection release in.
    for (let attempt = 0; attempt < 50 && !store.closed; attempt += 1) await idle(20);
    expect(store.closed).toBe(true);
  });

  it('answers chunked, with no content-length', async () => {
    // A length header is a promise about a body nobody has counted, and it is
    // what the express adapter sets when a handler returns a string. Its absence
    // is the observable difference between the two implementations.
    app = await boot(new StreamingStore(10));

    const response = await open(app);
    expect(response.headers['content-length']).toBeUndefined();
    expect(response.headers['transfer-encoding']).toBe('chunked');
    expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="Fleet-posture.csv"',
    );

    await drain(response);
  });

  it('asks the store for every row, with no cap and no deadline', async () => {
    // An export is the whole result by definition. A `maxRows` here would be a
    // prefix handed over as a complete file, and a `timeoutMs` would make the
    // export impossible for exactly the tables that need one.
    const store = new StreamingStore(3);
    app = await boot(store);

    await drain(await open(app));

    expect(store.ran).toEqual([{ sql: 'select * from vehicle' }]);
  });

  it('does not serve the export from the query cache', async () => {
    // The saved query carries a 60s TTL, and the cache holds a *capped* page.
    // Serving it would truncate the file silently; filling it from an export
    // would put the whole result in the object the cache exists to avoid.
    const store = new StreamingStore(3);
    app = await boot(store);

    await drain(await open(app));
    await drain(await open(app));

    expect(store.ran).toHaveLength(2);
    expect(store.produced).toBe(6);
  });

  it('writes the rows it was given, escaped', async () => {
    app = await boot(new BufferedStore([{ unit: '=cmd|calc', delta: -42, note: 'a,b' }]));

    const body = await drain(await open(app));

    expect(body).toBe('unit,delta,note\r\n\'=cmd|calc,-42,"a,b"\r\n');
  });

  it('falls back to the capped buffered read on a store that cannot stream', async () => {
    const store = new BufferedStore([{ n: 1 }, { n: 2 }]);
    app = await boot(store);

    const body = await drain(await open(app));

    expect(body).toBe('n\r\n1\r\n2\r\n');
    // Capped, deliberately: an unbounded read against a driver that
    // materialises would move the failure into the driver, where there is no
    // cap left to report.
    expect(store.ran).toEqual([
      { sql: 'select * from vehicle', maxRows: 1_000, timeoutMs: 15_000 },
    ]);
  });

  it('names the file after the saved query, with the awkward characters taken out', async () => {
    app = await boot(new StreamingStore(1), { ...SAVED_QUERY, name: 'Q4 / posture: "final"' });

    const response = await open(app);
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="Q4-posture-final-.csv"',
    );
    await drain(response);
  });

  it('refuses before it commits to being a CSV, when the store runs no SQL', async () => {
    // The one thing streaming takes away is the ability to change your mind
    // after the first byte. So everything that can be refused is refused before
    // any header is set: this comes back as an ordinary JSON error, not as a
    // download that turns out to contain an error message.
    app = await boot(new NoQueryStore());

    const response = await open(app);
    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.headers['content-disposition']).toBeUndefined();
    expect(JSON.parse(await drain(response)).message).toMatch(/does not support SQL queries/);
  });

  it('ends the download rather than hanging when the source fails mid-stream', async () => {
    // A failure after the first byte cannot become a status code — the status
    // went out with the headers. What it must not do is leave the client waiting
    // on a connection nobody will ever write to again.
    app = await boot(new FailingStore(3));

    const response = await open(app);
    const body = await drain(response);

    expect(response.statusCode).toBe(200);
    expect(body.startsWith('n,payload\r\n')).toBe(true);
    // Truncated, and terminated. The rows that made it are the rows that made
    // it; a partial CSV is what a chunked response can offer here.
    expect(body).not.toContain('\r\n3,');
  });
});
