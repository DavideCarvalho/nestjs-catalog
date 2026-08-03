# @dudousxd/nestjs-catalog-store-fanout

Move a catalog from one engine to another without a big-bang cutover. Register
both stores, keep them in step, verify the new one against the old one, and flip
when the numbers agree — with the old one still there if they do not.

```bash
pnpm add @dudousxd/nestjs-catalog-store-fanout
```

## The problem

You start on MySQL. A year later you want ClickHouse. The honest version of that
migration is not a maintenance window and a script — it is weeks of running both,
watching the new one, and being able to change your mind. This package is the
store that lets you do that.

## Writing to both cannot be symmetric

There is no distributed transaction across a MySQL schema and a ClickHouse
cluster. A load that commits on one and fails on the other leaves two databases
that disagree, and if both are authoritative, nothing in the system is entitled
to say which is right. Two disagreeing databases with no arbiter are strictly
worse than one, because now the wrong answer has a second source to confirm it.

So this package takes a position and does not soften it:

- **One store is the primary.** Its commit is what decides whether a load
  happened. Everything else is a follower.
- **Every read comes from the primary.** There is no "read from whichever
  answers", no failover, no round-robin. Those are how a system acquires results
  that change between requests and a bug report nobody can reproduce.
- **One exception, opt-in and by name.** `readFrom("clickhouse", …)` reads a
  named follower, because the only responsible way to make a follower the primary
  is to have looked at what it holds first.

## Why this is safer here than a dual write usually is

A row-level dual write has no recovery. The row that failed on one side is gone
unless you re-read the source, and by then the source has moved on.

Loads in `@dudousxd/nestjs-catalog` are not row-level. They are snapshot-scoped
and append-only: rows are written under a snapshot id in numbered batches, a
re-sent batch replaces itself rather than appending, and a **separate commit** is
what makes the snapshot visible. So a snapshot that failed on a follower is still
sitting on the primary — complete, immutable, addressed by its id. It can be
replayed to the follower from the primary, with no source involved and nothing
recomputed.

That property is what makes this defensible. A recorded failure here is
*recoverable*, not merely *visible*.

## Wire it up

```ts
import { CatalogFanoutStoreModule } from "@dudousxd/nestjs-catalog-store-fanout";

CatalogFanoutStoreModule.forRoot({
  imports: [
    CatalogMikroOrmStoreModule.forRoot({ contextName: "catalog" }),
    CatalogClickHouseStoreModule.forRoot({ url: process.env.CLICKHOUSE_URL }),
  ],
  primary: { name: "mysql", store: MySqlWarehouseStore },
  followers: [{ name: "clickhouse", store: ClickHouseWarehouseStore }],
});
```

It provides `CATALOG_STORE`, so adopting it is a matter of swapping which module
supplies that token. It depends on no adapter — it is handed injection tokens and
composes whatever they resolve to.

> **Import the adapter modules through this module's `imports`, not into your
> `AppModule`.** Each of them exports `CATALOG_STORE` bound to itself. Side by
> side in one injector, that token ends up bound to whichever module was
> registered last, everything bypasses the fan-out, and there is no error
> anywhere — loads go to one store and the other silently stops receiving them,
> which is the exact failure this package exists to prevent.

## The migration, end to end

### 1. Add the follower

```ts
followers: [{ name: "clickhouse", store: ClickHouseWarehouseStore }],
```

