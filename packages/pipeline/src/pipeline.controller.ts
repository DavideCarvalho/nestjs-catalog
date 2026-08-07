import { randomUUID } from 'node:crypto';
import {
  CATALOG_PIPELINE_STORE,
  CONNECTOR_KINDS,
  type CatalogCodeContext,
  type CatalogConnection,
  type CatalogConnector,
  type CatalogPipelineStore,
  type CatalogPrincipal,
  type CatalogReusableNode,
  type CatalogReusableNodeStore,
  type CatalogWorkflow,
  type CatalogWorkflowRelease,
  REUSABLE_NODE_KINDS,
  RequireHuman,
  RequireScopes,
  type ReusableNodeBody,
  SubprocessTransformRunner,
  TRANSFORM_LANGUAGES,
  TRANSFORM_MODES,
  type TransformLanguage,
  type TransformMode,
  type TransformResult,
  type TransformRunner,
  type WorkflowNode,
  curationActor,
  emitCatalog,
  hasScope,
  isConnectorKind,
  isReusableNodeBody,
  isTransformLanguage,
  isTransformMode,
  liveWorkflowVersion,
  nodeKindIsReusable,
  recordModeRefusal,
  reusableNodeBodyOf,
  supportsLoadExpectations,
  supportsReusableNodes,
  supportsTransformRevisions,
  supportsTransformStreaming,
  supportsWorkflowReleases,
} from '@dudousxd/nestjs-catalog';
import type { LoadExpectationInput } from '@dudousxd/nestjs-catalog/client';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  Logger,
  NotFoundException,
  Optional,
  Param,
  Post,
  Put,
  Query,
  Req,
  type Type,
  UseGuards,
} from '@nestjs/common';
import {
  CATALOG_PIPELINE_ENVIRONMENT,
  type CatalogEnvironmentNameResolver,
  allowlistedCodeEnv,
  codeContext,
  namedEnvironment,
} from './code-context';
import {
  redactConfigSecrets,
  redactConnection,
  redactConnector,
  restoreRedactedSecrets,
} from './config-secrets';
import { ConnectionChecker } from './connection-checker.service';
import {
  CATALOG_LOAD_EXPECTATIONS,
  type CatalogLoadExpectations,
  hostLockedFields,
  hostOwnedFields,
  refuseInvalidLoadExpectation,
  resolveLoadExpectation,
} from './load-expectations';
import { discoverSourceSchema } from './schema-discovery';
import { CATALOG_PIPELINE_REGISTRY, type CatalogPipelineRegistry } from './seams';
import { resolveSecret } from './sources';
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
      // The strongest layer of the load policy, read-only here. This controller
      // never writes it — a host declares it in code — but every one of the four
      // expectation routes has to report it: the resolved answer, which fields
      // this deployment has pinned, and the 409 that stops an edit from being
      // accepted and then silently overruled.
      @Optional()
      @Inject(CATALOG_LOAD_EXPECTATIONS)
      private readonly expectations?: CatalogLoadExpectations,
      // The host's name for this copy of the world, read only by the try pane
      // so that the context it hands sample code is the one a real run would
      // hand it. Optional for the same reason it is optional on the two
      // runners: nobody can work it out from here, and an absent name is a
      // truthful answer.
      @Optional()
      @Inject(CATALOG_PIPELINE_ENVIRONMENT)
      private readonly environmentName?: CatalogEnvironmentNameResolver,
    ) {}

    /**
     * The store, narrowed, or a sentence saying this deployment cannot.
     *
     * A refusal rather than an empty list, and the difference matters most on
     * the read routes: an empty picker and "this deployment does not hold
     * reusable nodes" look identical to somebody who has never seen one, and the
     * first invites them to keep looking for the button. The same distinction
     * `transforms/:id/revisions` draws between a store that keeps no history and
     * a transform that has never changed.
     */
    private requireReusableNodes(): CatalogPipelineStore & CatalogReusableNodeStore {
      if (!supportsReusableNodes(this.pipeline)) {
        throw new BadRequestException(
          "This catalog's pipeline store cannot hold reusable nodes, so a node saved here would exist nowhere. Every node of a graph is configured in place in this deployment.",
        );
      }
      return this.pipeline;
    }

    /**
     * The store, narrowed to one that can hold a release and be pointed at one.
     *
     * The same shape as {@link requireReusableNodes} above and for the same
     * reason: the members are optional so a store written before releases
     * existed still compiles, which makes "this deployment cannot hold releases"
     * a sentence somebody can read rather than a `TypeError` on a route they
     * pressed.
     */
    private requireReleases() {
      const store = this.pipeline;
      if (!supportsWorkflowReleases(store)) {
        throw new BadRequestException(
          'The pipeline store configured here cannot hold workflow releases, so there is no version to freeze and nothing to point a schedule at. Graphs on this deployment run whatever their latest save holds.',
        );
      }
      return store;
    }

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
     * What a call node could be pointed at, as the live fleet reports it.
     *
     * Its own route rather than a field on `capabilities`, and the reason is
     * cache lifetime rather than tidiness. `capabilities` reports what resolved
     * in this process — which languages the image can execute, whether a durable
     * engine is wired up — none of which can change without a redeploy, so the
     * console caches it forever and is right to. This answer is a snapshot of
     * live workers with a resolution of about one heartbeat: a worker that dies
     * drops off it within half a minute. Folded into the cached-forever payload
     * it would be a list of workers that were alive when the tab was opened,
     * presented as the fleet.
     *
     * Read on demand, and nothing here holds it between calls. The engine's own
     * `announcedWorkflows` is one advertisement scan per call by design, and a
     * cache in front of it would reintroduce exactly the staleness the TTL on
     * the descriptor keys exists to bound.
     *
     * `catalog:read`, like every other read on this controller. It exposes what
     * a deployment's workers announce about themselves — names, versions, worker
     * groups — which is the same class of operational fact `connectors` and
     * `capabilities` already answer with, and it starts nothing.
     *
     * **A literal segment, so it is declared with the other literals** and above
     * anything that could capture it. There is no `:param` route at this
     * position today; `pipeline.route-order.spec.ts` is what keeps that true.
     */
    @Get('callable-workflows')
    @RequireScopes('catalog:read')
    callableWorkflows() {
      return this.launcher.callableWorkflows();
    }

    /**
     * Every expectation an operator has stored, and every type this deployment
     * has pinned in code.
     *
     * Both halves, because either alone is misleading. The stored rows without
     * the locks would let a screen offer an edit that can never take effect; the
     * locks without the rows would say what is fixed and not what anybody chose.
     *
     * **Declared before `expectations/:type`**, and every literal segment on
     * this controller has to be — Nest matches in declaration order and a `:param`
     * captures a literal happily. This pair is safe on its own (one segment
     * against two), and the sweep in `pipeline.route-order.spec.ts` is what keeps
     * the next route added under here safe as well; `connections/check` above is
     * the case where getting it wrong already cost something.
     *
     * `supported: false` rather than a refusal, unlike `transforms/:id/revisions`
     * one screen over, and the difference is what the caller can do about it.
     * A store that keeps no revisions makes that route answerless. Here the host
     * layer still resolves and is still worth showing, so refusing would blank a
     * screen that has something true to draw — while an empty list on its own
     * cannot tell "this deployment cannot store these" from "nobody has set
     * one", which is the distinction that route was written to preserve.
     */
    @Get('expectations')
    @RequireScopes('catalog:read')
    async loadExpectations() {
      const supported = supportsLoadExpectations(this.pipeline);
      const stored = supported ? await this.pipeline.listLoadExpectations() : [];
      const hostLocked: Record<string, { deletes: boolean; rowCount: boolean }> = {};
      for (const typeName of Object.keys(this.expectations?.byType ?? {})) {
        // Through the same helper the resolver locks with, so this list and the
        // `hostLocked` on a single type can never disagree about what is pinned.
        const locked = hostLockedFields(this.expectations, typeName);
        if (locked.deletes || locked.rowCount) hostLocked[typeName] = locked;
      }
      return { supported, stored, hostLocked };
    }

    /**
     * The expectation actually in force for one type, and where each field came
     * from.
     *
     * The provenance is the reason this is not simply the merged object. Three
     * layers decide it — the host's entry for the type, then the operator's
     * stored row, then the host's house-wide default — and a screen handed only
     * the answer would let somebody edit a field this deployment has pinned and
     * watch the edit disappear on the next read with nothing saying why.
     *
     * Answers for a type the registry has never heard of, deliberately. An
     * expectation is a statement about a NAME, it is legitimately written before
     * the first load creates the type, and 404-ing here would make the screen
     * that sets one unusable at exactly the moment it is needed.
     */
    @Get('expectations/:type')
    @RequireScopes('catalog:read')
    loadExpectation(@Param('type') typeName: string) {
      return resolveLoadExpectation(this.expectations, this.pipeline, typeName);
    }

    /**
     * Set what this catalog expects of loads into one type.
     *
     * ## Why this route exists
     *
     * `CATALOG_LOAD_EXPECTATIONS` was the only way to declare a delete strategy,
     * so making an incremental load of a type legal took an engineer and a
     * deploy — for a connector somebody had just created in the UI. What the
     * control was ever after is that **somebody chose a strategy and wrote down
     * why**; that needs attribution and visibility, not compilation. So the row
     * carries who set it and when, and the whole thing is on the Model screen.
     *
     * ## `catalog:curate`, and a person
     *
     * `catalog:curate` because that is already the scope for statements the
     * catalog makes about a type — `PATCH types/:name` is the same act on the
     * same grain. {@link RequireHuman} because `because` is a sentence somebody
     * is accountable for: an application key has no author, and attribution is
     * the point rather than a side effect. That is checked in the handler as
     * well as declared, for the reason `transforms/try` sets out at length —
     * `REQUIRES_HUMAN` is metadata for a guard the host wrote, and most hosts
     * have not written it, so the decorator alone would be a sentence that is
     * true of the metadata and false of the deployment.
     *
     * ## What it refuses
     *
     * A field the host has declared in code is refused with **409** naming that
     * field, rather than stored and then quietly overruled by the precedence
     * rule. A body that could never be honoured is refused with **400** naming
     * the field — see {@link refuseInvalidLoadExpectation} for why that is
     * checked here as well as at the load.
     *
     * ## Merged over the stored row, not replacing it
     *
     * An absent field means "leave it alone", so a form that renders only the
     * delete strategy cannot silently drop a row-count bound somebody set.
     * Clearing is `DELETE`, which is a decision with a verb on it.
     */
    @Put('expectations/:type')
    @RequireScopes('catalog:curate')
    @RequireHuman()
    async saveLoadExpectation(
      @Req() request: { principal?: CatalogPrincipal },
      @Param('type') typeName: string,
      @Body() body: LoadExpectationInput,
    ) {
      const principal = requirePrincipal(request);
      this.assertIsPerson(principal, typeName);
      if (!supportsLoadExpectations(this.pipeline)) {
        throw new BadRequestException(
          `This catalog's pipeline store cannot hold per-type load expectations, so there is nowhere to write one for ${typeName}. Declare it under CATALOG_LOAD_EXPECTATIONS in this deployment's configuration instead.`,
        );
      }

      const input: LoadExpectationInput = {
        ...(body?.deletes !== undefined ? { deletes: body.deletes } : {}),
        ...(body?.rowCount !== undefined ? { rowCount: body.rowCount } : {}),
      };
      if (input.deletes === undefined && input.rowCount === undefined) {
        throw new BadRequestException(
          `Nothing to set for ${typeName}: send "deletes", "rowCount", or both. An empty write would record a decision nobody made — to drop what is stored, use DELETE.`,
        );
      }

      const invalid = refuseInvalidLoadExpectation(input);
      if (invalid) throw new BadRequestException(invalid);

      const owned = hostOwnedFields(this.expectations, typeName, input);
      if (owned.length > 0) {
        throw new ConflictException(
          `This deployment declares ${owned.join(' and ')} for ${typeName} in code, under CATALOG_LOAD_EXPECTATIONS, and a host declaration wins over a stored one — so storing this would change nothing. Change it where it is declared, or drop ${owned.join(' and ')} from this request.`,
        );
      }

      // Merged over whatever is stored, per this route's docblock: the store's
      // `saveLoadExpectation` takes the whole expectation, so the merge has to
      // happen on this side of it.
      const stored = await this.pipeline.getLoadExpectation(typeName);
      const saved = await this.pipeline.saveLoadExpectation(
        typeName,
        {
          deletes: input.deletes ?? stored?.deletes,
          rowCount: input.rowCount ?? stored?.rowCount,
        },
        principal.id,
        principal.actor?.id,
      );

      // The same event a rename of this type emits, with the same key for the
      // actor. `type.curated` is what a recorder lifts into the audit table's
      // indexed columns, and a second event name for the same grain would put
      // the more consequential decision on the feed nobody is subscribed to.
      emitCatalog('type.curated', {
        typeName,
        changed: Object.keys(input).map((field) => `expectation.${field}`),
        principalId: curationActor(principal.id),
      });
      this.logger.log(
        `${principal.id} set the load expectation for ${typeName} (${Object.keys(input).join(', ')}).`,
      );
      return saved;
    }

    /**
     * Drop the stored row for a type. The host layer is untouched.
     *
     * Untouched because it is not this route's to touch: `host.byType` and
     * `host.default` are declared in code, and a `DELETE` that appeared to clear
     * them would be a request that reports success and changes nothing on the
     * next boot. What comes back is the expectation now in force, so the caller
     * sees what deleting actually left behind rather than assuming it left
     * nothing — a type sitting on a house-wide default is the common case.
     *
     * `catalog:curate` and a person, exactly as the write is: withdrawing a
     * declaration is as consequential as making one — it is what puts a type
     * back to having every incremental load refused — and an audit trail that
     * recorded who set a policy but not who removed it answers half the
     * question.
     */
    @Delete('expectations/:type')
    @RequireScopes('catalog:curate')
    @RequireHuman()
    async clearLoadExpectation(
      @Req() request: { principal?: CatalogPrincipal },
      @Param('type') typeName: string,
    ) {
      const principal = requirePrincipal(request);
      this.assertIsPerson(principal, typeName);
      if (!supportsLoadExpectations(this.pipeline)) {
        throw new BadRequestException(
          `This catalog's pipeline store cannot hold per-type load expectations, so there is none stored for ${typeName} to drop.`,
        );
      }

      const cleared = await this.pipeline.clearLoadExpectation(typeName);
      if (cleared) {
        emitCatalog('type.curated', {
          typeName,
          changed: ['expectation.cleared'],
          principalId: curationActor(principal.id),
        });
        this.logger.log(`${principal.id} dropped the stored load expectation for ${typeName}.`);
      }
      return {
        cleared,
        remaining: await resolveLoadExpectation(this.expectations, this.pipeline, typeName),
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

    /**
     * Which pipelines read through this connection.
     *
     * `connectors` before, and the rename is the question actually being asked
     * rather than a tidy-up. An operator presses this before deleting a
     * connection, and what they need is the list of things that would break —
     * which is a list of workflows, because a workflow is the only thing anybody
     * authors now and a connector's name is an implementation detail of one.
     *
     * Two places name a connection and both are searched. A source node may
     * carry a `connectionId` of its own, and it may instead name a connector in
     * `config.connectorId` and inherit that connector's — `resolveSourceNode`
     * folds either in, so a list built from only the first would clear a
     * connection for deletion that a running graph reaches through the second.
     */
    @Get('connections/:id/workflows')
    @RequireScopes('catalog:read')
    async connectionUsers(@Param('id') id: string) {
      const store = this.workflows.requireStore();
      const viaConnector = new Set(
        (await this.pipeline.connectorsUsingConnection(id)).map((connector) => connector.id),
      );

      const using = [];
      for (const workflow of await store.listWorkflows()) {
        const reached = reachesConnection(workflow, id, viaConnector);
        if (reached) {
          using.push({
            id: workflow.id,
            name: workflow.name,
            status: workflow.status,
            through: reached,
          });
        }
      }
      return using;
    }

    @Delete('connections/:id')
    @RequireScopes('catalog:write')
    deleteConnection(@Param('id') id: string) {
      return this.pipeline.deleteConnection(id).then((deleted: boolean) => ({ deleted }));
    }

    /**
     * The internal records, read-only. Redacted as `connections` is.
     *
     * The one connector route left, and it is a read. There is no `POST` and no
     * `DELETE` any more: a connector is what a published workflow runs as, minted
     * by `POST workflows/:id/publish` and removed with the graph, so a route that
     * created one would be the second way to author a pipeline that this whole
     * change exists to remove.
     *
     * It stays served rather than being hidden, because it is the answer to
     * questions a graph cannot answer about itself: which id a run history and a
     * watermark are actually keyed on, and — on a deployment upgraded rather
     * than built fresh — which rows belong to no graph at all. Nothing turns
     * those into workflows, so this is the only surface they appear on, and an
     * internal record that no route exposes is one an operator debugs by opening
     * the database.
     */
    @Get('connectors')
    @RequireScopes('catalog:read')
    async connectors() {
      return (await this.pipeline.listConnectors()).map(redactConnector);
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
        /**
         * `string | undefined`, narrowed below, for the reason `language` is:
         * the value comes off the wire and anything at all can arrive.
         *
         * **Absent is not `'batch'` here**, and the difference is what keeps an
         * older client from silently undoing a deliberate choice: a caller
         * written before this field existed sends no mode, and the store leaves
         * the stored one alone rather than resetting it.
         */
        mode?: string;
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
      if (body.mode !== undefined && !isTransformMode(body.mode)) {
        throw new BadRequestException(
          `"${body.mode}" is not a transform mode. Accepted: ${TRANSFORM_MODES.join(', ')}.`,
        );
      }
      const mode = body.mode;
      // Refused here so the author is told while they are still looking at the
      // code. The runner asks the same question again, because a row can reach
      // it that never passed through this build's controller — see
      // `recordModeRefusal`.
      const refusal = recordModeRefusal({ language: body.language, code: body.code, mode });
      if (refusal) throw new BadRequestException(refusal);
      return this.pipeline.saveTransform({ ...body, language: body.language, mode }, principal.id);
    }

    @Delete('transforms/:id')
    @RequireScopes('catalog:write')
    deleteTransform(@Param('id') id: string) {
      return this.pipeline.deleteTransform(id).then((deleted: boolean) => ({ deleted }));
    }

    /**
     * Every version of this transform's code, newest first.
     *
     * The route that makes `code v3` in the runs list mean something. A run
     * records `transformVersion`; a transform row holds only its latest code; so
     * until this existed the console named a version of something already
     * overwritten. The version on a run and the version on a revision here are
     * the same number, which is the whole contract.
     *
     * `catalog:read`, the same scope `GET transforms` asks for — that route
     * already hands back the current `code` in full, so gating an older copy of
     * the same field harder would be gating the diff rather than the data.
     * Writing code stays `catalog:write`, as the note on this controller says.
     *
     * Declaration order is not load-bearing here: the only literal sibling under
     * `transforms/` is `transforms/try`, which is a POST and so cannot be
     * captured by a GET `:id`.
     *
     * A store that keeps no revisions is told apart from a transform with no
     * history, and answers differently. Both come back as an empty list
     * otherwise, and a screen would draw "we do not keep these" and "this has
     * never changed" identically.
     */
    @Get('transforms/:id/revisions')
    @RequireScopes('catalog:read')
    transformRevisions(@Param('id') id: string) {
      if (!supportsTransformRevisions(this.pipeline)) {
        throw new BadRequestException(
          "This catalog's pipeline store keeps no revisions, so a transform's code can be read but not compared with the version a run recorded.",
        );
      }
      return this.pipeline.listTransformRevisions(id);
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
        /** Which contract to run the sample under. Narrowed below, as `language` is. */
        mode?: string;
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
      if (body.mode !== undefined && !isTransformMode(body.mode)) {
        throw new BadRequestException(
          `"${body.mode}" is not a transform mode. Accepted: ${TRANSFORM_MODES.join(', ')}.`,
        );
      }
      const mode = body.mode;
      // The pane must refuse exactly what save refuses, and with the same
      // sentence. A try that ran code the save would reject is a pane that
      // teaches the author their transform works.
      const tryRefusal = recordModeRefusal({ language, code: body.code, mode });
      if (tryRefusal) throw new BadRequestException(tryRefusal);

      // Said out loud, for the same reason `connections/check` says what it did:
      // this route stores nothing — no transform row, no run row, nothing to
      // read back afterwards — so the log line is the only record that code ran
      // in this process, and on whose say-so.
      this.logger.log(
        `${principal.id} ran an unsaved ${language} transform against ${body.records?.length ?? 0} sample record(s).`,
      );

      const records = body.records ?? [];
      // The same admitted environment a real run gets, and deliberately so.
      // The try pane's entire value is that it predicts what the load will do,
      // and a pane where `context.env.VENDOR_TOKEN` is `undefined` and the
      // scheduled run's is not would send its author looking for a bug in
      // their code. The disclosure costs nothing that is not already spent:
      // this route is reached only by a human principal holding a write grant,
      // which is precisely the principal who could save the same code onto a
      // graph and read the same values out of a run log.
      //
      // No `runId`, and no invented stand-in for one: nothing is stored here,
      // so code deriving a key from the run is meant to see the absence.
      const admitted = allowlistedCodeEnv();

      const options = {
        timeoutMs: 10_000,
        context: codeContext({
          environment: namedEnvironment(this.environmentName),
          rowCount: records.length,
          inputs: [],
          env: admitted.env,
        }),
      };

      try {
        // Run under the contract the transform declares, not under whichever one
        // the pane finds convenient. A per-record transform tried through `run`
        // would be handed the whole array as its `record`, read `undefined` off
        // every property, and show the author a pane full of empty rows for code
        // that is perfectly correct — which is the same silent mismatch
        // TRANSFORM_MODES exists to prevent, arriving through the one screen
        // whose entire value is that it predicts what the load will do.
        //
        // Collected into an array here, and only here: a sample is a handful of
        // records the author pasted, and the pane has to render every row
        // anyway. Nothing about the streaming path's memory bound is being
        // spent, because there is nothing to bound.
        const result =
          mode === 'record'
            ? await tryStreamed(
                this.transforms,
                { language, code: body.code, mode },
                records,
                options,
              )
            : await this.transforms.run({ language, code: body.code }, records, options);
        // In front of the transform's own lines, matching where the runners put
        // them: the note is about the conditions the code ran under, and a
        // reader works down from those to what it said.
        return { ...result, logs: [...admitted.notes, ...result.logs] };
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
    /**
     * Which graphs run this transform, and at which node.
     *
     * The question the maintainer actually asked — "how many places use this
     * node" — pointed at the only shared object that already existed. It is
     * answerable at all because a transform node references code **by id**
     * rather than carrying a copy of it, which is the same property
     * `reusable-nodes/:id/workflows` depends on one route down and the reason
     * saving a node as reusable does not deep-copy.
     *
     * Shaped after `connections/:id/workflows` rather than inventing a third
     * shape for the third thing that answers this. What differs is the grain: a
     * connection reports each graph once, because deleting it breaks a graph
     * exactly once, and this reports each *node*, because whoever is reading it
     * is about to edit code and three nodes in one graph are three places it
     * lands. `pinned` is what turns the count into a decision — an unpinned node
     * moves the moment this is saved, a pinned one does not.
     *
     * Declared above `transforms/:id/revisions`? No: literal segments beat
     * parameters in Nest's matcher only within the same position, and these two
     * differ in the *third* segment, so neither can shadow the other.
     */
    @Get('transforms/:id/workflows')
    @RequireScopes('catalog:read')
    async transformUsers(@Param('id') id: string) {
      const store = this.workflows.requireStore();
      const using = [];
      for (const workflow of await store.listWorkflows()) {
        for (const node of workflow.nodes) {
          if (node.kind !== 'transform' || node.transformId !== id) continue;
          using.push({
            workflowId: workflow.id,
            workflowName: workflow.name,
            status: workflow.status,
            nodeId: node.id,
            nodeName: node.name,
            pinnedVersion: node.transformVersion,
          });
        }
      }
      return using;
    }

    /**
     * The reusable nodes, each with the number of places it is used.
     *
     * The count is on the list rather than behind a second request per entry,
     * and that is the whole design of this feature rather than a convenience.
     * There is deliberately no library screen — the maintainer was explicit that
     * reusable nodes belong where a node is added, not in a tab — so this list
     * IS the picker, and a number that changes somebody's decision has to be on
     * the row they are about to click. A count fetched lazily per row would
     * arrive after the click.
     *
     * Redacted like `connections` and `connectors`, and for the identical
     * reason: a reusable **source** body carries the same `config.url` those
     * two were redacted for. The softest scope in the system must not read the
     * strongest secret in it through whichever route was thought of last.
     */
    @Get('reusable-nodes')
    @RequireScopes('catalog:read')
    async reusableNodes() {
      const store = this.requireReusableNodes();
      const nodes = await store.listReusableNodes();
      const listed = [];
      for (const node of nodes) {
        listed.push({
          ...redactReusableNode(node),
          usedBy: (await store.reusableNodeUses(node.id)).length,
        });
      }
      return listed;
    }

    /** Which graphs use this reusable node, and at which node within each. */
    @Get('reusable-nodes/:id/workflows')
    @RequireScopes('catalog:read')
    reusableNodeUsers(@Param('id') id: string) {
      return this.requireReusableNodes().reusableNodeUses(id);
    }

    /**
     * Save a node body under a name, or edit one that already exists.
     *
     * ## No per-type check, and that is not an oversight
     *
     * A reusable **sink** body names an object type, and this route does not ask
     * whether the caller may write it. The same argument `saveTransform` makes
     * one route up applies with one extra step: nothing here commits anything.
     * A body only becomes a load when a graph adopts it, and `POST workflows`
     * calls `assertMayWriteTypes` over that graph's sinks — with the resolved
     * type, because `saveWorkflow` folds before it validates. `applyReusableNode`
     * then refuses to let the type move under a graph afterwards. So the grant
     * check is at the place that can enforce it, once, and gating this route as
     * well would stop somebody naming a type they cannot write while changing
     * nothing about who can load into it.
     *
     * ## Editing something other graphs use creates a version
     *
     * It does not refuse. See `CatalogPipelineStore.saveReusableNode` for why
     * refusing would let a pin take a shared node hostage. What the editor gets
     * instead is `reusable-nodes/:id/workflows`, read at the moment they are
     * about to press save.
     */
    @Post('reusable-nodes')
    @RequireScopes('catalog:write')
    async saveReusableNode(
      @Req() request: { principal?: CatalogPrincipal },
      @Body() body: { id?: string; name?: unknown; description?: unknown; body?: unknown },
    ) {
      const principal = requirePrincipal(request);
      const store = this.requireReusableNodes();
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) {
        throw new BadRequestException(
          'A reusable node needs a name. It is what somebody types when they reach for it while drawing a graph, so an unnamed one could never be found.',
        );
      }
      if (!isReusableNodeBody(body.body)) {
        throw new BadRequestException(
          `"${name}" was sent with a body this service cannot execute. A reusable node stands for a source — which needs a source kind and a config — or for a sink, which needs the object type it commits.`,
        );
      }
      // The other half of redacting the read, exactly as `saveWorkflow` does one
      // level up: a console reads a reusable source, edits its query, and posts
      // the whole body back — so what it sends for the URL is the placeholder it
      // was shown, and storing that verbatim would replace a working credential
      // with the word REDACTED.
      const stored = body.id ? await store.getReusableNode(body.id) : undefined;
      const saved = await store.saveReusableNode(
        {
          id: body.id,
          name,
          description:
            typeof body.description === 'string' && body.description.length > 0
              ? body.description
              : undefined,
          body: restoreReusableNodeSecrets(body.body, stored),
        },
        principal.id,
      );
      return redactReusableNode(saved);
    }

    /**
     * Refuses while any graph still uses it, and the refusal names them.
     *
     * The store makes the refusal rather than this route, so a host reaching the
     * store directly gets it too — the same arrangement `deleteConnection` has.
     */
    @Delete('reusable-nodes/:id')
    @RequireScopes('catalog:write')
    deleteReusableNode(@Param('id') id: string) {
      return this.requireReusableNodes()
        .deleteReusableNode(id)
        .then((deleted: boolean) => ({ deleted }));
    }

    /**
     * Lift one node of a graph into a reusable node, by reference.
     *
     * The gesture the maintainer asked for — "salvar nós reutilizáveis" — and it
     * lives beside `workflows/:id/nodes/:nodeId/discover` because it is the same
     * shape of thing: an action on one node of one graph.
     *
     * **It does not deep-copy, and it does not edit the graph either.** It
     * stores the body and answers with the reusable node; the caller then sets
     * `useId` on that node and saves the graph, which is one ordinary
     * `POST workflows` that bumps the graph's version and shows a diff. Doing
     * the edit here would mean a route that stores one thing and silently
     * rewrites another, and the graph's version would move for a reason its
     * author could not see in their own diff — which is the class of silence
     * this whole feature exists to end.
     *
     * The kind is checked here rather than trusted from the screen, because
     * `nodeKindIsReusable` is what a screen asks before offering the button and
     * a route that assumed the screen asked is a route that can be curled.
     */
    @Post('workflows/:id/nodes/:nodeId/save-as-reusable')
    @RequireScopes('catalog:write')
    async saveNodeAsReusable(
      @Req() request: { principal?: CatalogPrincipal },
      @Param('id') id: string,
      @Param('nodeId') nodeId: string,
      @Body() body: { name?: unknown; description?: unknown },
    ) {
      const principal = requirePrincipal(request);
      const store = this.requireReusableNodes();
      const workflow = await this.workflows.requireStore().getWorkflow(id);
      if (!workflow) throw new NotFoundException(`No workflow ${id}`);
      const node = workflow.nodes.find((candidate) => candidate.id === nodeId);
      if (!node) {
        throw new NotFoundException(`Workflow "${workflow.name}" has no node ${nodeId}.`);
      }
      if (!nodeKindIsReusable(node.kind)) {
        throw new BadRequestException(
          `"${node.name}" is a ${node.kind} node, and ${REUSABLE_NODE_KINDS.join(' and ')} nodes are the ones worth saving under a name. See REUSABLE_NODE_KINDS, which says why each of the others is not — the short version is that a transform and a call already reference a stored object, and a predicate is about the rows in front of it.`,
        );
      }
      const lifted = reusableNodeBodyOf(node);
      if (!lifted) {
        // Unreachable while the check above and `reusableNodeBodyOf` agree, and
        // refused rather than assumed for the reason every other narrowing on
        // this controller is: the two are in different packages and this is the
        // seam where a disagreement between them would otherwise become a 500.
        throw new BadRequestException(
          `"${node.name}" is a ${node.kind} node and this service could not lift a reusable body out of it.`,
        );
      }
      const name =
        typeof body.name === 'string' && body.name.trim().length > 0 ? body.name.trim() : node.name;
      const saved = await store.saveReusableNode(
        {
          name,
          description:
            typeof body.description === 'string' && body.description.length > 0
              ? body.description
              : undefined,
          // The stored graph's node, not the request's: the graph is where the
          // authoritative configuration lives, and lifting from a body the
          // caller sent would let one request store a source pointing somewhere
          // the graph never did, under a name four other graphs are about to
          // adopt.
          body: lifted,
        },
        principal.id,
      );
      return {
        reusableNode: redactReusableNode(saved),
        /**
         * What the caller has to do next, said out loud rather than left to be
         * inferred from the absence of a change: the node is not yet an instance
         * of anything until the graph is saved with this on it.
         */
        setOnNode: { nodeId: node.id, useId: saved.id },
      };
    }

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
    /**
     * Declare a graph finished.
     *
     * Its own route rather than a field on the save above, for the reason the
     * store's `publishWorkflow` argues: publishing is a claim that has to be
     * checked, and a check that fails owes an explanation naming the nodes. A
     * flag on the save has nowhere to put that which is not an error on an
     * operation the author thought was about something else — and an autosave
     * that silently published would make "ready" mean nothing at all.
     *
     * `catalog:write` and not something narrower. The graph's own sinks are
     * re-authorised here rather than trusted from save time, which is the same
     * case `workflows/:id/run` makes and for the same reason: a graph written
     * last month by a principal that could commit this type, published today by
     * one that cannot, is a load nobody with the grant ever approved.
     */
    @Post('workflows/:id/publish')
    @RequireScopes('catalog:write')
    async publishWorkflow(
      @Req() request: { principal?: CatalogPrincipal },
      @Param('id') id: string,
    ) {
      const principal = requirePrincipal(request);
      const store = this.workflows.requireStore();
      const workflow = await store.getWorkflow(id);
      if (!workflow) {
        throw new NotFoundException(
          `Workflow ${id} does not exist, so there is nothing to publish.`,
        );
      }
      assertMayWriteTypes(
        principal,
        committedTypes(workflow.nodes),
        `publishing workflow "${workflow.name}"`,
      );
      return store.publishWorkflow(id, principal.id);
    }
    /**
     * Take it back to draft, and be told what that stops.
     *
     * No type authorisation here, deliberately, and it is worth saying why the
     * asymmetry with publish is right rather than an oversight: unpublishing
     * cannot cause a load. It can only prevent one, and the store already
     * refuses while any connector still runs the graph — so the destructive
     * reading of this route is a refusal, not a write.
     */
    @Post('workflows/:id/unpublish')
    @RequireScopes('catalog:write')
    async unpublishWorkflow(
      @Req() request: { principal?: CatalogPrincipal },
      @Param('id') id: string,
    ) {
      const principal = requirePrincipal(request);
      const store = this.workflows.requireStore();
      return store.unpublishWorkflow(id, principal.id);
    }
    @Delete('workflows/:id')
    @RequireScopes('catalog:write')
    async deleteWorkflow(@Param('id') id: string) {
      const store = this.workflows.requireStore();
      return { deleted: await store.deleteWorkflow(id) };
    }
    /**
     * Run one now.
     *
     * **The only run route there is.** `POST connectors/:id/run` is gone with the
     * rest of the connector surface, and what it carried that this did not is
     * `expectShrink` — so that came here rather than being lost. See the note on
     * {@link CatalogWorkflowRunInput.expectShrink}: without it, deleting the
     * route would have deleted the only way an operator can re-drive a load the
     * row-count bound refused, and left them raising the bound in policy
     * instead — standing the guard down for every future load of the type rather
     * than for one snapshot.
     */
    @Post('workflows/:id/run')
    @RequireScopes('catalog:write')
    async runWorkflow(
      @Req() request: { principal?: CatalogPrincipal },
      @Param('id') id: string,
      @Body() body?: { snapshotId?: string; expectShrink?: string; version?: number },
    ) {
      const principal = requirePrincipal(request);
      const head = await this.workflows.requireWorkflow(id);
      // Resolved *before* the grant check, which is the whole reason this route
      // does the resolution rather than leaving it to the launcher. The check
      // below is over the types a graph commits, and the graph that runs may not
      // be the head: a live pointer at v3 whose sink writes a different type
      // than v9's would otherwise be authorised against v9 and executed as v3.
      const version = readRunVersion(body, head);
      const workflow =
        version === head.version ? head : await this.workflows.requireWorkflowAt(id, version);
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
        // Explicit, never left to be re-derived. The launcher would compute the
        // same number, and computing it twice is how the version that was
        // authorised and the version that ran come to differ by one save landing
        // between the two reads.
        version,
        // Almost always absent — the console posts an empty body. Present when
        // somebody is re-driving a load they already own the identity of.
        snapshotId: body?.snapshotId,
        // Forwarded, never defaulted, and the conditional spread is what keeps
        // the two states apart: absent means nobody said anything, and a present
        // empty string means somebody sent the field with nothing behind it,
        // which the sink refuses with a 400 asking for a reason. Flattening them
        // here would turn that refusal into silence.
        ...(body && 'expectShrink' in body ? { expectShrink: body.expectShrink } : {}),
      });
      return toRunView(workflow, run);
    }

    /**
     * Freeze this graph as it stands, so something can be pointed at it.
     *
     * ## Why releasing and going live are two routes and not one
     *
     * Because they are two decisions and the interesting deployments make them
     * at different times. Releasing says "this shape is worth keeping"; going
     * live says "this shape is what runs". A single route would mean the only
     * way to keep a version is to deploy it, which is the coupling this whole
     * change exists to break — and it would make releasing a candidate for
     * review impossible without shipping it first.
     *
     * It also keeps the blast radius of each route legible. **This one cannot
     * change what any load does.** It writes one immutable row; nothing reads it
     * until somebody presses the other route.
     *
     * Authorised like publishing rather than like reading, even though it
     * changes nothing that runs: a release is what a live pointer may name, so
     * minting one is a step on the path to a load, and the graph's own sinks are
     * re-checked here for the reason `publish` re-checks them.
     */
    @Post('workflows/:id/releases')
    @RequireScopes('catalog:write')
    async releaseWorkflow(
      @Req() request: { principal?: CatalogPrincipal },
      @Param('id') id: string,
      @Body() body?: { notes?: string },
    ) {
      const principal = requirePrincipal(request);
      const store = this.requireReleases();
      const workflow = await this.workflows.requireWorkflow(id);
      assertMayWriteTypes(
        principal,
        committedTypes(workflow.nodes),
        `releasing workflow "${workflow.name}"`,
      );
      return redactRelease(
        await store.releaseWorkflow(id, principal.id, {
          ...(typeof body?.notes === 'string' ? { notes: body.notes } : {}),
        }),
      );
    }
    /**
     * Every released version of this graph, newest first.
     *
     * Redacted node by node exactly as `GET workflows` is, and that is not
     * belt-and-braces: a release archives the graph as it was *stored*, which
     * means it holds whatever sealed credential the source node held, and a list
     * route that skipped the redaction would hand back through the history what
     * the read of the live graph is careful not to hand back directly.
     */
    @Get('workflows/:id/releases')
    @RequireScopes('catalog:read')
    async workflowReleases(@Param('id') id: string) {
      const store = this.requireReleases();
      return (await store.listWorkflowReleases(id)).map(redactRelease);
    }
    /**
     * Choose which released version this graph runs. **This is the deploy.**
     *
     * `PUT` because it sets a pointer to a value rather than appending anything,
     * and the same call is promotion, rollback and un-pinning — the last of
     * those by sending `null`, which is a decision somebody has to make
     * explicitly rather than an empty body meaning something.
     *
     * An absent `version` key is refused rather than read as `null`, for the
     * reason `PUT workflows/:id/schedule` refuses an empty write: the difference
     * between "run v6" and "go back to running whatever the canvas holds" is the
     * difference this whole feature is about, and a body that omitted the field
     * would resolve it by accident.
     *
     * Authorised like publishing and running, and this is the route where that
     * matters most — it is the one that decides what a cron executes, and the
     * grant is checked against the sinks of **the version being deployed**, not
     * of the head. A caller may not go live on a graph committing a type they
     * could not commit to themselves.
     */
    @Put('workflows/:id/live')
    @RequireScopes('catalog:write')
    async setLiveVersion(
      @Req() request: { principal?: CatalogPrincipal },
      @Param('id') id: string,
      @Body() body?: { version?: number | null },
    ) {
      const principal = requirePrincipal(request);
      const store = this.requireReleases();
      const head = await this.workflows.requireWorkflow(id);
      const version = readLiveVersion(body, head);

      // The graph that would run, checked before it is made to run. Reading it
      // also proves the release exists in a way that produces a graph rather
      // than merely a row — the store refuses an unreleased version too, and
      // this is the check that would catch a release whose nodes this build
      // cannot narrow.
      const deployed =
        version === undefined ? head : await this.workflows.requireWorkflowAt(id, version);
      assertMayWriteTypes(
        principal,
        committedTypes(deployed.nodes),
        version === undefined
          ? `clearing the live version of workflow "${head.name}"`
          : `setting workflow "${head.name}" live at v${version}`,
      );

      const saved = await store.setLiveWorkflowVersion(id, version, principal.id);
      if (version === undefined) {
        this.logger.warn(
          `"${saved.name}" now follows its latest save again, so editing it is once more the same thing as deploying it.`,
        );
      }
      return saved;
    }

    /**
     * Set when this graph runs, and whether it runs.
     *
     * The schedule moved here from the connector, which is the half of this
     * change with a live incident behind it: cron was silently broken for every
     * scheduled connector, and the symptom was a scheduler logging that it was
     * watching schedules while parsing nothing. So the route that writes one is
     * deliberately loud about the two ways a cron can be stored and still never
     * fire, and it answers with the workflow so a screen renders what was
     * actually stored rather than what it sent.
     *
     * `PUT` and its own route rather than fields on `POST workflows`, for the
     * reason {@link CatalogWorkflowStore.saveWorkflowSchedule} gives: a canvas
     * autosaves, and a cron folded into the save every drag passes through is
     * one a stale tab can silently revert.
     *
     * **Declared before `workflows/:id`**, as every literal under a `:param` on
     * this controller has to be. The sweep in `pipeline.route-order.spec.ts` is
     * what keeps that true for the next route added here.
     */
    @Put('workflows/:id/schedule')
    @RequireScopes('catalog:write')
    async scheduleWorkflow(
      @Req() request: { principal?: CatalogPrincipal },
      @Param('id') id: string,
      @Body() body: { schedule?: string; enabled?: boolean },
    ) {
      const principal = requirePrincipal(request);
      const store = this.workflows.requireStore();
      const workflow = await this.workflows.requireWorkflow(id);
      assertMayWriteTypes(
        principal,
        committedTypes(workflow.nodes),
        `scheduling workflow "${workflow.name}"`,
      );
      if (body?.schedule === undefined && body?.enabled === undefined) {
        throw new BadRequestException(
          `Nothing to set for "${workflow.name}": send "schedule", "enabled", or both. An empty write would record a decision nobody made — to stop it running, send enabled:false, which is a decision with a verb on it.`,
        );
      }

      const saved = await store.saveWorkflowSchedule(
        id,
        {
          ...(body.schedule !== undefined ? { schedule: body.schedule } : {}),
          ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        },
        principal.id,
      );

      const warning = scheduleWarning(saved);
      if (warning) this.logger.warn(warning);
      return { ...saved, warning };
    }

    /**
     * Ask one source node what its source looks like. Creates nothing.
     *
     * This was `POST connectors/:id/discover`, and it had to move rather than be
     * dropped: discovery is how a type gets its shape, and a type has to exist
     * before any sink can commit into it. The old route also could not have
     * survived on its own terms — `discoverConnectorSchema` refused outright when
     * a connector carried a `workflowId`, and every connector carries one now, so
     * it would have refused every connector there is.
     *
     * **Answers on a draft, deliberately.** Requiring a published graph would
     * require somebody to publish a graph whose target type they cannot create
     * until they have published it. That is the ordering this route exists to
     * break, so `requireWorkflow` and not `requireReadyWorkflow`.
     *
     * **It writes nothing, and it must stay that way.** Creating the type is a
     * separate act by a person against `PUT /publish/:type/schema`, which does
     * its own `mayWrite` check. A pipeline that created the type it loads into
     * would grow the catalog by accident, and the names it invented would come
     * from the shape of a query rather than from somebody who meant them.
     *
     * `POST` rather than `GET` for the same reason `connections/:id/check` is:
     * this reaches out over the network, takes as long as the source takes, and
     * is nobody's idea of a cacheable read.
     *
     * Authorised exactly as running the graph is, and that is not
     * belt-and-braces. Saving and running both require a grant on what the graph
     * commits, so a principal with `catalog:write` and no grants cannot cause the
     * server to read any source at all. Discovery without the same check would be
     * the first route that could: press it against somebody else's graph and the
     * answer is the column names of a database this caller was never allowed
     * near.
     */
    @Post('workflows/:id/nodes/:nodeId/discover')
    @RequireScopes('catalog:write')
    async discoverSchema(
      @Req() request: { principal?: CatalogPrincipal },
      @Param('id') id: string,
      @Param('nodeId') nodeId: string,
    ) {
      const principal = requirePrincipal(request);
      const workflow = await this.workflows.requireWorkflow(id);
      assertMayWriteTypes(
        principal,
        committedTypes(workflow.nodes),
        `discovering the schema behind a source in "${workflow.name}"`,
      );

      const node = workflow.nodes.find((candidate) => candidate.id === nodeId);
      if (!node) {
        throw new NotFoundException(
          `Workflow "${workflow.name}" has no node ${nodeId}, so there is nothing to describe.`,
        );
      }
      if (node.kind !== 'source') {
        throw new BadRequestException(
          `Node "${node.name}" is a ${node.kind} node. A source is the only kind whose shape this server can go and ask for — a transform's output shape is whatever its code returns, and the way to see that is to try it, and a call node's is whatever the workflow it hands off to decides to stage, which lives in another codebase and possibly another language. The way to see either is to run the graph.`,
        );
      }

      try {
        // Resolved through the runner's own method, so a discovery cannot fold a
        // connection in differently from the way the load will. See
        // `resolveSourceNode`.
        const { connector } = await this.workflows.resolveSourceNode(node);
        return await discoverSourceSchema({
          source: {
            workflowId: workflow.id,
            nodeId: node.id,
            nodeName: node.name,
            // The graph's sink type, not the node's — a source node has none.
            // Empty on a draft that has not drawn a sink yet, which reads back
            // as `typeExists: false` and is the honest answer: there is nothing
            // for the columns to have drifted from.
            targetType: workflow.targetType,
            reader: connector,
            transformed: workflow.nodes.some((other) => other.kind === 'transform'),
          },
          secret: resolveSecret(connector),
          // The registry, not the store: drift is measured against the type as
          // the engine currently sees it, which is the same object a load would
          // be written through.
          existing: workflow.targetType ? this.registry.getType(workflow.targetType) : undefined,
        });
      } catch (error) {
        // A source that refuses, a query that does not parse, a missing
        // credential: all of them are this graph's configuration, not the
        // server's fault, and a 500 would hide the one sentence that says which.
        throw new BadRequestException(error instanceof Error ? error.message : String(error));
      }
    }

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

    /**
     * Is there a person behind this request?
     *
     * The handler-side half of {@link RequireHuman} on the two expectation
     * writes, and it is the half that actually runs: the decorator is metadata
     * for a guard the host wrote, and `catalog.route-auth.ts` is explicit that
     * reading it is the host's job. `transforms/try` makes the same check for
     * the same reason and says so at length.
     *
     * What is being protected here is not permission — a machine key holding
     * `catalog:curate` is perfectly authorised — it is authorship. The row
     * records `setBy`, the reason field is a sentence, and "the nightly
     * publisher decided this dataset may accumulate deleted rows" is not an
     * answer to who decided it. `actor` is what says a person was behind the
     * principal; see `catalog.principal.ts`.
     */
    private assertIsPerson(principal: CatalogPrincipal, typeName: string): void {
      if (!principal.actor) {
        throw new ForbiddenException(
          `${principal.id} is an application, and a load expectation is a decision with a reason attached and a name against it — "${typeName} may accumulate rows deleted upstream, because…" is somebody's sentence. Take this route as a signed-in person, or declare it under CATALOG_LOAD_EXPECTATIONS in this deployment's configuration, which is reviewed.`,
        );
      }
    }
  }
  if (guards.length > 0) {
    UseGuards(...guards)(PipelineController);
  }

  return PipelineController;
}

