/**
 * Making every existing consumer environment-aware without changing any of
 * them.
 *
 * The problem this solves: the catalog's read API, its publish path, its
 * pipeline controller and the library's own `CatalogModule` controller all
 * inject a store by token and hold onto it for the life of the process. Once
 * there is more than one environment, "the store" stops being a thing — but
 * rewriting every consumer to take an environment argument would mean the
 * environment is passed by hand in dozens of places, and the one place somebody
 * forgets is a request served by the wrong world with no error attached.
 *
 * So the environment travels the way a request travels: in an
 * `AsyncLocalStorage`, established once at the edge, read by a set of proxies
 * that stand where the concrete stores used to. A consumer that never heard of
 * environments keeps working and is now correct, because the store it is
 * holding forwards to whichever environment the current request resolved to.
 *
 * The property that makes this safe rather than merely convenient: **there is
 * no ambient default.** A call that reaches one of these proxies outside any
 * environment scope throws {@link UnresolvedEnvironmentError}. It cannot serve
 * production because production is what it would have picked; it serves
 * nothing, and the stack trace names the caller that forgot to establish a
 * scope. The alternative — a proxy that falls back to the first configured
 * environment — is the silent cross-environment read this whole design exists
 * to make impossible.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  AuditQuery,
  CarryForwardResult,
  CatalogAuditEvent,
  CatalogConnection,
  CatalogConnector,
  CatalogEnvironment,
  CatalogGraph,
  CatalogMergeStore,
  CatalogObjectTypeDef,
  CatalogOverlay,
  CatalogPipelineStore,
  CatalogQueryRelation,
  CatalogQueryRequest,
  CatalogQueryResult,
  CatalogQueryStore,
  CatalogReadQuery,
  CatalogReadResult,
  CatalogSnapshot,
  CatalogStageStore,
  CatalogStoreCapabilities,
  CatalogTransform,
  CatalogWorkflow,
  CatalogWorkflowStore,
  CatalogWorkspaceStore,
  ConnectionCheck,
  ConnectorRun,
  Dashboard,
  DashboardCard,
  EnvironmentStampedAuditEvent,
  SaveQueryInput,
  SavedQuery,
  SnapshotRef,
} from '@dudousxd/nestjs-catalog';
import {
  CatalogRegistry,
  UnresolvedEnvironmentError,
  isQueryStore,
  stampEnvironment,
  supportsWorkflowStages,
  supportsWorkflows,
} from '@dudousxd/nestjs-catalog';
import { BadRequestException, Injectable } from '@nestjs/common';
import type { CatalogEnvironmentBundle } from './environment.bundle';

/**
 * Module-level rather than injected, because the proxies below are constructed
 * by Nest and the scope has to be establishable from a middleware, a guard, a
 * durable step and a scheduler tick alike — all of which have a request-ish
 * boundary and none of which share an injector.
 *
 * `AsyncLocalStorage` and not a plain variable: a single mutable "current
 * environment" would be shared by every concurrent request in the process, so
 * two requests for two environments overlapping — which is the normal case, not
 * an edge one — would each see whichever wrote last.
 */
const storage = new AsyncLocalStorage<CatalogEnvironmentBundle>();

/**
 * Run something with an environment in scope.
 *
 * Everything inside — including anything it awaits, and anything those await —
 * sees this environment and no other. Nesting is allowed and the inner scope
 * wins, which is what a promotion needs: it reads the source inside one scope
 * and writes the target inside another, and the two cannot be confused because
 * neither is ambient.
 */
export function runInEnvironment<T>(bundle: CatalogEnvironmentBundle, fn: () => T): T {
  return storage.run(bundle, fn);
}

/** The environment in scope, or undefined. For code that legitimately may not have one. */
export function currentEnvironmentBundle(): CatalogEnvironmentBundle | undefined {
  return storage.getStore();
}

/** The environment in scope, or a refusal. Everything on the request path uses this. */
export function requireEnvironmentBundle(): CatalogEnvironmentBundle {
  const bundle = storage.getStore();
  if (!bundle) throw new UnresolvedEnvironmentError();
  return bundle;
}

