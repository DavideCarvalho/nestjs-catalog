# @dudousxd/nestjs-catalog-pipeline

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
