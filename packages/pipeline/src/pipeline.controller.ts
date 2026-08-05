import { randomUUID } from 'node:crypto';
import {
  CATALOG_PIPELINE_STORE,
  CONNECTOR_KINDS,
  type CatalogConnection,
  type CatalogConnector,
  type CatalogPipelineStore,
  type CatalogPrincipal,
  type CatalogWorkflow,
  RequireHuman,
  RequireScopes,
  SubprocessTransformRunner,
  TRANSFORM_LANGUAGES,
  type WorkflowNode,
  hasScope,
  isConnectorKind,
  isTransformLanguage,
} from '@dudousxd/nestjs-catalog';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  type Type,
  UseGuards,
} from '@nestjs/common';
import {
  redactConfigSecrets,
  redactConnection,
  redactConnector,
  restoreRedactedSecrets,
} from './config-secrets';
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
    /**
     * Named for the generated class rather than the factory, so a log line says
     * which mount produced it in a host running more than one.
     */
    private readonly logger = new Logger(`${PipelineController.name}(${path})`);

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

    /** What this deployment can actually execute, and whether a run survives a crash. */
    @Get('capabilities')
    @RequireScopes('catalog:read')
    async capabilities() {
      const [languages, packages] = await Promise.all([
        this.transforms.available(),
        this.transforms.pythonPackages(),
      ]);
      return {
        languages,
        pythonPackages: packages,
        // Served, finally. The console has always asked — `WorkflowCanvas`
        // reads `capabilities.durable` and prints whether a failed run resumes
        // where it stopped — and this route has never answered, so the screen
        // fell through to its "unknown" branch in every deployment there has
        // ever been.
        //
        // That silence also swallowed the whole `CATALOG_PIPELINE_DURABILITY_DETAIL`
        // seam: it is the supported way a host states the two things the
        // launcher deliberately cannot detect from here — whether this pod
        // registers the workflow handlers, and which environment its worker
        // serves — and every word of it was dropped on arrival.
        //
        // Synchronous, unlike the two above: it reports what resolved in this
        // process rather than probing anything, which is the property its own
        // docblock argues for at length. Nothing here waits on it.
        durable: this.launcher.durability(),
      };
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

    /**
     * Reach a connection that has not been saved yet.
     *
     * Declared BEFORE `connections/:id/check`, and it has to be: Nest matches
     * in declaration order, and `:id` would happily capture the literal
     * "check".
     *
     * The reason this exists rather than the form telling you to save first:
     * the field most likely to be wrong is the env var's NAME, and the way you
     * find out is a connector run failing hours later. A connection saved to
     * discover it was misspelled is a row somebody then has to remember to
     * delete.
     *
     * `catalog:write`, not the `catalog:read` its saved sibling asks for, and
     * the difference is the point. Checking a SAVED connection reaches an
     * address somebody with `catalog:write` already chose and wrote down;
     * checking a posted one reaches an address supplied in the request, which
     * is the server connecting wherever the caller says. Under `catalog:read`
     * that is a port scanner for anybody who may look at the catalog.
     *
     * Under `catalog:write` it grants no reach that did not exist — the same
     * caller could save, check and delete — but that route leaves three
     * records and this one leaves none, so it says what it did in the log. The
     * address, never the credential.
     *
     * Records nothing on the connection, because there is no connection: the
     * saved sibling writes its result so the list can show what is known to
     * work, and there is nothing here to write it against.
     */
    @Post('connections/check')
    @RequireScopes('catalog:write')
    async checkUnsavedConnection(
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

      // An edit of something already stored puts the real credential back, the
      // same way saving does — otherwise testing a connection you only renamed
      // would test the redaction placeholder and report it unreachable.
      const stored = body.id ? await this.pipeline.getConnection(body.id) : undefined;
      const connection: CatalogConnection = {
        ...body,
        id: body.id ?? 'unsaved',
        kind: body.kind,
        config: restoreRedactedSecrets(body.config ?? {}, stored?.config),
        createdBy: principal.id,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      this.logger.log(
        `${principal.id} tested an unsaved "${body.kind}" connection named "${body.name}".`,
      );
      return this.checker.check(connection);
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
      // Redacted on the way out, exactly as the `GET` is, and not because this
      // caller could not have sent the credential. They could — but a caller who
      // posts back the placeholder they were shown gets the *restored* row, so
      // an unredacted response is the redaction on the read undone in a single
      // request by anyone holding `catalog:write`.
      return redactConnection(
        await this.pipeline.saveConnection(
          {
            ...body,
            kind: body.kind,
            config: restoreRedactedSecrets(body.config ?? {}, stored?.config),
          },
          principal.id,
        ),
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
      // Redacted on the way out — see `saveConnection` for why a save response
      // is a read.
      return redactConnector(
        await this.pipeline.saveConnector(
          {
            ...body,
            kind: body.kind,
            config: restoreRedactedSecrets(body.config ?? {}, stored?.config),
          },
          principal.id,
        ),
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
     *
     * ## What this route actually is
     *
     * It takes code and executes it in this pod. `SubprocessTransformRunner`
     * gives it a timeout and an environment of `{PATH, NODE_ENV}` and its own
     * docblock is careful to say that this is not a security boundary — the
     * child reads `/proc/<ppid>/environ` and gets back every variable the
     * allowlist withheld, and it reads the filesystem as whatever user the
     * service runs as. So the question this route asks is not "is the sandbox
     * tight enough" but "who may run code here", and it is answered here.
     *
     * ## Why the answer is not a bigger scope
     *
     * It reached the runner on `catalog:write` alone, with **no**
     * `requirePrincipal` — the only route on this controller without one — and
     * no check that `body.language` was a language. Raising it to
     * `catalog:admin` was the obvious repair and is the wrong one, because the
     * same runner is already three requests away from any `catalog:write`
     * holder with a grant: save a transform (no per-type check, deliberately —
     * see `saveTransform`), save a graph whose sink commits a type they may
     * write, press Run, and `WorkflowRunnerService` calls `transforms.run` with
     * that code. `ConnectorRunnerService` is the same story one route over. A
     * gate here that the graph path does not have would stop the person
     * iterating in the editor and not the person willing to press Save first.
     *
     * So the target is not a higher bar than the graph path. It is **the same
     * bar**, which is what makes the scope on this route honest:
     *
     * - a principal, so this is not the one anonymous door into the runner;
     * - at least one write grant, because that is exactly what the graph path
     *   costs (`assertMayWriteTypes` over the sinks) and `catalog.principal.ts`
     *   is entitled to keep claiming that `writeTypes` bounds what a
     *   `catalog:write` holder can cause. A principal granted no type can cause
     *   no load on any other route on this surface, and this was the one place
     *   it could still cause code to run;
     * - a person, via {@link RequireHuman}. A nightly publisher has no reason to
     *   open a try pane, and a machine key is the credential that leaks — the
     *   `StaticKeyPrincipalResolver` docblock says so itself, "long-lived,
     *   revoked only by redeploying". Holding one should not buy code execution
     *   in a single POST that stores nothing.
     *
     * The residual is deliberate and is written down where a host reads it
     * rather than only here: **anyone who may write any type can run code in
     * this process.** That is the trust model `SubprocessTransformRunner`
     * describes, and the supported way to change it is to bind a different
     * `TransformRunner`. See the pipeline README.
     *
     * ## Why the checks are in the handler and not only in the decorators
     *
     * `@RequireScopes` and `@RequireHuman` are declarations for a guard the host
     * wrote — that split is the whole of `catalog.route-auth.ts`. Scopes are
     * safe to leave there because every host guard already reads them. `REQUIRES_HUMAN`
     * had, until this route, never been on a single route in this repository, so
     * a host guard has had nothing to implement it against and most will not
     * have. Shipping the decorator as the only control would be shipping a
     * sentence that is true of the metadata and false of the deployment. The
     * grant has the same problem for a different reason: no guard can evaluate
     * it, because "holds at least one write grant" is not a scope. Both are
     * therefore checked where the principal is in hand, exactly as
     * `assertMayCommit` is.
     */
    @Post('transforms/try')
    @RequireScopes('catalog:write')
    @RequireHuman()
    async tryTransform(
      @Req() request: { principal?: CatalogPrincipal },
      @Body()
      body: {
        // `string`, not the two literals it used to name. That annotation was
        // the type system asserting something only a check can: the value comes
        // off the wire, `typescript` is a supported language it silently
        // excluded, and anything at all could arrive. Narrowed below, the way
        // `saveTransform` and `saveConnector` narrow theirs.
        language: string;
        code: string;
        records?: unknown[];
      },
    ) {
      const principal = requirePrincipal(request);
      this.assertMayRunCode(principal);
      // Validated exactly as `saveTransform` validates it. Without this an
      // unknown language fell through to the runner's `language === 'python'`
      // test and ran as JavaScript, so a typo produced a parse error about
      // somebody else's syntax.
      if (!isTransformLanguage(body.language)) {
        throw new BadRequestException(
          `"${body.language}" is not a transform language. Accepted: ${TRANSFORM_LANGUAGES.join(', ')}.`,
        );
      }
      const language = body.language;

      // Said out loud, for the same reason `connections/check` says what it did:
      // this route stores nothing — no transform row, no run row, nothing to
      // read back afterwards — so the log line is the only record that code ran
      // in this process, and on whose say-so.
      this.logger.log(
        `${principal.id} ran an unsaved ${language} transform against ${body.records?.length ?? 0} sample record(s).`,
      );

      try {
        return await this.transforms.run({ language, code: body.code }, body.records ?? [], {
          timeoutMs: 10_000,
        });
      } catch (error) {
        // A failing transform is the author's mistake, not the server's. Letting
        // it become a 500 hides the one thing they need — the timeout, the
        // exception, the line — behind "Internal server error".
        throw new BadRequestException(error instanceof Error ? error.message : String(error));
      }
    }

    /**
     * The graphs, with every source node's credential taken out.
     *
     * Served verbatim before, and the word was load-bearing in the right way and
     * wrong in one. Right: the view that used to sit here flattened a source
     * down to a connector id, renamed `name` to `label`, and turned a missing
     * position into the origin — three lies the screen then repeated back, one
     * of which would have erased a source's configuration on the next save.
     * Every field still arrives as stored.
     *
     * Wrong about the credential. A {@link WorkflowSourceNode} "carries the same
     * vocabulary a connector does — a kind, an optional named connection, a
     * config", says so in its own docblock, and means it: `config.url` on an
     * inline SQL source is `postgres://user:pass@host/db`, the same string
     * `config-secrets.ts` was written because `GET connections` and
     * `GET connectors` were serving. Those two got `redactConnection` and
     * `redactConnector` and this one did not, so the softest scope in the system
     * kept reading the strongest secret in it — through the one route nobody had
     * thought of as a connector route.
     *
     * The nesting is worth being exact about, because `config-secrets.ts` states
     * a boundary that sounds like it excludes this: "top-level string values
     * only", and a node sits inside a workflow. It does not exclude it. What that
     * boundary refuses is *descending into* a config —
     * `config.headers.authorization` stays untouched. A source's `config` is a
     * config, whole, and its `url` is a top-level string of it. Handing each node's
     * own config to the same helper is the covered case, not the excluded one; a
     * secret nested inside one is as untouched here as it is on a connector, and
     * for the same stated reason.
     */
    @Get('workflows')
    @RequireScopes('catalog:read')
    async workflowList() {
      const store = this.workflows.requireStore();
      return (await store.listWorkflows()).map(redactWorkflow);
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
      // The other half of redacting the read, and useless without it. A console
      // reads a graph, drags one box, and posts the whole thing back — so what
      // it sends for a source's URL is the placeholder it was shown, and storing
      // that verbatim replaces a working credential with the word REDACTED. It
      // is the exact failure `restoreRedactedSecrets` was written for on
      // connectors, arriving one level down: matched per node id, because a node
      // id is unique within a workflow and is the only thing that survives a
      // rename, a move, or a re-order of the array.
      const stored = body.id ? await store.getWorkflow(body.id) : undefined;
      const saved = await store.saveWorkflow(
        {
          id: body.id,
          name,
          description:
            typeof body.description === 'string' && body.description.length > 0
              ? body.description
              : undefined,
          nodes: restoreWorkflowSecrets(graph.nodes, stored),
          edges: graph.edges,
        },
        principal.id,
      );
      // Redacted on the way back for the same reason the list is. Returning the
      // stored row means returning what `restoreWorkflowSecrets` just put back,
      // so an unredacted response here would hand the credential to any caller
      // willing to POST the graph they had just been shown — one request, and
      // the redaction on the read is undone.
      return redactWorkflow(saved);
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
    /**
     * May this principal cause code to run in this process, right now?
     *
     * Two questions, and they refuse for different reasons, so they answer
     * separately rather than behind one message. Somebody fixing a 403 needs to
     * know whether to ask for a grant or to stop using a service account.
     *
     * **A write grant on something.** Not on a named type, because a transform
     * names none — `saveTransform` argues that at length and is right about
     * storing one. Executing one is where the argument runs out: there is no
     * later sink to check, because there is no later. What is left to ask is the
     * question the graph path asks in aggregate — may this principal cause any
     * load at all — and an empty or absent `writeTypes` answers no. That is
     * `mayWrite`'s own reading of absence ("an unlisted type is a denied
     * write"), applied with no type to look up.
     *
     * **A person.** See {@link RequireHuman}, and the note on this route.
     *
     * `ForbiddenException` rather than the plain `Error` `requirePrincipal`
     * throws: reaching here means a real caller was refused, which is a 403 and
     * something they can act on, not a deployment fault.
     */
    private assertMayRunCode(principal: CatalogPrincipal): void {
      if (!hasScope(principal, 'catalog:write') || (principal.writeTypes?.length ?? 0) === 0) {
        throw new ForbiddenException(
          `${principal.id} is granted no object type to write, so running a transform is refused. Trying a transform executes it in this process; the bar is the one the graph path already charges — see the pipeline README.`,
        );
      }
      if (!principal.actor) {
        throw new ForbiddenException(
          `${principal.id} is an application, and trying a transform runs code in this process against no stored record of who asked. Take this route as a signed-in person, or save the transform and run it through a graph, which leaves one.`,
        );
      }
    }

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

/**
 * One graph, as a screen may see it.
 *
 * The sibling of `redactConnector`/`redactConnection`, and deliberately not
 * living beside them in `config-secrets.ts`: those take a catalog row and this
 * takes a graph, which is a pipeline shape that `config-secrets.ts` has no
 * reason to import. What it borrows is the part that is genuinely shared —
 * `redactConfigSecrets` over a single config object — so there is still exactly
 * one answer to "what counts as a secret in a config", and a rule added there
 * reaches source nodes without anybody remembering to come here.
 *
 * Only source nodes carry a `config`; the union makes that a narrowing rather
 * than a hopeful property check, which is why a transform or sink node is
 * returned as-is rather than spread.
 */
function redactWorkflow(workflow: CatalogWorkflow): CatalogWorkflow {
  return {
    ...workflow,
    nodes: workflow.nodes.map((node) =>
      node.kind === 'source' ? { ...node, config: redactConfigSecrets(node.config) } : node,
    ),
  };
}

/**
 * Put back every source credential the caller was only ever shown a redaction
 * of, node by node.
 *
 * Matched on node id and nothing else. Position in the array is not identity — a
 * canvas re-orders freely — and neither is the name, which is documented as
 * cosmetic. The id is the durable step name and is unique within the workflow,
 * so it is the only thing here that a save may not quietly change.
 *
 * A node the stored graph does not have is a **new** node, and passes through
 * untouched: there is no placeholder it could be standing for, so whatever
 * arrived is what was meant, and the store's own refusal is what decides whether
 * a fresh plaintext password may be written. That is exactly the `stored`-absent
 * branch of {@link restoreRedactedSecrets}, one level up.
 *
 * A node whose id matches something that is no longer a source — the id reused
 * for a sink, say — also passes through: there is no config on the other side to
 * have shown anybody.
 */
function restoreWorkflowSecrets(
  nodes: WorkflowNode[],
  stored: CatalogWorkflow | undefined,
): WorkflowNode[] {
  if (!stored) return nodes;
  const previous = new Map(stored.nodes.map((node) => [node.id, node]));
  return nodes.map((node) => {
    if (node.kind !== 'source') return node;
    const was = previous.get(node.id);
    if (was?.kind !== 'source') return node;
    return { ...node, config: restoreRedactedSecrets(node.config, was.config) };
  });
}
