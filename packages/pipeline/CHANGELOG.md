# @dudousxd/nestjs-catalog-pipeline

## 0.19.0

### Minor Changes

- 4991770: A transform can declare that it is a function over **one record**, and then the whole graph streams

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
    return { mgmtCd: record["Mgmt Cd"] };
  }
  ```

  Return one object, an array of them (fan-out), or `null` (drop). The runner feeds
  the source into a child process as NDJSON and pulls rows back as they are
  produced, so the source, the child and the sink all run at once.

  **Which path that makes end-to-end bounded, exactly.** A **connector** streams the
  whole way: `source.records` goes into the child and the child's rows go into
  `appendBatches`, so back-pressure reaches the file descriptor and nothing
  anywhere holds the dataset. A **workflow graph** does not, and this change does
  not claim to make it so — its source node still stages its whole output before
  any downstream node reads a row, by the design `runSource` documents and which is
  left untouched here. What a graph gains is that its _transform node_ no longer
  holds the whole of its input in the heap on top of that: it reads one staged
  batch, maps it, and writes what came out. Making the source node stage
  incrementally is the next change, and `runSource` names the line.

  **Measured through the shipped runner**, end to end from the unopened file, over
  the real 102,519-record `af_fleet.csv` — `packages/catalog/bench/transform-stream.mjs`:

  |                  | wall clock | peak RSS |
  | ---------------- | ---------- | -------- |
  | whole batch      | 586 ms     | 503 MB   |
  | per record       | 383 ms     | 153 MB   |
  | in-process floor | 207 ms     | 114 MB   |

  Scale is where it stops being a percentage. Reading the same file three times —
  307,557 records — the **whole-batch arm fails outright**: its single JSON result
  is 44 MB against a 32 MB `MAX_OUTPUT_BYTES`, so the child is killed and the load
  cannot be done at all. The streamed arm holds **152 MB** for the same data, and
  **217 MB at 1,230,228 records** — twelve times the fixture, for one and a half
  times the memory, where the batch path stops at roughly 235,000 rows of this
  shape.

  **The row counts are identical across every arm at every size** — 102,519
  records, 102,519 rows, 89,458 with a non-null `Mgmt Cd`, matching what
  `test-system/full-pipeline.system-spec.ts` expects of this drop — and they are
  stated here because a faster transform that loses a row is a failure, and chunk
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
    it cannot retain anything past the node (process lifetime). It _can_ hold
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

## 0.18.0

### Minor Changes

- 382b71d: A `rename` node kind: declarative column renaming, with no author code.

  The generic `transform` continues to exist for everything else, and that is
  what lets this node stay narrow. The answer to "I need more than renaming" is
  always _use a transform_, never _add a field here_.

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

## 0.17.0

### Minor Changes

- 547a2ed: Reading a file stops holding it, and parquet is a format

  Two things that are one subject: **file reads stream**, and **parquet is a
  source format** — because parquet's row groups are the clearest case of a
  format that was never meant to be read whole.

  ## What used to happen

  `file`, `s3` and `http` read the entire payload into memory before parsing a
  byte of it. For a 7.6 MB export that is the buffer, plus the decoded string,
  plus every record built out of it, held at once, inside a durable step. The S3
  fetcher was worse: it concatenated every object under the prefix into one array
  before returning, so ten 40 MB drops were 400 MB of records in the heap before a
  single row was written.

  The write side has been bounded since it was written — `appendBatches`, 500 rows
  at a time. The read side was the half nobody had bounded for anything but SQL.

  ## What streams now, and what does not

  | Format    | How it is read                  | Why                                                                                  |
  | --------- | ------------------------------- | ------------------------------------------------------------------------------------ |
  | `csv`     | stream                          | A row ends at a newline the scanner has already seen                                 |
  | `ndjson`  | stream                          | Same                                                                                 |
  | `parquet` | stream, one row group at a time | The format supplies the chunk boundary                                               |
  | `json`    | whole                           | One value; the array may be nested in an envelope only found by parsing down to it   |
  | `xlsx`    | whole                           | A ZIP whose shared-string table generally precedes the sheet — unchanged, cap intact |

  `http` is **left whole**, deliberately. An incremental JSON parser would still
  have to read down to `path` before yielding anything, and for a bare top-level
  array the elements it would then yield are the whole response. The honest bound
  for an HTTP source is pagination, which this connector does not do; streaming
  the body would move where the memory is held without changing how much there is.

  Measured on `af_fleet.csv` (7.6 MB, 103,087 data rows) with a consumer that
  discards each record, which is the shape `appendBatches` has:

  |          | peak heap   | peak RSS    | records | blank lines | non-null `Mgmt Cd` |
  | -------- | ----------- | ----------- | ------- | ----------- | ------------------ |
  | whole    | 104.7 MB    | 282.5 MB    | 102,519 | 568         | 89,458             |
  | streamed | **18.7 MB** | **94.3 MB** | 102,519 | 568         | 89,458             |

  Identical rows, 5.6× less heap. The counts are #94's numbers and flip's: 568
  blank lines skipped, 89,458 rows with a `Mgmt Cd`.

  ## Where a stream is still bounded

  Streaming removes the memory ceiling and not every risk.

  - **A remote read that goes silent** is not an error any SDK reports — it is a
    promise that never settles, holding a step until its lease expires with
    nothing recorded about why. `readIdleTimeoutMs` (default 60s, reset by every
    chunk) abandons it and says so.
  - **`maxBytes`** is opt-in per connector and refuses before the transfer when
    the server declared a length, and mid-transfer when it did not.
  - **`maxObjectsPerRun`** already bounded the S3 fan-out and still does.

  ## Back-pressure, and why S3 spools to disk first

  An `AsyncIterable` consumed slowly by something writing to MySQL is exactly the
  failure flip recorded: per-batch flushes paused the read for minutes and the
  object store reset the connection (ECONNRESET, three to four minutes in),
  because S3 closes a connection that has gone quiet. So every remote payload —
  S3 object or HTTP body — is **spooled to a temp file and streamed from there**.
  The download runs at full speed with nothing throttling it, and the slow half
  reads a local file that is not going anywhere. Cost: one object's worth of temp
  disk, released as soon as its records have been read. A local path is read
  where it lies; `createReadStream` pauses the descriptor while the consumer is
  away, which is the back-pressure, end to end.

  It also makes parquet possible at all: the footer is at the end and row groups
  are addressed by offset, so a reader seeks rather than walks.

  ## The watermark, on failure

  `StreamedFetchResult.state` was already "asked only after `records` is
  exhausted". The S3 fetcher now computes it from the objects whose **last record
  has gone past**, not from the listing. A run that dies on the fourth of ten
  objects never reaches `state()` and advances nothing; the three it did read are
  left in an uncommitted snapshot and read again next time. A watermark taken
  from the listing would have promised never to read five through ten again.

  `StreamedFetchResult` gains **`notes?: () => string[]`**, and `RecordStream.notes`
  becomes a function for the same reason `state` is one. #94's blank-line ledger
  is a running count over rows not yet read; asking for it before the last row
  would report zero for every streamed file, which is the exact silence #94 exists
  to end.

  ## Parquet

  **`hyparquet`**, loaded through the same optional-driver seam as `pg`, `mysql2`
  and the S3 SDK. Unlike `xlsx` this is _not_ a security workaround: hyparquet is
  MIT, has **no runtime dependencies at all**, publishes weekly and has no OSV
  advisory against any version — a plain dependency would be defensible. It is
  optional because this package ships with zero runtime dependencies and a
  consumer that never reads parquet should not acquire a decoder by installing a
  catalog. hyparquet decompresses UNCOMPRESSED and SNAPPY natively; anything else
  loads `hyparquet-compressors` if present, and is refused naming the codec, the
  file and the package if not.

  **Types.** Every temporal type becomes an ISO-8601 string in UTC, never a
  `Date`: a `TIMESTAMP(MICROS)` or a legacy `INT96` carries precision a `Date`
  cannot hold, and the library's default parser divides it away. A `DATE` becomes
  `YYYY-MM-DD` and stops there — turning a calendar day into midnight UTC invents
  an instant the file never contained.

  | Parquet                                      | Becomes                                                                  |
  | -------------------------------------------- | ------------------------------------------------------------------------ |
  | BOOLEAN, INT32, FLOAT, DOUBLE, FLOAT16       | number / boolean                                                         |
  | INT64 within ±2^53                           | number                                                                   |
  | INT64 outside it                             | **refused, by name and value**                                           |
  | STRING / UTF8 / ENUM                         | string                                                                   |
  | TIMESTAMP MILLIS/MICROS/NANOS, INT96         | ISO-8601 with 3 / 6 / 9 fractional digits                                |
  | DATE                                         | `YYYY-MM-DD`                                                             |
  | UUID                                         | canonical uuid string                                                    |
  | JSON                                         | the decoded value                                                        |
  | LIST / MAP / group                           | array / object, walked                                                   |
  | null                                         | `null`                                                                   |
  | DECIMAL, precision ≤ 15                      | number                                                                   |
  | DECIMAL, precision > 15                      | **refused by name** — read through a double, would lose digits           |
  | TIME (MILLIS/MICROS)                         | **refused by name** — a bare count since midnight with no unit           |
  | raw BYTE_ARRAY                               | **refused by name** — the default is to decode every byte array as UTF-8 |
  | INTERVAL, BSON, VARIANT, GEOMETRY, GEOGRAPHY | **refused by name**                                                      |

  Every refusal is made from the schema **before the first row is read**, so a
  column this cannot represent fails while the run has written nothing.

  **A null is `null`**, and that is parquet's own answer rather than a position in
  the CSV argument: presence lives in the definition levels, so a null field and a
  field holding `""` are different things _in the file_. A CSV genuinely contains
  an empty field where parquet contains an absence, so this format has nothing to
  say about which of those a blank CSV cell should be.

  ## Also

  `SOURCE_FORMATS` gains `parquet`; `.parquet` and `.parq` are recognised
  extensions; the console derives its picker from the list. `FORMAT_READING` is a
  `satisfies Record<SourceFormat, …>` map, so a sixth format is a compile error
  until somebody says whether it streams.

  `importOptional` moved to `optional-modules.ts` — unchanged, re-exported from
  `sources.ts`, and only so that the parquet reader and `sources.ts` are not an
  import cycle.

## 0.16.0

### Minor Changes

- a51bf27: A CSV parse stops losing rows quietly

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
  `null`, and the rows out of a CSV are meant to be the rows somebody exported.
  Every existing graph loads exactly what it loaded before.

  The counter runs on the raw cells, one line _before_ `emptyAsNull` maps a blank
  cell to `null`. That order is deliberate and is the thing to preserve on any
  future edit: it asks whether the **line** had any content, which is a question
  about the file, and by the time the mapping is done a row of empty cells and a
  row of real nulls are indistinguishable.

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

  ## One shape change worth naming

  `fetchFile` now always returns a `FetchResult` rather than sometimes a bare
  array, because it has somewhere to put the count. Both are inside
  `SourceFetcher`'s declared return type and every caller reads it through
  `toRecordStream` or `toBufferedFetchResult`, so nothing in the repository had to
  change — but a consumer calling `fetchFile` directly and indexing the result as
  an array would notice. Returning an array when there were no blank lines and an
  object when there were would have been worse: a shape that varies with the
  contents of the file is a shape every caller has to test.

  A workbook read carries no notes and is asserted to carry none. `.xlsx` has no
  blank _line_ to skip — a row of empty cells is a row of `null`s the reader hands
  over like any other — so `blankRows: 0` there is the truth rather than a
  placeholder.

  `minor` rather than `patch`: no export was removed, but `FetchResult` and
  `RecordStream` both gained a field, `fetchFile`'s return shape narrowed, and a
  custom `SourceFetcher` in a consumer's tree can now say something it could not
  say before.

- ae298c3: Spreadsheets are a source format, so `.xlsx` is now one

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

  **A blank cell is `null`, and CSV changed to agree.** This is the one change
  here that touches a format that already worked, so it is the one to read
  carefully. `parseCsv` did `cells[index] ?? null`, which made a _missing_ cell
  `null` and a _blank_ cell `""` — two spellings of "no value here", only one of
  which the `present` predicate recognises, since it tests `null` and `undefined`.
  A graph filtering on `isNotNull` therefore kept every blank in the file:
  measured against one real drop, it committed 102,519 rows where the right answer
  was 89,458. Both readers now answer `null`.

  Aligning CSV rather than the workbook reader is deliberate. A blank spreadsheet
  cell is an _absent_ cell — there is no empty string in the file to report — so
  the workbook reader cannot honestly answer the other way, and the MVR sample has
  3,468 of them. One predicate should not mean two things depending on which
  format the source happened to read. If a transform downstream relied on a blank
  CSV field arriving as `""`, it now sees `null`. Nothing is trimmed on the way
  past in either format: a field holding spaces is still a value.

  **One other behaviour change worth naming.** A `format` the library does not
  recognise is now refused, listing the ones it knows. It used to be read as JSON.

- 53109b2: The catalog could not call a workflow that does not know about the catalog.

  A `call` node always wrapped the author's `config` in a `WorkflowCallEnvelope`, so a durable workflow registered long before this package — one whose body reads `data["proc"]` — received `{catalog: {…}, input: {proc: …}}` and died on the first key it looked for. The only repair on offer was to edit the callee, which inverts the dependency exactly the wrong way round: every workflow anybody wanted to call would have to start depending on this package's contract, including Python workflows in other repositories.

  So a call node now carries a **mode**. `WorkflowCallNode.callMode` is one of `WORKFLOW_CALL_MODES`:

  - `'envelope'` — unchanged, and what an absent field means. The child gets the catalog's metadata under `catalog` and the parameters under `input`, and can stage rows back for the graph.
  - `'plain'` — the child gets `config` verbatim, with nothing added and nothing wrapped.

  The envelope nests for one stated reason — an author's `runId` parameter must not shadow the run id — and that reason is not weakened, because a plain call sends no catalog metadata at all and so has nothing to shadow.

  **What a plain call gives up, and why the validator refuses graphs rather than documenting it.** No `runId` and no `nodeId` means the callee is told no key to stage rows under, so a plain call can never return rows to the graph. `validateWorkflow` therefore refuses a plain call node with **any outbound edge**, code `call-plain-has-output` — every node kind that can sit downstream of a call consumes rows and only rows, so "has downstream nodes expecting rows" and "has an outbound edge" are the same set. Two rules moved to make that statable: a plain call no longer counts as something that reads (so `plain call → sink` is refused by `no-source` as well), and it is exempt from `dead-end`, an exemption exactly one node wide because nothing can be behind a node that may not have an outbound edge. Without the refusal such a graph would save, publish, run, report success, and commit an empty snapshot.

  A plain call's **return value is not read** — not as rows and not at all. It is the child run's output, recorded durably under the child run id the node's log line names; reading `{batches, rowCount}` off it would send the graph to a stage that cannot exist, and copying it into this run's log would put an arbitrary worker's payload somewhere this package's redaction rules never see. The cost is that a plain call can hand nothing back into the graph, not even a scalar an `if` could test on. That is the trade the two modes are.

  Backward compatible in both directions that matter: every stored call node has no `callMode`, keeps sending the envelope, and `workflowGraphHash` appends a component only for `'plain'` — an explicit `'envelope'` hashes identically to an absent one, so no stored graph is renumbered by a deployment picking this up.

  The version pin is untouched. Worth being accurate about what it buys against a Python callee: `durable_worker` has no version concept at all and registers everything as `'1'`, so a pin against one is satisfiable and inert.

## 0.15.0

### Minor Changes

- 06eb2c1: Workflow releases, and the version a schedule actually runs

  ## Editing a graph was deploying it, on a cron, silently

  `ConnectorScheduler.fire` put `workflow.version` into the run payload — the
  version on the row, which is to say the latest save. A `ready` graph stays ready
  through an edit, deliberately: `saveWorkflow` refuses to demote one, because
  demoting would disable a scheduled load with nothing said to anybody. So there
  was no step between editing a live pipeline and the next cron tick executing what
  had just been typed. The only gate was `ready` versus `draft`, and an edit does
  not cross it. Somebody dragging a box on a canvas at 02:59 changed what ran at
  03:00.

  So: a graph can be **released**, and a released version can be made **live**.
  A scheduled window runs the live version. Editing bumps a counter nothing reads.

  - `POST workflows/:id/releases` freezes the graph as it currently stands and
    **deploys nothing**.
  - `PUT workflows/:id/live` chooses which released version runs. This is the
    deploy, and the same call with a smaller number is the rollback.
  - `POST workflows/:id/run` takes an optional `version`, so a new release can be
    tried without becoming what the cron executes.

  **Nothing is backfilled.** `liveVersion` absent means follow the latest save,
  which is what every graph in every deployment does today and what every existing
  graph keeps doing until somebody deliberately releases and deploys one. Pointing
  every existing graph at its current version would have been a deploy of every
  pipeline on the deployment, performed by a migration, at a moment nobody chose.

  ## The argument against archiving graphs, answered rather than ignored

  `CatalogWorkflow` states that a graph is not revisioned, and the decisive reason
  it gives is the counter: `version` is bumped on **draft** edits by design — so a
  run's `workflowVersion` can never mean two different graphs — and archiving one
  body per version would therefore store every autosave of a canvas somebody is
  still dragging boxes around on, under a bounded archive that would then evict the
  versions which actually ran.

  That argument is correct and this change does not weaken it. It is an argument
  against archiving **saves**, and this archives **releases**. `saveWorkflow` writes
  nothing to `catalog_workflow_release`; neither does `publishWorkflow`, which is
  idempotent and is what an environment promotion presses — a release minted there
  would appear in an environment as a side effect of promoting configuration into
  it. One route mints one, and a person presses it. The counter stays cheap to
  inflate and the archive stays sparse, because they are counting different things.

  The other half of that docblock — that a graph is a structure and a line differ
  over serialised JSON reports a dragged box as a change — is untouched. This is
  not a diff feature. It stores a graph so a version can be _run_.

  ## Releases are never evicted, unlike revisions

  `catalog_revision` is capped per subject at `CATALOG_REVISION_LIMIT`, and that
  cap is right for code: revisions grow with how often somebody edits, which nobody
  meters, and each row carries a whole body. Adding a `workflow` subject to it was
  the obvious move and is the wrong one, for a reason sharper than the `text`
  column. The row a live pointer names is the graph **production is running**, and
  an eviction rule that could delete it would stop a working pipeline to enforce a
  storage policy.

  So `catalog_workflow_release` is its own table and nothing evicts from it. That
  makes it unbounded, which this codebase is careful about, and it earns that on
  the same test `catalog_audit_event` and `catalog_connector_run` pass: one row per
  thing a person deliberately did, at a rate an operator reads off their own change
  process.

  Releases are also immutable, and there is no route that removes one — which is
  the strongest available form of "refuse to delete the version that is live":
  there is no operation to refuse. The exception is `deleteWorkflow`, which already
  takes the connector and the entire run history, so the releases go too; nothing
  that could still cite one survives. (Deleting a _transform_ leaves its revisions,
  for the opposite reason: the runs that ran them do survive.)

  ## A pointer on the workflow, not an environment table

  The request named the environment — "which version is in production in the
  environment" — and this catalog has a real environment concept. It isolates them
  _physically_, one database each, so a `catalog_workflow` row already exists once
  per environment and a pointer on it is already per-environment. The environment
  is the connection. A second dimension keyed on the environment id would be a
  table whose every query filtered on a constant.

  It is `liveVersion` rather than `productionVersion` because "production" here is
  the _name of an environment_, and a column called that on a row which lives inside
  exactly one environment would read as naming a different one.

  `liveVersion` deliberately **does not cross a promotion**. `planPromotion` is
  explicit that version numbers do not cross — a version counts edits made in the
  environment it lives in, so dev's v7 and production's v7 are unrelated numbers —
  and a pointer _to_ a version inherits that argument whole. A promoted graph
  arrives following the latest, exactly as a newly created one does.

  ## A run now finishes on the graph it started on

  Every step used to load the head and refuse if the version had moved, which was
  the only honest answer available when a graph kept nothing but its latest shape:
  a load edited at node three died at node three. With the archive there is a third
  answer, and `requireWorkflowAt` takes it — a run is pinned to its version for its
  whole life, so a deploy mid-run does not swap the graph underneath it.

  Where the archive cannot answer, **nothing falls back to the head**. That is the
  same stand the call node's version check takes, in the same words: running the
  newest thing available while the graph says otherwise is exactly the substitution
  a pin was written down to prevent. A store from before this change reaches the
  identical refusal through the capability predicate rather than a `TypeError`.

  ## Migration

  Additive, and it renumbers nothing. One nullable column, `catalog_workflow.live_version`,
  with **no default** — the opposite of the `status` and `enabled` defaults beside
  it, and by the same test: those default to something because leaving them empty
  would stop a working pipeline, and this defaults to nothing because filling it in
  would change what a working pipeline runs. One new table,
  `catalog_workflow_release`. `workflowGraphHash` is not touched at all, so no
  stored hash moves and no stored graph is invalidated.

## 0.14.0

### Minor Changes

- eaba502: Reusable source and sink nodes, and the version pin they could not ship without

  ## The pin first, because it is a prerequisite rather than a nicety

  `TransformRow` has carried a `version` since it existed. A transform node
  referenced a `transformId` **and nothing else**, and `runTransform` resolved it
  with `getTransform`, which answers with whatever is in the row today. The
  docblock on that field claimed the opposite — "a reference rather than inline
  code, so one piece of logic used at three points in a graph is versioned once and
  fixed once" — and there was nothing there to fix it _to_.

  That was survivable only because almost nothing was shared. Editing a transform
  changed every graph referencing it, at once, and the graph's own fingerprint does
  not move for it (`workflowGraphHash` excludes the transform's version on purpose,
  and still does) — so there was not even a new graph version to point at. The
  moment reusable nodes make sharing the point, that becomes the principal failure
  mode: somebody's load changes with nothing in their diff and nothing in their run
  history to explain it.

  The prior art in this repo is the `call` node, which pins `callName` **and**
  `callVersion` and argues in its own docblock that without the version it "would
  run whichever version is registered on the day it runs" — "the exact substitution
  the pin exists to prevent". So:

  - **`WorkflowTransformNode.transformVersion`** and **`ReusableNodeRef.useVersion`**
    pin a version. Both resolve out of `catalog_revision`; a version the archive can
    no longer produce **fails the node**, naming the pin, and never falls back to the
    latest. That is `WorkflowRunSteps.checkCall`'s stand, applied to code stored in
    the same database.
  - **Absent keeps meaning "follow the latest"**, which is exactly what every graph
    in every deployment already does. A backfill would be a behaviour change dressed
    as a migration: pinning the live version at upgrade time freezes graphs whose
    authors rely on edits reaching them, and refusing unpinned nodes stops every
    scheduled load. Neither is a decision this package gets to make for somebody.
    What changed is that following is now a **stated** position with a pinned
    alternative beside it — `describeVersionPin` turns either into a sentence a
    screen renders — rather than the only position and an unstated one.
  - **Editing a shared body creates a new version; it does not refuse.** Refusing
    would strand whoever owns the node the moment anybody pinned it, and would make
    pinning a way to take something hostage. Pinned graphs cost nothing: they
    resolve through the archive and keep running the body they named. What the
    editor gets instead of a refusal is the count of who is downstream, read at the
    moment they are about to save.

  ## Reusable nodes

  `catalog_reusable_node` holds a named node body, versioned like a transform and
  archived in the same `catalog_revision` table under a new `reusable-node` subject
  — one table, one retention rule, which is the argument that table already makes
  for holding two subjects.

  **Source and sink only.** What is reusable about a source is the _composition_ —
  connection **plus** query, plus mode, plus what the thing is called — not the
  connection, which is already a shared object answering "which database". Nobody
  reaches for "the warehouse" while drawing a graph; they reach for "the nightly
  MVR pull from the warehouse". A transform is deliberately absent: it is already a
  stored object referenced by id, so a reusable transform node would be a second
  way to say the same thing. `call` likewise. `if` and `filter` are absent because
  a predicate is _about_ the rows in front of it, and `filter.narrows` is an
  acknowledgement about one graph's own sinks. `NODE_KIND_IS_REUSABLE` is a
  `Record` over every node kind, so a new kind is a compile error until it answers.

  **By reference, never by copy.** A referencing node carries `useId` and keeps its
  resolved fields as a **cache** — the arrangement `toGraph` already documents for
  a source that names a connector, with the same consequence: the store folds at
  save time so the pure validator and the canvas keep working, and the runner
  re-reads, so an edit reaches an unpinned graph on its next run. The reference is
  what survives, and it is the only reason the usage count can be exact.

  **A sink's `targetType` may not move under a graph.** A graph is grant-checked
  against the types its sinks write, at save time, using the type on the node. A
  shared sink that could repoint it afterwards would load into a type nobody with
  access to that graph was ever granted — on a schedule, with the graph's own diff
  showing nothing. `applyReusableNode` refuses the disagreement, naming both types;
  adopting the new one is a re-save, which checks the grants again.

  ## The usage answer

  `GET pipeline/reusable-nodes/:id/workflows` and `GET pipeline/transforms/:id/workflows`,
  both shaped after `connections/:id/connectors` (now `connections/:id/workflows`),
  which answers the same question for a connection. Two differences, both
  deliberate: they report one entry per **node** rather than per graph, because
  whoever reads them is about to edit a body and three nodes in one graph are three
  places it lands; and each entry carries `pinnedVersion`, which is what turns a
  count into a decision — an unpinned node moves on the next run, a pinned one does
  not.

  `GET pipeline/reusable-nodes` carries a `usedBy` count on every row, because
  **there is no library screen and there is not going to be one.** Reusable nodes
  are offered where a node is added and the count belongs on the node itself, so
  that list _is_ the picker — a number that changes somebody's decision has to be
  there before the click, not one request after it.

  `POST pipeline/workflows/:id/nodes/:nodeId/save-as-reusable` lifts a node into
  the library and answers with the `useId` to put on it. It does **not** edit the
  graph: a route that stored one thing and silently rewrote another would move a
  graph's version for a reason its author cannot see in their own diff.

  ## Why `minor` and not `major`

  Nothing that exists changes behaviour. Every added field is optional and absent
  means what the absence has always meant; `workflowGraphHash` appends the new
  components only when they are present, so **not one of the 13 stored graphs is
  renumbered** — the same rule `edge.branch` follows, and it is pinned by a test.
  Every store method is optional on `CatalogPipelineStore` behind
  `supportsReusableNodes` / `supportsTransformPins`, so a host's own store keeps
  compiling and keeps working, and a graph with no pins runs on a store that has
  neither. The new table is additive and created by the existing fingerprint-gated
  `schema.update`.

  This is 0.x, so `minor` is the strongest signal available for "new surface, no
  removals", and that is what this is. The one thing worth knowing before upgrading
  is stated above rather than hidden behind a version number: **a pin that cannot
  be resolved stops a load.** Nothing is pinned until somebody pins it.

## 0.13.0

### Minor Changes

- 3f878f9: A filter node, whose predicate is a structure rather than code

  A transform can already filter — it takes rows and returns rows, so returning a
  subset filters — and this file's own node-kind list used to reject `filter` for
  exactly that reason. That argument is sound about _code_, and it is why this
  node does not take any. What changed is the predicate: a closed structure of
  column, operator and value, combined with `all`/`any`, which is a thing
  something other than a JavaScript engine can read.

  Three reasons the kind earns itself, and the third decides the shape. It is
  legible on the canvas without opening anything. Its effect is **reportable** —
  the node records rows in beside rows out, so a run panel can say what was
  dropped, where a transform records one number and a transform that quietly
  started dropping 90% of its input looks identical to a source that got smaller.
  And only a declarative predicate can be pushed into the source as a `WHERE`.
  That last one is not a micro-optimisation: filtering `obj_pribuybuylistdetail`
  in memory means every one of 7,637,391 rows is read off disk, crosses the
  network, and becomes a JS object of ~80 properties before anything decides it
  was unwanted.

  **The pushdown is not built, and this ships saying so rather than implying it.**
  The mechanism it would reuse already exists — `boundStatement` in `sources.ts`
  wraps an author's query as `SELECT * FROM (…) WHERE …` with the identifier
  quoted per dialect and the value bound — but `SourceFetcher` takes a connector,
  a secret, a watermark and a mode and knows nothing about the graph, while the
  runner that does know the graph dispatches by connector kind alone; threading a
  predicate through also drags in schema discovery, which shares `sqlTarget`.
  There is a second reason and it is the more interesting one: a pushed-down
  filter cannot honestly report rows in, because the rows it removed were never
  read — reason three deletes reason two, and recovering the number means a
  `COUNT(*)` over the unfiltered query, which is the scan the pushdown was for.
  Those are decisions, not typing, so they belong to the change that makes the
  move. What is _not_ deferred is the part that would have made it impossible
  later: the predicate is closed, its columns already have to match the identifier
  pattern `boundStatement` requires, and every comparison follows **SQL's
  three-valued logic** — a null column fails every test including the negative
  ones — so pushing it down cannot change which rows a type ends up holding.

  Meanwhile it runs in memory **one staged batch at a time**, never over the whole
  input. The obvious implementation is `readInputs()` then `.filter()`, and that
  is the shape that spent a day of this project's life stalling everything sharing
  a database: one synchronous pass over millions of objects holds the event loop
  for its whole duration. Survivors are coalesced back into full batches, so a
  filter keeping one percent does not write fifteen thousand stage rows of five.

  **The trap it had to be designed against**, and the reason `WorkflowFilterNode`
  carries `narrows`: dropping a filter onto a working `source → sink` wire
  replaces the published snapshot of that type with a subset, silently, because
  from the run's point of view everything succeeded. Filtering to _derive a new
  type_ and filtering before _recommitting the same type_ are structurally
  identical graphs — the only difference is what the name on the sink already
  means to the people reading it — so no rule over the shape can tell them apart
  without inventing a signal. The graph therefore makes the author **name the
  types**, and `validateWorkflow` requires it exactly where it matters and refuses
  it everywhere else: every full-mode sink this node is the only path to must be
  listed, and nothing that it is not. A filter on one of several paths into a
  sink, or in front of an incremental one, narrows nothing and may not claim to.
  The consequence is the intended one — that dragged-on filter produces a graph
  that will not save until somebody writes down the name of the type they are
  about to shrink. The sink's `maxShrink` bound is unchanged and still the last
  word at run time.

  `WorkflowNodeOutcome.rowsIn` is new and optional, and absent is not zero: a node
  that never reported an input count and a filter that was handed nothing are
  different facts, and defaulting would make every outcome stored before this
  exists read as having dropped everything it produced.

  Existing graphs are untouched — a graph with no filter in it hashes to exactly
  what it always did, which is pinned by a literal recorded from the previous
  build. Every per-kind decision still fails to compile when a kind is missing
  from it; adding this one found seven such places on the way in, and turned up a
  narrowing bug worth knowing about: TypeScript will **not** remove a union member
  whose discriminant is itself a union of literals, so an `all`/`any` group
  written as one interface silently disabled the exhaustiveness check for both.
  It is two interfaces over a shared base for that reason.

- f9ee3b8: An `if` node can branch on how many rows reached it

  The case that asked for it, and it is not hypothetical: a nightly export comes
  back empty because the upstream system is mid-maintenance. Nothing is broken —
  so the run succeeds, the sink commits, and committing is what repoints the live
  view of a type. Yesterday's good data stops being served, and the run reports
  success while it happens. The `if` node already had the mechanism to prevent
  that (a skipped node is never executed, so nothing reaches the publish
  protocol), and it could only be pointed at an environment variable, which
  answers a question about the _deployment_ and not about this run.

  So a gate now tests one of two things, and **the shape of the test changed to
  say so**: `WorkflowIfNode` carries a `predicate` — `{kind: 'env', envVar,
equals?}` or `{kind: 'rowCount', atLeast}` — where it used to carry `envVar` and
  `equals` directly. The flat alternative was to add the threshold beside them and
  mark everything optional, and that types a gate as "a variable, maybe, and a
  number, maybe": a node carrying both is representable, a node carrying neither
  is representable, and every reader has to invent its own rule for which one
  wins. A gate that runs the test its author did not choose is precisely the
  failure this node exists to prevent, so the ambiguity is not representable
  instead. Every decision made per predicate kind ends in
  `unreachablePredicateKind`, so the `code` predicate this file has been promising
  lands as a build failure listing what has to answer for it — the same treatment
  node kinds got.

  The threshold is one integer of at least one, compared one way. `atLeast: 1` is
  "did anything arrive at all", so the common case costs nothing to express, and
  "a full export is never legitimately under ten thousand rows" is the next thing
  anybody asks for — it would otherwise need a second predicate kind for one
  number. There is no `atMost` and no operator picker for the reason there is no
  `negate` flag: the inverse is already expressible by swapping which successor is
  on `then`, and two ways to say one thing is two places to look when a load takes
  the branch nobody expected. A threshold of zero is refused rather than treated
  as "always", because it is a gate that can only answer one way — the `else`
  subtree would never run on any deployment, which is the silent half-graph
  reached by typing a number rather than by mislabelling a wire.

  **The count is read off the checkpoint, never by counting rows.** It is
  `WorkflowStageRef.rowCount` on the step's own input — assembled by the workflow
  body from an upstream step's recorded output — so the predicate stays a pure
  function of what the run already wrote down, and the branch it produced is
  recorded on the step's output exactly as the env predicate's is. A resumed run
  on another pod reads the decision back rather than making a new one; nothing
  queries the stage store on the replay path. A gate still touches no rows, and
  still takes exactly one inbound edge, so "how many rows" has exactly one answer
  and it is the count on the very ref the gate hands on.

  Because `if` nodes have never been released, no stored graph carries the old
  flat shape and nothing is migrated. A payload carrying it is refused at the HTTP
  boundary and by `isWorkflowNode` rather than adapted — guessing the test from
  which fields happen to be present is the ambiguity above, arrived at by being
  helpful.

  The console's gate inspector picks the kind first and then shows that kind's
  fields, and a predicate kind added without a form there stops the build naming
  the file.

- 81a15c5: An `if` node, so one graph can serve two deployments

  The case that asked for it: a local deployment has a ClickHouse and dev does
  not. Without a conditional that is two workflows, which is two things to keep in
  step and one of them always drifts — so the graph gains a node that decides, at
  run time, which half of itself runs.

  An `if` names an **environment variable** and takes a `then` and an `else`.
  Declarative rather than code, and that is the safety property rather than a
  simplification: a predicate is the one expression whose answer decides which
  nodes exist for a run, so an answer that can differ between a run and its replay
  is a load that goes down a path nobody chose. The evaluated branch is recorded
  on the node's outcome the first time it is asked and read back afterwards — the
  node runs inside a durable step, whose output is a checkpoint, and the workflow
  body reads that record rather than the environment. A resumed run on another pod
  therefore reproduces the first run's decision instead of making a new one.

  **A sink on the untaken branch does not commit.** This is the part worth reading
  before upgrading. Committing is what repoints the live view of a type, so a sink
  that "ran with no rows" would publish an empty snapshot over a good dataset and
  report success while doing it. A skipped node is not executed at all, so nothing
  reaches the publish protocol; and because "skipped" already meant "the run
  stopped before here", the outcome now carries `skippedBecause` so the two can be
  told apart in the data and on the run panel. A sink stood down by a branch says
  so in the run's log, naming the type it did not commit and saying that whatever
  was live still is.

  The skip rule is reachability from the **taken** edges, not descendants of the
  untaken one. The obvious version is wrong on the shape branches are most often
  drawn in: where both sides converge on one node, walking down from the untaken
  edge skips the join — and with it the sink behind it — on a run that otherwise
  succeeded. `workflowNodeRuns` is exported so a screen can answer "would this have
  run" exactly the way the runner decided it.

  Nothing about an existing graph changes. `WorkflowEdge.branch` is optional and
  absent on every stored edge; an unlabelled wire is unconditional, and the graph
  fingerprint folds the label in only when there is one, so no stored workflow is
  renumbered and no past run becomes unidentifiable. What is refused is the pair of
  silent mistakes: an unlabelled wire out of an `if` (a subtree that would never
  run) and a label on a wire that leaves anything else (a decision that is drawn
  and never read).

  Every place that decides something per node kind now fails to compile when a kind
  is missing from it, rather than falling through to the last branch. Adding `if`
  found two such places on the way in, which is the argument for it.

  The console gets the node, an inspector, and `then`/`else` labelled and coloured
  on the wires — labelled as well as coloured, because two lines leaving one box
  that differ only by hue are one line to a colour-blind reader, and this
  particular difference decides which half of the pipeline runs.

- 3290183: A graph exists because somebody made it, not because a boot hook inferred it

  Boot-time connector adoption is removed entirely. A workflow now comes into
  existence only because something explicitly created it through the API. `minor`
  and not `major` on purpose — this is 0.x, and the project versions on that basis
  rather than on whether behaviour was withdrawn.

  **Why it goes.** Adoption wrapped every pre-workflow connector into a
  single-source, single-sink graph at boot and published it as `ready`. The wrap
  was validated, so `ready` was true in the narrow sense — it meant "this
  validated". It was false in the sense the word is actually read on that screen,
  which is "somebody looked at this and said it was finished". The console had
  grown a badge and a paragraph to explain that a pipeline marked ready had no
  author, which is the tell: a status that needs a note beside it saying it does
  not mean what it says is the wrong status, and the honest fix is to stop minting
  it rather than to keep apologising for it. Publishing is a decision, and a
  process starting up is not somebody deciding.

  **Gone.** `ConnectorAdoption` and the `CATALOG_ADOPT_CONNECTORS` token, the
  `adoptConnectors` module option and its entry in `CATALOG_PIPELINE_TOKENS`,
  `CatalogWorkflowStore.adoptConnector` with its MikroORM implementation and the
  environment-routing delegation, and — on the console — the `adopted` badge, the
  "adopted at boot" note, `wasAdopted` and `WORKFLOW_ADOPTION_ACTOR`.

  **No migration, because there was never a column.** "Adopted" was never stored.
  It was derived at render time from `createdBy === 'connector-adoption'`, so
  there is nothing to drop and nothing to rewrite. Graphs adopted by an earlier
  release keep working exactly as they did; the string in `createdBy` stops being
  read as a marker and reads as what it is, the name of whatever authored the row.

  **Nothing was keyed on the adoption.** The connector id is what a run history,
  the singleton mutex and the incremental watermark hang off, and it is
  `publishWorkflow` -> `mintConnectorFor` that ties a connector to its graph — the
  ordinary publish path, untouched here. Adoption borrowed that machinery for
  already-existing rows; it never owned it. Watermarks already re-keyed under a
  source node stay re-keyed, and no incremental source falls back to a full read.

  **What an upgraded deployment sees.** A connector that predates workflows is no
  longer wrapped into anything. It keeps loading on the path it was already on,
  `GET connectors` still reports it, and no route can edit it — the same standing
  consequence `adoptConnectors: false` always had, now the only behaviour. A
  deployment with connectors and no workflows therefore shows an empty
  `#workflows`, so the canvas gains an empty state that says so: that nothing is
  missing, that this deployment has simply never had one drawn, and that
  connectors already loading data are not shown there and nothing will turn them
  into workflows on their own. Three states rendered identically before — a first
  run, a graph whose nodes were all deleted, and a list that failed to load — and
  only one of them was speaking.

