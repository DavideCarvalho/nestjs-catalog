import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { emitCatalog } from './catalog.events';
import {
  type CatalogFilterOperator,
  offeredFilterOperators,
  resolveObjectFilters,
} from './catalog.filters';
import { CATALOG_OPTIONS, type CatalogModuleOptions } from './catalog.options';
import type { CatalogPrincipal } from './catalog.principal';
import {
  type CatalogQueryRelation,
  type CatalogQueryResult,
  assertReadOnlyShape,
  isQueryStore,
} from './catalog.query';
import { QueryCache } from './catalog.query-cache';
import { CatalogRegistry } from './catalog.registry.base';
import {
  CATALOG_STORE,
  type CatalogReadStore,
  type SnapshotRef,
  supportsObjectFilters,
} from './catalog.store';
import type {
  CatalogGraph,
  CatalogObjectPage,
  CatalogObjectQuery,
  CatalogObjectTypeDef,
  CatalogOverlay,
  CatalogSnapshot,
} from './catalog.types';
import {
  type AuditQuery,
  CATALOG_WORKSPACE_STORE,
  type CatalogAuditEvent,
  type CatalogWorkspaceStore,
  type Dashboard,
  type DashboardCard,
  type EmbeddedChart,
  type EmbeddedChartPlacement,
  type EmbeddedDashboard,
  type SaveQueryInput,
  type SavedQuery,
  embeddedVisualization,
} from './catalog.workspace';
import { emptySearch, maySearch, searchCatalog, visibleToPrincipal } from './search';
import type { CatalogSearchResult } from './search.types';

const DEFAULT_PAGE_SIZE = 25;
const DEFAULT_MAX_PAGE_SIZE = 200;

/**
 * Reads objects of any catalogued type through one endpoint.
 *
 * This layer owns the decisions that must hold no matter where the rows live:
 * which type names are real, which columns may be returned, how large a page
 * may be. The store below it only fetches. Keeping the guardrails here means a
 * new store cannot accidentally relax them — the appeal of a generic read
 * endpoint is also its whole risk.
 */
@Injectable()
export class CatalogService {
  constructor(
    private readonly registry: CatalogRegistry,
    @Inject(CATALOG_STORE) private readonly store: CatalogReadStore,
    @Inject(CATALOG_OPTIONS) private readonly options: CatalogModuleOptions,
    @Optional()
    @Inject(CATALOG_WORKSPACE_STORE)
    private readonly workspace?: CatalogWorkspaceStore,
  ) {}

  private readonly cache = new QueryCache();

  // ---------------------------------------------------------------------------
  // The facade.
  //
  // Everything the built-in controller does is reachable from this one class, by
  // class injection — no symbol to import, no second provider to remember. An
  // app that wants its own routes injects `CatalogService`, writes the
  // controller it wants, and passes `controller: false` so nothing is mounted
  // twice. The registry and the store stay available for anyone who needs them,
  // but nobody should have to reach for them to build an ordinary endpoint.
  // ---------------------------------------------------------------------------

  /** The whole model, as data. */
  getSnapshot(): CatalogSnapshot {
    return this.registry.getSnapshot();
  }

  getType(name: string): CatalogObjectTypeDef | undefined {
    return this.registry.getType(name);
  }

  /** Nodes and edges, for drawing the model. */
  getGraph(): CatalogGraph {
    return this.registry.getGraph();
  }

  /**
   * Presentation-only. Never a schema change.
   *
   * @param curatedBy who is doing it, for the audit trail — the same required
   * argument the sharing methods below take, and required for the same reason
   * `deleteSavedQuery` gives. This facade forwards it rather than resolving it:
   * a host writing its own controller has the request and this does not, and a
   * default here would attribute every such host's curation to nobody.
   */
  patchType(
    typeName: string,
    patch: Partial<CatalogOverlay['types'][string]>,
    curatedBy: string,
  ): Promise<CatalogObjectTypeDef | undefined> {
    return this.registry.patchType(typeName, patch, curatedBy);
  }

