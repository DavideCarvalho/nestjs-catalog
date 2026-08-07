---
"@dudousxd/nestjs-catalog": minor
"@dudousxd/nestjs-catalog-pipeline": minor
"@dudousxd/nestjs-catalog-react": minor
---

Spreadsheets are a source format, so `.xlsx` is now one

A `file` or `s3` connector could read CSV, NDJSON and JSON, which meant that an
ETL whose real input is a workbook could not be expressed as a workflow **at
all**. Not "awkwardly" — the drop that gets emailed to an operator every month
is a `.xlsx`, and there was no configuration of any node that would read it. The
failure was not even a refusal: the format chain ended in JSON, so a workbook
went to `JSON.parse` and came back as a syntax error at some byte offset, naming
neither the format nor the mistake.

`minor`, not `major`, and the reason to lead with is that one: a whole
real-world file format was unreachable, and this makes it reachable. Everything
else here follows from that. The package is 0.x, where a `minor` is where
features go and a `major` would announce a break that this does not contain — no
export was removed, no signature a consumer calls changed shape, and a connector
that reads CSV today reads the same CSV tomorrow.

**The format set is a list now.** `SOURCE_FORMATS`, `SourceFormat`,
`isSourceFormat` and `unreachableSourceFormat` ship from
`@dudousxd/nestjs-catalog`, the way `CONNECTOR_KINDS` already did. It replaces
three copies that had no way to disagree loudly — a string chain in the parser, a
second one in the extension guess, and a dropdown in the console. A fifth format
is now a compile error in each of them, and the console's labels are
`satisfies Record<SourceFormat, string>` so a format cannot be added to the
library and quietly missing from the picker.

**Sheets are chosen, never guessed.** A single-sheet workbook reads without
configuration. Anything else needs `sheet`, and is refused — with the sheet names
listed — rather than silently taking the first one. Taking the first is right
most of the time, and the rest of the time it loads the wrong rows under the
right name with nothing in the run to point at.

**Cells keep their types, and dates are the point.** Text stays text, numbers
stay numbers, booleans stay booleans, an empty or merged-over cell becomes `null`
the way a short CSV row does, and a cell holding `#REF!` is refused by address
rather than loaded as the string `"#N/A"` or as a null. A date becomes an
ISO-8601 string built from the cell's serial and the workbook's own epoch flag —
never the serial itself, never through a `Date`. That last part is not
fussiness: a date cell has no timezone, the conversion is done on calendar fields
so none is ever imposed, and two runs of the same file in two regions produce the
same string.

**Merged cells are not filled forward.** Only the anchor of a merged range holds
the value; every cell it covers arrives as `null`. Worth knowing before writing
the transform, because real exports lean on merges heavily — the sample this was
tested against has 1,732 merged ranges in 974 rows.

**The library is not a dependency.** It is loaded through `importOptional`, the
way `pg`, `mysql2` and the S3 SDK are, so a deployment that never opens a
workbook does not carry one. That is a security decision as much as a size one:
SheetJS stopped publishing to npm at `0.18.5`, and that version has two unfixed
advisories against it — CVE-2023-30533 and CVE-2024-22363, fixed in `0.19.3` and
`0.20.2`, neither of which is on npm. Depending on it directly would put a
permanently-vulnerable package in every consumer's tree, including the consumers
that never read a spreadsheet, and pin them to one choice of provenance. Install
`xlsx` from whichever patched distribution you trust and this reads it.

**One behaviour change worth naming.** A `format` the library does not recognise
is now refused, listing the ones it knows. It used to be read as JSON.
