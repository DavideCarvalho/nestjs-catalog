# @dudousxd/nestjs-catalog-store-clickhouse

## 0.3.0

### Minor Changes

- 4c2c383: ClickHouse drops a snapshot's rows and keeps its record, the way MySQL now does

  `dropSnapshot` removed two things: the partitions holding the rows, and the
  snapshot's row in `catalog_ch_snapshot`. The second is what made a drop unsafe —
  `catalog_connector_run.snapshotId` names a snapshot, and a run log whose ids
  resolve to nothing cannot answer what it is asked. That is written down
  elsewhere in this library as the reason nothing may be dropped by age.

  This adapter dropped by age anyway. `pruneSnapshots(type, keep)` is a real
  retention policy with a real cap, so the dangling pointer was not a hazard here
  but a scheduled output: MySQL only _could_ produce that state, ClickHouse was
  producing it every time the cap bit.

  The record now survives with `dropped_at` set, and the ref reports
  `SnapshotRef.droppedAt` — the same field, spelling and sentence the MikroORM
  adapter uses, so a caller cannot tell which store refused it. `droppedAt` is
  _are the rows still here_; `archive` is _does a copy exist elsewhere_; the two
  compose into hot / copied / tombstoned / evicted, with "no `SnapshotRef` at all"
  still the only state meaning gone.

  The `deleted` column stays and keeps its predicate. It answers a different
  question — it erases the _record_ — and nothing writes it any more, but rows
  carrying it exist in deployments written by earlier versions and dropping the
  predicate would resurrect every snapshot those deployments meant to be rid of.

  Readers taught about tombstones:

  - **`commit`** refuses one, naming the drop and its date. This is the refusal
    that mattered: committing a tombstone points a published type at a snapshot
    holding nothing, and this method takes the record's own count, so not even a
    warning would have been logged.
  - **`read`** refuses a `snapshot` that names one, rather than answering with an
    empty page. Paid only on the history path — the served snapshot can never be a
    tombstone, so an ordinary read is the two statements it always was.
  - **`carryForward`** excludes tombstones when choosing what to merge onto.
    Newly reachable now that records survive a drop: roll back to a good load,
    drop the bad one, and the newest committed snapshot is one with no rows.
    Merging onto it copies nothing and commits a full replacement wearing an
    incremental load's name.
  - **`dropSnapshot`** counts before unlinking the partitions and writes
    `droppedAt` after, so a crash between them leaves a snapshot still claiming
    its rows — visible and re-runnable — rather than a tombstone over partitions
    nobody will unlink. Idempotent: a replay does not rewrite the date. Its
    existing refusal of the served snapshot is now load-bearing rather than
    advisory.
  - **`listSnapshots`** reports tombstones with `droppedAt` and the count they
    held, never a fresh count (which would report a 27M-row load as an empty one).
    Its default bound rises from 50 to `CATALOG_SNAPSHOT_LIST_LIMIT` (500), the
    MikroORM adapter's number for the MikroORM adapter's reason: 50 was a page
    size doing a bound's job, and a dropped snapshot used to leave the list and
    now stays in it.

  `pruneSnapshots` unlinks exactly the partitions it always did — every byte of a
  snapshot's data — and no longer erases the record. That reclaims no less than
  before: the old code did not delete the record either, it inserted a
  `deleted = 1` row that `ReplacingMergeTree` collapses onto the original and
  which then stays for good. The record count under a daily load has always grown
  by one a day; what changes is the width of those rows, by the labels and
  principal the `deleted` marker blanked plus a nullable `DateTime64(3)`.

  Measured on 20,000 records of realistic width, merged and read out of
  `system.parts`: a live snapshot is 32.0 B/record on disk, the old `deleted`
  marker collapsed to 15.6 B/record, a tombstone is 38.0 B/record. Same row count
  in every case; a dropped snapshot costs about 22 more bytes than it used to. A
  deployment loading one type hourly for ten years accumulates ~88,000 records —
  3.3 MB where it would have been 1.4 MB. No second bound is needed for space, and
  none is added.

  `keep` counts snapshots that still hold rows, asked for with tombstones already
  excluded in SQL. A snapshot that is already a tombstone is not visited, not
  re-dropped and not reported in `dropped`. Counting tombstones towards `keep`
  would have been the quiet failure: a type with seven tombstones and one live
  snapshot would report itself at a cap of seven, and the next load would push the
  only readable snapshot out.

  `ensureCatalogClickHouseSchema` adds `dropped_at` to an existing table with
  `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, which is metadata-only on a nullable
  column and cannot lose data.

  Covered by two new cases in the shared store contract, so MySQL, Postgres, the
  fan-out and ClickHouse are held to one account of what a drop leaves behind
  rather than agreeing by coincidence.

## 0.2.0

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

## 0.1.2

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