  /** @param curatedBy who is doing it, for the audit trail. */
  patchProperty(
    typeName: string,
    propertyName: string,
    patch: NonNullable<CatalogOverlay['types'][string]['properties']>[string],
    curatedBy: string,
  ): Promise<CatalogObjectTypeDef | undefined> {
    return this.registry.patchProperty(typeName, propertyName, patch, curatedBy);
  }

  /**
   * Drops every runtime edit, where the registry supports it.
   *
   * @param resetBy who is doing it. The one act here that destroys curation in
   * bulk, so it is the one whose actor is hardest to reconstruct afterwards —
   * nothing versions an overlay, and after this there is nothing left to read.
   */
  resetOverlay(resetBy: string): Promise<void> {
    return this.registry.resetOverlay(resetBy);
  }

  /** Columns a generic UI may render: visible, and not a blob. */
  visibleColumns(type: CatalogObjectTypeDef) {
    return type.properties.filter((p) => !p.hidden && p.type !== 'json');
  }

  /**
   * Rows of one type, paged.
   *
   * **No principal, and so no access control.** This applies the guardrails that
   * hold for every caller — the type exists, the page is bounded, the sort names
   * a real column — and none that depend on who is asking: a classified column
   * comes back to whoever the host's guard let through the door. That is the
   * library's declare-and-enforce split, written out at length above `mayWrite`
   * in `catalog.principal.ts`. A host that wants per-principal reads passes this
   * page through `readableObjectPage`.
   */
  async readObjects(
    typeName: string,
    query: CatalogObjectQuery & { snapshot?: string },
  ): Promise<CatalogObjectPage> {
    const type = this.registry.getType(typeName);
    if (!type) throw new NotFoundException(`Unknown object type: ${typeName}`);

    const maxPageSize = this.options.maxPageSize ?? DEFAULT_MAX_PAGE_SIZE;
    const size = Math.min(Math.max(Number(query.size) || DEFAULT_PAGE_SIZE, 1), maxPageSize);
    const page = Math.max(Number(query.page) || 1, 1);

    const columns = this.visibleColumns(type);
    if (columns.length === 0) {
      throw new BadRequestException(`Object type ${type.name} has no readable columns`);
    }

    // Always fetch the primary key: the UI needs a stable row identity even
    // when the key is hidden from display.
    const fields = Array.from(new Set([...type.primaryKey, ...columns.map((c) => c.name)]));

    // Asking for a snapshot a store cannot serve is a caller error, not
    // something to silently answer with current state — a reader who thinks
    // they are looking at last Tuesday and is not would rather be told.
    if (query.snapshot && !this.store.capabilities.timeTravel) {
      throw new BadRequestException(
        "This catalog's store keeps no history, so it cannot read a snapshot.",
      );
    }

    // Sort is validated here rather than in the store: an unrecognised column
    // must never reach a query builder, whatever the engine.
    const sort = columns.some((c) => c.name === query.sort) ? query.sort : undefined;

    // Filters, against the same `columns` a sort is checked against and for the
    // same reason — with one difference in what a failure means. An unrecognised
    // sort falls back to the primary key, because the rows are the same rows in a
    // different order. An unrecognised filter cannot fall back to anything: the
    // read would come back holding rows the caller asked to exclude, and neither
    // the caller nor the screen has any way to tell.
    const filters = this.resolveFilters(columns, query.filters ?? []);

    const result = await this.store.read(type, fields, {
      page,
      size,
      search: query.search,
      sort,
      dir: query.dir === 'desc' ? 'desc' : 'asc',
      snapshot: query.snapshot,
      ...(filters.length > 0 ? { filters } : {}),
    });
    const { rows, total } = result;

    const storeOperators = this.filterOperators();
    return {
      type: type.name,
      page,
      size,
      total,
      pages: Math.max(Math.ceil(total / size), 1),
      columns: columns.map((c) => ({
        name: c.name,
        displayName: c.displayName,
        type: c.type,
        classification: c.classification,
        unit: c.unit,
        columnName: c.columnName,
        // What this deployment will actually accept for this column: the rule
        // derived from the column, narrowed by what the mounted store can do.
        // Sent per column so a console needs no second request and no table of
        // its own — see `catalog.filters.ts` on why a hand-kept list is the
        // failure mode being avoided.
        filterOperators: offeredFilterOperators(c, storeOperators),
      })),
      rows,
      ...(result.snapshot ? { snapshot: result.snapshot } : {}),
    };
  }

