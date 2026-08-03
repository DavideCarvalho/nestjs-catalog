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
} from '@dudousxd/nestjs-catalog';
import {
  emitCatalog,
  isConnectorKind,
  isTransformLanguage,
  isWorkflowEdge,
  isWorkflowExecutionMode,
  isWorkflowNode,
  validateWorkflow,
  workflowGraphHash,
} from '@dudousxd/nestjs-catalog';
import type { EntityManager } from '@mikro-orm/mysql';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { CATALOG_STORE_ENTITY_MANAGER } from './context';
import {
  ConnectionRow,
  ConnectorRow,
  ConnectorRunRow,
  TransformRow,
  WorkflowRow,
  WorkflowStageRow,
} from './entities/pipeline';

@Injectable()
export class MySqlPipelineStore
  implements CatalogPipelineStore, CatalogWorkflowStore, CatalogStageStore
{
  constructor(
    // By token, never positionally. The default connection is whichever one the
    // host registered first, and in a host with a database of its own that is
    // not this catalog's.
    @Inject(CATALOG_STORE_ENTITY_MANAGER)
    private readonly em: EntityManager,
  ) {}

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

    const issues = validateWorkflow({ nodes, edges });
    if (issues.length > 0) {
      throw new BadRequestException(
        `"${input.name}" cannot run as drawn. ${issues.map((issue) => issue.message).join(' ')}`,
      );
    }

    const em = this.em.fork();

    // Referential checks are separate from `validateWorkflow` because they need
    // the database, and keeping them out of the pure validator is what lets the
    // canvas run it in the browser at all.
    for (const node of nodes) {
      if (node.kind !== 'transform') continue;
      const transform = await em.findOne(TransformRow, { id: node.transformId });
      if (!transform) {
        throw new BadRequestException(
          `Node "${node.name}" (${node.id}) runs transform ${node.transformId}, which does not exist. Saving it would leave a graph that fails partway through a load rather than at the moment it was drawn.`,
        );
      }
    }

    // Validation guarantees exactly one sink, so this find cannot be ambiguous
    // and cannot be absent.
    const sink = nodes.find((node) => node.kind === 'sink');
    if (!sink || sink.kind !== 'sink') {
      throw new BadRequestException(
        `"${input.name}" has no sink node, so nothing would ever be committed.`,
      );
    }

    const graphHash = workflowGraphHash({ nodes, edges });
    const existing = input.id ? await em.findOne(WorkflowRow, { id: input.id }) : null;

    const row =
      existing ??
      em.create(WorkflowRow, {
        id: input.id ?? randomUUID(),
        name: input.name,
        nodes: [],
        edges: [],
        version: 1,
        graphHash,
        targetType: sink.targetType,
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
    // claim a workflow writes one type while its sink commits another.
    row.targetType = sink.targetType;
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
    if (typeof raw !== 'object' || raw === null) continue;
    const status = Reflect.get(raw, 'status');
    const rows = Reflect.get(raw, 'rows');
    if (status !== 'succeeded' && status !== 'failed' && status !== 'skipped') {
      continue;
    }
    const transformVersion = Reflect.get(raw, 'transformVersion');
    const elapsedMs = Reflect.get(raw, 'elapsedMs');
    const error = Reflect.get(raw, 'error');
    outcomes[nodeId] = {
      status,
      rows: typeof rows === 'number' ? rows : 0,
      transformVersion: typeof transformVersion === 'number' ? transformVersion : undefined,
      elapsedMs: typeof elapsedMs === 'number' ? elapsedMs : undefined,
      error: typeof error === 'string' ? error : undefined,
    };
  }
  return outcomes;
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
