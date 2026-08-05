import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import type { EntityProperty } from '@mikro-orm/core';
import { EntityMetadata, MetadataStorage, MikroORM, ReferenceKind } from '@mikro-orm/core';
import type {
  CanActivate,
  DynamicModule,
  ExecutionContext,
  INestApplication,
} from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { CATALOG_EVENTS, UNATTRIBUTED_PRINCIPAL_ID, channelNameFor } from './catalog.events';
import { CatalogModule } from './catalog.module';
import { InMemoryCatalogOverlayStore } from './catalog.overlay-store';
import type { CatalogPrincipal } from './catalog.principal';
import type { CatalogQueryRelation, CatalogQueryResult } from './catalog.query';
import { MikroOrmCatalogRegistry } from './catalog.registry';
import { CatalogRegistry } from './catalog.registry.base';
import { CATALOG_STORE, type CatalogReadResult, type CatalogReadStore } from './catalog.store';
import {
  type AuditQuery,
  CATALOG_WORKSPACE_STORE,
  type CatalogAuditEvent,
  type CatalogWorkspaceStore,
  type Dashboard,
  type DashboardCard,
  type SaveQueryInput,
  type SavedQuery,
} from './catalog.workspace';

/**
 * That curating something leaves a trail, and that the trail names who.
 *
 * `type.curated` exists because "who renamed this column and when is a governance
 * question, and the answer is otherwise nowhere" — and for several releases its
 * payload carried `typeName`, `property` and `changed`, which answers when and
 * what and never who. `overlay.reset` shipped with the same hole and a docblock
 * explaining it as a limit. Meanwhile `query.shared` two screens away named its
 * actor from the day it was added, so the trail was inconsistent in a way that
 * reads as a bug in whichever half you look at second.
 *
 * Modelled on `catalog.sharing-audit.integration.spec.ts` and for its reason:
 * these assert the whole path rather than the emit call. A spy on `emitCatalog`
 * passes on a payload whose actor is spelled something no recorder lifts, which
 * is an entry that reaches the audit table attributed to nobody while looking
 * complete. The recorder below is a re-implementation of the shipped one in
 * `@dudousxd/nestjs-catalog-store-mikro-orm`: it subscribes to `CATALOG_EVENTS`,
 * pulls `principalId` out of the payload, and writes the row — so both the name
 * of the field and its presence in the *indexed column* are under test, not just
 * its presence somewhere in a JSON blob.
 *
 * The registry here is the real `MikroOrmCatalogRegistry` over hand-built
 * metadata, not a stub. The emit happens inside it, so a stub registry would
 * leave nothing to record and every case below would pass vacuously.
 */

// ---------------------------------------------------------------------------
// The host's half: a guard that resolves a principal onto the request.
// ---------------------------------------------------------------------------

const ANA: CatalogPrincipal = {
  id: 'catalog-console#ana@example.com',
  applicationId: 'catalog-console',
  actor: { id: 'ana@example.com', displayName: 'Ana' },
  scopes: ['catalog:curate'],
};

@Injectable()
class SignedInGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    Reflect.set(context.switchToHttp().getRequest(), 'principal', ANA);
    return true;
  }
}

// ---------------------------------------------------------------------------
// A real registry over metadata built by hand.
// ---------------------------------------------------------------------------

function entity(className: string, props: Array<Partial<EntityProperty>>): EntityMetadata {
  const meta = new EntityMetadata({
    className,
    tableName: className.toLowerCase(),
    primaryKeys: ['id'],
  });
  for (const prop of props) meta.addProperty(prop);
  return meta;
}

function scalar(name: string): Partial<EntityProperty> {
  return { name, kind: ReferenceKind.SCALAR, type: 'string' };
}

/** A MikroORM whose only method is the one the registry calls. */
function ormOver(metas: EntityMetadata[]): MikroORM {
  const storage = new MetadataStorage(
    Object.fromEntries(metas.map((meta) => [meta.className, meta])),
  );
  const orm = Object.create(MikroORM.prototype);
  orm.getMetadata = () => storage;
  return orm;
}

function realRegistry(): MikroOrmCatalogRegistry {
  return new MikroOrmCatalogRegistry(
    ormOver([entity('WorkOrder', [scalar('id'), scalar('acftSn')])]),
    {},
    new InMemoryCatalogOverlayStore(),
  );
}

class StubStore implements CatalogReadStore {
  readonly capabilities = { snapshots: 'none', writable: false, timeTravel: false } as const;