  /** What the mounted store can push into a read predicate. Empty when it cannot. */
  private filterOperators(): readonly CatalogFilterOperator[] {
    return supportsObjectFilters(this.store) ? this.store.objectFilterOperators : [];
  }

  /**
   * Every filter, or a refusal naming all of them at once.
   *
   * One message listing every problem rather than the first: somebody who built
   * four filters and got two of them wrong should learn that in one round trip.
   *
   * The store is asked whether it can honour the operators before the read runs,
   * which is what stops a store that does not filter from answering with an
   * unfiltered page. That refusal is worth more than it costs — a screen only
   * offers what `filterOperators` reported, so a caller reaching this branch is
   * one that built the request itself.
   */
  private resolveFilters(columns: CatalogObjectTypeDef['properties'], raw: string[]) {
    if (raw.length === 0) return [];

    const { filters, problems } = resolveObjectFilters(columns, raw);
    const supported = this.filterOperators();
    const unsupported = filters
      .map((filter) => filter.op)
      .filter((op) => !supported.some((available) => available === op));

    if (unsupported.length > 0) {
      throw new BadRequestException(
        supported.length === 0
          ? "This catalog's store does not filter object reads, so it can only be paged, searched and sorted."
          : `This catalog's store cannot filter with ${[...new Set(unsupported)].join(', ')}. It applies ${supported.join(', ')}.`,
      );
    }
    if (problems.length > 0) {
      throw new BadRequestException(problems.join(' '));
    }
    return filters;
  }

  /** Empty when the store keeps no history. */
  async listSnapshots(typeName: string): Promise<SnapshotRef[]> {
    const type = this.registry.getType(typeName);
    if (!type) throw new NotFoundException(`Unknown object type: ${typeName}`);
    if (!this.store.listSnapshots) return [];
    return this.store.listSnapshots(type);
  }

  /** What the mounted store can do — the screens branch on this. */
  capabilities() {
    return {
      ...this.store.capabilities,
      query: isQueryStore(this.store),
    };
  }

  /** What a query may select from. Empty when the store offers no SQL. */
  async queryRelations(): Promise<CatalogQueryRelation[]> {
    if (!isQueryStore(this.store)) return [];
    return this.store.queryRelations();
  }

  /**
   * Run a read-only statement.
   *
   * The shape check here produces a readable error; the actual guarantee is the
   * read-only transaction the store opens, because a keyword denylist is a
   * guess about a parser and the parser wins eventually.
   */
  async runQuery(input: {
    sql: string;
    maxRows?: number;
    /** Reuse a result for this long. Zero (the default) never caches. */
    cacheTtlSeconds?: number;
  }): Promise<CatalogQueryResult> {
    if (!isQueryStore(this.store)) {
      throw new BadRequestException("This catalog's store does not support SQL queries.");
    }
    try {
      assertReadOnlyShape(input.sql);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }

    const cap = this.options.maxQueryRows ?? 1_000;
    const maxRows = Math.min(Math.max(Number(input.maxRows) || cap, 1), cap);

    // Keyed on the catalog version as well as the SQL: a curation edit that
    // renames a column must not serve a result computed under the old name.
    const ttl = input.cacheTtlSeconds ?? 0;
    const key = QueryCache.key(`${input.sql}|${maxRows}`, this.registry.getSnapshot().version);
    if (ttl > 0) {
      const hit = this.cache.get(key);
      if (hit) return { ...hit, cached: true };
    }

    const result = await this.store.runQuery({
      sql: input.sql,
      maxRows,
      timeoutMs: this.options.queryTimeoutMs ?? 15_000,
    });
    this.cache.set(key, result, ttl);
    return result;
  }

  /** Drops every cached result. Exposed so a worker can warm from cold. */
  clearQueryCache(): void {
    this.cache.clear();
  }

