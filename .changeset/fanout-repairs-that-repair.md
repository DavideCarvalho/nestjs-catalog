---
"@dudousxd/nestjs-catalog-store-fanout": minor
---

The documented repair now repairs, and a fan-out stops hiding three things its primary said

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
debt because it *is* the evidence; a failure is written down with the attempt
counted and refused as a `CatalogFanoutError` rather than thrown out of a repair
that left no trace. `cleared` counts the schema entry only when one was actually
discharged — a repair that overstates what it did is how this stayed invisible.

**`composeCapabilities` dropped `atomicCutover`, `atomicBatchReplace` and
`transactional` on the floor.** Both shipped adapters populate all three; behind
a fan-out all three came back absent, and the contract says absent must be read
as false. So a caller doing exactly what it was told got the pessimistic answer
with no follower to blame, and `explainCapabilities` — whose whole job is saying
what a follower cost — was silent. They are intersected now, and the near reason
matters more than the flip: a write through this store lands on the primary *and*
every follower, so what a crash can leave behind is answered by the worst of
them, today. The intersection is three-valued, keeping *not stated* apart from
*stated false*, because composing an unstated field down to `false` writes a
guess into the shape a measurement lives in.

**`currentSnapshot` was never forwarded.** A MySQL primary implements it; behind
a fan-out it reported that it could not say which snapshot it was serving, and
the fallback for that is newest-in-`listSnapshots` — a guess the core package
calls "not survivable", because rolling a bad load back means committing an
*older* snapshot and the newest is then the load that was just rolled back.
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
