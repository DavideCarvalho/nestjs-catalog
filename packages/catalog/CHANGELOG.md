# @dudousxd/nestjs-catalog

## 0.22.0

### Minor Changes

- 0499f80: A transform can now be a function over one object, so the argument list can grow

  The harness wrapped an author's code as a bare body and handed it `records` and
  `context` **positionally**. That fixed the set of things a transform can be given
  on the day the second parameter landed: a third one changes what every signature
  ever written means, including the ones sitting in a database that nobody is going
  to re-read. So the supported shape is a real function taking a single object —

  ```js
  export default function transform({ records, context }) {
    return records.map((r) => ({ mgmtCd: r["Mgmt Cd"] }));
  }
  ```

  — and a field can be added to that object later without touching a line of
  anybody's stored code. That is the whole argument; the syntax is just how it is
  spelled.

  **Nothing stored changes.** A bare body still runs through the identical wrapper,
  with the identical positional parameters and the identical interpreter flags. The
  two shapes are told apart by a top-level `export` keyword, which is a _syntax
  error_ inside a function body — so no transform that runs today can contain one,
  and backward compatibility is a property of the language rather than of how good
  a guess is. The rule deliberately ignores names: a body that declares its own
  helper called `transform` is still a body.

  Also:

  - `CatalogTransformInput` and `CatalogTransformFunction` are exported from
    `/client` for editor help. `import type` is erased before the code runs, so
    they cost nothing at run time — and buy nothing at run time either. Node's
    TypeScript support is stripping, not checking; a wrong type still runs.
  - `transformShape` / `transformDeclaresModule` are exported so a UI can say which
    shape the runner will read code as, from the runner's own rule rather than a
    second copy of it.
  - The transform editor opens new JavaScript and TypeScript transforms in the new
    shape, and shows which shape the current code is in. Existing transforms open
    with their own saved code, unchanged.
  - Python is unchanged and stays that way on purpose: its harness writes the `def`
    itself, so a Python transform never states a signature, and a new field there
    costs one generated line rather than a migration of everybody's pandas code.

## 0.21.0

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

## 0.20.0

### Minor Changes

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

## 0.19.0

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

## 0.18.0

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

## 0.17.0

### Minor Changes

- d3336f3: The activity list stops shipping every event payload it never draws

  `GET catalog/events/traces` answered the console's default page with **10.46 MB**
  of JSON, and the screen re-asks every ten seconds. 4.31 MB of that was
  `catalog_audit_event.detail` — the event payloads — read from the database,
  parsed into 28,105 objects, serialised again, and then not drawn: the list
  renders a waterfall, which needs when each event happened and whether it failed,
  and the payload is read only when somebody expands a trace.

  The shape of the data is why it is so lopsided. A page carries every span of
  every trace on it, which is deliberate — a trace shown with only the spans a
  filter hit is a story with the middle torn out. But on the dev trail a trace
  averages 452 events and the widest carry 1,992, so a 50-trace page is 28,105
  spans, or 22% of the entire audit table, to draw 50 cards.

  So the list now selects the two fields grading actually reads —
  `$.error` and `$.status`, extracted in the database — instead of the payload
  they come from, and `getTrace` keeps carrying the payload for the one trace a
  reader opened. `CatalogTraceSpan.detail` is therefore optional: present from
  `getTrace`, absent from `listTraces`.

  Nothing on the screen is poorer for it. Every step is still listed, in order,
  with its timing, its error and the card's error banner; `failed` and `error` are
  derived by the identical rule on both paths, which a db spec holds by grading
  the same trace through each and comparing span for span. Expanding a card
  fetches the trace that has the payloads, so the one line per step that
  summarises one is unchanged — it just arrives when it is looked at. A host whose
  client predates `getTrace` keeps a working steps pane, one line per step poorer.

  Measured through the store against a real trail of 127,835 events, minimum of
  three runs: the default 50-trace page 10.46 MB → 6.07 MB and 3,807 ms →
  3,149 ms; the 25-trace page 3.19 MB → 1.86 MB and 1,283 ms → 915 ms;
  `outcome=failed` 1,774 ms → 1,557 ms; `getTrace` unchanged at 229 ms. Those
  absolute timings are a `db.t4g.medium` reached over a WAN and do not transfer,
  but the bytes do.

  `minor`, not `patch`: `CatalogTraceSpan.detail` becomes optional and
  `CatalogClient` gains `getTrace`. Published shapes changed, so a consumer
  dereferencing a list span's payload has to guard it.

## 0.16.0

### Minor Changes

- 8b21b7d: A batch replace reads its batch instead of scanning the table

  A deployment's query log had one statement at **821 seconds**:

  ```
  DELETE FROM obj_subwo WHERE _snapshot_id = ? AND _batch = ?    821021 ms
  DELETE FROM obj_util  WHERE _snapshot_id = ? AND _batch = ?    612990 ms
  SELECT COUNT(*) AS total FROM obj_subwo WHERE _snapshot_id = ?  15213 ms
  ```

  Every `obj_*` table was created with one secondary index, `ix_snapshot
(_snapshot_id)`, and the statement that replaces a batch names two columns.
  Every row of a snapshot carries the same `_snapshot_id`, so that index narrows
  nothing — and MySQL, correctly, **declines to use it and scans the whole table**,
  taking row locks the whole way. Thirty batches per load, on a 313,833-row
  snapshot, with the API on the same database waiting behind the locks.

  Measured on MySQL 8.0 with 300,000 rows in one snapshot and 30 batches
  (`write-path.db.spec.ts`), replacing one 10,000-row batch:

  |      | before                               | after                        |
  | ---- | ------------------------------------ | ---------------------------- |
  | plan | **no index**, ~296,500 rows examined | `ix_snapshot_batch`, ~19,100 |
  | time | 248ms                                | 90ms                         |

  The 90ms that remain are removing 10,000 rows, which is the work the load asked
  for. The scan is what has gone, and with it the row locks it held across the
  whole table. On a warm local container with nothing else running the wall-clock
  gain is 2.8×; on the contended table above, where the cost _is_ the scan and the
  locking, it should be far larger — but that is a prediction and only the plan is
  measured here.

  **The load-bearing half is the evolution path, not the `CREATE TABLE`.** The
  index only ever appeared inside `CREATE TABLE`, and nothing added indexes to
  tables that already existed — so changing the DDL alone would have fixed no
  deployment that has ever run this package. `ensureType` now checks
  `information_schema.STATISTICS` and adds the composite where it is missing,
  beside the reserved-column path that already existed for exactly this reason. It
  runs on the first write to each table after boot, not at boot: boot does not know
  which types exist, and the pod that needs the index is the one about to write.
  InnoDB builds it in place without blocking DML — 1,010ms for 300,000 rows here,
  once.

  A failure there is a **warning, not a throw**, and the asymmetry is the argument:
  a missing column makes the next INSERT fail, so evolving it is a correctness
  repair; a missing index makes it slow. Refusing the load would turn a performance
  problem into an outage on a deployment whose database user may simply not hold
  ALTER. The log names the statement to run by hand.

  New tables get `ix_snapshot_batch` **instead of** `ix_snapshot`: a composite
  leading on `_snapshot_id` answers every snapshot-only lookup as a prefix match —
  confirmed, not assumed, by dropping `ix_snapshot` and checking that both the
  snapshot count and a page of rows still plan onto the composite at the same cost
  — and a redundant index is not free on a table whose ingestion pattern is
  delete-and-reinsert. Existing tables **keep** `ix_snapshot`: adding an index is
  recoverable and dropping one is not, this package does not otherwise remove
  anything from a table it did not create in this process, and the log says it can
  go.

  `schema.changed` gains an optional `addedIndexes`, so a table that acquires an
  index appears in the audit trail as the real event it is rather than as a
  column-less one. Additive, and separate from `addedColumns` because an operator
  asking when a column appeared must not get an index name back.

  **Staging a batch is now one statement.** `writeStage` read the row before
  writing it, and the deployment's N+1 list had that `SELECT` at 29 executions per
  request. The key is computed in the method from three arguments, so the read only
  ever chose between two writes that end in the same row. It is an upsert now, and
  the replace-not-append guarantee is _strengthened_: read-then-write is two
  statements with a gap, so two attempts at one batch could both read nothing and
  both insert; `ON DUPLICATE KEY UPDATE` makes it a property of one statement.
  `createdAt` stays out of the merge — a retry is not a new batch.

  **Deliberately not changed: the per-batch `SELECT COUNT(*)`.** It was the
  suspect, and the numbers say it is second-order — 15s against 821s in the
  deployment's own log, and 65ms against 248ms here. The composite does not improve
  it (it already had an index it could use), so removing it would mean accumulating
  `rowCount += inserted - deleted` in Node instead of counting the table. That
  trades an exact number for arithmetic, and that number feeds `refuseRowCountDrift`
  — the bound that stops an empty load replacing a live dataset. Not a trade worth
  making for the third-largest cost on the path, and it is written down here so the
  next person does not have to re-derive the decision.

  **Also deliberately not changed: the batched `DELETE`/`INSERT` pairs** that a
  query profiler flags as N+1. They are the delete-and-reinsert ingestion pattern
  working as designed, one per batch by construction; the profiler is counting them
  per request. Nothing to fix.

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

