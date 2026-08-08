---
'@dudousxd/nestjs-catalog': minor
'@dudousxd/nestjs-catalog-pipeline': minor
'@dudousxd/nestjs-catalog-react': minor
---

An `aggregate` node kind — declarative grouping, and a memory bound instead of a ceiling

flip's `wo` table is a `GROUP BY` over 44,720 SUBWO rows producing 16,119
groups. Today the graph can only express that as a whole-batch transform, and as
a whole-batch transform it works and only just: the child is handed 65.51 MiB on
stdin and answers with a single JSON line of 25.01 MiB — **78.2% of the hard
32 MiB `MAX_OUTPUT_BYTES`** — which the parent buffers whole, on top of the
44,720 records `readInputs` already materialised (237 MiB heap, 406 MiB RSS in a
standalone equivalent). It fails at **1.28×** that file, and it fails by being
killed at the cap rather than by degrading. SUBWO is already the largest file in
the drop it comes from.

A hash aggregate consumes its input as a stream and holds only the groups. This
node does that: one staged batch decoded at a time, 16,119 accumulator rows held
against 44,720 records, and nothing on the input side that scales with the load.

Verified against the live `SubwoReplica` snapshot: **16,119 groups**, matching
flip's own SQL exactly on `MIN`/`MAX` over dates, on `COUNT`, and on `SUM` to the
last cent, with the two deliberate divergences below.

**The argument for the kind is the `rename` node's, unchanged.** The generic
`transform` still exists, and that is what lets this stay narrow forever: "I need
more than this" is answered with *use a transform*, never with *add a field
here*. What is new is a **stated admission rule** for the function list, so
narrowness is checkable rather than promised: a function is in if it computes
from a fixed-size accumulator and its answer needs no extra config field.
`count`, `sum`, `avg`, `min`, `max`, `join` are in. `countDistinct` is out —
its accumulator is O(distinct values) per group, which is the thing being fixed
wearing an aggregate's name. `median`/percentiles/`stddev` are out for the same
reason; `first`/`last` are out because they mean "in input order" and a load
that answers differently on a rerun cannot be diffed. **Conditional aggregation
— the `MAX(CASE WHEN …)` status ladder in flip's own query — is out**, because it
is a predicate language nested inside an aggregate language; it composes instead
as rank-in-a-transform, `min`, un-rank.

**The three places this deliberately disagrees with MySQL, each measured on the
real data:**

- **`GROUP_CONCAT` truncation is not reproduced.** flip's deployment has
  `group_concat_max_len = 1024`; real values reach 1,700 and 1,883 characters,
  and 5 of 16,119 groups exceed it on each of two columns. MySQL truncates and
  raises a warning MikroORM does not surface, so five rows per column have been
  silently missing their tail in committed data. `join` **refuses** at its bound,
  naming the group and the length. The default bound is 65,535 — one `TEXT`
  column, because a value the target column cannot hold is the same defect one
  layer down — so flip's real maximum is 2.9% of it and the derivation runs
  untouched.
- **`min`/`max` over text compares by code point, not by collation.** Under
  `utf8mb4_0900_ai_ci` MySQL folds case; this does not. Measured: 18 of 16,119
  groups differ for `lastUpdatedBy` and 23 for `maintenanceLocation`; every other
  string column agrees. Code point order is total, stable and identical on every
  machine, and the alternative is not "MySQL's answer" but an approximation of
  one deployment's collation — being 99.8% right is worse than being clearly
  different, because nobody checks it.
- **`sum` keeps the low-order bits.** A prior comparison found 17 of 16,119
  groups differing in the last float64 ulp (`6442.999999999999` against `6443`)
  purely from summation order. Neumaier compensation costs one float per
  accumulator and, on decimal money and hours, gives the correctly-rounded sum.
  It does *not* promise order independence or bit equality with MySQL, and the
  docblock says so.

**Where a value has no decided answer, the node refuses rather than coercing.**
A `min`/`max` over a column holding both `12` and `"12"`, text that is not a
number in a `sum`, an object as a group key — each fails naming the column, the
group and the values. MySQL answers all three plausibly and wrongly with a green
run, which is the shape of failure this node was written about.

**The memory bound is loud.** `maxGroups` defaults to 1,000,000 (62× flip's real
case) and **refuses** when crossed, naming the columns being grouped on. Below
that, the run warns when a grouping came out nearly one-to-one, because a hash
aggregate holding one entry per record has quietly become the whole-batch
behaviour this node replaces.

**Determinism.** Values join in input order and groups emit in first-seen order,
both functions of the numbered list of staged batches — so two runs over the same
staged input produce the same bytes, which `GROUP_CONCAT` without an `ORDER BY`
does not. Stability across a source that reorders its own rows is not promised,
because a `SELECT` without an `ORDER BY` promises nothing.

**`producedColumns` gains its strongest answer.** An aggregate's output set is
the group keys plus the named aggregates, and it is **exact** rather than an
upper bound — every emitted record carries every one of those keys, whatever was
upstream. So a filter or a sink below an aggregate is checked when the graph is
saved. It claims nothing more: an aggregate over a column no record carried still
produces the column, holding `null`.

**Grouping and aggregating both require identifier-shaped column names**, which
`rename` deliberately does not. A group key comes out under the name it went in
under, so a source spelling its headers `Work Order Id` needs a `rename` above
this node — and the refusal says exactly that.

Every per-kind decision was a compile error until it answered: `WORKFLOW_NODE_KINDS`,
the union, `NODE_KIND_IS_REUSABLE` (false — an aggregate names one type's columns
on both sides), `canonicalNode`, `producedColumns`, `isWorkflowNode`,
`nodeIsUnconfigured`, `executeNode`, `toNode`, `ADD_NODE`, `KIND_STYLE`,
`miniMapColor`, `defaultLabel`, `subtitleFor`, `newNodeOfKind`, the template
factory map and the inspector chain.

`workflowGraphHash` renumbers nothing. No stored graph contains an aggregate,
`canonicalAggregate` appends only, and a hash recorded off a build predating this
change is pinned in the spec.
