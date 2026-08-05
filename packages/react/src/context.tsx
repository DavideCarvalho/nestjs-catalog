import type {
  CatalogAuditEvent,
  CatalogConnection,
  CatalogConnector,
  CatalogObjectPage,
  CatalogQueryRelation,
  CatalogQueryResult,
  CatalogRevision,
  CatalogSearchResult,
  CatalogSnapshot,
  CatalogTraceList,
  CatalogTransform,
  ConnectionCheck,
  ConnectorRun,
  Dashboard,
  DashboardCard,
  DeleteReconciliation,
  LoadExpectation,
  LoadExpectationInput,
  ObjectQueryParams,
  PropertyPatch,
  ResolvedLoadExpectation,
  RowCountBound,
  SaveQueryInput,
  SavedQuery,
  SnapshotRef,
  StoredLoadExpectation,
  TraceQuery,
  TransformLanguage,
  TransformResult,
  TypePatch,
} from '@dudousxd/nestjs-catalog/client';
import { catalogRoutes } from '@dudousxd/nestjs-catalog/client';
import { type ReactNode, createContext, useContext, useMemo } from 'react';
import type { EmbeddedChartPayload, EmbeddedDashboardPayload } from './embed/payload';
import {
  DEFAULT_ACCESS_BASE_PATH,
  DEFAULT_PIPELINE_BASE_PATH,
  DEFAULT_PUBLISH_BASE_PATH,
  type PeopleQuery,
  accessRoutes,
  embedRoutes,
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
  /**
   * Where this transport would send `path`, as a URL a browser can navigate to.
   *
   * The one thing a `Promise`-returning method cannot express. An export is a
   * GET that streams a file: the browser downloads it without this library
   * touching the response, which is what lets the control be a link that can be
   * copied, bookmarked or handed to a download manager. `exportUrl` is the only
   * caller.
   *
   * It exists because `exportUrl` used to answer `/api${path}` — the single
   * hardcoded mount point in a package whose whole argument (see `routes.ts`,
   * which makes it verbatim) is that the transport is the only thing that knows
   * where the API lives. Worse, the component it broke first is the embedded
   * chart, which by definition runs inside an application that mounted this
   * catalog wherever it liked.
   *
   * Optional so an existing transport keeps compiling, and a transport that
   * does not answer gets the path exactly as written — right only where the API
   * is served from the root. Implement it if your transport prepends anything
   * at all; it is the same concatenation the four methods above already do, and
   * the console's own does it in one line.
   */
  url?(path: string): string;
  /**
   * `PUT`, for the one route that has to be one.
   *
   * Optional for the same reason `url` is: a transport written before this
   * existed keeps compiling. Publishing a type is an idempotent upsert of the
   * whole shape — the same body twice is the same result — and the publish
   * route says so with its method. Adding a `POST` alias to spare this
   * three-line addition would have put a second name on one act, and the two
   * would eventually mean different things.
   *
   * A client that needs it and does not find it refuses by name rather than
   * silently doing nothing, because a "Create type" button that returns without
   * creating a type is the failure this whole panel exists to prevent.
   */
  put?<T>(path: string, body: unknown): Promise<T>;
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
 * What a load has to be true of before it becomes the data everybody reads.
 *
 * RE-EXPORTED rather than mirrored, and the distinction is the same one
 * {@link CatalogRevision} above turns on: {@link PipelineCapabilities} is
 * mirrored because naming it would mean importing
 * `@dudousxd/nestjs-catalog-pipeline`, a package built for a Node process with
 * database drivers behind optional imports. These shapes have no such problem —
 * they are plain declarations on `@dudousxd/nestjs-catalog/client`, the entry
 * point that exists precisely so a browser can name the catalog's own
 * contracts, and a second copy here is what would drift.
 *
 * Named from this module at all, rather than left for a host to import from the
 * other package, for the reason the whole of this file is: everything else this
 * client returns is reachable from here, and typing a variable should not
 * require knowing which of the two packages declares which shape.
 *
 * The enforcement functions are deliberately NOT reachable from a browser.
 * They decide whether a load commits, they live in the pipeline package, and a
 * console running its own copy would be a second answer to a question with one.
 */
export type {
  DeleteReconciliation,
  LoadExpectation,
  LoadExpectationInput,
  ResolvedLoadExpectation,
  RowCountBound,
  StoredLoadExpectation,
};

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

/**
 * One saved version of the two things in this catalog whose text a person edits.
 *
 * RE-EXPORTED rather than mirrored, unlike `PipelineCapabilities` above. The
 * distinction is worth keeping straight: `PipelineCapabilities` is mirrored
 * because importing it would mean importing `@dudousxd/nestjs-catalog-pipeline`,
 * a package built for a Node process with database drivers behind optional
 * imports, into a browser bundle. `CatalogRevision` has no such problem — it is
 * a plain shape on `@dudousxd/nestjs-catalog/client`, the entry point that
 * exists precisely so a browser can name the catalog's own contracts, and
 * restating it here would be the second copy of something two packages already
 * serve.
 *
 * Named here at all, rather than left for callers to import from the client
 * package, because everything else this file's `CatalogClient` returns is
 * reachable from this module and a host should not have to know which of the two
 * packages owns which shape to type a variable.
 */
export type { CatalogRevision };

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
  /**
   * Every load of one type, newest first. Empty on a store that keeps no
   * history, which is what makes the snapshot picker able to hide itself rather
   * than offer a control that cannot work.
   *
   * A separate call from {@link objects} rather than a field on the page: the
   * list changes once a load, and the page is refetched on every keystroke,
   * every sort and every page turn. Carried on the page it would be a query per
   * one of those.
   */
  snapshots(type: string): Promise<SnapshotRef[]>;
  patchType(name: string, patch: TypePatch): Promise<unknown>;
  patchProperty(name: string, property: string, patch: PropertyPatch): Promise<unknown>;
  reset(): Promise<CatalogSnapshot>;
  queryRelations(): Promise<CatalogQueryRelation[]>;
  runQuery(input: { sql: string; maxRows?: number }): Promise<CatalogQueryResult>;

  /**
   * One term across object types, properties, saved queries and dashboards.
   *
   * One call rather than four, and the ranking is the server's. A client that
   * merged four lists would own the order across kinds, which means the order
   * would live in whichever screen was written last — see the block above
   * `CatalogService.search`, which makes the argument where the code is.
   *
   * `limit` is the caller's request and the server's decision: it caps whatever
   * is asked for, and the answer carries `total` and `truncated` so a screen can
   * say "50 of 312" rather than implying the list it drew is the list.
   */
  search(term: string, limit?: number): Promise<CatalogSearchResult>;

  workspaceCapabilities(): Promise<{ workspace: boolean; query: boolean }>;
  listSavedQueries(): Promise<SavedQuery[]>;
  saveQuery(input: SaveQueryInput): Promise<SavedQuery>;
  updateSavedQuery(id: string, input: Partial<SaveQueryInput>): Promise<SavedQuery>;
  deleteSavedQuery(id: string): Promise<{ deleted: boolean }>;
  runSavedQuery(id: string): Promise<{ savedQuery: SavedQuery; result: CatalogQueryResult }>;
  exportUrl(id: string): string;
  /**
   * Every SQL this saved query has ever been, newest first.
   *
   * Beside {@link listTransformRevisions} rather than one polymorphic
   * `listRevisions(kind, id)`, because the two are served by different things:
   * a saved query is the catalog library's own resource and a transform is the
   * host's. One method taking a kind would hide that a host can move one of the
   * two endpoints and not the other, which is exactly the mistake `routes.ts`
   * spends its header preventing.
   *
   * An EMPTY list is a real answer and not an error. Every saved query written
   * before revisions existed has no history, and whether the store backfills a
   * first revision from the current SQL is a decision belonging to the store.
   * The screen has to read "nothing recorded" as "nothing recorded" — never as
   * "nothing has changed".
   */
  listSavedQueryRevisions(id: string): Promise<CatalogRevision[]>;

  listDashboards(): Promise<Dashboard[]>;
  /**
   * `shared` is declared on both writes, and it is not decoration.
   *
   * The server's `patchDashboard` says why one layer down: a field a body type
   * does not name is a field a host's whitelisting `ValidationPipe` deletes, so
   * the write appears to succeed and the flag never moves. This type dropped it
   * again — and a field a CLIENT type does not name cannot even be passed, so
   * the failure arrives earlier and reads as a compile error in the one screen
   * that would have set it.
   *
   * What that cost: `shared` is the entire access boundary of the embed API, so
   * every dashboard a shipped console produced was un-embeddable, `embedDashboard`
   * answered `403` for all of them, and `<EmbeddedDashboard>`'s "Nothing on this
   * dashboard has been shared" was not an empty state but the only state.
   *
   * On `saveDashboard` too, although the console's create form does not offer
   * it — a board is created empty and there is nothing yet to share. The field
   * is here because the route accepts it and a host driving this client
   * directly should not have to discover that the two writes disagree.
   */
  saveDashboard(input: {
    name: string;
    description?: string;
    shared?: boolean;
  }): Promise<Dashboard>;
  updateDashboard(
    id: string,
    input: Partial<{
      name: string;
      description: string;
      cards: DashboardCard[];
      shared: boolean;
    }>,
  ): Promise<Dashboard>;
  deleteDashboard(id: string): Promise<{ deleted: boolean }>;

  /**
   * What another application may render.
   *
   * Reads only, and rendered rather than executable: a chart comes back as
   * columns and rows with a visualization, never as SQL, so an embed cannot ask
   * for anything the sharer did not already share. Both refuse anything not
   * explicitly marked shared in the console, which is why there is no
   * `embedQuery(sql)` and never will be.
   *
   * `exportUrl` above is what an embedded chart's CSV action links to — the
   * same export the console uses, because it is the same saved query, and
   * resolved through the transport so it points at wherever the HOST mounted
   * this catalog rather than at wherever the console happens to live.
   */
  embedChart(id: string): Promise<EmbeddedChartPayload>;
  embedDashboard(id: string): Promise<EmbeddedDashboardPayload>;

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
  /**
   * What the source behind a connector looks like right now. Writes nothing.
   *
   * Typed loosely on purpose. The shape comes from
   * `@dudousxd/nestjs-catalog-pipeline`, and this package must not import that
   * one — it would drag a package built for a Node process, with database
   * drivers behind optional imports, into a browser bundle. `PipelineCapabilities`
   * above is mirrored for exactly the same reason.
   */
  discoverConnectorSchema(id: string): Promise<unknown>;
  /**
   * Publish an object type's schema — create it, or update the shape of one
   * that exists.
   *
   * The only write on this client that does not go through the catalog's own
   * routes: publishing is how a type comes into existence at all, and there is
   * deliberately no `POST /catalog/types`, because structure follows a
   * publisher and curation follows a person.
   *
   * Refuses by name when the transport cannot `PUT`, rather than resolving
   * having done nothing.
   */
  publishType(name: string, schema: unknown): Promise<unknown>;
  listRuns(connectorId?: string): Promise<ConnectorRun[]>;

  /**
   * What one type promises about deletes and row counts, resolved.
   *
   * Per type and never per connector: the three ways rows arrive — a
   * connector, a workflow sink, an application POSTing to the publish API —
   * end at the same two publish methods, so a per-connector answer would cover
   * one of the three and leave one dataset with two answers to one question.
   */
  loadExpectation(typeName: string): Promise<ResolvedLoadExpectation>;
  /**
   * Store one, or replace what is stored.
   *
   * The answer is typed `unknown` and callers are expected to refetch. That is
   * not laziness: what a screen has to show is the RESOLVED expectation, which
   * is a merge of this write with whatever the host declared in code, and the
   * merge is the server's to perform. A screen that wrote this response into
   * its cache would be claiming the stored row is the one in force, which is
   * exactly what {@link ResolvedLoadExpectation.hostLocked} exists to deny.
   *
   * Refuses by name when the transport cannot `PUT`, rather than resolving
   * having done nothing — see {@link CatalogTransport.put}.
   */
  setLoadExpectation(typeName: string, input: LoadExpectationInput): Promise<unknown>;
  /** Drop the stored row. Anything the host declared in code survives it. */
  clearLoadExpectation(typeName: string): Promise<unknown>;

  listTransforms(): Promise<CatalogTransform[]>;
  saveTransform(input: TransformInput): Promise<CatalogTransform>;
  deleteTransform(id: string): Promise<{ deleted: boolean }>;
  /**
   * Every version of this transform's code, newest first.
   *
   * The list rather than one version by number, because the screen that needs
   * this is comparing two of them and has to know which exist before it can pick
   * — including the case where the version a run recorded is NOT among them,
   * which is what a transform older than the revision store looks like and is a
   * thing the screen has to be able to say out loud.
   */
  listTransformRevisions(id: string): Promise<CatalogRevision[]>;
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
  /** Where `/publish` is mounted — a sibling of {@link pipelineBasePath}. */
  publishBasePath?: string;
  /** Same, for the access endpoints. */
  accessBasePath?: string;
  children: ReactNode;
}

