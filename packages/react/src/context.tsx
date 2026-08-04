import type {
  CatalogAuditEvent,
  CatalogConnection,
  CatalogConnector,
  CatalogObjectPage,
  CatalogQueryRelation,
  CatalogQueryResult,
  CatalogSnapshot,
  CatalogTraceList,
  CatalogTransform,
  ConnectionCheck,
  ConnectorRun,
  Dashboard,
  DashboardCard,
  ObjectQueryParams,
  PropertyPatch,
  SaveQueryInput,
  SavedQuery,
  TraceQuery,
  TransformLanguage,
  TransformResult,
  TypePatch,
} from '@dudousxd/nestjs-catalog/client';
import { catalogRoutes } from '@dudousxd/nestjs-catalog/client';
import { type ReactNode, createContext, useContext, useMemo } from 'react';
import {
  DEFAULT_ACCESS_BASE_PATH,
  DEFAULT_PIPELINE_BASE_PATH,
  type PeopleQuery,
  accessRoutes,
  pipelineRoutes,
} from './routes';
// The graph itself comes from `@dudousxd/nestjs-catalog/client`; what is left in
// this module is the handful of shapes only a console has an opinion about — the
// input a form may send, the durability answer, and the run view. See
// src/workflow/model.ts.
import type {
  CatalogWorkflow,
  WorkflowDurability,
  WorkflowInput,
  WorkflowRun,
} from './workflow/model';

/**
 * How these screens talk to the server.
 *
 * A `transport` rather than a built-in HTTP client: every host that would
 * install this already has one, with its own base URL, auth interceptors,
 * retries and error reporting. Bringing a second one along would mean the
 * console is the one screen in the app that authenticates differently.
 */
export interface CatalogTransport {
  get<T>(path: string, params?: Record<string, unknown>): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  delete<T>(path: string): Promise<T>;
}

/**
 * What this deployment can actually execute.
 *
 * Reported rather than assumed. A transform editor that offers Python on an
 * image without a Python runtime turns a deployment difference into a traceback
 * the transform's author cannot act on, and `pythonPackages` exists for the same
 * reason: "pandas is available" is a property of the image, not of the library.
 */
export interface PipelineCapabilities {
  languages: TransformLanguage[];
  pythonPackages: string[];
  /**
   * Whether this deployment can checkpoint between the nodes of a workflow.
   *
   * Optional, and its absence is a third answer rather than a synonym for
   * "no": a server older than this field has not been asked. The workflow
   * canvas renders all three states separately, because a screen that implies a
   * failed run will resume where it stopped — on a deployment with no durable
   * engine — is the exact promise this project keeps having to remove.
   */
  durable?: WorkflowDurability;
}

/**
 * What a caller may set on a connection.
 *
 * The server-owned fields — who created it, when, and the outcome of the last
 * check — are deliberately absent. They are consequences, written by the server,
 * and a form that could send them would let somebody claim a connection was
 * reachable without ever reaching it.
 */
export interface ConnectionInput {
  /** Present when editing. Absent creates a new connection. */
  id?: string;
  name: string;
  description?: string;
  kind: CatalogConnection['kind'];
  config: Record<string, unknown>;
  secretEnvVar?: string;
}

/** Same rule as {@link ConnectionInput}: authored fields only, never state. */
export interface ConnectorInput {
  id?: string;
  name: string;
  description?: string;
  kind: CatalogConnector['kind'];
  targetType: string;
  config: Record<string, unknown>;
  connectionId?: string;
  secretEnvVar?: string;
  transformId?: string;
  schedule?: string;
  mode?: 'full' | 'incremental';
  enabled: boolean;
}

export interface TransformInput {
  id?: string;
  name: string;
  description?: string;
  language: TransformLanguage;
  code: string;
}

/** The three answers a console can give somebody about what they may do. */
export type CatalogPersonRole = 'viewer' | 'curator' | 'admin';

