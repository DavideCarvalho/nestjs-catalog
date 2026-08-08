import type {
  CatalogWorkflow,
  ConnectorRun,
  SnapshotRef,
  WorkflowAggregate,
} from '@dudousxd/nestjs-catalog';
import { decodeStageRows, encodeStageRows } from '@dudousxd/nestjs-catalog';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowRunnerService } from './workflow-runner.service';

/** See the note in `pipeline.module.integration.spec.ts`: the package cannot load here. */
vi.mock('@dudousxd/nestjs-durable', () => ({
  WorkflowEngine: class WorkflowEngine {},
  Step: () => (_target: unknown, _key: unknown, descriptor: unknown) => descriptor,
  Workflow: () => (target: unknown) => target,
}));

/**
 * The aggregate node as it actually executes.
 *
 * THE THREE PROPERTIES
 * --------------------
 * **1. It produces exactly what the SQL it replaces produced.** The grounding
 * case is flip's `wo` derivation — `GROUP BY` over SUBWO rows with `MAX`, `MIN`,
 * `SUM` and `GROUP_CONCAT` — so the answers are compared against a
 * straightforward reimplementation of that query over the same fixture rather
 * than against literals somebody typed. A faster node that gets a total wrong is
 * not a faster node.
 *
 * **2. It never holds the records.** This is the property the whole node exists
 * for, and it is a property of the *order of store calls* rather than of the
 * output — an implementation that read everything and then reduced produces
 * identical rows. So it is asserted on an ordered log, exactly as
 * `workflow-runner.rename.spec.ts` and `workflow-runner.filter.spec.ts` argue:
 * every input batch is read before any output batch is written, and there is
 * never a read after a write.
 *
 * **3. It refuses out loud rather than answering plausibly.** The four refusals
 * the fold can raise all arrive at the run as a 400 with the sentence intact,
 * because a step that fails with a stack is a step somebody has to go and
 * reproduce.
 */

const SNAPSHOT = 'wf-run-aggregate-1';

/**
 * SUBWO, shaped the way the real drop is: several sub-work-orders per
 * (work order, asset), with costs to sum, dates to bound, text to take the
 * maximum of, and a service description to join.
 */
function subwo(groups: number, linesPerGroup: number): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let group = 0; group < groups; group += 1) {
    for (let line = 0; line < linesPerGroup; line += 1) {
      rows.push({
        workOrderId: `W${group}`,
        assetId: `A${group % 7}`,
        itemDescription: line % 2 === 0 ? 'TRUCK, UTILITY' : 'Truck, Utility',
        actualLaborCost: Number((12.34 + line * 0.01).toFixed(2)),
        nmcStartDate: new Date(Date.UTC(2026, 0, 1 + ((group + line) % 28))),
        requestedService: `service ${line}`,
        // Present on some rows and absent on others, which is what makes the
        // stage encoding a shape dictionary in the first place.
        ...(line % 3 === 0 ? { remarks: `note ${line}` } : {}),
      });
    }
  }
  return rows;
}

/** The aggregates flip's own `wo` query computes, minus the CASE ladder it excludes. */
const WO_AGGREGATES: WorkflowAggregate[] = [
  { as: 'itemDescription', fn: 'max', column: 'itemDescription' },
  { as: 'actualLaborCost', fn: 'sum', column: 'actualLaborCost' },
  { as: 'nmcStartDate', fn: 'min', column: 'nmcStartDate' },
  { as: 'requestedService', fn: 'join', column: 'requestedService', separator: '; ' },
  { as: 'subWorkOrders', fn: 'count' },
];

