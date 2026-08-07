# @dudousxd/nestjs-catalog-store-mikro-orm

## 0.18.1

### Patch Changes

- 306efba: Fix: a transform created without a mode broke the transform list route

  Create a transform the ordinary way — `POST /pipeline/transforms` with a name,
  a language and some code and no `mode` — and the very next
  `GET /pipeline/transforms` answered **500**, for every transform in the catalog,
  not just that one. Any workflow run reaching a transform node pointed at that
  row failed with it.

  The `mode` column is nullable, so a transform saved without one holds SQL NULL.
  The read path tested the absent case as `row.mode === undefined`, missed the
  `null`, and handed it to the loud enum guard, which refused it with

  > Transform mode "null" on t-… is not one this build knows about. It was most
  > likely written by a newer version of the catalog.

  — blaming the data for being newer than the build when the value is simply not
  there. This was not an upgrade-only hazard: the write path and the read path
  disagreed on a database created the same morning. Absent is now `null` or
  `undefined`, and an unrecognised _value_ is still refused loudly with the same
  message.

  Also: `expectShrink` on `POST /pipeline/workflows/:id/run` is now checked at the
  route. It is typed as a reason (text) and was checked nowhere, so
  `{"expectShrink": true}` reached the sink and crashed with
  `TypeError: expectShrink.trim is not a function` — a 500 for a bad request,
  raised only after the whole source had been read, renamed and filtered. A
  non-text reason is refused with a 400 before the run opens. Absent and a present
  empty string are unchanged: the first means nobody said anything, the second is
  still refused by the sink with its own 400 asking for a reason.

## 0.18.0

### Minor Changes

- 30cec84: A PostgreSQL warehouse store, behind the same interfaces and the same test suite as the MySQL one.

  The store package shipped four classes named `MySql*` and only one of them had earned the name. The pipeline, workspace and trace stores reach their tables through MikroORM's entity API, which is dialect-agnostic; the one thing binding them to MySQL was a type-only import of `EntityManager` from `@mikro-orm/mysql`, which re-exports `@mikro-orm/sql`'s `SqlEntityManager` — the same class `@mikro-orm/postgresql` re-exports.

  The warehouse store writes SQL by hand, so it gets a seam: `CatalogSqlDialect`, with `MYSQL_DIALECT` and `POSTGRES_DIALECT` as values rather than subclasses. `MySqlWarehouseStore` and the new `PostgresWarehouseStore` are one implementation with different dialects bound, and both run `test/catalog-store-contract.ts` — the suite the ClickHouse adapter already runs — against a real engine in testcontainers.

  **Nothing about the MySQL behaviour changes.** The statements it emits are byte-identical and its specs pass untouched.

  **New:** `CatalogMikroOrmStoreModule.forRoot({ dialect: 'postgres' })`. A Postgres host that sets no `contextName` also needs `entityManagerToken`/`mikroOrmToken`, because `@mikro-orm/postgresql` registers its own `EntityManager` subclass; passing a `contextName` avoids the question and is the better answer anyway. `pg` is never a dependency of this package — it arrives through the host's own install, as `mysql2` always has.

  **Two differences a Postgres deployment has to know about**, because closing either would mean the package lying about its engine:

  - Column names are case-sensitive. `assetId` and `AssetID` are two columns on Postgres and one on MySQL, so a model Postgres accepts can be refused by MySQL.
  - Search stays case-insensitive: the dialect uses `ILIKE`, because MySQL's default collation is case-insensitive and leaving `LIKE` would have made a Postgres catalog's search box quietly return fewer rows.

  The environment model is unchanged — one database per environment, not one schema, on both engines. `catalog.environment.ts` now argues why, and its reserved-id list refuses both engines' system databases on both engines so the answer cannot change under a migration.

## 0.17.0

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

## 0.16.0

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

## 0.12.0

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