  read(): Promise<CatalogReadResult> {
    return Promise.resolve({ rows: [], total: 0 });
  }
  runQuery(): Promise<CatalogQueryResult> {
    return Promise.resolve({ columns: [], rows: [], rowCount: 0, truncated: false, elapsedMs: 0 });
  }
  queryRelations(): Promise<CatalogQueryRelation[]> {
    return Promise.resolve([]);
  }
}

/** Only the audit half is exercised, so the workspace is one honest list. */
class MemoryWorkspace implements CatalogWorkspaceStore {
  readonly events: CatalogAuditEvent[] = [];

  listSavedQueries(): Promise<SavedQuery[]> {
    return Promise.resolve([]);
  }
  getSavedQuery(): Promise<SavedQuery | undefined> {
    return Promise.resolve(undefined);
  }
  saveQuery(): Promise<SavedQuery> {
    return Promise.reject(new Error('not used'));
  }
  updateSavedQuery(): Promise<SavedQuery | undefined> {
    return Promise.resolve(undefined);
  }
  deleteSavedQuery(): Promise<boolean> {
    return Promise.resolve(false);
  }
  listDashboards(): Promise<Dashboard[]> {
    return Promise.resolve([]);
  }
  getDashboard(): Promise<Dashboard | undefined> {
    return Promise.resolve(undefined);
  }
  saveDashboard(): Promise<Dashboard> {
    return Promise.reject(new Error('not used'));
  }
  updateDashboard(): Promise<Dashboard | undefined> {
    return Promise.resolve(undefined);
  }
  deleteDashboard(): Promise<boolean> {
    return Promise.resolve(false);
  }
  recordEvent(event: Omit<CatalogAuditEvent, 'id'>): Promise<void> {
    this.events.push({ id: `e-${this.events.length + 1}`, ...event });
    return Promise.resolve();
  }
  listEvents(query: AuditQuery): Promise<CatalogAuditEvent[]> {
    return Promise.resolve(
      this.events.filter((event) => !query.event || event.event === query.event),
    );
  }
}

/**
 * The shipped recorder's contract, restated: subscribe to every name in
 * `CATALOG_EVENTS`, lift `principalId` into the indexed column, keep the payload.
 */
class TestAuditRecorder {
  private readonly handlers = new Map<string, (message: unknown) => void>();

  constructor(private readonly workspace: MemoryWorkspace) {
    for (const event of CATALOG_EVENTS) {
      const channel = channelNameFor(event);
      const handler = (message: unknown): void => {
        const envelope = message && typeof message === 'object' ? message : {};
        const raw = Reflect.get(envelope, 'payload');
        const payload = raw && typeof raw === 'object' ? raw : {};
        const principalId = Reflect.get(payload, 'principalId');
        void this.workspace.recordEvent({
          event,
          // The shipped recorder's exact rule, including the part that matters
          // here: a falsy value becomes `undefined`, which lands as NULL in the
          // column. That is why the empty string is not an option for this field.
          principalId:
            typeof principalId === 'string' && principalId.length > 0 ? principalId : undefined,
          detail: { ...payload },
          occurredAt: new Date().toISOString(),
        });
      };
      subscribe(channel, handler);
      this.handlers.set(channel, handler);
    }
  }

  stop(): void {
    for (const [channel, handler] of this.handlers) unsubscribe(channel, handler);
    this.handlers.clear();
  }
}

function workspaceModule(workspace: CatalogWorkspaceStore): DynamicModule {
  return {
    module: class WorkspaceModule {},
    providers: [{ provide: CATALOG_WORKSPACE_STORE, useValue: workspace }],
    exports: [CATALOG_WORKSPACE_STORE],
  };
}

