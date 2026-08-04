/**
 * The paths behind the pipeline and access screens — and, for now, the embed
 * components, which are the documented exception at the top of the file.
 *
 * These deliberately do **not** live in `@dudousxd/nestjs-catalog/client` beside
 * `catalogRoutes`, and the difference is worth being precise about, because it
 * is the difference between a route builder that is a promise and one that is a
 * guess.
 *
 * `catalogRoutes` describes paths the catalog library's own controller serves.
 * Install the library, register the module, and `/catalog/objects/...` exists —
 * the builder is the library documenting itself, and it cannot be wrong.
 *
 * Connectors, transforms and access are the other shape. The library defines
 * their *model* — `CatalogPipelineStore`, `CatalogConnection`, `CatalogPrincipal`
 * — but ships no controller for any of them, because how a deployment exposes
 * the code that reshapes its data, and who may create an account, are decisions
 * that belong to the deployment. Putting `pipelineRoutes` next to `catalogRoutes`
 * would tell a reader that installing the library makes `/pipeline/connectors`
 * answer, and it does not: they would get a 404 with nothing to point at.
 *
 * So the builders live here, in the package that ships the screens that need
 * them, and are stated as a *default* the host can move. The defaults are
 * relative in the same way `catalogRoutes` is — `/pipeline`, not
 * `/api/pipeline` — because the transport is what knows the API prefix, and a
 * screen that hardcoded one app's mount point would be unusable in the next app.
 *
 * What this package therefore asks of a host is an HTTP surface with these
 * shapes, wherever it wants to mount it. That contract is the response types on
 * `CatalogClient` plus these paths, and a host that would rather satisfy it from
 * somewhere else entirely can pass its own base path, or replace the client.
 */

/**
 * The embed API, which is the exception to everything above.
 *
 * These paths ARE served by the catalog library's own controller — `GET
 * embed`, `GET embed/charts/:id`, `GET embed/dashboards/:id`, behind
 * `catalog:embed` — so by the argument in this file's header they belong beside
 * `catalogRoutes` in `@dudousxd/nestjs-catalog/client`, and that is where they
 * should end up. They are here only because the embed components landed in this
 * package first; moving them is a one-line change in the server package and a
 * re-export here.
 *
 * Which is why they are a frozen object of builders, in `catalogRoutes`' style,
 * rather than a `f(basePath)` like `pipelineRoutes` below. The shape is a
 * statement about who owns the path: a host cannot move these anywhere the rest
 * of the catalog controller has not also moved, so offering a base path would
 * be offering a knob that cannot be turned independently.
 */
export const embedRoutes = {
  /** What this caller may embed. Discovery, so ids need not be passed out of band. */
  embeddable: () => '/catalog/embed',
  chart: (id: string) => `/catalog/embed/charts/${encodeURIComponent(id)}`,
  dashboard: (id: string) => `/catalog/embed/dashboards/${encodeURIComponent(id)}`,
} as const;

/** Where the pipeline endpoints sit unless the host says otherwise. */
export const DEFAULT_PIPELINE_BASE_PATH = '/pipeline';

/**
 * Where the publish endpoints sit unless the host says otherwise.
 *
 * A sibling of the pipeline's base, not a child, because that is how the
 * library mounts them: one `path` given to `CatalogPipelineModule.forRoot`
 * yields `<path>/pipeline` and `<path>/publish`. Its own constant rather than a
 * string derived from the other, because deriving would mean rewriting
 * `/pipeline` into `/publish` inside whatever the host passed — which is right
 * until the day a host passes a base that contains the word twice.
 */
export const DEFAULT_PUBLISH_BASE_PATH = '/publish';

/** Where the access endpoints sit unless the host says otherwise. */
export const DEFAULT_ACCESS_BASE_PATH = '/access';