  // ---------------------------------------------------------------------------
  // Workspace: saved queries, dashboards, audit.
  //
  // Every method degrades rather than throws when no workspace store is
  // mounted, because a catalog without one is a legitimate configuration — it
  // simply has no saved queries, and the screens that need them hide.
  // ---------------------------------------------------------------------------

  workspaceAvailable(): boolean {
    return this.workspace !== undefined;
  }

  private requireWorkspace(): CatalogWorkspaceStore {
    if (!this.workspace) {
      throw new BadRequestException(
        'This catalog has no workspace store, so it cannot keep saved queries or dashboards.',
      );
    }
    return this.workspace;
  }

  listSavedQueries(): Promise<SavedQuery[]> {
    return this.workspace ? this.workspace.listSavedQueries() : Promise.resolve([]);
  }

  async getSavedQuery(id: string): Promise<SavedQuery> {
    const found = await this.requireWorkspace().getSavedQuery(id);
    if (!found) throw new NotFoundException(`No saved query ${id}`);
    return found;
  }

  // ---------------------------------------------------------------------------
  // Sharing is audited, and the six methods below are where.
  //
  // `shared` on a saved query or a dashboard is the entire embed boundary: it is
  // the one field that hands another company's frontend rows out of this
  // catalog, and it is set by a person clicking a toggle. So it is emitted the
  // way every other governance decision here is — `type.curated`,
  // `transform.changed` — rather than being the one that is not.
  //
  // Two rules hold across all six, and both are load-bearing:
  //
  // *On the transition, never on the write.* A save that leaves the flag where
  // it was is not a sharing decision. A trail that recorded one per keystroke
  // would be a trail people learn to scroll past, which costs more than the
  // entries are worth. Un-sharing is emitted too, under the same event name with
  // `shared: false` — a trail that records only grants cannot answer "was this
  // still shared last Tuesday".
  //
  // *Against what the store returned, never against what the caller asked for.*
  // A store that ignores `shared` must not produce an entry claiming access was
  // granted when nothing was.
  //
  // **Deleting is a transition.** For a while the first rule was applied only to
  // the writes, so revoking access with the delete button — which is how it
  // actually gets revoked — left nothing at all, and the only way to date the
  // revocation was to notice that a thing had stopped appearing. Deleting
  // something shared now emits `shared: false` with `deleted: true`, under the
  // same event name, so the one filter anybody runs answers the whole question.
  //
  // Deleting something *un*shared emits nothing, and that is the first rule
  // rather than an exception to it: an unshared query was not reachable from
  // outside before and is not reachable after, so no access changed. Recording
  // it would put entries carrying no grant and no revocation on the one channel
  // whose entries all carry one. A host that wants every deletion in the trail
  // wants a workspace-lifecycle event, which is a different event and not this
  // one.
  // ---------------------------------------------------------------------------

  /**
   * @param createdBy who saved it — the row's author and the audit entry's
   * actor. The host's resolved principal id where the host resolves one; see
   * the enforcement note in `catalog.principal.ts` for why this library cannot
   * work it out itself.
   */
  async saveQuery(input: SaveQueryInput, createdBy: string): Promise<SavedQuery> {
    if (!input?.name?.trim()) {
      throw new BadRequestException('A saved query needs a name.');
    }
    assertReadOnlyShape(input.sql ?? '');
    const saved = await this.requireWorkspace().saveQuery(input, createdBy);
    // Born shared is a grant with nothing to transition from: an outside
    // application can fetch it the moment this returns. Born unshared is not an
    // event at all.
    if (saved.shared) {
      emitCatalog('query.shared', {
        savedQueryId: saved.id,
        name: saved.name,
        shared: true,
        principalId: createdBy,
      });
    }
    return saved;
  }

