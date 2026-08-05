import { randomUUID } from 'node:crypto';
import type {
  CatalogConnection,
  CatalogConnector,
  CatalogPipelineStore,
  CatalogStageStore,
  CatalogTransform,
  CatalogWorkflow,
  CatalogWorkflowStore,
  ConnectionCheck,
  ConnectorKind,
  ConnectorRun,
  TransformLanguage,
  WorkflowEdge,
  WorkflowExecutionMode,
  WorkflowNode,
  WorkflowNodeOutcome,
  WorkflowStatus,
} from '@dudousxd/nestjs-catalog';
import {
  emitCatalog,
  isConnectorKind,
  isTransformLanguage,
  isWorkflowEdge,
  isWorkflowExecutionMode,
  isWorkflowNode,
  isWorkflowStatus,
  validateWorkflow,
  workflowGraphHash,
} from '@dudousxd/nestjs-catalog';
import type { EntityManager } from '@mikro-orm/mysql';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { CATALOG_STORE_ENTITY_MANAGER } from './context';
import {
  ConnectionRow,
  ConnectorRow,
  ConnectorRunRow,
  TransformRow,
  WorkflowRow,
  WorkflowStageRow,
} from './entities/pipeline';
import { CATALOG_STORE_OPTIONS, type CatalogStoreModuleOptions } from './options';

