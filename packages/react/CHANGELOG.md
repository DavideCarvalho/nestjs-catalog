# @dudousxd/nestjs-catalog-react

## 0.25.1

### Patch Changes

- ca23b05: Fix: the "Actions" pill on a workflow node opens its menu

  **Clicking it did nothing at all** — no menu, no error, nothing rendered to inspect. Right-click on the same node was unaffected and offered the identical list, which is why this reads as one bug in one place rather than two.

  `NodeToolbar` renders as a **direct child of `.react-flow__renderer`**, the element React Flow hands to d3-zoom, rather than inside the node it points at. So a `mousedown` anywhere on that toolbar bubbled straight into the canvas pan gesture, and d3-zoom's `mousedowned` opens by calling `stopImmediatePropagation`. React delegates its listeners to the root container, which is an ancestor of the renderer, so an event stopped there never reaches React at all — the trigger's `onMouseDown` simply never ran.

  That was fatal for the pill and for nothing else on the toolbar, because Base UI's `Menu.Trigger` opens on **mousedown** while the trash button beside it opens on **click**, which d3-zoom leaves alone. Hence a toolbar that looked half-working: delete fine, Actions inert.

  The toolbar now carries React Flow's own `nopan` guard, which makes the zoom filter refuse the gesture before it stops anything — the same guard the edge's × wrapper has carried since it shipped. Pressing and dragging from the toolbar no longer pans the canvas either, which it previously did.

  Verified in Chrome over CDP with real pointer events, and covered by a test that goes red without the guard: d3-zoom is genuinely live under jsdom, so the press path is exercised rather than approximated. The suite had missed it because every existing test opened the menu with a synthetic `click`, and with no preceding `mousedown` floating-ui falls through to a click path no pointer takes.

## 0.25.0

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

## 0.24.0

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

## 0.23.0

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

## 0.22.0

### Minor Changes

- 3ae190b: Right-click the workflow canvas: a menu on a node, a wire, empty space or a selection — and a faster way to delete a node

  **Why this exists is a discoverability failure, not a missing convenience.** "Make the next node and wire it in one action" already shipped. It lived in a pill on a node's hover toolbar, roughly 46×20 pixels on a 1600-pixel canvas, and the person who asked for this had never found it. Told it was there, they answered: _"Apertei na borda e só deu wire ué"_ — they pressed the handle, got the click-to-connect gesture, and reasonably concluded that was the feature. **Two different affordances were both called "wire", and the one carrying the menu was the less visible of the two.** So this is the discoverable home for capability that already existed and was being missed.

  The hover pill therefore **survives and is renamed**. It says "Actions" now, it is announced as the actions for the node it belongs to, and it opens _the same list_ right-click gives — one builder, one model, no way for two menus to answer "what can this node do" differently. It survives rather than being deleted because right-click is not discoverable either: a control that appears under the pointer is how somebody learns the menu exists, and the menu is how they learn what is in it.

  **What each target offers, worked out from the graph rather than written down.** A node: open it, edit its code (only once it names a transform), send its output to any node that can legally take it, make one of any kind that can legally follow it, disconnect any wire it is part of, delete it. A wire: open either end, **put a node in the middle of it** — `A → B` becomes `A → filter → B` in one action, which used to be four gestures, one of which was undoing the connection you already had — move it to the other branch where it leaves an `if`, disconnect it. Empty canvas: add a node **where the pointer is** rather than off the right-hand edge where the dock has to put one, tidy, fit. A selection: bring it into view, delete it.

  Every option that makes an edge is filtered through `canConnect` — the same function the drag, the click gesture and the inspector's picker are refused by — by building a throwaway node and asking. Nothing restates a rule about what may follow what. Where a list comes out empty the menu **says why** rather than showing a gap, because "nothing here" and "nothing is possible" look identical and mean different things: a sink is told "a sink commits its rows, nothing runs after one". The kinds come from `WORKFLOW_NODE_KINDS`, never a hand-written row — that is the bug that shipped `filter` complete with no way to create it.

  **A faster delete, asked for and made safe.** A node can now be removed from a control on its hover toolbar or from its menu, instead of opening the inspector and scrolling to the bottom of it. Neither stops to ask, deliberately: a confirmation on every node removal is friction people learn to click through without reading, and it would make the fast gesture the slow one. What makes that trade sound is the canvas's own per-action undo, which the delete goes through as one labelled entry. What undo does _not_ do is make it **visible** that a node took two other nodes' wiring with it — so every removal now says so, by name and by count, on the item before the click and in the live region after it. Deleting from a published workflow's node says what the server will do about it: a published graph has to stay runnable, so the edit is taken here and refused at the save.

  Destructive items are separated by a rule and sit last, in their own tone. Keyboard parity comes from the platform: the context-menu key and Shift+F10 dispatch the same `contextmenu` event, so a focused node or wire opens the same menu, arrow-navigable, Escape to close. The anchor is corrected for it — measured in a browser, Chrome reports the _last mouse position_ on a keyboard-fired event, so a keyboard user would otherwise have got the menu wherever they last clicked. Right-click is taken over on nodes, wires and the canvas pane and **nowhere else**: every text field in the chrome floating over the canvas keeps the browser's own menu, which is the only useful one inside an input. Motion is `motion-safe:` throughout.

## 0.21.0

### Minor Changes

- b77e32f: Focus mode: one gesture that gives the canvas the screen

  Making the canvas full-bleed fixed the shape of the drawing surface and left its
  size. Measured in a browser on the shipped build: at 1600×913 the floating chrome
  still covered **20.3%** of the canvas, and at 1280×800 it covered **25.3%**. Most
  of that is one panel — the top-left card is ~384×281, and about 240 of those 281
  pixels are a picker, a name field and a paragraph about checkpointing that is
  read once and then occupies the corner of the canvas forever.

  There is now a **Focus** control in the action cluster, and `F` from anywhere on
  the screen. One gesture, because the ask was for room and room is a property of
  the whole screen; three independent collapses would be three decisions and six
  states to be in. It does three things:

  - the workflow card folds to its head — title, name, status badges, commits
    badge — and the picker, the name field and the checkpointing banner go;
  - the node dock drops its labels to the icons-only form it **already** takes
    below `md`, rather than a second compact layout that could drift from the
    first;
  - the details rail goes away, and comes back to whatever it was before focus
    took it rather than to a default.

  Measured on the same build, same graph: chrome coverage **20.3% → 3.3%** at
  1600×913 (+21.2% free canvas), and **25.3% → 4.7%** at 1280×800 (+27.7%). The
  card itself goes from 281px tall to 41px. `fitView`'s per-side padding moves with
  the mode, so the room it buys is room the next fit actually uses.

  ## What it may not hide, and does not

  A mode that hides things is only worth having if it cannot hide the things that
  stop a mistake. The action cluster is therefore **untouched**, and that is the
  whole safety argument rather than an omission — every such signal on this screen
  lives in it or hangs off it:

  - **Save** doubles as the unsaved indicator ("Save" vs "Saved"), and it stays.
  - **Refusal notes** appear under the button that caused them, and that button
    stays. So does the shrink refusal and its acknowledge control.
  - **Problems** are in the rail, which focus takes — so the count and its colour
    ride on the rail's toggle while it is away, as they already did for anyone who
    had closed the rail by hand. Focus is simply the gesture most likely to close
    it now.
  - **Publish state** is in the status badges, and the badges are in the half of
    the card that stays.

  It is also the smallest of the three groups, so hiding it would have bought the
  least canvas for the most risk.

  ## The refusal

  Focus **will not** collapse the card while the graph has no name. Save is
  disabled on an empty name and the field that fills it in is inside the card, so
  collapsing unconditionally would leave a dead Save button, a tooltip about a
  field that is not on screen, and no way to connect the two. The toggle says which
  of the two things it is doing — in its accessible name, not only its tooltip —
  rather than looking like a button that did nothing.

  The refusal lifts on its own once there is a name, and specifically **not** while
  the caret is still in the field: the condition holding the card open stops being
  true on the first character typed, so without a guard the field would vanish
  mid-word.

  ## Remembered per tab

  `sessionStorage`, deliberately not `localStorage`. A mode you have to re-enter
  after every reload is a mode nobody uses — the person this is for is drawing a
  forty-node graph, and that person reloads. But a preference that hides controls
  and is restored silently a week later is somebody opening the console, finding
  fewer controls than they remember, and having no way to connect that to a
  keypress from last Tuesday. Per-tab is the honest middle: a reload keeps it, a
  new tab does not, and nobody inherits a hidden control from a decision they
  cannot remember making. A restored mode starts with the rail already away, so it
  does not arrive half-applied.

  ## Keyboard and motion

  `F` is a bare letter rather than a chord, because this is a drawing surface and
  the hand that would reach for a modifier is on the pointer. It is refused while
  anything is being typed into — this screen is covered in text fields — and every
  modifier is refused, so `Ctrl+F` and `Cmd+F` still find. The letter is rendered
  on the toggle and named in its tooltip, so the shortcut is learnable from the
  control it duplicates.

  The card body collapses on a tween rather than a spring, which is not only taste:
  a spring overshoots, and a height overshooting past zero clips against its own
  border. A spring on a height resolved from `auto` also has no analytic end — it
  settles on frames, and under jsdom it never settled at all, so `AnimatePresence`
  never unmounted the body and focus mode "worked" in a browser while leaving the
  picker and the name field in the document forever in a test.
  `prefers-reduced-motion` gets the same result with no transition, verified in a
  headless browser with the media feature emulated.

  The tab order the previous round settled — app nav, card, actions, rail toggle,
  dock, rail, canvas — is unchanged; the one new control goes on the end of the
  cluster it belongs to. The card body is unmounted rather than hidden, because a
  hidden control is still a tab stop.

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