- 8b21b7d: An idle host pays one statement a tick, not one per pipeline

  This library mounts inside somebody else's application, so what it costs a
  process that is not using it is a property it has to hold rather than a detail.
  It was not holding it. On a worker with twelve scheduled graphs, a
  `ConnectorScheduler` tick issued **13 statements** — one `listWorkflows`, then a
  `connectorsUsingWorkflow` per runnable graph to re-confirm a "not due" that could
  not have changed — every thirty seconds, forever. `AbandonedRunReconciler` read
  the whole connector table on every pass to have names ready for a warning that,
  on a healthy deployment, is never written.

  Measured against MySQL 8.0 with 20 workflows (12 scheduled), 20 connectors and
  200 run rows, through the real classes rather than fakes. `blocked` is time the
  event loop was held without yielding, sampled with a 1ms heartbeat — the number
  that matters to a host, and the one an average CPU figure hides:

  |                        | statements | blocked           | wall                 |
  | ---------------------- | ---------- | ----------------- | -------------------- |
  | scheduler tick, steady | 13 → **1** | 16.10ms → **0ms** | 26.41ms → **4.36ms** |
  | reconciler pass        | 2 → **1**  | 8.62ms → 4.94ms   | 22.53ms → 20.56ms    |

  Per idle hour on one worker: **1,584 → 132 statements**, and **2.04s → 0.06s** of
  held event loop.

  The scheduler now records the window it last carried each graph to a decision
  for, fingerprinted with that graph's cron, version and `updatedAt`, and returns
  without touching the store when the next tick brings the same one. It is not a
  cached schedule: the schedule list is still rebuilt from the store on every
  single tick, so an edit still takes effect within one poll interval. What it
  gives up is a connector row whose `updatedAt` moves _backwards_, which only a
  promotion importing an older environment's rows can do, and which costs one
  catch-up window on a pipeline somebody is mid-migration on. The guarantee that
  a window starts exactly once is untouched — it was never this filter, it is the
  deterministic run id. A `ready` graph with no connector is deliberately left
  paying a query per tick, so publishing again is still seen.

  `ReconcileScan.names` is now `() => Promise<ReadonlyMap<string, string>>` rather
  than the map itself, and is called only by a pass that has something to close.
  That is a breaking change to an exported type, hence minor: a caller passing a
  map gets a compile error rather than names that silently stop appearing.

  `ConnectorScheduler.tick()` is public, for the reason
  `AbandonedRunReconciler.pass()` already was — a host that drives it from its own
  scheduler, and a measurement that would rather not own a timer.

  `packages/pipeline/src/idle-cost.db.spec.ts` is that measurement, and it runs
  under `pnpm test:db`. It asserts statement counts, which are the same everywhere,
  and only reports timings, which are not.

  **What this does not fix, said plainly.** On an API-role process a host passes
  `scheduler: false` and `reconcileRuns` defaults to it, so neither loop runs there
  and none of the above changes what an API pod pays. Measured on that side, a
  mounted catalog costs ~19ms of held event loop once at boot (13.7ms for the
  second MikroORM connection and its schema check, 5.2ms for the registry build
  over 60 types and 902 properties) and nothing at all until somebody opens the
  console. The one expensive request is `GET catalog/events/traces`, which is
  already fixed and not yet released.

