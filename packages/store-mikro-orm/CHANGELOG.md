# @dudousxd/nestjs-catalog-store-mikro-orm

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