  /** @param changedBy who made the change, for the audit trail. */
  async updateSavedQuery(
    id: string,
    input: Partial<SaveQueryInput>,
    changedBy: string,
  ): Promise<SavedQuery> {
    if (input.sql !== undefined) assertReadOnlyShape(input.sql);
    // Read the old value only when the flag is in play. A transition needs both
    // ends, and every other edit — a rename, a new chart type — should not pay
    // for a round trip it does not need.
    const before =
      input.shared === undefined ? undefined : await this.requireWorkspace().getSavedQuery(id);
    const updated = await this.requireWorkspace().updateSavedQuery(id, input);
    if (!updated) throw new NotFoundException(`No saved query ${id}`);
    // `before` missing while the update succeeded means a store that disagrees
    // with itself about whether this query exists. The transition is then
    // unknowable, and an audit trail should over-record a grant rather than
    // miss one, so it is emitted.
    if (input.shared !== undefined && before?.shared !== updated.shared) {
      emitCatalog('query.shared', {
        savedQueryId: updated.id,
        name: updated.name,
        shared: updated.shared,
        principalId: changedBy,
      });
    }
    return updated;
  }

  /**
   * @param deletedBy who deleted it, for the audit trail. Required rather than
   * defaulted, matching `saveQuery` and `updateSavedQuery`: a default would
   * quietly attribute revocations to nobody in every caller that was not
   * updated, and the trail's whole value here is that it names somebody.
   */
  async deleteSavedQuery(id: string, deletedBy: string): Promise<boolean> {
    // Read unconditionally, unlike `updateSavedQuery` which reads only when the
    // flag is in play. A delete carries no statement of intent about `shared`,
    // so there is nothing to branch on — whether this revokes access is a
    // property of the row, and the row is about to stop existing.
    const before = await this.requireWorkspace().getSavedQuery(id);
    const deleted = await this.requireWorkspace().deleteSavedQuery(id);
    // Only when the store says it went, and only when it was reachable from
    // outside beforehand. A delete that removed nothing revoked nothing, and an
    // unshared query's deletion is not an access event.
    if (deleted && before?.shared) {
      emitCatalog('query.shared', {
        savedQueryId: before.id,
        // The name as it last read. Nothing can look it up after this.
        name: before.name,
        shared: false,
        principalId: deletedBy,
        deleted: true,
      });
    }
    return deleted;
  }

  /** Runs a saved query, honouring the TTL it was saved with. */
  async runSavedQuery(id: string, maxRows?: number) {
    const saved = await this.getSavedQuery(id);
    const result = await this.runQuery({
      sql: saved.sql,
      maxRows,
      cacheTtlSeconds: saved.cacheTtlSeconds,
    });
    return { savedQuery: saved, result };
  }

  listDashboards(): Promise<Dashboard[]> {
    return this.workspace ? this.workspace.listDashboards() : Promise.resolve([]);
  }

  async getDashboard(id: string): Promise<Dashboard> {
    const found = await this.requireWorkspace().getDashboard(id);
    if (!found) throw new NotFoundException(`No dashboard ${id}`);
    return found;
  }

  /**
   * `shared` is declared here, and that is not cosmetic.
   *
   * The store has always accepted it, so it worked as long as the body reached
   * the store untouched. A host with a whitelisting `ValidationPipe` — the
   * normal, recommended configuration — strips a property no type declares, and
   * the symptom is a dashboard that cannot be shared with no error anywhere:
   * the toggle saves, the response says `shared: false`, and the embed API
   * keeps answering 403 for a board somebody just shared.
   */
  async saveDashboard(
    input: { name: string; description?: string; cards?: DashboardCard[]; shared?: boolean },
    createdBy: string,
  ): Promise<Dashboard> {
    if (!input?.name?.trim()) {
      throw new BadRequestException('A dashboard needs a name.');
    }
    const saved = await this.requireWorkspace().saveDashboard(input, createdBy);
    if (saved.shared) {
      emitCatalog('dashboard.shared', {
        dashboardId: saved.id,
        name: saved.name,
        shared: true,
        principalId: createdBy,
      });
    }
    return saved;
  }

