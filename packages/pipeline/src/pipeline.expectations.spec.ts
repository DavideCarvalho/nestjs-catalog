import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import {
  CATALOG_EVENTS,
  CATALOG_PIPELINE_STORE,
  CATALOG_STORE,
  type CatalogConnection,
  type CatalogConnector,
  type CatalogLoadExpectations,
  type CatalogObjectTypeDef,
  type CatalogPipelineStore,
  type CatalogPrincipal,
  type CatalogReadResult,
  type CatalogStoreCapabilities,
  type CatalogTransform,
  type CatalogWriteStore,
  type ConnectorRun,
  REQUIRED_SCOPES,
  REQUIRES_HUMAN,
  type SnapshotRef,
  type StoredLoadExpectation,
  channelNameFor,
} from '@dudousxd/nestjs-catalog';
import { pipelineExpectationRoutes } from '@dudousxd/nestjs-catalog/client';
import { type CanActivate, type ExecutionContext, Injectable, Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CATALOG_LOAD_EXPECTATIONS } from './load-expectations';
import { createPipelineController } from './pipeline.controller';
import { CatalogPipelineModule } from './pipeline.module';
import {
  CATALOG_PIPELINE_EM,
  CATALOG_PIPELINE_REGISTRY,
  type CatalogPipelineRegistry,
} from './seams';

/** See the note in `pipeline.module.integration.spec.ts`: the package cannot load here. */
vi.mock('@dudousxd/nestjs-durable', () => ({
  WorkflowEngine: class WorkflowEngine {},
  Step: () => (_target: unknown, _key: unknown, descriptor: unknown) => descriptor,
  Workflow: () => (target: unknown) => target,
}));

/**
 * The four routes that let an operator declare what a load has to be true of,
 * driven over HTTP.
 *
 * Over HTTP rather than against the handler, for the reason
 * `pipeline.transform-try.spec.ts` gives about the route it covers: what is
 * under test here includes things a direct call cannot see — that Nest routes
 * `expectations` to the list rather than to the `:type` handler, that a body
 * arriving as JSON is narrowed before it is stored, and that a machine principal
 * is refused by the handler rather than only by metadata a host guard may never
 * read.
 */

const DAY = 86_400_000;

const PERSON: CatalogPrincipal = {
  id: 'console#ana@example.com',
  applicationId: 'console',
  actor: { id: 'ana@example.com', displayName: 'Ana' },
  scopes: ['catalog:read', 'catalog:curate'],
};

/** A nightly publisher: every scope a person has, and nobody behind it. */
const MACHINE: CatalogPrincipal = {
  id: 'nightly-publisher',
  scopes: ['catalog:read', 'catalog:curate'],
};

/** Admin implies every scope — and is still not a person, which is the point. */
const ADMIN_MACHINE: CatalogPrincipal = {
  id: 'ops-robot',
  scopes: ['catalog:admin'],
};

const PRINCIPALS: Record<string, CatalogPrincipal> = {
  person: PERSON,
  machine: MACHINE,
  'admin-machine': ADMIN_MACHINE,
};

@Injectable()
class HeaderPrincipalGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req: { headers?: Record<string, unknown>; principal?: CatalogPrincipal } = context
      .switchToHttp()
      .getRequest();
    const who = req.headers?.['x-principal'];
    if (typeof who === 'string' && PRINCIPALS[who]) req.principal = PRINCIPALS[who];
    return true;
  }
}

/* ---------------------------------------------------------------------------
 * A pipeline store that keeps the rows, and one that keeps none of them.
 * ------------------------------------------------------------------------- */

function unreached(method: string): never {
  throw new Error(`${method} is not reached by the expectation routes.`);
}

const rows = new Map<string, StoredLoadExpectation>();
/** Flipped per test: the same module, a store with or without the members. */
let keepsExpectations = true;