- e4b6123: Transform code gets a second parameter: `context`

  A transform was a function over a batch, and a batch is not the whole of what it needs. It needs the
  token for the API it enriches against; it needs to say which run it belongs to when it logs; and the
  conditional node coming next has a predicate with no `records` at all, which still has to answer "did
  the source return anything" — the guard that stops an empty snapshot being committed over live data.

  So `records` is joined by `context`, in JavaScript, TypeScript and Python alike: the run id, the
  graph and node, `rowCount`, the per-edge `inputs` (handles and counts, the same `WorkflowStageRef`
  the call node already hands a callee), the host's name for this environment, and `env`. The harness
  generates the parameter, so every transform stored before today keeps running unchanged.

  **`env` is the credential allow-list, not `process.env`, and that is the point of the change rather
  than a caveat on it.** Handing code the raw environment would have silently repealed
  `secret-env-allowlist.ts`: transform code is a string saved by a `catalog:write` principal, it runs
  in this pod, and it can print whatever it reads into `logs` — which cross into the run record and are
  served at `catalog:read`. That is precisely the route that let a connector's `secretEnvVar` name
  `DATABASE_URL`, reopened somewhere nobody would think to look. One list, one boot warning, one place
  an operator looks to answer "what can code on this deployment read".

  `['*']` is the one configuration where code and connectors differ, and it differs in the safe
  direction: it admits **nothing** to `context.env`. The escape hatch exists so an upgrade under time
  pressure has one honest line that keeps connectors reading one named variable each, visible on their
  own screens. Copying a whole pod's environment into every transform's context is a bulk disclosure
  nobody consented to by typing one character, and there is no compatibility argument on the other side
  because code previously got nothing at all. Every case says which of the three it was in the run's
  own log, where the person who can fix it is already looking.

  New optional seam `CATALOG_PIPELINE_ENVIRONMENT`, bound through `forRoot({ environmentName })` as a
  string or a per-call function. It surfaces as `context.environment` so that a transform behaving
  differently in production reads `context.environment === 'prod'` instead of sniffing a variable.
  Unbound leaves the field absent, which is a different statement from `'dev'` and the only truthful
  one available.

  Everything on the context is plain JSON, and everything except `env` and `environment` derives from a
  durable step's checkpointed input, so it is byte-identical across replays. `allowlistedCodeEnv()` and
  `namedEnvironment()` are separate, exported, impure functions and `codeContext()` is pure — so code
  evaluated in a workflow body rather than in a step can resolve them inside one and let the checkpoint
  carry the answer, instead of re-reading pod-local state on replay and taking a different branch.

- 2ab7077: A call node can now be pointed at a workflow by picking it, instead of typing its name from memory.

  The `call` node shipped with two typed fields and a docblock explaining why there was no picker, and
  that explanation was correct: nothing could enumerate a deployment's registrations.
  `workflowBody(name, version)` answers only for the process asking, and a missing body is ambiguous by
  construction — "not registered here" reads identically to "registered through `registerRemote`
  against another SDK" and to "a group resolved by convention against a live worker". A list inferred
  from it would have differed per replica and would have omitted precisely the cross-SDK workflows the
  node exists to call.

  `@dudousxd/nestjs-durable-core` **0.65.0** closed that with `WorkflowEngine.announcedWorkflows()`,
  which is not an inference: live workers publish what they can execute on the worker-descriptor
  keyspace, and every pod folds the same published statements. `GET <base>/pipeline/callable-workflows`
  serves it, and the call node's inspector offers it. The pipeline package's `@dudousxd/nestjs-durable-core`
  peer range moves to `>=0.65.0` accordingly.

  - **Two searchable fields, not one list of `name@version` keys.** A real fleet announces more
    workflows than fit in a popup somebody scrolls, so both fields are comboboxes you type into: the
    first searches the announced **names** — on the name, the group and the description — and the
    second lists the **versions announced for the name you chose**. A single combined list answered
    the version question inside the name question, which made the name list as long as the version
    count and, at eight versions, made the name eight times harder to find.
  - **Both halves, or neither.** Splitting one list into two raises the failure the combined list
    could not have: a name committed on its own leaves a node that runs whatever is newest on the day
    it runs and looks configured while doing it — the single thing the pin exists to prevent. So
    choosing a name writes `callVersion` in the **same** update whenever the fleet announces exactly
    one pinnable version, which is the common case and stays one action. Where there is a real choice
    the version is left blank on purpose rather than guessed — blank is visible, said out loud under
    the field, and refused by the existing `call-not-named` check. A version already held is kept when
    the new name still announces it, and a version somebody typed that the fleet never offered is
    never erased: this field has no standing over a value it did not supply.
  - **`group` is the field that carries the most.** It is the only signal that separates "this body
    lives in another process, in another language" from "not registered at all", which is exactly what
    a missing `workflowBody` could never tell apart. It is set only when the live announcers name
    **one**; more than one is left absent and reported as a disagreement.
  - **Disagreements are surfaced, not resolved.** Two workers claiming one `name@version` from two
    groups mean nobody can say which queue a run would land on, or whether the two are even the same
    code. Such an entry is **shown** — greyed, with both groups named in full under the field — and
    cannot be chosen. Neither half of that is optional: silently picking one would act on a claim
    nobody made, and silently dropping it is the "picker that hides what you are looking for" the
    original docblock refused to build. A disagreement on `origin` or `requires` is shown and is _not_
    a refusal: it does not change which queue the run goes to.
  - **Silence is not a claim.** An un-upgraded worker of any SDK announces a bare name with no version
    and no group. No version is invented for it from a sibling entry, and it is offered greyed with the
    reason, because a name with no version cannot satisfy the pin — offering it as though it could
    would be a lie the node then carries. `callableWorkflowBlock` is the shared rule behind both
    refusals, exported from `@dudousxd/nestjs-catalog/client` as `validateWorkflow` is, so the picker
    and anything server-side reasoning about the same list cannot drift.
  - **It is a snapshot, and says so.** Liveness is a TTL on the descriptor key, so a worker that dies
    takes its announcements with it within about one heartbeat. The route reads on demand and caches
    nothing; the client caches for ten seconds, emphatically not the `Infinity` that is right for
    `capabilities`; and the field prints the time it looked rather than presenting a moment as a
    standing fact. Hence a route of its own rather than a field on `capabilities`, whose answers cannot
    change without a redeploy.
  - **"Nobody could be asked" is not "there are none".** With no durable engine — or when the read
    itself fails — the answer is `{ supported: false, workflows: [], detail }`, never a bare empty
    list. Rendering "no workflows found" over the second would tell somebody their workflow does not
    exist. A failed read is reported, not thrown: this feeds a convenience, and it must not take the
    inspector down with it.
  - **Typing something nobody announced still works, and is not a fallback.** A deployment whose
    workers have not upgraded announces little or nothing, and a picker that became the only path
    would make the node unusable there. Both fields are text boxes first and lists second — the list
    is a suggestion over what you type, never a gate in front of it — so they stay usable when the
    list is empty, unavailable, or simply does not contain what somebody is pointing at. There is no
    empty select promising a choice it does not have; when there is nothing to offer, the popup
    carries the server's own sentence about why.

  **The pin is still checked after the start, not honoured at it.** `engine.start` takes a pinned
  `version` as of durable 0.65.0 and the catalog deliberately does not pass one: a pinned start is
  refused outright on the two _synthesized_ registration paths — a child inheriting a remote ancestor's
  routing, and convention routing to a live worker group — which are exactly how a cross-SDK workflow
  is reached. Pinning at the start would break the calls this node exists for. So
  `catalog.workflow.call-check` still reads the child's run row and cancels on a mismatch, and the
  `CallInspector` docblock now records why rather than repeating that no version argument exists.