- 90a219d: Staged batches are written columnar: each key-set once per batch, not once per row.

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

- 2d543ef: Adopted graphs stop drawing their boxes on top of each other, a connection can be cut by clicking
  it, and "Save first" now comes with a way to save.

  ## The nodes were four pixels too close, and the number was derived from nothing

  Opening any of the thirteen adopted workflows in the dev deployment drew every box glued to the
  next one. Nothing was stacked and nothing was missing, which is why it read as ugly rather than as
  broken and survived until somebody opened all thirteen.

  `adoptConnector` lays a pre-workflow connector out as a graph, and it placed its columns **220**
  apart. A node is **224** wide. So each box overlapped the next by exactly four pixels — and a
  connector that had a transform got the three-node shape, which collides twice and pinches the
  middle box from both sides.

  The interesting part is not that 220 was too small. It is that 220 had no relationship to anything.
  The width lived in `packages/react/src/workflow/graph.ts`, where the server could not see it, so
  the writer of the layout had nothing to derive from and picked a number that was correct only by
  luck. Raising it to 240 would have been the same bug with more slack.

  So the geometry moved to core, where both sides already depend on it:

  - `WORKFLOW_NODE_WIDTH`, `WORKFLOW_NODE_HEIGHT`, `WORKFLOW_COLUMN_GAP`, `WORKFLOW_ROW_GAP`
  - `workflowColumnX(column)` and `workflowRowY(row)`, which every generator of a layout now goes
    through instead of multiplying by a literal

  Exported from both the package root and `/client`, because the two things that have to agree are a
  store and a browser component.

  `WORKFLOW_NODE_WIDTH` is not a description of the node — it is the **source of** the node's width.
  `WorkflowNodeBody` sets its own width from the constant rather than from a `w-56` class, so there is
  one number and no way to restyle the box without moving the columns with it. The react package's
  `NODE_WIDTH` / `NODE_HEIGHT` keep their names on the `/workflow` entry point and are re-exports.

  The test is the overlap itself rather than the coordinates: `x[n+1] - x[n] >= WORKFLOW_NODE_WIDTH`,
  on both the two-node and the three-node shapes. Pinning `{x: 320}` would pass just as happily on a
  node 400 wide.

  ### Graphs already saved with the old positions

  **They do not fix themselves, and nothing repositions them behind anyone's back.** A stored graph
  whose nodes are 220 apart has distinct positions, so `layoutIfUnarranged` correctly reads it as
  "somebody arranged this" and leaves it alone — which is the right rule, because the alternative is a
  canvas that silently rearranges a layout a person deliberately built. Re-adopting will not help
  either: adoption is idempotent by design and skips anything that already has a `workflowId`.

  Fixing the thirteen that exist means rewriting their positions through `POST workflows`, which takes
  the whole graph back. New adoptions are correct from here.

  ## Clicking a connection offers to remove it

  `onDisconnect(edge)` has been wired since the wiring menu landed; what was missing was the gesture.
  Every route to it went through something else — a menu hanging off a node, a row in the wiring rail,
  or knowing that a selected edge answers to Delete — and the thing people reach for first is the
  connection itself, which did nothing.

  Edges are now this package's own type (`workflow/edges.tsx`) rather than the built-in `smoothstep`.
  Selecting one puts a round × above its midpoint, and pressing it removes that connection.

  - **Selection, not hover.** Hover would be slightly quicker with a mouse, unreachable without one,
    and would put a delete button under the pointer of somebody merely tracing where a line goes.
  - **The keyboard gets all of it, by two routes.** React Flow makes an edge focusable, and Enter or
    Space selects it — at which point the × is an ordinary `<button>` in the tab order, with an
    accessible name that says which connection it removes _in the words on the canvas_: "Remove the
    connection from Feed to Out", never the node ids. And the wiring rail's Disconnect row is
    untouched, so nobody has to go near the canvas at all. Both halves are held by tests, so neither
    can quietly become the only one.
  - The × deselects the edge before removing it, so an id reused later by a rewired pair does not come
    back already carrying a delete button nobody summoned.

  ## Nodes and edges, generally

  Per-kind colour is now three coordinated tokens rather than one accent bar — a tinted header strip,
  the icon and the kind word — because four kinds distinguished by four pixels of colour are not
  distinguished at the zoom people work at. `transform` moved to violet so it stops reading as a
  second `source`. Every token has a `dark:` counterpart.

  Nodes lift on hover and ring deeper when selected; handles grow under the pointer; edges thicken
  when selected and take a rounder corner. Nodes spring in on mount, and the × springs in and out.
  While a run is in progress the edges leaving the node that is _running_ flow — the one thing a
  picture can say about a run that a list of statuses cannot.

  **Nothing is revealed by an animation.** Under `prefers-reduced-motion` the × is mounted by the same
  selection and simply arrives without the transition, nodes are simply there, and no edge is marked
  `animated` — React Flow's flow animation is a keyframe in its own stylesheet, so declining to set
  the flag is the only honest accommodation. Nothing is lost by it: a running node still spins its own
  badge and says "Running now.", and the run panel still lists every step. `flowingEdgeIds` is where
  that decision lives, as a value rather than a branch in a render, and it is tested in both states.

  `@dudousxd/nestjs-catalog-react/workflow` now needs `motion` as well as `@xyflow/react`. Both are
  optional peers of the package and both are required by this subpath — a host mounting a node canvas
  is already installing a graph library, and one that wants neither wants the root entry point.

  ## "Discover schema — Save first" now comes with the save

  Reported as _"ué mas ta desabilitado não vejo nada"_ — it is disabled and I cannot see anything.

  The refusal is correct and unchanged: discovery reads the **stored** node, so with unsaved edits it
  would describe the source as it was before them. What was wrong is that the sentence lived inside a
  side sheet and the Save button lived in the header behind it, so a reader was told to do something
  with no way to do it where they were standing.

  `SchemaDiscoveryPanel` takes an optional `onSave` and `saving`, and renders a "Save now" button
  beside the refusal when there is one — plus a line saying that saving stores a draft and does not
  publish, carrying the same care the `!draft.id` reason already takes, because publishing is a
  different and much louder thing on this screen.

  The other half of that report was worth checking rather than assuming: is `dirty` honest? It is —
  `draftFrom` sets `dirty: false` even though it runs `layoutIfUnarranged` on the way in, because a
  derived layout re-derives identically next time and there is nothing to save. There are now tests
  that opening a workflow and touching nothing leaves discovery offered, including for a graph the
  server sent with no positions at all, which is the case a future layout change is most likely to
  break.

  ## The × was painted under a node, and the test that "covered" it could never have said so

  Reported as _"Cliquei na linha e não aparece um x em cima pra deletar"_ — I clicked the line and no
  × appears above it to delete. It was there. It was 38×38, fully opaque, correctly labelled, and
  414px to the left and 42px above its own line, directly underneath the first node — so
  `elementFromPoint` at its centre returned that node's header, not the button.

  The cause is a rule about Motion that is easy to walk into: **an element Motion animates a transform
  component of no longer owns its own `transform` property.** The control set
  `transform: translate(-50%, -140%) translate(Xpx, Ypx)` in `style` _and_ animated `scale`. Motion
  composes the whole property from the values it is animating and writes the result every frame, so
  the hand-written translate was overwritten — and at rest, with `scale: 1` and nothing else to
  compose, what it wrote was `transform: none`. The button landed at the untranslated origin of
  `.react-flow__edgelabel-renderer`, which is the top-left corner of the graph.

  The placement and the animation are now on two elements: a plain `<div>` carries the translate and
  Motion never touches it, and the `motion.div` inside animates opacity and scale about an origin that
  is already correct. The outer element stays mounted whether or not the × is offered, because that is
  what `AnimatePresence` needs in order to still play the exit.

  The more useful part is the test. `workflow-edge-delete.spec.tsx` had five tests over this control
  and **all of them passed the whole time it was unreachable** — they asserted that it existed, what it
  was called, and what pressing it did. So there is now one that reads the inline transform of the
  positioning element after the animated child has mounted, and a comment saying why that property and
  not a rect: jsdom lays nothing out, every element in it is 0×0, and a `getBoundingClientRect`
  assertion would have agreed with the broken placement just as readily as with the fixed one.

  ## Wiring is click, click — no drag required

  Asked for as _"invés de clicar e arrastar, queremos clicar na pontinha, aí já aparece a linha ta
  ligado e aí é só clicar no outro"_. Click a handle, see the line, click the other end.

  React Flow's `connectOnClick` was already on, and it already connected — but it draws **nothing**
  while the connection is open, because the connection line renders from `connection.inProgress` and
  that flag is only ever set by the pointer-drag path, past a 1px threshold a click never crosses. So
  the gesture worked and looked exactly like a dead click. It also cannot explain itself: the state it
  hands `onClickConnectEnd` after a click carries no target, so an illegal pair and a missed click
  were indistinguishable.

  So the click path is owned by the new `workflow/wiring.tsx` and `connectOnClick` is off, which keeps
  one state rather than two disagreeing about whether a wire is in flight:

  - a dashed, travelling line follows the pointer from the handle that was clicked, drawn into
    `ViewportPortal` so it stays registered with the graph while somebody pans or zooms mid-gesture
  - either end starts it. Clicking a sink's input first draws the wire backwards until it lands, which
    is the right affordance for somebody thinking "this needs feeding"
  - while a wire is open every handle says whether it can take it — green where it can, faded almost
    out where it cannot — which is the same judgement the drag has always shown on the one handle
    under the cursor, shown on all of them at once because a click has no "under the cursor" moment
  - **a refusal is a sentence on the canvas**, not silence. A loop, a duplicate, or anything else
    `canConnect` refuses now says so in a panel over the graph, and the wire stays in hand so
    correcting it is one more click rather than a restart
  - Escape, the pane, and clicking the same handle twice all put it away

  **Dragging is untouched.** It is React Flow's pointer-down path, it still validates through the same
  `isValidConnection`, and it still colours the handle under the cursor. This adds a way in; it removes
  none. Every rule still comes from `canConnect` — the one the drag, the wiring menu and the
  inspector's picker are all refused by — so there is no second copy of "nothing runs after a sink" to
  drift.

  A handle is now a control, so it says so: `role="button"`, in the tab order, and operable with Enter
  or Space. React Flow renders a handle as a plain `<div>`, so none of that is inherited.

  ## Prettier, where it changes what you can see

  The selected connection gets a soft halo behind the line, in the same variable the stroke uses, so
  selection reads at the zoom people actually work at instead of being a 1px thickening. The kind rail
  down the left of a node is a gradient rather than a flat fill — at 4px wide and full height, flat
  reads as a printing error. Nodes lift a little further on hover; the controls and the minimap are
  rounded and lifted so they read as panels on the canvas rather than as chrome bolted to it.

  `prefers-reduced-motion` remains the fallback and not the ceiling: the travelling dashes hold still,
  the pulse on an open handle is `motion-safe:`, and the wiring hint arrives without its spring. In
  every case what is left is the colour and the position, which is where the information was.