- 2a2833d: A load stops counting itself once per batch

  `MySqlWarehouseStore.write` ended every batch with

  ```sql
  SELECT COUNT(*) AS total FROM <obj_table> WHERE _snapshot_id = ?
  ```

  The predicate names the **snapshot**, not the batch, so the scan grows with the
  snapshot while the number of scans grows with the load: a load costs
  O(rows² / batch). At `BATCH_SIZE = 500` and the 783,000 rows a deployment's
  Subwo load carries, that is 1,566 scans of an ever-larger range.

  A previous changeset in this series looked at this statement and left it alone,
  on the evidence that it was 15s against the batch `DELETE`'s 821s in a
  deployment's query log. That reading was right about the ranking and wrong about
  what it implied: the `DELETE` was 821s **because it had no usable index and was
  scanning the whole table**, and now that it does, the count is what is left, and
  it is the only term on the path that is quadratic rather than linear.

  Measured on MySQL 8.0 against the 42-column PriBuy shape, three isolated samples
  per size, the scratch schema **recreated between every sample** — without that,
  three identical 50,000-row loads report 14.6s, 34s and 61.6s as the table
  outgrows the buffer pool, which measures the cache and not the code:

  | load                  | before       | after            |        |
  | --------------------- | ------------ | ---------------- | ------ |
  | 50,000 rows + commit  | 4,409ms ±201 | **3,272ms ±85**  | −25.8% |
  | 100,000 rows + commit | 9,596ms ±567 | **6,887ms ±745** | −28.2% |

  The saving grows faster than the data — 1.14s at 50k, 2.71s at 100k, 2.4× for 2×
  the rows — which is the quadratic term leaving. Per batch, the cost stops
  climbing with the load: 44.1 → 48.0 ms/batch before, 32.7 → 34.4 after.

  One `COUNT(*)` in isolation costs 1.7ms over 10,000 rows, 3.9ms over 25,000,
  7.0ms over 50,000 and 14.4ms over 100,000 — linear, as an index range scan
  should be. Multiplied out per load that is 0.03s, 0.19s, 0.70s, 2.87s.

  **Local absolute numbers do not transfer to a deployment.** This machine has 22
  vCPU and a 128 MB buffer pool; the deployment is a `db.t4g.medium` with 300
  baseline IOPS and a 1.5 GB pool against ~36 GB of data. It is not uniformly
  faster or slower — only the ratios and the shape of the curve carry over.

  **Statements per batch fell from 7 to 3.3** (70 → 33 over ten batches, counted
  from MikroORM's query log). `rowCount` was the only field a batch after the
  first one changed, so maintaining it cost an `UPDATE catalog_snapshot` per batch
  as well as the scan; with nothing to change, change tracking issues neither.
  That half is round trips rather than scans, which is what a remote database
  charges for.

  ## Arithmetic is not the answer, and the reason is not the obvious one

  `rowCount += inserted - deleted` is the tempting repair. It fails twice.

  First, **the number is not there to add**. `write` issues its DELETE through
  `connection.execute(sql, params)`, whose default method is `all`. Measured, not
  assumed: that call returns `[]` for a DELETE that removed 300 rows and `[]` for
  one that removed none — the affected-row count is discarded. It is reachable
  only by passing the method explicitly, where `execute(sql, params, 'run')`
  returns `{ affectedRows, insertId, row, rows }`. (The usual `ON DUPLICATE KEY
UPDATE` hazard — updated rows counting 2, unchanged 0, depending on
  `CLIENT_FOUND_ROWS` — does not arise: the object-table INSERT is a plain
  multi-row `INSERT ... VALUES` and the insert count is just `rows.length`.)

  Second, and fatal: **it drifts on the event it exists to survive.** `write` is
  three statements outside a transaction — DELETE, INSERT, then the snapshot row's
  flush. A crash between the INSERT and the flush leaves the table holding N rows
  the snapshot row was never told about; the retry re-sends the batch, deletes
  those N, inserts N, nets zero, and the snapshot is permanently N rows short.
  Counting has no such window — it reports what is there whenever it is asked, so
  a replay converges instead of accumulating error. Making arithmetic safe would
  mean putting all three statements in one transaction, which is a much larger
  claim than this class makes today (`transactional: false`).

  ## So it is still counted — once per read, not once per batch

  `commit` counts the snapshot it is about to publish, which makes the stored
  number final and authoritative for every later reader of that committed row.
  `listSnapshots` counts the **uncommitted** snapshots it reports, in one grouped
  statement, because that is what `PublishService.assertRowCountIsPlausible` reads
  the pending snapshot's size from — and it runs _before_ `commit`, so a count
  taken only at commit would arrive after the check that needs it. Committed rows
  are not recounted: `commit` is the only thing that sets the flag, and it sets the
  count in the same flush. `carryForward` already counted from the table and still
  does, once, as part of the statement that tells it how many rows it carried.

  Both properties the old comment bought are kept and are now covered by tests
  that fail without this change: a replaced batch does not double-count, and a
  snapshot whose stored count has drifted commits at the size the table actually
  holds.

  **One observable change.** `catalog_snapshot.row_count` is no longer maintained
  while a load is in flight, so a host reading that column directly for an
  uncommitted snapshot now sees `0` rather than a partial total. Everything that
  goes through the store — `commit`, `listSnapshots`, `currentSnapshot`,
  `carryForward` — reports the true size, and the row-count bound is unaffected.
  Committed rows written by earlier versions are already correct and need no
  backfill.

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

### Patch Changes

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

- ae76198: The activity screen pages off an index instead of grading the whole trail

  `GET catalog/events/traces` cost work proportional to the entire audit table on
  every request, no matter that it returns 25 traces. On 21k rows the default page
  took 151ms against 11ms for the unaggregated `GET catalog/events` beside it; on
  622k rows it took 9.2s, with one sample at 216s.

  It was not a missing index. The table's four indexes are the right four, and the
  statement could not use any of them: every filter was written against a `scoped`
  CTE — the whole linked half of the table, `detail` column included, spooled into
  a temporary table — rather than against `catalog_audit_event`, so there was
  nothing indexed left for the optimiser to reason about. `EXPLAIN ANALYZE` showed
  the table read three times and sorted once to return 289 span rows.

  Two changes. Every CTE now reads the base table, so the conditions reach the
  indexes. And when the caller has not filtered by outcome — which is what the
  explorer asks on load — the page is chosen _before_ anything is graded, by
  `GROUP BY snapshot_id ORDER BY MIN(occurred_at)`, which MySQL answers as a
  covering skip scan over `(snapshot_id, occurred_at)` without reading a row.
  Aggregation, JSON parsing and the span join then run over the ≤ 200 traces that
  survived rather than over everything ever recorded.

  Measured through the store against MySQL 8.0, median of seven:

  |                           | 21k rows         | 622k rows           |
  | ------------------------- | ---------------- | ------------------- |
  | default page              | 151ms → **20ms** | 9,234ms → **453ms** |
  | `?offset=500`             | 150ms → **25ms** | 7,760ms → **550ms** |
  | `?type=…`                 | 19ms → 18ms      | 1,701ms → **666ms** |
  | `?outcome=failed`         | 140ms → 104ms    | 5,322ms → 3,818ms   |
  | `?outcome=failed&since=…` | 27ms → 38ms      | 2,181ms → 1,566ms   |
  | `traceTotals`             | 141ms → 140ms    | 6,711ms → 5,422ms   |

  Filtering by outcome still costs a pass over every matching trace, and that is
  not a shortcoming of the statement: an outcome is `CASE` over
  `JSON_EXTRACT(detail, '$.status')`, so no index can answer "which traces failed"
  before the grading it is derived from has happened. Pass `since` — every caller
  in this repo that filters by outcome already does.

  **No DDL, and nothing to run against a deployed database** — except one thing
  worth knowing: if `catalog_audit_event` was loaded in bulk rather than grown a
  row at a time (a restored dump, a backfill), run
  `ANALYZE TABLE catalog_audit_event` once. Choosing the page needs no statistics,
  but the two span joins do: with statistics MySQL has never gathered it prices a
  scan of the table at `0.102` and hash-joins instead of looking each trace up —
  138ms against 415ms for the identical statement on a 173k-row table. A trail
  that grew normally gets this from `innodb_stats_auto_recalc`.

  Behaviour is unchanged with one improvement: a page past the end of the list now
  reports how many traces there are, instead of answering an out-of-range offset
  with "there are none". The lifecycle rank that orders a same-millisecond trace is
  untouched, and `audit-trace.db.spec.ts` now holds it against a real MySQL with a
  fixture written backwards on one timestamp, so that only the rank can put it
  right.

  Nothing prunes `catalog_audit_event`, `catalog_connector_run` or
  `catalog_snapshot`, and this does not change that — the default page no longer
  grows with the table, but the outcome path still does. The retention note in
  `audit-recorder.service.ts` argues the shape it should take, and why capping the
  window would be worse than a slow screen: a page that silently truncates reads
  as "this is everything", on the one screen whose job is to say what happened.

## 0.11.0

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

### Patch Changes

- 9ad4883: The second a write lands in is not the second it was written in

  `stored-registry.staleness.db.spec.ts` — the only place two real
  `StoredCatalogRegistry` instances meet one real MySQL, and so the only evidence
  that a replica heals itself — failed ten runs in twenty, every one of them the
  case that asserts a replica which nothing has written to does **not** rebuild.

  The cause is a difference between how MySQL stores a timestamp and how it reports
  the time. `updated_at` is a `DATETIME(0)`, and MySQL **rounds** a fractional
  second into it rather than truncating; mysql2 sends the millisecond the row was
  written, so a write at `…:32.600` is stored as `…:33` — up to half a second ahead
  of the instant it happened. `NOW()` truncates. `settledAt` compares the two, so a
  write stays "inside the second the database is still in" for up to 1.5s, not 1s.
  The spec waited a flat 1,100ms before opening its second registry, which is
  enough only when the write's millisecond happens to be below .500; above it, the
  sibling's watermark was recorded as untrustworthy and the replica correctly
  rebuilt on every check for the rest of that second, which is exactly what that
  case exists to say must not happen. Caught in the act: `type_at` came back
  `03:45:57` from the same statement whose `db_now` was `03:45:56`.

  The engine was right and the test was guessing. Nothing in the file waits a
  chosen duration for the database any more — it asks the database the same
  question `settledAt` asks, and proceeds when the answer is yes, which is exact
  under rounding, under a cold container's slow first statements and under clock
  skew between the process and the server. No timeout was widened and no assertion
  was weakened: mutating the registry so it never re-reads its watermark still
  turns four of the five cases red.

  `settledAt`'s docblock is corrected along with it. It claimed the provisional
  window cost "at most one extra rebuild per write, because the following check
  happens at least `staleAfterMs` later and the second has closed by then". Under
  rounding it has not necessarily closed, and at the default `staleAfterMs` of 1000
  the real bound is two. Still bounded, still per write rather than per request —
  but the reasoning as written was wrong, and it is the reasoning this flake was
  hiding behind.

## 0.10.0

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

## 0.9.0

### Minor Changes

- 4afbedd: A second replica stops serving last week's model

  `StoredCatalogRegistry` held the catalog in memory and rebuilt it only when
  something in **its own process** wrote. With one replica that is invisible. With
  two, `PUT publish/:type/schema` answered 200 from the pod that handled it and the
  connector run that followed was told by the other pod that the type had never
  been published — for as long as that pod lived, or until it happened to serve a
  publish itself. Which answer a caller got was load-balancer luck.

  Each process now re-reads a **watermark** over the two model tables — their row
  counts and their newest `updated_at` — and rebuilds when it has moved.
  Deliberately no writer takes part in this. An invalidation that every write path
  has to remember is correct until somebody adds one that forgets, and the symptom
  of forgetting is a model quietly a day out of date on half the traffic. Reading
  the rows themselves means a replica that never writes anything converges anyway,
  and so does one whose sibling was updated through a code path this package has
  never heard of.

  **The read path costs nothing.** `getSnapshot()` and `getType()` stay synchronous
  field reads; what they gained is one integer comparison, and when it says the
  window has elapsed they start the check _without waiting for it_. No request is
  ever slower for this. What the database sees is at most one statement per
  `staleAfterMs` per process — two counts and two maxima over a few hundred types
  and their columns — however much traffic arrives.

  New `forRoot` option **`staleAfterMs`**, default 1000. `0` turns the check off
  entirely, which is what a deployment that genuinely runs one process sets to keep
  its query count exactly as it was.

  Handled along the way: two replicas checking at once need no coordination and get
  none, since both are reads; a check that fails leaves the previous model serving
  rather than emptying the registry, and retries on the next window; and a
  watermark read inside the second of its own newest write is treated as
  provisional, because `updated_at` is a `DATETIME` and two writes in one second
  otherwise share a maximum that would hide the second one forever.

  **Schema note.** `catalog_property` gains a nullable `updated_at`. Half the model
  lives in that table and there are writes that touch nothing else — a curation
  rename, or a re-publish whose only change is a column's type — so a watermark
  over `catalog_object_type` alone would call those invisible. Adding a scalar
  column moves the fingerprint `autoSchema` gates on, so an already-running
  deployment does get it; what it does not get is a backfill, so rows written
  before this holds `NULL` until something next writes them. That is harmless by
  construction — `MAX()` ignores nulls and the row counts in the same watermark
  still move — and is covered against MySQL 8 in
  `stored-registry.staleness.db.spec.ts`. No index is declared, because
  `fingerprintOf` does not hash indexes and one would therefore never reach an
  existing database at all.

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

## 0.8.0

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

### Patch Changes

- 27a816e: The routing proxies forward what they stand in front of, and the build says so now

  `RoutingPipelineStore` and `RoutingWorkspaceStore` are hand-written proxies, and
  they had lost four methods: `publishWorkflow`, `unpublishWorkflow`,
  `listTransformRevisions` and `listSavedQueryRevisions`. So in a multi-environment
  deployment, publishing a workflow failed and both revision routes answered "this
  store keeps no revisions" about a store that keeps them.

  Omitting an optional member does not make a proxy answer _no_. It makes the
  member ABSENT, and a caller probing structurally reads absent as "cannot". The
  proxy answers on behalf of the store, and it answered wrongly.

  This is the third time — `currentSnapshot` was the first, and the fix then was a
  test with a hand-written list of method names, which is the same mechanism that
  lost the first three and duly went on passing while these four were missing.

  The mechanism is now a type-level assertion: every optional member of the
  interfaces must appear on the proxy, and omitting one fails the build with an
  error naming it. `implements` already covers the required ones.

## 0.7.0

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

- 060ec38: Two things this package spent in its host's process, and no longer does

  Both are the same kind of bug: work that is invisible from inside the catalog because it lands
  somewhere else — the host's heap, or a connection the host will borrow back.

  ## Dating a type read every snapshot ever committed

  `StoredCatalogRegistry.reload()` resolved each type's `lastCommittedAt` with
  `em.find(SnapshotRow, { committed: true }, { orderBy: { committedAt: 'desc' } })` — the entire
  committed history of every type, hydrated into managed entities, so that one row per type could be
  kept and the rest thrown away.

  Measured against MySQL 8.0 at 200 types and 50,000 committed snapshots: `reload()` took **450–500 ms**
  and the hydrated rows added **161 MB** to the heap. Both are spent in the process this package is
  mounted inside. `reload()` runs at boot, after every publish, after every commit and after every
  curation edit, so a nightly connector fleet pays it several times a night — and neither number is
  stable, because a snapshot row is written per load per type and **nothing in this repository ever
  deletes one**. The cost grows with how long the deployment has been running, forever.

  It is now a grouped query that asks the database which rows are the serving ones, followed by a
  primary-key `IN` over that handful. Same answer, and the same `reload()` at the same 200 types and
  50,000 snapshots now takes **119–133 ms** while hydrating 200 rows instead of 50,000.

  What it costs elsewhere, stated plainly: the grouped query still **scans** the table. The only
  declared index is `(type_name, created_at)`, which covers neither the `committed` filter nor the
  `committed_at` ordering. The scan is now the database server's work rather than the host's, which is
  the trade being made on purpose — but it does not vanish, and it still grows with history. An index
  on `(committed, type_name, committed_at)` takes the grouped query from ~85 ms to ~14 ms at 50k rows.
  It is deliberately **not** added here, for two reasons that are decisions rather than defects: the
  DDL runs at boot on every pod, behind the host's readiness probe, against a table that may be very
  large; and `fingerprintOf` hashes only column names, types and nullability, so an added `@Index`
  would not move the schema fingerprint and would never be applied to an already-booted database
  anyway. Retention for `catalog_snapshot` is the other half of that conversation, and there is
  currently none.

  ## The query console left a statement timeout on a pooled connection

  `runReadOnlyQuery` bounded the caller's statement with `SET SESSION MAX_EXECUTION_TIME`. That is
  session scope, and a session here is a pooled connection: the value stayed set on that connection
  after the request finished, for whoever borrowed it next. With no `contextName` configured,
  `catalogConnectionProviders` binds this package to the **host's** `EntityManager` — so the connection
  being altered is one of the host's, and the host's next statement on it silently inherited a
  fifteen-second timeout it never asked for and had no way to see. Confirmed against MySQL 8.0: after
  one query, a different `em.fork()` read the value back.

  It is now a per-statement optimizer hint on the wrapper this function already builds. Both forms
  interrupt a runaway cross join at 1.00 s; the hint leaves `@@SESSION.MAX_EXECUTION_TIME` at 0, and
  removes a round trip, since it rides on the statement instead of preceding it. The hint attaches to
  the outer `SELECT` written here, never to the caller's text, so a statement beginning with `WITH` is
  untouched.

  The `START TRANSACTION READ ONLY` that makes the screen safe to expose is unchanged, and was checked
  rather than assumed while this was in hand: an `INSERT` issued between it and the `ROLLBACK` comes
  back as `Cannot execute statement in a READ ONLY transaction`, sequentially and with eight such
  sequences in flight at once, with the connection id stable across all four statements.

## 0.6.0

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

## 0.5.0

### Minor Changes

- f600109: An empty load is a load, and a repair reports what it actually cleared

  **`MySqlWarehouseStore.write` no longer returns early on an empty array.** A
  load of zero rows now writes no rows and does everything else: it replaces
  whatever that batch held, it creates the snapshot row with the labels it was
  given, and it counts. This is a behaviour change a host can notice — a caller
  that used to get a silent no-op now gets a snapshot.

  The old shape cost more than it saved. No rows meant no snapshot row, so the
  next step failed with _"no snapshot has been written for this type"_ — true, and
  the wrong event: nothing failed to be written, a source returned nothing, and
  that sentence sends somebody looking for a lost batch. Worse, the
  acknowledgement an operator attaches to a collapse they meant (`_expectShrink`,
  read by `refuseRowCountDrift` in the pipeline package) rides on the snapshot's
  labels, so it was inert for exactly the load most likely to need it: the one
  where the dataset really did go to zero.

  Whether an empty snapshot may _replace_ what is being served is still not this
  store's decision. That rule already exists one layer up, together with the label
  that suspends it, and a refusal in the adapter would be the same rule enforced
  by the component that has no way to hear the answer — a deliberate truncation
  would become impossible to express. What the store does instead is make the load
  representable, and warn on a commit that empties a type which had rows, for the
  benefit of a host running this adapter with no bound configured.

  Two smaller consequences of the same change: an empty batch is refused for a
  negative batch number like any other batch (that check used to sit below the
  early return), and an empty batch that lands after a carry-forward marks the
  merge stale like any other batch — it removes rows, so the merge no longer
  covers the load.

  **Silence still is not a declaration.** A caller that writes no batch at all
  leaves no snapshot and `commit` still refuses, because a run whose source was
  unreachable, a run that died before its first batch, and a snapshot id nobody
  wrote to are indistinguishable from inside the store — and inventing an empty
  snapshot would pick the most destructive reading of the three. The refusal now
  names the possibility the caller's own logs will not: a source that returned
  nothing, and how to say so on purpose.

  **`FanoutReplayResult.cleared` no longer undercounts.** It was a sum of what two
  of the repair's steps reported, which could not include the entry the commit at
  the end of a replay discharges — a follower held back from a load owes a
  `commit` entry, and committing it on the follower also closes every entry about
  snapshots it has now moved past. An operator reading "2 outstanding" on the
  status screen, running the repair, being told it cleared 1 and then finding the
  ledger empty had two numbers that could not both be right. It is now measured by
  reading the ledger before and after, so it reconciles with the screen and cannot
  fall behind a step somebody adds to the repair later. Entries that were _closed_
  rather than repaired are counted and called out in `notes`.

### Patch Changes

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

## 0.4.1

### Patch Changes

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

## 0.4.0

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

## 0.3.0

### Minor Changes

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

- 09c9bc9: Promoting into production leaves a record, and cannot land in the wrong world

  `PROMOTION_AUDIT_EVENT` was exported with a paragraph explaining where the record
  is written, and referenced nowhere. `applyPromotion` wrote no audit row, so the
  act of releasing into production was unrecorded — while the code said otherwise,
  and while `CatalogPromotionApproval.reason` claimed the operator's text was
  "recorded in the audit trail".

  It writes one `promotion.applied` row per promotion now, into the TARGET
  environment's own table rather than through the routing store: a promotion is
  the one act about two environments at once, and the record has to be provably in
  the one that changed. One row rather than one per change, because a promotion is
  a single act by one person against one approved fingerprint — but every promoted
  id is in the detail, kept apart by kind, so the trail does not lose what moved.

  **A promotion that throws part-way records too.** An apply is not atomic, so the
  half-finished one is the record worth most; `status` and `error` carry it, the
  way `connector.run.finished` already reports both outcomes under one name.

  **And a refusal that was missing entirely.** `applyPromotion` never checked that
  the plan's `to` matched the environment it was handed. A caller that resolved the
  wrong bundle would release an approved-for-staging plan into production — and,
  once auditing existed, file the record under the environment the plan named
  rather than the one it hit. It refuses now. This is a behaviour change to a
  public API and the one part a host could notice.

  `reason` is a new optional argument, carried verbatim and never parsed. It is the
  one part of "who, what, when and why" that cannot be reconstructed from the two
  databases afterwards.

### Patch Changes

- 655f964: The routing store now forwards `currentSnapshot`

  `RoutingCatalogStore` proxies a `MySqlWarehouseStore`, which implements
  `currentSnapshot`, and did not forward it. That did not make the proxy answer
  "no" — it made the method absent, and a caller probing structurally reads absent
  as "this store cannot answer".

  What that costs is not hypothetical. A caller with no pointer falls back to the
  newest entry in `listSnapshots`, which `catalog.store.ts` calls not survivable:
  after a rollback the newest snapshot is precisely the one that was rolled back,
  so the fallback aims the reader at data somebody deliberately stopped serving.

  Still probed rather than assumed — the bundle's store is whatever the host bound,
  and forwarding blindly would turn a missing method into a crash inside a proxy
  the caller did not know was there.

  The real defect was that a hand-written proxy had no test that fails when the
  list falls behind. It has one now.

## 0.2.2

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

## 0.2.1

### Patch Changes

- f8a10d6: Fork the EntityManager, so `/access/principals` is not a 500

  `MikroOrmCatalogDirectory` read through the injected EntityManager, which is the
  **global** one. MikroORM refuses context-specific calls on it — `Using global
EntityManager instance methods for context specific actions is disallowed` — and
  a read from a request handler is exactly that, so every call to the endpoint
  answered 500.

  Nothing caught it: it compiles, the module boots, the route mounts, and the
  guard in front of it answers 401 to an unauthenticated probe — which looks
  identical to a working endpoint. A unit test with a stubbed EntityManager would
  also have passed, because a stub has no request context to be outside of. It is
  now covered by a `*.db.spec.ts` against a real MySQL, where reverting the fix
  fails four cases with that exact message.

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

## 0.1.1

### Patch Changes

- 21b2d71: Ship a README

  The package published with none, so its npm page was blank — for the one adapter whose
  misconfiguration is silent. `contextName` is the option worth reading before installing: omit it and
  the store resolves the _default_ EntityManager, creating the catalog's tables and loading every
  snapshot into the host application's schema, with no error raised, because writing to the wrong
  database is not a type error and the rows land successfully.

  Also documents keeping a host's migration differ away from the library's tables
  (`catalogManagedTables()`, `MARKER_TABLE`, and why `obj_*` is deliberately absent from both).