### Patch Changes

- 3acc560: A sink keeps the position it was saved at

  `readNode` reads `position` once for every node, and the `sink` branch was the
  one that did not return it. The read was four lines above.

  The consequence was total rather than cosmetic: a sink could not be placed at
  all, by any route. Drag one on the canvas, save, reload, and it is back where
  the automatic layout puts it. `POST pipeline/workflows` carrying explicit
  coordinates answers **201** and drops them — which is how this was found, by
  rewriting thirteen adopted graphs' positions and reading one back.

  The new spec is written over `Record<WorkflowNodeKind, …>` rather than about
  sinks: four independent branches each remembering a field that was read for all
  of them is the shape that caused this, and the fifth kind will be added by
  somebody who never saw it. A kind added to the union without a fixture is now a
  compile error.

- cba1a42: A source node can make its connection without leaving the canvas.

  The sink node could already create the thing it needs — its schema-discovery panel turns confirmed
  columns into an object type, on a draft. The source node could only _choose_ an address, so a graph
  whose connection did not exist yet meant leaving the canvas, opening the Connections tab, making
  one, coming back and finding the node again.

  `SourceConnectionCreator` sits under the "Read through" picker in the source inspector and carries
  everything the Connections screen carries, because a connection is the credential and the address
  boundary:

  - the same per-kind fields, now shared from `connection-form.tsx` rather than copied — a record
    keyed by `CONNECTOR_KINDS`, so a sixth kind fails the build instead of arriving with no fields;
  - **test before save**, through `POST pipeline/connections/check`, which reaches an address that has
    not been stored and records nothing — sent without an `id`, so nothing is restored and the address
    reached is the one that was typed;
  - the deployment's refusal of a credential at rest (`allowInlineCredentials`) printed verbatim, with
    nothing attached to the node when it happens;
  - a client-side refusal of a URL whose password is the redaction placeholder, which is the one case
    the server cannot catch: a create has no stored row to restore the real credential from, so
    `REDACTED` would simply become the password.

  The new connection is selected onto the node immediately, which marks the draft dirty exactly as
  typing a URL into the same node does — and the confirmation says so, rather than leaving somebody to
  discover it from schema discovery going quiet.

  `@dudousxd/nestjs-catalog` gains `REDACTED_SECRET` on both entry points: the placeholder is part of
  what `GET pipeline/connections` answers, and a browser form has to be able to recognise the string it
  was shown. `@dudousxd/nestjs-catalog-pipeline` re-exports it from there instead of declaring its own.

## 0.12.0

### Minor Changes

- cbab48c: A property may be named the way its source spells it, and the publish check refuses only what
  genuinely cannot become a column.

  A store matches a source's record to a property by property NAME — it reads `row[property.name]` —
  and nothing on the write path consults `columnName`. But the name was also written _verbatim_ as the
  output alias of the committed view and of every read, through an `ident` that refuses rather than
  escapes, so a property could not be called `Asset Id` at all. Publishers therefore did what the
  refusal told them to do: renamed the property to `Asset_Id` and put the source's spelling in
  `columnName`. Thirteen types were loaded that way and six came out with most of their columns NULL —
  73 of 84 on the largest, across 313,833 rows — with every run green, every row count right, and
  nothing visible short of opening a cell.

  - **The view's output alias and the read's alias now go through `outputAlias`**, in both shipped
    adapters (`query.ts` and the store in each of `store-mikro-orm` and `store-clickhouse`). A name
    SQL cannot take is cleaned to its physical column; **a name SQL can take is kept byte for byte**,
    so no view that resolves today changes shape. The two names that would otherwise have moved — one
    whose doubled underscores would collapse, one over 60 characters — are pinned by tests.
  - **The publish-time refusal asks the question it actually needs to**: does this name _clean_ to an
    identifier? `Asset Id` does and is accepted; `2024 Total` does not, because `2024_Total` starts
    with a digit, and is still refused before a single row exists. The refused value named in the
    message is the cleaned one, which is exactly the string `ident` would refuse, so publish-time and
    DDL-time still say one sentence about one string. Length alone can no longer refuse a name, since
    the cleaning cuts at 60 and the rule allows 63.
  - **The refusal message now says what a rename costs.** Taking the suggested name means the load
    looks up `row[<new name>]` in records the source still keys by the old one, so the message names
    `row[name]` and says a transform has to go with it. That sentence is the one whose absence turned
    a correct refusal into six empty tables.
  - **`physicalColumn` moved to `@dudousxd/nestjs-catalog`** and is re-exported by both adapters
    unchanged. It was three byte-identical private copies — two of them inside `store-mikro-orm`, one
    deciding the view's columns and one deciding the table's — and it is now what decides whether a
    published name can work at all, so the publish check and the DDL run the same function rather than
    copies of it. `outputAlias` lives beside it. Both are new named exports; nothing was removed.

  **What an existing deployment sees: nothing.** Every property name stored today is a SQL identifier,
  because the old publish check demanded one, and `outputAlias` returns such a name unchanged — so
  every view keeps every column it has, `read()` still returns rows keyed by the property's own name,
  and no migration or republish is needed. What changes is what a _new_ publish may say, and one
  repair: a type that picked up a name like `Asset Id` before the publish check existed used to fail
  at every commit and be warned about on every publish. It now cleans to a column like any other, so
  it works and the warning correctly stops.

- 2d115cd: A workflow node that hands its step to a durable workflow that already exists.

  A graph could do three things — read, transform, commit — and every one of them had to be written
  here. A deployment that already runs durable workflows, including ones whose body is in Python, had
  no way to put one in a pipeline. `call` is a fourth node kind: it names a registered workflow and a
  version, and runs it as a **tracked child** of the catalog's own durable run.

  - **The version is pinned, and pinned means checked.** A node stores `callName` _and_ `callVersion`,
    and both are part of the graph fingerprint, so repointing a node at `foo@2` is a new version of
    the graph. The honest limit is written down where it applies: `engine.start` resolves the newest
    registered version and takes no version argument, so the child is started and then **checked** —
    `catalog.workflow.call-check` reads the child's run row, and a mismatch cancels the child and
    fails the node naming both versions. A wrong version is stopped, not prevented. The step refuses
    outright when the process running it has no engine to check against, because "unchecked" and
    "checked and fine" must not read the same.
  - **Handles cross the boundary, never rows.** The child receives one documented envelope —
    `{catalog: {contract, runId, nodeId, workflowId, workflowVersion, principalId, inputs}, input}` —
    where `inputs` names the stages its inbound edges wrote, addressed by `(runId, nodeId, batch)` as
    everything else in a run is. A child that produces rows for the graph stages them under the
    calling node's id and returns `{batches, rowCount}`. There is no shared type between a catalog
    node and an arbitrary workflow and none is pretended: `readWorkflowCallOutput` reads those two
    counts, reads their absence as "called for its effect, no rows" and says so in the run log, and
    **refuses half of them** rather than turning a callee's bug into a load that came out short.
  - **Nothing validates the callee's input at save time, because nothing can.** `register()` takes
    `validateInput` and `searchAttributesSchema`, but neither is reachable: the registry is private
    and no public method hands a registration out. What does happen is that `engine.start` runs the
    callee's own `validateInput`, and a refused start is delivered to the parent as a failed child —
    so a bad wiring fails at the node, naming the node, the workflow, the version and the child run.
  - **A busy callee waits rather than failing.** A singleton with `maxQueueDepth` refuses a start once
    its backlog is full, which is contention and not a fault; the node retries five times over about
    seven and a half minutes, suspended at zero compute, each attempt with its own child id, and then
    fails saying it was contention and quoting the engine. Skipping was rejected: a node that quietly
    produced nothing is the failure this service exists to remove.
  - **Failure and cancellation, stated:** a failed child fails the node, everything downstream is
    `skipped`, and the load is failed. Cancelling the parent cascades to the child; letting the parent
    hit its `executionTimeout` does **not**, because that sweep marks the run cancelled without going
    through `cancel`. The parent's own execution timeout is still what stops a hung child holding a
    connector's singleton slot for ever — admission counts `suspended` runs, and a timed-out parent is
    no longer one. A called workflow should carry its own `executionTimeout`; `ctx.child` takes none.
  - **Serialisation belongs to the callee, and is weaker across SDKs.** Calling a workflow does not
    lend it the caller's singleton. On the convention/`attach` path a cross-SDK body is reached by,
    the synthesised registration carries no singleton, timeout or validator at all. The canvas says so
    rather than implying otherwise.
  - **`expectShrink` reaches every node step and no callee.** The acknowledgement on
    `POST workflows/:id/run` stands the row-count bound down for one snapshot, and the bound is
    applied at the sink — so a call node does not forward it. Handing a one-time acknowledgement to
    an arbitrary workflow would put it somewhere nothing on this side can account for what was done
    with it.
  - **A `call` node counts as something that reads**, so `call → sink` is a valid graph and
    `no-source` is no longer raised on one. A graph of transforms alone is still refused.
  - **On a pod with no durable engine the run is refused up front**, naming the node and the workflow,
    instead of opening a run row and failing at the node.
  - The canvas gains a Call node with a workflow field, a version field and a JSON parameter box, in
    the same node inspector that authors a source or a sink — the one screen a pipeline is now
    published, scheduled and run from, so a call node is drawn, saved and published exactly like the
    rest of the graph rather than through a surface of its own.
    **Deliberately no picker**: nothing can enumerate a deployment's workflows — `workflowBody` answers
    only for the asking process, and a missing body equally means a `registerRemote` body in another
    SDK or a group resolved against a live worker — so a list inferred from it would silently omit the
    cross-SDK workflows this node exists to call. `CallableWorkflowRef` is the shape to hand it the day
    a deployment can announce its registrations: one entry per name **and** version.
  - A call node's `config` travels the same credential path a source node's does — sealed under
    `encryptCredentials`, refused in plaintext without it, redacted on the way out and restored on the
    way back in — which is why it carries the same field name.

  **Calling a durable _step_ is not offered, and cannot be.** A step has no global identity: it is
  routed by a name a worker subscribes to and addressed within a run by its `seq`, so there is nothing
  to start, await or cancel. Wrap it in a one-step workflow. This is written into `WORKFLOW_NODE_KINDS`
  beside the other rejected kinds rather than left to be rediscovered.

- 5d81530: A run row nothing revisits is closed by asking the engine, not a clock

  `closeAbandonedAttempts` closes a row left at `running` when the **next attempt at the same
  snapshot** opens. That is exact, and it is also the whole of its reach: a durable run plans once and
  its node retries reuse that row, so the attempt that does the closing is a planning step being
  retried or an operator re-driving the same `snapshotId`. A durable run that dies without ever
  reaching its finish step — the two-hour execution timeout, a cancellation, a worker that never
  resumes — leaves a row nothing comes back to, because the next run of that pipeline mints a _new_
  snapshot. That row sat at `running` with `fetched = 0` and no error indefinitely. `minor` and not
  `major`: this is 0.x, and the project versions on that basis.

  **The lever is that the snapshot id IS the durable run id.** It is minted by `WorkflowLauncher.run`
  and handed straight to `engine.start`, so there is nothing to correlate: the question "is this load
  still going" can be put to the component that decides the answer. `closeRunsTheEngineHasFinished`
  asks `engine.getRun(snapshotId)` and closes the row when the engine has no record of the run or
  reports it terminal. An age threshold was never available here for the reason it was never available
  to the first rule — the loads this is about _are_ the slow ones, so "open for a long time" is
  indistinguishable from working.

  **Three answers, and only two of them are writes.** No record of the run (never held, or pruned by a
  retention policy) and a terminal status are closes. A **non-terminal** status is left exactly alone,
  and that is the answer that must never be got wrong: closing a live load writes `failed` onto a
  healthy run and makes the row disagree with the data it is about to commit. Terminal is read from the
  engine's own exported `TERMINAL_RUN_STATUSES` rather than a hand-written list, so a status a later
  release adds — `blocked` and `cancelling` are both recent, both non-terminal — falls to "alive",
  which is the direction that costs nothing.

  **When the engine cannot be asked, nothing is written and the reason is said once, at boot.** Two
  shapes, reported differently because they are different facts: no engine resolved at all
  (`CATALOG_DURABLE=off`, so every run here is `inline` and there is nothing to reconcile — logged as
  the ordinary state it is), and an engine that resolved and cannot read a run. The second is the thin
  tenant worker, which is given `DurableStartClient` under the `WorkflowEngine` token — a store-less,
  start-only facade with no `getRun` at all — and it warns, because durable runs exist on that
  deployment and this process can see none of them. The engine is therefore injected by explicit token
  and typed `object`: declaring `WorkflowEngine` as the _type_ would state a contract that token does
  not keep, and the compiler would agree that `engine.getRun` exists where it does not.

  **A timer, on one process, and here is what it costs.** The trigger had to be something other than
  "the next attempt", which by definition never comes for these rows.

  - **Boot only** was the cheapest and does not work: the run dies mid-afternoon, and a pod not
    restarted until Thursday leaves the row `running` until Thursday. Kept as the _first_ tick, because
    a pod replacing a killed one is exactly when the killed one's leftovers are visible.
  - **A read path** is always fresh and is refused on principle: it makes a `GET` write to a governance
    record, so what a run row says would depend on who looked and when — and it costs an engine
    round-trip per open row on every render of the runs list.
  - **A pass every `CATALOG_RUN_RECONCILE_MS`** (default 5 minutes) costs one
    `ORDER BY started_at DESC LIMIT CATALOG_RUN_RECONCILE_SCAN` (default 200) over the run table, one
    `listConnectors` for the names, and one `engine.getRun` per row _currently_ marked running — nought
    or one when nothing is wrong. Nothing in that grows with the data a load moves. Not the scheduler's
    30s tick: a hundredfold the queries for no gain, in the loop whose one job is starting loads on
    time.

  New: `AbandonedRunReconciler`, `CATALOG_RECONCILE_RUNS`, and
  `CatalogPipelineModuleOptions.reconcileRuns` — defaulting to `scheduler` and then to `true`, the same
  axis and the same default as `adoptConnectors`, because this writes and six replicas racing to close
  one row is six copies of the warning about it.

  Two things it deliberately will not do:

  - **Only rows that positively say `executionMode: 'durable'`.** An `inline` row has no durable run,
    so `getRun` would answer "no record" for a load running perfectly — the same third-state error,
    reached by asking a question that never applied. A row with _no_ execution mode is refused for the
    same reason rather than guessed at, which means `ConnectorRunnerService`'s rows are not reconciled:
    that path is being retired into workflows, it keeps the next-attempt rule, and buying it a second
    would mean inferring durability from a missing column.
  - **It re-reads the run list before it writes.** Between listing the rows and the engine answering,
    every one of them had a chance to record its own outcome, and its own outcome is worth more — it is
    the one that knows what the load did. Only a row still `running` at the second read is closed. The
    starting race needs no such guard and gets none: `engine.start` awaits `createRun` strictly before
    it dispatches, and the catalog row is opened by the plan step, which runs after the dispatch — so
    "no record" can never mean "not started yet", and a grace period would be a clock with the same
    objection as before.

