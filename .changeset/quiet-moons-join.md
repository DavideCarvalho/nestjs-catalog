---
'@dudousxd/nestjs-catalog': minor
'@dudousxd/nestjs-catalog-pipeline': minor
'@dudousxd/nestjs-catalog-react': minor
---

A `lookup` node kind — enrich each row from a reference dataset, by key, with only one side held

**Replicating flip's SUBWO reader in the catalog succeeded on every per-record
column except three, which came out hard null:** `planName`, `planDescription`
and `unitMel`. flip fills them by building two maps in a first pass —
`plansMap` from `vscos_work_plan`, `unitDictionariesMap` from `unit_dictionary`
— and reading them per row. The catalog had no way to express that. The only
workaround was a whole-batch transform holding both datasets, which is the
ceiling problem: a comparable transform over these 44,720 rows reached 78% of a
hard 32 MiB output bound.

Joining against reference data is, after renaming, the most common operation in
ETL.

## The property that justifies a kind rather than a transform

**One side is held; the other streams.** The reference is read once into a map
keyed by its key column; the driving rows then go past it a batch at a time and
never accumulate. That asymmetry is a property of the *operation*, and it is not
expressible as a function over a batch — a transform is handed both sides at
once, which is why `ConnectorRunnerService` has to log *"Held all N records in
memory"* when one is present. A per-record transform cannot do it either: a
function over one record has nowhere to put the map, so it would rebuild it
44,720 times or reach a database 44,720 times.

The generic `transform` still exists, and that is what lets this node stay
narrow forever — the argument `rename` makes. No composite keys, no expressions
on either side, no join type beyond the three below. The answer to "I need more
than this" is always *use a transform*.

## Where the reference comes from: an edge, named

The reference is **another node in the graph**, and `reference` says which of the
inbound edges it is.

Not a connector on the node, because a source is already a modelled thing with a
kind, a connection, a secret, a mode, a config, discovery and staging — a second
copy inside this node would fork it. Wiring a source in means the reference
composes: `sourceKind: 'catalog'` reads the **current snapshot** of a published
type, resolved when the run reaches it and naming no physical table, which is the
natural reference; a `sql` source reads a code table out of an operational
database; and a filter or a rename may sit in between.

Not the first inbound edge, and that is the sharp one. Edge order is defined and
does decide what a multi-input node receives — but for every other kind,
reordering two wires changes only the order rows are concatenated in. Here it
would decide **which side is held entirely in memory**, and swapping them turns a
working graph into one that either holds 44,720 rows to enrich 200 or joins the
two the wrong way round and reports success. Reordering edges is invisible on a
canvas.

## Which side streams, and the bound on the other

The driving side streams. The reference is bounded at
`WORKFLOW_LOOKUP_MAX_REFERENCE_ROWS` (200,000) and refused **before a row is
read**, because a staged input announces its `rowCount`. A bound discovered by
allocating until it hurts has already done the damage, and the damage is a pod
killed by the kernel — no run log, no failed node, no message. What is retained
per key is the values of the *named fields*, not the reference row, so the bill
is a property of this node's config rather than of somebody else's schema.

## A key that matches nothing

`unmatched: 'null' | 'drop' | 'fail'`, defaulting to `null` — a LEFT JOIN, an
INNER JOIN, and "this reference is a prerequisite" (which is not hypothetical:
flip's docs make seeding the unit dictionary a prerequisite of MEL, MVR and
SUBWO, and an unseeded one yields unnormalized rows rather than an error).

**Whichever it is, the run log carries three numbers:** how many rows matched,
how many had a key that matched nothing, and how many had no key at all. The
third is separate because it has a different cause and a different fix, and
flip's reader folds both into the same NULL. Up to five of the unmatched keys are
named, which is what turns "nothing matched" into "the two sides spell it
differently" in one glance. A run where nothing matched gets a line of its own,
the way a filter that kept nothing does.

That reporting is the actual change. Defaulting to `null` reproduces what flip
does today; counting it out loud is what makes a zero-match join distinguishable
from a working one.

