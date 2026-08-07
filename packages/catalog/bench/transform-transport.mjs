/**
 * Where the wall clock actually goes when a transform runs over a real batch.
 *
 * ## Why this exists
 *
 * "Is `.map()` the fast way to do this?" is the first question anybody asks
 * about a transform, and it has an answer that cannot be reached by reading the
 * code: the map is a rounding error and the transport is everything. This script
 * is that answer, reproducible, rather than an assertion in a docblock.
 *
 * Run it:
 *
 * ```
 * node --max-old-space-size=8192 packages/catalog/bench/transform-transport.mjs
 * ```
 *
 * It mirrors `SubprocessTransformRunner.run` seam for seam — same spawn options,
 * same trimmed environment, same envelope on stdin, same single JSON line back —
 * with a timestamp at each boundary. The child reports its own marks as epoch
 * milliseconds inside the result, so both sides lay on one timeline with no
 * clock alignment to get wrong. The instrumentation costs something itself
 * (roughly 15% against the real runner on the same fixture); what it is for is
 * the *proportions*, which it does not distort.
 *
 * ## The fixture
 *
 * A DPAS-shaped CSV: about 103,000 rows and five columns whose headers contain
 * spaces — `Mgmt Cd`, `Asset NSN`, `Reg Number`. That shape is the point. Those
 * headers are illegal as property names, so a pure column rename is not an
 * occasional transform in a system like this one; it is mandatory for every such
 * file, and it is therefore the transform whose cost is worth knowing exactly.
 *
 * Point `AF_FLEET` at a real file to use one. Without it, an equivalent is
 * generated, so the numbers are reproducible on a machine that has no such file.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HEADERS = ['Mgmt Cd', 'VEH Type Name', 'Asset NSN', 'Reg Number', 'VEH Cat'];
const GENERATED_ROWS = 103_087;

function readRecords() {
  const path = process.env.AF_FLEET;
  if (!path || !existsSync(path)) return generateRecords();

  const lines = readFileSync(path, 'utf8').split('\n');
  const header = lines[0].split(',');
  const records = [];
  for (let i = 1; i < lines.length; i += 1) {
    if (!lines[i]) continue;
    const cells = lines[i].split(',');
    const record = {};
    for (let c = 0; c < header.length; c += 1) record[header[c]] = cells[c] ?? '';
    records.push(record);
  }
  return { records, from: path };
}

function generateRecords() {
  const records = new Array(GENERATED_ROWS);
  for (let i = 0; i < GENERATED_ROWS; i += 1) {
    records[i] = {
      'Mgmt Cd': `C${600 + (i % 40)}`,
      'VEH Type Name': 'DEICER TRUCK MOUNTED',
      'Asset NSN': '1730005556205YW',
      'Reg Number': `09C${String(i).padStart(5, '0')}`,
      'VEH Cat': 'Aircraft Towing/Servicing',
    };
  }
  return { records, from: 'generated (set AF_FLEET to use a real file)' };
}

/** The transform every DPAS file needs and no DPAS file can do without. */
const AUTHOR_CODE = `return records.map((r) => ({
  mgmtCd: r["Mgmt Cd"],
  vehTypeName: r["VEH Type Name"],
  assetNsn: r["Asset NSN"],
  regNumber: r["Reg Number"],
  vehCat: r["VEH Cat"],
}));`;

function harness(code) {
  return `
const M = { start: Date.now() };
let input = "";
process.stdin.setEncoding("utf8");
M.beforeRead = Date.now();
for await (const chunk of process.stdin) input += chunk;
M.afterRead = Date.now();
const payload = JSON.parse(input || "{}");
M.afterParse = Date.now();
const records = Array.isArray(payload.records) ? payload.records : [];
const context = Object.freeze({ ...payload.context, env: Object.freeze({ ...payload.context?.env }) });
const transform = async (records, context) => { ${code} };
const rows = await transform(records, context);
M.afterCode = Date.now();
// Serialised once, and the mark taken AFTER it. Putting \`Date.now()\` inside the
// object being stringified reads the clock while the argument is built — before
// a byte is written — which reports this phase as 0 ms and silently moves its
// cost into the phase after. The envelope is concatenated so the big array is
// still only serialised once.
const rowsJson = JSON.stringify(rows ?? []);
M.afterStringify = Date.now();
process.stdout.write('{"rows":' + rowsJson + ',"logs":[],"marks":' + JSON.stringify(M) + '}');
`;
}