- dd79c42: The workflow is the only thing anybody authors

  A connector stops being an authored object. It becomes what a published workflow
  runs as: minted by `publishWorkflow`, removed with the graph, with no route to
  create one directly. `minor` and not `major` on purpose — this is 0.x, and the
  project versions on that basis rather than on whether a route was removed.

  **Routes gone.** `POST connectors`, `DELETE connectors/:id`,
  `POST connectors/:id/run`, `POST connectors/:id/discover`, and
  `GET workflows/:id/connectors`. `GET connectors` stays, as a read: it is where a
  run history and a watermark are actually keyed, and an internal record no route
  exposes is one an operator debugs by opening the database.

  **Routes arrived.** `PUT workflows/:id/schedule`, because a schedule is a
  statement about a pipeline and a pipeline is a graph; and
  `POST workflows/:id/nodes/:nodeId/discover`, because discovery is how a type gets
  its shape before anything can be published into it. `GET connections/:id/connectors`
  became `GET connections/:id/workflows`, which is the question an operator is
  actually asking before they delete one.

  **Three things had to move rather than be dropped, and each was load-bearing.**

  _Discovery._ `discoverConnectorSchema` refused any connector carrying a
  `workflowId`, telling the caller to discover from the graph's source node
  instead — correct advice pointing at something that did not exist. Every
  connector carries one now, so the old shape would have refused every connector
  there is. It takes a `DiscoverySource` and resolves through
  `WorkflowRunnerService.resolveSourceNode`, the same method a run resolves with,
  so a discovery cannot describe a source the load never touches. It answers on a
  **draft**, deliberately: a sink cannot commit into a type that does not exist, so
  requiring a published graph would require publishing a graph whose target type
  cannot be created until it is published.

  _The schedule._ Authored on `CatalogWorkflow` now, and `ConnectorScheduler` reads
  workflows. The connector keeps a copy for evidence and nothing reads it. Every
  way a schedule can exist and not fire — a draft, a disabled graph, an unparseable
  cron, a ready graph with no connector — is now logged by name rather than skipped:
  this loop once announced it was watching schedules every 30000ms while parsing
  nothing, and a silent skip is that failure wearing a different cause.

  _`expectShrink`._ The acknowledgement that lets a deliberately collapsing load
  past the row-count bound reached it only through `POST connectors/:id/run`.
  Removing that route without moving this would have left an operator unable to
  re-drive a refused load at all, which pushes them to raise the bound in policy —
  standing the guard down for every future load of the type rather than for one
  snapshot. It is on `POST workflows/:id/run`, carried through the durable step
  input, and a scheduled window still has no field for it.

  **Existing connectors are migrated, not frozen.** `ConnectorAdoption` wraps every
  connector that predates workflows into the graph it always was — one source,
  optionally one transform, one sink — at boot, idempotently, and loudly. It keeps
  the connector **id**, so the run history, the singleton mutex key and the
  watermark stay attached to the same pipeline; **re-keys the watermark** under the
  new source node, so the first run after the upgrade does not re-read an
  incremental source from the beginning; and moves the schedule onto the graph. A
  connector whose wrap does not validate is refused and keeps running exactly as it
  was. Turn it off with `adoptConnectors: false`, and be aware of the consequence:
  those connectors keep loading and no route can edit them.

  **Unpublishing and deleting a workflow now cascade.** Both used to refuse while a
  connector still ran the graph, on the reasoning that "point them elsewhere first"
  was advice somebody could act on. It no longer is — a published graph runs as
  exactly one connector, its own — so the old check would refuse every unpublish
  there has ever been. Unpublishing **disables** the connector, keeping the id and
  the history so re-publishing resumes the same pipeline; deleting removes it,
  which takes the run history with it.

  **Not included: the console.** `#connectors` and `#workflows` are still two
  screens, and `CatalogClient.saveConnector`, `deleteConnector`, `runConnector`,
  `discoverConnectorSchema` and `connectionConnectors` still address routes this
  release removes, so those actions 404. Merging the two screens into one place to
  author a pipeline is the other half of this work and is deliberately not
  half-done here.

- d4a39ba: A run the graph path left open is closed by the attempt that follows it

  `closeAbandonedAttempts` existed only on `ConnectorRunnerService`, and the two runners are two
  implementations of a load rather than one wrapping the other — so making the workflow the only
  thing anybody runs took the protection away with it. A step whose lease expires is re-dispatched
  while the attempt holding it is still inside the load: that attempt never reaches `finishRun`, and
  its row sits at `running` with `fetched = 0` and no error for good, with the truth written down
  only in `durable_step_checkpoints`. `minor` and not `major`: this is 0.x, and the project versions
  on that basis.

  **One implementation, two callers.** The rule moves to `abandoned-runs.ts` and both runners call
  it. It is subtle in a specific way — what it keys on, and which of two attempts it may touch — and
  a second copy that drifted would not fail; it would quietly close the wrong row, or stop closing
  any. The keying is unchanged and is the whole design: **the snapshot id, not age**. A durable retry
  reuses the snapshot and nothing else does, so a concurrent run of the same connector is untouched,
  and an age threshold is unusable because the loads this is about are the slow ones. Both stated
  limits survive: the last attempt of a series is closed by nothing, and an attempt still alive
  elsewhere may write its own outcome over this — which is correct, it is the one that knows.

  **A workflow run stops adopting the row it finds.** `WorkflowRunnerService.plan` was idempotent by
  `(connectorId, snapshotId)`: an existing row at the same snapshot was adopted rather than opened
  again, so a planning step that committed `startRun` and lost its result would not leave one row per
  attempt. That answered the multiplicity and left the silence — the adopting attempt wrote its own
  outcome over the row and nothing anywhere said an earlier one had vanished, which is the failure
  this scan exists to end, arrived at from the other side. The earlier row is now closed with the
  message that names the three causes and points at the checkpoints table, and this attempt opens its
  own. A run list reporting "a load that never happened" is exactly right when the row says which
  load and why it never happened.

  Consequences worth knowing:

  - **A snapshot can carry more than one row.** `findRun` answers with the one still being written,
    and otherwise with the one that recorded an outcome last. `started_at` is stored to the second,
    so a first match could otherwise report an abandoned attempt's failure as the outcome of the run
    that had just replaced it — which is what `WorkflowLauncher.awaitRun` hands back to whoever
    pressed Run.
  - **`WorkflowPlanResult` gains `notes`.** The row a workflow run reports into is opened by the plan
    step and finished by a later one, so a line written at the open would be overwritten by the finish
    step's `logs`. The closure travels on the plan's checkpoint instead — which is also what makes it
    survive a replay, the case that matters, since what is being recorded is that a previous attempt
    did not. Optional, so a run whose plan was checkpointed by an older build replays without it.
  - **`emptyProgress(logs?)`** takes the lines a run starts with, so the note sits above the first
    node's output rather than wherever a caller remembered to push it.
  - **The two housekeeping rules read one list.** `sweepAbandonedStages` no longer runs its own
    query. Two reads are two answers to which runs there were, and the read is now guarded — the
    workflow path's `findRun` on the way in was not, so a store that could not answer took the load
    with it.

  `sweepAbandonedStages` and this are **not** the same job and are not merged: the sweep takes runs
  that _failed_, at _other_ snapshots, older than the retention window, and drops staged rows; this
  takes runs still _running_, at _this_ snapshot, at any age, and writes them an outcome. Disjoint on
  every clause. They do compose — staged rows are only ever collected from a failed run, so a row
  abandoned at `running` kept its stages for good until something closed it.

  **The limit is wider on the graph path and is written down rather than papered over.** A durable
  workflow run plans once and its node retries reuse that row, so the attempt that does the closing is
  a planning step being retried or an operator re-driving the same `snapshotId`. A durable run that
  dies without reaching its finish step — an execution timeout, a cancellation, a worker that never
  resumes — leaves a row nothing revisits, because the next run mints a new snapshot. Closing that one
  needs the engine's own view of the run, which is not a clock. `AbandonedRunReconciler` does it, in
  the changeset beside this one: the snapshot id _is_ the durable run id, so `engine.getRun` answers
  whether a run this deployment still calls `running` is actually alive. The two rules are complements
  — this one needs no engine and closes the earlier attempts of a retry series as the next one opens;
  that one needs an engine and closes the row nothing will ever come back to.

### Patch Changes

- 9744e91: Test cron against the parser that ships, not a stub of it

  Every scheduled connector in a deployment was silently inert. The worker said so
  at boot, once, and contradicted itself on the next line:

                    ERROR [ConnectorScheduler] No connector will run on a schedule:
                          parser.parseExpression is not a function.
                    LOG   [ConnectorScheduler] Watching connector schedules every 30000ms.

  `cron-parser` v4 exported `parseExpression`; v5 replaced it with
  `CronExpressionParser.parse`. The durable core read only the v4 shape, so
  `prevCronFireMs` threw on the first expression it was handed — which is every
  expression, for every connector, on every tick.

  **No test here could have caught it.** `cron-parser` is an optional peer this
  package did not install, so `prevCronFireMs` throws in this repository for a
  second, unrelated reason, and any scheduler spec had to stub the parser and
  assert against the stub. A stub of the thing that broke cannot fail when the
  thing that broke changes.

  So `cron-parser` is now a devDependency, and one spec exercises the real seam:
  that the version this lockfile resolves is one the durable core can read
  through. It does not test `cron-parser` — that library has its own tests — it
  tests the join, which is the only thing an API change breaks and exactly what
  nobody was checking. It pins the arithmetic a scheduler depends on (the answer
  is aligned to the expression, not to the instant, because an unaligned fire time
  mints a new run id every tick and turns idempotent scheduling into a runaway),
  the timezone being honoured, and both refusals.

  Verified by reproducing the incident: with `@dudousxd/nestjs-durable-core`
  pinned back to 0.62.0, four of the six cases fail with `parser.parseExpression
is not a function` — the log line from the outage, in CI.

## 0.11.0

### Minor Changes

- 6986058: Bound the read side of a connector run, and stop a lost attempt vanishing without trace.

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

## 0.10.0

### Minor Changes

- 800a61b: A property name that can never be a column is refused at the publish, not at the load

  `PUT :type/schema` accepted `{"name": "Asset Id"}`, stored it, and answered 200.
  The refusal — `Refusing to use "Asset Id" as a SQL identifier: letters, digits
and underscore only, …` — arrived at the first commit, which is after the
  connector has read the whole source and written every row of it. An observed run
  reported `fetched=6905, written=6905` and then discovered the schema could never
  have worked. Real column headers look like this: `Asset Id`, `Work Order Id`,
  `Asset LIN/TAMCN`.

  Everything needed to answer the question is in the publish payload, so
  `upsertType` now answers it there: before the row is created, before the flush,
  before `ensureType`. The rule is not restated — `identifierRefusal` runs
  `assertSafeIdentifier` from `@dudousxd/nestjs-catalog`, the same call every
  store's `ident` makes before it quotes anything, and hands back the error it
  raises. So the publish-time refusal and the DDL-time one cannot come to disagree
  about the character set, the length or the wording, whichever store is mounted.

  The refusal names every offending property, not the first, and offers the
  payload that would have worked: `{ "name": "Asset_Id", "columnName": "Asset Id"
}` — the shape the API already supports, where `columnName` is free-form by
  design and is what the loader looks up in the source record. A `columnName` the
  caller already sent is kept rather than overwritten. Nothing is sanitised on the
  caller's behalf: `name` is how the catalog, every query and every row a
  publisher sends refer to the field, and quietly rewriting it would leave the
  next batch — still keyed by `Asset Id` — writing nothing into that column.

  **A name a type already holds is warned about, not refused.** `upsertType` only
  ever adds properties and nothing anywhere removes one, so refusing the republish
  of a type that picked up `Asset Id` before this check existed would leave a type
  nobody can now repair — including the publisher trying to add the correctly
  named property beside it. Those types republish exactly as they did, their
  commits keep failing exactly as they did, and the log now names the properties
  and says that fixing them means the database or a new type. A _new_ bad name on
  that same republish is still refused.

  New exports: `identifierRefusal`, `isUnpublishableName`,
  `refuseUnpublishablePropertyNames`, `describeStoredUnpublishableNames`.

- 800a61b: A delete strategy can be declared by an operator, not only by a deployment

  `CATALOG_LOAD_EXPECTATIONS` was the only way to say how a type reconciles rows
  deleted at its source, and it is a provider bound at boot. So the path was:
  build a connector in the console, run it in `full`, and the moment you wanted
  `incremental` you needed an engineer, a commit and a deploy. For a console whose
  whole premise is that you assemble a pipeline on screen, that is the wrong shape.

  The control was never about compilation. Read its own docblock: what it wants is
  that **somebody chose a strategy and wrote down why**. That needs attribution and
  visibility, which a row can carry as well as a provider can.

  So the policy now resolves through three layers, field by field:

      host.byType[type]   >   stored row   >   host.default

  A deployment that declared something about a type still wins — that is what lets
  one pin a type down and keep it pinned. Where the host is silent, an operator's
  stored decision applies. `host.default` stays weakest, so a house-wide bound
  never beats a specific one. `expectationFor` is now literally the same merge with
  no stored layer, so there is one precedence rule in the codebase rather than two.

  The enforcement functions did not move and did not become async.
  `refuseUndeclaredDeletes`, `refuseStaleReconciliation` and `refuseRowCountDrift`
  are still pure and synchronous; only the _sourcing_ of the policy reaches a
  store, and it reaches it through `supportsLoadExpectations`, so a store that
  implements none of the four new optional members behaves exactly as it does
  today. The four members are optional for that reason: this package is not the
  only implementation of `CatalogPipelineStore`, and widening a required interface
  silently disqualifies every other one.

  `PUT`/`DELETE pipeline/expectations/:type` ask for `catalog:curate` — the scope
  that already governs what the catalog says about a type — and for a person.
  `@RequireHuman()` is not decoration here: `because` is a sentence somebody is
  accountable for, and an application key has no author. The writes merge over the
  stored row, so an absent field means "leave it alone" rather than "clear it", and
  a write to a field the host owns is a 409 naming that field rather than a silent
  no-op. Both writes emit `type.curated`, the same event `patchType` emits, so the
  recorder that already lifts `principalId` into the audit table needs no change.

  The connector's cheap pre-flight gate resolves through the same three layers.
  Without that the feature would work everywhere except where it is used: a
  scheduled incremental run would still be refused by the early check after an
  operator had stored a strategy.

  `deletes` and `rowCount` are stored as JSON rather than as columns, and that is
  load-bearing rather than lazy. MikroORM infers `int` for a `number`, which would
  round `maxShrink: 0.5` to `0` — a bound that refuses a load for losing a single
  row — and would overflow a thirty-day `withinMs` past a signed INT.

### Patch Changes

- 800a61b: One rule about what may be a SQL identifier, rather than two that agreed

  `store-mikro-orm` and `store-clickhouse` each carried the pattern
  `/^[A-Za-z_][A-Za-z0-9_]{0,62}$/`, an `UnsafeIdentifierError`, and the sentence
  `Refusing to use "…" as a SQL identifier: letters, digits and underscore only,
starting with a letter or underscore, 63 characters max.` — byte for byte
  identical, in two files, with nothing anywhere comparing them.

  That mattered because the publish-time refusal added alongside this reuses a
  store's rule on purpose, so that a name refused at publish and the same name
  refused at DDL cannot be described differently. It reused the MySQL copy. Which
  bought the guarantee for a MySQL deployment and left a ClickHouse-only one
  trusting two files to have been edited in step.

  The rule now lives in `@dudousxd/nestjs-catalog` beside
  `CATALOG_RESERVED_COLUMNS`, which is already shared for exactly this reason:
  both are part of what the catalog promises a _publisher_, and a publisher should
  be able to read the answer out of the contract rather than out of whichever
  adapter happens to be mounted. New exports: `isSafeIdentifier`,
  `assertSafeIdentifier`, `UnsafeIdentifierError`.

  Each store keeps its own `ident`, because _quoting_ is engine syntax and not the
  catalog's business — what may be quoted at all is. Both now call
  `assertSafeIdentifier` and re-export the core's `UnsafeIdentifierError` rather
  than declaring one, which also makes `error instanceof UnsafeIdentifierError` a
  question worth asking across packages: it used to be false whenever the mounted
  store was not the one the catching code imported from.

  No behaviour changes. The character set, the 63-character limit, the wording and
  the quoting are all what they were; there is one copy of them instead of two.

## 0.9.0

### Minor Changes

- c457080: A version number that names code you can still read

  A connector run records `transformVersion` and a workflow run records
  `graphHash`, so the catalog has always known _which_ version produced a load. It
  did not keep the text of that version: `catalog_transform` is one row per
  transform, overwritten in place, and a saved query's `sql` was overwritten with
  nothing recorded at all — while the runs list rendered `code v3`, which reads as
  a reference to something retrievable. Every version's body is kept now, and the
  number on a run and the number on a revision are the same number.

  **New table: `catalog_revision`.** Host-visible. It is created by
  `ensureCatalogSchema` and named by `catalogManagedTables()`, so a differ's skip
  list picks it up with no action from a host that already feeds it that list. A
  host registering entities by hand gets it from `catalogStoreEntities`.
  `SavedQueryRow` also gains a `version` column, defaulted to 1 — every saved query
  that exists has had exactly one statement as far as anything can tell, and
  calling that version 1 is the only claim about it that is true.

  **Two routes**, both `catalog:read` and both newest-first:
  `GET <pipeline>/transforms/:id/revisions` and
  `GET <catalog>/saved-queries/:id/revisions`. They are the same scope as the
  routes that already serve the current `code` and `sql`, because history is that
  field one version older; the authoring scope holds back _choosing what SQL runs_,
  which reading an old body is not. `CatalogRevision` is exported from both the
  package root and `/client`.

  **Bounded, and that is the decision worth reading.** The newest
  `CATALOG_REVISION_LIMIT` (50) revisions per subject are kept; older ones are
  dropped as newer ones arrive. This is the fourth append-only table in the store
  and the first that grows with how often somebody edits rather than with what
  happened, with a whole code body per row — so a run's `transformVersion` can name
  a revision that has been evicted. That loss is real, it is strictly smaller than
  the one it replaces, and the constant's docblock states the arithmetic. A
  revision is written only when the text actually changed, following the rule the
  version counter already used, which under a cap matters more than it did before:
  a revision per save would let twenty renames evict twenty bodies that loads ran.

  **Existing rows are not left empty.** A subject with nothing recorded answers
  with its live text at its live version, synthesised on read and not written down;
  the first save that changes the text backfills that same revision for real,
  byte-for-byte identical, so a screen does not shift underneath somebody.

  **Workflow graphs are deliberately excluded**, and `CatalogWorkflow` says so
  where a reader will look for the missing feature. A graph is a structure rather
  than text a person typed, and its `version` is bumped on draft edits by design —
  archiving one body per version would fill a bounded table with autosaves of a
  canvas somebody is still dragging boxes around on, evicting the versions that
  ran.

  Both store methods are optional on their interfaces, so a store written against
  the previous shape still compiles; `supportsTransformRevisions` and
  `supportsSavedQueryRevisions` are how a caller asks, and a store that keeps none
  gets a route that says so rather than one that answers `[]` — "nothing recorded"
  and "not kept here" draw identically and mean opposite things.

