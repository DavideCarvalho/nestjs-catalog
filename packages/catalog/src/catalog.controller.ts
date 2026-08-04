import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Optional,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  type Type,
  UseGuards,
} from '@nestjs/common';
import type { CatalogPrincipal } from './catalog.principal';
import { toCsv } from './catalog.query-cache';
import { CatalogRegistry } from './catalog.registry.base';
import { RequireScopes } from './catalog.route-auth';
import { CatalogService } from './catalog.service';
import {
  CATALOG_TRACE_STORE,
  type CatalogTraceOutcome,
  type CatalogTraceStore,
  type DashboardCard,
  type SaveQueryInput,
  isCatalogTraceOutcome,
} from './catalog.workspace';

/**
 * Built as a factory rather than a plain class because the route prefix and the
 * guards both come from `forRoot`. A library that hardcodes either one forces
 * every host app to accept its idea of auth, which for an endpoint that
 * enumerates every table in the database is not a reasonable default.
 */
export function createCatalogController(
  path: string,
  guards: Type<unknown>[],
  decorators: ClassDecorator[] = [],
): Type<unknown> {
  @Controller(path)
  class CatalogController {
    constructor(
      private readonly registry: CatalogRegistry,
      private readonly service: CatalogService,
      // Optional, and injected by token rather than reached through
      // `CatalogService`, because grouping the trail into traces is a query only
      // some stores can run. A deployment on a store that cannot gets a catalog
      // that works in every other respect and one endpoint that says why.
      @Optional()
      @Inject(CATALOG_TRACE_STORE)
      private readonly traces?: CatalogTraceStore,
    ) {}

    private requireTraces(): CatalogTraceStore {
      if (!this.traces) {
        throw new BadRequestException(
          'This catalog has no trace store, so the audit trail can be listed but not grouped into traces.',
        );
      }
      return this.traces;
    }

    /** The whole ontology, as data. */
    @Get()
    snapshot() {
      return this.registry.getSnapshot();
    }

    /** Nodes and edges, for drawing it. */
    @Get('graph')
    graph() {
      return this.registry.getGraph();
    }

    @Get('types/:name')
    type(@Param('name') name: string) {
      const type = this.registry.getType(name);
      if (!type) throw new NotFoundException(`Unknown object type: ${name}`);
      return type;
    }

    /**
     * Tier 0. Renames a type, regroups it, changes its icon. No migration, no
     * deploy, no engineer.
     */
    @Patch('types/:name')
    async patchType(
      @Param('name') name: string,
      @Body()
      body: {
        displayName?: string;
        pluralDisplayName?: string;
        description?: string;
        icon?: string;
        group?: string;
        titleProperty?: string;
      },
    ) {
      const updated = await this.registry.patchType(name, body);
      if (!updated) throw new NotFoundException(`Unknown object type: ${name}`);
      return updated;
    }

    /** Tier 0, one property at a time. */
    @Patch('types/:name/properties/:property')
    async patchProperty(
      @Param('name') name: string,
      @Param('property') property: string,
      @Body()
      body: {
        displayName?: string;
        description?: string;
        hidden?: boolean;
        order?: number;
        classification?: string;
        unit?: string;
      },
    ) {
      const updated = await this.registry.patchProperty(name, property, body);
      if (!updated) {
        throw new NotFoundException(`Unknown property: ${name}.${property}`);
      }
      return updated;
    }

    /** Drops every tier-0 edit and falls back to what the ORM says. */
    @Post('reset')
    async reset() {
      await this.registry.resetOverlay();
      return this.registry.getSnapshot();
    }

    /** One generic read endpoint for every type in the catalog. */
    @Get('objects/:name')
    objects(
      @Param('name') name: string,
      @Query('page') page?: string,
      @Query('size') size?: string,
      @Query('search') search?: string,
      @Query('sort') sort?: string,
      @Query('dir') dir?: string,
      // Reads as of an earlier load. Stores that keep no history reject this
      // rather than quietly answering with current state — a reader who thinks
      // they are looking at last Tuesday and is not would rather be told.
      @Query('snapshot') snapshot?: string,
    ) {
      return this.service.readObjects(name, {
        page: page ? Number(page) : undefined,
        size: size ? Number(size) : undefined,
        search,
        sort,
        dir: dir === 'desc' ? 'desc' : 'asc',
        snapshot,
      });
    }

    /** What an ad-hoc query may select from, and whether it can run at all. */
    @Get('query/relations')
    queryRelations() {
      return this.service.queryRelations();
    }

    /** Run one read-only statement. */
    @Post('query')
    runQuery(@Body() body: { sql: string; maxRows?: number }) {
      return this.service.runQuery(body ?? { sql: '' });
    }

    /** Everything a saved query or dashboard needs to know is here. */
    @Get('workspace/capabilities')
    workspaceCapabilities() {
      return {
        workspace: this.service.workspaceAvailable(),
        ...this.service.capabilities(),
      };
    }

    @Get('saved-queries')
    savedQueries() {
      return this.service.listSavedQueries();
    }

    @Post('saved-queries')
    saveSavedQuery(
      @Body() body: SaveQueryInput & { createdBy?: string },
      @Req() request: { principal?: CatalogPrincipal },
    ) {
      return this.service.saveQuery(body, actorOf(request, body?.createdBy));
    }

    @Get('saved-queries/:id')
    savedQuery(@Param('id') id: string) {
      return this.service.getSavedQuery(id);
    }

    /**
     * The body names no actor, deliberately — unlike the create route above,
     * which has always let one be declared because `createdBy` is a stored
     * field. Here the only consumer of the name is the audit entry a `shared`
     * toggle produces, and a caller that can put any string into the audit trail
     * is worse than one the trail records as the console.
     */
    @Patch('saved-queries/:id')
    patchSavedQuery(
      @Param('id') id: string,
      @Body() body: Partial<SaveQueryInput>,
      @Req() request: { principal?: CatalogPrincipal },
    ) {
      return this.service.updateSavedQuery(id, body, actorOf(request));
    }

    @Delete('saved-queries/:id')
    removeSavedQuery(@Param('id') id: string) {
      return this.service.deleteSavedQuery(id).then((deleted) => ({ deleted }));
    }

    /** Run a saved query, honouring the cache TTL it was saved with. */
    @Post('saved-queries/:id/run')
    runSavedQuery(@Param('id') id: string, @Body() body?: { maxRows?: number }) {
      return this.service.runSavedQuery(id, body?.maxRows);
    }

    /**
     * The same result as CSV.
     *
     * A GET, not a POST, so it can be a plain link — a download that only works
     * from JavaScript cannot be pasted into a mail or a scheduled job.
     */
    @Get('saved-queries/:id/export.csv')
    async exportSavedQuery(
      @Param('id') id: string,
      @Res({ passthrough: true }) response: {
        setHeader(name: string, value: string): void;
      },
    ) {
      const { savedQuery, result } = await this.service.runSavedQuery(id);
      const filename = `${savedQuery.name.replace(/[^A-Za-z0-9_-]+/g, '-')}.csv`;
      response.setHeader('content-type', 'text/csv; charset=utf-8');
      response.setHeader('content-disposition', `attachment; filename="${filename}"`);
      return toCsv(result);
    }

    @Get('dashboards')
    dashboards() {
      return this.service.listDashboards();
    }

    /**
     * `shared` is declared rather than merely passed through.
     *
     * It is the entire access boundary of the embed API — a board is
     * embeddable because a person said so — and a field a body type does not
     * name is a field a host's whitelisting `ValidationPipe` deletes. The
     * failure is silent in the worst direction: the toggle appears to save and
     * the dashboard is never actually shareable.
     */
    @Post('dashboards')
    createDashboard(
      @Body()
      body: {
        name: string;
        description?: string;
        cards?: DashboardCard[];
        shared?: boolean;
        createdBy?: string;
      },
      @Req() request: { principal?: CatalogPrincipal },
    ) {
      return this.service.saveDashboard(body, actorOf(request, body?.createdBy));
    }

    @Get('dashboards/:id')
    dashboard(@Param('id') id: string) {
      return this.service.getDashboard(id);
    }

    @Patch('dashboards/:id')
    patchDashboard(
      @Param('id') id: string,
      @Body()
      body: Partial<{
        name: string;
        description: string;
        cards: DashboardCard[];
        shared: boolean;
      }>,
      @Req() request: { principal?: CatalogPrincipal },
    ) {
      return this.service.updateDashboard(id, body, actorOf(request));
    }

    @Delete('dashboards/:id')
    removeDashboard(@Param('id') id: string) {
      return this.service.deleteDashboard(id).then((deleted) => ({ deleted }));
    }

    /**
     * What this caller may embed.
     *
     * A discovery endpoint so a consuming frontend can list what it is allowed
     * to render rather than being told the ids out of band.
     *
     * `catalog:embed` here as well as on the two fetches, and deliberately the
     * SAME scope rather than a softer one. A caller that cannot fetch anything
     * has no use for the list, and a discovery endpoint open to callers the
     * fetches refuse is an inventory of this catalog's shared dashboards handed
     * to whoever asks.
     */
    @Get('embed')
    @RequireScopes('catalog:embed')
    embeddable() {
      return this.service.listEmbeddable();
    }

    /** A whole dashboard, every chart resolved and ready to draw. */
    @Get('embed/dashboards/:id')
    @RequireScopes('catalog:embed')
    embedDashboard(@Param('id') id: string) {
      return this.service.embedDashboard(id);
    }

    /**
     * One chart, for a consumer that wants to place it itself.
     *
     * `catalog:embed` and not `catalog:read`: the whole reason the scope exists
     * separately is that an application rendering one chart in its own UI needs
     * nothing else, and a route that accepted `catalog:read` instead would make
     * the narrow grant unusable — every embed consumer would be handed the
     * whole catalog to draw one bar chart.
     */
    @Get('embed/charts/:id')
    @RequireScopes('catalog:embed')
    embedChart(@Param('id') id: string) {
      return this.service.embedChart(id);
    }

    /** The audit trail: what happened, to what, by whom. */
    @Get('events')
    events(
      @Query('event') event?: string,
      @Query('type') typeName?: string,
      @Query('principal') principalId?: string,
      @Query('since') since?: string,
      @Query('limit') limit?: string,
    ) {
      return this.service.listEvents({
        event,
        typeName,
        principalId,
        since,
        limit: limit ? Number(limit) : undefined,
      });
    }

    /**
     * The same trail, grouped into causal stories.
     *
     * Declared after `events` and before anything with a parameter in that
     * position, so `traces` is matched as the literal it is. Nest resolves
     * routes in declaration order, and a `:something` registered first would
     * swallow this path and answer it with a lookup for an event named
     * "traces" — a 404 nobody could explain.
     *
     * `event` and `outcome` pick *which traces* come back, never which spans:
     * a trace returned with only its matching events would be a story with
     * pages missing that still looked complete.
     */
    @Get('events/traces')
    traceList(
      @Query('type') typeName?: string,
      @Query('principal') principalId?: string,
      @Query('event') event?: string,
      // `?outcome=failed&outcome=incomplete`, or one comma-separated value, or
      // one plain value. Express hands back a string for one and an array for
      // repeats, so both forms have to be accepted whatever this declares.
      @Query('outcome') outcome?: string | string[],
      @Query('since') since?: string,
      @Query('limit') limit?: string,
      @Query('offset') offset?: string,
    ) {
      return this.requireTraces().listTraces({
        typeName,
        principalId,
        event,
        outcome: parseOutcomes(outcome),
        since,
        limit: limit ? Number(limit) : undefined,
        offset: offset ? Number(offset) : undefined,
      });
    }

    /** One story in full, by correlation id. */
    @Get('events/traces/:id')
    async trace(@Param('id') id: string) {
      const found = await this.requireTraces().getTrace(id);
      if (!found) {
        throw new NotFoundException(`No trace ${id} in the audit trail.`);
      }
      return found;
    }

    /** Every load of this type: when, by whom, how many rows. */
    @Get('objects/:name/snapshots')
    snapshots(@Param('name') name: string) {
      return this.service.listSnapshots(name);
    }
  }

  if (guards.length > 0) {
    UseGuards(...guards)(CatalogController);
  }

  for (const decorate of decorators) {
    decorate(CatalogController);
  }

  return CatalogController;
}