/**
 * Who the server thinks is calling, as the access screen needs it.
 *
 * A prop rather than something this package fetches, because signing in is not
 * part of the catalog's surface: a host may use a session cookie, OIDC, a
 * reverse proxy header or nothing at all, and a library that fetched
 * `/auth/me` would be dictating the answer.
 *
 * `actor` carries the distinction the whole screen exists to make. Non-null
 * means a person is behind this request and `principalId` names them; null means
 * an application key is, and nothing anyone does will be attributable to a
 * human.
 */
export interface CatalogIdentity {
  principalId: string;
  displayName: string;
  actor: { id: string; displayName: string } | null;
  scopes: string[];
  writeTypes: string[];
  /** Null means every type, which is not the same as an empty list. */
  readTypes: string[] | null;
  classifications: string[];
  session: { expiresAt: string; idleMinutes: number } | null;
}

/** An application: holds a credential, acts on its own behalf. */
export interface CatalogPrincipalSummary {
  id: string;
  displayName: string;
  scopes: string[];
  writeTypes: string[];
  readTypes: string[] | null;
  classifications: string[];
  active: boolean;
  /**
   * How it authenticates. Never the credential itself — a console that can
   * display one is a console that leaks it over somebody's shoulder.
   */
  authMethod: 'key' | 'token' | 'session';
  lastSeenAt: string | null;
  ownedTypes: string[];
}

export interface CatalogPeoplePage {
  people: CatalogPersonSummary[];
  /** How many match, ignoring the page. */
  total: number;
  limit: number;
  offset: number;
}

/** A person: signs in, and acts through an application that caps them. */
export interface CatalogPersonSummary {
  email: string;
  displayName: string;
  role: CatalogPersonRole;
  active: boolean;
  /** Exactly the string their actions land in the audit trail as. */
  principalId: string;
  hasPassword: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  liveSessions: number;
  /**
   * The intersection with the application they sign in through, not the role in
   * the abstract. An administrator whose console has had `catalog:admin` removed
   * is not an administrator, and showing the role alone would say otherwise.
   */
  effective: {
    scopes: string[];
    writeTypes: string[];
    readTypes: string[] | null;
    classifications: string[];
  };
}

export interface PersonInput {
  email: string;
  displayName: string;
  role: CatalogPersonRole;
  password?: string;
  active?: boolean;
}

export interface PersonUpsertResult {
  email: string;
  created: boolean;
  /**
   * Whether open sessions were invalidated. Surfaced because demoting somebody
   * whose tabs keep working is the failure that makes people distrust the whole
   * session system.
   */
  sessionsRevoked: boolean;
}

export interface CatalogClient {
  snapshot(): Promise<CatalogSnapshot>;
  objects(type: string, params: ObjectQueryParams): Promise<CatalogObjectPage>;
  patchType(name: string, patch: TypePatch): Promise<unknown>;
  patchProperty(name: string, property: string, patch: PropertyPatch): Promise<unknown>;
  reset(): Promise<CatalogSnapshot>;
  queryRelations(): Promise<CatalogQueryRelation[]>;
  runQuery(input: { sql: string; maxRows?: number }): Promise<CatalogQueryResult>;

  workspaceCapabilities(): Promise<{ workspace: boolean; query: boolean }>;
  listSavedQueries(): Promise<SavedQuery[]>;
  saveQuery(input: SaveQueryInput): Promise<SavedQuery>;
  updateSavedQuery(id: string, input: Partial<SaveQueryInput>): Promise<SavedQuery>;
  deleteSavedQuery(id: string): Promise<{ deleted: boolean }>;
  runSavedQuery(id: string): Promise<{ savedQuery: SavedQuery; result: CatalogQueryResult }>;
  exportUrl(id: string): string;