> **A note on 1.0.0.** A release briefly published `1.0.0` carrying the changes
> listed under 0.8.0 below. It was withdrawn — `latest` points at 0.7.1 and then
> at 0.8.0 — because this package is not ready to claim a settled API. The
> breaking change is real and is described where it always was; inside 0.x, a
> minor is the level that carries one. `1.0.0` remains on the registry because
> npm does not allow its removal with the token that published it; nothing
> should install it.

## 0.8.0

### Minor Changes

- db38811: A caller chose which environment variable the server read, and a failed URL was readable at `catalog:read`

  Two holes on the same path, both of which turned an ordinary `catalog:write` grant into a read of
  something it was never given.

  ## 1. `secretEnvVar` was an arbitrary read of the pod's environment — **breaking**

  `resolveSecretEnv` did `process.env[name]`, and `name` is chosen by whoever writes the connector —
  on `POST pipeline/connectors`, on `POST pipeline/connections`, and on a workflow source node. There
  was no allow-list anywhere. So a principal holding `catalog:write` on one narrow object type could
  point a connector at the host application's own database and read it back out of the catalog:

  ```
  POST pipeline/connectors  {"kind":"sql","targetType":"Mvr","secretEnvVar":"DATABASE_URL",
                             "config":{"query":"SELECT * FROM users"}}
  POST pipeline/connectors/<id>/discover   → the columns, writing nothing
  POST pipeline/connectors/<id>/run        → the rows, into a type they may write
  GET  catalog/objects/Mvr                 → read them back at catalog:read
  ```

  Every guard on that path passed, and each of them passed honestly. The per-type write grant passed
  because the sink really was a type the principal held. `assertNoNewPlaintextCredential` passed
  because `config` carried no URL at all — the credential was fetched by name, which is the thing the
  design was proud of. The read-only transaction in `fetchSql` prevents writes and was never about
  reads. The three "credentials are never stored" docblocks were all true and all beside the point:
  the catalog stores the _name_, and the name is chosen by the caller.

  The error also distinguished "set" from "not set" **by name**, so any route reaching it was an
  oracle for the pod's environment, one variable per request — including `discover`, which writes
  nothing and leaves nothing behind.

  ### What a host has to do

  **Bind an allow-list, or every authenticating connector stops running.** This is fail-closed on
  purpose, the same stance `CATALOG_LOAD_EXPECTATIONS` and `RefusingSecretVault` already take.

  ```ts
  CatalogPipelineModule.forRoot({
    // …em, registry, imports, expectations…
    secretEnvAllowlist: ["FLEET_DB_URL", "DPAS_API_TOKEN", "VENDOR_*"],
  });
  ```

  or, for an operator who owns the manifest rather than the code:

  ```
  CATALOG_SECRET_ENV_ALLOW="FLEET_DB_URL,DPAS_API_TOKEN,VENDOR_*"
  ```

  **The list to write is already on your screen.** Every connector and connection shows the variable
  it reads, under `Credential env var`; the union of those is the whole migration. Both levers are
  comma- or whitespace-separated; the module option wins when both are set, and the boot line says
  which is in force, so setting the variable and seeing nothing change has an answer on screen.

  An entry is an exact name, or a prefix ending in a single `*`. A `*` anywhere else is refused **at
  boot, naming the entry** — `*_URL` reads like a tidy way to admit connection strings and it admits
  `DATABASE_URL`.

  `['*']` restores the previous behaviour wholesale — every variable in the pod readable by anyone who
  can write a connector. It exists so an upgrade under time pressure has one honest, greppable line
  instead of a pin to the previous release, and it warns on **every** boot.

  A host that binds nothing boots and warns, once, naming both levers and what will happen. Connectors
  that name no credential at all — `inline`, `file`, an S3 connector on a pod role — are unaffected.

  ### What a refused caller is told, and what an operator is told

  One sentence, the same one whether the name was never admitted or was admitted and is not set. The
  name is repeated back, because the caller supplied it; the _reason_ is what leaked, so the reason
  goes to the process log under the `CatalogSecretEnv` context instead. This is not less diagnosable —
  it is diagnosable by the person entitled to diagnose it.

  The cost, stated plainly: `POST pipeline/connections/check` gets less specific. Its whole purpose is
  catching a mistyped variable name, and it now answers "no credential is available" rather than
  naming the problem. That is deliberate and unavoidable — the route asks for `catalog:write`, which is
  exactly the grant the attack above starts from, so it cannot be given a better answer than anybody
  else. The log line has it.

  ## 2. Source URLs were echoed into run logs and audit payloads — no host action needed

  `fetchHttp` throws `GET ${url} → ${status}` and the file source does the same. The connector runner
  pushed `Failed: ${message}` into `logs` and emitted `connector.run.finished` with `error: message`;
  the workflow runner did the same, plus the per-node `error` on `nodeOutcomes`. Both sinks are served
  under the softest scope in the system: `GET pipeline/runs` returns `logs` and `error` unredacted at
  `catalog:read`, and `GET catalog/events` returns the payload verbatim. A credential-bearing URL — a
  password in the userinfo, an `?api_key=`, a signed S3 URL — needed to fail **once** to become
  readable by everybody who may look at the catalog at all. `redactConnector` guarded the connector
  list and nothing guarded the runs.

  Redaction now happens at the sink rather than at each thrower, because a URL reaches those fields
  from any fetcher, any driver and any transform — guarding the throwers means guarding the next one
  somebody writes. `redactConfigSecrets` was the wrong tool and is untouched: an error message is not
  a config object and never parses whole as a URL.

  What goes: the URL's password, its **entire** query string, and its fragment. The whole query rather
  than the parameters that look sensitive, because naming them is a deny-list and this is a fix for a
  deny-list losing. What stays: scheme, host, path and username — which is what actually says _which_
  source refused and _as whom_. A URL with nothing to hide is left byte for byte as it was. The
  unredacted message still goes to the process log, so the operator keeps the full URL.

  **Also fixed:** the connector runner folded transform logs in with `.slice(0, 50)` — a line cap with
  no character cap, so one line naming every record a transform received wrote megabytes into a run
  row, growing with the data. It now uses the same both-axes `capLines` the workflow runner has had
  since that was measured there. `capLines` moved to a new `run-logs.ts` and is still re-exported from
  `workflow-runner.service.ts`, so nothing importing it has to change.

- 67741ab: Two security fixes on the pipeline surface: who may execute a transform, and what a graph serves.

  **`POST pipeline/transforms/try` is code execution and is now authorised as such.** It was the only
  route on the controller that never called `requirePrincipal`, and it did not check that
  `body.language` was a language the way `saveTransform` does. It reached `SubprocessTransformRunner`
  on `catalog:write` alone — and that runner is honest in its own docblock about not being a security
  boundary, because the child reads the parent's whole environment back out of `/proc/<ppid>/environ`
  whatever the `env` allowlist withholds, and reads the filesystem as the service's own user. So the
  softest thing on that route was the only thing holding the door.

  It now requires a principal, at least one `writeTypes` grant, and a signed-in person
  (`@RequireHuman()` — this is the decorator's first use anywhere; declare `REQUIRES_HUMAN` in your
  guard). **Breaking for hosts** whose console calls this route with a machine principal, or with a
  principal holding `catalog:write` and no per-type write grant: both now get 403.

  The bar is deliberately the same one the graph path already charges rather than a higher one — a
  principal that may write some type can already run the same code by saving a transform, saving a
  graph and pressing Run. That residual is the trust model, and it is now written down in the pipeline
  README under "Running a transform is running code" instead of only in a JSDoc, along with the
  supported way to change it (bind your own `TransformRunner`).

  **`GET pipeline/workflows` served source-node credentials verbatim.** A `WorkflowSourceNode` carries
  the same `config` vocabulary a connector does, so a URL with a password in a graph was readable by
  anyone holding `catalog:read` — the audience `redactConnector`/`redactConnection` were written for,
  through the one route nobody had counted as a connector route. Source configs are now redacted on the
  way out, and restored per node id on the way back in, so a console that reads a graph and posts it
  back does not overwrite the credential with the placeholder. The save responses of `POST workflows`,
  `POST connectors` and `POST connections` are redacted too: each returns the row it just restored, so
  an unredacted response undid the read redaction in a single request.

  `SubprocessTransformRunner` also gets three fixes worth having regardless of the above: `stderr` is
  bounded at 64 KiB (it accumulated without any cap for the whole timeout window, growing the _parent's_
  heap until the pod died), the timeout kills the child's process group rather than one pid (so a
  transform that spawned anything no longer outlives it), and the child runs in a temporary directory
  rather than inheriting the service's, where `readFileSync(".env")` reached the host application's
  configuration.

### Minor Changes

- 4d28056: A workflow can be saved unfinished, and publishing is what validates it

  Validation used to be the gate on _saving_. `MySqlPipelineStore.saveWorkflow` ran
  `validateWorkflow` and refused anything with an issue — `"<name>" cannot run as
drawn.` — so a graph you had not finished could not be written down at all, and
  closing the tab lost it. A saved workflow was, by definition, one that runs.

  That also made the canvas lie about ordinary work. Clicking **+ Sink** produced a
  node that "is not reachable from any source" and "does not say which object type
  it writes": both true, both useless one second after the click, because a
  just-added node is unwired by construction.

  So the gate moved rather than loosened. `CatalogWorkflow` gains
  `status: 'draft' | 'ready'`. A draft saves without validating; only a `ready`
  graph runs, is schedulable, or is promoted. The same `validateWorkflow` still
  decides — a draft is not a graph that skipped the rules, it is a graph nobody has
  claimed is finished yet.

  ## What a host does on upgrade

  **The schema gains one column, and its default is the decision.**
  `catalog_workflow.status` is `varchar(16) NOT NULL DEFAULT 'ready'`, applied by
  `ensureCatalogSchema` like every other change in this package — there is nothing
  to run by hand. It backfills every existing row to `ready`, deliberately: each
  one got there through a save that refused anything invalid, so each is a graph
  that was valid when it was written, which is exactly what `ready` asserts.
  Defaulting to `draft` would have been the conservative-looking choice and would
  have silently stopped every scheduled connector on the deployment the moment the
  migration ran, because a connector may only run a ready graph. A default that
  turns an upgrade into an outage is the wrong default.

  **New graphs now arrive as drafts.** Anything automating `POST workflows` and
  expecting the result to be immediately runnable must now call
  `POST workflows/:id/publish`. This is the one behavioural break: a script that
  created a workflow and attached a connector to it in the same breath will now be
  refused at the connector save until it publishes.

  **Two new routes**, both `catalog:write`: `POST workflows/:id/publish` and
  `POST workflows/:id/unpublish`. Publishing is a transition rather than a field on
  save because "ready" is a claim that has to be checked, and a check that fails
  owes an explanation naming the nodes — a boolean on a save request has nowhere to
  put that which is not an error on an operation the author thought was about
  something else.

  **Two new store methods.** `CatalogWorkflowStore` gains `publishWorkflow` and
  `unpublishWorkflow`, and `supportsWorkflows` now asks for `publishWorkflow` by
  name. A custom store implementing the interface must add both; one that has the
  save and not the transition would narrow cleanly and then fail one call into a
  promotion that had already written types and transforms into the target.

  ## The three refusals worth knowing about

  **A connector may only point at a `ready` workflow, refused at save.** The check
  could equally have lived in the runner, and that is the version worth arguing
  against: it would move the error from the person wiring the connector — who is
  looking at the screen and can fix it in one edit — to a scheduled window at 3am.

  **A published workflow edited into an invalid state is refused, not demoted.**
  Silently dropping it back to `draft` was the alternative, and it is the one that
  loses a running pipeline without saying so: connectors may only run ready graphs,
  so the demotion would disable a scheduled load with nothing reported. Unpublish
  it explicitly to park a broken idea on a live graph.

  **Unpublishing is refused while any connector still runs the graph**, naming
  them, exactly as `deleteWorkflow` already did. Cascading — disabling those
  connectors here — was rejected on principle: turning off somebody's loads as a
  side effect of an edit to something else is the silent action this status exists
  to prevent.

  ## Promotion

  Drafts are not in the promotable set at all, which is stronger than refusing a
  draft promotion and is the statement worth making: a draft may have no sink, so
  there is not even a well-formed thing to describe to a reviewer. Nothing can be
  hidden by the omission, because no connector can reference one. `promoteWorkflows`
  now saves _and publishes_, since a save drafts and the connector phase that
  follows cannot attach to a draft — and the publish re-validates the graph against
  the transforms that actually arrived in the target rather than trusting that it
  was ready in the source.

- 0995daa: The connection form asks for a connection string, and can test it before saving

  Three changes to one screen's worth of friction.

  **One field, not two.** The SQL address block offered an inline URL and the name
  of an environment variable holding one, side by side, with a paragraph
  explaining when each applied — and only one of them worked for a database with a
  password, which is every database anybody connects to. It asks for the
  connection string now.

  **`allowInlineCredentials` on the store, default false.** A connection URL is
  the credential, and `config` is served under `catalog:read`, so a password
  inside one is refused. That refusal is what makes the "never the credential"
  promise true rather than aspirational, and it stays the default. A deployment
  that would rather type a connection string than provision an environment
  variable can turn it off — and what does NOT change is the redaction: the
  password never travels in a response either way. The flag decides only whether
  it may rest in the catalog's own table.

  **`POST pipeline/connections/check`** reaches a connection that has not been
  saved. The field most likely to be wrong is the address, and finding out used to
  mean saving a row, testing it from its card, and deleting it.

  It asks `catalog:write`, not the `catalog:read` its by-id sibling asks for, and
  the difference is the whole point: checking a saved connection reaches an
  address somebody already chose and wrote down; checking a posted one reaches an
  address supplied in the request. Under `catalog:read` that is a port scanner for
  anybody who may look at the catalog. Under `catalog:write` it grants no reach
  that did not exist — the same caller could save, check and delete — but that
  route leaves records and this one leaves none, so it logs what it did. The
  address, never the credential.

### Patch Changes

- ba2a8f6: A failed connection check no longer returns the credential

  `POST pipeline/connections/:id/check` asks for `catalog:read`, and a probe that
  fails throws with the address in its message — `${url} answered 401.` for an
  HTTP source, the driver's own text for a SQL one. A connection URL is the
  credential, so the softest scope in the system was reading the strongest secret
  in it, through an error string rather than through the config the redaction was
  built to guard.

  The process log still gets the message whole. The response is redacted:
  password, query string and fragment go, scheme, host, path and username stay —
  because which host refused, and as whom, is the entire value of a failed check.

## 0.7.1

### Patch Changes