- b77e32f: Focus mode shrinks the overview, and hovering it brings it back

  Focus mode left the minimap alone, deliberately: it is a navigation aid for
  exactly the big graph that made somebody want the room, so hiding it takes away
  the thing the mode is for. But it is also the largest single piece of chrome
  still standing once the card has folded, and at 200×150 it was most of what was
  left. So it shrinks rather than goes, and comes back at full size under a
  pointer or a caret.

  ### What the shrunk map still shows

  96×72, which is React Flow's 200×150 scaled by 0.48 — whole pixels on both
  axes, because a fractional height puts the mask's bottom edge on a half-pixel
  and the viewport box picks up a grey seam that reads as a border it does not
  have.

  It keeps the one thing it is for: **where the viewport is in the graph**. That
  is drawn as a hole in a tinted mask, so it is an area rather than a detail, and
  area survives scaling — the box keeps its position and its proportion of the
  whole, which is the entire "am I looking at the middle of this graph or the far
  edge" question. The node dots keep their kind colours, so a cluster and a lone
  box on the other side of the graph are still two different pictures.

  **What is sacrificed**: reading an individual node's position precisely, and
  telling two adjacent nodes apart. Both come back on hover, and neither was ever
  a gesture here — no `onNodeClick` is passed to the minimap, so a dot has never
  been a target.

  ### The numbers

  Measured in a headless browser on the same seven-node graph and the same two
  viewports as the previous round, with chrome coverage taken as the true **union**
  of the floating panels clipped to the canvas — not a sum, which would
  double-count the day two panels overlap and flatter every later number.

  |                                         | 1600×913 | 1280×800 |
  | --------------------------------------- | -------- | -------- |
  | chrome, no focus mode                   | 23.7%    | 30.5%    |
  | chrome, focus mode, overview full size  | 5.6%     | 8.0%     |
  | **chrome, focus mode, overview shrunk** | **4.0%** | **5.7%** |
  | free canvas, shrunk                     | 96.0%    | 94.3%    |

  So the shrink is worth **1.6 points** of canvas at 1600×913 and **2.3 points** at
  1280×800, on top of what focus mode already bought. That is a modest number and
  it is the honest one: the card was the big win, and this is the remainder. The
  minimap itself goes from 2.1% of the canvas to 0.5%.

  (These absolute percentages are not directly comparable with the 20.3% / 25.3%
  quoted for the previous round — that measurement did not count React Flow's own
  panels, and this one does. The focus-mode delta is measured the same way
  throughout the table above.)

  ### Hover is not the only way in

  **Pointer.** `:hover`, which is the gesture that was asked for.

  **Keyboard.** The panel becomes a focus stop _while it is shrunk_, and expands on
  `:focus`/`:focus-within`. React Flow's minimap is an `svg` with `role="img"` and
  cannot hold a caret, so `focus-within` needed something that could. It is
  conditional on purpose: outside focus mode the tab order is exactly the one the
  previous round measured and settled — app nav, card, actions, rail toggle, dock,
  rail, canvas — and inside focus mode there is one extra stop, at the end, on the
  element that needs it. That is a net gain for a keyboard, since the minimap was
  never reachable in either mode before.

  **Touch.** It does not shrink at all. There is no state between "not touching"
  and "touching" on a touch screen, so the first contact with a pannable minimap
  _is_ a pan — a map that expanded on touch would turn a navigation gesture into a
  resize gesture and move the viewport while doing it. There is no version of
  hover-to-expand that works there, so a finger gets the map exactly as it is
  today. Gated on `(hover: hover) and (pointer: fine)`, read once at mount, and
  answering "do not shrink" to every failure.

  ### Panning, and why the size had to be a scale

  React Flow sizes the minimap from `style.width`/`style.height` and derives
  `viewScale` from them. Its pan handler moves the viewport by `rawClientDelta *
viewScale`, reading `viewScale` **live** from a ref on every `mousemove`.

  Shrinking the obvious way — passing a smaller width and height — would therefore
  change the pan gain, and change it _on every frame of an animation between the
  two sizes_. A drag that started while the map was small and expanded mid-gesture
  would have the viewport accelerate under the finger for the length of the
  animation.

  Scaling has none of it: `style.width` stays 200 in both states, so `viewScale` is
  a constant and the pan gain is identical small, large, and every frame in
  between. The interactive area is smaller while shrunk, but on a fine pointer that
  state is unreachable — a drag needs a press, a press needs the pointer over the
  element, and the pointer being over the element is what expands it. Every drag
  begins on a settled, full-size map. Expand-then-pan, arrived at by geometry
  rather than by disabling anything. Verified in a browser: hover expands 97→202px,
  the drag pans, and the map stays expanded throughout.

  ### It cannot flicker

  Both states are anchored at the same bottom-left corner and the transform origin
  is that corner, so the small box is a strict sub-rectangle of the large one. A
  pointer that enters the small box is still inside the large box once it expands,
  so expansion can never move the element out from under the pointer that caused
  it. The oscillating geometry — expand, pointer now outside, collapse, repeat —
  needs the two boxes to disagree about a region, and containment rules that out.
  Measured twice, 500ms apart, after the pointer leaves: the same size both times.

  It also cannot collide with the zoom controls above it, because the expanded size
  is the size the minimap already is today — it grows back into space that was
  always reserved for it.

  ### The animation

  A 200ms tween on the same curve the card body folds on, so the two halves of one
  gesture move as one gesture. Not a spring, and not on a resolved height: that is
  the shape of animation which never settled under jsdom, so `AnimatePresence`
  never unmounted and the card body stayed in the document forever in a test while
  working fine in a browser. There is nothing here for that to happen to — the
  minimap is never unmounted and never changes layout size; the only thing moving
  is one compositor property. `prefers-reduced-motion` gets the same end state with
  no transition, verified with the media feature emulated.

  ### The zoom controls are untouched

  The maintainer asked for the minimap, and the controls are left exactly as they
  are — but not only because they were not asked for. They are already the
  smallest thing on the canvas (28×80, four icon buttons with no labels), so there
  is no compact form to go to short of hiding them, and hiding zoom and fit in a
  mode about looking at a big graph removes the way out of being lost. Leaving them
  in place is also what gives the expanded map somewhere to grow: the gap between
  the shrunk map and the controls is exactly the space the full-size map needs, so
  reserving it is what keeps a hover-expand from covering a button.

## 0.20.0

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

- 163d657: The workflow canvas is the screen, and the tooling floats on it

  The canvas was a box in a column. Above it sat a heading, a description
  paragraph, a checkpointing notice, a picker, a name field and a row of buttons;
  beside it, a 18rem column of panels. On a 1600×1000 window the surface somebody
  actually draws on got a little over half the viewport, and the half it got was
  the wrong shape — wide graphs ran out of room sideways while a third of the
  screen held text that is read once.

  So the layout is inverted. The React Flow surface is pinned to all four edges of
  whatever the host gives it, and everything else floats over it: the graph's
  identity and its two fields top-left, the save/publish/run cluster top-right, the
  node dock bottom-centre, and the wiring/problems/schedule/run panel on the right
  edge. Nothing is in normal flow and nothing scrolls.

  **Occlusion is paid for rather than ignored.** A panel over a canvas covers
  graph, and the honest version of this layout has to answer for that. `fitView` is
  given per-side padding matching the chrome's own insets, so the graph is fitted
  into the region nothing covers instead of into the raw viewport — no more nodes
  centred underneath the action cluster. The panels are translucent with a blur, so
  what is behind them stays legible. The gaps between them are still canvas: the
  overlay is `pointer-events: none` except on the panels themselves, so panning and
  marquee-selection work through it.

  **What is permanent, and what is not.** The add-node dock and the problems are
  what somebody mid-draw needs, so both are on screen by default. The description
  paragraph is not: it explains the screen to somebody arriving at it and costs
  three lines of canvas forever to be read once, so it moved to a tooltip on the
  title — and is still rendered to screen readers in full, which is the audience a
  tooltip alone would have failed. The details rail can be put away for the room,
  and the toggle then carries the problem count and its colour, so the _fact_ of a
  problem never depends on the panel being open. Running a graph reopens it, since
  the run's answer is written there.

  The rail's own contents were reordered while it moved. Problems and outstanding
  work now come first, the wiring after them, the schedule and connector panels
  last. On a stored graph those last two are tall enough that Problems — the one
  thing that should never need scrolling to — was below the fold.

  **Small viewports.** The rail starts closed under 1024px and the minimap is
  hidden there, so the canvas keeps the whole window instead of a floating layout
  burying it; under 768px the dock drops its labels to icons, which keeps all six
  kinds reachable without a sideways scroll. Verified in a browser at 1600×1000,
  1180×820, 820×900 and 560×760: no horizontal overflow, every node clear of the
  chrome, and the graph on screen at each.

  **Keyboard order was the thing most at risk and is now better than it was.** The
  chrome is ahead of the canvas in the DOM, so Tab reaches the workflow controls,
  the actions and the dock before the graph's nodes — rather than after every box
  and handle on a large canvas. The dock is deliberately ahead of the rail for the
  same reason: the rail grows a stop for every wire, problem and sink, and the
  add-node buttons are what somebody is tabbing towards. The rail is not modal and
  traps nothing, and Escape is left alone, because on this screen it already means
  "put the half-drawn wire away".

  Nothing about the graph model, the wiring state machine, the edge delete control,
  the inspectors or the live regions changed.

  Also in here, because it lives in the row this rewrote: **a `filter` node can be
  added from the canvas.** The kind shipped complete — model, validator, executor,
  inspector, its own colour — and had no way in except the API, because the row
  that offers the kinds was five hand-written buttons and there are six kinds. The
  row now maps `WORKFLOW_NODE_KINDS` through a `Record<WorkflowNodeKind, …>`, so a
  new kind fails to compile until somebody says how it is offered. The accessible
  names are generated with it, which is how "Add a if node" appeared and was fixed.

  One incidental fix: the two context values handed to every node and every edge
  were fresh object literals on each render of the screen, so any state change here
  re-rendered every box and every wire. They are memoised, which matters more now
  that opening a panel is a state change on this component.

