/**
 * What a `source → rename → sink` graph costs, and what it holds while it runs.
 *
 * ## The question
 *
 * `runSource` used to buffer a source's whole read before staging a batch of
 * it. `packages/catalog/bench/transform-stream.mjs` measured the *transform*
 * node's half of the streaming work and could not measure this one, because a
 * graph whose source buffers has already lost the memory argument before the
 * transform is reached. This measures the graph the change is actually about:
 * a source, a rename — which is metadata-only on staged data and therefore adds
 * nothing to the peak — and a sink.
 *
 * Run it against the shipped runner at two commits. There is no "before" arm in
 * this file on purpose: an arm that reimplemented the buffered path would
 * measure a model of it, and the buffered path is one `git checkout` away.
 *
 * ```
 * pnpm build
 * AF_FLEET=/path/to/af_fleet.csv node packages/pipeline/bench/source-stage.mjs
 * ```
 *
 * **Point `AF_FLEET` at a real CSV, not at a copy pulled out of an object
 * store's on-disk layout.** MinIO writes a 32-byte bitrot checksum at the head
 * of every 1 MiB block of a part file, so a `part.1` carved out by hand has
 * binary spliced into the middle of a data row every megabyte — and when one of
 * those checksums contains a `0x0A` it splits a row and the record count comes
 * out one high. The counts printed below are the check: `af_fleet.csv` is known
 * to hold 103,087 data rows, 568 of them blank, and to produce 102,519 records.
 *
 * ## The stage store writes files, and that is the whole design of the bench
 *
 * A `Map` in this process would put every staged row in the same heap the
 * runner is being measured for, and both arms would then peak at the size of
 * the load whatever `runSource` did — the bench would be measuring itself. A
 * store that writes a batch as a file and reads it back is what a real store is
 * from the runner's point of view: somewhere else. What is left in this process
 * is exactly what the runner chose to hold.
 *
 * It implements `readStagePayload`/`writeStagePayload` as well as the row pair,
 * so the rename node takes the fast path a real deployment gives it.
 *
 * ## Peak RSS is per process
 *
 * `process.resourceUsage().maxRSS` is a high-water mark for the life of the
 * process, so the run happens in a child this script spawns and the parent
 * prints what the child reports.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const RUNS = Number(process.env.RUNS ?? 3);

const { decodeStageRows, encodeStageRows } = await import(
  new URL('../../catalog/dist/index.js', import.meta.url).href
);
const { WorkflowRunnerService } = await import(
  // The per-file entry rather than the barrel: `index.js` pulls in the durable
  // steps, and `@dudousxd/nestjs-durable` cannot load outside a Nest app here.
  // The specs work around it the same way, with a `vi.mock`.
  new URL('../dist/workflow-runner.service.js', import.meta.url).href
);

function fixturePath() {
  const path = process.env.AF_FLEET;
  if (!path || !existsSync(path)) {
    throw new Error(
      'Set AF_FLEET to a DPAS-shaped CSV — this bench measures a real file on purpose.',
    );
  }
  return path;
}

/* ------------------------------------------------------------------ the graph */

/**
 * The rename every DPAS file needs. Real headers have spaces in them, which
 * `WORKFLOW_FILTER_COLUMN_PATTERN` and `property-names.ts` both refuse, so this
 * is not a synthetic step invented for the bench.
 */
const COLUMNS = {
  'Mgmt Cd': 'mgmtCd',
  'VEH Type Name': 'vehTypeName',
  'Asset NSN': 'assetNsn',
  'Reg Number': 'regNumber',
  'VEH Cat': 'vehCat',
};