  /** @param changedBy who made the change, for the audit trail. */
  async updateDashboard(
    id: string,
    input: Partial<{
      name: string;
      description: string;
      cards: DashboardCard[];
      shared: boolean;
    }>,
    changedBy: string,
  ): Promise<Dashboard> {
    const before =
      input.shared === undefined ? undefined : await this.requireWorkspace().getDashboard(id);
    const updated = await this.requireWorkspace().updateDashboard(id, input);
    if (!updated) throw new NotFoundException(`No dashboard ${id}`);
    if (input.shared !== undefined && before?.shared !== updated.shared) {
      emitCatalog('dashboard.shared', {
        dashboardId: updated.id,
        name: updated.name,
        shared: updated.shared,
        principalId: changedBy,
      });
    }
    return updated;
  }

  /** @param deletedBy who deleted it. See {@link deleteSavedQuery}. */
  async deleteDashboard(id: string, deletedBy: string): Promise<boolean> {
    const before = await this.requireWorkspace().getDashboard(id);
    const deleted = await this.requireWorkspace().deleteDashboard(id);
    if (deleted && before?.shared) {
      emitCatalog('dashboard.shared', {
        dashboardId: before.id,
        name: before.name,
        shared: false,
        principalId: deletedBy,
        deleted: true,
      });
    }
    return deleted;
  }

  // ---------------------------------------------------------------------------
  // Embed: what another application's frontend gets.
  //
  // Only what has been explicitly shared. The alternative — deriving access
  // from the types a query touches — means parsing SQL to decide a permission,
  // and a permission that depends on a parser widens silently the first time
  // the parser meets a query it did not expect.
  // ---------------------------------------------------------------------------

  /** Everything shared, so a consumer can discover what it may render. */
  async listEmbeddable(): Promise<{
    dashboards: Array<{ id: string; name: string; description?: string; charts: number }>;
    charts: Array<{ id: string; name: string; description?: string; kind: string }>;
  }> {
    const [dashboards, queries] = await Promise.all([
      this.listDashboards(),
      this.listSavedQueries(),
    ]);
    return {
      dashboards: dashboards
        .filter((d) => d.shared)
        .map((d) => ({
          id: d.id,
          name: d.name,
          description: d.description,
          charts: d.cards.length,
        })),
      charts: queries
        .filter((q) => q.shared)
        .map((q) => ({
          id: q.id,
          name: q.name,
          description: q.description,
          kind: q.visualization.kind,
        })),
    };
  }

  /**
   * One chart, rendered.
   *
   * `placement` is what the dashboard card said, and it is honoured rather than
   * merely carried: a card's `title` and `library` exist to override the saved
   * query on THIS board, so an embed that ignored them would show a different
   * heading and a different chart from the console for the same dashboard —
   * silently, with nothing thrown and nothing logged.
   */
  async embedChart(
    savedQueryId: string,
    placement?: EmbeddedChartPlacement,
  ): Promise<EmbeddedChart> {
    const saved = await this.getSavedQuery(savedQueryId);
    if (!saved.shared) {
      throw new ForbiddenException(
        `"${saved.name}" has not been shared. Mark it shared in the console to make it embeddable.`,
      );
    }
    const result = await this.runQuery({
      sql: saved.sql,
      cacheTtlSeconds: saved.cacheTtlSeconds,
    });
    // A card whose title was cleared falls back to the query's name rather than
    // embedding a blank heading — an empty override is the absence of one.
    const overridden = placement?.title?.trim();
    return {
      id: saved.id,
      title: overridden ? overridden : saved.name,
      description: saved.description,
      visualization: embeddedVisualization(saved.visualization, placement?.library),
      layout: placement ? { width: placement.width, position: placement.position } : undefined,
      columns: result.columns,
      rows: result.rows,
      rowCount: result.rowCount,
      cached: Boolean(result.cached),
      generatedAt: new Date().toISOString(),
    };
  }