- 186b969: Undo by action, Reset to the last save, and a canvas that will not lose your work silently

  **Closing the tab on an unsaved graph lost it, with no warning.** There was no
  `beforeunload` handler anywhere in this package: a stray ⌘W, a middle-click on a
  link, a refresh out of habit, and an afternoon of wiring was gone. That is data
  loss rather than a missing nicety, and it is the part of this change that would
  have shipped on its own.

  There was also no undo of any kind, and the only trace of unsaved work anywhere
  on screen was the word on the Save button changing from "Saved" to "Save" — thin
  for something that means "this is only in your browser".

  Four things, and they are one subject.

  **Undo steps back by ACTION, not by change.** The unit is the gesture, not the
  state update. Dragging a node across the canvas is one action however many
  hundred position changes React Flow emitted on the way — the drag's own
  `dragging` flag is what holds the run open, so a slow drag with a pause in the
  middle is still one step back. Adding a node and auto-wiring it is one action,
  because it is one gesture that happens to produce two graph changes; undoing them
  separately would leave a node nobody asked for standing on its own. Typing into a
  field folds into one action per field: consecutive edits to the same node share
  an entry only while they touch the same fields, so typing a name and then
  flipping a switch on the same node a second later stays two steps — otherwise
  undoing the switch would silently retype the name. Everything else — connect,
  disconnect, delete, branch, tidy, add — is one entry each, and a delete is never
  folded into anything, because it is the change people most want back.

  **The stack holds 50 actions and drops the oldest at the limit,** rather than
  refusing at the top. What that costs is the ability to walk all the way back to
  the beginning of a long session, which is what Reset is for; the tooltip says
  "up to the last 50" rather than implying an infinite one.

  **There is no redo, deliberately.** Undo only steps backwards. A redo stack has
  to be invalidated correctly on every new edit, every save and every graph swap,
  and a stale one is a control that puts back something that no longer fits the
  graph. The two things people actually reach for — take back the last mistake, or
  give up on everything since the last save — are both covered without one.
  Shift+⌘Z is caught rather than ignored, and says which control does the job
  instead, because silence reads as a broken shortcut.

  **Reset means the last SAVED version, and says so.** Not "undo until the stack is
  empty": the baseline moves to each save, so after saving halfway through a
  session Reset returns to that save, while undoing forty times would walk straight
  past it to the version the tab was opened on. It is destructive of unsaved work,
  so it is confirmed exactly as deleting the workflow is, and the confirmation
  counts what is about to go ("3 actions will be thrown away") and states what it
  does not touch: no run is stopped, nothing is unpublished, the stored workflow
  stays as it is.

  **Unsaved work is now visible as a state rather than a word on a button.** An
  amber dot and "Unsaved" sit directly to the left of Save, as an `<output>`, so it
  is announced once when work becomes unsaved rather than only found by somebody
  who goes looking. The dot pulses, and does not under `prefers-reduced-motion`.

  **Leaving with unsaved work is warned about — and only then.** The `beforeunload`
  listener is registered while the draft is dirty and removed the moment it is not,
  because a page that always warns is a page whose warning people learn to dismiss
  without reading. Undoing back to the loaded graph makes the draft genuinely
  clean, not merely "edited back", so the warning goes away with it.

  **Where undo stops, stated on screen.** Undo touches the drawing and nothing the
  server has already done — saving, publishing, running and deleting the workflow
  are not undone here. That sentence is in the tooltip and in the accessible tree
  next to the controls, not only in a comment, because a boundary somebody has to
  read the source to learn is not one they will learn.

  **Keyboard and screen reader.** Ctrl/⌘Z undoes, bound on the window so it works
  without the canvas happening to be focused — and it does not fire while somebody
  is typing. The canvas has a name field, several config fields and a real
  contenteditable code editor on it, and in all of them ⌘Z means "undo my typing";
  the binding declines any input, textarea, select, contenteditable, `role=textbox`
  or anything inside a dialog or sheet. Every undo and every reset is announced
  through the canvas's existing live region, naming what it took back — undo
  routinely reverts something scrolled off screen, and a silent revert of an
  invisible thing is indistinguishable from a dead button. The Undo button's
  accessible name carries the same thing ("Undo: adding a sink node").

  Verified in a real headless Chrome as well as in jsdom: a 20-step pointer drag
  moved a node and one ⌘Z put it back in a single step; ⌘Z inside the inspector's
  name field did nothing to the graph; the browser's own leave dialog appeared on a
  navigation away with unsaved work, and cancelling it kept the page and the edits.

  The history lives in a new `workflow/history.tsx` beside the canvas rather than
  inside it — the canvas's `edit()` now takes a labelled action alongside the
  change, and that label is what an undo announces.

## 0.19.0

### Minor Changes

- 2ab7077: New `Combobox` / `ComboboxField`: a searchable select that also accepts a value nobody offered.

  `Select` is a closed set — it renders a button, and every value is one of its rows. That is right
  for a mode or a kind, whose options are three and written in this repository. It is wrong for a list
  a _deployment_ supplies, which is what the call node's workflow picker needed and what these screens
  will keep needing: a fleet announcing three hundred workflows renders three hundred rows in a popup
  whose only gesture is "scroll until you see it", and a workflow served by a worker too old to
  publish its registrations is not on the list at all and is perfectly callable.

  Built on Base UI's `Autocomplete` rather than its `Combobox`, and the difference is the whole point.
  `Combobox` has a _selected value_: its input is a query over a closed list, and what you end up with
  is one of the items. `Autocomplete` has no selected value — the input's text **is** the value — so
  free entry is not a feature bolted onto a picker, it is what the primitive already is.

  - **Picking and typing are told apart.** `onValueChange` fires for keystrokes, `onSelect` for a
    committed row. Base UI also fills the input on an item press, which arrives as a value change
    reasoned `item-press`; that one is dropped, so a caller writing two fields from one row cannot
    have the second immediately overwritten by the keystroke-shaped echo of the first.
  - **Reopening shows the whole list again.** The query is held separately from the value and reset on
    every open. Filtering by the value would open the popup onto the single row already chosen, and
    the only way to see the others would be to delete what is there.
  - **A row can be shown and refused.** `disabled` greys a row and blocks the commit — twice, in the
    rendering and again in the click handler, because what may be committed is a rule and not a
    rendering decision. Omitting such a row instead is how a picker comes to hide the thing somebody
    was looking for.
  - **The search reads more than the label.** `keywords` is matched and never shown, because somebody
    hunting the Python half of a fleet types the group, and somebody who half-remembers a workflow
    types what it does.
  - **Substring, not prefix**, since these names are dotted and namespaced and `reconcile` is as
    likely a query as `billing`. Labels truncate with a `title`, because the distinguishing half of
    `billing.reconcile.nightly` is the end.
  - **An empty result says so.** `emptyMessage` renders in a live region Base UI keeps mounted, rather
    than leaving a blank popup that reads as a broken field.

  The popup animates and honours `prefers-reduced-motion` as a fallback rather than as the ceiling.

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

- 439db61: A path between the model and the workflows, in both directions.

  `#model` and `#workflows` were siblings with no navigation between them. A sink node knew exactly
  which object type it committed and could not take you there; an object type said nothing about what
  loaded it, so "there is an `af_fleet` workflow — how is that tied to this type?" had no answer on
  either screen.

  **Workflow → model.** `WorkflowCanvas` takes a `modelHref(typeName)`, and the sink inspector — the
  one node whose configuration names a type in this catalog — renders a link to the type it commits.
  Nothing is rendered for a sink with no type chosen: `?type=` names nothing, and the model screen's
  fallback is its first type, so the link would land somewhere plausible and unrelated.

  **Model → workflow.** A new `LoadedBySection`, mounted on the type panel directly above the load
  expectation — the two are one question in two halves, who loads this and what is checked when they
  do. It lists every graph whose SINKS commit the type, which is deliberately not the stored
  `CatalogWorkflow.targetType`: that is one string, and a graph may commit several types. Each row
  says whether the graph would actually run — a draft is scheduled by nothing, a published graph may
  be turned off, and one with no cron runs only when somebody starts it — because naming a type at a
  sink is not the same as loading it.

  The list is honest about being incomplete. An application holding a key can publish straight into a
  type through the publish API, and no workflow will ever explain that load, so the caveat is
  rendered whether the list is empty or not: "none" means "no graph", never "nothing". A read that
  failed says so rather than rendering the empty state, because a host that mounts no pipeline
  endpoints is not a deployment where nothing loads the type.

  `CatalogManager` gains `type` and `workflowHref`. `type` follows the same three-step fallback as
  `ObjectExplorer`'s — prop, then `?type=` in the hash, then the first type — with one difference
  that is the point of it: a name this catalog does not hold is reported rather than replaced by the
  first type, since a sink may name a type nothing has published yet.

## 0.18.0

### Minor Changes

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

