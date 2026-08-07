/**
 * What a per-record streaming transform costs, against the whole-batch one it is
 * beside and against the in-process floor neither can beat.
 *
 * ## Why this exists next to `transform-transport.mjs`
 *
 * That script answered "where does the wall clock go" for one whole-batch call
 * and found the author's `.map` at 1.5% of it. This one answers the question
 * that follows — whether feeding the same child NDJSON over a process that lives
 * for the whole node recovers any of the other 98.5% — and it answers a second
 * one the first could not ask at all: **what is held in memory while it
 * happens.**
 *
 * ## Every mode is timed end to end, from the unopened file
 *
 * That is the one thing this had to get right and the easy thing to get wrong.
 * A whole-batch transform must read the entire source before it can spawn
 * anything, so timing it from the spawn hides the read it forced; a stream
 * overlaps the read with the mapping, so timing it from the first record charges
 * it for a read the other arm was not charged for. Both arms therefore start at
 * `createReadStream` and stop when the last row has been counted, which is the
 * only comparison a load actually experiences.
 *
 * ## The chunked wire
 *
 * `stream-1` puts one record on each line and `stream-500` puts five hundred,
 * and the difference between them is the whole argument for the framing the
 * runner ships. The *contract* is per-record either way — the child calls the
 * author's function once per record and never hands it an array — so this is
 * purely how many JSON values cross the pipe per parse, and a batched line
 * amortises the per-call cost that one-record-per-line pays 102,520 times.
 *
 * ## Reading the output
 *
 * Each mode runs in **its own process**, re-spawned by this script, because
 * `process.resourceUsage().maxRSS` is a high-water mark for the life of a
 * process: running two modes in one would report the larger of them twice. The
 * child's own peak comes back in its final line, so both sides of the pipe are
 * reported rather than only the half this process can see.
 *
 * Run it:
 *
 * ```
 * AF_FLEET=/path/to/af_fleet.csv node packages/catalog/bench/transform-stream.mjs
 * ```
 *
 * `REPEAT=2` reads the fixture twice per run, back to back, which is what turns
 * "the stream holds less" into "the stream holds a constant": a bounded arm's
 * peak is flat in `REPEAT` and a buffering arm's is linear in it.
 *
 * The fixture is read through the pipeline package's **real** streaming CSV
 * reader (`csvRecords` over `decodeChunks`), not a bespoke split on commas, so
 * "source → transform → sink streams" is measured rather than asserted — and the
 * row counts here are the counts a real load would get, blank lines and all.
 *
 * Build first: this imports from `packages/pipeline/dist`.
 */
import { spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const PIPELINE = new URL('../../pipeline/dist/record-streams.js', import.meta.url);
const { csvRecords, decodeChunks, blankRowLedger } = await import(PIPELINE.href);

const SELF = fileURLToPath(import.meta.url);
const RUNS = Number(process.env.RUNS ?? 5);
const REPEAT = Number(process.env.REPEAT ?? 1);

/* ---------------------------------------------------------------- the fixture */

function fixturePath() {
  const path = process.env.AF_FLEET;
  if (!path || !existsSync(path)) {
    throw new Error(
      'Set AF_FLEET to a DPAS-shaped CSV — this bench measures a real file on purpose.',
    );
  }
  return path;
}

/**
 * The source, as the connector runner sees it: an async iterable that has not
 * opened the file yet.
 *
 * `REPEAT` reads it more than once, concatenated, so the dataset can be doubled
 * without a second file on disk.
 */
async function* sourceRecords(ledger) {
  const path = fixturePath();
  for (let pass = 0; pass < REPEAT; pass += 1) {
    yield* csvRecords(decodeChunks(createReadStream(path)), ',', path, ledger);
  }
}

/** The rename every DPAS file needs, in each of the two modes. */
const BATCH_CODE = `export default function transform({ records }) {
  return records.map((r) => ({
    mgmtCd: r["Mgmt Cd"],
    vehTypeName: r["VEH Type Name"],
    assetNsn: r["Asset NSN"],
    regNumber: r["Reg Number"],
    vehCat: r["VEH Cat"],
  }));
}`;

const RECORD_CODE = `export default function transform({ record }) {
  return {
    mgmtCd: record["Mgmt Cd"],
    vehTypeName: record["VEH Type Name"],
    assetNsn: record["Asset NSN"],
    regNumber: record["Reg Number"],
    vehCat: record["VEH Cat"],
  };
}`;

/* ------------------------------------------------------------- the two harnesses */

const CHILD_SPAWN = {
  env: { PATH: process.env.PATH ?? '', NODE_ENV: 'production' },
  cwd: tmpdir(),
  detached: process.platform !== 'win32',
  stdio: ['pipe', 'pipe', 'pipe'],
};

/**
 * The author's module, as an expression the harness can call.
 *
 * Inlined rather than written to a file and imported, because this measures
 * transport and a `writeFile` plus `import()` would charge one arm for a disk
 * round trip the other does not make. The real runner writes the file, for the
 * reasons `transform-runner.ts` gives.
 */
function wrapModule(code) {
  return `(${code.replace(/^export default function transform/, 'function transform')})`;
}

function batchHarness(code) {
  return `
let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
const payload = JSON.parse(input || "{}");
const records = Array.isArray(payload.records) ? payload.records : [];
const context = Object.freeze({ ...payload.context, env: Object.freeze({ ...payload.context?.env }) });
const rows = await ${wrapModule(code)}({ records, context });
process.stdout.write('{"rows":' + JSON.stringify(rows ?? []) + ',"peakKb":' + process.resourceUsage().maxRSS + '}');
`;
}

function streamHarness(code) {
  return `
const FLUSH_BYTES = 262144;
const fn = ${wrapModule(code)};
let context = null;
let pending = [];
let pendingBytes = 0;
let at = 0;
const write = async (line) => {
  if (!process.stdout.write(line)) await new Promise((r) => process.stdout.once("drain", r));
};
const flush = async () => {
  const line = '{"at":' + at + ',"rows":[' + pending.join(",") + ']}\\n';
  pending = [];
  pendingBytes = 0;
  await write(line);
};
const emit = (value) => {
  if (value === null || value === undefined) return;
  for (const row of (Array.isArray(value) ? value : [value])) {
    const json = JSON.stringify(row);
    pending.push(json);
    pendingBytes += json.length;
  }
};
let carry = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) {
  carry += chunk;
  let nl = carry.indexOf("\\n");
  while (nl !== -1) {
    const line = carry.slice(0, nl);
    carry = carry.slice(nl + 1);
    nl = carry.indexOf("\\n");
    if (line.length === 0) continue;
    if (context === null) {
      const c = JSON.parse(line);
      context = Object.freeze({ ...c, env: Object.freeze({ ...c.env }) });
      continue;
    }
    for (const record of JSON.parse(line)) {
      at += 1;
      emit(await fn({ record, context }));
      if (pendingBytes >= FLUSH_BYTES) await flush();
    }
  }
}
await flush();
await write('{"done":{"recordsIn":' + at + ',"peakKb":' + process.resourceUsage().maxRSS + '}}\\n');
`;
}

/* ------------------------------------------------------------------ the arms */

/** Counts what a sink would write, and holds none of it. */
function counter() {
  return { rowsOut: 0, nonNull: 0 };
}

function count(into, row) {
  into.rowsOut += 1;
  if (row.mgmtCd) into.nonNull += 1;
}

async function runBatch() {
  const started = Date.now();
  const ledger = blankRowLedger();
  const collected = [];
  for await (const record of sourceRecords(ledger)) collected.push(record);

  const input = JSON.stringify({
    records: collected,
    context: { contract: 1, rowCount: collected.length, inputs: [], env: {} },
  });

  const child = spawn(
    process.execPath,
    ['--input-type', 'module', '-e', batchHarness(BATCH_CODE)],
    CHILD_SPAWN,
  );
  let stdout = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  const closed = new Promise((resolve, reject) => {
    child.on('close', resolve);
    child.on('error', reject);
  });
  child.stdin.end(input);
  await closed;

  const parsed = JSON.parse(stdout.trim().split('\n').pop());
  const into = counter();
  for (const row of parsed.rows) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) continue;
    count(into, row);
  }
  return {
    ms: Date.now() - started,
    recordsIn: collected.length,
    ...into,
    childPeakKb: parsed.peakKb,
    blankRows: ledger.blankRows,
  };
}