/**
 * Why a stored schedule will not fire, when it will not.
 *
 * Said back to the caller rather than left to be inferred from a 200. A cron on
 * a draft is exactly the silent no-op this whole change is written against: the
 * row is written, the screen shows it, and the scheduler never touches it,
 * because only a `ready` graph is scheduled. The scheduler says the same thing
 * on its own tick — this is the half that reaches the person at the moment they
 * typed it, rather than a log line nobody is watching.
 *
 * `undefined` for a schedule that will fire, and for one that was cleared: a
 * warning about a graph carrying no cron would be a sentence about nothing.
 */
function scheduleWarning(workflow: CatalogWorkflow): string | undefined {
  if (!workflow.schedule) return undefined;
  if (workflow.status !== 'ready') {
    return `"${workflow.name}" is still a draft, so this schedule will not fire. Publish it — only a ready graph is scheduled.`;
  }
  if (!workflow.enabled) {
    return `"${workflow.name}" is disabled, so this schedule will not fire until it is enabled.`;
  }
  return undefined;
}

/**
 * Which of a graph's source nodes reaches a given connection, described.
 *
 * Both ways a node can name one, because there are two and checking only the
 * first would clear a connection for deletion that a running graph reaches
 * through the second: a node carries its own `connectionId`, **or** it names a
 * connector in `config.connectorId` and inherits that connector's.
 * `resolveSourceNode` folds either in at run time, so either is a real
 * dependency.
 *
 * Answers a sentence rather than a boolean, because "what breaks" is the
 * question and "the node called Warehouse, through connector abc" is an answer
 * somebody can act on. The first match wins: one graph appears once in the list
 * however many of its nodes reach the connection, since deleting it breaks the
 * graph exactly once.
 */
