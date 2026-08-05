---
"@dudousxd/nestjs-catalog-store-mikro-orm": minor
"@dudousxd/nestjs-catalog-store-fanout": patch
---

An empty load is a load, and a repair reports what it actually cleared

**`MySqlWarehouseStore.write` no longer returns early on an empty array.** A
load of zero rows now writes no rows and does everything else: it replaces
whatever that batch held, it creates the snapshot row with the labels it was
given, and it counts. This is a behaviour change a host can notice — a caller
that used to get a silent no-op now gets a snapshot.

The old shape cost more than it saved. No rows meant no snapshot row, so the
next step failed with *"no snapshot has been written for this type"* — true, and
the wrong event: nothing failed to be written, a source returned nothing, and
that sentence sends somebody looking for a lost batch. Worse, the
acknowledgement an operator attaches to a collapse they meant (`_expectShrink`,
read by `refuseRowCountDrift` in the pipeline package) rides on the snapshot's
labels, so it was inert for exactly the load most likely to need it: the one
where the dataset really did go to zero.

Whether an empty snapshot may *replace* what is being served is still not this
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
fall behind a step somebody adds to the repair later. Entries that were *closed*
rather than repaired are counted and called out in `notes`.