@Injectable()
class SpecPipelineStore implements CatalogPipelineStore {
  listConnectors(): Promise<CatalogConnector[]> {
    return unreached('listConnectors');
  }
  getConnector(): Promise<CatalogConnector | undefined> {
    return unreached('getConnector');
  }
  saveConnector(): Promise<CatalogConnector> {
    return unreached('saveConnector');
  }
  deleteConnector(): Promise<boolean> {
    return unreached('deleteConnector');
  }
  saveConnectorState(): Promise<void> {
    return unreached('saveConnectorState');
  }
  listConnections(): Promise<CatalogConnection[]> {
    return unreached('listConnections');
  }
  getConnection(): Promise<CatalogConnection | undefined> {
    return unreached('getConnection');
  }
  saveConnection(): Promise<CatalogConnection> {
    return unreached('saveConnection');
  }
  deleteConnection(): Promise<boolean> {
    return unreached('deleteConnection');
  }
  recordConnectionCheck(): Promise<void> {
    return unreached('recordConnectionCheck');
  }
  connectorsUsingConnection(): Promise<CatalogConnector[]> {
    return unreached('connectorsUsingConnection');
  }
  listTransforms(): Promise<CatalogTransform[]> {
    return unreached('listTransforms');
  }
  getTransform(): Promise<CatalogTransform | undefined> {
    return unreached('getTransform');
  }
  saveTransform(): Promise<CatalogTransform> {
    return unreached('saveTransform');
  }
  deleteTransform(): Promise<boolean> {
    return unreached('deleteTransform');
  }
  startRun(): Promise<ConnectorRun> {
    return unreached('startRun');
  }
  finishRun(): Promise<ConnectorRun | undefined> {
    return unreached('finishRun');
  }
  listRuns(): Promise<ConnectorRun[]> {
    return unreached('listRuns');
  }
}

/**
 * The four optional members, on a subclass.
 *
 * A subclass rather than a flag inside the methods, because
 * `supportsLoadExpectations` probes for the METHODS: a base class that defined
 * them and then threw would narrow cleanly and never exercise the branch that
 * matters, which is a store that does not have them at all.
 */
@Injectable()
class ExpectationKeepingStore extends SpecPipelineStore {
  listLoadExpectations(): Promise<StoredLoadExpectation[]> {
    return Promise.resolve([...rows.values()]);
  }
  getLoadExpectation(typeName: string): Promise<StoredLoadExpectation | undefined> {
    return Promise.resolve(rows.get(typeName));
  }
  saveLoadExpectation(
    typeName: string,
    expectation: Pick<StoredLoadExpectation, 'deletes' | 'rowCount'>,
    setBy: string,
    setByActor?: string,
  ): Promise<StoredLoadExpectation> {
    const row: StoredLoadExpectation = {
      typeName,
      ...expectation,
      setBy,
      setByActor,
      setAt: '2026-08-05T00:00:00.000Z',
    };
    rows.set(typeName, row);
    return Promise.resolve(row);
  }
  clearLoadExpectation(typeName: string): Promise<boolean> {
    return Promise.resolve(rows.delete(typeName));
  }
}

class UnusedWriteStore implements CatalogWriteStore {
  readonly capabilities: CatalogStoreCapabilities = {
    snapshots: 'emulated',
    writable: true,
    timeTravel: false,
  };
  read(): Promise<CatalogReadResult> {
    return Promise.resolve({ rows: [], total: 0 });
  }
  ensureType(): Promise<void> {
    return Promise.resolve();
  }
  write(): Promise<{ written: number }> {
    throw new Error('Nothing here writes rows.');
  }
  commit(): Promise<SnapshotRef> {
    throw new Error('Nothing here commits.');
  }
  dropSnapshot(): Promise<void> {
    return Promise.resolve();
  }
}

const registryStub: CatalogPipelineRegistry = {
  reload: () => Promise.resolve(),
  getType: (): CatalogObjectTypeDef | undefined => undefined,
};

@Module({
  providers: [
    {
      provide: CATALOG_PIPELINE_STORE,
      useFactory: () =>
        keepsExpectations ? new ExpectationKeepingStore() : new SpecPipelineStore(),
    },
    { provide: CATALOG_STORE, useClass: UnusedWriteStore },
  ],
  exports: [CATALOG_PIPELINE_STORE, CATALOG_STORE],
})
class FakeStoreModule {}

/**
 * What the host declares in code. `Mvr` is pinned both ways, `Subwo` only in its
 * row count, and the house default says something about neither so it cannot be
 * mistaken for a lock.
 */