- c2259bc: Two guards that answered "fine" when what they meant was "I could not tell".

  ## The staleness clock could be stopped by one unreadable timestamp

  `refuseStaleReconciliation` is the half that makes `periodic-full-reload` a mechanism rather than a
  note: once the newest full snapshot of a type is older than the declared interval, incremental loads
  of it stop committing. All of it rests on picking which of the store's full snapshots is the newest,
  and that was decided by comparing the two `createdAt` **strings**.

  Two of them sort chronologically only while every store writes the same UTC ISO-8601 shape — which
  this cannot check, and which did not hold.

  - **A timestamp that cannot be read at all was the expensive case.** `"unknown"` sorts above every
    real timestamp, because `'u'` is past every digit. It won the comparison for newest,
    `Date.parse` of it is `NaN`, and `NaN > withinMs` is false — so the load was admitted. One
    unreadable row, in a list whose other rows could have dated the type perfectly well, switched the
    bound off, and nothing anywhere said so. A type nine days past a one-day interval went on carrying
    forward rows deleted upstream, reporting healthy the whole time.
  - **An offset other than `Z` was the cheap case**, wrong in the safe direction: it mis-ordered by up
    to a day and therefore refused slightly more than it should.

  Both are the same fix. The unreadable ones are now dropped **before** the newest is chosen, and the
  newest is chosen by parsed instant. A refusal also names the snapshot it actually dated the interval
  from, which it could not be relied on to do before — being refused with the wrong snapshot named
  sends an operator to look at a load that was fine.

  **This can refuse a load it previously admitted**, which is the point of it: the loads it now refuses
  are the ones whose last full reload really is past the interval. A store that gives every full
  snapshot an unreadable `createdAt` is still admitted, unchanged and deliberately — that is the same
  permissive-rather-than-punishing stance `CARRIED_FROM_LABEL` takes, and there is nothing to refuse ON
  when every comparison available is against `NaN`. What changed is how narrow that branch is: it used
  to be reached by one bad row, and now needs all of them.

  ## `InMemoryCatalogOverlayStore` handed out the object it holds

  `load()` returned the store's own overlay and `save()` kept the caller's. The registry edits the
  overlay in place — `this.overlay.types[name] = { ...current, ...patch }` — before it persists, so the
  store's state moved on a patch, before any `save`, in both directions.

  The net behaviour was identical, because every edit is followed by a persist. Two things were not:

  - **The two bundled stores disagreed about the one sentence a store is for.**
    `FileCatalogOverlayStore` round-trips through JSON and so has never aliased anything. Every spec in
    this repository runs on the in-memory one, so a test asserting that an edit had not been written
    yet passed vacuously here and would have failed on the store a deployment actually uses.
  - **Two registries over one store shared mutable state**, each able to see the other's half-applied
    edit with no write between them.

  Both ends now copy, and one end would not have been enough: copy only on `load` and the object handed
  to `save` becomes the store's own again on the very next patch; copy only on `save` and the object
  handed out by `load` already is. The copy is a `structuredClone` rather than a JSON round-trip, so a
  key whose value is `undefined` survives it instead of being silently dropped.

  The cost is one deep copy per load and per save. The overlay holds the names, descriptions and
  per-property patches a human has typed — not the catalog, which is derived from entity metadata and
  does not live there — so the two paths that pay it are a boot and a curator pressing save. Neither is
  a read.

## 0.7.0

### Minor Changes