/** The environment in scope, described. Useful for stamping attribution. */
export function currentEnvironment(): CatalogEnvironment | undefined {
  return storage.getStore()?.environment;
}

/**
 * The model, for whichever environment the caller is in.
 *
 * Extends `CatalogRegistry` because that abstract class doubles as the DI
 * token: a host binds this under `CatalogRegistry` and the library's own
 * controller, which asks for the token and knows nothing about environments,
 * starts serving whichever one the request named.
 */
@Injectable()
export class RoutingCatalogRegistry extends CatalogRegistry {
  getSnapshot(): CatalogSnapshot {
    return requireEnvironmentBundle().registry.getSnapshot();
  }

  getType(name: string): CatalogObjectTypeDef | undefined {
    return requireEnvironmentBundle().registry.getType(name);
  }

  getGraph(): CatalogGraph {
    return requireEnvironmentBundle().registry.getGraph();
  }

  patchType(
    typeName: string,
    patch: Partial<CatalogOverlay['types'][string]>,
  ): Promise<CatalogObjectTypeDef | undefined> {
    return requireEnvironmentBundle().registry.patchType(typeName, patch);
  }

  patchProperty(
    typeName: string,
    propertyName: string,
    patch: NonNullable<CatalogOverlay['types'][string]['properties']>[string],
  ): Promise<CatalogObjectTypeDef | undefined> {
    return requireEnvironmentBundle().registry.patchProperty(typeName, propertyName, patch);
  }

  resetOverlay(): Promise<void> {
    return requireEnvironmentBundle().registry.resetOverlay();
  }

  /**
   * Not on the abstract class, but on the stored implementation, and callers
   * that publish need it. Forwarded so a publish path can stay written against
   * one registry object.
   */
  reload(): Promise<void> {
    return requireEnvironmentBundle().registry.reload();
  }
}

/**
 * Rows, for whichever environment the caller is in.
 *
 * Implements the merge store rather than the plain write store because the
 * MySQL store does, and a proxy that dropped `carryForward` would make every
 * incremental connector fail its capability check — the store *can* merge, the
 * proxy just would not have said so.
 */
@Injectable()
export class RoutingCatalogStore implements CatalogMergeStore, CatalogQueryStore {
  get capabilities(): CatalogStoreCapabilities {
    return requireEnvironmentBundle().store.capabilities;
  }

  read(
    type: CatalogObjectTypeDef,
    fields: string[],
    query: CatalogReadQuery,
  ): Promise<CatalogReadResult> {
    return requireEnvironmentBundle().store.read(type, fields, query);
  }

  listSnapshots(type: CatalogObjectTypeDef): Promise<SnapshotRef[]> {
    return requireEnvironmentBundle().store.listSnapshots(type);
  }

  ensureType(type: CatalogObjectTypeDef): Promise<void> {
    return requireEnvironmentBundle().store.ensureType(type);
  }

  write(
    type: CatalogObjectTypeDef,
    rows: Array<Record<string, unknown>>,
    options: {
      snapshotId: string;
      principalId: string;
      batch?: number;
      labels?: Record<string, string>;
    },
  ): Promise<{ written: number }> {
    return requireEnvironmentBundle().store.write(type, rows, options);
  }

  commit(type: CatalogObjectTypeDef, snapshotId: string): Promise<SnapshotRef> {
    return requireEnvironmentBundle().store.commit(type, snapshotId);
  }

  dropSnapshot(type: CatalogObjectTypeDef, snapshotId: string): Promise<void> {
    return requireEnvironmentBundle().store.dropSnapshot(type, snapshotId);
  }

  carryForward(
    type: CatalogObjectTypeDef,
    snapshotId: string,
    options: { principalId: string; labels?: Record<string, string> },
  ): Promise<CarryForwardResult> {
    return requireEnvironmentBundle().store.carryForward(type, snapshotId, options);
  }

  /**
   * Querying is routed too, and forwarding it is not optional.
   *
   * `isQueryStore` is a structural check, so a proxy that implements everything
   * else and omits these two reports "this catalog's store does not support SQL
   * queries" — a sentence about the engine, said about a wrapper, while the
   * engine underneath supports it perfectly well. The query screen went blank
   * that way, and the message sent the reader to the adapter rather than here.
   */
  runQuery(request: CatalogQueryRequest): Promise<CatalogQueryResult> {
    const { store } = requireEnvironmentBundle();
    if (!isQueryStore(store)) {
      throw new BadRequestException("This environment's store cannot run SQL queries.");
    }
    return store.runQuery(request);
  }