const HOST: CatalogLoadExpectations = {
  default: { rowCount: { minRows: 25 } },
  byType: {
    Mvr: {
      deletes: { strategy: 'accepted', because: 'the host declared this in code' },
      rowCount: { maxShrink: 0.1 },
    },
    Subwo: { rowCount: { maxGrowth: 4 } },
  },
};

/** The shipped recorder's contract: subscribe by name, keep the payload. */
class TestRecorder {
  readonly events: Array<{ event: string; payload: Record<string, unknown> }> = [];
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
    return this.events.filter((recorded) => recorded.event === event).map((r) => r.payload);
  }

  stop(): void {
    for (const [channel, handler] of this.handlers) unsubscribe(channel, handler);
    this.handlers.clear();
  }
}

const BASE = '/catalog/pipeline';

describe('per-type load expectations over HTTP', () => {
  let app: INestApplication;
  let recorder: TestRecorder;

  beforeEach(async () => {
    rows.clear();
    keepsExpectations = true;
    recorder = new TestRecorder();
    const moduleRef = await Test.createTestingModule({
      imports: [
        CatalogPipelineModule.forRoot({
          path: 'catalog',
          guards: [HeaderPrincipalGuard],
          imports: [FakeStoreModule],
          em: {
            provide: CATALOG_PIPELINE_EM,
            useValue: () => {
              throw new Error('No EntityManager here; nothing in this file publishes a type.');
            },
          },
          registry: { provide: CATALOG_PIPELINE_REGISTRY, useValue: registryStub },
          expectations: { provide: CATALOG_LOAD_EXPECTATIONS, useValue: HOST },
          scheduler: false,
        }),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    recorder.stop();
    await app.close();
  });

  const as = (who: string | undefined, agent: request.Test) =>
    who ? agent.set('x-principal', who) : agent;

  const get = (who: string | undefined, path: string) =>
    as(who, request(app.getHttpServer()).get(`${BASE}${path}`));
  const put = (who: string | undefined, path: string, body: object) =>
    as(who, request(app.getHttpServer()).put(`${BASE}${path}`)).send(body);
  const del = (who: string | undefined, path: string) =>
    as(who, request(app.getHttpServer()).delete(`${BASE}${path}`));

  /* -----------------------------------------------------------------------
   * Routing. The literal has to win over the parameter.
   * --------------------------------------------------------------------- */

  it('routes the literal "expectations" to the list, not to the :type handler', async () => {
    // Nest matches in declaration order and `:type` would capture the word
    // happily. If it ever does, this comes back as a resolved expectation for a
    // type named "expectations" — which is a 200 either way, so asserting the
    // status would not have caught it.
    rows.set('Mvr', {
      typeName: 'Mvr',
      deletes: { strategy: 'accepted', because: 'stored' },
      setBy: 'console#ana@example.com',
      setAt: '2026-07-01T00:00:00.000Z',
    });

    const response = await get('person', '/expectations').expect(200);

    expect(response.body.supported).toBe(true);
    expect(response.body.stored).toHaveLength(1);
    expect(response.body.deletesFrom).toBeUndefined();
  });

  it('lists which types the host has pinned, and which fields of them', async () => {
    const response = await get('person', '/expectations').expect(200);

    expect(response.body.hostLocked).toEqual({
      Mvr: { deletes: true, rowCount: true },
      Subwo: { deletes: false, rowCount: true },
    });
  });

  it('says so when the store cannot hold them at all', async () => {
    // Told apart from "nobody has set one", which is the distinction
    // `transforms/:id/revisions` was written to preserve one screen over.
    keepsExpectations = false;
    await app.close();
    const moduleRef = await Test.createTestingModule({
      imports: [
        CatalogPipelineModule.forRoot({
          path: 'catalog',
          guards: [HeaderPrincipalGuard],
          imports: [FakeStoreModule],
          em: { provide: CATALOG_PIPELINE_EM, useValue: () => unreached('em') },
          registry: { provide: CATALOG_PIPELINE_REGISTRY, useValue: registryStub },
          expectations: { provide: CATALOG_LOAD_EXPECTATIONS, useValue: HOST },
          scheduler: false,
        }),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    const listed = await get('person', '/expectations').expect(200);
    expect(listed.body).toMatchObject({ supported: false, stored: [] });

    // And a write has nowhere to go, which is a 400 with a sentence rather than
    // a method missing at run time.
    const refused = await put('person', '/expectations/Fleet', {
      deletes: { strategy: 'accepted', because: 'append-only' },
    }).expect(400);
    expect(JSON.stringify(refused.body)).toContain('cannot hold per-type load expectations');
  });

  it('answers every path the client builds, and nothing else has to know them', async () => {
    // The route builders in `@dudousxd/nestjs-catalog/client` are the contract a
    // console codes against, and a builder is only worth shipping if it is the
    // same string the server serves. Driven THROUGH the builders rather than
    // asserted equal to a literal: a comparison of two strings in this file
    // would pass just as happily if both were wrong.
    const routes = pipelineExpectationRoutes('/catalog/pipeline');
    const server = () => request(app.getHttpServer());

    await server().get(routes.expectations()).set('x-principal', 'person').expect(200);
    await server().get(routes.expectation('Fleet')).set('x-principal', 'person').expect(200);
    await server()
      .put(routes.expectation('Fleet'))
      .set('x-principal', 'person')
      .send({ deletes: { strategy: 'accepted', because: 'an append-only ledger' } })
      .expect(200);
    await server().delete(routes.expectation('Fleet')).set('x-principal', 'person').expect(200);

    // And a type name with a slash in it addresses one type rather than a path
    // of its own, which is what the encoding is for.
    expect(routes.expectation('a/b')).toBe('/catalog/pipeline/expectations/a%2Fb');
    // A base path with a trailing slash is a host being ordinary, not a host
    // making a mistake — `//expectations` is a 404 nobody can read.
    expect(pipelineExpectationRoutes('/api/pipeline/').expectations()).toBe(
      '/api/pipeline/expectations',
    );
  });

  /* -----------------------------------------------------------------------
   * Provenance.
   * --------------------------------------------------------------------- */

  it('answers with the resolved expectation and where each field came from', async () => {
    const response = await get('person', '/expectations/Fleet').expect(200);

    expect(response.body).toMatchObject({
      typeName: 'Fleet',
      // Nothing declares deletes for `Fleet` anywhere, which is exactly the
      // state that refuses its incremental loads.
      deletesFrom: 'none',
      // The house default bounded the row count, and nothing stronger did.
      rowCountFrom: 'default',
      hostLocked: { deletes: false, rowCount: false },
    });
    expect(response.body.resolved.rowCount).toEqual({ minRows: 25 });
  });

  it('reports the host as the source for a type this deployment pinned', async () => {
    rows.set('Mvr', {
      typeName: 'Mvr',
      deletes: { strategy: 'soft-deleted-at-source', because: 'the operator set this' },
      setBy: 'console#ana@example.com',
      setAt: '2026-07-01T00:00:00.000Z',
    });

    const response = await get('person', '/expectations/Mvr').expect(200);

    expect(response.body.deletesFrom).toBe('host');
    expect(response.body.resolved.deletes.because).toBe('the host declared this in code');
    expect(response.body.hostLocked.deletes).toBe(true);
    // The overruled row still comes back, so the screen can say whose edit is
    // not applying rather than silently dropping it.
    expect(response.body.stored.setBy).toBe('console#ana@example.com');
  });

  it('reports the operator as the source where the host said nothing about the type', async () => {
    await put('person', '/expectations/Fleet', {
      deletes: { strategy: 'accepted', because: 'an append-only ledger' },
    }).expect(200);

    const response = await get('person', '/expectations/Fleet').expect(200);

    expect(response.body.deletesFrom).toBe('stored');
    expect(response.body.resolved.deletes.because).toBe('an append-only ledger');
  });

  it('answers for a type the registry has never heard of', async () => {
    // An expectation is a statement about a NAME and is legitimately written
    // before the first load creates the type.
    await get('person', '/expectations/NeverPublished').expect(200);
  });

  /* -----------------------------------------------------------------------
   * Writing one.
   * --------------------------------------------------------------------- */

  it('stores the expectation with who set it and when', async () => {
    const response = await put('person', '/expectations/Fleet', {
      deletes: {
        strategy: 'periodic-full-reload',
        because: 'the nightly connector reads it all',
        withinMs: DAY,
      },
      rowCount: { maxShrink: 0.4 },
    }).expect(200);

    expect(response.body).toMatchObject({
      typeName: 'Fleet',
      setBy: 'console#ana@example.com',
      // The person behind the composite principal, which is the audit's real
      // subject — see `catalog.principal.ts`.
      setByActor: 'ana@example.com',
    });
    expect(rows.get('Fleet')?.deletes).toEqual({
      strategy: 'periodic-full-reload',
      because: 'the nightly connector reads it all',
      withinMs: DAY,
    });
  });

  it('records the write on the same audit event a rename of the type emits', async () => {
    await put('person', '/expectations/Fleet', {
      deletes: { strategy: 'accepted', because: 'an append-only ledger' },
    }).expect(200);

    const curated = recorder.of('type.curated');
    expect(curated).toHaveLength(1);
    expect(curated[0]).toMatchObject({
      typeName: 'Fleet',
      changed: ['expectation.deletes'],
      // `principalId`, not any other spelling: it is the key a recorder lifts
      // into the audit table's indexed column.
      principalId: 'console#ana@example.com',
    });
  });

  it('leaves the field a write did not mention alone', async () => {
    await put('person', '/expectations/Fleet', { rowCount: { maxShrink: 0.4 } }).expect(200);
    await put('person', '/expectations/Fleet', {
      deletes: { strategy: 'accepted', because: 'an append-only ledger' },
    }).expect(200);

    // A form that renders only the strategy must not drop a bound somebody set.
    expect(rows.get('Fleet')?.rowCount).toEqual({ maxShrink: 0.4 });
    expect(rows.get('Fleet')?.deletes?.strategy).toBe('accepted');
  });

  it('refuses an empty write rather than recording a decision nobody made', async () => {
    await put('person', '/expectations/Fleet', {}).expect(400);
    expect(rows.has('Fleet')).toBe(false);
  });

  describe('what it refuses with 400, naming the field', () => {
    const cases: Array<[string, object, string]> = [
      [
        'a strategy with a blank reason',
        { deletes: { strategy: 'accepted', because: '  ' } },
        'because',
      ],
      [
        'a periodic full reload with no interval',
        { deletes: { strategy: 'periodic-full-reload', because: 'nightly' } },
        'withinMs',
      ],
      [
        'a strategy outside the three',
        { deletes: { strategy: 'tombstones', because: 'off a change feed' } },
        'tombstones',
      ],
      ['a shrink bound of zero', { rowCount: { maxShrink: 0 } }, 'maxShrink'],
      ['a shrink bound above one', { rowCount: { maxShrink: 1.5 } }, 'maxShrink'],
      ['a growth bound of one', { rowCount: { maxGrowth: 1 } }, 'maxGrowth'],
    ];

    for (const [name, body, named] of cases) {
      it(`refuses ${name}`, async () => {
        const response = await put('person', '/expectations/Fleet', body).expect(400);

        expect(JSON.stringify(response.body)).toContain(named);
        // Refused rather than stored and then refused at 03:00 by something the
        // editor never mentioned.
        expect(rows.has('Fleet')).toBe(false);
      });
    }
  });

  it('refuses with 409 a write to a field the host declared, saying which', async () => {
    const response = await put('person', '/expectations/Mvr', {
      deletes: { strategy: 'soft-deleted-at-source', because: 'we soft-delete now' },
    }).expect(409);

    expect(JSON.stringify(response.body)).toContain('deletes');
    // Not stored: a row that can never apply would sit on the screen looking
    // like a policy.
    expect(rows.has('Mvr')).toBe(false);
  });

  it('admits a write to a field of a type the host pinned only partly', async () => {
    // `Subwo` is pinned on row counts and nothing else, so its delete strategy
    // is still the operator's to decide. A 409 here would mean one field of a
    // host entry locks the whole type.
    await put('person', '/expectations/Subwo', {
      deletes: { strategy: 'accepted', because: 'work orders are never removed' },
    }).expect(200);

    await put('person', '/expectations/Subwo', { rowCount: { maxGrowth: 9 } }).expect(409);
  });

  /* -----------------------------------------------------------------------
   * Who may write one.
   * --------------------------------------------------------------------- */

  it('refuses a machine principal, however scoped', async () => {
    // `because` is a sentence somebody is accountable for, and an application
    // key has no author.
    const refused = await put('machine', '/expectations/Fleet', {
      deletes: { strategy: 'accepted', because: 'nightly said so' },
    }).expect(403);

    expect(JSON.stringify(refused.body)).toContain('is an application');
    await del('machine', '/expectations/Fleet').expect(403);
  });

  it('refuses an admin machine too, because admin is not a person', async () => {
    // `hasScope` treats `catalog:admin` as implying every scope, so a scope
    // check alone lets this through — the requirement is orthogonal to scopes.
    await put('admin-machine', '/expectations/Fleet', {
      deletes: { strategy: 'accepted', because: 'ops said so' },
    }).expect(403);
  });

  it('refuses a caller the guard left no principal for', async () => {
    await put(undefined, '/expectations/Fleet', {
      deletes: { strategy: 'accepted', because: 'nobody said so' },
    }).expect(500);
    expect(rows.has('Fleet')).toBe(false);
  });

  /* -----------------------------------------------------------------------
   * Dropping one.
   * --------------------------------------------------------------------- */

  it('drops the stored row and says what is left in force', async () => {
    await put('person', '/expectations/Subwo', {
      deletes: { strategy: 'accepted', because: 'work orders are never removed' },
    }).expect(200);

    const response = await del('person', '/expectations/Subwo').expect(200);

    expect(response.body.cleared).toBe(true);
    expect(rows.has('Subwo')).toBe(false);
    // The host layer is untouched, and what comes back says so: the row-count
    // entry this deployment declared for `Subwo` is still there.
    expect(response.body.remaining.deletesFrom).toBe('none');
    expect(response.body.remaining.resolved.rowCount).toEqual({ minRows: 25, maxGrowth: 4 });
  });

  it('records the withdrawal, because who removed a policy is the other half of the question', async () => {
    await put('person', '/expectations/Fleet', {
      deletes: { strategy: 'accepted', because: 'an append-only ledger' },
    }).expect(200);
    recorder.events.length = 0;

    await del('person', '/expectations/Fleet').expect(200);

    expect(recorder.of('type.curated')).toEqual([
      {
        typeName: 'Fleet',
        changed: ['expectation.cleared'],
        principalId: 'console#ana@example.com',
      },
    ]);
  });

  it('is honest about deleting nothing', async () => {
    const response = await del('person', '/expectations/Fleet').expect(200);

    expect(response.body.cleared).toBe(false);
    // Nothing happened, so nothing is recorded as having happened.
    expect(recorder.of('type.curated')).toEqual([]);
  });
});

/* ---------------------------------------------------------------------------
 * What the routes declare, for the guard a host wrote.
 * ------------------------------------------------------------------------- */

describe('what the expectation routes declare', () => {
  const prototype = createPipelineController('catalog').prototype;

  const scopesOf = (handler: string): unknown =>
    Reflect.getMetadata(REQUIRED_SCOPES, Reflect.get(prototype, handler));
  const humanOf = (handler: string): unknown =>
    Reflect.getMetadata(REQUIRES_HUMAN, Reflect.get(prototype, handler));

  it('reads under catalog:read', () => {
    expect(scopesOf('loadExpectations')).toEqual(['catalog:read']);
    expect(scopesOf('loadExpectation')).toEqual(['catalog:read']);
  });

  it('writes under catalog:curate, the scope that already governs statements about a type', () => {
    expect(scopesOf('saveLoadExpectation')).toEqual(['catalog:curate']);
    expect(scopesOf('clearLoadExpectation')).toEqual(['catalog:curate']);
  });

  it('declares the writes as human-only, so a host guard can refuse them too', () => {
    expect(humanOf('saveLoadExpectation')).toBe(true);
    expect(humanOf('clearLoadExpectation')).toBe(true);
    // And the reads are not: a dashboard polling the resolved policy is fine.
    expect(humanOf('loadExpectations')).toBeUndefined();
    expect(humanOf('loadExpectation')).toBeUndefined();
  });
});
