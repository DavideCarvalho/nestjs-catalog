import type { CatalogWorkflow, ConnectorRun, SnapshotRef } from '@dudousxd/nestjs-catalog';
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
 * The rename node as it actually executes.
 *
 * THE THREE PROPERTIES
 * --------------------
 * **1. It produces exactly what the transform it replaces produced.** The
 * grounding case is real: an Air Force fleet export whose headers are
 * `Mgmt Cd`, `Reg Number`, `Asset Id` and `VEH Type Name`, and the four-line
 * transform that exists in production today to rename them. A faster node that
 * loses a row is a failure, so the rows are compared against the `.map` itself
 * rather than against a literal somebody typed.
 *
 * **2. It never holds the load.** A rename is per record and cannot aggregate,
 * so the node reads one batch, rewrites it and writes it before reading the
 * next. That is a property of the *order* of store calls and not of the output —
 * a buffering implementation produces identical rows — so it is asserted on an
 * ordered log, exactly as `workflow-runner.filter.spec.ts` argues.
 *
 * **3. It says what it cost.** "A pure rename moves no data" is the whole
 * argument for the node kind, and a claim like that is worth nothing if a run
 * cannot say whether it held this time. So the log line is asserted for both
 * dispositions and for a store that cannot take the fast path.
 */

const SNAPSHOT = 'wf-run-rename-1';

/** What the drop actually arrives as, headers and all. */
function fleet(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => ({
    'Mgmt Cd': index % 3 === 0 ? null : 'AF',
    'Reg Number': `0${index}-1234`,
    'Asset Id': `A${index}`,
    'VEH Type Name': index % 2 === 0 ? 'Sedan' : 'Truck',
  }));
}