- 70f5e0b: The canvas can tell you a source does not supply the columns its sink writes, before the load does.

  Every check on the workflow canvas was topological — a sink with no type, two sinks on one type, a
  node nothing reaches. All of them pass a graph whose source supplies not one of the columns its
  sink writes, because nothing in a graph says what the columns _are_. The load then succeeds,
  commits, reports its row count, and the rows are null.

  That is not hypothetical. `subwo` has 84 columns, 73 of them spelled in ways SQL cannot use as an
  identifier, and the mismatch was found after a run reported `fetched=6905, written=6905`. Thirteen
  types were published the same way and six came out with most of their columns null, 313,833 rows of
  the largest. `property-names.ts` moved _its_ half of that problem to publish time for exactly this
  reason; this moves the other half to design time, where everything needed to answer it is already on
  screen.

  ## What is compared, and against which of the two names

  A published property has two names and they are not interchangeable:

  - **`name`** is what the load looks the field up by — `row[property.name]` — and nothing on the
    write path consults anything else.
  - **`columnName`** is lineage: how the source spells the field, recorded when the property ended up
    called something else.

  A source with no transform between it and the sink hands its records over exactly as they arrive,
  keyed by the source's own spelling. So the record has `Asset Id`, the store asks for `Asset_Id`,
  and the answer is `undefined` — written as null in every row of every run, forever, while the load
  reports success.

  So the comparison is `column.name` against `property.name`. Matching on `columnName` instead —
  which _is_ the field that agrees with the source — reports "fits" on precisely the graph that wrote
  the 6,905 rows. `columnName` is still read, but only to explain a miss: a source column matching a
  property's `columnName` and not its `name` is the split-name case, and saying so is the difference
  between "this column is missing" and "these two are the same field under two names".

  The repair the message offers changed with the release that relaxed the publish check. Publishing
  used to refuse any property name that was not a SQL identifier, so publishers renamed the property
  to `Asset_Id` and put the source's spelling in `columnName` — which is the type that loads nulls.
  Both aliases now go through `outputAlias`, so `Asset Id` is a perfectly good property name and the
  type can simply be renamed to what the source calls the field. The message says that first, and
  names a transform second, for the narrower set of names that cannot become a column even cleaned.

  ## Three outcomes, not two

  Discovery says how it knows what it knows, and against a real deployment it answered
  `basis: "driver"` with `sampled: 0` — the driver described the result set and not one row was read.
  There are questions this genuinely cannot settle, and pretending otherwise in either direction is
  the failure:

  - **fits** — nothing is reported.
  - **does not fit** — `level: "error"`, so Save is coloured as refused and the wire is drawn red.
    Reserved for what the two schemas decide between them and nothing else can change: a column the
    source does not produce under the name the store will ask for (`shape-source-spelling` when the
    source has it under its own spelling, `shape-missing-column` when it does not have it at all).
  - **not known well enough to say** — `level: "warning"` (`shape-unproven`, `shape-not-checked`). It
    blocks nothing, colours nothing and paints no wire, and it names the basis it is unsure from.

  The third one uses the `level` distinction `WorkflowProblem` already had rather than a new one, and
  that is the load-bearing part rather than a detail. `coerce` in the warehouse store is total: it
  stringifies for a `string`, parses a `date` and gives up as null, returns null for a number that is
  not finite. A `string` column arriving at a `number` property therefore loads perfectly when every
  value happens to be numeric and writes nulls when one is not — a fact about the rows, and there
  were no rows. Calling that "does not fit" would refuse graphs that load correctly every night, and
  a panel that shouts about what it could not prove is a panel people stop reading, which is the
  failure `workflow/validate.ts` opens by describing.

  Also warnings, for the same reason: a column discovery reached no conclusion about (`type: null` is
  the absence of a decision, not the `unknown` scalar), and the two sides disagreeing about
  nullability — the type saying a field is never null while the source says its column may be. Both
  are declarations. Neither is a row.

  ## Anything that computes its rows is said out loud

  What a transform emits is whatever its TypeScript returns, and knowing that means compiling and
  running it. A `call` node is further out of reach still: what it emits is decided by a durable
  workflow this graph does not own, possibly written in another language, and the graph holds nothing
  but its name and a pinned version. So a sink fed through either gets `shape-not-checked` naming the
  node, and no error and no silence — silence would read as "these columns fit", which is a claim
  nothing here is in a position to make.

  The branch is on "not a source" rather than on the kind, so a kind added to the vocabulary tomorrow
  lands in the honest answer by default instead of falling through the comparison as though a source
  had produced its rows.

  ## Where nobody asked, nothing is said

  If no source feeding a sink has a discovered shape, this reports nothing at all — not even "could
  not check". A deployment that has never run discovery would otherwise carry a permanent amber line
  on every graph, which is the same noise by another route.

  That is also the default. `ValidateOptions.shapes` is optional and **absent, not empty**: a caller
  with nothing to offer has not learned that every graph is fine, it has not asked. Every existing
  caller of `validateWorkflow` is unaffected.

  ## Wiring: no new prop

  `WorkflowCanvas` answers this for itself. Both halves are already on the screen: the types come from
  the catalog snapshot it reads, and the columns come from `POST workflows/:id/nodes/:nodeId/discover`
  — the route the source node's inspector already calls. `SchemaDiscoveryPanel` gained an
  `onDiscovered` callback and the canvas keeps what came back, keyed by node id.

  Kept by the canvas rather than by the panel because the panel is unmounted with the inspector sheet,
  and the rail that has something to say about the columns is on the other side of it. Not fetched by
  the canvas on load, either: discovery is a read of a live source behind a `POST`, and a graph with
  four source nodes would open four database connections nobody asked for. So the check speaks about
  the nodes somebody asked about, which is exactly the silence the section above is built on.

  A shape is dropped when the node is pointed somewhere else — its kind, its connection, its read mode
  or its config — because columns read from one address say nothing about another. Renaming the node
  keeps them: a name is not an address.

  `checkShapes` and its input types (`ShapeKnowledge`, `SourceShape`, `SourceColumn`, `TargetShape`,
  `TargetProperty`) are exported, because the comparison is pure and a host may want it somewhere
  other than the canvas — a pre-flight before a scheduled run. `ConnectorSchemaDiscovery` already
  satisfies `SourceShape`, so such a caller has one for free.

- adf4cfe: One place to author a pipeline, and no client method that 404s

  The server half of this landed already: a connector stopped being an authored
  object and became what a published workflow runs as. It shipped with five client
  methods pointing at routes that no longer exist, and two screens for one concept.
  This is the other half.

  **`#connectors` and `#workflows` are one screen.** The canvas is where a workflow
  is authored, end to end — draw it, save it, publish it, schedule it, run it, and
  ask a source what its columns are. What is left of the old connectors screen is
  `<PipelineConsole />`, which keeps the two objects a workflow _borrows_ and does
  not author: connections, which are the credential and address boundary somebody
  manages independently of any graph, and transforms, which are code several graphs
  may name. Its title, its tabs and its docblock all say so. The dashboard's tabs
  are `Workflows` and `Connections`, and `#connectors` still resolves — to the
  canvas, because authoring is what that screen was for.

  **Every dead client method is gone rather than quietly broken.**

  - `saveConnector`, `deleteConnector` — removed with the connector form. Authoring
    is `saveWorkflow` plus the new `publishWorkflow`; the fields those took are
    fields of nodes now. `ConnectorInput` went with them.
  - `runConnector` — replaced by `runWorkflow(id, options)`.
  - `discoverConnectorSchema(id)` — replaced by
    `discoverSourceSchema(workflowId, nodeId)`.
  - `connectionConnectors(id)` — replaced by `connectionWorkflows(id)`, which is
    the question actually being asked before somebody deletes a connection.

  New on `CatalogClient`: `publishWorkflow`, `unpublishWorkflow`,
  `scheduleWorkflow`, `connectionWorkflows`, `discoverSourceSchema`, and a second
  argument on `runWorkflow`. `pipelineRoutes()` gains the matching builders and
  loses the four that addressed removed routes — a builder left behind is a path a
  screen can still ask for.

  **Discovery works before publication, which is the whole point of the route.** A
  sink cannot commit into an object type that does not exist, so requiring a
  published graph would require publishing a graph whose target type cannot be
  created until it is. The panel lives on the source node's inspector, it is
  enabled on a draft, and when it cannot run it says so — naming _saving_, never
  publishing, because a reader told to publish first would go and find they cannot.
  `SchemaDiscoveryPanel` moved out of `PipelineConsole` into its own module so both
  entry points can mount it, and is exported.

  **`expectShrink` is reachable, and says what it does where it is used.** It is
  the acknowledgement that lets a deliberately collapsing load past the row-count
  bound, it now exists on exactly one route, and without a way to reach it an
  operator's only recourse is raising `rowCount.maxShrink` in the type's policy —
  which stands the guard down for every future load of that type instead of for one
  snapshot. So it is a control beside Run, it opens a dialog that states that
  trade-off, it will not submit a blank reason, and a refused load grows a
  "Re-run, acknowledging the shrink" button in the refusal itself.

  **Adoption is said out loud.** A connector wrapped into a graph at boot is
  published as `ready` without a person declaring it finished. An `adopted` badge
  and a note on the canvas say where the graph came from and that "ready" here
  means "it validated", not "somebody looked at it" — matched on `createdBy`, so a
  connector that carried its own description is covered too.

  Also: a `Runs as` panel showing the connector id the run history and watermark
  are keyed on (and never its config — the server redacts, so the screen does not
  render it at all); a `Schedule` panel that prints the server's warning when a
  stored cron will never fire; `ConfirmDialog` gains `confirmDisabled`; the delete
  dialog now says the connector and its history go too.

  Nothing here changes what the canvas says about an unfinished node: a freshly
  added node still reports its checks as work rather than as failure, and a graph
  that would never run still cannot be saved quietly.

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

### Patch Changes

- 4aaf82a: A tall query can be scrolled to the bottom

  **The bug.** "tentei scrollar e não foi" — the SQL box on `#query` would not
  scroll. Reproduced in Chrome with a 61-line body in the `h-56` box: a real wheel
  event dispatched over the editor moved `window.scrollY` from 0 to 270 and left
  the editor on line 1. The PAGE scrolled; the code did not.

  **The cause, which is the previous fix's blind spot.** `overflow: 'scroll'` is an
  option about WRAPPING, and it buys one axis. Inside the shadow root
  `@pierre/diffs` puts `overflow-x: scroll` on its `[data-code]` element, pairs it
  with `overflow-y: clip`, and lets that element size to the whole document — 1230px
  of it inside a 224px box. Nothing in the library scrolls vertically: `File` is
  the non-virtualised renderer and owns no viewport, and the one escape hatch it
  exposes, `--diffs-overflow-override`, substitutes into the X component alone. So
  the overflow landed on the first ancestor with an opinion, which was
  `CodeEditor`'s own wrapper wearing `overflow-hidden` — clipping, by definition,
  without offering any way to scroll. Walking every element from the last line up
  to `<html>` found not one with a user-scrollable Y axis. Only the browser's own
  caret-into-view scrolling could reach line 61, which is why typing to the bottom
  appeared to work and dragging never did.

  **The change.** The wrapper is now `overflow-x-hidden overflow-y-auto`: it
  becomes the vertical viewport the dependency declines to be. `overflow-x-hidden`
  is load-bearing rather than tidy — an `overflow-x` left `visible` beside a
  scrolling Y axis computes to `auto`, stacking a second, permanently empty
  scrollbar on the real one inside the shadow root.

  Nothing about the horizontal axis moves, and the selection bug that
  `overflow: 'scroll'` exists to prevent does not come back. Verified in Chrome
  after the change, on the same 61-line body: a wheel down takes the wrapper's
  `scrollTop` from 0 to 1013 with `window.scrollY` still 0, a drag on the 15px
  scrollbar takes it to 636, `PageDown` and the arrows keep the caret in view,
  typing past the bottom edge scrolls one line to follow it, and a horizontal wheel
  still moves the 1463px first line inside its 657px box. Every line box is exactly
  one line-height tall, and `Shift+End` from offset 7 of that first line still
  selects to the end of the LOGICAL line.

  The query console (`h-56`), both transform panes (`h-72`, `h-32`) and the
  workflow canvas's code sheet were all affected and are all fixed by the one
  change. The history sheet's diff never was: `MultiFileDiff` is given no fixed
  height there, so it grows to its content and the page scrolls it.

  **Known, and not fixable from outside the shadow root.** The horizontal scrollbar
  belongs to `[data-code]`, which is document-height, so it is drawn at the bottom
  of the DOCUMENT rather than at the bottom of the visible box. A horizontal wheel
  or trackpad swipe works from anywhere in the box; the scrollbar itself only comes
  into view once you have scrolled to the end.