function runStream(perLine) {
  return async () => {
    const started = Date.now();
    const ledger = blankRowLedger();

    const child = spawn(
      process.execPath,
      ['--input-type', 'module', '-e', streamHarness(RECORD_CODE)],
      CHILD_SPAWN,
    );
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));

    // The writer is a floating loop on purpose: awaiting it before draining
    // stdout is the one shape that deadlocks — the child blocks writing rows
    // nobody is reading, stops reading stdin, and this waits for a `drain` that
    // is never coming.
    let recordsIn = 0;
    let writerError;
    const writeLine = (text) =>
      child.stdin.write(text) ? undefined : new Promise((r) => child.stdin.once('drain', r));
    const writer = (async () => {
      await writeLine(`${JSON.stringify({ contract: 1, rowCount: 0, inputs: [], env: {} })}\n`);
      let chunk = [];
      for await (const record of sourceRecords(ledger)) {
        recordsIn += 1;
        chunk.push(record);
        if (chunk.length >= perLine) {
          await writeLine(`${JSON.stringify(chunk)}\n`);
          chunk = [];
        }
      }
      if (chunk.length > 0) await writeLine(`${JSON.stringify(chunk)}\n`);
      child.stdin.end();
    })().catch((error) => {
      writerError = error;
    });

    const into = counter();
    let childPeakKb = 0;
    let carry = '';
    for await (const chunk of child.stdout) {
      carry += chunk;
      let nl = carry.indexOf('\n');
      while (nl !== -1) {
        const line = carry.slice(0, nl);
        carry = carry.slice(nl + 1);
        nl = carry.indexOf('\n');
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.done) {
          childPeakKb = message.done.peakKb;
          continue;
        }
        for (const row of message.rows) count(into, row);
      }
    }
    await writer;
    if (writerError) throw writerError;

    return {
      ms: Date.now() - started,
      recordsIn,
      ...into,
      childPeakKb,
      blankRows: ledger.blankRows,
    };
  };
}

/** The floor: the same rename with no child process at all. */
async function runInProcess() {
  const started = Date.now();
  const ledger = blankRowLedger();
  const into = counter();
  let recordsIn = 0;
  for await (const record of sourceRecords(ledger)) {
    recordsIn += 1;
    count(into, {
      mgmtCd: record['Mgmt Cd'],
      vehTypeName: record['VEH Type Name'],
      assetNsn: record['Asset NSN'],
      regNumber: record['Reg Number'],
      vehCat: record['VEH Cat'],
    });
  }
  return {
    ms: Date.now() - started,
    recordsIn,
    ...into,
    childPeakKb: 0,
    blankRows: ledger.blankRows,
  };
}

const MODES = {
  batch: runBatch,
  'stream-1': runStream(1),
  'stream-500': runStream(500),
  floor: runInProcess,
};

/* ---------------------------------------------------------------------- driver */

const mode = process.argv[2];
if (mode) {
  const results = [];
  for (let i = 0; i < RUNS; i += 1) results.push(await MODES[mode]());
  const last = results[results.length - 1];
  process.stdout.write(
    `${JSON.stringify({
      mode,
      ms: results.map((r) => r.ms),
      recordsIn: last.recordsIn,
      rowsOut: last.rowsOut,
      nonNull: last.nonNull,
      blankRows: last.blankRows,
      parentPeakKb: process.resourceUsage().maxRSS,
      childPeakKb: last.childPeakKb,
    })}\n`,
  );
} else {
  const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const mb = (kb) => `${(kb / 1024).toFixed(0)} MB`;
  console.log(`fixture: ${fixturePath()}   runs per mode: ${RUNS}   passes per run: ${REPEAT}\n`);
  console.log(
    'mode         median ms   every run                      parent peak   child peak    records     rows   non-null   blank',
  );
  for (const name of Object.keys(MODES)) {
    const out = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [SELF, name], { stdio: ['ignore', 'pipe', 'inherit'] });
      let text = '';
      child.stdout.on('data', (chunk) => {
        text += chunk;
      });
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0
          ? resolve(JSON.parse(text.trim().split('\n').pop()))
          : reject(new Error(`${name} exited ${code}`)),
      );
    });
    console.log(
      [
        name.padEnd(12),
        String(median(out.ms)).padStart(9),
        `  ${out.ms.join(', ')}`.padEnd(31),
        mb(out.parentPeakKb).padStart(11),
        (out.childPeakKb ? mb(out.childPeakKb) : '—').padStart(12),
        String(out.recordsIn).padStart(10),
        String(out.rowsOut).padStart(8),
        String(out.nonNull).padStart(10),
        String(out.blankRows).padStart(7),
      ].join(' '),
    );
  }
}
