/**
 * The paths behind the pipeline and access screens — and, for now, the embed
 * components, which are the documented exception at the top of the file.
 *
 * Most of these deliberately do **not** live in
 * `@dudousxd/nestjs-catalog/client` beside `catalogRoutes`, and the difference
 * is worth being precise about, because it is the difference between a route
 * builder that is a promise and one that is a default.
 *
 * `catalogRoutes` is a frozen object of builders that take no base path: the
 * paths the catalog library's own controller serves, at the segment it serves
 * them under. Install the library, register the module, and
 * `/catalog/objects/...` exists — the builder is the library documenting itself.
 *
 * Connectors, transforms and access are the other shape, and what makes them so
 * is not that nothing serves them. It is that WHERE they are served is the
 * host's decision, which a frozen builder cannot express:
 *
 * - Connectors, transforms, workflows and runs are served by
 *   `createPipelineController`, which ships in
 *   `@dudousxd/nestjs-catalog-pipeline` — a *separate* package, mounted under
 *   whatever `path` its `forRoot` was given, and mounted nowhere at all if it
 *   was given none. Installing `@dudousxd/nestjs-catalog` does not make
 *   `/pipeline/connectors` answer, so putting `pipelineRoutes` beside
 *   `catalogRoutes` would tell a reader it does, and they would get a 404 with
 *   nothing to point at.
 * - Access is the one that used to be described here as having no controller
 *   either, and it does have one: `createAccessController` is in the catalog
 *   library and `CatalogModule.forRoot` mounts it unless the host passes
 *   `controller: false`. What it does not have is a fixed path — it mounts
 *   under `accessPath`, a sibling of the catalog's own mount point — so it is
 *   still a default rather than a promise, for the second reason rather than
 *   the first.
 *
 * So the builders live here, in the package that ships the screens that need
 * them, and are stated as a *default* the host can move. The defaults are
 * relative in the same way `catalogRoutes` is — `/pipeline`, not
 * `/api/pipeline` — because the transport is what knows the API prefix, and a
 * screen that hardcoded one app's mount point would be unusable in the next app.
 *
 * The two load-expectation paths are the case that says what the rule above
 * really is. They are served by that same pipeline controller in that same
 * separate package, yet their builder — `pipelineExpectationRoutes` — is in
 * `@dudousxd/nestjs-catalog/client`, and `pipelineRoutes` below borrows it
 * instead of writing the strings again. That is not an exception, because the
 * test was never which package a builder lives in: it is whether the builder
 * takes a base path. `pipelineExpectationRoutes` does, so it promises nothing
 * about where the routes are mounted no matter where it sits. It sits there
 * because the wire types it goes with — `LoadExpectationInput`,
 * `ResolvedLoadExpectation` — are declared in that entry point and the pipeline
 * controller reads them from there too, and a path split from the shapes it
 * returns is how the two halves of one contract come to be moved separately.
 *
 * What this package therefore asks of a host is an HTTP surface with these
 * shapes, wherever it wants to mount it. That contract is the response types on
 * `CatalogClient` plus these paths, and a host that would rather satisfy it from
 * somewhere else entirely can pass its own base path, or replace the client.
 */

import { pipelineExpectationRoutes } from '@dudousxd/nestjs-catalog/client';

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

