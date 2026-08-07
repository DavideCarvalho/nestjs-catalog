/**
 * What a per-record streaming transform costs against the whole-batch one, and
 * against the in-process floor neither can beat.
 *
 * ## Why this exists next to `transform-transport.mjs`
 *
 * That script answered "where does the wall clock go" for one whole-batch call
 * and found the author's `.map` at 1.5% of it. This one answers the question
 * that follows — whether feeding the same child NDJSON recovers any of the other
 * 98.5% — and it answers a second one the first could not ask at all: **what is
 * held in memory while it happens.**
 *
 * ## It measures the shipped runner, not a model of it
 *
 * `SubprocessTransformRunner` itself, from `dist`, through `run` and
 * `runStream`. A bench with its own copy of the harness measures a prototype and
 * drifts from the thing it is quoted about; the numbers below are ones somebody
 * can act on precisely because the code under them is the code that runs a load.
 *
 * ## Every arm is timed end to end, from the unopened file
 *
 * That is the one thing this had to get right and the easy thing to get wrong. A
 * whole-batch transform must read the entire source before it can spawn
 * anything, so timing it from the spawn hides the read it forced; a stream
 * overlaps the read with the mapping, so timing it from the first record charges
 * it for a read the other arm was not charged for. Both arms therefore start at
 * `createReadStream` and stop when the last row has been counted, which is the
 * only comparison a load actually experiences.
 *
 * The fixture is read through the pipeline package's **real** streaming CSV
 * reader, so "source → transform → sink streams" is measured rather than
 * asserted, and the row counts are the counts a real load would get — blank
 * lines skipped and all.
 *
 * ## Reading the output
 *
 * Each arm runs in **its own process**, re-spawned by this script, because
 * `process.resourceUsage().maxRSS` is a high-water mark for the life of a
 * process: running two arms in one would report the larger of them twice.
 *
 * ```
 * AF_FLEET=/path/to/af_fleet.csv node packages/catalog/bench/transform-stream.mjs
 * ```
 *
 * **Point `AF_FLEET` at a real CSV, not at a copy pulled out of an object store's
 * on-disk layout.** MinIO writes a 32-byte bitrot checksum at the head of every
 * 1 MiB block of a part file, so a `part.1` carved out by hand has binary spliced
 * into the middle of a data row every megabyte — and when one of those checksums
 * happens to contain a `0x0A`, it splits a row and the record count comes out one
 * high. That is not hypothetical; it is how this bench was first run, and it cost
 * an afternoon of wondering whether a chunk boundary had eaten a row. The counts
 * printed below are the check: they must match what the drop is known to hold.
 *
 * `REPEAT=n` reads the fixture n times per run, back to back, which is what
 * turns "the stream holds less" into "the stream holds a constant". Raising it
 * is also how the whole-batch arm's hard ceiling shows up: past about 235,000
 * rows of this shape its single JSON result exceeds `MAX_OUTPUT_BYTES` and the
 * run **fails** — which is not a slow load, it is a load that cannot be done at
 * all. The streamed arm has no such ceiling, because what it bounds is one
 * flush rather than the whole result.
 *
 * Build first: this imports from `packages/catalog/dist` and
 * `packages/pipeline/dist`.
 */
import { spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { SubprocessTransformRunner } = await import(
  new URL('../dist/index.js', import.meta.url).href
);
const { csvRecords, decodeChunks, blankRowLedger } = await import(
  new URL('../../pipeline/dist/record-streams.js', import.meta.url).href
);

const SELF = fileURLToPath(import.meta.url);
const RUNS = Number(process.env.RUNS ?? 5);
const REPEAT = Number(process.env.REPEAT ?? 1);

/**
 * Far above anything here, because this bench is not measuring the timeout.
 *
 * The default is thirty seconds, and it means different things on the two arms —
 * total wall clock for a batch, a stall for a stream — so leaving it in place
 * would put a bound on one arm that does not apply to the other. See
 * `RecordStreamPump` for why the two differ.
 */
const TIMEOUT_MS = 600_000;

const runner = new SubprocessTransformRunner();

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

/** The source as a connector sees it: an iterable that has not opened the file. */
async function* source(ledger) {
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

/* ------------------------------------------------------------------- the arms */

/**
 * A sink that counts and holds nothing, standing in for `appendBatches`.
 *
 * Counting rather than collecting matters as much here as it does in the
 * runner: an array of the rows would make every arm's peak the same number and
 * measure this script instead of the code.
 */
function sink() {
  return {
    rowsOut: 0,
    nonNull: 0,
    take(row) {
      this.rowsOut += 1;
      if (row.mgmtCd) this.nonNull += 1;
    },
  };
}

async function batch() {
  const started = Date.now();
  const ledger = blankRowLedger();
  const records = [];
  for await (const record of source(ledger)) records.push(record);

  const result = await runner.run({ language: 'javascript', code: BATCH_CODE }, records, {
    timeoutMs: TIMEOUT_MS,
  });
  const into = sink();
  for (const row of result.rows) into.take(row);
  return {
    ms: Date.now() - started,
    recordsIn: records.length,
    rowsOut: into.rowsOut,
    nonNull: into.nonNull,
    blank: ledger.blankRows,
  };
}

async function record() {
  const started = Date.now();
  const ledger = blankRowLedger();
  const stream = await runner.runStream(
    { language: 'javascript', code: RECORD_CODE, mode: 'record' },
    source(ledger),
    { timeoutMs: TIMEOUT_MS },
  );

  const into = sink();
  for await (const row of stream.rows) into.take(row);
  const summary = stream.summary();
  return {
    ms: Date.now() - started,
    recordsIn: summary.recordsIn,
    rowsOut: into.rowsOut,
    nonNull: into.nonNull,
    blank: ledger.blankRows,
  };
}

/** The floor: the same rename with no child process at all. */
async function floor() {
  const started = Date.now();
  const ledger = blankRowLedger();
  const into = sink();
  let recordsIn = 0;
  for await (const r of source(ledger)) {
    recordsIn += 1;
    into.take({
      mgmtCd: r['Mgmt Cd'],
      vehTypeName: r['VEH Type Name'],
      assetNsn: r['Asset NSN'],
      regNumber: r['Reg Number'],
      vehCat: r['VEH Cat'],
    });
  }
  return {
    ms: Date.now() - started,
    recordsIn,
    rowsOut: into.rowsOut,
    nonNull: into.nonNull,
    blank: ledger.blankRows,
  };
}

const ARMS = { batch, record, floor };

/* ---------------------------------------------------------------------- driver */

const arm = process.argv[2];
if (arm) {
  const results = [];
  for (let i = 0; i < RUNS; i += 1) results.push(await ARMS[arm]());
  const last = results[results.length - 1];
  process.stdout.write(
    `${JSON.stringify({ ...last, arm, ms: results.map((r) => r.ms), peakKb: process.resourceUsage().maxRSS })}\n`,
  );
} else {
  const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const mb = (kb) => `${(kb / 1024).toFixed(0)} MB`;
  console.log(`fixture: ${fixturePath()}   runs per arm: ${RUNS}   passes per run: ${REPEAT}\n`);
  console.log(
    'arm       median ms   every run                       peak     records     rows   non-null   blank',
  );
  for (const name of Object.keys(ARMS)) {
    const out = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [SELF, name], { stdio: ['ignore', 'pipe', 'pipe'] });
      let text = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        text += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', reject);
      // A failed arm is reported rather than thrown, because a whole-batch arm
      // that cannot complete at this size IS the result at this size — and
      // aborting the script would take the arms that did complete with it.
      child.on('close', (code) =>
        code === 0
          ? resolve(JSON.parse(text.trim().split('\n').pop()))
          : resolve({
              // The thrown message, not the source line above it that node
              // echoes first — the whole value of reporting a failed arm is the
              // sentence that says why.
              failed:
                stderr.split('\n').find((line) => line.trimStart().startsWith('Error:')) ??
                `exit ${code}`,
            }),
      );
    });
    if (out.failed) {
      console.log(`${name.padEnd(9)} ${'—'.padStart(9)}   FAILED: ${out.failed.trim()}`);
      continue;
    }
    console.log(
      [
        name.padEnd(9),
        String(median(out.ms)).padStart(9),
        `  ${out.ms.join(', ')}`.padEnd(32),
        mb(out.peakKb).padStart(7),
        String(out.recordsIn).padStart(11),
        String(out.rowsOut).padStart(8),
        String(out.nonNull).padStart(10),
        String(out.blank).padStart(7),
      ].join(' '),
    );
  }
}