function reachesConnection(
  workflow: CatalogWorkflow,
  connectionId: string,
  connectorIds: ReadonlySet<string>,
): string | undefined {
  for (const node of workflow.nodes) {
    if (node.kind !== 'source') continue;
    if (node.connectionId === connectionId) return `"${node.name}"`;
    const named = node.config.connectorId;
    if (typeof named === 'string' && connectorIds.has(named)) {
      return `"${node.name}" via connector ${named}`;
    }
  }
  return undefined;
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
 * Source and **call** nodes carry a `config`; the union makes that a narrowing
 * rather than a hopeful property check, which is why a transform or sink node
 * is returned as-is rather than spread. A call node is in the list because the
 * store seals and opens its config exactly as it does a source's — this is the
 * read side of that decision, and leaving it out would hand back in plaintext
 * what the write side had refused to store in plaintext.
 */
/**
 * Which version `POST workflows/:id/run` should execute.
 *
 * Absent is the ordinary answer and means "whatever this graph is set to run":
 * the live version if one is set, the latest save otherwise. `liveWorkflowVersion`
 * is what decides, so this route and the scheduler cannot come to different
 * conclusions about which graph is deployed.
 *
 * Present is refused unless it is a whole number of at least one, and the
 * refusal is worth the four lines: the value arrives from a form, `"6"` is what
 * an unparsed field sends, and a string here would match no stored version and
 * be discovered by a load that stops rather than by the person who typed it.
 */
function readRunVersion(body: { version?: unknown } | undefined, head: CatalogWorkflow): number {
  const found = body?.version;
  if (found === undefined || found === null) return liveWorkflowVersion(head);
  if (typeof found !== 'number' || !Number.isInteger(found) || found < 1) {
    throw new BadRequestException(
      `"${head.name}" was asked to run version ${JSON.stringify(found)}, and a version is a whole number of at least 1. Leave it out to run whatever this graph is set to run.`,
    );
  }
  return found;
}

/**
 * Which version `PUT workflows/:id/live` should deploy — or none.
 *
 * `null` is a real answer here and `undefined` is not, which is the opposite of
 * every other optional field on this controller. Sending `null` means "stop
 * pinning this graph and go back to running its latest save", which is a
 * decision with consequences somebody should have to state; omitting the key
 * means the caller sent a body with no instruction in it, and reading that as
 * the un-pin would perform the most dangerous of the three operations by
 * default. So the omission is refused and the `null` is honoured.
 */
function readLiveVersion(
  body: { version?: unknown } | undefined,
  head: CatalogWorkflow,
): number | undefined {
  if (!body || !('version' in body)) {
    throw new BadRequestException(
      `Nothing to set for "${head.name}": send "version" with the released version to run, or null to go back to running its latest save. An absent field would have to be read as one of those, and reading it as the second would un-pin a live pipeline because somebody sent an empty body.`,
    );
  }
  const found = body.version;
  if (found === null) return undefined;
  if (typeof found !== 'number' || !Number.isInteger(found) || found < 1) {
    throw new BadRequestException(
      `"${head.name}" cannot be set live at ${JSON.stringify(found)}: a version is a whole number of at least 1, or null to follow the latest save.`,
    );
  }
  return found;
}

/**
 * One release, as a screen may see it.
 *
 * The same node-by-node redaction `redactWorkflow` performs, and needed for a
 * sharper reason than symmetry: a release archives the graph **as stored**, so
 * it holds whatever sealed credential the source node held at the time. Without
 * this, the history route would hand back in plaintext what the read of the live
 * graph goes to some trouble not to.
 */
function redactRelease(release: CatalogWorkflowRelease): CatalogWorkflowRelease {
  return {
    ...release,
    nodes: release.nodes.map((node) =>
      node.kind === 'source' || node.kind === 'call'
        ? { ...node, config: redactConfigSecrets(node.config) }
        : node,
    ),
  };
}

function redactWorkflow(workflow: CatalogWorkflow): CatalogWorkflow {
  return {
    ...workflow,
    nodes: workflow.nodes.map((node) =>
      node.kind === 'source' || node.kind === 'call'
        ? { ...node, config: redactConfigSecrets(node.config) }
        : node,
    ),
  };
}

/**
 * Put back every credential the caller was only ever shown a redaction of, node
 * by node — on a source node and on a call node alike.
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
 * A node whose id matches something that is no longer of the same kind — the id
 * reused for a sink, say — also passes through: there is no config on the other
 * side to have shown anybody.
 */
/**
 * One reusable node, as a screen may see it.
 *
 * The sibling of {@link redactWorkflow}, and it exists for the same reason a
 * source node's config had to be redacted at all: a reusable **source** body is
 * a connector's vocabulary — a kind, an optional connection, a config — so its
 * `config.url` is `postgres://user:pass@host/db`, the exact string
 * `config-secrets.ts` was written because `GET connections` was serving.
 *
 * A **sink** body is returned as-is rather than spread, because the union makes
 * "has a config" a narrowing instead of a hopeful property check, and a sink
 * body has none.
 */
function redactReusableNode(node: CatalogReusableNode): CatalogReusableNode {
  if (node.body.kind !== 'source') return node;
  return { ...node, body: { ...node.body, config: redactConfigSecrets(node.body.config) } };
}

/**
 * Put back every credential the caller was only ever shown a redaction of.
 *
 * One level shallower than {@link restoreWorkflowSecrets} — there is one body
 * rather than an array of nodes — so there is no id matching to do. What is
 * still checked is the **kind**: a body that arrived as a sink where a source
 * was stored has no config to restore into, and a previous kind's config is not
 * a placeholder for this one's.
 *
 * A reusable node the caller is creating has nothing stored, so nothing is
 * restored and whatever arrived is what was meant — which is the `stored`-absent
 * branch of `restoreRedactedSecrets`, and it is the store's own refusal that
 * decides whether a fresh plaintext password may be written at all.
 */
function restoreReusableNodeSecrets(
  body: ReusableNodeBody,
  stored: CatalogReusableNode | undefined,
): ReusableNodeBody {
  if (body.kind !== 'source') return body;
  if (stored?.body.kind !== 'source') return body;
  return { ...body, config: restoreRedactedSecrets(body.config, stored.body.config) };
}

function restoreWorkflowSecrets(
  nodes: WorkflowNode[],
  stored: CatalogWorkflow | undefined,
): WorkflowNode[] {
  if (!stored) return nodes;
  const previous = new Map(stored.nodes.map((node) => [node.id, node]));
  return nodes.map((node) => {
    if (node.kind !== 'source' && node.kind !== 'call') return node;
    const was = previous.get(node.id);
    if (was?.kind !== node.kind) return node;
    return { ...node, config: restoreRedactedSecrets(node.config, was.config) };
  });
}

/**
 * A per-record transform run against a sample, as the whole-batch pane's shape.
 *
 * The try pane renders `{rows, logs, elapsedMs}` and has no reason to learn a
 * second shape for a mode difference the author already declared, so the stream
 * is drained here and reported the same way. That is safe precisely because a
 * sample is a sample: the records were pasted into a text box, the pane paints
 * every row, and there is no dataset to bound. **No other caller may do this** —
 * see `ConnectorRunnerService` and `WorkflowRunnerService`, which stream, and
 * whose whole point is that they do not collect.
 *
 * Falls back to a buffered `run` when the bound runner cannot stream, so a
 * deployment that swapped `TransformRunner` for a container still gets a pane
 * rather than an error about a method it never promised. That fallback would be
 * wrong for a real load and is right here for the same reason the collection is.
 */
async function tryStreamed(
  runner: TransformRunner,
  transform: { language: TransformLanguage; code: string; mode: TransformMode },
  records: unknown[],
  options: { timeoutMs: number; context: CatalogCodeContext },
): Promise<TransformResult> {
  if (!supportsTransformStreaming(runner)) {
    return runner.run(transform, records, options);
  }
  const stream = await runner.runStream(transform, arrayAsStream(records), options);
  const rows: Array<Record<string, unknown>> = [];
  for await (const row of stream.rows) rows.push(row);
  const summary = stream.summary();
  return { rows, logs: summary.logs, elapsedMs: summary.elapsedMs };
}

async function* arrayAsStream(records: unknown[]): AsyncGenerator<unknown> {
  for (const record of records) yield record;
}
