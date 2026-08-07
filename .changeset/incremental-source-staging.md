---
'@dudousxd/nestjs-catalog-pipeline': minor
---

A workflow source node stages its output as the fetcher produces it

`runSource` buffered the whole read into an array and handed it to `stage`. The comment there argued the array bought nothing to remove, because `stage` was one write of one finished array — which was true of `stage` and had stopped being true of the fetchers: file, S3 and SQL sources have handed rows over incrementally since they began to stream, so the array was the only thing left holding a load, inside a durable step, on top of whatever the parse was already holding.

Now `stageStream` writes batch *n* while the fetcher is producing batch *n + 1*, and does not ask for the next record until the previous write has finished — so back-pressure reaches the file descriptor through the stage store, and a `source → rename → sink` graph streams end to end.

What deliberately did not change:

- **Batch numbering is still a position.** Batch *n* is staged rows `(n-1)*500` to `n*500` of the source's record order, with no number skipped and the non-object filter applied before the boundary — the same numbers the buffered path produced over the same read. A retried step writes the *same* numbers over the same stage and each one replaces itself.
- **The stale tail is still swept.** `clearStaleTail` runs after the drain, so a shorter second attempt cannot leave a longer first attempt's batches readable. It is called by `runSource` rather than by `stageStream` because the caller has counts to report above it in the run log.
- **The watermark still cannot advance on a partial read.** `state()` is asked only after the stream has drained, so a read that dies on batch 7 of 20 never reaches it and writes no `pending` at all. The batches it did stage sit in an uncommitted snapshot and are read again next time.
- **The durable checkpoint is unchanged.** A node is the unit of resumption; a step's output is checkpointed only when the step returns. A crash mid-stage therefore re-runs the node from the start of the read on the next attempt, exactly as it did when the read was buffered — incremental staging makes a failed attempt leave *more* batches behind, not a partly-resumable node, and the numbering and the sweep are what make that harmless.

`toBufferedFetchResult` is unchanged and still exported; schema discovery is now its only caller.