## Two reference rows for one key

**Refused when they disagree about a named field, collapsed when they agree.**
Agreeing costs nobody anything — there is no winner and the answer is the same
either way — and it is what a reference table looks like when it has one row per
key *and* something else. Disagreeing fails the node, naming the key, the field
and both values, while the map is being built and before any output is written.

Picking a winner is a rule about whose data survives, which `renameColumnRefusals`
already refused for two columns renamed onto one name. flip is the argument for
refusing rather than choosing: it keeps the **last** duplicate for the plan map
(`plansMap.set`) and the **first** for the unit dictionary (`Array.find`), forty
lines apart in one file, and neither key column has a unique constraint.

## A name the driving rows already carry: empty is filled, occupied is refused

The rule is about **destroying a value**, not about a name being taken, and the
real data is what settled it. `SubwoReplica` *declares* `planName`,
`planDescription` and `unitMel` as properties, so all 44,720 of its rows arrive
carrying those keys with `null` in them — which is exactly the three columns
this node exists to fill. An earlier version refused a taken name and thereby
refused its own motivating case, with no way to express the graph at all: there
is no node that drops one column, and a rename that dropped what it did not name
would have had to list all 76.

So a target that is absent or holds `null` is filled. A target holding an actual
value fails the node, naming the column, the row's key and the value that would
have been lost. Whether a column holds a value is a fact about the data rather
than about the graph, so the run decides it rather than the validator.

## What the validator can now prove

`workflowKnownColumns` takes an optional input filter, because a lookup is the
only node whose inputs are **not interchangeable**: the reference's columns never
flow on. A walk that pooled them would accept a filter naming a reference-only
column, which matches no row and commits — the precise failure
`checkColumnsProduced` exists to catch, produced by the check itself.
`workflowLookupColumns` is the exported split, and the inspector reads it rather
than working one out.

What a lookup produces is **exact** when its driving side is known: what arrived
plus the names it was told to add, and nothing else.

## Keys are compared as text, exactly as written

`String(value)`, no trimming and no case folding, and `null`/`undefined`/`""`
mean *no key*. The coercion is there because the two sides come from different
engines and `43` and `"43"` are the same plan code to everyone except `===`. The
limit is there because normalising the *shape* of a value is a rule about which
of somebody's values are the same value — and flip's reader is the cautionary
tale: it normalises the driving unit and compares it against a column normalised
at write time by a different screen, so the two agree only for as long as nobody
edits either.

## Measured against the real 44,720 rows

`SubwoReplica`'s head snapshot in a real deployment, read through a `catalog`
source, joined against `flip.vscos_work_plan` read through a `sql` source:

| | |
|---|---|
| driving rows | 44,720 |
| reference rows / distinct keys | 1,667 / 1,667 |
| matched | **44,504** |
| key matched nothing | **216** |
| no key at all | **0** |

`planName` and `planDescription` come out filled — `"FLMN-Field Level
Maintenance"` on the `43AA` rows — where the replica had hard null. Under
`unmatched: 'drop'` the same run passes 44,504 of the 44,720. The five unmatched
keys the log names are `"SBL275-16-001"`, `"BODY MOUNTS"`, `"LIGHTING WARNING
LIGHT"`, `"2AZ"`, `"L275-16-003"` — which is the diagnosis rather than a
mystery: those are the rows where flip's reader falls back to `Work Order Desc`
for the plan key, so they are work-order text rather than plan codes and a plan
catalogue was never going to hold them.

Adding one deliberately disagreeing second row for the real code `43AA` fails
the node, naming `43AA` and both values.

## Nothing stored is renumbered

`workflowGraphHash` gains a branch for a new kind, so no existing graph's
canonical string changes; a pinned fingerprint recorded before this release is
asserted. `unmatched` is appended only when it is not the default, so a canvas
that normalises the field cannot bump a version. `NODE_KIND_IS_REUSABLE` says
`false` — `reference` is a node id in *this* graph, so a shared body would carry
the id of a node the adopting graph has never had.
