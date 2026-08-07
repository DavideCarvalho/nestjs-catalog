---
'@dudousxd/nestjs-catalog': minor
'@dudousxd/nestjs-catalog-pipeline': minor
'@dudousxd/nestjs-catalog-store-mikro-orm': minor
'@dudousxd/nestjs-catalog-react': minor
---

A transform can declare that it is a function over **one record**, and then the whole graph streams

File reads have streamed since #96 — `af_fleet.csv`, 102,520 records, peaks at
18.7 MB streamed against 104.7 MB whole. **Any transform cancelled that**, because
a transform was by definition a function over the whole batch, so the runner had
to buffer the source before it could call anything. And that was not an edge
case: a column rename is mandatory for every DPAS file this ingests, since real
headers contain spaces (`Mgmt Cd`, `Asset Id`) and both
`WORKFLOW_FILTER_COLUMN_PATTERN` and `property-names.ts` refuse them. The
commonest graph in the system was the one that switched streaming off.

So a transform now says which contract it is written against:

```js
export default function transform({ record, context }) {
  return { mgmtCd: record['Mgmt Cd'] };
}
```

Return one object, an array of them (fan-out), or `null` (drop). The runner feeds
the source into a child process as NDJSON and pulls rows back as they are
produced, so the source, the child and the sink all run at once and nothing
anywhere holds the dataset.

**Measured through the shipped runner**, end to end from the unopened file, over
the real 102,520-record `af_fleet.csv` — `packages/catalog/bench/transform-stream.mjs`:

| | wall clock | peak RSS |
|---|---|---|
| whole batch | 938 ms | 636 MB |
| per record | 485 ms | 154 MB |
| in-process floor | 281 ms | 118 MB |

Scale is where it stops being a percentage. Reading the same file three times —
307,560 records — the **whole-batch arm fails outright**: its single JSON result
is 44 MB against a 32 MB `MAX_OUTPUT_BYTES`, so the child is killed and the load
cannot be done at all. The streamed arm holds **159 MB** for the same data, and
**231 MB at 1,230,240 records** — twelve times the fixture, for one and a half
times the memory, where the batch path stops at roughly 230,000 rows of this
shape.

**The row counts are identical across every arm at every size** — 102,520
records, 102,520 rows, 89,459 with a non-null `Mgmt Cd` — and they are stated
here because a faster transform that loses a row is a failure, and chunk
boundaries are exactly where that hides. They agree at 1×, 3× and 12×, which is
what makes it a claim about the framing rather than about one lucky size.

**Nothing stored changes.** `mode` is absent on every transform written before
this, absent means `'batch'`, and a batch transform is called once with every
record exactly as it always was — which is what aggregating, deduplicating and
sorting need, and none of them can be written per record.

The mode is **declared and never inferred**. Destructuring is not reliably
introspectable and a parameter name is the author's to choose, and both wrong
guesses commit silently: guess towards per-record and an aggregation returns one
partial answer per record; guess towards batch and a per-record function reads
`undefined` off every property. It follows the `callMode` discriminant from #93 —
`TRANSFORM_MODES`, `isTransformMode`, `unreachableTransformMode` — so a third
calling convention is a compile error naming the files that owe it a harness, a
transport and a consumer.

Also:

- **The timeout becomes a stall clock for a stream, and total wall clock is given
  up deliberately.** A streamed transform's elapsed time would include waiting on
  its source, which the batch path finished before it spawned anything — so the
  old bound would fail loads that work today for reasons that have nothing to do
  with the transform. What is bounded instead is the child owing an answer and
  nobody hearing one: a hang is caught, a slow source is not, and a slow sink
  back-pressuring the chain is not. Whole-batch transforms keep the total bound
  byte for byte.
- **A failure names where it happened.** A batch call could only report that the
  transform threw; a stream reports `failed on record 618`. A killed child cannot
  say where it got to, so a stall reports the window it stopped in rather than
  picking a record inside it. Rows already produced sit in an uncommitted
  snapshot and **no watermark moves** — the commit is above this path and is
  never reached.
- **Isolation is unchanged**, and shared through one `CHILD_PROCESS_OPTIONS`
  object rather than two literals: the same `{PATH, NODE_ENV}`, the same
  temporary cwd, the same process group, the context still travelling beside the
  records rather than in `env`. The child is not longer-lived than the batched
  one — both live for exactly one node run.
- **What a per-record transform may retain** is stated and enforced rather than
  assumed: it cannot see other records (there is no array in scope), it cannot
  emit at the end (there is no finish hook, so an accumulated aggregate has
  nowhere to go and the node's row count is zero — loud, not silently wrong), and
  it cannot retain anything past the node (process lifetime). It *can* hold
  module-scope state for one run, which no harness can prevent without forbidding
  modules, so that is written down rather than pretended otherwise.
- **Two combinations are refused by name**, at save and again at run: a
  per-record transform must be a module (a bare body has `records` in scope by
  the harness's own construction), and it cannot be Python yet (that harness
  writes the `def` and there is no second one). `recordModeRefusal` is exported
  from `/client`, so the editor refuses with the server's own sentence rather
  than a second copy of the rule.
- **The workflow transform node streams too**, using the filter node's loop —
  one staged batch in, coalesced full batches out, the same stale-tail sweep —
  rather than a second answer to where a batch boundary falls. It reports
  `rowsIn` beside `rows`, as the filter node does.
- `CatalogRecordTransformInput` and `CatalogRecordTransformFunction` are exported
  from `/client` for editor help, and cost nothing at run time for the reason
  their batch twins do.
- A `mode` change bumps the transform's version and shows as a field diff in a
  promotion plan, because it changes what the same text computes — a promotion
  reporting "nothing to release" for it would leave production on the other
  contract.
- `TransformRunner.runStream` is **optional**. A deployment that swapped the
  runner for a container still runs per-record transforms, buffered, through
  `run`; `supportsTransformStreaming` is how a caller asks.
