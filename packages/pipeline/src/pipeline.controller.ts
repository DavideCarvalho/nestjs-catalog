import { randomUUID } from 'node:crypto';
import {
  CATALOG_PIPELINE_STORE,
  CONNECTOR_KINDS,
  type CatalogConnection,
  type CatalogConnector,
  type CatalogPipelineStore,
  type CatalogPrincipal,
  RequireHuman,
  RequireScopes,
  SubprocessTransformRunner,
  TRANSFORM_LANGUAGES,
  isConnectorKind,
  isTransformLanguage,
} from '@dudousxd/nestjs-catalog';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  type Type,
  UseGuards,
} from '@nestjs/common';
import { redactConnection, redactConnector, restoreRedactedSecrets } from './config-secrets';
import { ConnectionChecker } from './connection-checker.service';
import { ConnectorRunnerService } from './connector-runner.service';
import { discoverConnectorSchema } from './schema-discovery';
import { CATALOG_PIPELINE_REGISTRY, type CatalogPipelineRegistry } from './seams';
import { applyConnection, resolveSecret } from './sources';
import { WorkflowLauncher } from './workflow-launcher.service';
import { WorkflowRunnerService } from './workflow-runner.service';
import { type CanvasWorkflowInput, toGraph, toRunView } from './workflow-view';
import { assertMayWriteTypes, committedTypes, requirePrincipal } from './write-grants';

/**
 * Connectors, transforms and their runs.
 *
 * Writing a connector or a transform needs `catalog:write`, not a softer
 * scope: a transform is code that decides what gets stored, so the person who
 * can change it can change the data as surely as anyone loading rows directly.
 */
// No `api/` prefix: a host's global prefix, if it sets one, applies on top.
// `/api/catalog-service/pipeline`.
/**
 * Connectors, connections, transforms and runs.
 *
 * A factory rather than a plain class, matching `createCatalogController`: the
 * route prefix and the guards both come from `forRoot`. A library that hardcodes
 * either forces every host to accept its idea of auth.
 */