## 0.15.0

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

- 688becb: Stream the CSV export, and stop a cell in it executing when somebody opens the file.

  `GET saved-queries/:id/export.csv` ran the query, held the result, built the whole CSV string and
  then answered. That is the same shape that stopped a 981,469-row connector load ever finishing, and
  it is worse on an export, because an export has no row cap by design: the point of it is to take
  everything.

  - **Rows are written to the response as they arrive.** `CatalogQueryStore` gains an optional
    `streamQuery`, `csvLines` turns an async row source into CSV a line at a time, and the handler
    returns a `StreamableFile` over it. `@Res({ passthrough: true })` is unchanged and still correct —
    what changed is the returned value, because the express adapter answers a _string_ body with
    `res.send()`, which sets a `content-length` on a body nobody has counted. The response is now
    chunked and carries none. Back-pressure runs the whole way: the pipe stops when the socket is full,
    the readable stops pulling, and the generator stops asking the store — so a slow client slows the
    database read rather than filling this process. A client that abandons the download tears the
    readable down, which runs the generator's `finally`.
  - **The export is no longer capped or cached** on a store that streams. `maxQueryRows` bounds a
    screen's page; a capped export is a prefix handed over as a complete file. The cache is skipped in
    both directions — it holds a capped page, and filling it from an export would put the whole result
    in the object the cache exists to avoid. No statement timeout is applied either: an export of a
    large table legitimately runs for minutes, and the bound that matters for it is that no stage holds
    more than a row.
  - **`MySqlWarehouseStore` implements `streamQuery`**, on MikroORM v7's Kysely-backed
    `connection.stream()` inside a real `READ ONLY` transaction handle — passing the handle matters,
    since a stream executed on some other pooled connection would be protected by nothing. The rollback
    is in the generator's `finally`, so it runs when a consumer stops early. `FanoutCatalogStore`
    forwards it when its primary has it; `RoutingCatalogStore` forwards it per environment.
  - **A store that cannot stream keeps the capped buffered read**, and the truncation is logged.
    Lifting the cap there would not make the export complete, it would move the failure into a driver
    that has no cap to report. `ClickHouseWarehouseStore` is in this group today.
  - **A cell whose value would be read as a formula is neutralised.** `=`, `+`, `-` and `@` all start
    an expression in Excel and Sheets, including through leading blank the importer strips first and
    including a leading tab or carriage return, and the values here come from whatever the queried
    source contained. Such a cell is prefixed with `'`. **A value that is plainly a number is exempt**,
    so `-42` still reads back as `-42` for a machine: a spreadsheet evaluates `-42` to the number it
    already was, so there is nothing there to defend against, and the apostrophe is a real cost —
    outside a spreadsheet the cell now carries a character the database did not have. The guard runs
    before the CSV quoting, so a value that needed both comes out as `"'=1+1,x"`, escaped once.

  `toCsv` keeps its name, its signature and its bytes, and moves from `catalog.query-cache` to
  `catalog.csv` alongside `csvLines`, `csvCell` and `guardFormula`; the package entry point exports all
  four. Its output changes only where the formula guard applies.

- e21d113: Workflow templates: the graphs people actually draw, with the decisions already made.

  Thirteen types were loaded into a dev catalog in one evening by hand-building one pipeline per
  type. Six came out with **every renamed column 100% null** — `Subwo` has 313,833 rows and 73 of its
  84 columns empty. Nothing caught it: the loads committed, the row counts were right, the runs were
  green. The same wrong decision about property naming was simply made six times, because it was
  being re-derived per type by somebody trying to get data in.

  So a template here is not sugar. It is the place a decision that is easy to get wrong is made once,
  by somebody who thought about it, and written down where it gets reviewed. Every template states
  what it **assumes** and what it **declares** on the operator's behalf, and both travel with the plan
  so a screen shows them rather than burying them.

  ## The five that shipped

  - **Replicate a table** — SQL straight into a type. Two nodes and one edge, and the entire value is
    the refusal described below.
  - **Load a file drop** — a CSV/NDJSON/JSON drop from a path or a bucket. Structurally the same and
    separate on purpose: a spreadsheet header is the likeliest place to meet a column headed with a
    year.
  - **Fan one source into several types** — one expensive read, a transform _per branch_, a sink per
    type. Per branch because both successors of a source read the same rows, so one shared transform
    would commit identical wide rows into every type.
  - **Join two sources into one type** — two reads joined inside one transform.
  - **Enrich against a lookup table** — the same graph and the same code with one flag flipped, and
    it is a separate template because that flag _is_ the decision: an unmatched row is kept when
    enriching and dropped when joining. Dropping it from an enrichment means a load silently loses
    every record the dictionary has not caught up with — a run that succeeds, reports a plausible
    count, and is missing data.
  - **Periodic full reload** — a full read on a schedule, with the matching `periodic-full-reload`
    declaration derived from the **same** cadence, so the two cannot disagree.

  ## The naming problem, and why two templates refuse rather than guess

  The warehouse matches records to properties **by property name** — `row[property.name]`. So on a
  graph with no transform on the path, where a record arrives keyed by the source's own spelling, the
  property has to be named that spelling exactly. `columnName` is display metadata and is never a
  lookup key, so recording the source's spelling there redirects nothing.

  That used to make an entire class of columns unloadable, because the name was also written verbatim
  as the view's output column and as the alias of every read, both through `ident`, which refuses
  rather than escapes. `Asset Id` could be neither kept (publishing refused the name) nor renamed to
  `Asset_Id` (the record still arrives keyed `Asset Id`, the store asks for `Asset_Id`, gets
  `undefined`, and writes null into every row of every run while reporting success). The second is the
  naive fix and is exactly what produced the six null types.

  **`fix/view-alias-sanitised` has since landed and closed the first door.** Both alias sites go
  through `outputAlias`, so a property keeps the source's spelling end to end: `Asset Id` is a
  perfectly good name, lands in `Asset_Id`, and reads back as `Asset Id`. `Asset LIN/TAMCN` likewise.
  These templates no longer refuse them — doing so would send an operator off to perform the exact
  rename that caused the incident.

  **What survived is narrower and is still a trap.** The publish-time refusal asks whether a name
  _cleans_ to an identifier, not whether it is one, and a name can still fail that: `2024 Total`
  cleans to `2024_Total`, and no store will quote a column starting with a digit. For those columns
  both doors are still shut in the old way. So "Replicate a table" and "Load a file drop" still
  **refuse**, on precisely that set, and name every offending column together with what it cleans to.
  The check is `isSafeIdentifier(physicalColumn(name))` — the same two calls, in the same order, that
  the publish-time refusal and the DDL make.

  A column list nobody has discovered is _also_ still a refusal. That set shrank and did not empty: an
  undiscovered `2024 Total` still ends as a property renamed to `2024_Total`, loading null into every
  row and reporting success. Proceeding on silence is asserting the names are fine because nobody
  looked, which is how the six were built.

  ## What every template obeys

  - **It does not hide the decision.** A plan is plain nodes, edges, transform bodies and expectation
    payloads — no template object survives into the saved workflow, and every declaration carries a
    `changeAt` saying where to undo it.
  - **It does not claim a mode it cannot justify.** Nothing offers `incremental`: it is refused
    outright without a delete declaration and needs a watermark column no template can know.
  - **It does not restate a list.** Source kinds are a `Record` over `ConnectorKind`, starter code a
    `Record` over `TransformLanguage`, node construction a mapped type over `WorkflowNodeKind`. A kind
    or language added to the library without a line here is a compile error, not a template that
    quietly stops covering it.

  The templates are shipped by the library rather than stored per deployment, deliberately: they are
  decisions, and decisions belong in code where they are reviewed and carry their reasoning.
  Per-deployment templates are a store concern and a separate change.

  ## Also here

  The whole naming rule — `isSafeIdentifier`, `assertSafeIdentifier`, `UnsafeIdentifierError`,
  `physicalColumn` and `outputAlias` — moved into a dependency-free `catalog.identifiers.ts` and is now
  exported from `@dudousxd/nestjs-catalog/client` as well as the package root. It used to sit in
  `catalog.store.ts`, which imports `@nestjs/common` at module scope, so a browser could not reach any
  of it without dragging NestJS along — and a canvas that answered "can this be a property name?" from
  its own copy of the pattern would be a fresh definition of a rule whose own docblock says one
  definition is the guarantee and two identical ones are a habit.

  `physicalColumn` had to travel with `isSafeIdentifier` rather than being left behind, because the
  question a publisher is refused on is the _composition_ of the two. A browser holding only half of it
  would answer the obsolete, stricter question and refuse graphs the server would accept.

  Every existing import path still works; `catalog.store.ts` re-exports all five.

  ## Not shipped

  Reading an already-published catalog type as a source — to build a derived or aggregate type — is
  **not reachable**. `CONNECTOR_KINDS` is `http`, `sql`, `file`, `s3`, `inline`, and none of them reads
  the catalog's own warehouse. It is the natural next template and it needs a connector kind first.

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