  /** A whole dashboard, every chart resolved. */
  async embedDashboard(dashboardId: string): Promise<EmbeddedDashboard> {
    const dashboard = await this.getDashboard(dashboardId);
    if (!dashboard.shared) {
      throw new ForbiddenException(`"${dashboard.name}" has not been shared.`);
    }

    const ordered = [...dashboard.cards].sort((a, b) => a.position - b.position);
    // Sequential, not parallel: every card is a database query, and a shared
    // dashboard is exactly the thing a consumer will poll on a timer.
    const charts: EmbeddedChart[] = [];
    for (const card of ordered) {
      try {
        charts.push(
          await this.embedChart(card.savedQueryId, {
            width: card.width,
            position: card.position,
            // Everything the card says about this chart, not only where it
            // sits. See `EmbeddedChartPlacement`.
            ...(card.title !== undefined ? { title: card.title } : {}),
            ...(card.library !== undefined ? { library: card.library } : {}),
          }),
        );
      } catch {
        // A card whose query is unshared or broken is skipped rather than
        // failing the whole dashboard — one bad card should not blank a page.
      }
    }

    return {
      id: dashboard.id,
      name: dashboard.name,
      description: dashboard.description,
      charts,
      generatedAt: new Date().toISOString(),
    };
  }

  listEvents(query: AuditQuery): Promise<CatalogAuditEvent[]> {
    return this.workspace ? this.workspace.listEvents(query) : Promise.resolve([]);
  }

  // ---------------------------------------------------------------------------
  // Search: one term, four kinds of thing.
  //
  // **One call that fans out, rather than four the client merges**, and the
  // reason is not the round trips.
  //
  // Half of this is already free: the registry snapshot is in memory, so every
  // type and every property costs a loop over an object this process is holding
  // anyway. Only the workspace half touches a store, and it does so as one
  // `Promise.all` — so the wall clock is the slower of two reads, not four
  // sequential fetches from a browser. A client that split this to render the
  // free half a few milliseconds earlier would be buying that with a second
  // request and a second cache key.
  //
  // What actually decides it is that a merged list needs ONE ranking. Four
  // routes means the client owns the ordering across kinds, which means the
  // ordering lives in the browser, which means every other consumer of this HTTP
  // API — and there is meant to be one, that is what `client.ts` is for —
  // reinvents it slightly differently. And the access filter would have four
  // places to be forgotten instead of one, which for the thing that decides
  // whether a caller learns the name of a type they cannot read is not a
  // trade worth making for a progress spinner.
  //
  // The cost, stated because it is real: a deployment whose workspace store is
  // slow makes the free half wait for it. If that ever bites, the fix is a
  // `kinds` parameter on this one route, not four routes.
  // ---------------------------------------------------------------------------

  /**
   * Everything matching `term` that this principal may see.
   *
   * @param principal the caller, when the host resolved one. **Optional, and its
   * absence filters nothing** — the declare-and-enforce split written out above
   * `mayWrite` in `catalog.principal.ts` means this library never resolves a
   * principal itself. In a deployment with no guard, `GET /catalog` already
   * hands over the whole snapshot, so search is exactly as open as what is
   * already there and strictly narrower the moment a principal appears. See
   * {@link visibleToPrincipal}.
   */
  async search(
    term: string,
    options: { principal?: CatalogPrincipal; limit?: number } = {},
  ): Promise<CatalogSearchResult> {
    const trimmed = (term ?? '').trim();
    if (!trimmed) return emptySearch();
    // Answered before either store is touched. A principal that may read
    // nothing should not cost a workspace query to be told so.
    if (!maySearch(options.principal)) return emptySearch(trimmed);

    const [savedQueries, dashboards] = await Promise.all([
      this.listSavedQueries(),
      this.listDashboards(),
    ]);

    return searchCatalog({
      term: trimmed,
      types: visibleToPrincipal(options.principal, this.registry.getSnapshot().types),
      // Narrowed here rather than handed over whole. `searchCatalog` takes the
      // fields it ranks and nothing else, so `sql` cannot reach the matcher even
      // by accident — see `SearchableSavedQuery` for why matching a statement is
      // the wrong feature rather than a missing one.
      savedQueries: savedQueries.map((query) => ({
        id: query.id,
        name: query.name,
        description: query.description,
        folder: query.folder,
      })),
      dashboards: dashboards.map((dashboard) => ({
        id: dashboard.id,
        name: dashboard.name,
        description: dashboard.description,
      })),
      limit: options.limit,
    });
  }
}