/*
 * A saved query's history is deliberately NOT here.
 *
 * `GET /catalog/saved-queries/:id/revisions` is served by the catalog library's
 * own controller, so by this file's header it belongs beside `catalogRoutes` —
 * and that is where it is: `catalogRoutes.savedQueryRevisions`. The note is here
 * because a reader looking for the pair of it will find `transformRevisions` on
 * `PipelineRoutes` below and reasonably wonder where the other half went. The
 * split is the whole argument of this file: transforms are served by the host
 * and move with the base path it chose; saved queries are served by the library
 * and cannot move at all.
 *
 * A plain comment rather than a docblock on purpose — there is no declaration
 * here for it to belong to, and a `/**` would attach itself to the constant
 * below and describe the wrong thing in every editor tooltip.
 */

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
  /**
   * What a call node could be pointed at: every workflow the live fleet
   * announces it can execute.
   *
   * Beside `capabilities` and NOT part of it, because the two have opposite
   * lifetimes. Capabilities report what resolved in the server process and
   * cannot change without a redeploy; this is a snapshot of live workers with a
   * resolution of about one heartbeat. A screen caching the second the way it
   * caches the first would show the fleet as it was when the tab opened.
   */
  callableWorkflows(): string;
  connections(): string;
  connection(id: string): string;
  checkConnection(id: string): string;
  /**
   * Reach a connection that has not been saved yet.
   *
   * A sibling of {@link PipelineRoutes.checkConnection} and not the same route
   * with an absent id, because the two ask for different scopes and the
   * difference is the point: checking a SAVED connection reaches an address
   * somebody with `catalog:write` already chose and wrote down, so it asks only
   * `catalog:read`; this one reaches an address supplied in the request, which
   * under `catalog:read` would be a port scanner for anybody who may look at the
   * catalog. It therefore asks `catalog:write`.
   *
   * The server declares its handler BEFORE `connections/:id/check`, because Nest
   * matches in declaration order and `:id` captures the literal "check" happily.
   * Nothing on this side can enforce that, and it is written down here because a
   * console that gets a 404 from this path is most likely talking to a server
   * where the two were reordered — which reads like a missing feature rather
   * than like a routing bug.
   */
  checkUnsavedConnection(): string;
  /**
   * Which pipelines read through a connection. Named, so a refusal can say.
   *
   * `.../connectors` before, and the rename is the question actually being
   * asked rather than a tidy-up: an operator presses this before deleting a
   * connection, and what they need is the list of things that would break —
   * which is a list of workflows, because a workflow is the only thing anybody
   * authors and a connector's name is an implementation detail of one.
   */
  connectionWorkflows(id: string): string;
  /**
   * The internal records, read-only.
   *
   * **The one connector path left, and it is a `GET`.** There is no `POST`, no
   * `DELETE` and no `.../run`: a connector is what a published workflow runs
   * as, minted by `workflows/:id/publish` and removed with the graph. A builder
   * for a route that creates one would be this package advertising a second way
   * to author a pipeline, which is the thing that was removed.
   *
   * It stays because it answers what a graph cannot answer about itself — which
   * id the run history and the incremental watermark are keyed on.
   */
  connectors(): string;
  runs(): string;
  transforms(): string;
  transform(id: string): string;
  /**
   * Every version of a transform's code that was ever saved, newest first.
   *
   * A sub-resource of the transform rather than a `?version=` on it, because the
   * question this answers is "what were all of them" — a screen comparing the
   * version that ran against the version that is current has to see the list
   * before it knows which two ids to name, and one request that answers that is
   * cheaper than a list request plus two fetches.
   *
   * `CatalogTransform.version` is a counter over a row that is overwritten in
   * place, so before this route existed the number on a run — `code v3` in the
   * runs list — named code that no longer existed anywhere. The version stayed
   * traceable and the code did not.
   */
  transformRevisions(id: string): string;
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
  /**
   * Declare a graph finished, which is also what mints the connector it runs
   * as. Its own path rather than a field on the save, because publishing is a
   * claim that gets checked and a check that fails owes an explanation.
   */
  publishWorkflow(id: string): string;
  /** Back to draft. The connector keeps its id and its history, and stops. */
  unpublishWorkflow(id: string): string;
  /**
   * Run it now. **The only run path there is** — `connectors/:id/run` is gone,
   * and what it carried that this did not is `expectShrink`, which moved onto
   * this one's body rather than being lost with it.
   */
  runWorkflow(id: string): string;
  /**
   * When this graph runs, and whether it runs at all.
   *
   * A `PUT` of its own rather than fields on the save: a canvas autosaves, and
   * a cron folded into every save a drag passes through is one a stale tab can
   * silently revert.
   */
  workflowSchedule(id: string): string;
  /**
   * What the system behind one source node looks like right now. Writes nothing.
   *
   * `connectors/:id/discover` before. It had to move rather than be dropped —
   * discovery is how a type gets its shape, and a sink cannot commit into a
   * type that does not exist — and it deliberately answers on a **draft**:
   * requiring a published graph would require publishing a graph whose target
   * type cannot be created until it is published.
   *
   * Per node, not per graph, because a graph may have several sources and only
   * a source has a shape to report.
   */
  discoverSourceSchema(id: string, nodeId: string): string;
  /**
   * Every per-type load expectation an operator has stored.
   *
   * Keyed by object type and nothing else. A connector, a workflow sink and an
   * application POSTing to the publish API all end at the same publish methods
   * and all have the same delete problem, so a per-connector route would have
   * given one dataset two answers to one question.
   */
  loadExpectations(): string;
  /**
   * One type's expectation. GET resolves it and says where each field came
   * from; PUT stores one; DELETE drops the stored row and leaves the host's.
   *
   * The GET answers a merge rather than the stored row, because the stored row
   * alone cannot tell a screen whether it is the one in force — a host that
   * declared the same type in code wins, and a screen that showed the stored
   * value would offer an edit that is refused.
   */
  loadExpectation(typeName: string): string;
}

export function pipelineRoutes(basePath: string = DEFAULT_PIPELINE_BASE_PATH): PipelineRoutes {
  const base = normalise(basePath);
  // The two expectation paths are BORROWED rather than written out again — two
  // copies of a path is how a route ends up moved on one side and 404ing on the
  // other. The header's load-expectation paragraph is why the copy that wins
  // lives in `@dudousxd/nestjs-catalog/client` while everything else here is
  // built in place.
  const expectations = pipelineExpectationRoutes(base);
  return {
    capabilities: () => `${base}/capabilities`,
    callableWorkflows: () => `${base}/callable-workflows`,
    connections: () => `${base}/connections`,
    connection: (id) => `${base}/connections/${encodeURIComponent(id)}`,
    checkConnection: (id) => `${base}/connections/${encodeURIComponent(id)}/check`,
    checkUnsavedConnection: () => `${base}/connections/check`,
    connectionWorkflows: (id) => `${base}/connections/${encodeURIComponent(id)}/workflows`,
    connectors: () => `${base}/connectors`,
    runs: () => `${base}/runs`,
    transforms: () => `${base}/transforms`,
    transform: (id) => `${base}/transforms/${encodeURIComponent(id)}`,
    transformRevisions: (id) => `${base}/transforms/${encodeURIComponent(id)}/revisions`,
    tryTransform: () => `${base}/transforms/try`,
    workflows: () => `${base}/workflows`,
    workflow: (id) => `${base}/workflows/${encodeURIComponent(id)}`,
    publishWorkflow: (id) => `${base}/workflows/${encodeURIComponent(id)}/publish`,
    unpublishWorkflow: (id) => `${base}/workflows/${encodeURIComponent(id)}/unpublish`,
    runWorkflow: (id) => `${base}/workflows/${encodeURIComponent(id)}/run`,
    workflowSchedule: (id) => `${base}/workflows/${encodeURIComponent(id)}/schedule`,
    discoverSourceSchema: (id, nodeId) =>
      `${base}/workflows/${encodeURIComponent(id)}/nodes/${encodeURIComponent(nodeId)}/discover`,
    loadExpectations: () => expectations.expectations(),
    loadExpectation: (typeName) => expectations.expectation(typeName),
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