## 0.14.0

### Minor Changes

- 220918f: Filter a type by its own columns, and read it as of an earlier load

  The object explorer offered paging, a search box and a sort. Two things it did
  not offer are now here, and both are derived rather than configured.

  **Filters come from the type.** `GET objects/:name` now answers with
  `filterOperators` on every column — computed from the column's own scalar type
  by `filterOperatorsFor`, then narrowed to what the mounted store declares it can
  apply. Nothing anywhere lists a filterable column, which matters because these
  types are created at runtime by `PUT publish/:type/schema`: a column published
  this morning is filterable this morning, with no list for it to be missing from.
  `?filter=property:operator:value` may be repeated, and a range is `gte` and
  `lte` on one property. A filter is resolved against the type before any store
  sees it and carries the property _definition_, so a caller's string is never a
  column name; a filter that cannot be honoured is refused by name rather than
  dropped, because a dropped filter comes back as an unfiltered page presented as
  the matching rows. Classified columns take no filters at all — a range filter
  lets a reader binary-search a value they may not see.

  **A store says whether it filters.** `CatalogFilteringReadStore` +
  `supportsObjectFilters`; the MikroORM read store and the MySQL warehouse store
  declare all nine operators. A store that declares none offers no controls and
  refuses a filter rather than answering unfiltered.

  **And a snapshot picker.** Every earlier load is still in the type's physical
  table — the machine for time travel was already built and nothing exposed it.
  The explorer now lists a type's loads and reads as of one, defaulting to
  current, saying unmistakably when it is not, and never touching the SQL view the
  query console selects from. `CatalogReadResult` and the object page carry
  `{ id, current }` from the store, so the warning is driven by what was read
  rather than by what the screen believes it asked for.

## 0.13.0

### Minor Changes

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

## 0.12.0

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

## 0.11.0

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

- f2f5d7c: Credentials can be encrypted before they rest in the catalog's own tables

  The redaction stopped a connection password travelling in an HTTP response. The
  refusal stopped a new one being written. Neither does anything for the reader
  this is about: a database dump, a read replica, a nightly backup, or anybody
  holding `SELECT` on the instance. For them `catalog_connection.config` was a
  list of every password the catalog knew — and `allowInlineCredentials` enlarges
  that population on purpose, which is why this is worth building now.

  **`CatalogSecretVault`, a seam and not a cipher.** There is no encryption in
  this library and there must not be: shipping AES with a key from an environment
  variable moves the problem from one column to one variable, and leaves this
  package answering for key rotation and per-environment separation that the
  host's KMS or Vault already answers for. Bind `CATALOG_SECRET_VAULT` — to one
  vault, or to an array of them, which is what lets a key rotation happen without
  an outage: the first seals, and any of them may open, matched on the `vault`
  name every row carries.

  **The default refuses.** Unbound, `RefusingSecretVault` throws on `seal` naming
  the token. A default that quietly stored plaintext would make
  `encryptCredentials: true` a no-op with a reassuring name — saves would succeed
  and the column would be exactly as it was.

  **`encryptCredentials`, and how it composes with `allowInlineCredentials`.**
  Four combinations, three meanings, and no fourth: sealing runs _before_ the
  refusal is asked, so a sealed credential is an object by the time anything looks
  for a password-bearing string. `false/false` refuses (unchanged, and the
  default). `false/true` and `true/true` seal. `true/false` is the deliberate
  dev-environment plaintext trade the flag already documented. The combination
  worth naming is `allowInlineCredentials: false, encryptCredentials: true` — it
  reads like a contradiction and is the one a production deployment wants.

  **The store opens on every read**, whatever the flag currently says, so turning
  encryption off keeps existing rows readable rather than being a data-loss
  button. It also means nothing downstream learns that a vault exists: `fetchSql`
  still gets a URL, and — the sharper reason — `restoreRedactedSecrets` still
  gets a string to compare against. Had reads handed out ciphertext, the console
  round trip would have written the literal `REDACTED` over the credential, which
  is the classic way a fix of this shape corrupts what it protects. **The
  redaction is unchanged and stays**: it defends against `catalog:read` over HTTP,
  sealing defends against `SELECT` on the database, and dropping either because
  the other exists gives that attacker the password back.

  **What is sealed** is what the refusal already recognises — a top-level string
  that parses as a URL carrying a password — and not the whole `config` object.
  One predicate, two consumers: seal something the redaction does not hide and a
  console renders a ciphertext blob; hide something this does not seal and the
  column still holds the password. Sealing everything would also blind the
  refusal, which needs a string to inspect.

  **Rows already holding plaintext** are sealed on their next save and not before.
  No read-through-reseal — a read that writes can fail a connector run for a
  bookkeeping reason, and these rows are read on the runner's hot path — and no
  one-shot migration in this release. The column takes both forms indefinitely,
  `isSealedSecret` tells them apart, and a migration written later needs no schema
  change.

  **A vault that is down fails a save, and fails a read _retryably_.** A save that
  cannot seal writes nothing; there is deliberately no catch that logs and stores
  the plaintext, because a deployment that did that during an outage would have no
  way afterwards to find out which credentials went in clear. A read that cannot
  open throws `SecretOpenFailedError`, which is pointedly **not** a
  `BadRequestException` — `ConnectorRunSteps` catches that class and converts it
  to a non-retryable `connector_unavailable`, so a five-second vault blip would
  have become a load that never ran and an operator hunting for a connector nobody
  deleted. It is fatal only when waiting provably cannot help: nothing bound,
  nothing bound under the row's vault name, or the vault's own error saying so.

  **`saveWorkflow` refuses and seals a source node's credential too.**
  `WorkflowSourceNode` promised "credentials stay out of the catalog here exactly
  as they do everywhere else" and nothing enforced it: the graph was written
  verbatim, and the workflow runner spreads `node.config` into a synthesised
  connector, so `fetchSql` read `config.url` from there exactly as it does from a
  connector's. Same predicate, applied per node; grandfathering compares per node
  id, so renaming a graph does not refuse over a credential nobody touched. The
  graph fingerprint is taken before sealing, so a non-deterministic ciphertext
  never registers as a new version.

### Patch Changes

- 7e8d541: The canvas can see what a draft is, and stops promising a refusal that no longer happens

  `WORKFLOW_STATUSES`, `WorkflowStatus` and `isWorkflowStatus` are exported from
  the client entry point, alongside the node kinds and issue codes already there
  and for the same stated reason: an editor that cannot see the vocabulary
  restates it, and the copy is what drifts.

  The Save tooltip said "the server will refuse the graph". That was true before
  drafts and is now wrong in the case it fires most often: saving an unfinished
  graph **succeeds** — it is stored as a draft, which is the whole point. The
  refusal moved to publishing. A hint that still promised one would be
  confidently wrong, which is worse than saying nothing.

