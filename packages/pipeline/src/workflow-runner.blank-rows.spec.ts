import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CatalogWorkflow, ConnectorRun, SnapshotRef } from '@dudousxd/nestjs-catalog';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowRunnerService } from './workflow-runner.service';

/** See the note in `pipeline.module.integration.spec.ts`: the package cannot load here. */
vi.mock('@dudousxd/nestjs-durable', () => ({
  WorkflowEngine: class WorkflowEngine {},
  Step: () => (_target: unknown, _key: unknown, descriptor: unknown) => descriptor,
  Workflow: () => (target: unknown) => target,
}));

/**
 * Where a reader finds out that the parser threw rows away.
 *
 * `sources.csv.spec.ts` proves the parser counts them. This proves the count
 * reaches the run — which is the half that was actually missing, and the half
 * that would have made the 568 rows lost out of flip's `af_fleet.csv` visible
 * to the person reading the load rather than to nobody.
 *
 * The assertion is on `run.logs` rather than on a return value, because the run
 * log is the artefact somebody opens when a count looks wrong, and a note that
 * existed on a `FetchResult` and never made it there would pass a test written
 * against the fetcher alone.
 */

async function csvFile(text: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'catalog-run-csv-'));
  const path = join(dir, 'af_fleet.csv');
  await writeFile(path, text, 'utf8');
  return path;
}

function workflowReading(path: string): CatalogWorkflow {
  return {
    id: 'wf-blank',
    name: 'Fleet drop',
    nodes: [
      {
        id: 'src',
        kind: 'source',
        name: 'Fleet export',
        sourceKind: 'file',
        config: { path },
      },
      { id: 'load', kind: 'sink', name: 'Into Fleet', targetType: 'Fleet' },
    ],
    edges: [{ from: 'src', to: 'load' }],
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

function harness(workflow: CatalogWorkflow) {
  const stages = new Map<string, Array<Record<string, unknown>>>();
  const runs: ConnectorRun[] = [];

  const store = {
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
      stages.set(`${input.runId}/${input.nodeId}/${input.batch}`, input.rows);
      return Promise.resolve();
    },
    readStage: (input: { runId: string; nodeId: string; batch: number }) =>
      Promise.resolve(stages.get(`${input.runId}/${input.nodeId}/${input.batch}`) ?? []),
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

  const publish = {
    appendRowsAsSystem: (
      _principalId: string,
      _typeName: string,
      _snapshotId: string,
      rows: Array<Record<string, unknown>>,
    ) => Promise.resolve({ written: rows.length }),
    carryForwardAsSystem: () => Promise.resolve({ carried: 0, total: 0, from: undefined }),
    commitAsSystem: (principalId: string, _typeName: string, snapshotId: string) =>
      Promise.resolve<SnapshotRef>({
        id: snapshotId,
        rowCount: 0,
        createdAt: '2026-02-01T03:00:00.000Z',
        principalId,
      }),
  };

  return new WorkflowRunnerService(
    Object.assign(Object.create(null), store),
    Object.assign(Object.create(null), {
      run: () => Promise.reject(new Error('No node in this file names a transform.')),
    }),
    Object.assign(Object.create(null), publish),
  );
}

async function runOver(csv: string): Promise<ConnectorRun> {
  const workflow = workflowReading(await csvFile(csv));
  return harness(workflow).runInline({
    workflow,
    connectorId: 'conn-1',
    principalId: 'ana',
    snapshotId: 'wf-run-blank-1',
  });
}

describe('a source node reading a CSV with blank lines', () => {
  it('puts the skipped count on the run, next to the count it does not agree with', async () => {
    // Three data lines in the file, two records out. Before this the run said
    // "Fetched 2 records from file." and stopped, and the missing line was
    // recoverable only by opening the drop and counting it by hand.
    const run = await runOver('a,b\n1,2\n\n3,4\n');

    expect(run.logs).toContain('Fetched 2 records from file.');
    const note = run.logs.find((line) => line.startsWith('Skipped 1 blank line'));
    expect(note).toBeDefined();
    expect(note).toContain('not in the record count');
    expect(run.logs.indexOf('Fetched 2 records from file.')).toBe(
      run.logs.findIndex((line) => line.startsWith('Skipped 1 blank line')) - 1,
    );
  });

  it('says nothing at all when the file is well formed', async () => {
    const run = await runOver('a,b\n1,2\n3,4\n');

    expect(run.logs.some((line) => line.includes('blank line'))).toBe(false);
  });
});