  queryRelations(): Promise<CatalogQueryRelation[]> {
    const { store } = requireEnvironmentBundle();
    // An empty list rather than a throw: a console asking what it may select
    // from is drawing a sidebar, and an environment backed by a store with no
    // query support has nothing to offer rather than something to complain
    // about. `runQuery` is where the refusal belongs, because that is where
    // somebody asked for something.
    return isQueryStore(store) ? store.queryRelations() : Promise.resolve([]);
  }
}

/** Connectors, transforms and connections, for whichever environment the caller is in. */
@Injectable()
export class RoutingPipelineStore implements CatalogPipelineStore {
  private get inner() {
    return requireEnvironmentBundle().pipeline;
  }

  listConnectors(): Promise<CatalogConnector[]> {
    return this.inner.listConnectors();
  }

  getConnector(id: string): Promise<CatalogConnector | undefined> {
    return this.inner.getConnector(id);
  }

  saveConnector(
    input: Omit<CatalogConnector, 'id' | 'createdAt' | 'updatedAt' | 'createdBy'> & {
      id?: string;
    },
    createdBy: string,
  ): Promise<CatalogConnector> {
    return this.inner.saveConnector(input, createdBy);
  }

  deleteConnector(id: string): Promise<boolean> {
    return this.inner.deleteConnector(id);
  }

  saveConnectorState(id: string, state: Record<string, unknown>): Promise<void> {
    return this.inner.saveConnectorState(id, state);
  }

  listConnections(): Promise<CatalogConnection[]> {
    return this.inner.listConnections();
  }

  getConnection(id: string): Promise<CatalogConnection | undefined> {
    return this.inner.getConnection(id);
  }

  saveConnection(
    input: Omit<CatalogConnection, 'id' | 'createdAt' | 'updatedAt' | 'createdBy'> & {
      id?: string;
    },
    createdBy: string,
  ): Promise<CatalogConnection> {
    return this.inner.saveConnection(input, createdBy);
  }

  deleteConnection(id: string): Promise<boolean> {
    return this.inner.deleteConnection(id);
  }

  recordConnectionCheck(id: string, check: ConnectionCheck): Promise<void> {
    return this.inner.recordConnectionCheck(id, check);
  }

  connectorsUsingConnection(id: string): Promise<CatalogConnector[]> {
    return this.inner.connectorsUsingConnection(id);
  }

  listTransforms(): Promise<CatalogTransform[]> {
    return this.inner.listTransforms();
  }

  getTransform(id: string): Promise<CatalogTransform | undefined> {
    return this.inner.getTransform(id);
  }

  saveTransform(
    input: Pick<CatalogTransform, 'name' | 'language' | 'code'> & {
      id?: string;
      description?: string;
    },
    createdBy: string,
  ): Promise<CatalogTransform> {
    return this.inner.saveTransform(input, createdBy);
  }

  deleteTransform(id: string): Promise<boolean> {
    return this.inner.deleteTransform(id);
  }

  startRun(input: {
    connectorId: string;
    snapshotId: string;
    principalId: string;
  }): Promise<ConnectorRun> {
    return this.inner.startRun(input);
  }

  finishRun(
    id: string,
    outcome: Partial<
      Pick<ConnectorRun, 'status' | 'fetched' | 'written' | 'logs' | 'error' | 'transformVersion'>
    >,
  ): Promise<ConnectorRun | undefined> {
    return this.inner.finishRun(id, outcome);
  }

  listRuns(connectorId?: string, limit?: number): Promise<ConnectorRun[]> {
    return this.inner.listRuns(connectorId, limit);
  }
  // Workflows and their staged rows route like everything else.
  //
  // Optional on the interface, so omitting them here would have compiled — and
  // `supportsWorkflows` is a structural check, so the whole deployment would
  // have reported that it cannot hold workflows while every environment
  // underneath held them perfectly well. Forwarding is not a convenience; it is
  // what stops a proxy from answering a question about the thing it wraps.
  //
  // Each one refuses rather than returning empty when the environment's own
  // store lacks the capability: a caller that asked to save a graph and got
  // nothing back has been told the save worked.

