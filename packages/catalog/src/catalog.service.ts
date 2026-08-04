import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { CATALOG_OPTIONS, type CatalogModuleOptions } from './catalog.options';
import {
  type CatalogQueryRelation,
  type CatalogQueryResult,
  assertReadOnlyShape,
  isQueryStore,
} from './catalog.query';
import { QueryCache } from './catalog.query-cache';
import { CatalogRegistry } from './catalog.registry.base';
import { CATALOG_STORE, type CatalogReadStore, type SnapshotRef } from './catalog.store';
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

  /** Presentation-only. Never a schema change. */
  patchType(
    typeName: string,
    patch: Partial<CatalogOverlay['types'][string]>,
  ): Promise<CatalogObjectTypeDef | undefined> {
    return this.registry.patchType(typeName, patch);
  }

  patchProperty(
    typeName: string,
    propertyName: string,
    patch: NonNullable<CatalogOverlay['types'][string]['properties']>[string],
  ): Promise<CatalogObjectTypeDef | undefined> {
    return this.registry.patchProperty(typeName, propertyName, patch);
  }

  /** Drops every runtime edit, where the registry supports it. */
  resetOverlay(): Promise<void> {
    return this.registry.resetOverlay();
  }

  /** Columns a generic UI may render: visible, and not a blob. */
  visibleColumns(type: CatalogObjectTypeDef) {
    return type.properties.filter((p) => !p.hidden && p.type !== 'json');
  }

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

    const { rows, total } = await this.store.read(type, fields, {
      page,
      size,
      search: query.search,
      sort,
      dir: query.dir === 'desc' ? 'desc' : 'asc',
      snapshot: query.snapshot,
    });

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
      })),
      rows,
    };
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

  saveQuery(input: SaveQueryInput, createdBy: string): Promise<SavedQuery> {
    if (!input?.name?.trim()) {
      throw new BadRequestException('A saved query needs a name.');
    }
    assertReadOnlyShape(input.sql ?? '');
    return this.requireWorkspace().saveQuery(input, createdBy);
  }

  async updateSavedQuery(id: string, input: Partial<SaveQueryInput>): Promise<SavedQuery> {
    if (input.sql !== undefined) assertReadOnlyShape(input.sql);
    const updated = await this.requireWorkspace().updateSavedQuery(id, input);
    if (!updated) throw new NotFoundException(`No saved query ${id}`);
    return updated;
  }

  deleteSavedQuery(id: string): Promise<boolean> {
    return this.requireWorkspace().deleteSavedQuery(id);
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
  saveDashboard(
    input: { name: string; description?: string; cards?: DashboardCard[]; shared?: boolean },
    createdBy: string,
  ): Promise<Dashboard> {
    if (!input?.name?.trim()) {
      throw new BadRequestException('A dashboard needs a name.');
    }
    return this.requireWorkspace().saveDashboard(input, createdBy);
  }

  async updateDashboard(
    id: string,
    input: Partial<{
      name: string;
      description: string;
      cards: DashboardCard[];
      shared: boolean;
    }>,
  ): Promise<Dashboard> {
    const updated = await this.requireWorkspace().updateDashboard(id, input);
    if (!updated) throw new NotFoundException(`No dashboard ${id}`);
    return updated;
  }

  deleteDashboard(id: string): Promise<boolean> {
    return this.requireWorkspace().deleteDashboard(id);
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
}
