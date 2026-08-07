---
'@dudousxd/nestjs-catalog': minor
'@dudousxd/nestjs-catalog-store-mikro-orm': minor
---

Staged batches are written columnar: each key-set once per batch, not once per row.

`catalog_workflow_stage.rows` held a JSON array of row objects, so every property name was written
out again for every row — `Sub_Work_Order_State_Cd` 500 times per batch, once per row, for 85
properties. On one deployment that is 9.04 GB across ~16,233 staged batches in a week, on graphs
that are two nodes long.

**Why this and not fusing the nodes.** A two-node graph has no second consumer that the
materialisation serves, so handing the array over in memory is the obvious cut — and it is the wrong
one. The stage is not a cache: the durable engine checkpoints a step's output so that a crash
resumes instead of re-reading the source, and a two-node graph is exactly the case where re-reading
the source is the expensive thing. Fusing spends the resume guarantee to buy the speed. This keeps
the guarantee and makes it cheaper, which is why it is a `minor` and not a change anybody has to
reason about before upgrading.

**The shape is a shape dictionary**, not a single column list: `shapes` holds each distinct key-set
in the batch once, `shapeOf[i]` says which one row `i` uses, and `values[i]` runs parallel to it. A
padded union column list would have been simpler and could not say **absent** — a row that lacks
`note` and a row whose `note` is `null` are different facts, and every sentinel that could stand for
the first inside a JSON array is also a value a row is entitled to hold. Naming each row's own
key-set has the distinction built in. It also degrades gracefully: a batch of 500 mutually distinct
rows stores 500 key-sets, which is what the old encoding stored anyway, where a padded union list
would have been far worse than what it replaced.

**Old batches still read, and are told apart by JSON type rather than by inspection.** The previous
writer only ever `JSON.stringify`'d an array, and this one only ever writes an object tagged
`"enc": "columnar"`. A top-level JSON value cannot be both, so no batch matches both branches and
nothing is inferred from what the rows look like — an empty legacy batch, where a
contents-sniffing discriminator would have nothing to read, classifies as cleanly as a full one.
Anything else throws by name, including a version this build does not know: a stage that decoded to
`[]` would reach an incremental sink as "nothing changed", and carry-forward would commit a snapshot
quietly missing whatever the batch held.

There is **no migration and no new column** — a MySQL `JSON` column takes an object as readily as an
array — so batches already staged stay as they are, and a run in flight resumes onto them.

**Keys whose value is `undefined`, a function or a symbol are dropped, key and all**, which is what
`JSON.stringify` did to them under the old encoding, and what `codeContext` does deliberately for
the same reason.

**Key order now survives, which it did not before.** A MySQL `JSON` column stores a normalised
binary document in which an object's members are sorted by key length then bytes, so
`{zebra, a, Middle_Name, b}` came back as `{a, b, zebra, Middle_Name}` — every staged row has been
returning reordered since the stage existed. Here the names live in an array, whose order that format
keeps. Nothing downstream depended on either behaviour: the warehouse stores build their column list
from the object type's declared properties and read each row by name, and the three places a row's
key order does decide something (schema discovery's proposed column order, `csvLines` without an
explicit column list, the ClickHouse ad-hoc query fallback) none of them read a staged batch.

Measured on the shipped store, 50,000 rows, real column lists, `BATCH_SIZE = 500`, five interleaved
samples: the 85-column shape's round trip falls from 8,630 ms (±593) to 4,980 ms (±130), a 42%
saving, and the bytes in the table from 133.2 MB to 66.7 MB — 49.9% smaller. The 42-column shape
saves 34.5% of its round trip and 46.2% of its bytes. The saving arrives mostly through the
`INSERT`, whose cost is linear in bytes, and not through the parse.

New from `@dudousxd/nestjs-catalog`: `encodeStageRows`, `decodeStageRows`, `classifyStagePayload`,
`isColumnarStageBatch`, `ColumnarStageBatch`, `StagePayload`, `STAGE_ENCODING`,
`STAGE_ENCODING_VERSION` — exported because `CatalogStageStore` is a seam a host can implement, and
two stores encoding the same batch differently would be a run that cannot resume across a deployment
that changed its mind about where stages live.