## 0.10.0

### Minor Changes

- 42f3441: The curation trail can finally name who.

  `type.curated` fires whenever somebody renames a column, changes a unit, hides a property or sets a
  classification, and its own docblock justifies its existence: _"who renamed this column and when is a
  governance question, and the answer is otherwise nowhere."_ Its payload carried `typeName`, `property`
  and `changed` — so it answered _when_ and _what_, and never _who_. `overlay.reset`, added last
  release for the catalog-wide revert, shipped with the same hole and a docblock explaining it as a
  limit rather than a decision.

  Two things made that worth fixing rather than documenting. `query.shared` and `dashboard.shared`
  have named their actor since the day they were added, so the trail was inconsistent in a way that
  reads as a bug in whichever half you look at second. And curation is the one act this library
  describes as surviving the publisher's next deploy — a decision that outlives deployments and could
  not name its author.

  **Both events now carry `principalId`**, threaded from the route that resolves a principal down to
  the registry that emits. It holds the whole `CatalogPrincipal.id`, composite half included, matching
  `query.shared`: `parsePrincipalId` recovers the application from an `<app>#<person>` id, so nothing
  is lost by carrying the person, while dropping to `applicationId` would file a curator's decision
  under the console they signed into. It is spelled `principalId` and not `curatedBy` because that is
  the key `CatalogAuditRecorder` lifts into the audit table's indexed column.

  ## 💥 Breaking: `CatalogRegistry` takes the actor

  `patchType`, `patchProperty` and `resetOverlay` each take the acting principal's id as a new, final,
  **required** argument.

  - **Your call sites need it.** `registry.patchType(name, patch)` becomes
    `registry.patchType(name, patch, principal.id)`; `patchProperty` gains a fourth argument and
    `resetOverlay` a first. The compiler names every one. `CatalogService`'s three forwarders take it
    too, so a host that wrote its own controller against the service is updated the same way.
  - **Your subclasses keep compiling, and that is the part to check by hand.** TypeScript lets an
    override take fewer parameters than it promised, so a registry of your own that still declares
    `patchType(typeName, patch)` is a legal implementation and will not be flagged. What _will_ fail
    to compile is its emit: `CatalogEventPayloads['type.curated']` now requires `principalId`, so any
    implementation that emits its own curation event has to have one to put there. Add the parameter
    and pass it through.
  - **Required rather than optional, deliberately**, on the argument `CatalogService.deleteSavedQuery`
    already makes about its own `deletedBy`: a default quietly attributes the act to nobody in every
    caller that was not updated, and naming somebody is the entire value of the record.
  - **No value is ever empty.** A producer with no principal in hand emits the exported
    `UNATTRIBUTED_PRINCIPAL_ID` (`"unattributed"`) via the exported `curationActor()`. The recorder
    writes a falsy actor as NULL, and NULL in that column reads as "nobody did this" rather than "this
    was not captured" — and an unauthenticated mount gets `"console"` from the controller, the same
    fallback the sharing routes use, which is the narrower and more useful claim.

  The emit stays inside each registry rather than moving up to the service or the controller. A host
  calling `patchProperty` from a migration script or an admin job would otherwise emit nothing, which
  would quietly redefine the trail as "curation that happened to go through the bundled controller" —
  the same class of gap the actor was missing from. The registries also know things the layer above
  does not: the stored one decides whether a patch landed on a column or a link, and only the in-app
  one can summarise the overlay it is about to destroy.

  ## The environment hop

  `RoutingCatalogRegistry` forwards these calls by hand, and it forwards the actor with them. This is
  the hop the field would have been lost at, and it fails differently from a dropped method: the patch
  lands, the response is a 200, the audit row is written — and its actor says `unattributed`, in
  exactly the multi-environment deployments that have a governance team reading the trail.
  `environment.routing.curation.spec.ts` asserts what the registry _behind_ the proxy received, because
  every other observable is identical whether the actor was forwarded or not.

  `StoredCatalogRegistry.resetOverlay` still refuses and still emits nothing, and it declares no actor
  parameter — accepting one would advertise a record it never writes.

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

## 0.9.0

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

- 01df149: Reverting every curation edit at once is audited too.

  `patchType` and `patchProperty` emit `type.curated`, on the argument that "who renamed this column
  and when" is a governance question with no other answer. `resetOverlay` discards every curated label,
  description, unit, order, hidden flag and **classification** in the catalog, needs the same
  `catalog:curate` scope, and emitted nothing — so the trail could name the person who renamed one
  column and not the person who reverted every name at once.

  Un-classifying a property this way is not cosmetic either: `visibleToPrincipal` filters search
  results on `classification`, so a reset silently re-admits every classified property's _name_ to
  searches by principals who could not see it a moment before.

  **New event: `overlay.reset`.** It could not be a `type.curated` — that payload leads with a
  `typeName` a recorder lifts into an indexed column, and a reset has no single one — so `CATALOG_EVENTS`
  gains a name, and every recorder and watcher that iterates that list picks it up with no change.

  What it carries is a **summary, not a copy**. The overlay is discarded rather than versioned, so what
  is not in the payload is nowhere, which argues for carrying all of it — and all of it would be a
  backup nobody designed, with no restore path and no retention policy of its own. So:

  - `typeNames` — every type that carried curation, because "was the work on `Dispute` in it" is the
    question actually asked six months later.
  - `properties` — how many per-property entries went with them, as one number. The property names are
    where the summary would become the dump.
  - `classifications` — every classification that stopped applying, with its value, in full. They are
    the one part of the overlay whose loss changes what the catalog shows to whom, they are a small
    subset of it, and re-typing them is the only recovery available.

  There is no `principalId`, and the absence is a limit rather than a claim that the actor does not
  matter: `resetOverlay()` takes no principal and the route that calls it resolves none, so the field
  would be empty on every row — which an audit table reads as "nobody did this" rather than "not
  captured". `type.curated` has the same gap; closing it is a change to the controller, the service and
  every registry.

  **`StoredCatalogRegistry` deliberately emits nothing.** It has no overlay — the published values _are_
  the stored values — so it still throws, and a refusal that wrote an audit row would claim a reset
  happened while the caller got an exception and every stored label stayed put.

  `InMemoryCatalogOverlayStore` no longer describes itself as being for "deployments that want the
  catalog strictly read-only". It never was: `save` accepts writes, `PATCH /catalog/types/:name`
  answers 200 and emits `type.curated`, and the edit is real until the process ends — but it lives in
  one process's heap, so replicas disagree about what a column is called. Read-only is the host guard's
  decision about the `catalog:curate` scope, not a store's, so the docblock now says what the store
  actually is: non-persistent, and single-process.

## 0.8.0

### Minor Changes

- 64a3b00: One search box across the whole catalog

  Finding anything in a catalog meant already knowing which screen it lived on:
  object types and their properties on Model, saved queries on Query, boards on
  Dashboards. At two hundred types that _is_ the experience, and the thing a
  person actually types is a word they half-remember.

  `GET /catalog/search?q=…` answers across four kinds in one call — object types
  (name, display name, plural, description, group), properties (name, display
  name, description, unit), saved queries (name, description, folder) and
  dashboards (name, description) — ranked as one list. `CatalogClient.search(term)`
  and `<CatalogSearch />` are the client half; the component takes the same
  `explorerHref` prop the model screen does, plus optional `savedQueryHref` and
  `dashboardHref`, and renders a row as a plain row rather than a dead link where
  the host mounted no screen for that kind.

  **The ranking is four named tiers, not a score.** `exact`, `prefix` and `name`
  for a match on what a thing is _called_; `text` for one in what somebody _wrote
  about_ it — a description, a group, a unit. Ties break by kind (type, property,
  saved query, dashboard) and then by label, so the same term always gives the
  same order. Every hit carries the tier and the field it matched, which is what a
  row shows instead of a number nobody can predict.

  **Results are filtered by the caller, which is a deliberate exception to this
  library's read path.** Every other read here applies no grants — the host wraps
  them, see the note above `mayWrite` in `catalog.principal.ts` — and that
  position does not survive a search box: a host can wrap a read whose subject it
  knows, and cannot wrap one whose result set is chosen by a stranger's typing.
  So `GET search` looks at `request.principal`, drops every type `mayRead`
  refuses **and its properties with it**, and drops every property whose
  classification the caller does not hold. The name is the disclosure in both
  cases — "there is a type called `PayrollAdjustment`" and "there is a column
  called `settlementAmount`" are answers, even with no row attached — and `total`
  is counted after the filter so the count cannot report what the rows do not.

  An absent principal filters nothing, and that is not a fail-open: in a
  deployment with no guard `GET /catalog` already hands over the whole snapshot,
  so search is exactly as open as the route beside it and strictly narrower the
  moment a principal appears.

  **What a hit does not carry:** no `sql`, no property list, no card layout —
  enough to draw a row and follow it. The matcher is not given a saved query's
  statement at all, so a search cannot become a code search and a fragment of SQL
  cannot end up in a dropdown.

  **Connectors and transforms are deliberately out.** They are served by
  `@dudousxd/nestjs-catalog-pipeline`, which this package does not depend on, and
  folding them into a route declared `catalog:read` would re-grant a surface
  carrying connection references and `secretEnvVar` under a scope their owner
  never agreed to. A console that wants them in the same box makes a second call
  against the pipeline's own routes, under the pipeline's own guard — which is
  honest about the fact that they are two permissions.

  Nothing is mounted for you: export `CatalogSearch` from
  `@dudousxd/nestjs-catalog-react` and place it wherever your shell wants a search.

