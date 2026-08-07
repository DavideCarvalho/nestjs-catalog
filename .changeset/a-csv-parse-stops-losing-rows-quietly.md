---
"@dudousxd/nestjs-catalog-pipeline": minor
---

A CSV parse stops losing rows quietly

`parseCsv` filtered all-blank rows out with a bare `.filter` and no counter, so
rows left the parser and were reported nowhere. Measured against flip's 21 LRS
drop: `af_fleet.csv` has **103,087** data rows and the source node reported
**102,519**. 568 rows, gone, with nothing anywhere saying so.

That test only passed by arithmetic coincidence. Those 568 rows carry a blank
`Mgmt Cd`, and the graph's filter dropped them for its own reasons — 13,629
minus 13,061 is exactly 568. On a source with **no row filter** they would have
gone straight out of the committed count with nothing to notice them by.

It is the one thing this library refuses to do everywhere else. The filter node
reports `rowsIn` and `rows` precisely so that a shrink is legible; the parser
was dropping rows with no ledger at all.

## What changed

**Not which rows come out.** The same lines are skipped for the same reason: a
line with no content in any cell would shape into a record whose every column is
the empty string, and the rows out of a CSV are meant to be the rows somebody
exported. Every existing graph loads exactly what it loaded before.

What is new is that the count comes back with them:

- `parseCsv` returns `blankRows` beside its records.
- `fetchFile` and the S3 object reader turn a non-zero count into a line on the
  new **`FetchResult.notes`** — the ledger for anything a source discarded on
  its own account, before the records reached anybody who counts them.
- `RecordStream` carries `notes` too, so both runners can read it.

## What a reader now sees, and where

On the run, immediately under the count it does not agree with:

```
Fetched 102519 records from file.
Skipped 568 blank lines in "/drops/af_fleet.csv": every cell on them was empty,
and they are not in the record count. A file ending in one newline does not
produce these, so they are empty lines in the file itself.
```

Both paths say it: a workflow **source node** puts it in that node's logs, and a
single-connector **run** puts it in the run's logs. The last sentence is there to
head off the reflex dismissal — "that will just be the trailing newline" — which
would be wrong, and would put the number straight back to being ignored.

An S3 prefix reports **one** aggregated line rather than one per object, naming
the total and the first affected key. A prefix is routinely hundreds of part
files, and a note apiece would be truncated by the node's log cap, pushing out
the lines that say what the run actually did.

## It does not cry wolf

A file ending in a single newline produces **no** note, which is the constraint
the whole fix had to clear. `splitCsvRows` closes its last row at the `\n` and
starts no new one, so there is no phantom blank row to count — true for LF, for
CRLF, and for a file with no trailing newline at all. A non-zero count means
genuinely empty lines in the file.

Three cases pin that, deliberately: a well-meant change to the scanner could
turn this ledger into a line on every well-formed file without failing anything
else in the suite.

## Also now visible

A blank line **before** the header is counted as well. It does not merely get
skipped — it changes which line the header is read from, silently. The behaviour
is unchanged, but it is now said out loud, which is the only way anybody would
find it.

`minor` rather than `patch`: no export was removed and no signature a consumer
calls changed shape, but `FetchResult` and `RecordStream` both gained a field,
and a custom `SourceFetcher` in a consumer's tree can now say something it could
not say before.