export function CatalogProvider({
  transport,
  pipelineBasePath = DEFAULT_PIPELINE_BASE_PATH,
  publishBasePath = DEFAULT_PUBLISH_BASE_PATH,
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
      snapshots: (type) => transport.get<SnapshotRef[]>(catalogRoutes.snapshots(type)),
      patchType: (name, patch) => transport.patch(catalogRoutes.type(name), patch),
      patchProperty: (name, property, patch) =>
        transport.patch(catalogRoutes.property(name, property), patch),
      reset: () => transport.post<CatalogSnapshot>(catalogRoutes.reset()),
      queryRelations: () => transport.get<CatalogQueryRelation[]>(catalogRoutes.queryRelations()),
      runQuery: (input) => transport.post<CatalogQueryResult>(catalogRoutes.query(), input),
      // `limit` is omitted rather than sent undefined when nobody asked for
      // one, for the reason `listRuns` states below: a transport that
      // serialises `limit=` hands the server an empty string, and `Number('')`
      // is 0 — which the route would floor back to 1 and answer with a single
      // row that reads as "there is only one match".
      search: (term, limit) =>
        transport.get<CatalogSearchResult>(catalogRoutes.search(), {
          q: term,
          ...(limit === undefined ? {} : { limit }),
        }),

      workspaceCapabilities: () => transport.get(catalogRoutes.workspaceCapabilities()),
      listSavedQueries: () => transport.get(catalogRoutes.savedQueries()),
      saveQuery: (input) => transport.post<SavedQuery>(catalogRoutes.savedQueries(), input),
      updateSavedQuery: (id, input) =>
        transport.patch<SavedQuery>(catalogRoutes.savedQuery(id), input),
      deleteSavedQuery: (id) =>
        transport.delete<{ deleted: boolean }>(catalogRoutes.savedQuery(id)),
      runSavedQuery: (id) => transport.post(catalogRoutes.runSavedQuery(id), {}),
      listSavedQueryRevisions: (id) => transport.get(catalogRoutes.savedQueryRevisions(id)),
      // A URL rather than a fetch: an export the browser downloads itself can
      // be a link, and a link can be copied, bookmarked or scheduled. Where
      // that link points is the transport's answer, exactly like every other
      // request this client makes — see `CatalogTransport.url` for what this
      // hardcoded `/api` used to cost.
      exportUrl: (id) => {
        const path = catalogRoutes.exportSavedQuery(id);
        return transport.url ? transport.url(path) : path;
      },

      listDashboards: () => transport.get(catalogRoutes.dashboards()),
      saveDashboard: (input) => transport.post<Dashboard>(catalogRoutes.dashboards(), input),
      updateDashboard: (id, input) =>
        transport.patch<Dashboard>(catalogRoutes.dashboard(id), input),
      deleteDashboard: (id) => transport.delete<{ deleted: boolean }>(catalogRoutes.dashboard(id)),

      embedChart: (id) => transport.get<EmbeddedChartPayload>(embedRoutes.chart(id)),
      embedDashboard: (id) => transport.get<EmbeddedDashboardPayload>(embedRoutes.dashboard(id)),

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
      discoverConnectorSchema: (id) =>
        transport.post<unknown>(pipeline.discoverConnectorSchema(id), {}),
      publishType: (name, schema) => {
        if (!transport.put) {
          throw new Error(
            'This transport cannot PUT, so it cannot publish a type. Implement `put` on the ' +
              'transport you passed to CatalogProvider — publishing is an idempotent upsert of ' +
              'the whole shape, which is why the route is a PUT and not a POST.',
          );
        }
        return transport.put<unknown>(
          `${publishBasePath}/${encodeURIComponent(name)}/schema`,
          schema,
        );
      },
      // The parameter is omitted rather than sent empty when no connector is
      // named, because a transport that serialises `connector=` turns "every
      // run" into "runs of the connector whose id is the empty string", which
      // is an empty list that looks like a system that has never run anything.
      listRuns: (connectorId) =>
        transport.get(pipeline.runs(), connectorId ? { connector: connectorId } : undefined),

      loadExpectation: (typeName) =>
        transport.get<ResolvedLoadExpectation>(pipeline.loadExpectation(typeName)),
      setLoadExpectation: (typeName, input) => {
        if (!transport.put) {
          throw new Error(
            'This transport cannot PUT, so it cannot store a load expectation. Implement `put` ' +
              'on the transport you passed to CatalogProvider — storing one is an idempotent ' +
              'upsert of the whole per-type row, which is why the route is a PUT and not a POST.',
          );
        }
        return transport.put<unknown>(pipeline.loadExpectation(typeName), input);
      },
      clearLoadExpectation: (typeName) =>
        transport.delete<unknown>(pipeline.loadExpectation(typeName)),

      listTransforms: () => transport.get(pipeline.transforms()),
      saveTransform: (input) => transport.post<CatalogTransform>(pipeline.transforms(), input),
      deleteTransform: (id) => transport.delete<{ deleted: boolean }>(pipeline.transform(id)),
      listTransformRevisions: (id) => transport.get(pipeline.transformRevisions(id)),
      tryTransform: (input) => transport.post<TransformResult>(pipeline.tryTransform(), input),

      listWorkflows: () => transport.get(pipeline.workflows()),
      saveWorkflow: (input) => transport.post<CatalogWorkflow>(pipeline.workflows(), input),
      deleteWorkflow: (id) => transport.delete<{ deleted: boolean }>(pipeline.workflow(id)),
      runWorkflow: (id) => transport.post<WorkflowRun>(pipeline.runWorkflow(id), {}),

      listPrincipals: () => transport.get(access.principals()),
      listPeople: (query) => transport.get(access.people(query)),
      upsertPerson: (input) => transport.post<PersonUpsertResult>(access.people(), input),
    };
  }, [transport, pipelineBasePath, publishBasePath, accessBasePath]);

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
   * A type's loads, keyed by type and NOT by the read's parameters.
   *
   * The list is a property of the type, so paging, sorting and filtering must
   * not re-ask for it — keyed under `objects(type, params)` it would be fetched
   * again on every keystroke of a search box.
   */
  objectSnapshots: (type: string) => ['nestjs-catalog', 'objects', type, 'snapshots'] as const,

  /**
   * Keyed on the term, so react-query caches per term and a backspace shows the
   * previous answer instantly instead of re-asking.
   *
   * Deliberately NOT keyed on anything about the caller. The answer already
   * depends on who is asking — the route filters by principal — and a cache key
   * that did not say so would be a bug; it is safe here only because a browser
   * session is one principal, and a host that swaps identity in place without a
   * reload should invalidate `catalogQueryKeys.all`, which is what that prefix
   * is for.
   */
  search: (term: string, limit?: number) =>
    ['nestjs-catalog', 'search', term, limit ?? null] as const,

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
  /**
   * A transform's history, keyed UNDER `transforms` on purpose.
   *
   * `catalogQueryKeys.transforms` is a prefix of this, so the invalidation the
   * transform list already performs after a save reaches the history too — and
   * it must, because saving new code is precisely what cuts a revision. Keyed
   * anywhere else, the diff screen would keep showing yesterday's history beside
   * today's code, which is the one thing it exists not to do.
   */
  transformRevisions: (id: string) =>
    ['nestjs-catalog', 'pipeline', 'transforms', id, 'revisions'] as const,
  runs: (connectorId?: string) =>
    ['nestjs-catalog', 'pipeline', 'runs', connectorId ?? 'all'] as const,
  /**
   * One type's resolved load expectation.
   *
   * Under the `pipeline` prefix rather than beside `snapshot`, even though the
   * screen that reads it is the Model screen: the endpoint is served by the
   * host's pipeline controller, not by the catalog library, so a host
   * invalidating "everything the pipeline knows" has to reach this too. Keyed
   * per type because that is the grain of the answer.
   */
  loadExpectation: (typeName: string) =>
    ['nestjs-catalog', 'pipeline', 'expectations', typeName] as const,
  workflows: ['nestjs-catalog', 'pipeline', 'workflows'] as const,

  /**
   * The embed keys, under one prefix so a host can invalidate every embedded
   * chart on its page at once — which is the only refresh an embed has. The
   * components deliberately ship no refresh control of their own, so this is
   * the seam a host uses to decide when its own page reloads its data.
   */
  embed: ['nestjs-catalog', 'embed'] as const,
  embeddedChart: (id: string) => ['nestjs-catalog', 'embed', 'chart', id] as const,
  embeddedDashboard: (id: string) => ['nestjs-catalog', 'embed', 'dashboard', id] as const,

  access: ['nestjs-catalog', 'access'] as const,
  principals: ['nestjs-catalog', 'access', 'principals'] as const,
  people: ['nestjs-catalog', 'access', 'people'] as const,
};