@Injectable()
export class MySqlPipelineStore
  implements CatalogPipelineStore, CatalogWorkflowStore, CatalogStageStore
{
  private readonly logger = new Logger(MySqlPipelineStore.name);

  constructor(
    // By token, never positionally. The default connection is whichever one the
    // host registered first, and in a host with a database of its own that is
    // not this catalog's.
    @Inject(CATALOG_STORE_ENTITY_MANAGER)
    private readonly em: EntityManager,
    // Optional so a host that constructs this store by hand — several specs do
    // — keeps working, and an absent options object reads as every default,
    // which for this one is the refusing side.
    @Optional()
    @Inject(CATALOG_STORE_OPTIONS)
    private readonly options?: CatalogStoreModuleOptions,
  ) {}

  /**
   * The refusal, unless this deployment said otherwise.
   *
   * The check itself is the free function below; this only decides whether to
   * ask it. Kept as a method rather than threading the flag through every call
   * site because the flag is a property of the STORE — of which database these
   * rows land in — and not of any one save.
   *
   * `allowInlineCredentials` turns it off, and its docblock argues the trade.
   * Note what stays on either way: reads are redacted, so the password never
   * travels in an HTTP response. This flag decides only whether it may rest in
   * the catalog's own table.
   */
  private assertNoNewPlaintextCredential(
    incoming: Record<string, unknown> | undefined,
    stored: Record<string, unknown> | undefined,
    subject: string,
  ): void {
    if (this.options?.allowInlineCredentials) return;
    assertNoNewPlaintextCredential(incoming, stored, subject);
  }

  async listConnectors(): Promise<CatalogConnector[]> {
    const em = this.em.fork();
    const rows = await em.find(ConnectorRow, {}, { orderBy: { name: 'asc' } });
    return rows.map(toConnector);
  }

  async getConnector(id: string): Promise<CatalogConnector | undefined> {
    const em = this.em.fork();
    const row = await em.findOne(ConnectorRow, { id });
    return row ? toConnector(row) : undefined;
  }

  async saveConnector(
    input: Omit<CatalogConnector, 'id' | 'createdAt' | 'updatedAt' | 'createdBy'> & {
      id?: string;
    },
    createdBy: string,
  ): Promise<CatalogConnector> {
    const em = this.em.fork();

    // Checked before anything is written, and here rather than in a controller,
    // because a connector saved by curl reaches this method and nothing else.
    if (input.transformId && input.workflowId) {
      throw new BadRequestException(
        `"${input.name}" names both a transform and a workflow. Exactly one of them decides what shapes this data — with both set the runner picks one, and which one it picked is invisible until the load comes out wrong.`,
      );
    }
    if (input.workflowId) {
      const workflow = await em.findOne(WorkflowRow, { id: input.workflowId });
      if (!workflow) {
        throw new BadRequestException(
          `"${input.name}" points at workflow ${input.workflowId}, which does not exist. A connector pointing at a graph that is not there fails on a schedule rather than at the moment somebody decided.`,
        );
      }
      // **Refused at save, not at run.** A draft is a graph nobody has declared
      // finished, and it may have no sink at all, so a connector pointing at one
      // has nothing to execute. The check could equally live in the runner, and
      // that is precisely the version worth arguing against: it would move the
      // error from the person wiring the connector — who is looking at the
      // screen and can fix it in one edit — to a scheduled window at 3am, where
      // it becomes a failed run somebody reads the next morning without the
      // context that produced it.
      if (workflow.status !== 'ready') {
        throw new BadRequestException(
          `"${input.name}" points at workflow "${workflow.name}", which is still a draft. Publish it first: a draft is a graph nobody has declared finished, and scheduling one means finding out at 3am rather than now.`,
        );
      }
      // The redundancy between a connector's target type and its workflow's sink
      // is kept honest here. It is what lets "which connectors write this type"
      // keep working unchanged now that the sink, not the connector, is what
      // actually commits.
      if (workflow.targetType !== input.targetType) {
        throw new BadRequestException(
          `"${input.name}" says it writes ${input.targetType}, but workflow "${workflow.name}" commits ${workflow.targetType}. The sink is what writes, so the connector would be advertising a type it never produces.`,
        );
      }
    }

    const existing = input.id ? await em.findOne(ConnectorRow, { id: input.id }) : null;

    this.assertNoNewPlaintextCredential(input.config, existing?.config, `"${input.name}"`);

    const row =
      existing ??
      em.create(ConnectorRow, {
        id: input.id ?? randomUUID(),
        name: input.name,
        kind: input.kind,
        targetType: input.targetType,
        config: {},
        enabled: true,
        createdBy,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

    row.name = input.name;
    row.description = input.description;
    row.kind = input.kind;
    row.targetType = input.targetType;
    row.config = { ...(input.config ?? {}) };
    row.secretEnvVar = input.secretEnvVar;
    row.transformId = input.transformId;
    // Validated at length above — both-transform-and-workflow refused, a
    // missing workflow refused, a mismatched target type refused — and then
    // never written, so a connector could not be attached to a graph at all. It
    // saved, reported success, and ran nothing but its own kind. Careful
    // validation of a field that is then discarded is worse than no validation:
    // it reads as proof the field works.
    row.workflowId = input.workflowId;
    row.schedule = input.schedule;
    row.connectionId = input.connectionId;
    // `state` is deliberately not taken from the input: it belongs to the
    // runner, and a save that carried it would let an edit rewind a watermark.
    row.mode = input.mode;
    row.enabled = input.enabled ?? true;

    em.persist(row);
    await em.flush();
    return toConnector(row);
  }

  /**
   * Advance a connector's watermark.
   *
   * A targeted update rather than a read-modify-write of the whole row: two
   * runs of different connectors must never be able to overwrite each other's
   * progress by way of a stale copy of the rest of the record.
   */
  async saveConnectorState(id: string, state: Record<string, unknown>): Promise<void> {
    const em = this.em.fork();
    await em.nativeUpdate(ConnectorRow, { id }, { state });
  }

  async deleteConnector(id: string): Promise<boolean> {
    const em = this.em.fork();
    return (await em.nativeDelete(ConnectorRow, { id })) > 0;
  }

  async listConnections(): Promise<CatalogConnection[]> {
    const em = this.em.fork();
    const rows = await em.find(ConnectionRow, {}, { orderBy: { name: 'asc' } });
    return rows.map(toConnection);
  }

  async getConnection(id: string): Promise<CatalogConnection | undefined> {
    const em = this.em.fork();
    const row = await em.findOne(ConnectionRow, { id });
    return row ? toConnection(row) : undefined;
  }

  async saveConnection(
    input: Omit<CatalogConnection, 'id' | 'createdAt' | 'updatedAt' | 'createdBy'> & {
      id?: string;
    },
    createdBy: string,
  ): Promise<CatalogConnection> {
    const em = this.em.fork();
    const existing = input.id ? await em.findOne(ConnectionRow, { id: input.id }) : null;

    this.assertNoNewPlaintextCredential(input.config, existing?.config, `"${input.name}"`);

    const row =
      existing ??
      em.create(ConnectionRow, {
        id: input.id ?? randomUUID(),
        name: input.name,
        kind: input.kind,
        config: {},
        createdBy,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

    row.name = input.name;
    row.description = input.description;
    row.kind = input.kind;
    row.config = { ...(input.config ?? {}) };
    row.secretEnvVar = input.secretEnvVar;

    em.persist(row);
    await em.flush();
    return toConnection(row);
  }

  async connectorsUsingConnection(id: string): Promise<CatalogConnector[]> {
    const em = this.em.fork();
    const rows = await em.find(ConnectorRow, { connectionId: id }, { orderBy: { name: 'asc' } });
    return rows.map(toConnector);
  }

  /**
   * Refuses while anything still reads through it.
   *
   * Checked here rather than left to a foreign key because the useful part is
   * the message: a constraint violation says a row is referenced, and an
   * operator needs to know *which connectors* so they can be pointed somewhere
   * else first.
   */
  async deleteConnection(id: string): Promise<boolean> {
    const inUse = await this.connectorsUsingConnection(id);
    if (inUse.length > 0) {
      throw new BadRequestException(
        `${inUse.length} connector(s) still read through this connection: ${inUse
          .map((connector) => connector.name)
          .join(
            ', ',
          )}. Point them elsewhere before deleting it, or their next run fails with no address.`,
      );
    }
    const em = this.em.fork();
    return (await em.nativeDelete(ConnectionRow, { id })) > 0;
  }

  async recordConnectionCheck(id: string, check: ConnectionCheck): Promise<void> {
    const em = this.em.fork();
    // A targeted update: recording a check must never carry a stale copy of the
    // configuration back over an edit made while the check was running.
    await em.nativeUpdate(
      ConnectionRow,
      { id },
      {
        lastCheckedAt: new Date(),
        lastCheckOk: check.ok,
        lastCheckError: check.error?.slice(0, 1024),
      },
    );
  }

  async listTransforms(): Promise<CatalogTransform[]> {
    const em = this.em.fork();
    const rows = await em.find(TransformRow, {}, { orderBy: { name: 'asc' } });
    return rows.map(toTransform);
  }

  async getTransform(id: string): Promise<CatalogTransform | undefined> {
    const em = this.em.fork();
    const row = await em.findOne(TransformRow, { id });
    return row ? toTransform(row) : undefined;
  }

  /**
   * Saving bumps the version whenever the code changed.
   *
   * Only when it changed: renaming a transform is not a new version, and
   * inflating the number would make it useless for the question it exists to
   * answer.
   */
  async saveTransform(
    input: Pick<CatalogTransform, 'name' | 'language' | 'code'> & {
      id?: string;
      description?: string;
    },
    createdBy: string,
  ): Promise<CatalogTransform> {
    const em = this.em.fork();
    const existing = input.id ? await em.findOne(TransformRow, { id: input.id }) : null;

    const row =
      existing ??
      em.create(TransformRow, {
        id: input.id ?? randomUUID(),
        name: input.name,
        language: input.language,
        code: input.code,
        version: 1,
        createdBy,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

    const codeChanged = existing !== null && existing.code !== input.code;
    row.name = input.name;
    row.description = input.description;
    row.language = input.language;
    row.code = input.code;
    if (codeChanged) row.version += 1;

    em.persist(row);
    await em.flush();

    if (!existing || codeChanged) {
      emitCatalog('transform.changed', {
        transformId: row.id,
        name: row.name,
        language: row.language,
        version: row.version,
        changedBy: createdBy,
      });
    }

    return toTransform(row);
  }

  async deleteTransform(id: string): Promise<boolean> {
    const em = this.em.fork();
    return (await em.nativeDelete(TransformRow, { id })) > 0;
  }

  async listWorkflows(): Promise<CatalogWorkflow[]> {
    const em = this.em.fork();
    const rows = await em.find(WorkflowRow, {}, { orderBy: { name: 'asc' } });
    return rows.map(toWorkflow);
  }

  async getWorkflow(id: string): Promise<CatalogWorkflow | undefined> {
    const em = this.em.fork();
    const row = await em.findOne(WorkflowRow, { id });
    return row ? toWorkflow(row) : undefined;
  }

  /**
   * Validate, then write.
   *
   * The whole-graph checks run here and not only in the canvas. A canvas that
   * validates against its own copy of the rules and a server that does not is a
   * canvas that lies: the first graph to arrive by curl, or from a canvas one
   * release behind, would be stored as something that looks runnable and fails
   * halfway through a load instead of at the moment it was drawn. It calls the
   * same exported `validateWorkflow` the canvas does, so the two cannot drift.
   *
   * The version bumps only when the graph's behaviour changed — the same rule
   * `saveTransform` applies to code. Renaming a workflow or dragging a node is
   * not a new version, and inflating the number would make it useless for the
   * question it exists to answer.
   */
  async saveWorkflow(
    input: Pick<CatalogWorkflow, 'name' | 'nodes' | 'edges'> & {
      id?: string;
      description?: string;
    },
    createdBy: string,
  ): Promise<CatalogWorkflow> {
    const nodes = input.nodes ?? [];
    const edges = input.edges ?? [];

    const em = this.em.fork();
    const existing = input.id ? await em.findOne(WorkflowRow, { id: input.id }) : null;
    // A new graph starts as a draft. An existing one keeps the status it has —
    // a save is an edit, never a promotion, and never a demotion either.
    const status = existing
      ? narrow(existing.status, isWorkflowStatus, 'Workflow status', existing.id)
      : 'draft';

    assertStaysRunnable(status, { nodes, edges }, input.name);

    await assertTransformsExist(em, nodes);

    const targetType = targetTypeOf(status, nodes, input.name);

    const graphHash = workflowGraphHash({ nodes, edges });

    const row =
      existing ??
      em.create(WorkflowRow, {
        id: input.id ?? randomUUID(),
        name: input.name,
        nodes: [],
        edges: [],
        status,
        version: 1,
        graphHash,
        targetType,
        createdBy,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

    const graphChanged = existing !== null && existing.graphHash !== graphHash;
    row.name = input.name;
    row.description = input.description;
    row.nodes = nodes;
    row.edges = edges;
    row.graphHash = graphHash;
    // Written from the sink, never from the input: a caller must not be able to
    // claim a workflow writes one type while its sink commits another. Empty
    // while a draft has not drawn one yet — `publishWorkflow` is what refuses to
    // let that state become runnable.
    row.targetType = targetType;
    if (graphChanged) row.version += 1;

    em.persist(row);
    await em.flush();

    if (!existing || graphChanged) {
      emitCatalog('workflow.changed', {
        workflowId: row.id,
        name: row.name,
        version: row.version,
        graphHash: row.graphHash,
        targetType: row.targetType,
        nodeCount: nodes.length,
        changedBy: createdBy,
      });
    }

    return toWorkflow(row);
  }

  /**
   * Validate, then declare it ready.
   *
   * This is where the gate that used to sit on `saveWorkflow` now lives, and
   * putting it on its own transition is what gives the refusal somewhere to go:
   * the caller asked one question — "is this finished?" — so every issue
   * `validateWorkflow` found is the answer, rather than an error on a save the
   * author thought was about something else.
   *
   * The sink check is repeated here rather than left to `validateWorkflow`
   * because `targetType` is a stored, indexed column that a draft is allowed to
   * carry empty. Publishing is the moment it stops being allowed to, and it is
   * re-derived from the graph at this instant rather than trusted from the row —
   * the row's copy was written by a save that may not have had a sink at all.
   *
   * Idempotent. Publishing something already published re-validates it and
   * returns it, because "it was already ready" is not a problem anybody needs
   * reported and an error would make a double-click a failure.
   */
  async publishWorkflow(id: string, publishedBy: string): Promise<CatalogWorkflow> {
    const em = this.em.fork();
    const row = await em.findOne(WorkflowRow, { id });
    if (!row) {
      throw new NotFoundException(`Workflow ${id} does not exist, so there is nothing to publish.`);
    }

    const workflow = toWorkflow(row);
    const issues = validateWorkflow({ nodes: workflow.nodes, edges: workflow.edges });
    if (issues.length > 0) {
      throw new BadRequestException(
        `"${row.name}" cannot run as drawn, so it cannot be published. ${issues
          .map((issue) => issue.message)
          .join(' ')}`,
      );
    }

    // Validation guarantees exactly one sink, so this cannot be absent here even
    // though it can be on the draft this was a second ago.
    const sink = workflow.nodes.find((node) => node.kind === 'sink');
    if (!sink || sink.kind !== 'sink') {
      throw new BadRequestException(
        `"${row.name}" has no sink node, so nothing would ever be committed.`,
      );
    }

    await assertTransformsExist(em, workflow.nodes);

    const wasDraft = row.status !== 'ready';
    row.status = 'ready';
    row.targetType = sink.targetType;
    em.persist(row);
    await em.flush();

    // Only on the transition. Re-publishing an unchanged graph is not a change,
    // and an event on every idempotent call would put a stream of them in front
    // of anybody watching for the one that mattered.
    if (wasDraft) {
      emitCatalog('workflow.changed', {
        workflowId: row.id,
        name: row.name,
        version: row.version,
        graphHash: row.graphHash,
        targetType: row.targetType,
        nodeCount: workflow.nodes.length,
        changedBy: publishedBy,
      });
    }

    return toWorkflow(row);
  }

  /**
   * Back to `draft`, and refused while anything still runs it.
   *
   * The same refusal `deleteWorkflow` makes, listing the same names, because the
   * consequence is the same: a connector may only run a ready graph, so
   * unpublishing one out from under a schedule is indistinguishable from
   * deleting it as far as the next window is concerned. Cascading — disabling
   * those connectors here — was the alternative and is refused on principle:
   * turning off somebody's loads as a side effect of an edit to something else
   * is exactly the silent action this status was added to prevent.
   */
  async unpublishWorkflow(id: string, unpublishedBy: string): Promise<CatalogWorkflow> {
    const inUse = await this.connectorsUsingWorkflow(id);
    if (inUse.length > 0) {
      throw new BadRequestException(
        `${inUse.length} connector(s) still run this workflow: ${inUse
          .map((connector) => connector.name)
          .join(
            ', ',
          )}. Point them elsewhere before unpublishing it, or their next run fails with nothing to execute.`,
      );
    }

    const em = this.em.fork();
    const row = await em.findOne(WorkflowRow, { id });
    if (!row) {
      throw new NotFoundException(
        `Workflow ${id} does not exist, so there is nothing to unpublish.`,
      );
    }

    row.status = 'draft';
    em.persist(row);
    await em.flush();
    this.logger.log(`${unpublishedBy} took workflow "${row.name}" (${row.id}) back to draft.`);
    return toWorkflow(row);
  }

  async connectorsUsingWorkflow(id: string): Promise<CatalogConnector[]> {
    const em = this.em.fork();
    const rows = await em.find(ConnectorRow, { workflowId: id }, { orderBy: { name: 'asc' } });
    return rows.map(toConnector);
  }

  /**
   * Refuses while any connector still runs it.
   *
   * The same protection `deleteConnection` gives, for the same reason: a
   * constraint violation says a row is referenced, and an operator needs to know
   * *which connectors* would start failing so they can be pointed somewhere else
   * first.
   */
  async deleteWorkflow(id: string): Promise<boolean> {
    const inUse = await this.connectorsUsingWorkflow(id);
    if (inUse.length > 0) {
      throw new BadRequestException(
        `${inUse.length} connector(s) still run this workflow: ${inUse
          .map((connector) => connector.name)
          .join(
            ', ',
          )}. Point them elsewhere before deleting it, or their next run fails with nothing to execute.`,
      );
    }
    const em = this.em.fork();
    return (await em.nativeDelete(WorkflowRow, { id })) > 0;
  }

  /**
   * Stage one node's batch.
   *
   * Keyed deterministically by `(runId, nodeId, batch)`, so a retried durable
   * step re-sending its batches replaces them rather than appending a second
   * copy. An append-only stage would silently double a node's output on every
   * retry, and the only symptom would be a row count that looks merely large.
   */
  async writeStage(input: {
    runId: string;
    nodeId: string;
    batch: number;
    rows: Array<Record<string, unknown>>;
  }): Promise<{ written: number }> {
    const em = this.em.fork();
    const id = stageKey(input.runId, input.nodeId, input.batch);
    const existing = await em.findOne(WorkflowStageRow, { id });

    const row =
      existing ??
      em.create(WorkflowStageRow, {
        id,
        runId: input.runId,
        nodeId: input.nodeId,
        batch: input.batch,
        rows: [],
        rowCount: 0,
        createdAt: new Date(),
      });

    row.rows = input.rows;
    row.rowCount = input.rows.length;
    em.persist(row);
    await em.flush();
    // Rows accepted by this call, matching what the warehouse's `write` means by
    // the same word — never a running total.
    return { written: input.rows.length };
  }

  async readStage(ref: {
    runId: string;
    nodeId: string;
    batch: number;
  }): Promise<Array<Record<string, unknown>>> {
    const em = this.em.fork();
    const row = await em.findOne(WorkflowStageRow, {
      id: stageKey(ref.runId, ref.nodeId, ref.batch),
    });
    if (!row) return [];
    // Narrowed rather than trusted. A staged batch is JSON that a transform
    // produced, and a transform can return anything; anything that is not a
    // plain object could not have been written as a row and is dropped here
    // rather than surfacing as a column named after an array index.
    return row.rows.filter(isRowRecord);
  }

  async dropStages(runId: string): Promise<number> {
    const em = this.em.fork();
    return em.nativeDelete(WorkflowStageRow, { runId });
  }

  async startRun(input: {
    connectorId: string;
    snapshotId: string;
    principalId: string;
    workflowId?: string;
    workflowVersion?: number;
    graphHash?: string;
    executionMode?: WorkflowExecutionMode;
  }): Promise<ConnectorRun> {
    const em = this.em.fork();
    const row = em.create(ConnectorRunRow, {
      id: randomUUID(),
      connectorId: input.connectorId,
      snapshotId: input.snapshotId,
      principalId: input.principalId,
      status: 'running',
      fetched: 0,
      written: 0,
      logs: [],
      // Recorded now rather than at the finish. A run that crashes hard enough
      // never to reach `finishRun` is precisely the one whose graph somebody
      // will need to identify.
      workflowId: input.workflowId,
      workflowVersion: input.workflowVersion,
      graphHash: input.graphHash,
      executionMode: input.executionMode,
      startedAt: new Date(),
    });
    em.persist(row);

    const connector = await em.findOne(ConnectorRow, { id: input.connectorId });
    if (connector) {
      connector.lastRunAt = new Date();
      connector.lastRunStatus = 'running';
    }
    await em.flush();
    return toRun(row);
  }

  async finishRun(
    id: string,
    outcome: Partial<
      Pick<
        ConnectorRun,
        'status' | 'fetched' | 'written' | 'logs' | 'error' | 'transformVersion' | 'nodeOutcomes'
      >
    >,
  ): Promise<ConnectorRun | undefined> {
    const em = this.em.fork();
    const row = await em.findOne(ConnectorRunRow, { id });
    if (!row) return undefined;

    if (outcome.nodeOutcomes !== undefined) {
      row.nodeOutcomes = outcome.nodeOutcomes;
    }

    if (outcome.status) row.status = outcome.status;
    if (outcome.fetched !== undefined) row.fetched = outcome.fetched;
    if (outcome.written !== undefined) row.written = outcome.written;
    // Capped: a chatty transform should not be able to fill the table with logs
    // from one run.
    if (outcome.logs) row.logs = outcome.logs.slice(0, 200);
    if (outcome.error !== undefined) row.error = outcome.error?.slice(0, 4000);
    if (outcome.transformVersion !== undefined) {
      row.transformVersion = outcome.transformVersion;
    }
    row.finishedAt = new Date();

    const connector = await em.findOne(ConnectorRow, { id: row.connectorId });
    if (connector) connector.lastRunStatus = row.status;

    await em.flush();
    return toRun(row);
  }

  async listRuns(connectorId?: string, limit = 50): Promise<ConnectorRun[]> {
    const em = this.em.fork();
    const rows = await em.find(ConnectorRunRow, connectorId ? { connectorId } : {}, {
      orderBy: { startedAt: 'desc' },
      limit: Math.min(limit, 200),
    });
    return rows.map(toRun);
  }
}

/**
 * No new plaintext credential goes into `config`.
 *
 * `ConnectorRow.config` and `ConnectionRow.config` both promise, in their own
 * docblocks, that what is stored is the *name* of an environment variable and
 * "never the credential". That held for every source that authenticates with a
 * token — those really do come from `secretEnvVar` — and did not hold for SQL,
 * where `fetchSql` reads `connector.config.url` and a connection URL is a
 * password with an address attached. So `postgres://user:pass@host/db` sat in a
 * JSON column, and `GET pipeline/connections` served it under `catalog:read`.
 *
 * Refused **here**, in the store, rather than in the controller, for the reason
 * the both-transform-and-workflow check above gives: a connector saved by curl,
 * by a host's own code, or by `applyPromotion` reaches this method and nothing
 * else. The route can only close the route.
 *
 * ## What is refused, precisely
 *
 * A password-bearing URL that is **not already the value stored under that key
 * for this row**. Three consequences, all intended:
 *
 *  - A new connector carrying one is turned away. That is the point.
 *  - An existing one is grandfathered, so a deployment with such URLs already
 *    in its table keeps running and can still be renamed, re-pointed or
 *    disabled. Refusing those would break working loads to no benefit — the
 *    password is already in the database either way.
 *  - Promoting such a connector into an environment that does not have it yet
 *    is refused. `promoteConnectors` deliberately never carries `secretEnvVar`
 *    across, so that a newly promoted connector "arrive[s] with no credential to
 *    reach anything with" — this applies that same rule to the credential that
 *    was hiding inside `config`, which promotion was otherwise copying verbatim.
 *
 * Compared as exact strings rather than by re-parsing: the value being
 * grandfathered is the one that came out of this table, so byte equality is
 * both sufficient and the only comparison that cannot be argued with later.
 *
 * The URL parse duplicates a few lines of `config-secrets.ts` in the pipeline
 * package, knowingly. That package depends on this one, so the shared helper
 * cannot live there, and moving it to `@dudousxd/nestjs-catalog` to save ten
 * lines would put a rule about *storage* in the package that deliberately holds
 * no storage.
 */
function assertNoNewPlaintextCredential(
  incoming: Record<string, unknown> | undefined,
  stored: Record<string, unknown> | undefined,
  subject: string,
): void {
  const offending: string[] = [];
  for (const [key, value] of Object.entries(incoming ?? {})) {
    if (typeof value !== 'string' || !hasUrlPassword(value)) continue;
    if (stored && stored[key] === value) continue;
    offending.push(key);
  }
  if (offending.length === 0) return;
  throw new BadRequestException(
    `${subject} carries a password inside config.${offending.join(', config.')}. A connection URL is the credential, and this column is read by anyone holding catalog:read — put the URL in an environment variable and name it in "Credential env var" instead, which is where every fetcher already looks first.`,
  );
}

/** Whether a string parses as a URL that carries a password. */
function hasUrlPassword(value: string): boolean {
  try {
    // WHATWG `URL` handles non-special schemes, so `postgres:` and `mysql:`
    // yield a real `password` rather than an opaque path — which is why this is
    // a parse and not a regular expression.
    return new URL(value).password.length > 0;
  } catch {
    return false;
  }
}

/**
 * Narrow a stored string, loudly.
 *
 * The previous shape here — `KINDS.find(k => k === row.kind) ?? "http"` — kept
 * its own copy of the list, and when the list grew the copy did not. A `file`
 * connector came back as an `http` one and failed complaining about a missing
 * URL, which points the reader at the connector's config instead of at this
 * line. Falling back is the whole mistake: an unrecognised value means this
 * build is older than the data, and quietly answering with a different value is
 * worse than saying so.
 */
function narrow<T extends string>(
  value: string,
  guard: (candidate: unknown) => candidate is T,
  field: string,
  id: string,
): T {
  if (guard(value)) return value;
  throw new Error(
    `${field} "${value}" on ${id} is not one this build knows about. It was most likely written by a newer version of the catalog.`,
  );
}

function toConnector(row: ConnectorRow): CatalogConnector {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    kind: narrow(row.kind, isConnectorKind, 'Connector kind', row.id),
    targetType: row.targetType,
    config: row.config ?? {},
    secretEnvVar: row.secretEnvVar,
    transformId: row.transformId,
    workflowId: row.workflowId,
    schedule: row.schedule,
    connectionId: row.connectionId,
    mode: row.mode === 'incremental' ? 'incremental' : 'full',
    state: row.state ?? {},
    enabled: row.enabled,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastRunAt: row.lastRunAt?.toISOString(),
    lastRunStatus:
      row.lastRunStatus === 'succeeded' ||
      row.lastRunStatus === 'failed' ||
      row.lastRunStatus === 'running'
        ? row.lastRunStatus
        : undefined,
  };
}

function toTransform(row: TransformRow): CatalogTransform {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    language: narrow(row.language, isTransformLanguage, 'Transform language', row.id),
    code: row.code,
    version: row.version,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toRun(row: ConnectorRunRow): ConnectorRun {
  return {
    id: row.id,
    connectorId: row.connectorId,
    snapshotId: row.snapshotId,
    principalId: row.principalId,
    status: row.status === 'succeeded' || row.status === 'failed' ? row.status : 'running',
    fetched: row.fetched,
    written: row.written,
    logs: row.logs ?? [],
    error: row.error,
    transformVersion: row.transformVersion,
    workflowId: row.workflowId,
    workflowVersion: row.workflowVersion,
    graphHash: row.graphHash,
    // Narrowed with the shared guard rather than trusted. An execution mode this
    // build does not recognise means the row was written by a newer one, and
    // answering "inline" would tell an operator a checkpointed run was not.
    executionMode: isWorkflowExecutionMode(row.executionMode) ? row.executionMode : undefined,
    nodeOutcomes: toNodeOutcomes(row.nodeOutcomes),
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString(),
  };
}

/**
 * The gate that used to stand in front of every save now stands in front of
 * `ready` only.
 *
 * A draft is stored exactly as drawn, unfinished nodes and all: that is what
 * makes closing the tab safe, and it is why "+ Sink" no longer answers with two
 * true and useless complaints one second after the click. What is refused is a
 * *ready* graph edited into something that cannot run — **refused rather than
 * demoted**, because a connector may only point at a ready graph, so a save that
 * silently dropped the status would stop a scheduled load with nothing said to
 * anybody. The person editing is the one who can fix it, and they are looking at
 * the screen right now.
 *
 * A free function rather than a branch inside `saveWorkflow` because that method
 * was already at the complexity ceiling, and because this is the rule the whole
 * feature turns on — it deserves somewhere to be read.
 */
function assertStaysRunnable(
  status: WorkflowStatus,
  graph: { nodes: WorkflowNode[]; edges: WorkflowEdge[] },
  name: string,
): void {
  if (status !== 'ready') return;
  const issues = validateWorkflow(graph);
  if (issues.length === 0) return;
  throw new BadRequestException(
    `"${name}" is published, so it has to stay runnable, and this edit would leave it unable to run. ${issues
      .map((issue) => issue.message)
      .join(' ')} Unpublish it first if you want to park it in this state.`,
  );
}

/**
 * The type the sink commits, or the empty string while nobody has drawn one.
 *
 * Only a `ready` graph is guaranteed to have exactly one sink, because only a
 * ready graph has been validated. A draft may legitimately have none yet — that
 * is what drafting is — so this carries the empty string until there is a sink
 * to derive it from, and `publishWorkflow` is what guarantees one exists before
 * anything can run. Never taken from the caller: a client must not be able to
 * claim a workflow writes one type while its sink commits another.
 */
function targetTypeOf(status: WorkflowStatus, nodes: WorkflowNode[], name: string): string {
  const sink = nodes.find((node) => node.kind === 'sink');
  if (sink && sink.kind === 'sink') return sink.targetType;
  if (status === 'ready') {
    throw new BadRequestException(
      `"${name}" has no sink node, so nothing would ever be committed.`,
    );
  }
  return '';
}

/**
 * Every transform node points at a transform that exists.
 *
 * Kept out of `validateWorkflow` because it needs the database, and keeping the
 * validator pure is exactly what lets the canvas run the same rules in the
 * browser. Checked node by node rather than with one `IN` query so the refusal
 * can name the node the author is looking at, which is the difference between a
 * fixable message and a list of ids.
 */
async function assertTransformsExist(em: EntityManager, nodes: WorkflowNode[]): Promise<void> {
  for (const node of nodes) {
    if (node.kind !== 'transform') continue;
    const transform = await em.findOne(TransformRow, { id: node.transformId });
    if (!transform) {
      throw new BadRequestException(
        `Node "${node.name}" (${node.id}) runs transform ${node.transformId}, which does not exist. Saving it would leave a graph that fails partway through a load rather than at the moment it was drawn.`,
      );
    }
  }
}

/**
 * Read the per-node record back, dropping anything malformed.
 *
 * The one place in this file that falls back rather than throwing, and the
 * reason is the direction the data flows: this is observability *about* a run
 * that already happened, so a garbled entry costs a line in a panel, while
 * throwing would make an entire run history unreadable because one node's
 * outcome was written by a version that shaped it differently. Everything that
 * decides what a load *does* — kinds, languages, graph nodes — still refuses.
 */
function toNodeOutcomes(
  value: Record<string, unknown> | undefined,
): Record<string, WorkflowNodeOutcome> | undefined {
  if (!value) return undefined;
  const outcomes: Record<string, WorkflowNodeOutcome> = {};
  for (const [nodeId, raw] of Object.entries(value)) {
    const outcome = toNodeOutcome(raw);
    if (outcome !== undefined) outcomes[nodeId] = outcome;
  }
  return outcomes;
}

/**
 * One node's outcome, or `undefined` if it is not one.
 *
 * `status` is the only field that can reject the entry: it is what a panel
 * groups and counts by, so an unrecognised value would show up as a fourth
 * status nobody has a colour for. Every other field degrades to a default,
 * because a missing `elapsedMs` costs a column in one row and dropping the
 * whole outcome over it would lose the status too.
 */
function toNodeOutcome(raw: unknown): WorkflowNodeOutcome | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const status = Reflect.get(raw, 'status');
  const rows = Reflect.get(raw, 'rows');
  if (status !== 'succeeded' && status !== 'failed' && status !== 'skipped') {
    return undefined;
  }
  const transformVersion = Reflect.get(raw, 'transformVersion');
  const elapsedMs = Reflect.get(raw, 'elapsedMs');
  const error = Reflect.get(raw, 'error');
  return {
    status,
    rows: typeof rows === 'number' ? rows : 0,
    transformVersion: typeof transformVersion === 'number' ? transformVersion : undefined,
    elapsedMs: typeof elapsedMs === 'number' ? elapsedMs : undefined,
    error: typeof error === 'string' ? error : undefined,
  };
}

/**
 * The key a staged batch is stored under.
 *
 * Derived rather than random so that re-staging the same batch overwrites it.
 * `#` is safe as a separator because `WORKFLOW_NODE_ID_PATTERN` refuses a node
 * id that could contain one, which is checked before any graph is saved — if
 * that ever stopped being true, one node could read another node's rows.
 */
function stageKey(runId: string, nodeId: string, batch: number): string {
  return `${runId}#${nodeId}#${batch}`;
}

function isRowRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toWorkflow(row: WorkflowRow): CatalogWorkflow {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    nodes: row.nodes.map((node, index) =>
      narrowGraphPart(node, isWorkflowNode, 'node', index, row.id),
    ),
    edges: row.edges.map((edge, index) =>
      narrowGraphPart(edge, isWorkflowEdge, 'edge', index, row.id),
    ),
    status: narrow(row.status, isWorkflowStatus, 'Workflow status', row.id),
    version: row.version,
    graphHash: row.graphHash,
    targetType: row.targetType,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Narrow one stored node or edge, loudly — the same refusal `narrow` above makes
 * about a connector kind, for a sharper reason.
 *
 * Skipping an unrecognised node would leave a graph that still validates and
 * quietly runs nine steps of ten, committing a snapshot that is missing whatever
 * the tenth did. There is no symptom: the load succeeds, the row count is
 * plausible, and the difference only shows up in the data. An unrecognised part
 * almost always means this build is older than the one that wrote it, and saying
 * so is the only safe answer.
 */
function narrowGraphPart<T>(
  value: unknown,
  guard: (candidate: unknown) => candidate is T,
  what: 'node' | 'edge',
  index: number,
  workflowId: string,
): T {
  if (guard(value)) return value;
  throw new Error(
    `Workflow ${workflowId} has a ${what} at position ${index} this build cannot read. It was most likely written by a newer version of the catalog; running the graph without it would silently change what the load produces.`,
  );
}

function toConnection(row: ConnectionRow): CatalogConnection {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    kind: narrow(row.kind, isConnectorKind, 'Connection kind', row.id),
    config: row.config ?? {},
    secretEnvVar: row.secretEnvVar,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastCheckedAt: row.lastCheckedAt?.toISOString(),
    lastCheckOk: row.lastCheckOk,
    lastCheckError: row.lastCheckError,
  };
}
