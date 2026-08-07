---
'@dudousxd/nestjs-catalog': minor
'@dudousxd/nestjs-catalog-pipeline': minor
'@dudousxd/nestjs-catalog-react': minor
'@dudousxd/nestjs-catalog-store-mikro-orm': minor
---

A `rename` node kind: declarative column renaming, with no author code.

The generic `transform` continues to exist for everything else, and that is
what lets this node stay narrow. The answer to "I need more than renaming" is
always *use a transform*, never *add a field here*.

**The config** is a map of old name → new name, applied simultaneously, plus
`unnamed: 'keep' | 'drop'` for the columns it does not mention (absent means
`keep`). A target that is not a column name, and two columns renamed onto one
name, are refused when the graph is saved. A rename onto a name the rows
already hold fails the node naming both columns; under `drop` there is nothing
to collide with.

**Why it is a kind rather than a transform.** A rename is per record, so it
streams by construction and never holds a batch. It needs no child process. And
on staged data it is metadata-only: a staged batch names its columns once, in
`shapes`, and keeps the values in positional arrays, so renaming a column
rewrites a handful of strings and moves no data at all. Dropping a column
removes a position and does cost a pass over the rows — the run log says which
one happened.

**Authoring-time schema.** A rename with `unnamed: 'drop'` has an output column
set known exactly from its config, so `workflowKnownColumns` can answer for
anything downstream of one. A filter or a second rename naming a column that
cannot be there is now refused when the graph is saved rather than discovered
when the load comes out empty.

`CatalogStageStore` gains two optional members, `readStagePayload` and
`writeStagePayload`, probed by `supportsStagePayloads`. A store without them
keeps working: the rename falls back to the row path and produces identical
rows through the same rename function.
