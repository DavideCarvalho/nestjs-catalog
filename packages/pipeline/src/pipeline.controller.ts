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
import { ConnectionChecker } from './connection-checker.service';
import { ConnectorRunnerService } from './connector-runner.service';
import { WorkflowLauncher } from './workflow-launcher.service';
import { WorkflowRunnerService } from './workflow-runner.service';
import { type CanvasWorkflowInput, toGraph, toRunView } from './workflow-view';

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

    @Get('connections')
    @RequireScopes('catalog:read')
    connections() {
      return this.pipeline.listConnections();
    }

    @Post('connections')
    @RequireScopes('catalog:write')
    saveConnection(
      @Req() request: { principal?: CatalogPrincipal },
      @Body()
      body: Omit<CatalogConnection, 'id' | 'createdAt' | 'updatedAt' | 'createdBy'> & {
        id?: string;
      },
    ) {
      if (!isConnectorKind(body.kind)) {
        throw new BadRequestException(
          `"${body.kind}" is not a connection kind. Accepted: ${CONNECTOR_KINDS.join(', ')}.`,
        );
      }
      return this.pipeline.saveConnection(
        { ...body, kind: body.kind },
        request.principal?.id ?? 'console',
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
    connectionUsers(@Param('id') id: string) {
      return this.pipeline.connectorsUsingConnection(id);
    }

    @Delete('connections/:id')
    @RequireScopes('catalog:write')
    deleteConnection(@Param('id') id: string) {
      return this.pipeline.deleteConnection(id).then((deleted: boolean) => ({ deleted }));
    }

    @Get('connectors')
    @RequireScopes('catalog:read')
    connectors() {
      return this.pipeline.listConnectors();
    }

    @Post('connectors')
    @RequireScopes('catalog:write')
    saveConnector(
      @Req() request: { principal?: CatalogPrincipal },
      @Body() body: Omit<CatalogConnector, 'id' | 'createdAt' | 'updatedAt' | 'createdBy'> & {
        id?: string;
      },
    ) {
      // Validated here, at the edge, rather than narrowed on the way back out.
      // The store can only be strict about what it reads if nothing invalid ever
      // reached it, and a 400 naming the accepted kinds is a better answer than a
      // connector that saves and then fails on its first run.
      if (!isConnectorKind(body.kind)) {
        throw new BadRequestException(
          `"${body.kind}" is not a connector kind. Accepted: ${CONNECTOR_KINDS.join(', ')}.`,
        );
      }
      return this.pipeline.saveConnector(
        { ...body, kind: body.kind },
        request.principal?.id ?? 'console',
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
    run(
      @Req() request: { principal?: CatalogPrincipal },
      @Param('id') id: string,
      @Body() body?: { snapshotId?: string },
    ) {
      return this.runner.run(
        id,
        request.principal?.id ?? 'console',
        body?.snapshotId ?? `manual-${randomUUID().slice(0, 8)}`,
      );
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
      if (!isTransformLanguage(body.language)) {
        throw new BadRequestException(
          `"${body.language}" is not a transform language. Accepted: ${TRANSFORM_LANGUAGES.join(', ')}.`,
        );
      }
      return this.pipeline.saveTransform(
        { ...body, language: body.language },
        request.principal?.id ?? 'console',
      );
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
      const store = this.workflows.requireStore();
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) {
        throw new BadRequestException('A workflow needs a name.');
      }
      // No workflow-level target type: a sink carries the type it commits, and a
      // graph may now have several sinks writing different ones.
      const graph = toGraph(body);
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
        request.principal?.id ?? 'console',
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
      const workflow = await this.workflows.requireWorkflow(id);
      const run = await this.launcher.run({
        workflowId: id,
        principalId: request.principal?.id ?? 'console',
        // Almost always absent — the console posts an empty body. Present when
        // somebody is re-driving a load they already own the identity of.
        snapshotId: body?.snapshotId,
      });
      return toRunView(workflow, run);
    }
    @Get('workflows/:id/connectors')
    @RequireScopes('catalog:read')
    async workflowUsers(@Param('id') id: string) {
      return this.workflows.requireStore().connectorsUsingWorkflow(id);
    }
  }
  if (guards.length > 0) {
    UseGuards(...guards)(PipelineController);
  }

  return PipelineController;
}