## 0.17.0

### Minor Changes

- 220918f: A real code editor, and a diff against the version you have not saved yet

  **The bug.** Selecting `checked_fields` in the SQL box and cutting gave back
  `checked_fields-` — one character more than was selected — and the caret reported
  being on "the final line + 1". The two-layer editor (a transparent `<textarea>`
  over a Prism `<pre>`) was the obvious suspect and was innocent: measured in
  Chrome, the two layers chose identical wrap positions on 3,725 fuzzed bodies at
  fifteen widths, plus tabs, CJK, emoji, RTL, combining marks, unbreakable runs,
  trailing spaces at a wrap point, blank lines and a trailing newline. The cause
  was soft wrapping itself. `Home`/`End`/`Shift+End` and the vertical arrows move
  by VISUAL row, the line wrapped after `checked_fields-`, and with no gutter
  nothing on screen admitted that a thirteen-line query was occupying fourteen
  rows.

  **The change.** `ui/code-editor.tsx` is now `@pierre/diffs` in edit mode:
  horizontal scrolling instead of soft wrap, line numbers, Shiki highlighting, a
  real document model and a real undo stack. One component, used by the query
  console, the transform editor, and the transform code sheet on the workflow
  canvas. The history sheet's comparison is the same library's diff, with
  word-level highlighting inside a changed line.

  **New.** The history sheet can now diff the buffer in the editor against the
  newest recorded revision, as `Unsaved edits` — the answer to "what have I changed
  since I last saved", which this console could not give. `SavedQuery` still has no
  `version` field, so the buffer is not given a number; not being nameable was
  never a reason not to compare it.

  **Breaking, in the 0.x sense.**

  - `prism-react-renderer` is no longer a peer dependency. `@pierre/diffs`
    (`>=1.3.3`) is.
  - `diffLines`, `foldUnchanged`, `DIFF_MAX_CELLS`, `DIFF_CONTEXT_LINES`,
    `DIFF_MIN_FOLD` and the `DiffLine`/`DiffOp`/`DiffSection`/`LineDiff` types are
    gone, with `diff/line-diff.ts`. Their docblock argued that a diff of somebody's
    code and SQL was not worth a supply-chain question mark, so there was no
    dependency at all; that argument does not survive the same package becoming the
    editor those strings are typed into.
  - `CodeEditor` drops `textareaRef`, `padding` and `fontSize`, and gains
    `handleRef` (`focus`, `insertAtCursor`). `onKeyDown` now fires in the capture
    phase on the wrapper and takes a `KeyboardEvent<HTMLDivElement>`.
  - New exports `codeEditorRoot` and `codeEditorText`: the editor renders into a
    shadow root, so Testing Library queries do not reach its content.

  **What contentEditable costs.** Checked in Chrome rather than assumed. Screen
  readers still get a labelled multiline textbox: the editable element is
  `role="textbox" aria-multiline="true" aria-label="<label>"`, and its accessible
  value is the whole document — nothing here is virtualised. What is gone is
  form-control semantics: it is a `<div>`, with no `value` property, no form
  participation, no `<label>` to associate, and each line is a row of per-token
  `<span>`s rather than one text node. Tab indents rather than moving focus, which
  was a keyboard trap until `CodeEditor` took Escape (park focus on the wrapper)
  and Tab (leave for the next tab stop outside the component).

  **Size.** `prism-react-renderer` was ~86 KB minified / 26 KB gzipped, in one
  piece. `@pierre/diffs` brings Shiki, which is a different order of thing.
  Measured by bundling exactly the imports `ui/code-editor.tsx` and
  `diff/RevisionDiff.tsx` make, with React external (`vite build --lib`,
  esbuild-minified): the entry chunk is 943 KB minified / 234 KB gzipped, and
  Shiki's language and theme registries split into a further 318 chunks — 10.6 MB
  minified, 2.0 MB gzipped, of which a SQL console touches four. Installed, the new
  subtree is 26 MB (`@pierre/diffs` 10, `@shikijs/langs` 9, the rest 7).

  Those lazy chunks are pruned by the `shikiSubset()` build plugin in the changeset
  beside this one, which takes the same measurement to 8 chunks / 1.8 MB. The entry
  figure is not improved by it and is the honest cost of the dependency.

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

- 220918f: Only the four grammars this console renders

  **The defect.** The changeset beside this one swapped a hand-rolled editor for
  `@pierre/diffs`, which resolves a language by looking its name up in Shiki's
  `bundledLanguages` — ~240 entries whose values are
  `() => import('@shikijs/langs/<name>')` — and a theme the same way through
  `@pierre/theming`. A bundler cannot tree-shake a dynamic import selected by a
  runtime key, so it emits a chunk for every entry. `packages/dashboard`'s SPA came
  out as **319 JS chunks, 12.42 MB minified**, of which 242 were grammars (7.47 MB)
  and 75 were themes (1.58 MB), for a console that renders SQL, JSON, TSX and
  Python in two palettes. This library's contract is that embedding it must not
  degrade the host, so that is a defect and not a tradeoff.

  **The measurement, and what it does not say.** Built twice from the same tree,
  with and without the fix:

  | `packages/dashboard/dist/spa` | before                        | after                |
  | ----------------------------- | ----------------------------- | -------------------- |
  | entry chunk                   | 2836.1 KB min / 867.1 KB gzip | 2826.5 KB / 861.8 KB |
  | JS chunks                     | 319                           | 8                    |
  | total                         | 12.42 MB min / 2.62 MB gzip   | 3.67 MB / 1.10 MB    |
  | on disk                       | 12.50 MB                      | 3.75 MB              |

  **The entry barely moves, and that is the honest headline.** Every one of those
  grammar chunks was already lazy — none of them was on the first-paint path — so
  this buys nothing at all for time-to-interactive. What it buys is 8.75 MB and 311
  files that a host no longer builds, uploads, caches or pays for at the CDN, and a
  `dist/` whose contents can be accounted for. Installed size is unchanged: the
  grammars are still in `node_modules`, they are simply no longer bundled.

  **How.** A new build plugin, on its own subpath so it never reaches a browser
  graph:

  ```ts
  import { shikiSubset } from "@dudousxd/nestjs-catalog-react/bundler";

  export default defineConfig({ plugins: [react(), shikiSubset()] });
  ```

  It rewrites every `import('@shikijs/langs/…')`, `import('@shikijs/themes/…')` and
  `import('@pierre/theme/…')` outside the subset into a loader that rejects naming
  the grammar it wanted. There is then no `import()` for Rollup to split on, so
  there is no chunk — where resolving those specifiers to a stub module would have
  left ~320 chunks, only tiny ones.

  **It cannot quietly stop working**, which is the part that matters more than the
  megabytes. Four independent gates:

  - `CodeEditor`'s `language` prop and `DiffBody`'s are now `CatalogCodeLanguage`,
    derived from the set. A grammar the bundle does not carry is a compile error at
    the call site. **This is breaking in the 0.x sense** — the prop was `string`.
  - `TRANSFORM_HIGHLIGHTED_AS` says what each transform language is highlighted as
    and `satisfies Record<TransformLanguage, CatalogCodeLanguage>`, so a fourth
    entry in `TRANSFORM_LANGUAGES` is a compile error until somebody answers for
    it. It replaces `language === 'python' ? 'python' : 'tsx'` in
    `TransformEditor`, which answered a fourth language silently and wrongly.
  - `shikiSubset()` fails the **build** if any kept name is missing from the
    registry it prunes, or if a registry never reaches it at all — so a Shiki
    rename, a typo, or a generated shape this no longer matches stops the build
    instead of silently pruning nothing.
  - A spec scans this package's sources for `language="…"` and `lang: '…'` literals
    and fails on one the bundle does not carry, which is the only gate that sees a
    `lang` handed straight to `@pierre/diffs` past our own prop types.

  **New exports.** `shikiSubset` and `ShikiSubsetPlugin` from
  `@dudousxd/nestjs-catalog-react/bundler`; `CATALOG_CODE_LANGUAGES`,
  `CATALOG_CODE_THEMES`, `CatalogCodeLanguage`, `CatalogCodeTheme` and
  `TRANSFORM_HIGHLIGHTED_AS` from the main entry.

  **The set, and why it is that set.** `sql` (the query console and a saved query's
  diff), `json` (the transform editor's sample pane), `python` and `tsx` (its code
  pane). TSX covers both JavaScript and TypeScript transforms because it is a
  superset of each; shipping those two grammars beside it would be another 366 KB
  of `@shikijs/langs` for output no reader could tell apart. The themes are `pierre-light` and
  `pierre-dark`, which is what `@pierre/diffs`' `DEFAULT_THEMES` resolves to and
  what this package never overrides — Shiki's own 65 and Pierre's other eight are
  reachable only by naming one, which nothing here does.

  **Still there:** the 622 KB `shiki/wasm` chunk. `@pierre/diffs` defaults to the
  JavaScript regex engine and only fetches the WASM one if a caller asks for
  `preferredHighlighter: 'shiki-wasm'`, so it is emitted and never loaded — but it
  is a capability a caller can legitimately want, and pruning it would take that
  away rather than take away waste.