  listWorkflows(): Promise<CatalogWorkflow[]> {
    const inner = this.inner;
    return supportsWorkflows(inner) ? inner.listWorkflows() : Promise.resolve([]);
  }

  getWorkflow(id: string): Promise<CatalogWorkflow | undefined> {
    const inner = this.inner;
    return supportsWorkflows(inner) ? inner.getWorkflow(id) : Promise.resolve(undefined);
  }

  saveWorkflow(
    input: Pick<CatalogWorkflow, 'name' | 'nodes' | 'edges'> & {
      id?: string;
      description?: string;
    },
    createdBy: string,
  ): Promise<CatalogWorkflow> {
    return requireWorkflows(this.inner).saveWorkflow(input, createdBy);
  }

  deleteWorkflow(id: string): Promise<boolean> {
    return requireWorkflows(this.inner).deleteWorkflow(id);
  }

  connectorsUsingWorkflow(id: string): Promise<CatalogConnector[]> {
    const inner = this.inner;
    return supportsWorkflows(inner) ? inner.connectorsUsingWorkflow(id) : Promise.resolve([]);
  }

  writeStage(input: {
    runId: string;
    nodeId: string;
    batch: number;
    rows: Array<Record<string, unknown>>;
  }): Promise<{ written: number }> {
    return requireStages(this.inner).writeStage(input);
  }

  readStage(ref: {
    runId: string;
    nodeId: string;
    batch: number;
  }): Promise<Array<Record<string, unknown>>> {
    return requireStages(this.inner).readStage(ref);
  }

  dropStages(runId: string): Promise<number> {
    return requireStages(this.inner).dropStages(runId);
  }
}

/**
 * Refuse loudly when the environment's store cannot do this.
 *
 * A write that quietly does nothing is the failure this codebase keeps
 * removing: the caller is told the graph was saved, and finds out otherwise
 * when a run cannot find it. Reads may answer "none"; writes may not.
 */
function requireWorkflows(
  store: CatalogPipelineStore,
): CatalogPipelineStore & CatalogWorkflowStore {
  if (!supportsWorkflows(store)) {
    throw new BadRequestException("This environment's pipeline store cannot hold workflows.");
  }
  return store;
}

function requireStages(store: CatalogPipelineStore): CatalogPipelineStore & CatalogStageStore {
  if (!supportsWorkflowStages(store)) {
    throw new BadRequestException(
      "This environment's pipeline store cannot stage rows between workflow nodes.",
    );
  }
  return store;
}

/**
 * Saved queries, dashboards and the audit trail, for whichever environment the
 * caller is in.
 *
 * The audit half is why this proxy matters most. `CatalogAuditRecorder`
 * subscribes to the diagnostics channel once and writes every event through one
 * workspace store; handed this one, each event lands in the database of the
 * environment whose scope it was emitted inside. That is what makes "every
 * audit event records its environment" true by construction rather than by a
 * column somebody has to remember to fill — a row in the production database
 * cannot claim to be a dev event, because nothing but a production-scoped call
 * can put a row there.
 *
 * The claim is only true while the recorder can actually be handed this class.
 * It could not, once: the recorder asked for `MySqlWorkspaceStore` by class, and
 * this one implements the interface rather than extending it, so no amount of
 * host wiring could substitute it and every event in a multi-environment process
 * went to one database regardless of scope. It injects `CATALOG_WORKSPACE_STORE`
 * now. A host that runs several environments binds *this* class to that token;
 * a host with one binds `MySqlWorkspaceStore`, which is what
 * `CatalogMikroOrmStoreModule` does and why the single-environment default is
 * unchanged.
 *
 * {@link listEvents} completes the round trip by stamping what it read — see the
 * note on it for why the stamp can only be applied here.
 *
 * `recordEvent` is the one method that must not throw when there is no scope.
 * An event emitted outside any environment — a boot-time diagnostic, a
 * schedule tick that has not entered its environment yet — is a lost audit row,
 * which is bad; an exception thrown from an event handler on a background tick
 * is an unhandled rejection that can take the process down, which is worse. So
 * it drops the event and says so once, and every other method still refuses.
 */
