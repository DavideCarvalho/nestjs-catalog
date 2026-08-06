# @dudousxd/nestjs-catalog-react

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