/**
 * Who to record a workspace change against.
 *
 * The host's resolved principal wins over anything the body claimed, and that
 * order is the whole point: a `createdBy` in a request body is a name the caller
 * chose for itself, and letting it beat the principal a guard authenticated
 * would make the audit trail's actor column a free-text field. It is still
 * honoured when there is no principal, because this library does not resolve
 * one — see the enforcement note in `catalog.principal.ts` — and a host that has
 * not wired a guard yet is better served by "console" than by nothing.
 *
 * `principal.id` rather than `applicationId`, matching every other event on this
 * channel: for a delegated caller that string carries the person inside it, and
 * dropping to the application half would attribute a person's decision to the
 * console they used.
 */
function actorOf(request: { principal?: CatalogPrincipal } | undefined, claimed?: string): string {
  const resolved = request?.principal?.id?.trim();
  if (resolved) return resolved;
  return claimed?.trim() || 'console';
}

/**
 * `?outcome=failed`, `?outcome=failed,incomplete`, `?outcome=a&outcome=b`.
 *
 * Two behaviours here are load-bearing and neither is obvious.
 *
 * An unrecognised outcome is dropped rather than passed down as a filter that
 * matches nothing, and if nothing recognisable is left the filter goes away
 * entirely. Returning an empty list for a typo would read as "no traces
 * failed", which is the most expensive wrong answer this endpoint could give.
 *
 * A single outcome comes back as a bare string rather than a one-element array.
 * `TraceQuery.outcome` accepts both, but a trace store written against the
 * earlier contract expects only the string and would compare its column to an
 * array — matching nothing, and reporting it as a clean empty page. So the
 * array form is only ever produced when the caller genuinely asked for more
 * than one, which is also the only case where an older store could not have
 * answered anyway.
 */
function parseOutcomes(
  raw: string | string[] | undefined,
): CatalogTraceOutcome | CatalogTraceOutcome[] | undefined {
  if (raw === undefined) return undefined;
  const candidates = (Array.isArray(raw) ? raw : [raw]).flatMap((value) =>
    String(value).split(','),
  );
  const outcomes: CatalogTraceOutcome[] = [];
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (isCatalogTraceOutcome(trimmed) && !outcomes.includes(trimmed)) {
      outcomes.push(trimmed);
    }
  }
  if (outcomes.length === 0) return undefined;
  return outcomes.length === 1 ? outcomes[0] : outcomes;
}
