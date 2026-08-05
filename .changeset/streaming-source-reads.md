---
'@dudousxd/nestjs-catalog-pipeline': minor
---

Bound the read side of a connector run, and stop a lost attempt vanishing without trace.

`fetchSql` awaited the whole result set, so the driver materialised every row before the pipeline
ran at all. The write side has been bounded since it was written — 500 rows per batch — and the read
side was the half nobody had bounded: a 981,469-row table never committed a row across three
attempts, because the step's lease expired while the rows were still arriving, with `fetched = 0`
and no error recorded on the run, the durable run or the step.

- **`SourceFetcher` may now return an async iterable of records** alongside the two shapes it always
  had, with `state` as a function the runner calls once the rows have run out — a streamed watermark
  is a running maximum and is not final until the read is. Every bundled fetcher except the SQL one
  still returns an array, unchanged. `toRecordStream`, `toBufferedFetchResult` and
  `StreamedFetchResult` are exported for hosts with their own fetchers; `toFetchResult` is untouched.
- **MySQL reads through mysql2's row stream**, so back-pressure reaches the socket and the pipeline
  holds a batch rather than a table. **Postgres does not**: plain `pg` buffers the result set inside
  the driver, and streaming it needs the explicit portal in `pg-cursor`/`pg-query-stream`, which this
  package does not require. A Postgres connector over a large table still needs a `watermarkColumn`
  or a `LIMIT`.
- **A connector that names a transform still reads everything into memory, deliberately.** A
  transform is a function over a batch — the contract says so, and it is what lets one deduplicate,
  aggregate or join — so chunking the calls would change what an aggregating transform computes
  without failing. The behaviour is unchanged; what is new is a run log line saying that this is why
  the read was held.
- **A run left open by an attempt that never came back is now closed by the next attempt at the same
  snapshot**, as `failed`, with a message saying what that state means and where the engine records
  its side of it. The last attempt of a series is still never closed, because nothing runs after it.
- A long read now reports progress on the process log every twenty batches, so a slow load is
  distinguishable from a wedged one while it is happening.

The incremental watermark, the `expectShrink` acknowledgement, the row-count bound, the empty batch a
full load of zero rows writes and the `fetched`/`written` counts are all unchanged: the watermark is
the same comparison fed from a loop instead of an array, and the bounds were always computed by the
store at commit rather than from the runner's records.