## 0.16.0

### Minor Changes

- 800a61b: The Model screen says whether a load of this type would be refused

  A type with no delete strategy declared has its **incremental** loads refused —
  that is what `CATALOG_LOAD_EXPECTATIONS` is for, and until now the only way to
  find out was to run one and read the failure, or to have an engineer put the
  answer in code and deploy. The type panel now carries a section that says it
  outright, and lets an operator set it.

  What it shows: the resolved delete strategy, the `because` as **prose** rather
  than as a config value — it is a sentence somebody is accountable for — who set
  it and when, the row-count bounds, and a table saying, field by field, which
  layer won. Field by field because the resolution is: a deployment can pin the
  row-count bound in code and say nothing about deletes, and one badge for the
  whole expectation would have to pick one of those and be wrong about the other.

  What it refuses: a `because` that is empty, for every one of the three
  strategies — the button is disabled and the form declines to submit, because
  Enter in a text field is not a pointer. A `periodic-full-reload` with no
  interval, or one that is not positive. And a write to a field this deployment
  fixed in code: those controls are **shown, explained and disabled**, never
  hidden, and the body omits them rather than echoing the host's value back into a 409.

  Nothing here is a fourth strategy. The select is built from
  `DELETE_RECONCILIATION_STRATEGIES`, the same list the server validates against,
  so the dropdown cannot offer something the route would reject or miss something
  it would take.

  `CatalogClient` gains `loadExpectation`, `setLoadExpectation` and
  `clearLoadExpectation`, and `PipelineRoutes` gains the two paths behind them.
  The writes deliberately return `unknown` and the screen refetches: what belongs
  on screen is the resolved expectation, and merging a stored row with what the
  host declared is the server's job, not a cache write's.

  A host that serves no pipeline endpoints gets a section that says it could not
  read the expectation, which is not the same sentence as "nothing is declared" —
  only one of those means a load is being refused.

## 0.15.0

### Minor Changes

- 472d1d2: Why Tuesday's load came out different from Monday's

  A connector run records `transformVersion` and the runs list has been rendering
  it as `code v3` — a number naming code that existed nowhere, because a
  transform's `version` counts saves of a row overwritten in place. Revisions fix
  the storage. This is the screen on top of them.

  `code v3` on a run is now a control. Pressing it opens the version that **ran**
  against the version that is **current**, which is the comparison somebody
  standing in front of a surprising load actually wants, rather than a pair of
  dropdowns and a version number to carry across screens. The two selects are
  there as the fallback, defaulted so nobody has to touch them. The same panel is
  reachable from the transform editor and from a row in the saved-query list.

  **No dependency was added.** The line diff is `diffLines` — an LCS over the
  changed region after trimming the common prefix and suffix, in a file with no
  imports. A transform is executable code and a saved query is somebody's SQL
  against real data; those are the two strings in this product least worth handing
  to a package on every render, and this package already declines dependencies for
  weaker reasons (`charts/css.tsx`, `ui/button.tsx`, `export/pdf.ts`). `diffLines`
  and `foldUnchanged` are exported, so a host can render the comparison its own way
  without writing one.

  Long bodies: unchanged stretches fold to a control that opens them, three lines
  of context either side; the row count is capped and says how many it is holding
  back. Line **content** is never truncated — two lines cut into equality would be
  reported as unchanged, which is the one thing a diff must not do. That is why
  this does not follow `capLines`, whose bound is about what a checkpoint may hold
  rather than what a reader may see.

  An empty history is honest about being empty. "Nothing recorded", "one version
  recorded", and "the run used a version the history does not contain" each say so
  in their own words, and none of them borrows the sentence that belongs to two
  versions that really are byte-identical.

## 0.14.0

### Minor Changes

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

- ef7d16b: The credential fields leave the console's screens

  The connector editor and the workflow source node each offered a "Credential env
  var" field beside the address. Two doors for one decision, and the question it
  produced was "what is this second field" — a form asking the reader to
  understand its implementation.

  The credential goes in the connection string. Where that string may **rest** is
  the store's decision — `allowInlineCredentials`, and the secret vault behind it
  — not a question for a form, and not one whose answer changes per connection.

  `secretEnvVar` is untouched on the model and `CredentialField` is still
  exported, so a deployment that wants the name-only path can mount it. It is no
  longer the console's default story.

### Patch Changes

