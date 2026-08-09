---
'@dudousxd/nestjs-catalog': minor
'@dudousxd/nestjs-catalog-store-mikro-orm': minor
'@dudousxd/nestjs-catalog-pipeline': minor
---

An archived snapshot carries the two reserved columns a merge reads, and not `_batch`

`streamSnapshot` takes an optional fourth argument, `{ provenance: true }`, which
adds `_principal_id` and `_loaded_at` to every row it hands over. The snapshot
archiver writes both into the parquet file and lists them in the manifest, and
refuses a stream that does not carry them.

**Which reserved columns a copy of a snapshot has to hold, asked of all five.**
`carryForward` copies `_principal_id` and `_loaded_at` off the snapshot it merges
against, untouched and deliberately — a carried row is not a new load of that
row, so restamping them would erase the one thing they are good for. A snapshot
produced by an incremental run therefore holds two answers to "who loaded this
and when", and nothing else records the difference: `catalog_snapshot` names only
the run that committed it. An archive without them makes a restored snapshot
answer "whoever ran the restore" for every row, and the next incremental load
carries that forward, and the one after it.

**`_batch` is not archived, and the previous note claiming it was "a prerequisite
for anything that deletes" is withdrawn.** Nothing reads a committed snapshot's
`_batch`: the batch-replace predicate and the merge's self-feed guard both scope
to the snapshot being built, and `carryForward` joins the previous snapshot on
its primary key without looking at its `_batch` at all. The `-1` marker records
that a merge happened; it is never an input to the next one. It could not be
restored in any case — `write` refuses a negative batch by name, and that is the
only seam a restore has. `_snapshot_id` stays in the manifest, being one value
per archive, and `_row` stays implicit in the file's order.

The two columns cost **0.028 bytes per row**, +0.02%, measured over 200,000 rows
of a 24-column type. `_batch` would have cost 0.029 B/row, so size decided
nothing either way.

The addition is under the archiver's existing verification — the checksum hashes
every archive column — plus one check the other three could not make: a stream
with no provenance on it is refused on the way in, because an absent key encodes
as a null, and a null verifies against a null.

The shared store contract gains two cases for `streamSnapshot`, skipped out loud
by an adapter that does not implement it.