  listDashboards(): Promise<Dashboard[]>;
  saveDashboard(input: { name: string; description?: string }): Promise<Dashboard>;
  updateDashboard(
    id: string,
    input: Partial<{ name: string; description: string; cards: DashboardCard[] }>,
  ): Promise<Dashboard>;
  deleteDashboard(id: string): Promise<{ deleted: boolean }>;

  listEvents(query: {
    event?: string;
    typeName?: string;
    principalId?: string;
    limit?: number;
  }): Promise<CatalogAuditEvent[]>;
  /**
   * The same events, grouped into one causal story each.
   *
   * Beside `listEvents` rather than replacing it: a flat feed answers "what
   * happened recently" and a trace answers "what happened during that load",
   * and collapsing the two would cost the first question its answer.
   */
  listTraces(query: TraceQuery): Promise<CatalogTraceList>;

  /**
   * Getting data in.
   *
   * On the same client as everything above rather than in a fetch module beside
   * the screens, because a host configures its transport exactly once — base
   * URL, auth, retries, error reporting — and a second module bound to a second
   * transport makes the pipeline screens the ones that authenticate differently.
   * That difference is invisible until the day a token refresh lands in one and
   * not the other.
   */
  pipelineCapabilities(): Promise<PipelineCapabilities>;

  listConnections(): Promise<CatalogConnection[]>;
  saveConnection(input: ConnectionInput): Promise<CatalogConnection>;
  /**
   * Reach it, and find out what answered.
   *
   * The server records the outcome as well as returning it, so the list can say
   * which connections are known to work without every page load reaching every
   * system it names.
   */
  checkConnection(id: string): Promise<ConnectionCheck>;
  /** Which connectors read through it. Named, so a refusal can say which. */
  connectionConnectors(id: string): Promise<CatalogConnector[]>;
  deleteConnection(id: string): Promise<{ deleted: boolean }>;

  listConnectors(): Promise<CatalogConnector[]>;
  saveConnector(input: ConnectorInput): Promise<CatalogConnector>;
  deleteConnector(id: string): Promise<{ deleted: boolean }>;
  runConnector(id: string): Promise<ConnectorRun>;
  listRuns(connectorId?: string): Promise<ConnectorRun[]>;

  listTransforms(): Promise<CatalogTransform[]>;
  saveTransform(input: TransformInput): Promise<CatalogTransform>;
  deleteTransform(id: string): Promise<{ deleted: boolean }>;
  /**
   * Run code against sample records without storing anything.
   *
   * The difference between a transform somebody can iterate on and one they can
   * only test in production.
   */
  tryTransform(input: {
    language: TransformLanguage;
    code: string;
    records: unknown[];
  }): Promise<TransformResult>;

  /**
   * Authored graphs: sources wired through transforms into sinks.
   *
   * `saveWorkflow` is the authority on whether a graph is legal. The canvas runs
   * core's own `validateWorkflow` while somebody draws — literally the same
   * function, shipped to the browser from `@dudousxd/nestjs-catalog/client` — so
   * that a cycle or a dead-end branch is reported beside the node that caused it
   * rather than as a toast a minute later. Sharing the code is not the same as
   * trusting the client: this call is still made, and its refusal always wins.
   */
  listWorkflows(): Promise<CatalogWorkflow[]>;
  saveWorkflow(input: WorkflowInput): Promise<CatalogWorkflow>;
  deleteWorkflow(id: string): Promise<{ deleted: boolean }>;
  /**
   * Execute it. When a durable engine is available each node runs as its own
   * step, so a failure part-way resumes rather than restarts — see
   * `PipelineCapabilities.durable`, which is what the screen states.
   */
  runWorkflow(id: string): Promise<WorkflowRun>;