/**
 * Trailing slashes are stripped rather than rejected.
 *
 * A host that writes `/api/pipeline/` is not making a mistake worth an
 * exception, but concatenating it would produce `/api/pipeline//connectors`,
 * which most routers treat as a different path and answer with a 404 nobody can
 * read from the browser's network tab.
 */
function normalise(basePath: string): string {
  return basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
}

export interface PipelineRoutes {
  capabilities(): string;
  connections(): string;
  connection(id: string): string;
  checkConnection(id: string): string;
  /** Which connectors read through a connection. Named, so a refusal can say. */
  connectionConnectors(id: string): string;
  connectors(): string;
  connector(id: string): string;
  runConnector(id: string): string;
  /**
   * What the source behind a connector looks like right now.
   *
   * A read that writes nothing: it runs the connector's own configured query
   * with no rows asked for, and reports the columns. Here rather than on a
   * generic "describe this database" route because the connector is what
   * already holds the address, the credential reference and the statement —
   * a route taking those as arguments would be a way to point the server at
   * any database at all.
   */
  discoverConnectorSchema(id: string): string;
  runs(): string;
  transforms(): string;
  transform(id: string): string;
  tryTransform(): string;
  /**
   * Authored graphs of transforms. GET lists, POST creates or updates.
   *
   * Under the same base as the rest of the pipeline rather than a base of their
   * own, because a workflow is made entirely of connectors and transforms that
   * are already served from here — a host that mounted the pipeline endpoints
   * behind one guard would otherwise have to remember a second mount point with
   * the same guard on it, and the one that forgets exposes the graph editor to
   * everybody.
   */
  workflows(): string;
  workflow(id: string): string;
  runWorkflow(id: string): string;
}

export function pipelineRoutes(basePath: string = DEFAULT_PIPELINE_BASE_PATH): PipelineRoutes {
  const base = normalise(basePath);
  return {
    capabilities: () => `${base}/capabilities`,
    connections: () => `${base}/connections`,
    connection: (id) => `${base}/connections/${encodeURIComponent(id)}`,
    checkConnection: (id) => `${base}/connections/${encodeURIComponent(id)}/check`,
    connectionConnectors: (id) => `${base}/connections/${encodeURIComponent(id)}/connectors`,
    connectors: () => `${base}/connectors`,
    connector: (id) => `${base}/connectors/${encodeURIComponent(id)}`,
    runConnector: (id) => `${base}/connectors/${encodeURIComponent(id)}/run`,
    discoverConnectorSchema: (id) => `${base}/connectors/${encodeURIComponent(id)}/discover`,
    runs: () => `${base}/runs`,
    transforms: () => `${base}/transforms`,
    transform: (id) => `${base}/transforms/${encodeURIComponent(id)}`,
    tryTransform: () => `${base}/transforms/try`,
    workflows: () => `${base}/workflows`,
    workflow: (id) => `${base}/workflows/${encodeURIComponent(id)}`,
    runWorkflow: (id) => `${base}/workflows/${encodeURIComponent(id)}/run`,
  };
}

export interface AccessRoutes {
  principals(): string;
  /**
   * GET lists people; POST creates or updates one.
   *
   * The GET is PAGED — a host's user table is its whole directory, and the
   * server caps whatever is asked for. Omitting the query is asking for the
   * server's default page, never for all of them.
   */
  people(query?: PeopleQuery): string;
}

export interface PeopleQuery {
  search?: string;
  limit?: number;
  offset?: number;
}

export function accessRoutes(basePath: string = DEFAULT_ACCESS_BASE_PATH): AccessRoutes {
  const base = normalise(basePath);
  return {
    principals: () => `${base}/principals`,
    people: (query) => {
      const params = new URLSearchParams();
      if (query?.search) params.set('search', query.search);
      if (query?.limit !== undefined) params.set('limit', String(query.limit));
      if (query?.offset !== undefined) params.set('offset', String(query.offset));
      const search = params.toString();
      return search ? `${base}/people?${search}` : `${base}/people`;
    },
  };
}
