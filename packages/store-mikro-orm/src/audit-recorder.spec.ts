import { setImmediate as flush } from 'node:timers/promises';
import {
  CATALOG_WORKSPACE_STORE,
  type CatalogAuditEvent,
  type CatalogEnvironment,
  type CatalogWorkspaceStore,
  type Dashboard,
  type SaveQueryInput,
  type SavedQuery,
  emitCatalog,
} from '@dudousxd/nestjs-catalog';
import { EntityManager } from '@mikro-orm/sql';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { CatalogAuditRecorder, MySqlCatalogTraceStore } from './audit-recorder.service';
import { CatalogEnvironmentBundle } from './environment.bundle';
import { RoutingWorkspaceStore, runInEnvironment } from './environment.routing';

/**
 * That an audit event can say which environment it happened in, and that a
 * trace can say when its steps happened.
 *
 * Both were claimed by docblocks and implemented by nothing.
 * `environment.routing.ts` said routing the recorder made "every audit event
 * records its environment" true by construction — while `CatalogAuditRecorder`
 * asked for `MySqlWorkspaceStore` *by class*, which `RoutingWorkspaceStore`
 * implements rather than extends, so the routed store could never be handed to
 * it however a host wired its module. And `CLOCK_RESOLUTION_MS` still said one
 * second after the audit column was widened to `datetime(3)`, so every trace
 * shorter than a second was reported as having no internal timing to draw.
 *
 * So these assert the delivered rows and the computed flag rather than that
 * some method was called. A spy on `recordEvent` would have passed against the
 * class-injected recorder, since the spy would have been the class.
 */

// ---------------------------------------------------------------------------
// Stubs. Only what the audit path touches does anything; the rest refuses, so
// a change that starts calling something new fails here rather than passing.
// ---------------------------------------------------------------------------

class StubWorkspace implements CatalogWorkspaceStore {
  readonly recorded: Array<Omit<CatalogAuditEvent, 'id'>> = [];

  /** What `listEvents` hands back, so the stamp has something to land on. */
  constructor(private readonly stored: CatalogAuditEvent[] = []) {}

  recordEvent(event: Omit<CatalogAuditEvent, 'id'>): Promise<void> {
    this.recorded.push(event);
    return Promise.resolve();
  }

  listEvents(): Promise<CatalogAuditEvent[]> {
    return Promise.resolve(this.stored);
  }

  listSavedQueries(): Promise<SavedQuery[]> {
    return Promise.reject(new Error('not part of the audit path'));
  }
  getSavedQuery(): Promise<SavedQuery | undefined> {
    return Promise.reject(new Error('not part of the audit path'));
  }
  saveQuery(_input: SaveQueryInput, _createdBy: string): Promise<SavedQuery> {
    return Promise.reject(new Error('not part of the audit path'));
  }
  updateSavedQuery(): Promise<SavedQuery | undefined> {
    return Promise.reject(new Error('not part of the audit path'));
  }
  deleteSavedQuery(): Promise<boolean> {
    return Promise.reject(new Error('not part of the audit path'));
  }
  listDashboards(): Promise<Dashboard[]> {
    return Promise.reject(new Error('not part of the audit path'));
  }
  getDashboard(): Promise<Dashboard | undefined> {
    return Promise.reject(new Error('not part of the audit path'));
  }
  saveDashboard(): Promise<Dashboard> {
    return Promise.reject(new Error('not part of the audit path'));
  }
  updateDashboard(): Promise<Dashboard | undefined> {
    return Promise.reject(new Error('not part of the audit path'));
  }
  deleteDashboard(): Promise<boolean> {
    return Promise.reject(new Error('not part of the audit path'));
  }
}

function environment(id: string): CatalogEnvironment {
  return {
    id,
    displayName: id,
    databaseName: `catalog_${id}`,
    contextName: id,
    durableKeyspace: `catalog-${id}`,
    rank: 1,
    protected: false,
  };
}

/**
 * A bundle carrying only the two members the routing store reads.
 *
 * Built off the prototype rather than by `new`, because the real constructor is
 * private and takes a live MikroORM — and the point of these cases is that they
 * run on a laptop with no MySQL anywhere near them. Everything the routing
 * store touches (`environment`, `workspace`) is real; nothing else is reached,
 * and a change that starts reaching for `em` or `registry` here fails loudly on
 * undefined rather than quietly passing.
 */
function bundleFor(id: string, workspace: StubWorkspace): CatalogEnvironmentBundle {
  const bundle: CatalogEnvironmentBundle = Object.create(CatalogEnvironmentBundle.prototype);
  return Object.assign(bundle, { environment: environment(id), workspace });
}

/** One `connector.run.started`, which is a real member of `CATALOG_EVENTS`. */
function emitRunStarted(snapshotId: string, principalId: string): void {
  emitCatalog('connector.run.started', {
    connectorId: 'mvr-nightly',
    connectorName: 'MVR nightly',
    typeName: 'Mvr',
    snapshotId,
    principalId,
  });
}