function runOnce(records) {
  return new Promise((resolve, reject) => {
    const t = {};
    t.stringifyStart = Date.now();
    const input = JSON.stringify({
      records,
      context: { contract: 1, rowCount: records.length, inputs: [], env: {} },
    });
    t.stringifyEnd = Date.now();
    t.inputBytes = input.length;

    t.spawnCall = Date.now();
    const child = spawn(process.execPath, ['--input-type', 'module', '-e', harness(AUTHOR_CODE)], {
      env: { PATH: process.env.PATH ?? '', NODE_ENV: 'production' },
      cwd: tmpdir(),
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      t.close = Date.now();
      if (code !== 0 && stdout.trim().length === 0) {
        reject(new Error(`exit ${code}: ${stderr.slice(0, 400)}`));
        return;
      }
      t.parseStart = Date.now();
      const parsed = JSON.parse(stdout.trim().split('\n').pop() ?? '{}');
      // The same filter the real runner applies before it returns.
      const rows = parsed.rows.filter(
        (row) => typeof row === 'object' && row !== null && !Array.isArray(row),
      );
      t.parseEnd = Date.now();
      t.rows = rows.length;
      resolve({ t, marks: parsed.marks, outBytes: stdout.length });
    });

    t.writeStart = Date.now();
    child.stdin.write(input, () => {
      t.writeFlushed = Date.now();
    });
    child.stdin.end();
  });
}

/** The same rename with no child process: what a declarative path would cost. */
function inProcessRename(records) {
  const pairs = [
    ['Mgmt Cd', 'mgmtCd'],
    ['VEH Type Name', 'vehTypeName'],
    ['Asset NSN', 'assetNsn'],
    ['Reg Number', 'regNumber'],
    ['VEH Cat', 'vehCat'],
  ];
  const rows = new Array(records.length);
  for (let i = 0; i < records.length; i += 1) {
    const row = {};
    for (const [from, to] of pairs) row[to] = records[i][from];
    rows[i] = row;
  }
  return rows;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const { records, from } = readRecords();
const runs = Number(process.env.RUNS ?? 7);
console.log(`fixture: ${records.length} records — ${from}`);

const all = [];
for (let i = 0; i < runs; i += 1) all.push(await runOnce(records));

const direct = [];
for (let i = 0; i < runs; i += 1) {
  const t0 = Date.now();
  inProcessRename(records);
  direct.push(Date.now() - t0);
}

const phases = [
  ['parent JSON.stringify', (r) => r.t.stringifyEnd - r.t.stringifyStart],
  ['spawn -> child running', (r) => r.marks.start - r.t.spawnCall],
  ['stdin write (flushed)', (r) => r.t.writeFlushed - r.t.writeStart],
  ['child reads stdin', (r) => r.marks.afterRead - r.marks.beforeRead],
  ['child JSON.parse', (r) => r.marks.afterParse - r.marks.afterRead],
  ["the author's code (.map)", (r) => r.marks.afterCode - r.marks.afterParse],
  ['child JSON.stringify', (r) => r.marks.afterStringify - r.marks.afterCode],
  ['stdout read (parent)', (r) => r.t.close - r.marks.afterStringify],
  ['parent JSON.parse + filter', (r) => r.t.parseEnd - r.t.parseStart],
];

console.log(
  `\non the wire: ${(all[0].t.inputBytes / 1e6).toFixed(1)} MB in, ` +
    `${(all[0].outBytes / 1e6).toFixed(1)} MB out, ${all[0].t.rows} rows\n`,
);
console.log('phase                          median ms   every run');
for (const [name, of] of phases) {
  const values = all.map(of);
  console.log(`${name.padEnd(30)} ${String(median(values)).padStart(9)}   ${values.join(', ')}`);
}
const totals = all.map((r) => r.t.parseEnd - r.t.stringifyStart);
console.log(
  `${'TOTAL, subprocess'.padEnd(30)} ${String(median(totals)).padStart(9)}   ${totals.join(', ')}`,
);
console.log(
  `${'the same rename, in-process'.padEnd(30)} ${String(median(direct)).padStart(9)}   ${direct.join(', ')}`,
);