  /**
   * Who may do what.
   *
   * Reads only. Creating a person is a write and it is here too, because an
   * account has to be creatable by somebody who is not holding a database
   * client — but granting an *application* access to a type is deliberately not,
   * for the reason it never was: it has real blast radius, and the moment it
   * becomes a button it stops leaving a reviewable trail.
   */
  listPrincipals(): Promise<CatalogPrincipalSummary[]>;
  /**
   * A PAGE, not the list. The server bounds it whatever is asked for, so a
   * caller that ignores `total` is a screen that silently under-reports who has
   * access — which reads as "this person has none" rather than "look further".
   */
  listPeople(query?: PeopleQuery): Promise<CatalogPeoplePage>;
  upsertPerson(input: PersonInput): Promise<PersonUpsertResult>;
}

const CatalogContext = createContext<CatalogClient | null>(null);

export interface CatalogProviderProps {
  transport: CatalogTransport;
  /**
   * Where the host mounted the pipeline endpoints, relative to whatever base the
   * transport prepends.
   *
   * A prop rather than a constant because, unlike `/catalog`, these are not
   * paths this library serves — see `routes.ts` for the full argument. The
   * default matches the shape the shipped screens document, so a host following
   * the README passes nothing.
   */
  pipelineBasePath?: string;
  /** Same, for the access endpoints. */
  accessBasePath?: string;
  children: ReactNode;
}

export function CatalogProvider({
  transport,
  pipelineBasePath = DEFAULT_PIPELINE_BASE_PATH,
  accessBasePath = DEFAULT_ACCESS_BASE_PATH,
  children,
}: CatalogProviderProps) {
  const client = useMemo<CatalogClient>(() => {
    const pipeline = pipelineRoutes(pipelineBasePath);
    const access = accessRoutes(accessBasePath);

    return {
      snapshot: () => transport.get<CatalogSnapshot>(catalogRoutes.snapshot()),
      objects: (type, params) =>
        transport.get<CatalogObjectPage>(catalogRoutes.objects(type), {
          ...params,
        }),
      patchType: (name, patch) => transport.patch(catalogRoutes.type(name), patch),
      patchProperty: (name, property, patch) =>
        transport.patch(catalogRoutes.property(name, property), patch),
      reset: () => transport.post<CatalogSnapshot>(catalogRoutes.reset()),
      queryRelations: () => transport.get<CatalogQueryRelation[]>(catalogRoutes.queryRelations()),
      runQuery: (input) => transport.post<CatalogQueryResult>(catalogRoutes.query(), input),

      workspaceCapabilities: () => transport.get(catalogRoutes.workspaceCapabilities()),
      listSavedQueries: () => transport.get(catalogRoutes.savedQueries()),
      saveQuery: (input) => transport.post<SavedQuery>(catalogRoutes.savedQueries(), input),
      updateSavedQuery: (id, input) =>
        transport.patch<SavedQuery>(catalogRoutes.savedQuery(id), input),
      deleteSavedQuery: (id) =>
        transport.delete<{ deleted: boolean }>(catalogRoutes.savedQuery(id)),
      runSavedQuery: (id) => transport.post(catalogRoutes.runSavedQuery(id), {}),
      // A URL rather than a fetch: an export the browser downloads itself can
      // be a link, and a link can be copied, bookmarked or scheduled.
      exportUrl: (id) => `/api${catalogRoutes.exportSavedQuery(id)}`,

      listDashboards: () => transport.get(catalogRoutes.dashboards()),
      saveDashboard: (input) => transport.post<Dashboard>(catalogRoutes.dashboards(), input),
      updateDashboard: (id, input) =>
        transport.patch<Dashboard>(catalogRoutes.dashboard(id), input),
      deleteDashboard: (id) => transport.delete<{ deleted: boolean }>(catalogRoutes.dashboard(id)),

      listEvents: (query) => transport.get(catalogRoutes.events(), { ...query }),
      listTraces: (query) => transport.get(catalogRoutes.traces(), { ...query }),

      pipelineCapabilities: () => transport.get(pipeline.capabilities()),

      listConnections: () => transport.get(pipeline.connections()),
      saveConnection: (input) => transport.post<CatalogConnection>(pipeline.connections(), input),
      checkConnection: (id) => transport.post<ConnectionCheck>(pipeline.checkConnection(id), {}),
      connectionConnectors: (id) => transport.get(pipeline.connectionConnectors(id)),
      deleteConnection: (id) => transport.delete<{ deleted: boolean }>(pipeline.connection(id)),

      listConnectors: () => transport.get(pipeline.connectors()),
      saveConnector: (input) => transport.post<CatalogConnector>(pipeline.connectors(), input),
      deleteConnector: (id) => transport.delete<{ deleted: boolean }>(pipeline.connector(id)),
      runConnector: (id) => transport.post<ConnectorRun>(pipeline.runConnector(id), {}),
      // The parameter is omitted rather than sent empty when no connector is
      // named, because a transport that serialises `connector=` turns "every
      // run" into "runs of the connector whose id is the empty string", which
      // is an empty list that looks like a system that has never run anything.
      listRuns: (connectorId) =>
        transport.get(pipeline.runs(), connectorId ? { connector: connectorId } : undefined),

      listTransforms: () => transport.get(pipeline.transforms()),
      saveTransform: (input) => transport.post<CatalogTransform>(pipeline.transforms(), input),
      deleteTransform: (id) => transport.delete<{ deleted: boolean }>(pipeline.transform(id)),
      tryTransform: (input) => transport.post<TransformResult>(pipeline.tryTransform(), input),

      listWorkflows: () => transport.get(pipeline.workflows()),
      saveWorkflow: (input) => transport.post<CatalogWorkflow>(pipeline.workflows(), input),
      deleteWorkflow: (id) => transport.delete<{ deleted: boolean }>(pipeline.workflow(id)),
      runWorkflow: (id) => transport.post<WorkflowRun>(pipeline.runWorkflow(id), {}),

      listPrincipals: () => transport.get(access.principals()),
      listPeople: (query) => transport.get(access.people(query)),
      upsertPerson: (input) => transport.post<PersonUpsertResult>(access.people(), input),
    };
  }, [transport, pipelineBasePath, accessBasePath]);

  return <CatalogContext.Provider value={client}>{children}</CatalogContext.Provider>;
}