- c90d9ea: One graph builder, not two.

  Relations shipped with the edge rule written twice: `MikroOrmCatalogRegistry` derives the ontology
  from ORM metadata, `StoredCatalogRegistry` reads it out of the database, and each had its own
  `linkKey` and its own edge loop, in different packages, under a comment asking whoever changed one to
  change both.

  A comment is not a mechanism, and this divergence would have been invisible. The rule is that a link
  declared at both ends produces ONE edge, paired by a key that survives the two ends having different
  property names, drawn from the end that holds the foreign key so the arrow points the way a join is
  written. A copy that regressed to keying on property name alone draws two edges for every ordinary
  foreign key — which is the bug this rule was written to fix, and the only place it shows up is a
  picture nobody diffs.

  `CatalogRegistry.getGraph()` is now **concrete** on the abstract class, built from the snapshot every
  registry already has to produce. Nothing about it ever varied, so there was never anything for a
  subclass to decide. Both registries drop their copy; the graph they serve is byte-for-byte what it
  was.

  For anyone implementing `CatalogRegistry` in a host: `getGraph` is no longer abstract, so a third
  registry gets the edge rule right without writing it. Overriding is still correct where a registry
  _delegates_ rather than derives — `RoutingCatalogRegistry` hands the whole call to whichever
  environment the request named — but deriving it a second time is not.

## 0.7.0

### Minor Changes

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

- baacf22: The ontology has links.

  `CatalogRelationDef` existed and the in-app registry read relations off the ORM, but the persisted
  catalog — the one a real deployment runs — answered `relations: []`, `stats.relations: 0` and
  `edges: []`, hardcoded. So two types could both be published and nothing recorded that one belonged
  to the other. The graph drew nodes and no lines.

  **Persisted.** `ObjectTypeRow` gains a `relations` column and a `mergeRelations()` that takes the
  structure a publisher sends and keeps the labels a curator wrote, the same rule properties already
  follow. A link the publisher stops sending is dropped, unlike a column: a column may still hold data
  in the warehouse, a link holds nothing, and keeping one the schema no longer has means the ontology
  asserts a join that will fail. Nullable, so rows written before this exist and read as no links.

  **Served.** The stored registry reports relations on the type, counts them in `stats` and in the boot
  line, and builds the graph. Nothing is guessed: there are no foreign keys in the warehouse, and a
  `base_id` column beside a type called `Base` is a strong hint and a bad edge.

  **One edge per link.** The graph de-duplicated relations by property name, which only catches the
  accident of both ends being spelled alike — `Mvr.base` with `Base.mvrs` is the ordinary shape of a
  foreign key and it drew two lines between the same pair of nodes. Links are now paired through the
  new `owner` and `inverseName` fields on `CatalogRelationDef`, and the surviving edge is the one that
  holds the key, so the arrow points the way a join is written.

  **A link whose target is not published** is kept on the type and marked with the new
  `targetPublished` — dropping it leaves a type looking less connected than it is — but draws no edge,
  because an edge promises a node the reader can open. `CatalogManager` no longer renders it as a
  button that silently selected an unrelated type.

  **Both directions on screen.** A type carries one row per link it declares, so a `@ManyToOne` left
  the target with an empty list and the catalog screen said nothing linked to or from it. The inbound
  half is now derived from the snapshot the screen already holds — nothing stored, nothing counted
  twice — and a link can be renamed in place through the existing property route. `FlowView` flags the
  links that cross a publisher boundary, or land on a type nobody has loaded.

  No new endpoints and no new decorator. A relation is a property to whoever is looking, so
  `@CatalogProperty` labels one and `PATCH .../properties/:name` curates one, in both registries.

  `CatalogRelationDef` gains four required fields (`owner`, `targetPublished`, `enriched`, and the
  optional `inverseName`). Code that constructs one by hand — chiefly test fixtures — has to fill them
  in; code that only reads relations is unaffected.

- 04f09a3: A type now says when its data was last committed

  A type whose publisher was deleted six months ago and a type loaded ten minutes
  ago produced byte-identical payloads. `CatalogObjectTypeDef` carried a name, a
  table and its properties, and nothing at all about the data — the only
  timestamps in the snapshot were `generatedAt`, which is when the MODEL was
  assembled, and `stats`, which counts types and properties. Every screen
  downstream inherited that blindness, and the failure is somebody reading a
  number off a type in June that stopped being updated in January.

  Nothing deletes a type when its publisher goes away, and that is deliberate: a
  failed deploy, a service that is down and a renamed entity all look like an
  absent publisher, and a lake that dropped data on that evidence is not a lake
  anybody trusts. But keeping the data and keeping quiet about its age are
  different decisions, and only the first was made.

  `lastCommittedAt`, `rowCount` and `lastPrincipalId` are filled from the newest
  COMMITTED snapshot per type — `committedAt`, not `createdAt`, because a load
  that was written and never committed is not what readers are served, and dating
  a type by one reports freshness that does not exist. One query for all types,
  not one per type: this runs on every reload.

  **Absent means never committed**, and that is a third state the old shape could
  not express. A schema published and never loaded is not a pipeline that stopped;
  the fixes differ, and collapsing them is how the second gets ignored.

  `rowCount` is there for a failure the timestamp cannot show: a connector that
  starts returning 12 rows where it returned 40,000 produces data that is wrong
  and _fresh_, so every staleness signal reports it healthy.

  The Model screen shows the age beside the table name, marks what has not
  committed in a week, and puts the count and the publisher in the tooltip. It is
  not a health verdict — the catalog cannot tell a deleted publisher from a
  monthly load, and a type labelled "orphaned" is a type somebody deletes on the
  strength of a guess. `freshnessOf` and `isWorthFlagging` are exported for hosts
  that want the same words elsewhere.

### Patch Changes

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

## 0.6.0

### Minor Changes