That is the whole change. From the next load on, every batch and every commit
goes to both. Reads do not move. If ClickHouse is down, loads still succeed into
MySQL and the failures are written to the journal — see
[strictness](#strictness), below.

Watch it settle for a few days:

```ts
const status = await migration.status();
// status.clean === true means no follower owes anything
```

### 2. Repair whatever it missed

`status()` lists, per follower, exactly which snapshots of which types it owes
and at which step. Each of them is fixable from the primary:

```ts
await migration.replay("Mvr", "run-4471", "clickhouse");
```

The replay drops the follower's copy of that snapshot, pages the primary's copy
into it, discharges the journal entries, commits on the follower if that snapshot
is the one currently being served, and then runs the comparison. **A replay that
does not end in a match is not a finished replay** — the returned
`comparison.matches` is the check, not the absence of an exception.

### 3. Verify

```ts
const verification = await migration.verify();
if (!verification.ready) console.log(verification.reasons);
```

For every type, this compares the current snapshot on both sides: the row count,
and an order-independent checksum over the primary-key columns. The checksum is
not decoration. Two stores holding the same number of rows and different rows is
the most likely way a dual write goes wrong, and it is the one shape of failure
counting cannot see.

`ready` is true only when every comparison matched *and* nothing is outstanding
in the journal. "Mostly caught up" is the state every failed migration was in the
day before it was discovered.

### 4. Tighten the screws

Once the follower has been clean for a while, make its failures stop the line:

```ts
followers: [{ name: "clickhouse", store: ClickHouseWarehouseStore, strictness: "required" }],
```

Now a load that ClickHouse cannot take is a load that does not commit on MySQL
either. Run like this until you trust it — this is the setting you want on the
day of the flip, because it means the two cannot drift while you are switching.

### 5. Flip

```ts
primary:   { name: "clickhouse", store: ClickHouseWarehouseStore },
followers: [{ name: "mysql", store: MySqlWarehouseStore }],
```

Reads move. Writes carry on to both. MySQL is now the follower, so if ClickHouse
turns out to be wrong about something you swap the two lines back and the old
store has been kept current the whole time. That is the entire reason to do it in
this order.

### 6. Drop the old one

```ts
followers: [],
```

With no followers this module is a transparent pass-through, which is also a
perfectly good shape to deploy before the second engine exists.

## Strictness

Set per follower, because both settings are correct at different points in the
migration.

| | What a follower failure does |
|---|---|
| `recorded` *(default)* | Written to the journal. The load carries on and the primary's commit still decides that it happened. The follower falls behind by exactly the snapshots it failed. |
| `required` | The load fails. For everything except the follower's own commit — which is to say every failure of `ensureType`, `write` and `carryForward` — the primary is not committed either, so the load is published nowhere and the retry replays it from the top. |

**The default is `recorded`, and it is the safe one here**, which is not the usual
answer for a dual write. It is the safe one because *nothing reads from a
follower*. A follower that is behind cannot give a wrong answer to anybody; it
can only be incomplete, visibly, in the journal and in the comparison. Defaulting
to `required` would give a brand-new unproven store a veto over loads into the
one that actually serves traffic — a ClickHouse cluster nobody depends on yet
could stop data reaching MySQL. That is the wrong trade, and it is the trade that
makes teams turn the mirror off entirely.

Neither setting rolls anything back. There is no distributed transaction here and
this package does not pretend to have one: `required` means "report the load as
failed", not "undo it". What makes that survivable is that a retry re-sends every
batch and every store replaces rather than appends.

## What is recorded, and where

Every interaction with a follower is announced to the **journal** *before* it is
attempted, and the announcement is cleared only when the step is known to have
succeeded. A process that dies mid-attempt therefore leaves an entry behind,
which is exactly right: a crash and a failure are the same fact from the
primary's point of view.

An entry is keyed down to the batch — `(type, snapshot, follower, stage, batch)`
— so a load whose batch 3 failed and whose batch 4 succeeded owes batch 3 and
only batch 3.

A debt about an older snapshot is closed when the follower successfully commits a
newer one, because a snapshot in this library is the complete state of a type and
not a delta — a follower serving snapshot S is serving everything the type has,
whatever it missed three loads ago. Without that, entries would accumulate for the
life of the deployment and `verify()` would be permanently red, which is a gate
everybody learns to walk past. A failed `ensureType` is the exception and is never
superseded: no amount of committing loads makes a missing column appear, so it
holds the follower back from every commit until the type is published again.

The default journal is an append-only JSONL file at `.catalog-fanout/journal.jsonl`.
**It is single-process.** Anything running more than one loader must supply its
own; the interface is five methods:

```ts
CatalogFanoutStoreModule.forRoot({
  journal: new MyDatabaseBackedJournal(),
  ...
});
```

Live observability is separate, on `aviary:catalog-fanout:*` via
`@dudousxd/nestjs-diagnostics` — `follower.failed`, `follower.held-back`,
`follower.recovered`, `snapshot.fanned-out`, `comparison.finished`. That channel
is explicitly *not* where failures are recorded: it reaches whoever is subscribed
at the moment it fires, and a follower that missed three days of loads is
discovered long after that.

## Ordering

One rule explains every sequence: **at every intermediate point, the primary is
ahead of or equal to the followers.** Creation goes primary-first, deletion goes
followers-first. "The follower is behind" is the ordinary, repairable state — it
is what a replay fixes. "The follower holds something the primary never blessed"
is a state with no owner and no procedure.

Concretely, a commit:

1. Ask the journal what is outstanding for this snapshot. If a `required`
   follower owes anything, throw **before the primary commits** — the load is then
   published nowhere.
2. Commit on the primary. From this instant the load has happened.
3. Write the commit mark, so a later replay knows which snapshot is current.
4. Per follower: record the attempt, then commit it. A follower that already owes
   something for this snapshot is **held back** rather than committed, because a
   follower serving a snapshot that is one batch short is worse than one serving
   yesterday's — one is stale and obviously so, the other is current and wrong.
5. Return the primary's `SnapshotRef`, always.

A crash between any two of those leaves a state a replay can fix, and nothing a
reader sees is ever half a load: the primary's commit is atomic and the followers
are never committed ahead of it.

## Capabilities are the intersection

`CatalogStoreCapabilities` is composed by taking the **weakest** `snapshots` mode
and requiring `timeTravel` of every participant, not by reporting the primary's.

Two reasons. First, `readFrom` is a read this store offers, so advertising
`timeTravel: true` while `readFrom("clickhouse", { snapshot: X })` cannot honour
it is the store lying about its own API — and the caller finds out by getting
current data labelled as history. Second, a follower exists here in order to
become the primary. If capabilities tracked the primary, the flip would be the
moment history silently disappears, and the flip is exactly when the old store is
about to be dropped. Intersecting pays that cost the day you *add* the follower,
while the old store is still there and the change is one line to revert.

This is not hypothetical: ClickHouse's ReplacingMergeTree collapses old versions
rather than keeping them, and DuckDB has no time travel at all. The remedy for a
degraded capability is never to weaken the report — it is either to not attach a
store that cannot hold what this catalog promises, or to accept a smaller
promise. Either way you are told which follower cost you what, in the boot log.

## API

Inject `CatalogFanoutMigration` for the operational surface:

| | |
|---|---|
| `status()` | What each follower owes, straight off the journal |
| `compare(type, { snapshotId?, follower? })` | Row counts and a primary-key checksum on both sides |
| `verify({ types? })` | Every type, every follower. The cutover gate |
| `replay(type, snapshotId, follower)` | Re-send a snapshot from the primary, then compare |

Inject `FanoutCatalogStore` (or `CATALOG_STORE`) for the store itself, plus
`readFrom(name, …)`, `storeNamed(name)` and `journal`.

**No controller ships with this package.** A route that can rewrite a follower's
copy of a dataset is not something a library should mount by default, and who may
call it, under which prefix, behind which guard, is a decision only the host can
make.

## What a mismatch looks like

`compare()` returns `matches` and a list of sentences. They read like this:

> clickhouse holds 12004 rows of Mvr snapshot run-4471; mysql holds 12110. 106
> row(s) never landed. Replay the snapshot to clickhouse.

> Row counts agree at 12110, but the primary-key digest differs (mysql:
> 3f2a…:9c11…; clickhouse: 8b40…:2d77…). The same number of rows carry different
> keys, so rows were replaced rather than lost — a count-only check would have
> called this identical.

> Mvr declares no primary key, so only row counts could be compared. Equal counts
> here do not mean equal data.

## License

MIT
