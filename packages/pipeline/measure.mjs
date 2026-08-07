import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';

const FILE = '/home/dudousxd/documents/flip/flip-python-db/sampleFiles/21st/june-2026/DOD SAFE-PocAncIqXAAUjMA0/to-upload/af_fleet.csv';
const mode = process.argv[2];

function peak() { return process.memoryUsage(); }
let maxHeap = 0, maxRss = 0;
const timer = setInterval(() => {
  const m = process.memoryUsage();
  if (m.heapUsed > maxHeap) maxHeap = m.heapUsed;
  if (m.rss > maxRss) maxRss = m.rss;
}, 5);
timer.unref();

const { csvRecords, blankRowLedger, decodeChunks } = await import('./dist/record-streams.js');

const started = Date.now();
let count = 0;
const ledger = blankRowLedger();
let nonNullMgmt = 0;
let header = null;

if (mode === 'whole') {
  // The old shape: whole file into a buffer, decoded into one string, every
  // record built before anything consumes them.
  const bytes = await readFile(FILE);
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8');
  const records = [];
  async function* one() { yield text; }
  for await (const r of csvRecords(one(), ',', FILE, ledger)) records.push(r);
  count = records.length;
  for (const r of records) if (r['Mgmt Cd'] !== null && r['Mgmt Cd'] !== undefined) nonNullMgmt += 1;
  header = Object.keys(records[0]);
} else {
  for await (const r of csvRecords(decodeChunks(createReadStream(FILE)), ',', FILE, ledger)) {
    count += 1;
    if (r['Mgmt Cd'] !== null && r['Mgmt Cd'] !== undefined) nonNullMgmt += 1;
    if (!header) header = Object.keys(r);
  }
}

clearInterval(timer);
const m = process.memoryUsage();
if (m.heapUsed > maxHeap) maxHeap = m.heapUsed;
if (m.rss > maxRss) maxRss = m.rss;
console.log(JSON.stringify({
  mode, records: count, blankRows: ledger.blankRows, nonNullMgmt,
  columns: header.length,
  peakHeapMB: +(maxHeap / 1048576).toFixed(1),
  peakRssMB: +(maxRss / 1048576).toFixed(1),
  ms: Date.now() - started,
}));