describe('CatalogAuditRecorder wiring', () => {
  it('writes through whatever is bound to CATALOG_WORKSPACE_STORE', async () => {
    const workspace = new StubWorkspace();
    const moduleRef = await Test.createTestingModule({
      providers: [{ provide: CATALOG_WORKSPACE_STORE, useValue: workspace }, CatalogAuditRecorder],
    }).compile();
    await moduleRef.init();

    emitRunStarted('snap-1', 'ana@example.com');
    await flush();

    expect(workspace.recorded).toHaveLength(1);
    expect(workspace.recorded[0]).toMatchObject({
      event: 'connector.run.started',
      typeName: 'Mvr',
      principalId: 'ana@example.com',
      snapshotId: 'snap-1',
    });

    await moduleRef.close();
  });

  /**
   * The claim `environment.routing.ts` makes, end to end.
   *
   * Nothing here says "environment" to the recorder. The event is emitted inside
   * a scope, the routed store resolves that scope, and the row lands in that
   * environment's own workspace — which is what "a row in the production
   * database cannot claim to be a dev event" has to mean if it means anything.
   */
  it('routes each event to the environment whose scope it was emitted in', async () => {
    const dev = new StubWorkspace();
    const prod = new StubWorkspace();
    const moduleRef = await Test.createTestingModule({
      providers: [
        RoutingWorkspaceStore,
        { provide: CATALOG_WORKSPACE_STORE, useExisting: RoutingWorkspaceStore },
        CatalogAuditRecorder,
      ],
    }).compile();
    await moduleRef.init();

    runInEnvironment(bundleFor('dev', dev), () => emitRunStarted('snap-dev', 'ana@example.com'));
    runInEnvironment(bundleFor('prod', prod), () => emitRunStarted('snap-prod', 'bo@example.com'));
    await flush();

    expect(dev.recorded.map((event) => event.snapshotId)).toEqual(['snap-dev']);
    expect(prod.recorded.map((event) => event.snapshotId)).toEqual(['snap-prod']);

    await moduleRef.close();
  });
});

describe('reading the trail back', () => {
  /**
   * The other half of the attribution claim: what comes *out* says where it came
   * from.
   *
   * `stampEnvironment` shipped with a paragraph about answering "everything this
   * person did this week" across environments, and had no call site anywhere in
   * the repository. The stamp has to be applied by this reader specifically,
   * because this reader is the only one that resolved an environment in order to
   * choose the connection — which is exactly what makes the value underivable
   * from, and unfalsifiable by, anything in the row.
   */
  it('stamps read events with the environment they were read through', async () => {
    const store = new RoutingWorkspaceStore();
    const devRow = auditRow('audit-1', 'snap-dev');
    const prodRow = auditRow('audit-2', 'snap-prod');

    const fromDev = await runInEnvironment(bundleFor('dev', new StubWorkspace([devRow])), () =>
      store.listEvents({}),
    );
    const fromProd = await runInEnvironment(bundleFor('prod', new StubWorkspace([prodRow])), () =>
      store.listEvents({}),
    );

    expect(fromDev.map((event) => event.environment)).toEqual(['dev']);
    expect(fromProd.map((event) => event.environment)).toEqual(['prod']);
    // The event itself is untouched: the stamp is added, nothing is rewritten.
    expect(fromDev[0]).toMatchObject({ id: 'audit-1', snapshotId: 'snap-dev' });
  });
});

function auditRow(id: string, snapshotId: string): CatalogAuditEvent {
  return {
    id,
    event: 'connector.run.started',
    typeName: 'Mvr',
    principalId: 'ana@example.com',
    snapshotId,
    detail: {},
    occurredAt: '2026-03-04T09:15:00.000Z',
  };
}

describe('the trace clock', () => {
  /**
   * A trace whose spans are tens of milliseconds apart is not coarse.
   *
   * Forty milliseconds is the case the stale constant got wrong: well inside one
   * second, so it was flagged as unmeasurable, and well outside one millisecond,
   * so the column had recorded the spacing perfectly. The explorer replaced the
   * waterfall with a dashed track and said there was no internal timing to draw.
   */
  it('reports millisecond resolution and measures a sub-second trace', async () => {
    const store = new MySqlCatalogTraceStore(fakeEntityManager());
    const list = await store.listTraces({});

    expect(list.clockResolutionMs).toBe(1);
    const [trace] = list.traces;
    expect(trace.coarse).toBe(false);
    expect(trace.spans.map((span) => span.offsetMs)).toEqual([0, 40]);
  });
});

const STARTED_AT = new Date('2026-03-04T09:15:00.000Z');
const FINISHED_AT = new Date('2026-03-04T09:15:00.040Z');

/**
 * The two span rows one query would return, without a database.
 *
 * `getConnection().execute` is the only thing the trace store asks of its
 * EntityManager, so it is the only thing supplied. Two events forty milliseconds
 * apart, which is what a `datetime(3)` column can hold and a `datetime` cannot.
 */
function fakeEntityManager(): EntityManager {
  const rows = [
    spanRow('connector.run.started', 'span-1', STARTED_AT),
    spanRow('connector.run.finished', 'span-2', FINISHED_AT),
  ];
  const em: EntityManager = Object.create(EntityManager.prototype);
  return Object.assign(em, {
    getConnection: () => ({
      // The same connection answers the trace query and the unlinked-events
      // query. Told apart by the condition only the second one carries, so this
      // stub cannot accidentally feed span rows into a list that is defined as
      // the events belonging to no trace.
      execute: (sql: string) => Promise.resolve(sql.includes('e.snapshot_id IS NULL') ? [] : rows),
    }),
  });
}

function spanRow(event: string, spanId: string, at: Date) {
  return {
    snapshot_id: 'snap-1',
    started_at: STARTED_AT,
    last_at: FINISHED_AT,
    event_count: 2,
    type_name: 'Mvr',
    principal_id: 'ana@example.com',
    connector_id: 'mvr-nightly',
    connector_name: 'MVR nightly',
    rows_committed: 12,
    failures: 0,
    outcome: 'succeeded',
    total: 1,
    span_id: spanId,
    span_event: event,
    span_type_name: 'Mvr',
    span_principal_id: 'ana@example.com',
    span_detail: { status: 'succeeded' },
    span_at: at,
  };
}