@Injectable()
export class RoutingWorkspaceStore implements CatalogWorkspaceStore {
  private warnedAboutScopelessEvents = false;

  private get inner() {
    return requireEnvironmentBundle().workspace;
  }

  listSavedQueries(): Promise<SavedQuery[]> {
    return this.inner.listSavedQueries();
  }

  getSavedQuery(id: string): Promise<SavedQuery | undefined> {
    return this.inner.getSavedQuery(id);
  }

  saveQuery(input: SaveQueryInput, createdBy: string): Promise<SavedQuery> {
    return this.inner.saveQuery(input, createdBy);
  }

  updateSavedQuery(id: string, input: Partial<SaveQueryInput>): Promise<SavedQuery | undefined> {
    return this.inner.updateSavedQuery(id, input);
  }

  deleteSavedQuery(id: string): Promise<boolean> {
    return this.inner.deleteSavedQuery(id);
  }

  listDashboards(): Promise<Dashboard[]> {
    return this.inner.listDashboards();
  }

  getDashboard(id: string): Promise<Dashboard | undefined> {
    return this.inner.getDashboard(id);
  }

  saveDashboard(
    input: {
      name: string;
      description?: string;
      cards?: DashboardCard[];
      shared?: boolean;
    },
    createdBy: string,
  ): Promise<Dashboard> {
    return this.inner.saveDashboard(input, createdBy);
  }

  updateDashboard(
    id: string,
    input: Partial<{
      name: string;
      description: string;
      cards: DashboardCard[];
      shared: boolean;
    }>,
  ): Promise<Dashboard | undefined> {
    return this.inner.updateDashboard(id, input);
  }

  deleteDashboard(id: string): Promise<boolean> {
    return this.inner.deleteDashboard(id);
  }

  async recordEvent(event: Omit<CatalogAuditEvent, 'id'>): Promise<void> {
    const bundle = currentEnvironmentBundle();
    if (!bundle) {
      if (!this.warnedAboutScopelessEvents) {
        this.warnedAboutScopelessEvents = true;
        // Once, not per event. A background emitter that has this wrong emits
        // continuously, and a log line per event would bury the one that says
        // what to fix.
        console.warn(
          `[catalog] A "${event.event}" event was emitted with no environment in scope, so it was not recorded. Wrap the emitting work in runInEnvironment() — an audit row that cannot say which world it happened in is not a governance record.`,
        );
      }
      return;
    }
    await bundle.workspace.recordEvent(event);
  }

  /**
   * The trail, with the environment it came out of stamped onto every event.
   *
   * Here and nowhere else, because here is the only place that knows. A
   * `MySqlWorkspaceStore` holds one EntityManager and has never been told which
   * environment that connection belongs to; this proxy resolved the bundle in
   * order to do the read, so the id it stamps is derived from the connection the
   * rows were actually read through. That is the whole point of stamping on read
   * rather than storing a column: a column can be wrong — nothing in MySQL stops
   * a row in the production table saying `environment: "dev"` — and a value
   * taken from the connection that produced the row cannot be.
   *
   * The return type widens rather than the shared `CatalogAuditEvent` gaining a
   * field. An optional `environment?` on the interface would be absent on most
   * reads and present on some, which is a shape every consumer has to test
   * before trusting; this way the type says exactly what is true, that events
   * read through environment routing carry their environment and events read
   * straight off a store do not.
   *
   * What it buys is the cross-environment governance question — "everything this
   * person did this week", asked of a deployment with three of them. The answer
   * is N reads, one per `runInEnvironment` scope, concatenated; without the
   * stamp the concatenation is a list whose rows are indistinguishable and the
   * reader has to remember which third of it they are looking at.
   */
  async listEvents(
    query: AuditQuery,
  ): Promise<Array<CatalogAuditEvent & EnvironmentStampedAuditEvent>> {
    const bundle = requireEnvironmentBundle();
    return stampEnvironment(bundle.environment.id, await bundle.workspace.listEvents(query));
  }
}