- 117e471: The workflow canvas told people off for clicking "+", and gave them no way to draw a wire.

  ## A node reported problems the instant it was created

  Clicking **+ Sink** produced, in the same breath:

  > Node "Sink" (sink_3b5a…) is not reachable from any source, so it would never run. Wire a source
  > into it or delete it — a node on the canvas that silently does nothing is the thing this check
  > exists to prevent.
  >
  > "Sink" does not say which object type it writes, so there would be nothing for the run to commit
  > into.

  Every word true, every word useless: a node that was just added is unwired and unconfigured **by
  construction**. Nobody had had a chance to do either.

  Worse, it is expensive. That prose was written for somebody about to save a graph that would
  silently do nothing, and firing it at somebody mid-click is exactly how a validator becomes
  something people scroll past — which is the failure `workflow/validate.ts` opens by describing.

  The canvas now separates **incomplete** from **wrong**. A node the author has not finished is a
  to-do; a node the author _thinks_ is finished and is not is a problem, and only the second gets the
  checks' own language.

  - A node added in this editing session goes into a set of unstarted nodes. Checks naming only
    unstarted nodes are presented as outstanding work — a "Still to do" panel in the rail and in the
    inspector, one line per node, each check rewritten as an imperative ("choose the object type it
    commits") rather than repeated as an accusation. The node is not ringed red and does not carry an
    error icon.
  - It leaves that set the moment anybody **acts** on it: any field edited, any wire added or removed
    at either end. That is the answer to "a node touched once and abandoned" — acting on a node and
    stopping is precisely the statement "I think this is done", which is the case the long wording
    was written for. Dragging a box is deliberately not an act: it arranges the picture and says
    nothing about whether its author is finished, and no check reads a position.
  - The set is component state. It is never saved, never sent, and empty after a reload — a node that
    came back from the server is one somebody saved and walked away from.

  **Nothing is suppressed, and that is load-bearing.** `hasBlockingProblem` is still asked about every
  check, held back or not, so Save is coloured as refused from the moment the graph would not run —
  with a tooltip that names the unfinished nodes instead of pointing at an error list that is empty.
  And pressing Save clears the held-back set outright, before the request: a save attempt is the
  declaration that the graph is finished, so every check gets its full wording next to whatever the
  server answers. A graph that would silently do nothing still cannot be saved unnoticed.

  New nodes are also named uniquely — `Sink`, `Sink 2`, `Sink 3` — because `Sink (sink_3b5a…)` above
  is what a message falls back to when the name it was given identifies nothing.

  ## There was no way to connect from a node

  The only gesture that made an edge was a drag between two React Flow handles. Perfectly
  discoverable to somebody who has used a node editor before, invisible to everybody else — the
  canvas read as needing prior knowledge of the library behind it. The keyboard paths (the wiring rail,
  the inspector's picker) were the answers for keyboard users and still are, but reaching either means
  knowing to open a panel first.

  There is now a **Wire** control on the node under the pointer, or on the single selected node, on
  React Flow's own `NodeToolbar` so the placement comes from the same measurements the canvas draws
  with. Its menu offers:

  - **an existing node** to send this one's output to;
  - **a new node**, created and wired in one action;
  - **disconnect**, for each wire this node already has — removing one otherwise means finding a
    two-pixel line on a canvas.

  What it offers is what the graph allows, and it does not know what that is: every option is filtered
  by `canConnect`, the same function that refuses the drag, and the "new node" kinds are found by
  building a throwaway node of each kind and _asking_. Nothing here restates the rule that a source may
  feed a transform or a sink and that nothing follows a sink. Offering an edge that is then rejected
  teaches somebody the menu is a guess.

  A created node lands one column right of the node that spawned it — which is not a guess either:
  `layout` puts a node one column past the deepest thing feeding it, and this node is fed by that node
  and nothing else — then drops a row at a time until the spot is free. Under the cursor, on top of
  something, and off-screen are each wrong in their own way. The same "New transform" / "New sink"
  action is in the inspector too, because the menu is a pointer affordance and cannot be anything else.

  ## A transform node on a fresh catalog was three dead ends at once

  Opening one on a deployment with no transforms gave an error, a promise the screen could not keep,
  and a button that answered clicks with silence:

  - **"Choose a transform…" over an empty list.** The way out was on another tab and nothing said so.
    It now says the catalog is empty and offers **Write the first transform**, which creates one
    through `saveTransform`, points the node at it and opens its code. Created here rather than by
    opening the editor empty, because the editor reports _that_ it saved and not _what_ — so the
    canvas would have had no id to put on the node and the person would have come back to the same
    empty picker. Its starter code is the identity, `return records`, in the deployment's own first
    language: the smallest thing that actually runs.
  - **"Open the code" was correctly disabled and did not look it.** `opacity-40` reads as faint, not
    as off, so it got clicked. It is no longer rendered until there is code behind it.
  - **The vocabulary made two things look like one.** A field called "Transform", inside a sheet
    describing a transform node, asking you to choose a Transform — "the transform node needs another
    transform, it reads a bit strange", and it does. The model is right: a `CatalogTransform` is named,
    reusable code, deliberately shared between connectors and graphs, and a node is a _position_ in a
    graph that runs some. The field is now labelled by what it asks for — **Code it runs** — and says
    in one line why the two are separate.

    The node is deliberately **not** renamed. Half its vocabulary — `defaultLabel` and the badge it
    draws itself with — lives in `workflow/`, so renaming here would produce a step called "Step"
    wearing a badge that says TRANSFORM: the same disease with an extra word in it.

  The three add buttons also gained accessible names (`Add a sink node`), because heard on its own
  "Sink" is a heading, not a control.

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

## 0.13.0

### Minor Changes

- cb486cf: The query and dashboard screens open what the URL names

  Last release mounted the search box and said plainly that two of its four kinds
  of link were half-honest: `#query?savedQuery=…` and `#dashboards?dashboard=…`
  landed on the right **screen** and stopped, because `QueryConsole` took only
  `onGenerate` and `maxRows` and `DashboardBoard` took no props at all. The id
  rode in the address bar unread, and somebody who clicked a result for a specific
  dashboard got whichever board the component had picked for itself. That is worse
  than not navigating: nothing on screen says the link failed. It also broke the
  ordinary thing people do with a console, which is send somebody a link.

  **Both screens now read the id, from the same two places `ObjectExplorer` does.**
  `QueryConsole` takes `savedQueryId`, `DashboardBoard` takes `dashboardId`, and
  each falls back to reading its parameter out of the hash — the precedent, and
  the reasoning, `ObjectExplorer` already argued: the host is the one that knows
  where its router keeps parameters, so it passes what it parsed, and the self-read
  is the convenience for a host that does not route. Both props follow the prop
  whenever it changes, not only on the first render, because navigating from one
  saved query to another is how you arrive here a second time.

  **An id naming something that is gone is refused out loud.** A deleted board, a
  saved query somebody else removed. Falling back to the first row is what makes a
  stale link look like a working link showing the wrong thing, so neither screen
  does it any more: the dashboard board says _"That dashboard is not here"_ and
  quotes the id, the query console says the same above an editor it leaves
  untouched, and the address is left naming the dead id — rewriting it would erase
  the only evidence of which link broke. The old fallback survives for the case it
  was right for, which is nobody having named anything: arriving at `#dashboards`
  with no parameter still opens the first board.

  **The address follows what you select, so a link can be copied out of it.** Both
  screens report the selection through `onSavedQueryChange` / `onDashboardChange`
  rather than writing the URL themselves — reading a URL is an observation, but
  writing one is an act with effects outside a component's box, and a console
  mounted inside somebody else's page should not find a library appending
  parameters to its address. Omit the callback and nothing writes, which is exactly
  what an existing host gets.

  The shipped console wires both up, and writes with `history.replaceState`. That
  is the whole of the history question: assigning `location.hash` would push an
  entry per selection, so clicking through eleven dashboards would leave eleven
  presses of Back between you and the screen you were on before. Replacing keeps
  the address naming what is on screen — which is all a copyable link needs — and
  costs nothing to leave.

  `SavedQueryPanel` also marks which of its rows is the one currently in the
  editor, so a console that filled the editor from a link says where the SQL came
  from.

  A spec holds **both ends**: it reads the href off the rendered search row and
  follows it, then asserts the named saved query and the named board are what
  appear. The parameter is spelled twice — once where the link is generated and
  once where the screen is handed it — and nothing but that test makes the two
  agree.

## 0.12.0

### Minor Changes

- a742ed7: The console mounts the search box, and the barrel names what it was hiding

  `CatalogSearch` shipped last release and nothing rendered it, so finding
  anything in the console still meant knowing which of nine tabs it lived on —
  which is the experience the box was written to replace.

  **It is a route, not a tenth tab.** `#search` can be bookmarked, sent to
  somebody and reloaded, and it is deliberately absent from the tab list: nine
  tabs plus the brand and the pinned controls already need ~1150px, and below that
  the strip scrolls. A tenth would spend ~90px of that budget, and an
  always-visible input several times more, to buy a destination a keystroke
  reaches faster than a click. The way in is a 28px icon pinned beside the
  environment picker — outside the scrolling strip, so it cannot scroll away —
  and **⌘K / Ctrl-K** from anywhere in the console, which opens the screen with
  the cursor already in the box. **Escape** goes back to the screen you were on,
  not to the console's default, so a search opened mid-task does not cost you your
  place.

  **All three hrefs are passed, and two of them promise less than they look like
  they do.** A kind with no href renders as a plain row rather than a link, so a
  box that crosses four kinds and dead-ends on two would be worse than the tabs it
  replaces. `#objects?type=X` is honest end to end — the object explorer is handed
  that parameter and opens on the type, and it is the same string the model screen
  generates for the same destination. `#query?savedQuery=…` and
  `#dashboards?dashboard=…` land on the right **screen** and no further:
  `QueryConsole` takes no saved-query id and `DashboardBoard` takes no props at
  all, so today both open on their own default and the id rides along unread. The
  row still navigates, and the parameter is already in the address for the day
  either screen learns to read it.

  **Newly exported from `@dudousxd/nestjs-catalog-react`**, all of them reachable
  from something the barrel already exported and from nowhere else:

  - `SchemaDiscoveryBridge`, `ConnectorSchemaDiscovery`, `DiscoveredColumn`,
    `SchemaDrift`, `DiscoveredTypeDraft`, `ColumnChoice` — the whole schema
    discovery seam. `PipelineConsoleProps.schemaDiscovery` is a bridge the **host**
    implements, and the only way to write one with its signature spelled out was
    an indexed access on a component's props, or a deep import into `dist/`.
    `initialChoices` and `proposalFrom` come with them: they are the pure rules
    that decide whether a schema somebody ticked is one the publish route will
    accept, and they are worth nothing outside the panel if rendering the panel is
    the only way to run them.
  - `CatalogPeoplePage` and `PeopleQuery` — the reply and the argument of
    `CatalogClient.listPeople` and `AccessRoutes.people`. Both interfaces were
    exported; neither of the two types their one method takes was. Typing the
    reply as `CatalogPersonSummary[]` instead is the exact mistake that method's
    own docblock warns about — it drops `total`, and a screen that ignores `total`
    under-reports who has access.
  - `DEFAULT_PUBLISH_BASE_PATH` — the third of three defaults, with the other two
    already exported, so `CatalogProviderProps.publishBasePath` documented a
    default a host could not name.
  - `WorkflowProblemLevel`, `WorkflowDraft`, `ValidateOptions` and
    `DurabilityCopy` — the level on an exported problem, the two arguments of
    `validateWorkflow`, and what `describeDurability` answers with.

  A spec now sweeps the five modules the barrel re-exports from and fails when one
  of their names is missing, rather than trusting a hand-maintained list — the
  third time in this repo that a list fell behind the module under it.

## 0.11.0

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

## 0.10.0

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

## 0.9.0

### Minor Changes

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

- d62e481: Sharing can be switched on from the console, and the export link follows the host

  **A dashboard can be shared, which means the embed API is reachable at all.**
  `CatalogClient.saveDashboard`/`updateDashboard` did not name `shared`, so
  `updateDashboard(id, { shared: true })` was a compile error and no screen ever
  sent it. `shared` is the entire access boundary of the embed API, so every
  dashboard a shipped console produced answered `403` from `embedDashboard`, and
  `<EmbeddedDashboard>`'s "Nothing on this dashboard has been shared" was not an
  empty state but the only state the component had. The server anticipated exactly
  this one layer down — `patchDashboard` declares the field so a whitelisting
  `ValidationPipe` cannot strip it — and the client type dropped it again.

  Both writes name it now, and the board carries a control: the state, a sentence
  saying who can reach the board while it holds, and a button naming the
  transition. Not a switch — the server records this crossing as an event, in both
  directions, and a control for an audited act should say where you are before it
  offers to move you.

  **A saved query can be un-shared.** `shared` was settable only when the query was
  first saved, and `updateSavedQuery` — which accepts it — had no call site
  anywhere, so a query shared by mistake could only be un-shared by deleting it.
  The list now marks a shared query without waiting to be hovered, and offers both
  directions.

  **`exportUrl` no longer hardcodes `/api`.** It was the one method on
  `CatalogClient` that bypassed the injected transport, in the component most
  likely to run inside somebody else's page. `CatalogTransport` gained an optional
  `url(path)`, and the export link is built from it like every other request.

  > **Hosts should implement `url` on their transport.** It is optional, so
  > nothing stops compiling — but a transport that does not answer gets the path
  > exactly as written, which is right only where the catalog API is served from
  > the root. If yours prepends a base (an axios `baseURL`, a gateway prefix), add
  > `url: (path) => \`${base}${path}\``or the CSV export will 404. Hosts that were
mounted under`/api` were previously right by accident.

  **`CatalogApiSessionGuard` is a host-appliable primitive, and says so.** It
  documented itself as gating `CatalogApiController`, a class that exists nowhere,
  and was bound to nothing. It cannot be bound here: the catalog's JSON API is
  mounted in the host's own tree and deliberately not proxied through the console.
  The module now provides and exports it, so `app.get(CatalogApiSessionGuard)` —
  how a host puts it in front of a whole API surface — resolves.

  **`dashboardAuth` no longer claims to gate the JSON API.** It gates the SPA
  shell, and only that; the option's own docblock said "BOTH the SPA and the JSON
  API", which left a host that configured `auth` and stopped reading with its rows,
  ad-hoc SQL and connector runs on whatever guarded the API before. The docblock
  now points at the two seams that close it, `readCatalogConsoleSession` and the
  guard above.

  **The CSRF rationale names the flag the code actually sets.** The console's
  transport justified `credentials: 'same-origin'` with a `SameSite=Strict` cookie;
  `serializeSetCookie` has only ever emitted `Lax`. Lax is kept — `Strict` costs
  nothing on the flows this package ships but withholds the cookie from a top-level
  navigation arriving from another site, which is how a console gets linked to —
  and the guarantee is restated accurately: Lax covers cross-site `fetch`, `XHR`
  and form POSTs, and permits a cross-site top-level GET. The one state-changing
  GET that leaves exposed, `GET logout`, is argued once, where the route is.

### Patch Changes

- c02c36f: Every dropdown follows the theme, because none of them is a native select any more

  Six controls were raw `<select>` elements against sixteen using the vendored
  one. A native select draws its option list with the platform's own widget: the
  list stays light on a dark console and no class can reach it. On the dark
  surface the console now wears, they were unreadable.

  They are all `Select` now — the Base UI one this package already vendored — so
  the list is markup that inherits the theme like everything else. Converted: the
  environment picker in the nav, the card's chart-library picker, both governance
  filters, and both visualization pickers in the save panel.

  Two things fell out of the conversion:

  - The options that needed a **second line** can have one. `SelectOption.hint`
    already existed, described as "the reason a native option was not enough", and
    it is exactly what the card picker's default needed to say the query names a
    library nobody installed. A native `<option>` is one line of unstyleable text.
  - The chart-kind picker had a `as 'table'` cast on the raw event value. It is a
    lookup against one exported list now, which the picker also renders from — so
    a kind added to the union appears in the dropdown instead of being silently
    absent from it.

- 3becb3a: Say which library is actually drawing, not which one was asked for

  Found on a real board the moment the card picker shipped: a saved query named
  `visx`, nobody had registered it, and the card drew the built-in bars — correctly
  — while the control read "follows query (visx)".

  The fallback is right and it is silent, so the label has to be the thing that
  says so. It now reads "follows query (visx — not installed, drawing built-in)".

  A control that reports an intention the card is not honouring is worse than one
  that reports nothing: it is the exact failure the picker was built from a
  registry to avoid, arriving through the default option instead.

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

## 0.8.0

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

## 0.7.2

### Patch Changes

- dbe7928: Stop the tab strip leaking its scroll extent onto the page

  The console still scrolled sideways on a narrow screen — by 189px at 809px wide
  — and the cause was the fix for that same bug.

  Bringing the selected tab into view needs a ref on the tab, and `TabsTab` did
  not forward one, so the strip rendered a zero-size `sr-only` marker inside each
  tab and used that. Tailwind's `sr-only` is `position: absolute`, which escapes
  the strip's `overflow-x` clipping: each marker reported its static position —
  out where its tab sits in the strip's full scroll extent — and the document grew
  to contain them. The page then scrolled by exactly the amount the strip was
  hiding.

  `TabsTab` forwards a ref now and the marker is gone.

  Proven on the running console rather than argued: removing the nine markers took
  `documentElement.scrollWidth` from 998 to 809, and putting them back restored 998. An isolated harness did NOT reproduce it, which is worth saying — the
  evidence for this is the experiment on the real page, not a reduction.

## 0.7.1

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

## 0.6.0

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

## 0.5.0

### Minor Changes

- 3214fc7: One code editor, themed by the console instead of against it

  The query console and the transform editor each carried their own copy of the
  same overlay editor — a transparent `<textarea>` over a highlighted `<pre>` —
  with the same two boxes, the same three comments, and only one of them taught
  about anything but its own language. They now share `ui/CodeEditor`.

  **It was unreadable.** Both copies passed `themes.github`, a light Prism theme
  that paints keywords a dark red and strings a dark blue. That was invisible for
  as long as the console was light and became dark-on-dark the moment the console
  went dark: the editor still worked perfectly, you just could not read what you
  were typing. The theme is now defined against the same `--text` / `--muted` /
  `--accent` variables the shell sets, so the two cannot drift apart again.

  **The sample-records pane gets highlighting too.** It was the one that stayed a
  bare textarea, so the JSON you debug a transform against rendered flat grey
  beside a coloured transform — and a missing brace in a sample is exactly what
  highlighting finds for you.

  Two smaller things found while extracting it: the theme's `plain` was never
  applied, because `Highlight`'s `style` was not spread onto the `<pre>`; and
  `leading-[1.5]` was being dropped by tailwind-merge, which treats a
  `text-{size}` utility as able to carry a line-height and discards a `leading-*`
  written before it. Both layers agreed, so the caret never drifted — the intended
  line-height simply was not there.

  Still a textarea rather than CodeMirror, and deliberately: the platform's
  textarea already has the caret, selection, undo, IME and every accessibility
  affordance, and a controlled document-model editor has to reimplement all of it
  — the classic symptom being a caret that jumps to the end when the value updates
  from outside. What is missing is autocomplete and bracket matching, which
  nothing here asks for.

- 93ed05b: Every table on TanStack Table v9

  Four screens hand-rolled `<table>` markup with the same header row, the same
  hairlines and the same "numbers go right" rule, each slightly differently. They
  now share `ui/DataTable`, and there is no raw `<table>` left outside `ui/`.

  **Sorting is a prop, not a row model, and that is the load-bearing decision.**
  The object explorer sorts, pages and searches on the SERVER, because it reads a
  warehouse table that does not fit in a browser. Handing those columns to
  `createSortedRowModel` would sort the rows currently on screen and present the
  result as though it were the whole answer — a worse bug than no sorting at all,
  because it looks right. So the header renders the affordance and reports the
  click, and the caller decides whether that means a refetch or a reorder. A test
  asserts the rows come out in the order they went in.

  What each screen gained:

  - **Query results** and the **dashboard card preview** shared a value-rendering
    ladder that they each had a copy of. `renderUnknown` is now one function, and
    it keeps `0`, `false` and `''` visible — the `value || '—'` shorthand erases
    all three and nothing reports it.
  - **The object explorer** keeps its server-side sort, and `aria-sort` moved onto
    the column header where a screen reader announces it as part of the column;
    on the button it read as "this control is sorted".
  - **The property editor** declares its six columns once, with their widths beside
    their contents rather than in a separate header row kept in the same order by
    hand. The widths stay fixed on purpose: those cells hold inputs, and a
    content-sized column reflows the table on every keystroke.

  `@tanstack/react-table` joins the peer dependencies at `>=9`. v9 is opt-in per
  feature rather than v8's batteries-included table, so a table that never groups
  does not ship the grouping code — this one registers the core features and
  nothing else. Two things about its API worth knowing: the row model factories
  live inside `features` rather than in a sibling option, and `useTable` needs
  explicit type arguments, because `columns` and `data` are two inference sites
  for the same pair and TS falls back to the constraints with a third parameter
  in play.

## 0.4.0

### Minor Changes

- 939b747: A real Tabs in the console nav, a Button component, and arrows when tabs are hidden

  **Tabs.** The nav was a row of `<button>`s, which looks like tabs and is not:
  no roving tabindex, no arrow-key movement between them, and no `aria-controls`
  relationship to the screen each reveals. It now uses the vendored `Tabs` — one
  root around BOTH the strip and the panels, because splitting them would leave
  that last part broken while looking correct. The panels replace
  `{tab === x && ...}` and behave identically: Base UI unmounts the unselected
  ones, so each screen still owns its query and no tab polls while hidden.

  **Button.** `ui/button.tsx`, vendored in the shadcn style with hand-rolled
  variants — matching how `select`, `tabs` and `dialog` are already done here, and
  what `class-variance-authority` would compile to for a component with no
  compound variants. What it buys over a `<button>` with classes is the part
  nobody writes by hand every time: a real focus ring, `disabled` that also stops
  pointer events (a dead button otherwise looks alive right up until it is
  clicked), `type="button"` by default so a button inside a form does not submit
  it, and one place where "what a secondary button looks like" lives.

  **Arrows.** Scrolling the strip fixed the overflow but created a second
  problem: tabs that exist and cannot be seen, with nothing saying so. Each arrow
  appears only when there is something in its direction — a pair where one is
  always dead teaches people to ignore both, and on a wide screen two greyed
  chevrons beside a strip that does not scroll are pure noise. They stay mounted
  and `invisible` rather than unmounting, so the strip does not change width as
  they come and go. Out of the tab order too: keyboard users move between tabs
  with the arrow KEYS, which Base UI already wires.

  `TabsList` now forwards a ref and `TabsTab` takes a `className`, which is what a
  caller needs to measure a strip and give it its own metrics.

  **The dashboard grid.** Its cards were a fixed `grid-cols-4` at every width, so
  on a narrow board a chart's axis labels rendered outside its own card. The grid
  is now driven by CONTAINER queries rather than viewport ones — the board sits
  beside a sidebar, so how much room a card has is a fact about that box and not
  about the window — and a chosen span is only honoured once there are columns to
  spend it on.

## 0.3.0

### Minor Changes

- 09f0a4b: Wear the Aviary console surface, and stop overflowing on a small screen

  **The surface.** `/durable`, `/media` and `/ai-gateway` are one dark product
  distinguished by a single accent, and the catalog was a light console sitting
  beside them. It now uses the same tokens down to the hex — `--bg: #09090b`,
  `--panel`, `--line`, `--text`, `--muted` — and the same Space Grotesk /
  JetBrains Mono pair, which `index.html` was already linking and nothing was
  applying.

  Dark is forced with `class="dark"` rather than left to `prefers-color-scheme`,
  because the set would otherwise be inconsistent on any machine set to light.
  The screens already carried `dark:` variants throughout, so this is a switch
  being thrown rather than a repaint.

  **The accent is sky.** Emerald belongs to durable and media, violet to the agent
  gateway; a fourth console reusing one makes the chrome stop telling you where
  you are. Sky is also not a semantic colour anywhere in the set — the others
  spend amber and red on warn and bad — so it can carry "selected" without also
  implying a state. The component library's accent classes were renamed
  `violet-*` → `sky-*` rather than remapped in the theme, so a reader who greps
  for the colour finds the colour.

  **The overflow.** Nine tabs plus the brand and two controls need ~1150px. Below
  that the strip pushed the whole DOCUMENT sideways — `nav` is `shrink-0` inside a
  flex column, so nothing absorbed the excess and the page itself grew a
  horizontal scrollbar, taking every screen with it. At 809px it overflowed by 345.

  The tabs now scroll in their own container while the brand, the environment
  picker and the store badge stay pinned: scrolling a tab strip is ordinary,
  having the environment you are editing scroll off screen is not. `min-w-0` is
  what makes it work — a flex item defaults to `min-width: auto` and would
  otherwise refuse to shrink. The scrollbar itself is hidden because a native
  horizontal bar here is as tall as the tabs and sits between them and their
  underline; the half-cut tab at the edge is the affordance. Selecting a tab that
  is scrolled out of sight now brings it into view, so arriving on `#access`
  directly no longer opens the last screen with the strip parked at the first.

## 0.2.0

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

### Patch Changes

- 5d10b69: Say `duplicate-sink-type` once

  The workflow canvas raised its own copy of the complaint alongside the one core
  validation already produced, so the same problem appeared twice in two different
  wordings — which reads as two problems, and sends someone looking for a second
  one that is not there.