function graph(path) {
  return {
    id: 'wf-bench',
    name: 'Fleet drop',
    nodes: [
      { id: 'src', kind: 'source', name: 'Fleet export', sourceKind: 'file', config: { path } },
      { id: 'ren', kind: 'rename', name: 'Real names', columns: COLUMNS, unnamed: 'keep' },
      { id: 'load', kind: 'sink', name: 'Into Fleet', targetType: 'Fleet' },
    ],
    edges: [
      { from: 'src', to: 'ren' },
      { from: 'ren', to: 'load' },
    ],
    status: 'ready',
    enabled: true,
    version: 1,
    graphHash: 'abcdef0123456789',
    targetType: 'Fleet',
    createdBy: 'bench',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/* ------------------------------------------------------------- the file store */

function fileStages(dir) {
  mkdirSync(dir, { recursive: true });
  const at = (ref) => join(dir, `${ref.runId}__${ref.nodeId}__${ref.batch}.json`);
  const load = (ref) => {
    const path = at(ref);
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
  };
  return {
    writeStage: (input) => {
      writeFileSync(at(input), JSON.stringify({ kind: 'rows', rows: input.rows }));
      return Promise.resolve({ written: input.rows.length });
    },
    readStage: (ref) => {
      const held = load(ref);
      if (held === undefined) return Promise.resolve([]);
      return Promise.resolve(held.kind === 'rows' ? held.rows : decodeStageRows(held.payload));
    },
    writeStagePayload: (input) => {
      writeFileSync(at(input), JSON.stringify({ kind: 'payload', payload: input.payload }));
      return Promise.resolve({ written: input.rows });
    },
    readStagePayload: (ref) => {
      const held = load(ref);
      if (held === undefined) return Promise.resolve(undefined);
      return Promise.resolve(held.kind === 'payload' ? held.payload : encodeStageRows(held.rows));
    },
    dropStages: () => Promise.resolve(0),
  };
}

/* -------------------------------------------------------------------- the arm */

async function runGraph() {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-bench-stage-'));
  const workflow = graph(fixturePath());
  const runs = [];
  const counted = { written: 0, nonNull: 0, batches: 0 };

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
    startRun: (input) => {
      const run = {
        id: `run-${runs.length + 1}`,
        ...input,
        status: 'running',
        fetched: 0,
        written: 0,
        logs: [],
        startedAt: new Date().toISOString(),
      };
      runs.push(run);
      return Promise.resolve(run);
    },
    finishRun: (id, outcome) => {
      const run = runs.find((candidate) => candidate.id === id);
      if (run) Object.assign(run, outcome, { finishedAt: new Date().toISOString() });
      return Promise.resolve(run);
    },
    listRuns: () => Promise.resolve([...runs]),
    ...fileStages(dir),
  };

  /**
   * A sink that counts and holds nothing, standing in for the warehouse.
   *
   * Counting rather than collecting matters as much here as it does in the
   * runner: an array of the rows would make the peak the same number whatever
   * `runSource` did, and measure this script instead of the code.
   */
  const publish = {
    appendRowsAsSystem: (_principalId, _typeName, _snapshotId, rows) => {
      counted.batches += 1;
      counted.written += rows.length;
      for (const row of rows) if (row.mgmtCd) counted.nonNull += 1;
      return Promise.resolve({ written: rows.length });
    },
    carryForwardAsSystem: () => Promise.resolve({ carried: 0, total: 0, from: undefined }),
    commitAsSystem: (principalId, _typeName, snapshotId) =>
      Promise.resolve({
        id: snapshotId,
        rowCount: counted.written,
        createdAt: new Date().toISOString(),
        principalId,
      }),
  };

  const service = new WorkflowRunnerService(
    Object.assign(Object.create(null), store),
    Object.assign(Object.create(null), {
      run: () => Promise.reject(new Error('No node in this graph names a transform.')),
    }),
    Object.assign(Object.create(null), publish),
  );

  const started = Date.now();
  const run = await service.runInline({
    workflow,
    connectorId: 'conn-bench',
    principalId: 'bench',
    snapshotId: `bench-${process.pid}-${runs.length}`,
  });
  const ms = Date.now() - started;
  rmSync(dir, { recursive: true, force: true });

  if (run.status !== 'succeeded') {
    throw new Error(`The graph did not finish: ${run.error ?? run.status}`);
  }
  const blank = run.logs.find((line) => line.startsWith('Skipped '));
  return {
    ms,
    fetched: run.fetched,
    written: counted.written,
    batches: counted.batches,
    nonNull: counted.nonNull,
    blank: blank === undefined ? 0 : Number(blank.split(' ')[1]),
  };
}

/* ------------------------------------------------------------------- the driver */

if (process.argv[2] === 'child') {
  const results = [];
  for (let index = 0; index < RUNS; index += 1) results.push(await runGraph());
  const last = results[results.length - 1];
  process.stdout.write(
    `${JSON.stringify({ ...last, ms: results.map((r) => r.ms), peakKb: process.resourceUsage().maxRSS })}\n`,
  );
} else {
  const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const out = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SELF, 'child'], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let text = '';
    child.stdout.on('data', (chunk) => {
      text += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve(JSON.parse(text.trim().split('\n').pop()))
        : reject(new Error(`the child exited ${code}`)),
    );
  });
  console.log(`fixture: ${fixturePath()}   runs: ${RUNS}\n`);
  console.log(
    'median ms   every run          peak       fetched   staged   batches   non-null   blank',
  );
  console.log(
    [
      String(median(out.ms)).padStart(9),
      `  ${out.ms.join(', ')}`.padEnd(18),
      `${(out.peakKb / 1024).toFixed(0)} MB`.padStart(8),
      String(out.fetched).padStart(12),
      String(out.written).padStart(8),
      String(out.batches).padStart(9),
      String(out.nonNull).padStart(10),
      String(out.blank).padStart(7),
    ].join(' '),
  );
}
