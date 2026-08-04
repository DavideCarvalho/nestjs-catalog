# @dudousxd/nestjs-catalog-store-fanout

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