- f3cc527: Every catalog route says what it needs, and deleting a shared thing is recorded

  **Read this before upgrading if your guard enforces `REQUIRED_SCOPES`.** Routes
  that admitted any authenticated caller now refuse principals that do not hold the
  scope named below. That is the point of the change, and it will produce 403s on
  the day you deploy it.

  ## The declarations

  Only the three `embed` routes carried `@RequireScopes`. Everything else on the
  catalog controller declared nothing — which, per `catalog.route-auth.ts`'s own
  model, is not "undecided" but "authenticated is enough". So arbitrary SQL, both
  curation `PATCH`es, the overlay reset and every workspace write were open to any
  principal a host's guard let past the door, while `packages/pipeline` had
  declared its scopes on all 20 of its routes since it shipped.

  | Routes                                                                                                                                                                   | Scope                       |
  | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- |
  | `GET /`, `graph`, `types/:name`, `objects/:name`, `objects/:name/snapshots`, `query/relations`, `workspace/capabilities`, `events`, `events/traces`, `events/traces/:id` | `catalog:read`              |
  | `GET saved-queries`, `saved-queries/:id`, `saved-queries/:id/export.csv`, `POST saved-queries/:id/run`, `GET dashboards`, `dashboards/:id`                               | `catalog:read`              |
  | `PATCH types/:name`, `PATCH types/:name/properties/:property`, `POST reset`                                                                                              | `catalog:curate`            |
  | `DELETE saved-queries/:id`, `POST/PATCH/DELETE dashboards`                                                                                                               | `catalog:curate`            |
  | `POST query`, `POST saved-queries`, `PATCH saved-queries/:id`                                                                                                            | `catalog:admin`             |
  | `GET embed`, `embed/dashboards/:id`, `embed/charts/:id`                                                                                                                  | `catalog:embed` (unchanged) |

  **`POST query` is `catalog:admin`, not `catalog:read`, and that is the one worth
  arguing.** Read-only is not the same as bounded. `catalog:read` is documented as
  "read object metadata and rows" — rows of a catalogued type, through a route that
  names one — whereas an ad-hoc statement is whatever the store's read connection
  can reach. In the shipped MikroORM store that connection is the catalog's own
  schema, so `SELECT * FROM catalog_principal` returns every principal's scopes,
  grants and `keyHash`, the SHA-256 of its static key. Nothing else on this
  controller exposes that, and handing it to a reporting principal is an
  escalation, not a read. `queryRelations` lists only the catalogued types, but it
  is a schema panel for the editor, not a restriction on the statement.

  The two saved-query write routes follow it because they accept a `sql` field:
  `POST saved-queries` plus `POST saved-queries/:id/run` is `POST query` in two
  requests, and gating one without the others would make the strict declaration
  decoration. Running a saved query stayed at `catalog:read` — what is held back is
  _choosing what SQL runs_, not _seeing a result_, and gating execution instead
  would both stop an analyst opening a dashboard and let an unprivileged caller
  plant a statement for a privileged one to run.

  `POST reset` is `catalog:curate` rather than `catalog:admin`: it discards exactly
  what the two `PATCH`es write, and a curator can already blank every label one
  request at a time, so requiring admin would deny nothing while pushing a routine
  console action into the scope that manages principals.

  ### Who breaks, and what to do

  - **A principal with only `catalog:read` that curates.** Renaming a type or a
    property, and resetting the overlay, now need `catalog:curate`. Add it to the
    principals that do the curating — that is what the scope is for.
  - **A principal with only `catalog:read` that uses the SQL editor, or saves and
    edits saved queries.** Now needs `catalog:admin`. If you want analysts writing
    SQL without the rest of admin, the options are: give the catalog's read
    connection a database role that cannot see the `catalog_*` tables, in which
    case `catalog:read` is an honest declaration for your deployment and you can
    say so with `controller: false` and your own route; or grant `catalog:admin`
    deliberately, knowing what it reaches.
  - **A principal with only `catalog:read` that creates or edits dashboards.** Now
    needs `catalog:curate`.
  - **`catalog:admin` holders are unaffected** — it expands to every scope.
  - **Hosts that pass no guard, or a guard that ignores `REQUIRED_SCOPES`, are
    unaffected.** This library declares; it has never enforced.

  One consequence stated rather than left to be found: `shared` rides on the
  dashboard write routes, so `catalog:curate` carries the power to hand a board to
  an outside application. Splitting it would mean a route whose only job is to flip
  a boolean. What makes it accountable is that the act is audited — which is the
  other half of this release.

  ## Deleting a shared thing was silent

  `query.shared` and `dashboard.shared` fired on the toggle but not on the delete
  button, which is how access actually gets revoked. The trail could not answer
  "when did this stop being reachable from outside" except by noticing that
  something had stopped appearing — an inference from an absence, which is the
  exact failure the event was added to remove.

  Deleting a **shared** saved query or dashboard now emits the same event with
  `shared: false` and `deleted: true`. The same event name is the decision here:
  anybody asking that question filters on `query.shared` and reads the last entry,
  so a `query.deleted` beside it would leave that filter reporting `shared: true`
  forever for something nobody can fetch. `deleted` distinguishes "revoked, still
  there" from "gone", and the payload carries the name as it last read, because
  after a deletion there is nothing left to look up.

  Deleting an **unshared** one emits nothing. That is the existing transition rule
  rather than an exception to it: something that was not reachable from outside
  before is not reachable after, so no access changed, and recording it would put
  entries carrying neither a grant nor a revocation on the one channel whose
  entries all carry one. A host that wants every deletion in the trail wants a
  workspace-lifecycle event, which is a different event and is not this one.

  **API change:** `CatalogService.deleteSavedQuery(id)` and `deleteDashboard(id)`
  now take the actor as a second argument, matching `saveQuery` and
  `updateSavedQuery`. Required rather than defaulted — a default would quietly
  attribute revocations to nobody in every caller that was not updated. The
  built-in controller passes the host-resolved principal, falling back to
  `"console"`; a host with its own controller passes whatever it resolves. The
  `CatalogWorkspaceStore` interface is unchanged: the store takes no actor, because
  a store that emitted would emit on every path into it and could not tell a
  revocation from a cascade.

  ## Still true and not fixed here

  `POST reset` discards every curation edit in the catalog and emits nothing, while
  `patchType` and `patchProperty` each emit `type.curated`. The trail can therefore
  say who renamed a column but not who reverted every name at once. It needs an
  event `CATALOG_EVENTS` does not have — `type.curated` requires a `typeName` and a
  reset has no single one — so it is named rather than papered over.

  ## The Access screen's three routes, which were the same hole one file over

  `createAccessController` declared no scope on any of its routes. By the rule
  above — absence means "authenticated is enough" — `GET access/principals`
  handed any authenticated caller the list of every application that can reach the
  catalog, with its scopes, its `writeTypes` and its `classifications`: the map of
  what a stolen credential is worth and which one to take. `POST access/people`
  wrote into the host's directory and accepts `role: 'administrator'`, so it was a
  way to grant yourself the scope it should have been protecting.

  All three are `catalog:admin` now. The console had always hidden this screen
  behind `catalog:admin`, and that check was the only one there was — a hidden tab
  is not an access control, and the three paths answered a direct request.

  The reason it survived a test named _leaves no handler undeclared_ is worth more
  than the fix: the sweep read `createCatalogController` and knew nothing about the
  second factory. A completeness check that knows about some of the controllers is
  not a completeness check; it is a statement that the ones it forgot are fine. It
  reads both now, and a third factory has to be added to it by hand — there is no
  way to enumerate them without booting the module.

- d07687d: Embed a chart or a board in somebody else's application

  The server already served `GET embed`, `embed/charts/:id` and
  `embed/dashboards/:id`, returning rendered rows rather than SQL so a consumer
  never becomes a second implementation of the console. What was missing was
  everything a consumer needs to use it: no client method, no component, no
  documentation, and — it turns out — no enforcement.

  **The `catalog:embed` scope was attached to no route.** It existed as a type, was
  expanded by `catalog:admin`, and was named in two docblocks as the thing that
  gates this API, while `packages/pipeline` had declared its scopes on all 20 of
  its routes since it shipped. Any principal a host's guard let past the door could
  fetch every shared dashboard. All three routes declare it now, discovery
  included: a caller the fetches refuse has no use for the list, and an open
  discovery endpoint is an inventory of what is worth asking for.

  **The embed dropped the card's overrides.** `DashboardCard.title` and
  `.library` exist to override the saved query _on that board_, and the payload
  used the query's own — so the console and the embed drew the same dashboard
  differently, silently. The server now restates the same precedence the React
  side uses (card, then query, then built-in) rather than inventing a second rule.

  **`shared` was undeclared on dashboard writes.** It worked only because the body
  reached the store untouched; under a host's whitelisting `ValidationPipe` it is
  stripped and a dashboard can never become shareable, with no error anywhere.

  `<EmbeddedChart>` and `<EmbeddedDashboard>` render the payload with a toolbar
  that holds only OUTPUT actions — no refresh, no delete, no chart-library picker.
  Those are authoring controls and belong to the console where the board is
  assembled; an embed that could refresh would also bypass whatever caching the
  host put in front of it. `actions` defaults to `'none'`, and a caller's list is
  filtered against the actions that exist rather than trusted, so a host asking for
  one that does not exist gets no control instead of a dead button.

  A chart can be exported as PNG with no dependency — a serialised SVG, a canvas
  and `toBlob` are already in every browser. Two limits are worth knowing: an SVG
  rasterised through a data URI cannot load `@font-face`, so exported text falls
  back to a system face; and the built-in CSS bar chart draws with divs rather than
  an `<svg>`, so it cannot be exported at all and offers no action rather than a
  failing one.

- c0c2b8c: A PDF seam, the read rules said plainly, and an audit trail for sharing

  **PDF is a seam, not a dependency.** A host registers something backed by its own
  document pipeline; where nobody did, no PDF action appears — the rule the chart
  registry already follows. The two client-side candidates cost ~128KB gzipped on
  every consumer for a feature only some want, and the application embedding this
  catalog already generates PDFs server-side. The exporter receives BOTH the PNG
  and the serialised SVG: a host drawing with an image library takes the raster, a
  host with a vector pipeline takes the markup and keeps text selectable at print
  size.

  The registry is subscribable, unlike the chart one, and that difference is
  load-bearing: a PDF pipeline is heavy, so it is usually behind a dynamic import
  that resolves after the console has mounted. Without a subscription the cards
  already on screen would stay actionless forever. The card also watches for a
  late `<svg>`, because recharts inserts one from its own state with no React
  render to prompt a second look.

  **The read rules are a toolkit, and now say so.** `mayRead` and
  `maySeeClassification` have no call site anywhere, and that turns out to be the
  design rather than a hole: this library declares and the host enforces — no
  guard ships, `CatalogPrincipalGuard` does not exist in this repo, and
  `readObjects` takes no principal to enforce with. What was wrong was the prose.
  `CatalogPrincipal.classifications` claimed a column outside the list "is dropped
  from its reads" and `CatalogObjectPage.columns` claimed "non-redacted columns" —
  both describing a mechanism nothing performs. Corrected, with the decision
  written where the next reader will ask. `readableObjectPage(principal, page)` is
  the named helper that applies both, deleting hidden values rather than blanking
  them, since a key present with `null` is itself a disclosure.

  **Sharing leaves a trail.** `SavedQuery.shared`'s docblock claimed marking a
  query shared "shows up in the audit trail as one"; no such event existed, so the
  single act that grants an outside application access to data left no record.
  `query.shared` and `dashboard.shared` now fire — on the transition only, because
  a save that leaves the flag alone is not a sharing event and a trail that logs
  every save teaches people to ignore it. Un-sharing is recorded too and is
  distinguishable. The actor is the resolved principal rather than anything the
  body claimed.

  `PROMOTION_AUDIT_EVENT` was the third instance of the same pattern —
  referenced nowhere, while its docblock explained where the record is written. It
  is fixed in the same release; see the store adapter's entry.