function workflowRenaming(
  records: Array<Record<string, unknown>>,
  columns: Record<string, string>,
  unnamed?: 'keep' | 'drop',
): CatalogWorkflow {
  return {
    id: 'wf-rename',
    name: 'Fleet headers',
    nodes: [
      {
        id: 'src',
        kind: 'source',
        name: 'Fleet export',
        sourceKind: 'inline',
        config: { records },
      },
      { id: 'head', kind: 'rename', name: 'Headers', columns, unnamed },
      { id: 'load', kind: 'sink', name: 'Into Fleet', targetType: 'Fleet' },
    ],
    edges: [
      { from: 'src', to: 'head' },
      { from: 'head', to: 'load' },
    ],
    status: 'ready',
    enabled: true,
    version: 1,
    graphHash: 'abcdef0123456789',
    targetType: 'Fleet',
    createdBy: 'ana',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/**
 * A store that stages payloads the way the shipped one does, and records the
 * order it was asked things in.
 *
 * `payloads` is what makes this a test of the fast path at all: the batches are
 * held encoded, so a rename that went through `readStage` would be visible in
 * `ops` as a row read rather than a payload read.
 */
function harness(workflow: CatalogWorkflow, options: { payloads?: boolean } = {}) {
  const fast = options.payloads ?? true;
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

  const payloads = {
    readStagePayload: (input: { runId: string; nodeId: string; batch: number }) => {
      const key = `${input.runId}/${input.nodeId}/${input.batch}`;
      ops.push(`payload ${key}`);
      return Promise.resolve(stages.get(key));
    },
    writeStagePayload: (input: {
      runId: string;
      nodeId: string;
      batch: number;
      payload: unknown;
      rows: number;
    }) => {
      const key = `${input.runId}/${input.nodeId}/${input.batch}`;
      ops.push(`stamp ${key}`);
      stages.set(key, input.payload);
      return Promise.resolve({ written: input.rows });
    },
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
    Object.assign(Object.create(null), base, fast ? payloads : {}),
    Object.assign(Object.create(null), {
      run: () => Promise.reject(new Error('No node in this file names a transform.')),
    }),
    Object.assign(Object.create(null), publish),
  );

  return { service, stages, ops, committed, written };
}

async function runOver(
  records: Array<Record<string, unknown>>,
  columns: Record<string, string>,
  unnamed?: 'keep' | 'drop',
  options: { payloads?: boolean } = {},
) {
  const workflow = workflowRenaming(records, columns, unnamed);
  const kit = harness(workflow, options);
  const run = await kit.service.runInline({
    workflow,
    connectorId: 'conn-1',
    principalId: 'ana',
    snapshotId: SNAPSHOT,
  });
  return { ...kit, run };
}

/**
 * The whole run's log, joined.
 *
 * All of it rather than the lines naming the node, because the sentences worth
 * asserting on here — what it cost, which column was never found — deliberately
 * do not repeat the node's name: the run panel already groups a node's lines
 * under it, and repeating it in every line is noise in the one place somebody
 * reads while a load is going wrong.
 */
function renameLog(run: { logs?: string[] }): string {
  return (run.logs ?? []).join(' ');
}

describe('the transform this node exists to delete', () => {
  const DROP = fleet(2_000);

  it('produces exactly what the .map produced, row for row', async () => {
    // The transform in production today, verbatim:
    //   records.map((r) => ({ mgmtCd: r["Mgmt Cd"], regNumber: r["Reg Number"] }))
    const byHand = DROP.map((row) => ({
      mgmtCd: row['Mgmt Cd'],
      regNumber: row['Reg Number'],
    }));

    const { written } = await runOver(
      DROP,
      { 'Mgmt Cd': 'mgmtCd', 'Reg Number': 'regNumber' },
      'drop',
    );

    expect(written).toEqual(byHand);
  });

  it('loses no row and no null', async () => {
    // A faster node that quietly drops a row is a failure, and a null that
    // becomes an absent key is the same failure one level down — it decides
    // whether the sink writes the column or leaves it alone.
    const { written } = await runOver(
      DROP,
      { 'Mgmt Cd': 'mgmtCd', 'Reg Number': 'regNumber' },
      'drop',
    );
    expect(written).toHaveLength(DROP.length);
    expect(written.filter((row) => row.mgmtCd !== null)).toHaveLength(
      DROP.filter((row) => row['Mgmt Cd'] !== null).length,
    );
    expect(Object.hasOwn(written[0] ?? {}, 'mgmtCd')).toBe(true);
  });

  it('leaves the columns it was not asked about when it is not dropping', async () => {
    const { written } = await runOver(fleet(3), { 'Mgmt Cd': 'mgmtCd' });
    expect(written[0]).toEqual({
      mgmtCd: null,
      'Reg Number': '00-1234',
      'Asset Id': 'A0',
      'VEH Type Name': 'Sedan',
    });
  });
});

describe('what it costs, and what the run says about it', () => {
  it('rewrites the column list and moves nothing, and says so', async () => {
    const { run } = await runOver(fleet(2_000), { 'Mgmt Cd': 'mgmtCd' });
    expect(renameLog(run)).toContain('No values were moved');
  });

  it('says the rows were rebuilt when it is also dropping columns', async () => {
    // The honest half. Removing a column removes a position from every row, so
    // the metadata-only property is gone and the log must not imply otherwise.
    const { run } = await runOver(fleet(200), { 'Mgmt Cd': 'mgmtCd' }, 'drop');
    expect(renameLog(run)).toContain('Every row was rebuilt');
    expect(renameLog(run)).toContain('drops the columns it does not name');
  });

  it('says so too when the store cannot hand a batch over undecoded', async () => {
    // The fallback produces the same rows through the same rename function, and
    // the difference is a cost — which a run that claimed "no values were moved"
    // would be lying about.
    const { run, written } = await runOver(fleet(200), { 'Mgmt Cd': 'mgmtCd' }, undefined, {
      payloads: false,
    });
    expect(renameLog(run)).toContain('cannot hand a batch over without decoding it');
    expect(written).toHaveLength(200);
    expect(Object.hasOwn(written[0] ?? {}, 'mgmtCd')).toBe(true);
  });

  it('names a column that was in no row rather than leaving it to be found', async () => {
    // A typo in a header. Its symptom otherwise is a target column absent from
    // every row, a sink committing NULL into all of them, and a green run —
    // which is exactly what `property-names.ts` is the record of.
    const { run } = await runOver(fleet(10), { 'Mgmt Cd': 'mgmtCd', 'Mgmt Code': 'mgmtCode' });
    expect(renameLog(run)).toContain('"Mgmt Code"');
    expect(renameLog(run)).toContain('was not found in any row');
  });
});

describe('what it never does', () => {
  it('writes each batch out before it reads the next one in', async () => {
    // The property no assertion about the output could catch: a rename that
    // read every batch first would produce identical rows, an identical outcome
    // and an identical log, and would differ only in this ordering.
    const { ops } = await runOver(fleet(2_000), { 'Mgmt Cd': 'mgmtCd' });
    const byNode = ops.filter((op) => op.includes('/head/'));
    const firstWrite = ops.findIndex((op) => op.startsWith('stamp '));
    const lastRead = ops.reduce(
      (at, op, index) => (op.startsWith(`payload ${SNAPSHOT}/src/`) ? index : at),
      -1,
    );

    expect(byNode.length).toBeGreaterThan(1);
    // Something was written before the last input batch was ever read.
    expect(firstWrite).toBeLessThan(lastRead);
  });

  it('reads the payload rather than the rows', async () => {
    const { ops } = await runOver(fleet(200), { 'Mgmt Cd': 'mgmtCd' });
    // The whole point of the node: the rows between `src` and `head` are never
    // decoded into objects at all.
    expect(ops).toContain(`payload ${SNAPSHOT}/src/1`);
    expect(ops).not.toContain(`read ${SNAPSHOT}/src/1`);
  });
});