export function useCatalogClient(): CatalogClient {
  const client = useContext(CatalogContext);
  if (!client) {
    throw new Error('Catalog screens must be rendered inside <CatalogProvider transport={...}>.');
  }
  return client;
}

/** Query keys, exported so a host can invalidate them from its own code. */
export const catalogQueryKeys = {
  all: ['nestjs-catalog'] as const,
  snapshot: ['nestjs-catalog', 'snapshot'] as const,
  objects: (type: string, params: ObjectQueryParams) =>
    ['nestjs-catalog', 'objects', type, params] as const,

  /**
   * The pipeline keys are nested under one prefix so a host — or a screen that
   * just ran a connector — can invalidate the whole of it at once. Running a
   * connector changes the runs, the connector's own last-run fields, and the
   * catalog snapshot the load wrote into, and invalidating them one by one is
   * how a list ends up showing a run that finished next to a connector that
   * still says it never has.
   */
  pipeline: ['nestjs-catalog', 'pipeline'] as const,
  capabilities: ['nestjs-catalog', 'pipeline', 'capabilities'] as const,
  connections: ['nestjs-catalog', 'pipeline', 'connections'] as const,
  connectors: ['nestjs-catalog', 'pipeline', 'connectors'] as const,
  transforms: ['nestjs-catalog', 'pipeline', 'transforms'] as const,
  runs: (connectorId?: string) =>
    ['nestjs-catalog', 'pipeline', 'runs', connectorId ?? 'all'] as const,
  workflows: ['nestjs-catalog', 'pipeline', 'workflows'] as const,

  access: ['nestjs-catalog', 'access'] as const,
  principals: ['nestjs-catalog', 'access', 'principals'] as const,
  people: ['nestjs-catalog', 'access', 'people'] as const,
};