- ca6d08b: A Python transform's `print` goes somewhere, and `durability()` stops describing checks it never made.

  ## `print`

  `TransformResult.logs` is documented as "Anything the code logged", and the JavaScript harness
  overrides `console.*` so that it is. The Python harness captured nothing unless the author called an
  undocumented `log()`: `print` went straight through to the child's real stdout, where the last-line
  result parse discarded it. So the first thing anybody writes while working out what their transform
  is doing produced an empty log panel and no explanation — and the conclusion that invites ("my code
  never ran") is the wrong one. It costs the author their trust in the tool before they have written
  anything real.

  `print` is now redirected, along with `sys.stderr`, into the same list the result carries.

  - **`log()` stays, and is now literally `print`.** Transforms in the wild call it and a `NameError`
    is a worse answer than a redundant helper — but it is no longer a second capture path with its own
    ordering. One buffer, one sequence.
  - **stdout and stderr interleave in call order, unmarked**, which is what the JavaScript harness
    already does with `console.error`. A reader is reconstructing a sequence and two lists cannot be
    zipped back together.
  - **Output written before a traceback survives it.** The redirect is a `contextlib` context manager
    around the call rather than a swap held for the whole script, so it unwinds out of an exception
    with the buffer intact. That is the case logs matter most for and the case a naive swap loses.
  - **A write that never ended its line is kept** rather than being lost. It used to be worse than
    lost: it landed immediately before the result JSON on the same line, so `sys.stdout.write("x")`
    without a newline failed the whole run as unreadable.

  ## Bounds, in both harnesses

  `logs` is user code writing whatever it likes, and it is the one thing that crosses a durable step
  boundary into the run record — so an unbounded capture makes the size of a `finishRun` write a
  property of somebody's source data. Both harnesses now cap at **500 lines of 2,000 characters**, the
  same two numbers, applied in the child before anything is serialised. The JavaScript harness had no
  bound of its own; its only ceiling was the 32MB stdout kill, which loses the whole run rather than
  truncating a log.

  What is dropped is said out loud, in a final line naming the count. A truncation nobody is told about
  is the same failure as a log nobody is told about, moved to line 501.

  The Python sink is bounded, not only its result: an unterminated write past a line's ceiling is
  emitted rather than accumulated, so a transform writing megabytes with no newlines in them cannot
  grow the child's memory either.

  Two smaller things of the same family: **`console.debug` and `console.trace` are now captured**
  (`debug` writes to stdout exactly as `log` does, so it was corrupting the very result line the
  override exists to protect; `trace` writes to stderr and simply vanished), and **a failing transform's
  last logged lines are folded into the error**. A failure throws, and a throw carries a message and
  nothing else, so `logs` never reached the caller at all on the one path they were most wanted — the
  last ten lines at 200 characters, counted so nobody reads a tail as the whole of it.

  ## `WorkflowLauncher.durability()`

  Its docblock described three refusal checks — an engine, whether this pod serves handlers for it, and
  whether that engine belongs to the environment the caller asked for — and the body performed one. An
  unused `requireEnvironmentBundle` import and an uncalled `safely()` helper were left behind from the
  other two.

  **The prose was corrected rather than the checks rebuilt, because neither can be made correctly from
  this package**, and the docblock now says that instead of implying they are covered:

  - **Handlers.** `engine.workflowBody(name, version)` answers only half of it. A body means definitely
    registered; _no_ body is equally a `registerRemote` worker in another SDK or a group resolved by
    convention against a live worker, both of which run the graph perfectly well. Treating that half
    answer as "no" would route a durable run inline — and an inline run carries none of the singleton
    mutex, so two workers would load one connector's type at once. That is worse than the failure it
    would guard against, and the genuinely unregistered case already fails loudly: `engine.start` throws
    and `startDurable` refuses rather than falling back.
  - **Environment.** The one with real damage behind it, and the one least available from here. A
    `WorkflowEngine` carries no environment identity this package can read, so the most it could compute
    is which environment the _caller_ is in — half a comparison, which is exactly why the two fossils
    were left unused rather than finished.

  Both are therefore reported rather than detected, through
  `CATALOG_PIPELINE_DURABILITY_DETAIL` — **which was broken in the way that matters most for that job.**
  The seam is documented as something that "only ever ADDS to what the package observed" and it was
  _substituting_: a host binding a true and specific sentence ("this pod registers no workflow
  handlers") erased the sentence saying whether an engine had resolved at all. It now composes, with
  the observation first, because that is the part that was actually checked.

  `WorkflowDurability.engine` is populated for the first time. It is declared as something a console can
  print and absent whenever nothing can checkpoint, and the body never set it — so the console's
  `checkpointing: <engine>` label could not have rendered a name in any deployment. It is the class that
  resolved, which is a weak signal named as one: it distinguishes a real engine from a host's stand-in
  and says nothing about which broker or which environment is behind it.

  **Still unreachable, and not fixed here:** `GET <path>/pipeline/capabilities` returns only
  `{ languages, pythonPackages }`, so nothing serves `durability()` over HTTP at all. The React console
  already has the banner — `describeDurability(capabilities?.durable)` in `WorkflowCanvas` — and reads
  `undefined` in every deployment. Whatever a host says through the detail seam is dropped on arrival
  until that route carries `durable`.

- 6e9e1f5: A full connector run that read nothing now leaves a snapshot

  A batch is the only thing that creates the snapshot row, and the batching loop
  wrote none when there were no rows. So a full-mode connector whose source
  returned nothing left no snapshot at all, and the commit that followed refused
  with "no snapshot has been written" — an error naming the wrong event entirely,
  for a source that answered perfectly and had nothing to say.

  The labels ride on that batch, and the labels are how an operator's
  acknowledgement that a collapse was deliberate reaches the snapshot. So the one
  case `expectShrink` was built for — a source that really was emptied — was the
  one case where it could not arrive.

  Incremental runs are deliberately excluded: the carry-forward that follows
  writes the snapshot and carries the same labels, so a batch here would be a
  second write on a path that already has one.

  An empty batch is a statement — the load ran and produced nothing. Writing no
  batch at all is silence, and the store cannot tell silence from a crash.

## 0.6.0

### Minor Changes

- 0512946: Somewhere to bind the load expectations, and a way for a run to say a shrink was
  meant

  Two loose ends left by the load-expectation refusals, both of them about the
  same thing: the feature ships on, so the two moments a host actually meets it —
  binding it, and being refused by it — are the two moments that had no shape.

  **A host had no natural place to bind the token.**
  `CATALOG_LOAD_EXPECTATIONS` is how a deployment declares, per object type, how
  rows deleted at the source reach the catalog and how far one load may move a row
  count. The only way to bind it was to write a module that provides it and pass
  that module in `forRoot({ imports })` — a module whose entire body is one
  `useValue`. `forRoot` already takes `em` and `registry` as `Provider`s for
  exactly this kind of seam, and now takes `expectations` the same way:

  ```ts
  CatalogPipelineModule.forRoot({
    // …em, registry, imports…
    expectations: {
      provide: CATALOG_PIPELINE_TOKENS.expectations,
      useValue: {
        default: { rowCount: { maxShrink: 0.5, minRows: 100 } },
        byType: {
          AuditEvent: {
            deletes: { strategy: "accepted", because: "append-only ledger" },
          },
          Mvr: {
            deletes: {
              strategy: "periodic-full-reload",
              because: "the nightly connector reads the whole fleet",
              withinMs: 86_400_000,
            },
            rowCount: { maxShrink: 0.3 },
          },
        },
      },
    },
  });
  ```

  The docblock on that option is now where somebody learns what to declare and
  why, rather than a changeset nobody reads twice. Exporting the token from a
  module in `imports` keeps working exactly as before; a host that does both gets
  the one passed to `forRoot`, which is Nest's ordinary precedence.

  **An absent binding and an empty one are now different statements.** They
  produce the same refusals — an incremental load of an undeclared type does not
  commit either way — but "nobody here has thought about deletes" and "we looked
  and nothing applies" are not the same fact, and only the first is a surprise. A
  host that binds nothing now hears one line at boot naming the token, what will
  be refused, and the bound that applies meanwhile. A host that binds `{}` has
  answered, and is not warned at.

  **A connector run can now acknowledge a deliberate truncation.**
  `_expectShrink` stands the row-count bound down for one snapshot — a source
  deliberately emptied, a type cut back to one base for a migration — and the HTTP
  publish path could set it. A connector run could not: the runner hard-coded
  `{ source, connector }` as its labels. The only way through was to raise
  `rowCount.maxShrink` for the type, run the connector, and lower it again, with
  the type unbounded in between and the third step the one that gets forgotten.

  `ConnectorRunnerService.run` now takes a fourth argument:

  ```ts
  await runner.run(connectorId, principal.id, snapshotId, {
    expectShrink: "The 509th was cut back to one base for the migration.",
  });
  ```

  A reason rather than a flag, and an empty one is refused with a 400 before a run
  row is opened — the same requirement `DeleteReconciliation.because` makes, for
  the same reason: the sentence is stored in the snapshot's labels, so "why was
  this load allowed to lose most of the data?" is answerable off the snapshot by
  somebody who was not there. It is also written to the run's own log, so a
  collapse that was permitted does not read like an ordinary load in the runs
  list.

  **It cannot become permanent, because there is nowhere to keep it.** It is an
  argument to one call: not a column on the connector, not a key in
  `connector.state` — the runner's watermark, which the catalog documents as never
  written by a person — and not a field on `ConnectorRunStepInput`. That last
  exclusion is the deliberate one. A scheduled run has no way to acknowledge
  anything, because it comes from a cron window attributed to a synthetic
  `scheduler` principal with nobody watching, and an acknowledgement given once
  and honoured nightly is the bound switched off wearing a reason. A refused
  scheduled load is meant to fail loudly and be re-run by hand by somebody willing
  to say why.

  One thing stated rather than glossed, because it is the last inch: the bundled
  `POST /pipeline/connectors/:id/run` route does not yet read `expectShrink` off
  its body, so today the acknowledgement is reachable from a host's own controller
  or any caller holding the exported `ConnectorRunnerService`, and not from the
  bundled route.

## 0.5.0

### Minor Changes

- 5cb78c8: A connector can report the schema of the source it reads

  Pointing this catalog at a table nobody has written an entity for meant writing
  the schema out by hand, column by column, from a database somebody had to open a
  client against. `appendRowsAsSystem` refuses a type the registry does not carry,
  and the only things that create one are a `@CatalogType` entity or a
  `PUT /publish/:type/schema` body — so every table without an entity cost a
  person a session with `information_schema` and a JSON document typed from it.

  `POST pipeline/connectors/:id/discover` closes that from the other end. It runs
  the connector's own configured read, reports the columns, and **creates
  nothing**. For a SQL source the columns come from the driver describing the
  result set of the author's query wrapped in `LIMIT 0`, so a billion-row table
  costs what an empty one costs and no row is read at all; Postgres type oids and
  MySQL column type ids are mapped to catalog scalars, including the two the ids
  alone get wrong (`TINYINT(1)` is how MySQL spells a boolean, and a `TEXT` column
  arrives under a blob type id with a non-binary character set). For `http`,
  `file` and `s3` there is no schema to ask for, so the shape is inferred from a
  bounded sample and the payload says so in as many words.

  **A column it cannot type confidently is reported with no type at all.** Not
  `string`, not `unknown` — `null`, which the console renders as "not typed" and
  refuses to include until a person chooses. An unmapped oid, a sample that
  disagrees with itself, a column that was null in every record sampled: each one
  comes back with the reason. Guessing quietly is the failure that matters here,
  because a wrong type becomes a wrong column in a lake nobody re-checks and the
  load that fills it succeeds every night.

  **Re-running discovery against a type that already exists reports drift** —
  columns the source gained, columns it lost, columns whose type moved. That is
  the part worth having. A first discovery happens once per source; drift happens
  for as long as the connector exists, and all three are silent today: an added
  column is dropped by the store, a removed one loads as null, and a retyped one
  is coerced into whatever the catalog still believes.

  The route is authorised exactly as running the connector is, against a grant on
  its target type. Saving and running both require one, so without that check
  discovery would have been the first route on this surface that let a principal
  with no grants make the server read a source — and the answer is the column
  names of a database it was never allowed near.

  Property names take the source's spelling verbatim. The warehouse store matches
  records to properties as `row[property.name]`, so a `first_name` column tidied
  into a `firstName` property is a column that writes null on every run and
  reports success; the tidying belongs in `displayName`, which is editable at
  runtime and needs no migration.

  In the console, the connector editor grows a "Discover schema" panel behind a
  new optional `schemaDiscovery` prop on `<PipelineConsole />`. `CatalogClient`
  carries neither a discovery call nor any publish call, so the two functions are
  handed in rather than invented; a host that supplies discovery but no way to
  create a type gets the confirmed `PUT` request printed instead of a button that
  cannot work.

- 8d58f9f: Links survive publishing, and survive a promotion

  Relations shipped end to end — discovered from ORM metadata, stored as a column
  on the object type row, merged by a rule that knows what a publisher owns and
  what a curator owns, served on the type and drawn in the graph — with nothing
  writing the column. `PublishedType` had no `relations`, so the one route an
  application publishes its shape through dropped every link at the door, and the
  whole feature was inert in any deployment that had not hand-edited the database.
  `PUT /publish/:type/schema` now carries them, through the row's own
  `mergeRelations` rather than a second copy of that judgement.

  **Absent and empty are different statements on that wire.** A publisher that
  sends no `relations` key has said nothing about links and its stored ones are
  left alone — an application on a client that predates this field re-publishes its
  whole shape on every deploy, and reading silence as "no links" would delete the
  ontology, and every label curated onto it, the next time somebody shipped an
  unrelated change. A publisher that sends an empty array has said there are none,
  and the merge drops them.

  **A promotion between environments carried none of it.** The promoted type
  arrived complete in every visible way — right properties, right table, right
  owner — and sat in the target's graph as an island, with nothing erroring at any
  point, because the plan could not see the difference either: a promotion whose
  only content was a link reported "nothing to promote". The promotable shape now
  carries relations, the diff reports `relations.added` / `.changed` / `.removed`,
  and the apply writes them.

  **`relations.removed`, not `relations.absentFromSource`.** A property that
  disappears from the source keeps its column and its rows in the target, because
  `ensureType` never drops anything; a link that disappears is deleted there. The
  apply ASSIGNS the source's links rather than merging them — a promotion is
  somebody approving a fingerprinted plan of what the source holds, and a link the
  source deliberately dropped surviving in the target would mean the plan says
  `relations.removed` while the apply does not remove it. It is safe in a way
  dropping a column is not: a column may still hold rows, a link holds nothing.
  The removed names are carried in the diff's `to` value, because the fingerprint
  an approval is compared against hashes exactly that — empty, dropping the link to
  `Base` and dropping the link to `Depot` would hash identically.

  `StoredRelation`, `PublishedRelation` and `relationsOf` are exported from the
  store package's entry point, along with `catalogConnectionProviders`, which had
  fallen behind the same hand-maintained list: both connection tokens were exported
  and the only supported way to satisfy them was not.

- b4410bb: A load now has to be plausible before it becomes the data everybody reads

  Two failures, and they are the same failure from two ends: a load that is
  **fresh and wrong**. Every signal this catalog publishes about a type —
  `lastCommittedAt`, the age badge on the Model screen, a green run in the runs
  list — reports whether a load HAPPENED. None of them reports whether what it
  loaded resembles the dataset it replaced, and a snapshot commit is atomic, so
  from the moment a wrong load commits it is indistinguishable from a right one
  until somebody counts rows by hand.

  **Deleted rows lived in the lake forever.** An incremental connector asks its
  source for what changed since a watermark. A row physically removed from the
  source never changes again, so it is never returned again, so `carryForward`
  copies it into every subsequent snapshot indefinitely. Nothing goes wrong at
  any step; the catalog simply never finds out. There was no reconciliation, no
  tombstone, and no mention of the limitation anywhere.

  `PublishService.carryForwardAsSystem` — the one method every incremental load
  passes through, whether it came from a connector, a workflow sink or an
  application — now **refuses a type for which no reconciliation strategy has
  been declared**. `ConnectorRunSteps` asks the same question before a scheduled
  connector reads its source, so a misconfigured connector is refused without
  pulling forty thousand rows first and without burning three durable retries on
  something that will be exactly as wrong in fifteen minutes.

  **A collapsed load committed as though it were healthy.** A connector that
  starts returning 12 rows where it returned 40,000 — a source-side filter
  change, a broken `WHERE`, a partial outage — committed successfully. Both
  commit paths now compare the pending snapshot against the one being served and
  refuse a load that lost more of it than the type allows. A refusal leaves the
  snapshot written and uncommitted, so readers keep the previous one and the rows
  are still there to be looked at; a connector run reports it through
  `connector.run.finished` with `status: "failed"`, the same event both outcomes
  have always come out of.

  **Both are refusals a host will meet.** What to do about it:

  Bind `CATALOG_LOAD_EXPECTATIONS` from a module you already pass in
  `CatalogPipelineModule.forRoot({ imports })`, exporting the token:

  ```ts
  {
    provide: CATALOG_LOAD_EXPECTATIONS,
    useValue: {
      default: { rowCount: { maxShrink: 0.5, minRows: 100 } },
      byType: {
        AuditEvent: { deletes: { strategy: 'accepted', because: 'append-only ledger' } },
        Employee: {
          deletes: {
            strategy: 'soft-deleted-at-source',
            because: 'HR sets deleted_at, so the watermark sees the removal',
            column: 'deleted_at',
          },
        },
        Mvr: {
          deletes: { strategy: 'periodic-full-reload', because: 'nightly full read', withinMs: 86_400_000 },
          rowCount: { maxShrink: 0.3 },
        },
      },
    },
  }
  ```

  - **Every type loaded by an `incremental` connector needs a `deletes` entry**,
    or its next load is refused. The reason is a required field: it is the only
    part of the decision still legible in six months. `periodic-full-reload` is
    the one that is policed — once the last full snapshot is older than
    `withinMs`, incremental loads of that type stop committing.
  - **The row-count bound applies with no configuration at all**, defaulting to
    `maxShrink: 0.5` above `minRows: 100`, plus an absolute rule at any size: a
    snapshot of zero rows never replaces a non-empty one. Growth is unbounded
    unless a type sets `maxGrowth` — a type that doubles has usually had a good
    day, a type that loses 90% has not. A load that is legitimately smaller is
    admitted by setting `_expectShrink` in its labels (the publish API passes
    labels through) or by raising `rowCount.maxShrink` for that type.

  Two limitations stated rather than glossed. A connector run cannot set
  `_expectShrink` today — the runner labels its snapshots `{ source, connector }`
  and takes no input for the rest — so a connector whose truncation is deliberate
  is unblocked by raising the bound for that type. And a store that implements
  neither `currentSnapshot` nor `listSnapshots` has no baseline to compare
  against; the row-count check logs a warning naming the type and stands aside
  rather than refusing an adapter for recording less than the bundled one does.

- ad0219b: The console can reach schema discovery, and a host can bind load expectations

  Two features shipped in this release were built and unreachable, for the same
  reason in two places: the thing that would call them had no name to call.

  **Schema discovery** returned a report the console could not ask for.
  `CatalogClient` gained `discoverConnectorSchema`, and `pipelineRoutes` the path
  behind it. The panel took a bridge as a prop and nothing supplied one.

  **Creating the type from that report** had nowhere to go at all: this client had
  no publish call, because publishing is the one write that does not go through
  the catalog's own routes — there is deliberately no `POST /catalog/types`, since
  structure follows a publisher and curation follows a person. `publishType` is
  that call, and `CatalogTransport.put` is optional so a transport written before
  this keeps compiling. A client handed one that cannot `PUT` refuses **by name**
  rather than resolving having done nothing: a "Create type" button that returns
  without creating a type is the exact failure the panel exists to prevent.

  `publishBasePath` is its own option, defaulting to `/publish` — a sibling of the
  pipeline's base, not a child, because that is how the library mounts the two.

  **Load expectations** were exported from nothing. `CATALOG_LOAD_EXPECTATIONS` is
  the token a host binds to declare how a type handles deleted rows and how far a
  snapshot may shrink; a token nobody can name is a feature nobody can switch on,
  and the refusals ship on by default. The whole module is exported with
  `export *`, deliberately — a hand-maintained list is how the catalog package's
  barrel came to export an interface without the two types its one method takes.

## 0.4.0

### Minor Changes

- f1100ba: Enforce per-type write grants across the pipeline surface, stop serving connection passwords, and make a deleted connector actually stop retrying.

  **Behaviour change: the pipeline routes now authorise, not just attribute.** `mayWrite` had call sites in one file — `publish.service.ts` — and none on this surface. Every route here read `request.principal` for `?.id ?? 'console'` and used it as a name to write in a log, so a principal holding `catalog:write` with `writeTypes: ["Mvr"]` could author a workflow whose sink commits `Subwo`, attach a connector, and run it. Nothing lied on the way through: the graph validated, the run succeeded, and the snapshot recorded the write as authorised.

  Four routes now refuse. `POST /pipeline/workflows` and `POST /pipeline/connectors` check at save time, which is the gate the scheduled path depends on — a cron-fired run carries a synthetic scheduler id with no grants to consult, so the question has to have been answered when the graph was written down. `POST /pipeline/workflows/:id/run` and `POST /pipeline/connectors/:id/run` check again at run time, which catches what save time cannot see: a graph saved by a principal that held the grant, run by one that does not. Types are read off **every** sink, not off `WorkflowRow.targetType`, which records only the first sink a multi-sink graph declares.

  A host may now be refused for: saving or running a workflow whose sink commits a type outside the principal's `writeTypes`; saving a connector whose `targetType` is outside it, or one attached to a workflow whose sinks are; running either. Refusals are `403` and name every type they turned down.

  **Behaviour change: these routes now require a principal.** `saveConnection`, `saveConnector`, `saveTransform`, `saveWorkflow`, and both run routes previously fell back to attributing the write to `'console'` when no guard had put a principal on the request. They now fail the way `createPublishController` already did, because a caller with no identity has no grants to check and "allow everything when nobody is identified" is the bug being fixed. **A deployment that mounts `CatalogPipelineModule` without a principal guard will start failing these routes.**

  **Behaviour change: a connection URL carrying a password is no longer accepted or served.** `ConnectorRow.config`, `ConnectionRow.config` and `sources.ts` all promise that a credential is never stored — only the _name_ of an environment variable. That held for token-based sources and not for SQL, where `fetchSql` reads `config.url` and `postgres://user:pass@host/db` is a password with an address attached. `config` was persisted verbatim, returned verbatim, and served by `GET /pipeline/connections` and `GET /pipeline/connectors`, both of which ask only for `catalog:read`.

  Two halves, because neither alone is enough:

  - `MySqlPipelineStore.saveConnector` and `saveConnection` refuse a password-bearing URL in `config` that is not already the stored value for that row. Refused in the store rather than the controller, because a connector saved by curl, by a host's own code, or by `applyPromotion` reaches it and nothing else. **A host may now be refused for** creating a connector or connection whose config carries such a URL, changing an existing one's to a different password-bearing URL, or **promoting such a connector into an environment that does not have it yet** — `promoteConnectors` already refuses to carry `secretEnvVar` across so a promoted connector "arrives with no credential", and this applies that rule to the credential that was hiding inside `config`. Move the URL into an environment variable and name it in `secretEnvVar`. Rows already in the table are grandfathered and keep running.
  - The four read routes that serve connectors and connections redact the password on the way out. This is what covers the rows that are already stored. It is at the route and not in the store on purpose: `ConnectorRunnerService` resolves the connector it is about to run through the store, and `applyPromotion` copies connectors between environments by reading them from it — a store that redacted would hand the runner a URL that cannot connect and promote the placeholder into the next environment as though it were the password.

  A console that reads a connector, edits it and posts the whole object back is safe: the save routes put the stored credential back when the value they receive is exactly the redaction of what is held.

  **Fix: `FatalError` in the connector step now actually stops the retries.** `connector-run.steps.ts` documented that a deleted or disabled connector must not be retried and did not achieve it. `FatalError` carries `message` and `code` and no `retryable`; durable core honours the class itself only in `runStepHandler`'s local retry loop, while a dispatched step is judged by `existing.error?.retryable !== false` on a serialised envelope. All three attempts were burning over roughly fifteen minutes for a connector somebody deleted on purpose. Fixed the way `workflow-run.steps.ts` already had been, by extending `FatalError` with `readonly retryable = false` so both paths are correct.

## 0.3.1

### Patch Changes

- 0fe6d6f: Clear the lint backlog — 63 warnings to 0, mostly by extraction

  Behaviour is unchanged throughout; what moved is where the code lives.

  **Two `any`s in `sources.ts`** became interfaces declaring only the methods this
  package calls, with rows staying `unknown[]` because that is the boundary where
  the type genuinely is unknown. No assertions were added.

  **Two functions were doing several separable jobs.** `planPromotion` (61) split
  into a section per kind, and `validateWorkflow` (75) into the checks its own
  comments already named. `workflowRunOrder` now reuses `buildAdjacency` rather
  than rebuilding its own indegree map — its docstring already argued that "two
  implementations of one rule is how a graph that validated comes out executing
  differently", and it was doing exactly that.

  **The vendored chart files are handled by config, not by comments.** 79 files
  under `charts/bklit/` carry a header promising "nothing else is modified, so
  re-syncing with upstream stays a diff rather than a merge". A scoped `overrides`
  entry keeps that promise, and it made nine pre-existing suppressions redundant —
  so those files now have FEWER local edits than before, not more.

  **Three suppressions survive, each with the reason written beside it:**

  - A telescope event renderer whose docblock asserts every branch emits only
    names, never data. That is a security property auditable in one screen
    precisely because the branches are adjacent; splitting them into four
    functions would spread it where it can no longer be read at once.
  - `SelectField`'s `<label>`: `Select` renders a BUTTON, and a label does not
    implicitly name a button — which is why `Select` already required an
    accessible name of its own. `ariaLabel` now defaults to `label` so the common
    case cannot forget it, while still allowing the fuller name the call sites
    deliberately use ("Kind" on screen, "Connection kind" announced).
  - `Switch`'s `<label>`, which DOES resolve — Base UI renders a hidden native
    input inside the root, so the implicit association works and the rule simply
    cannot see through the component boundary. A new spec asks for the control by
    its accessible name, so the suppression's claim is checked rather than
    asserted.

  **`planPromotion` had no test at all**, which is a poor place for the largest
  refactor in the batch: it decides what moves between environments, and a wrong
  plan promotes something that should have been withheld or withholds something an
  operator is waiting on, neither of which throws. It now has 37, mutation-checked
  — including the cross-section exception where connectors are planned last and
  handed what the earlier sections produced, so a connector whose transform is
  arriving in the same promotion is accepted rather than blocked.

  The two deliberate NUL bytes — a sentinel in `stable()` and a separator in the
  query cache key — are now written as escapes rather than raw bytes. Same value;
  git stops calling those files binary and `grep` stops silently finding nothing
  in them.

## 0.3.0

### Minor Changes

- 5d10b69: Serve the workflow routes the console asks for

  The controller was ported without its five workflow endpoints, so the Ingestion
  › Workflows screen answered `Cannot GET …/pipeline/workflows`. They are back:
  `GET`/`POST` `workflows`, `DELETE workflows/:id`, `POST workflows/:id/run` and
  `GET workflows/:id/connectors`.

  `WorkflowLauncher` is registered and exported alongside them — a route that can
  list workflows but not start one is a screen with a button that 404s.

## 0.2.1

### Patch Changes

- 64ad4f0: Stop naming one consumer in a public library

  The pipeline package was extracted from an application's copy of the engine, and the extraction
  carried that application's name into comments, a docblock, a seams table — and into a **runtime error
  message**, which shipped advice about one host's durable module to every consumer that hit it.

  Nothing was wrong with the _reasoning_ in those places; only with whose name it was told through. It
  now describes the situation rather than the application: "a host with separate API and worker
  processes", "a multi-environment host", "either this host mounts no durable engine, or its durable
  module failed to bind".

  `catalog.principal.ts` had the same slip in an older comment, so that goes too.

## 0.2.0

### Minor Changes

- 6f739d9: Ship the pipeline and publish controllers

  The engine moved into this package but its HTTP surface did not, so the 19 routes under
  `<path>/pipeline` and `<path>/publish` stayed hand-written in every host — the same duplication the
  engine had, one level up.

  They are factories, matching `createCatalogController`: the route prefix and the guards come from
  `forRoot`, because a library that hardcodes the auth for routes which can rewrite a catalog's schema
  is deciding something only the host can. Omit `path` and no controllers are mounted at all, which is
  what a worker-only host wants.

  `@dudousxd/nestjs-catalog` now owns the vocabulary those routes declare with — `RequireScopes`,
  `RequireHuman`, and the two metadata keys behind them. It already owned `CatalogScope`,
  `CatalogPrincipal` and `hasScope`, and the alternative is every package that ships routes inventing
  its own key, which would force a host to write one guard per package instead of one guard for the
  catalog. Declaring stays separate from enforcing: the library says what a route needs, the host's
  guard decides who the caller is.

## 0.1.1

### Patch Changes

- af85ebe: Export `SubprocessTransformRunner`

  A host that declares its own pipeline controllers needs it, and Nest resolves a controller's
  dependencies from the module that declares the controller — so without the export the host fails at
  boot with `Nest can't resolve dependencies of the PipelineController ... SubprocessTransformRunner at
index [1] is available in the ... module`.

  Exported rather than left to the host to provide, because this module owns the configured instance:
  it is the one built with `pythonVenv`. A host supplying a second one would be running transforms
  through a runner configured somewhere else, which is the kind of difference that only shows up when a
  transform cannot find its interpreter.

## 0.1.0

### Minor Changes

- d00c67d: The connector pipeline, as a package

  Fetch, transform, publish was application code in two places at once: the standalone catalog service
  and a copy of it mounted inside another app. The two had already drifted — one of them was missing
  the scheduler entirely, so `connector.schedule` was a column nothing acted on until it was ported by
  hand. That is the failure duplication always produces eventually, and it is why this is a package.

  Two things the engine cannot decide for itself are injected rather than imported, because the two
  applications it came from disagreed on both:

  - `CATALOG_PIPELINE_EM` resolves the EntityManager a write lands on. It is a **function**, not a
    value: a multi-environment host picks the connection per call, and a value captured at construction
    would pin every write to whichever environment was current at boot. Writing to the wrong database
    is not a type error and the rows land successfully.
  - `CATALOG_PIPELINE_REGISTRY` is the registry the engine reads the model from — only `reload()` and
    `getType()`, which is all either application used.

  `CATALOG_PIPELINE_SCOPE` covers the third difference. A durable step is a message off a queue and a
  scheduler tick is a timer callback, so neither carries an ambient scope; a host routing one store
  across several environments enters one, and a single-connection host binds the pass-through default
  and pays nothing.

  The scheduler's "should this process poll?" is an option instead of the `APP_TYPE` check the copy
  carried, which was one host's role split leaking into shared code.
