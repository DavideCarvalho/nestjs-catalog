# @dudousxd/nestjs-catalog-store-fanout

## 0.3.0

### Minor Changes

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

- ce475f1: Two stores that can filter now say so, and ClickHouse stops keeping its own copy of the reserved
  column list.

  **`store-clickhouse` and `store-fanout` declare `objectFilterOperators`.** The design is that a
  store _declares_ which operators it can push into a predicate: the service offers a screen exactly
  those and refuses a filter naming anything else, so a store that ignores a filter can never answer
  with more rows than were asked for. That part worked. What was missing was the declaration on two
  stores that can, in fact, filter — so a ClickHouse deployment and a fan-out deployment each got no
  filter controls at all, and a hand-built filter came back as a refusal, for stores with a perfectly
  good WHERE clause available the entire time.

  - **ClickHouse applies all nine operators**, in the same `where` its `count()` and its page both
    read from — a filter on the page and not the count is a screen showing three rows above the words
    "of 4,812". Two predicates are not MySQL's, and deliberately: `empty`/`notEmpty` compare against
    `''` only on the text types, because ClickHouse refuses `Nullable(Float64) = String` outright
    where MySQL coerces it, and `contains` is `ILIKE` rather than `LIKE`, the same choice the search
    box already makes so that a control does not behave differently depending on which adapter is
    mounted. `eq` is left case-sensitive, which is a real difference from MySQL's default collation
    and is stated rather than papered over: matching it would mean lowering both sides of every
    comparison, forfeiting the sparse index, and still not matching, since that collation is
    accent-insensitive too. A filter on a column the same read did not select is refused, as on MySQL:
    a predicate over a hidden or classified column leaks it through row membership.
  - **The fan-out reports its primary's operators**, and reports nothing when the primary declares
    nothing — `read` is the primary's `read`, so that is the only answer it can keep. Not intersected
    with the followers, unlike the capability object: nothing routes an ordinary read to a follower,
    so intersecting would remove the filter controls from a catalog that filters fine for the sake of
    a store nobody reads. The one read path that does leave the primary, `readFrom(name, ...)`, now
    **refuses** a filter the named store cannot apply — otherwise a follower that filters nothing
    returns its whole table and the operator comparing it against the primary before a flip reads that
    as the follower holding extra rows.

  **`RESERVED_COLUMNS` in `store-clickhouse` is `CATALOG_RESERVED_COLUMNS`,** re-exported rather than
  rebuilt. The file's own docblock already said the identifier rule came from the core package "next
  to `CATALOG_RESERVED_COLUMNS`, and taken from there for the same reason that list is" — and the list
  was not taken from there. It was assembled locally and agreed with the core's by coincidence, which
  is what let the claim survive being read. The two lists were byte-identical, so nothing changes for
  a deployment; what changes is that they can no longer come apart. The five per-column constants stay
  (the DDL and the SELECT lists need each name on its own) and both adapters now assert that those
  constants and the shared list still describe the same set — the half a re-export cannot give you,
  and the failure `_row` already caused once.

## 0.2.1

### Patch Changes

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

## 0.2.0

### Minor Changes

- 7080f18: The documented repair now repairs, and a fan-out stops hiding three things its primary said

  **A follower that failed `ensureType` could not be unblocked.** Those failures are
  recorded under `FANOUT_SCHEMA_SCOPE` rather than a snapshot id, and `commit()`
  folds the schema scope into every snapshot — so one refused schema change held
  that follower back from every subsequent commit and `verify()` was red for good.
  `clearDebt` queries by snapshot id, so the `'ensureType'` entry in
  `REPLAYED_STAGES` matched nothing and never had; the replay reported how many
  debts it cleared, the operator read that as progress, and the next load held the
  follower back again. Which is the worst version of this: a cutover gate that is
  permanently red is a gate everybody learns to walk past, and this package says so
  about itself.

  The repair is not to widen `clearDebt`. A schema entry says a column is missing
  and copying rows in is not evidence about columns — `supersede` already refuses
  to discharge one for the same reason. So the replay's own `ensureType` call,
  which used to go straight to the follower's store and bypass the ledger
  entirely, now goes through `FanoutCatalogStore.ensureTypeOn` (new, public, the
  head of a replay the way `commitFollower` is its tail). A success discharges the
  debt because it _is_ the evidence; a failure is written down with the attempt
  counted and refused as a `CatalogFanoutError` rather than thrown out of a repair
  that left no trace. `cleared` counts the schema entry only when one was actually
  discharged — a repair that overstates what it did is how this stayed invisible.

  **`composeCapabilities` dropped `atomicCutover`, `atomicBatchReplace` and
  `transactional` on the floor.** Both shipped adapters populate all three; behind
  a fan-out all three came back absent, and the contract says absent must be read
  as false. So a caller doing exactly what it was told got the pessimistic answer
  with no follower to blame, and `explainCapabilities` — whose whole job is saying
  what a follower cost — was silent. They are intersected now, and the near reason
  matters more than the flip: a write through this store lands on the primary _and_
  every follower, so what a crash can leave behind is answered by the worst of
  them, today. The intersection is three-valued, keeping _not stated_ apart from
  _stated false_, because composing an unstated field down to `false` writes a
  guess into the shape a measurement lives in.

  **`currentSnapshot` was never forwarded.** A MySQL primary implements it; behind
  a fan-out it reported that it could not say which snapshot it was serving, and
  the fallback for that is newest-in-`listSnapshots` — a guess the core package
  calls "not survivable", because rolling a bad load back means committing an
  _older_ snapshot and the newest is then the load that was just rolled back.
  Forwarded now, and `CatalogFanoutMigration` asks for it before guessing.

  **And the list that caused it.** The `declare` block enumerating the optional
  methods to forward was maintained by hand against interfaces this package does
  not own, and adding an optional member to one of those interfaces breaks nothing
  in a consumer that ignores it — that is what optional means, and it is why the
  omission survives review and is found by whoever needed the member. Both that
  list and the capability fields are now checked against the interfaces at compile
  time, so a member added upstream stops this package building with an error that
  names it. The bindings themselves are walked by the suite, driven by the same
  list.

  Also: the local copy of the capability-shape predicate is gone in favour of the
  core package's `isCatalogStoreCapabilities`, which the core exports for exactly
  this. The copy had already drifted — it validated none of the optional fields,
  so a store the core would refuse was admitted here.

## 0.1.1

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