### Patch Changes

- ad6b892: An audit event can finally say which environment it happened in, and a trace can say when its steps happened

  **The recorder injects `CATALOG_WORKSPACE_STORE` instead of `MySqlWorkspaceStore`.**
  This is the release-visible one. `environment.routing.ts` explained at length that
  handing `CatalogAuditRecorder` the routing store is what makes "every audit event
  records its environment" true by construction — but the recorder asked for
  `MySqlWorkspaceStore` _by class_, and `RoutingWorkspaceStore` implements the
  interface rather than extending the class, so no host could ever substitute it.
  In a multi-environment process every audit row landed in whichever single
  database the recorder happened to be constructed against, under no environment
  column: a dev event sitting in the production audit table, reading exactly like a
  production one. Every sibling in the package already injected by token; the
  recorder was the only one that did not.

  The single-environment default is unchanged — `CatalogMikroOrmStoreModule` already
  binds that token to `MySqlWorkspaceStore`. A host that constructs the recorder
  itself and provides only the concrete class must now bind the token too.

  **`stampEnvironment` has a call site.** It shipped with a paragraph about
  answering "everything this person did this week" across environments and was
  referenced by nothing. `RoutingWorkspaceStore.listEvents` now stamps what it read
  and widens its return type to say so. It happens there and cannot happen anywhere
  else: that reader is the only one that resolved an environment in order to choose
  the connection, which is the whole reason the value is stamped on read rather
  than stored in a column a row could lie in.

  **`CLOCK_RESOLUTION_MS` was stale by three orders of magnitude.** The audit
  column was widened to `datetime(3)` and this constant went on saying `1_000`, so
  `coarse` was set for every trace that finished inside a second — which is most of
  them. The explorer answered with a dashed track and "there is no internal timing
  to draw" over spans whose real spacing was sitting in the rows, on exactly the
  loads a waterfall exists for. Rows written before the widening are still whole
  seconds and still come back `coarse`, which is the truth about them.

  **And three docblocks corrected rather than built.** `TransformRow` claimed a row
  per version; there is one row, overwritten in place, and `saveTransform` bumps a
  counter on it — real versioning is a schema change with its own retention
  question, and the console rendering `code v3` was already inviting operators to
  believe a bad load's source was recoverable. `CatalogPromotionPlan.fingerprint`
  claimed an apply endpoint that recomputes and refuses; there is none in this
  repository, and the check belongs to the host, phrased the way `applyPromotion`
  already phrases it. `CatalogEnvironment.protected` claimed the API demands
  confirmation; nothing server-side reads it and the only reader paints a badge, so
  it is now documented as advisory until a host enforces it.

## 0.5.0

### Minor Changes

- 38dd467: Choose the chart library while assembling the board, not only when saving

  Which library draws a chart — the built-in, shadcn/recharts, bklit — could only
  be decided on the saved query, which is to say at save time. But the question
  you are actually answering while arranging a dashboard is how this card should
  look _beside the other cards on this board_, and the saved query cannot answer
  that: it is used by other boards too, and editing it to fix one of them changes
  all of them.

  So `DashboardCard` gains a `library`, with the same semantics its `title`
  already had — an override for this card, on this board. The card toolbar gets a
  picker beside the width control, and the default option names what the query
  chose so it is clear what "follows query" means before you change it.

  The picker is built from `registeredChartLibraries()`, so it offers only what
  the host actually installed. An option for a library nobody registered would be
  an option that silently degrades to the built-in: the control would say one
  thing and the card draw another.

  The precedence — card, then query, then built-in — now lives in one named
  function, `visualizationFor`, rather than in two lines inside a component that
  needs a query client and a transport to render. A test that mirrors those lines
  drifts from them silently; this one calls the same function the board does.

  Going back to "follows query" REMOVES the key rather than setting it to
  undefined. The two behave identically at the lookup, but a card is stored as
  JSON, and "the key is there and empty" is a different statement from "nobody
  chose" the moment anything else reads it.

## 0.4.1

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

## 0.4.0

### Minor Changes

- aa14420: Curated descriptions are rich text, stored as markdown

  The two fields an operator writes prose into — a type's description and a
  property's — are TipTap editors now, with bold, italic, inline code and lists.
  `RichTextField` and `RichTextView` are exported for hosts that render the same
  text elsewhere.

  **They store markdown, and that choice is about everyone who is not this
  editor.** `description` is served raw in the `/catalog` snapshot to whatever a
  host built on top of it, and those consumers were written against plain text.
  Markdown degrades into something a person can still read — `**bold**` — while
  HTML degrades into `<strong>bold</strong>`, which is noise, and creates an XSS
  surface in every consumer that decides to render it after all. One of those
  failures is cosmetic and the other is a vulnerability.

  So this is a contract change with no migration and nothing to update: plain text
  is valid markdown, so every description written before, and every one declared
  by a decorator, is unchanged and renders as itself. The type's docblock says so.

  Three decisions worth keeping:

  - **The read view is the same editor with `editable: false`**, not a second
    markdown renderer. Two parsers for one format is two answers to "what does
    this text mean", and they diverge on exactly the inputs nobody tests.
  - **Nothing is saved when nothing changed.** Opening a field and closing it is
    not an edit; saving anyway writes an overlay row that shadows the declared
    description with an identical string and puts a change in the audit trail that
    nobody made.
  - **Plain Enter belongs to the editor**, and Cmd/Ctrl+Enter commits. Stealing
    Enter is right for a one-line field and would make a multi-paragraph
    description impossible to write.

  Headings, images and horizontal rules are configured off: these render in a
  table cell, and an `<h1>` in a 20%-wide column is a line of enormous text that
  would be there purely because the library offers it.

  `@tiptap/react`, `@tiptap/core`, `@tiptap/starter-kit`, `@tiptap/pm` and
  `tiptap-markdown` join the peer dependencies. A host that mounts only the NestJS
  module never pulls them in.

## 0.3.1

### Patch Changes

- 6da500a: Export the types `CatalogDirectory` is written in

  `CATALOG_DIRECTORY` and `CatalogDirectory` shipped without
  `CatalogDirectoryQuery` or `CatalogPeoplePage` — the argument and the return of
  the one method a host is expected to implement. Implementing the seam meant
  restating both by hand.

  The barrel now re-exports the module wholesale rather than naming members, since
  the failure was a list that fell behind the file it was listing.

## 0.3.0

### Minor Changes

- 5d10b69: Serve the Access screen, through a directory the host can own — and page it.

  `GET /access/principals`, `GET /access/people` and `POST /access/people` had no
  server implementation at all. The React screens called endpoints nothing
  answered, so the whole screen read as a broken build.

  They are now served from `CATALOG_DIRECTORY`, split along who actually owns the
  answer. Applications come from `catalog_principal` and are shipped:
  `CatalogMikroOrmStoreModule` binds `MikroOrmCatalogDirectory` and hosts get that
  half for free. People are the host's — `listPeople` and `upsertPerson` are
  optional, and a directory implementing neither is a complete implementation
  rather than a half-finished one, because a catalog embedded in an application is
  embedded in one that already has a user store. Standing up a second one beside
  it is how you get two lists of employees that disagree about who was offboarded.

  An unimplemented half answers **501 naming the seam** instead of returning an
  empty list, so an operator can tell "not wired" from "nobody is there".

  **`listPeople` is paged, and the bound is not advisory.** The host's user table
  is its whole directory, so `GET /access/people` takes `search`/`limit`/`offset`,
  caps the limit at 500 whatever is asked for, and hands the query DOWN to the
  directory so it reaches the database rather than slicing a list that was already
  materialised. The response is a page carrying `total`, and the screen renders
  "Showing 1–50 of 1,340" plus a search box — a bounded list that cannot report
  what it is bounding is indistinguishable from a complete one, and an operator
  reading it as complete concludes somebody has no access when they were merely on
  the next page.

  Bind your own directory with the new `directory` option on
  `CatalogModule.forRoot` — via the option rather than only exporting the token
  from an imported module, since a provider declared inside the module shadows one
  exported by its imports. Routes mount at the new `accessPath`, a sibling of
  `path` by default.

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