describe('Curating leaves an audit trail that names who (integration)', () => {
  let app: INestApplication | undefined;
  let recorder: TestAuditRecorder | undefined;

  afterEach(async () => {
    recorder?.stop();
    recorder = undefined;
    await app?.close();
    app = undefined;
  });

  async function boot(options: { guarded?: boolean } = {}) {
    const workspace = new MemoryWorkspace();
    const registry = realRegistry();
    recorder = new TestAuditRecorder(workspace);
    const moduleRef = await Test.createTestingModule({
      imports: [
        CatalogModule.forRoot({
          path: 'api/catalog',
          guards: options.guarded === false ? [] : [SignedInGuard],
          imports: [workspaceModule(workspace)],
          registry: { provide: CatalogRegistry, useValue: registry },
          store: { provide: CATALOG_STORE, useValue: new StubStore() },
          overlayStore: new InMemoryCatalogOverlayStore(),
        }),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    return { server: app.getHttpServer(), workspace, registry };
  }

  function curationEvents(workspace: MemoryWorkspace) {
    return workspace.events.filter(
      (event) => event.event === 'type.curated' || event.event === 'overlay.reset',
    );
  }

  // -------------------------------------------------------------------------
  // 1. Renaming.
  // -------------------------------------------------------------------------

  it('names the curator who renamed a type, in the indexed column and not only the payload', async () => {
    // `principalId` is the column a governance screen filters on. An entry
    // carrying the actor only inside `detail` is invisible to every query anybody
    // actually runs against the trail.
    const { server, workspace } = await boot();

    await request(server)
      .patch('/api/catalog/types/WorkOrder')
      .send({ displayName: 'Work Order' })
      .expect(200);

    const [recorded] = curationEvents(workspace);
    expect(recorded.event).toBe('type.curated');
    expect(recorded.principalId).toBe('catalog-console#ana@example.com');
    expect(recorded.detail.principalId).toBe('catalog-console#ana@example.com');
  });

  it('names the curator who renamed a column', async () => {
    // The route the defect was written about: somebody renames a column, and the
    // trail could say which column and when and not by whom.
    const { server, workspace } = await boot();

    await request(server)
      .patch('/api/catalog/types/WorkOrder/properties/acftSn')
      .send({ displayName: 'Tail number' })
      .expect(200);

    expect(curationEvents(workspace)[0]).toMatchObject({
      event: 'type.curated',
      principalId: 'catalog-console#ana@example.com',
      detail: { typeName: 'WorkOrder', property: 'acftSn', changed: ['displayName'] },
    });
  });

  it('names the curator who classified a column, which is an access decision', async () => {
    // A classification is what `visibleToPrincipal` filters search on, so setting
    // one changes who can see a column's name. It arrives through the same
    // presentation-only route as a rename, which is exactly why the actor has to
    // be on it.
    const { server, workspace } = await boot();

    await request(server)
      .patch('/api/catalog/types/WorkOrder/properties/acftSn')
      .send({ classification: 'CUI' })
      .expect(200);

    expect(curationEvents(workspace)[0].principalId).toBe('catalog-console#ana@example.com');
  });

  it('reaches the trail through the endpoint a governance screen actually calls', async () => {
    // Read back through `/events`, not out of the store: the claim is "it shows
    // up in the audit trail", and the trail is what that route answers with.
    const { server } = await boot();

    await request(server)
      .patch('/api/catalog/types/WorkOrder')
      .send({ displayName: 'Work Order' })
      .expect(200);

    const listed = await request(server).get('/api/catalog/events?event=type.curated').expect(200);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0].principalId).toBe('catalog-console#ana@example.com');
  });

  // -------------------------------------------------------------------------
  // 2. Reverting the whole catalog.
  // -------------------------------------------------------------------------

  it('names who reverted every curated value at once', async () => {
    // The act with the least left to reconstruct from: nothing versions the
    // overlay, so after this the event is the only record that it happened, and
    // the only record of who did it.
    const { server, workspace } = await boot();

    await request(server)
      .patch('/api/catalog/types/WorkOrder')
      .send({ displayName: 'Work Order' })
      .expect(200);
    await request(server).post('/api/catalog/reset').expect(201);

    const reset = curationEvents(workspace).at(-1);
    expect(reset?.event).toBe('overlay.reset');
    expect(reset?.principalId).toBe('catalog-console#ana@example.com');
    expect(reset?.detail.principalId).toBe('catalog-console#ana@example.com');
  });

  it('names them even when the reset destroyed nothing', async () => {
    // "Somebody pressed it and nothing was there" is still a fact about somebody,
    // and it is the reading an empty reset exists to preserve.
    const { server, workspace } = await boot();

    await request(server).post('/api/catalog/reset').expect(201);

    expect(curationEvents(workspace)[0]).toMatchObject({
      event: 'overlay.reset',
      principalId: 'catalog-console#ana@example.com',
      detail: { typeNames: [], properties: 0 },
    });
  });

  // -------------------------------------------------------------------------
  // 3. Who, exactly.
  // -------------------------------------------------------------------------

  it('records the person inside the delegated id rather than the console alone', async () => {
    // The choice `query.shared` made, kept: `parsePrincipalId` recovers
    // `catalog-console` from the composite, so a governance query asking what the
    // application did still matches — while dropping to the application half
    // would file Ana's decision under the console she signed into, and "the
    // console renamed this column" is the answer nobody accepts.
    const { server, workspace } = await boot();

    await request(server)
      .patch('/api/catalog/types/WorkOrder')
      .send({ displayName: 'Work Order' })
      .expect(200);

    const recorded = curationEvents(workspace)[0];
    expect(recorded.principalId).toBe('catalog-console#ana@example.com');
    expect(recorded.principalId).not.toBe('catalog-console');
  });

  it('falls back to the console when no guard resolved anybody', async () => {
    // An unauthenticated mount. This library resolves no principal of its own, so
    // `console` is the honest answer — not a person, and still a statement about
    // where the act came from. What it must not be is empty: the recorder turns a
    // falsy actor into NULL, and NULL in that column reads as "nobody did this".
    const { server, workspace } = await boot({ guarded: false });

    await request(server)
      .patch('/api/catalog/types/WorkOrder')
      .send({ displayName: 'Work Order' })
      .expect(200);
    await request(server).post('/api/catalog/reset').expect(201);

    expect(curationEvents(workspace).map((event) => event.principalId)).toEqual([
      'console',
      'console',
    ]);
  });

  it('never files a curation entry under an empty actor', async () => {
    // The assertion the whole design turns on, stated once against both events
    // and both mounts. `undefined` here means the recorder wrote NULL, which is
    // indistinguishable from the rows written before actors were recorded at all.
    const { server, workspace } = await boot({ guarded: false });

    await request(server)
      .patch('/api/catalog/types/WorkOrder/properties/acftSn')
      .send({ hidden: true })
      .expect(200);
    await request(server).post('/api/catalog/reset').expect(201);

    for (const event of curationEvents(workspace)) {
      expect(`${event.event}: ${event.principalId}`).not.toBe(`${event.event}: undefined`);
      expect(`${event.event}: ${event.principalId}`).not.toBe(`${event.event}: `);
    }
  });

  it('says "unattributed" when the registry is called with nobody named', async () => {
    // Not reachable through a route — the controller always supplies one — but
    // very reachable from a host's own admin script or scheduled job, which is
    // the caller the parameter cannot bind. The distinction is the point:
    // `console` says an unguarded request came through this library's HTTP
    // surface, this says the API was called in-process and named nobody, and an
    // empty column would say neither.
    const { workspace, registry } = await boot();

    // Deliberately through the JavaScript the compiler does not see, because that
    // is the only shape this fallback exists for. `unknown` and `Reflect.apply`
    // rather than the method off the class: `Reflect.get` keeps the declared
    // signature when the key is known, so a direct call here would be checked for
    // the very argument this case is about omitting.
    const call: unknown = Reflect.get(registry, 'patchType');
    if (typeof call !== 'function') throw new Error('patchType is not callable');
    await Reflect.apply(call, registry, ['WorkOrder', { displayName: 'Work Order' }]);

    expect(curationEvents(workspace)[0].principalId).toBe(UNATTRIBUTED_PRINCIPAL_ID);
  });

  // -------------------------------------------------------------------------
  // 4. What did not change.
  // -------------------------------------------------------------------------

  it('still records what changed, not only who changed it', async () => {
    // The actor was added to a payload that already answered "what". A producer
    // that replaced the summary rather than extending it would leave the trail
    // able to name a curator and not the edit.
    const { server, workspace } = await boot();

    await request(server)
      .patch('/api/catalog/types/WorkOrder')
      .send({ displayName: 'Work Order', group: 'Maintenance' })
      .expect(200);

    expect(curationEvents(workspace)[0].detail).toMatchObject({
      typeName: 'WorkOrder',
      changed: ['displayName', 'group'],
    });
  });

  it('says nothing when the patch was refused', async () => {
    // A 404 curated nothing. An entry here would name somebody for an edit that
    // never landed, which is worse than no entry: it is a false one.
    const { server, workspace } = await boot();

    await request(server)
      .patch('/api/catalog/types/NoSuchType')
      .send({ displayName: 'Nope' })
      .expect(404);
    await request(server)
      .patch('/api/catalog/types/WorkOrder/properties/noSuchColumn')
      .send({ hidden: true })
      .expect(404);

    expect(curationEvents(workspace)).toEqual([]);
  });
});