function workflowAggregating(
  records: Array<Record<string, unknown>>,
  aggregates: WorkflowAggregate[] = WO_AGGREGATES,
  maxGroups?: number,
): CatalogWorkflow {
  return {
    id: 'wf-aggregate',
    name: 'Work orders from sub work orders',
    nodes: [
      { id: 'src', kind: 'source', name: 'SUBWO', sourceKind: 'inline', config: { records } },
      {
        id: 'wo',
        kind: 'aggregate',
        name: 'Build wo',
        groupBy: ['workOrderId', 'assetId'],
        aggregates,
        ...(maxGroups === undefined ? {} : { maxGroups }),
      },
      { id: 'load', kind: 'sink', name: 'Into Wo', targetType: 'Wo' },
    ],
    edges: [
      { from: 'src', to: 'wo' },
      { from: 'wo', to: 'load' },
    ],
    status: 'ready',
    enabled: true,
    version: 1,
    graphHash: 'abcdef0123456789',
    targetType: 'Wo',
    createdBy: 'ana',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/** A store that stages rows and records the order it was asked things in. */
function harness(workflow: CatalogWorkflow) {
  const stages = new Map<string, unknown>();
  const runs: ConnectorRun[] = [];
  const ops: string[] = [];

  const base = {
    listWorkflows: () => Promise.resolve([workflow]),
    getWorkflow: () => Promise.resolve(workflow),
    saveWorkflow: () => Promise.resolve(workflow),
    publishWorkflow: () => Promise.resolve(workflow),
    saveWorkflowSchedule: () => Promise.resolve(workflow),
    adoptConnector: () => Promise.resolve(undefined),
    connectorsUsingWorkflow: () => Promise.resolve([]),
    getConnector: () => Promise.resolve(undefined),
    getConnection: () => Promise.resolve(undefined),
    getTransform: () => Promise.resolve(undefined),
    saveConnectorState: () => Promise.resolve(),

    writeStage: (input: {
      runId: string;
      nodeId: string;
      batch: number;
      rows: Array<Record<string, unknown>>;
    }) => {
      const key = `${input.runId}/${input.nodeId}/${input.batch}`;
      ops.push(`write ${key}`);
      stages.set(key, encodeStageRows(input.rows));
      return Promise.resolve({ written: input.rows.length });
    },
    readStage: (input: { runId: string; nodeId: string; batch: number }) => {
      const key = `${input.runId}/${input.nodeId}/${input.batch}`;
      ops.push(`read ${key}`);
      const stored = stages.get(key);
      return Promise.resolve(stored === undefined ? [] : decodeStageRows(stored));
    },
    dropStages: () => Promise.resolve(0),

    startRun: (input: { connectorId: string; snapshotId: string; principalId: string }) => {
      const run: ConnectorRun = {
        id: `run-${runs.length + 1}`,
        ...input,
        status: 'running',
        fetched: 0,
        written: 0,
        logs: [],
        startedAt: '2026-02-01T02:00:00.000Z',
      };
      runs.push(run);
      return Promise.resolve(run);
    },
    finishRun: (id: string, outcome: Partial<ConnectorRun>) => {
      const run = runs.find((candidate) => candidate.id === id);
      if (run) Object.assign(run, outcome, { finishedAt: '2026-02-01T03:00:00.000Z' });
      return Promise.resolve(run);
    },
    listRuns: () => Promise.resolve([...runs]),
  };

  const committed: string[] = [];
  const written: Array<Record<string, unknown>> = [];
  const publish = {
    appendRowsAsSystem: (
      _principalId: string,
      _typeName: string,
      _snapshotId: string,
      rows: Array<Record<string, unknown>>,
    ) => {
      written.push(...rows);
      return Promise.resolve({ written: rows.length });
    },
    carryForwardAsSystem: () => Promise.resolve({ carried: 0, total: 0, from: undefined }),
    commitAsSystem: (principalId: string, typeName: string, snapshotId: string) => {
      committed.push(typeName);
      return Promise.resolve<SnapshotRef>({
        id: snapshotId,
        rowCount: written.length,
        createdAt: '2026-02-01T03:00:00.000Z',
        principalId,
      });
    },
  };

  const service = new WorkflowRunnerService(
    Object.assign(Object.create(null), base),
    Object.assign(Object.create(null), {
      run: () => Promise.reject(new Error('No node in this file names a transform.')),
    }),
    Object.assign(Object.create(null), publish),
  );

  return { service, stages, ops, committed, written };
}

async function runOver(
  records: Array<Record<string, unknown>>,
  aggregates: WorkflowAggregate[] = WO_AGGREGATES,
  maxGroups?: number,
) {
  const workflow = workflowAggregating(records, aggregates, maxGroups);
  const kit = harness(workflow);
  const run = await kit.service.runInline({
    workflow,
    connectorId: 'conn-1',
    principalId: 'ana',
    snapshotId: SNAPSHOT,
  });
  return { ...kit, run };
}

/**
 * The whole run's log, joined, plus the error it stopped on.
 *
 * Both, because half of what this node has to say is said by refusing: a run
 * that stops at the group ceiling or at a join bound records its sentence on
 * `error` rather than in `logs`, and the sentence is the thing under test.
 */
function log(run: { logs?: string[]; error?: string }): string {
  return [...(run.logs ?? []), run.error ?? ''].join(' ');
}

/**
 * The query this node replaces, written out.
 *
 * A second implementation on purpose: comparing the node against a literal
 * proves the literal was typed correctly, and comparing it against the shape of
 * the SQL proves the node answers the question the SQL asked.
 */
function byHand(records: Array<Record<string, unknown>>): Map<string, Record<string, unknown>> {
  const groups = new Map<string, Record<string, unknown>>();
  for (const row of records) {
    const key = `${String(row.workOrderId)}|${String(row.assetId)}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        workOrderId: row.workOrderId,
        assetId: row.assetId,
        itemDescription: row.itemDescription,
        actualLaborCost: Number(row.actualLaborCost),
        nmcStartDate: row.nmcStartDate,
        requestedService: String(row.requestedService),
        subWorkOrders: 1,
      });
      continue;
    }
    const description = String(row.itemDescription);
    if (description > String(existing.itemDescription)) existing.itemDescription = description;
    existing.actualLaborCost = Number(existing.actualLaborCost) + Number(row.actualLaborCost);
    if (
      row.nmcStartDate instanceof Date &&
      existing.nmcStartDate instanceof Date &&
      row.nmcStartDate.getTime() < existing.nmcStartDate.getTime()
    ) {
      existing.nmcStartDate = row.nmcStartDate;
    }
    existing.requestedService = `${String(existing.requestedService)}; ${String(row.requestedService)}`;
    existing.subWorkOrders = Number(existing.subWorkOrders) + 1;
  }
  return groups;
}

describe('the GROUP BY this node exists to bring into the graph', () => {
  // 1,200 groups of 4, so the ratio is the same order as flip's real 44,720
  // into 16,119 and the run is fast enough to be a unit test.
  const DROP = subwo(1_200, 4);

  it('produces one row per group, and the same rows the query does', async () => {
    const { run, written } = await runOver(DROP);
    expect(run.status).toBe('succeeded');
    expect(written.length).toBe(1_200);

    const expected = byHand(DROP);
    for (const row of written) {
      const wanted = expected.get(`${String(row.workOrderId)}|${String(row.assetId)}`);
      expect(wanted).toBeDefined();
      expect(row.itemDescription).toBe(wanted?.itemDescription);
      expect(row.subWorkOrders).toBe(wanted?.subWorkOrders);
      expect(row.requestedService).toBe(wanted?.requestedService);
      expect(row.nmcStartDate).toEqual(wanted?.nmcStartDate);
      // Within a rounding of the naive sum, and often exactly it — the whole
      // point of the compensation is that it is *never further away* than the
      // naive answer, which is what this asserts rather than bit equality.
      expect(Number(row.actualLaborCost)).toBeCloseTo(Number(wanted?.actualLaborCost), 8);
    }
  });

  it('reads every input batch before it writes any output batch, and never reads after writing', async () => {
    // The claim the node is for, asserted on the order of store calls rather
    // than on the output, because a buffering implementation produces identical
    // rows. An aggregate is a genuine barrier — no group can be emitted before
    // the last record is read — so the shape is: all reads, then all writes.
    const { ops } = await runOver(DROP);
    const batches = Math.ceil(DROP.length / 500);
    // Only what the aggregate itself did: its reads are of the source's stage
    // and its writes are of its own. The source's own `clearStaleTail` probe of
    // one-past-the-end is dropped, because it belongs to the node before this
    // one and happens before this node starts.
    const during = ops.filter(
      (entry) =>
        (entry.startsWith('read') &&
          entry.includes('/src/') &&
          !entry.endsWith(`/${batches + 1}`)) ||
        (entry.startsWith('write') && entry.includes('/wo/')),
    );
    const reads = during.filter((entry) => entry.startsWith('read'));
    const firstWrite = during.findIndex((entry) => entry.startsWith('write'));
    const lastRead = during.map((entry) => entry.startsWith('read')).lastIndexOf(true);
    expect(firstWrite).toBeGreaterThan(-1);
    // Every read before every write: this node is a barrier, and it costs
    // groups rather than records precisely because the reads do not accumulate.
    expect(lastRead).toBeLessThan(firstWrite);
    // Each input batch opened exactly once, and none of them twice.
    expect(reads.length).toBe(batches);
    expect(new Set(reads).size).toBe(batches);
  });

  it('coalesces its groups into full batches rather than one per input batch', async () => {
    // 1,200 groups at 500 to a batch is three, and not the ten input batches
    // that produced them. Without this the stage store holds a row per input
    // batch for a node that shrank the data twenty times over.
    const { ops } = await runOver(DROP);
    const writes = ops.filter((entry) => entry.startsWith('write') && entry.includes('/wo/'));
    expect(writes.length).toBe(3);
  });

  it('says what it held, and puts the ratio first', async () => {
    const { run } = await runOver(DROP);
    expect(log(run)).toContain('read 4800 records and held 1200 groups (4.0 records per group)');
    expect(log(run)).toContain(
      'The memory this node used is the 1200 groups, not the 4800 records',
    );
  });
});

describe('the failures that would otherwise be committed', () => {
  it('warns when the grouping turned out to be nearly one-to-one', async () => {
    // Legal, and usually the wrong group-by column. A hash aggregate that holds
    // one group per record has quietly become the whole-batch behaviour this
    // node replaces, and the run is the only place that can say so.
    const { run } = await runOver(subwo(600, 1));
    expect(log(run)).toContain('nearly one-to-one');
    expect(log(run)).toContain('usually the wrong group-by column');
  });

  it('refuses past its ceiling instead of filling the machine, and the run says which columns', async () => {
    const { run } = await runOver(subwo(400, 2), WO_AGGREGATES, 50);
    expect(run.status).toBe('failed');
    expect(log(run)).toContain('"workOrderId", "assetId"');
    expect(log(run)).toContain('holding the whole load rather than a summary of it');
  });

  it('names a column that was in no record, rather than committing nulls quietly', async () => {
    const { run } = await runOver(subwo(20, 3), [
      { as: 'total', fn: 'sum', column: 'actuallLaborCost' },
      { as: 'n', fn: 'count' },
    ]);
    expect(run.status).toBe('succeeded');
    expect(log(run)).toContain('"actuallLaborCost"');
    expect(log(run)).toContain('commits NULL into every row and reports success');
  });

  it('refuses a join past its bound with the sentence intact, rather than truncating like the query it replaces', async () => {
    const { run } = await runOver(subwo(5, 40), [
      { as: 'services', fn: 'join', column: 'requestedService', separator: '; ', maxLength: 40 },
    ]);
    expect(run.status).toBe('failed');
    expect(log(run)).toContain('against a limit of 40');
    expect(log(run)).toContain('refused rather than truncated');
    expect(log(run)).toContain('group_concat_max_len');
  });

  it('reports how long the longest joined value got, so the bound is not a surprise later', async () => {
    const { run } = await runOver(subwo(20, 3));
    expect(log(run)).toContain('The longest joined value was');
  });

  it('stops rather than committing an empty snapshot when the source was empty', async () => {
    const { run, committed } = await runOver([]);
    // No groups from no records, which is what GROUP BY does — and the sink's
    // own refusal is what stops an empty full snapshot replacing a good one.
    expect(committed).toEqual([]);
    expect(run.status).toBe('failed');
  });
});