export function createPipelineController(
  path: string,
  guards: Type<unknown>[] = [],
): Type<unknown> {
  @Controller(`${path}/pipeline`)
  class PipelineController {
    constructor(
      @Inject(CATALOG_PIPELINE_STORE)
      private readonly pipeline: CatalogPipelineStore,
      private readonly transforms: SubprocessTransformRunner,
      private readonly runner: ConnectorRunnerService,
      private readonly checker: ConnectionChecker,
      private readonly workflows: WorkflowRunnerService,
      private readonly launcher: WorkflowLauncher,
      // Read-only here, and only by `discoverSchema`: it is how this controller
      // answers "does the target type exist yet, and what does it say", which is
      // the difference between a discovery that proposes a type and one that
      // reports drift. The same instance the engine loads through, so the two
      // can never disagree about what is published.
      @Inject(CATALOG_PIPELINE_REGISTRY)
      private readonly registry: CatalogPipelineRegistry,
    ) {}

    /** Which transform languages this deployment can actually execute. */
    @Get('capabilities')
    @RequireScopes('catalog:read')
    async capabilities() {
      const [languages, packages] = await Promise.all([
        this.transforms.available(),
        this.transforms.pythonPackages(),
      ]);
      return { languages, pythonPackages: packages };
    }

    /**
     * Redacted, because this route asks only for `catalog:read`.
     *
     * A connection's `config.url` is the credential for every SQL source — see
     * `config-secrets.ts` — and it was being served here verbatim to anyone who
     * could read the catalog at all. The store still answers truthfully; the
     * hiding happens at the boundary where the audience becomes a person.
     */
    @Get('connections')
    @RequireScopes('catalog:read')
    async connections() {
      return (await this.pipeline.listConnections()).map(redactConnection);
    }

    @Post('connections')
    @RequireScopes('catalog:write')
    async saveConnection(
      @Req() request: { principal?: CatalogPrincipal },
      @Body()
      body: Omit<CatalogConnection, 'id' | 'createdAt' | 'updatedAt' | 'createdBy'> & {
        id?: string;
      },
    ) {
      const principal = requirePrincipal(request);
      if (!isConnectorKind(body.kind)) {
        throw new BadRequestException(
          `"${body.kind}" is not a connection kind. Accepted: ${CONNECTOR_KINDS.join(', ')}.`,
        );
      }
      // What the caller was shown for a password is put back before it is
      // written. Without this, a console that read this connection, changed its
      // name and posted the object back would store the placeholder as the real
      // credential — the classic way a redaction corrupts what it protects.
      const stored = body.id ? await this.pipeline.getConnection(body.id) : undefined;
      return this.pipeline.saveConnection(
        {
          ...body,
          kind: body.kind,
          config: restoreRedactedSecrets(body.config ?? {}, stored?.config),
        },
        principal.id,
      );
    }

    /**
     * Reach it, and remember what happened.
     *
     * Recorded rather than only returned, so the list can show which connections
     * are known to work without every page load reaching every system it names.
     */
    @Post('connections/:id/check')
    @RequireScopes('catalog:read')
    async checkConnection(@Param('id') id: string) {
      const connection = await this.pipeline.getConnection(id);
      if (!connection) throw new NotFoundException(`No connection ${id}`);
      const result = await this.checker.check(connection);
      await this.pipeline.recordConnectionCheck(id, result);
      return result;
    }

    @Get('connections/:id/connectors')
    @RequireScopes('catalog:read')
    async connectionUsers(@Param('id') id: string) {
      return (await this.pipeline.connectorsUsingConnection(id)).map(redactConnector);
    }

    @Delete('connections/:id')
    @RequireScopes('catalog:write')
    deleteConnection(@Param('id') id: string) {
      return this.pipeline.deleteConnection(id).then((deleted: boolean) => ({ deleted }));
    }

    /** Redacted for the same reason as `connections` — see that route. */
    @Get('connectors')
    @RequireScopes('catalog:read')
    async connectors() {
      return (await this.pipeline.listConnectors()).map(redactConnector);
    }

    @Post('connectors')
    @RequireScopes('catalog:write')
    async saveConnector(
      @Req() request: { principal?: CatalogPrincipal },
      @Body() body: Omit<CatalogConnector, 'id' | 'createdAt' | 'updatedAt' | 'createdBy'> & {
        id?: string;
      },
    ) {
      const principal = requirePrincipal(request);
      // Validated here, at the edge, rather than narrowed on the way back out.
      // The store can only be strict about what it reads if nothing invalid ever
      // reached it, and a 400 naming the accepted kinds is a better answer than a
      // connector that saves and then fails on its first run.
      if (!isConnectorKind(body.kind)) {
        throw new BadRequestException(
          `"${body.kind}" is not a connector kind. Accepted: ${CONNECTOR_KINDS.join(', ')}.`,
        );
      }
      await this.assertMayCommit(
        principal,
        body.targetType,
        body.workflowId,
        `saving connector "${body.name}"`,
      );
      const stored = body.id ? await this.pipeline.getConnector(body.id) : undefined;
      return this.pipeline.saveConnector(
        {
          ...body,
          kind: body.kind,
          config: restoreRedactedSecrets(body.config ?? {}, stored?.config),
        },
        principal.id,
      );
    }

    @Delete('connectors/:id')
    @RequireScopes('catalog:write')
    deleteConnector(@Param('id') id: string) {
      return this.pipeline.deleteConnector(id).then((deleted: boolean) => ({ deleted }));
    }

    /**
     * Run one now.
     *
     * The snapshot id is minted here when the caller does not supply one. A
     * durable-scheduled run passes its own run id instead, which is what makes a
     * retry replace its batches rather than load twice.
     */
    @Post('connectors/:id/run')
    @RequireScopes('catalog:write')
    async run(
      @Req() request: { principal?: CatalogPrincipal },
      @Param('id') id: string,
      @Body() body?: { snapshotId?: string; expectShrink?: string },
    ) {
      const principal = requirePrincipal(request);
      // Checked at the run and not only at the save, because a connector
      // authored by somebody who could write its type may be run by somebody
      // who cannot, and the run is what commits. `commitAsSystem` at the end of
      // it takes a `principalId` string and checks nothing by design — that id
      // is attribution, not an authorisation — so this is the last point where
      // there are grants to consult at all.
      //
      // A connector that is not there is left to the runner's own 404: there is
      // nothing to authorise when there is nothing to write with.
      const connector = await this.pipeline.getConnector(id);
      if (connector) {
        await this.assertMayCommit(
          principal,
          connector.targetType,
          connector.workflowId,
          `running connector "${connector.name}"`,
        );
      }
      return this.runner.run(
        id,
        principal.id,
        body?.snapshotId ?? `manual-${randomUUID().slice(0, 8)}`,
        // The acknowledgement that this load is allowed to collapse, and it
        // reaches the runner only from HERE. The scheduled path deliberately
        // has no field for it: a cron run is unattended, and an acknowledgement
        // given once and honoured every night is the bound switched off wearing
        // a reason. So the operator's route is exactly this one — let the
        // scheduled load be refused, then re-run it by hand saying why.
        //
        // Forwarded rather than defaulted. `undefined` means nobody said
        // anything; an empty string means somebody sent the field with nothing
        // behind it, which the runner refuses, and flattening the two here
        // would turn that refusal into silence.
        ...(body && 'expectShrink' in body ? [{ expectShrink: body.expectShrink }] : []),
      );
    }

    /**
     * Ask a connector what its source looks like. Creates nothing.
     *
     * The route that lets somebody point the catalog at a table nobody has
     * written an entity for. It runs the connector's own read — the driver's
     * column description for SQL, a bounded sample for everything else — and
     * answers with the columns, the types it could conclude, the ones it could
     * not, and how what it found differs from the type as it stands today. See
     * `schema-discovery.ts` for why each of those is what it is.
     *
     * **It writes nothing, and it must stay that way.** Creating the type is a
     * separate act by a person against `PUT /publish/:type/schema`, which does
     * its own `mayWrite` check. A connector that created the type it loads into
     * would grow the catalog by accident, and the names it invented would come
     * from the shape of a query rather than from somebody who meant them.
     *
     * `POST` rather than `GET` for the same reason `connections/:id/check` is:
     * this reaches out over the network, takes as long as the source takes, and
     * is nobody's idea of a cacheable read.
     *
     * Authorised exactly as running it is, and that is not belt-and-braces.
     * Saving a connector and running one both require a grant on its target
     * type, so today a principal with `catalog:write` and no grants cannot cause
     * the server to read any source at all. Discovery without the same check
     * would be the first route that could: press it against somebody else's
     * connector and the answer is the column names of a database this caller was
     * never allowed near.
     */
    @Post('connectors/:id/discover')
    @RequireScopes('catalog:write')
    async discoverSchema(
      @Req() request: { principal?: CatalogPrincipal },
      @Param('id') id: string,
    ) {
      const principal = requirePrincipal(request);
      const connector = await this.pipeline.getConnector(id);
      if (!connector) throw new NotFoundException(`No connector ${id}`);
      await this.assertMayCommit(
        principal,
        connector.targetType,
        connector.workflowId,
        `discovering the schema behind "${connector.name}"`,
      );

      // Resolved here rather than at save time, exactly as a run resolves it: an
      // edited connection has to take effect on the next read, and a discovery
      // that described the old address would describe a source the load no
      // longer touches.
      const connection = connector.connectionId
        ? await this.pipeline.getConnection(connector.connectionId)
        : undefined;
      if (connector.connectionId && !connection) {
        throw new BadRequestException(
          `"${connector.name}" reads through a connection that no longer exists (${connector.connectionId}). Point it at one that does — there is nothing to describe until then.`,
        );
      }
      const resolved = applyConnection(connector, connection);

      try {
        return await discoverConnectorSchema({
          connector: resolved,
          secret: resolveSecret(resolved),
          // The registry, not the store: drift is measured against the type as
          // the engine currently sees it, which is the same object a load would
          // be written through.
          existing: this.registry.getType(connector.targetType),
        });
      } catch (error) {
        // A source that refuses, a query that does not parse, a missing
        // credential: all of them are this connector's configuration, not the
        // server's fault, and a 500 would hide the one sentence that says which.
        throw new BadRequestException(error instanceof Error ? error.message : String(error));
      }
    }

    @Get('runs')
    @RequireScopes('catalog:read')
    runs(@Query('connector') connectorId?: string, @Query('limit') limit?: string) {
      return this.pipeline.listRuns(connectorId, limit ? Number(limit) : undefined);
    }

    @Get('transforms')
    @RequireScopes('catalog:read')
    transformList() {
      return this.pipeline.listTransforms();
    }

    @Post('transforms')
    @RequireScopes('catalog:write')
    saveTransform(
      @Req() request: { principal?: CatalogPrincipal },
      @Body()
      body: {
        id?: string;
        name: string;
        language: string;
        code: string;
        description?: string;
      },
    ) {
      // No per-type check here, and that is not an oversight: a transform names
      // no object type. It is code, and which type its output lands in is
      // decided by the sink of whatever graph runs it — which is checked when
      // that graph is saved and again when it is run. `catalog:write` remains
      // the bar for writing code, as the note on this controller says.
      const principal = requirePrincipal(request);
      if (!isTransformLanguage(body.language)) {
        throw new BadRequestException(
          `"${body.language}" is not a transform language. Accepted: ${TRANSFORM_LANGUAGES.join(', ')}.`,
        );
      }
      return this.pipeline.saveTransform({ ...body, language: body.language }, principal.id);
    }

    @Delete('transforms/:id')
    @RequireScopes('catalog:write')
    deleteTransform(@Param('id') id: string) {
      return this.pipeline.deleteTransform(id).then((deleted: boolean) => ({ deleted }));
    }

    /**
     * Run a transform against sample records without storing anything.
     *
     * The difference between a transform someone can iterate on and one they can
     * only test in production.
     */
    @Post('transforms/try')
    @RequireScopes('catalog:write')
    async tryTransform(
      @Body()
      body: {
        language: 'javascript' | 'python';
        code: string;
        records?: unknown[];
      },
    ) {
      try {
        return await this.transforms.run(
          { language: body.language, code: body.code },
          body.records ?? [],
          { timeoutMs: 10_000 },
        );
      } catch (error) {
        // A failing transform is the author's mistake, not the server's. Letting
        // it become a 500 hides the one thing they need — the timeout, the
        // exception, the line — behind "Internal server error".
        throw new BadRequestException(error instanceof Error ? error.message : String(error));
      }
    }

    @Get('workflows')
    @RequireScopes('catalog:read')
    async workflowList() {
      const store = this.workflows.requireStore();
      // Served verbatim. The view that used to sit here flattened a source down
      // to a connector id, renamed `name` to `label`, and turned a missing
      // position into the origin — three lies the screen then repeated back, one
      // of which would have erased a source's configuration on the next save.
      return store.listWorkflows();
    }
    @Post('workflows')
    @RequireScopes('catalog:write')
    async saveWorkflow(
      @Req() request: { principal?: CatalogPrincipal },
      @Body() body: CanvasWorkflowInput,
    ) {
      const principal = requirePrincipal(request);
      const store = this.workflows.requireStore();
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) {
        throw new BadRequestException('A workflow needs a name.');
      }
      // No workflow-level target type: a sink carries the type it commits, and a
      // graph may now have several sinks writing different ones.
      const graph = toGraph(body);
      // Authorised against every type the graph would commit, before it is
      // stored. This is the check the scheduled path depends on: a cron-fired
      // run carries `SCHEDULER_PRINCIPAL`, which is a synthetic id with no
      // grants to consult, so if a graph committing somebody else's type can be
      // written down at all, nothing downstream will ever object to it again.
      assertMayWriteTypes(principal, committedTypes(graph.nodes), `saving workflow "${name}"`);
      const saved = await store.saveWorkflow(
        {
          id: body.id,
          name,
          description:
            typeof body.description === 'string' && body.description.length > 0
              ? body.description
              : undefined,
          nodes: graph.nodes,
          edges: graph.edges,
        },
        principal.id,
      );
      return saved;
    }
    @Delete('workflows/:id')
    @RequireScopes('catalog:write')
    async deleteWorkflow(@Param('id') id: string) {
      const store = this.workflows.requireStore();
      return { deleted: await store.deleteWorkflow(id) };
    }
    @Post('workflows/:id/run')
    @RequireScopes('catalog:write')
    async runWorkflow(
      @Req() request: { principal?: CatalogPrincipal },
      @Param('id') id: string,
      @Body() body?: { snapshotId?: string },
    ) {
      const principal = requirePrincipal(request);
      const workflow = await this.workflows.requireWorkflow(id);
      // The case save time cannot see: a graph written last month by a
      // principal that could commit this type, run today by one that cannot.
      assertMayWriteTypes(
        principal,
        committedTypes(workflow.nodes),
        `running workflow "${workflow.name}"`,
      );
      const run = await this.launcher.run({
        workflowId: id,
        principalId: principal.id,
        // Almost always absent — the console posts an empty body. Present when
        // somebody is re-driving a load they already own the identity of.
        snapshotId: body?.snapshotId,
      });
      return toRunView(workflow, run);
    }
    @Get('workflows/:id/connectors')
    @RequireScopes('catalog:read')
    async workflowUsers(@Param('id') id: string) {
      const using = await this.workflows.requireStore().connectorsUsingWorkflow(id);
      return using.map(redactConnector);
    }

    /**
     * Every type this connector would cause to be committed, authorised at once.
     *
     * Two sources, and both are needed. `targetType` is what a plain connector
     * publishes on its own. A connector attached to a workflow publishes
     * whatever that graph's **sinks** commit, which is not the same set: the
     * store keeps `WorkflowRow.targetType` in step with the connector's, but
     * that field records only the first sink found, while a graph may legally
     * carry several as long as they commit different types. Authorising on the
     * connector's field alone would clear a two-sink graph on the strength of
     * its first sink.
     *
     * A workflow id that resolves to nothing is passed over rather than raised
     * here: `saveConnector` in the store already refuses that, with a message
     * that explains what a connector pointing at a missing graph does to a
     * schedule, and answering 404 first would replace it with a worse one.
     */
    private async assertMayCommit(
      principal: CatalogPrincipal,
      targetType: string,
      workflowId: string | undefined,
      subject: string,
    ): Promise<void> {
      const types = [targetType];
      if (workflowId) {
        const workflow = await this.workflows.requireStore().getWorkflow(workflowId);
        for (const type of committedTypes(workflow?.nodes ?? [])) {
          if (!types.includes(type)) types.push(type);
        }
      }
      assertMayWriteTypes(principal, types, subject);
    }
  }
  if (guards.length > 0) {
    UseGuards(...guards)(PipelineController);
  }

  return PipelineController;
}
