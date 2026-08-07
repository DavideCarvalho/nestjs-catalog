---
"@dudousxd/nestjs-catalog": minor
"@dudousxd/nestjs-catalog-store-mikro-orm": minor
"@dudousxd/nestjs-catalog-pipeline": minor
"@dudousxd/nestjs-catalog-react": minor
---

Reusable source and sink nodes, and the version pin they could not ship without

## The pin first, because it is a prerequisite rather than a nicety

`TransformRow` has carried a `version` since it existed. A transform node
referenced a `transformId` **and nothing else**, and `runTransform` resolved it
with `getTransform`, which answers with whatever is in the row today. The
docblock on that field claimed the opposite — "a reference rather than inline
code, so one piece of logic used at three points in a graph is versioned once and
fixed once" — and there was nothing there to fix it *to*.

That was survivable only because almost nothing was shared. Editing a transform
changed every graph referencing it, at once, and the graph's own fingerprint does
not move for it (`workflowGraphHash` excludes the transform's version on purpose,
and still does) — so there was not even a new graph version to point at. The
moment reusable nodes make sharing the point, that becomes the principal failure
mode: somebody's load changes with nothing in their diff and nothing in their run
history to explain it.

The prior art in this repo is the `call` node, which pins `callName` **and**
`callVersion` and argues in its own docblock that without the version it "would
run whichever version is registered on the day it runs" — "the exact substitution
the pin exists to prevent". So:

- **`WorkflowTransformNode.transformVersion`** and **`ReusableNodeRef.useVersion`**
  pin a version. Both resolve out of `catalog_revision`; a version the archive can
  no longer produce **fails the node**, naming the pin, and never falls back to the
  latest. That is `WorkflowRunSteps.checkCall`'s stand, applied to code stored in
  the same database.
- **Absent keeps meaning "follow the latest"**, which is exactly what every graph
  in every deployment already does. A backfill would be a behaviour change dressed
  as a migration: pinning the live version at upgrade time freezes graphs whose
  authors rely on edits reaching them, and refusing unpinned nodes stops every
  scheduled load. Neither is a decision this package gets to make for somebody.
  What changed is that following is now a **stated** position with a pinned
  alternative beside it — `describeVersionPin` turns either into a sentence a
  screen renders — rather than the only position and an unstated one.
- **Editing a shared body creates a new version; it does not refuse.** Refusing
  would strand whoever owns the node the moment anybody pinned it, and would make
  pinning a way to take something hostage. Pinned graphs cost nothing: they
  resolve through the archive and keep running the body they named. What the
  editor gets instead of a refusal is the count of who is downstream, read at the
  moment they are about to save.

## Reusable nodes

`catalog_reusable_node` holds a named node body, versioned like a transform and
archived in the same `catalog_revision` table under a new `reusable-node` subject
— one table, one retention rule, which is the argument that table already makes
for holding two subjects.

**Source and sink only.** What is reusable about a source is the *composition* —
connection **plus** query, plus mode, plus what the thing is called — not the
connection, which is already a shared object answering "which database". Nobody
reaches for "the warehouse" while drawing a graph; they reach for "the nightly
MVR pull from the warehouse". A transform is deliberately absent: it is already a
stored object referenced by id, so a reusable transform node would be a second
way to say the same thing. `call` likewise. `if` and `filter` are absent because
a predicate is *about* the rows in front of it, and `filter.narrows` is an
acknowledgement about one graph's own sinks. `NODE_KIND_IS_REUSABLE` is a
`Record` over every node kind, so a new kind is a compile error until it answers.

**By reference, never by copy.** A referencing node carries `useId` and keeps its
resolved fields as a **cache** — the arrangement `toGraph` already documents for
a source that names a connector, with the same consequence: the store folds at
save time so the pure validator and the canvas keep working, and the runner
re-reads, so an edit reaches an unpinned graph on its next run. The reference is
what survives, and it is the only reason the usage count can be exact.

**A sink's `targetType` may not move under a graph.** A graph is grant-checked
against the types its sinks write, at save time, using the type on the node. A
shared sink that could repoint it afterwards would load into a type nobody with
access to that graph was ever granted — on a schedule, with the graph's own diff
showing nothing. `applyReusableNode` refuses the disagreement, naming both types;
adopting the new one is a re-save, which checks the grants again.

## The usage answer

`GET pipeline/reusable-nodes/:id/workflows` and `GET pipeline/transforms/:id/workflows`,
both shaped after `connections/:id/connectors` (now `connections/:id/workflows`),
which answers the same question for a connection. Two differences, both
deliberate: they report one entry per **node** rather than per graph, because
whoever reads them is about to edit a body and three nodes in one graph are three
places it lands; and each entry carries `pinnedVersion`, which is what turns a
count into a decision — an unpinned node moves on the next run, a pinned one does
not.

`GET pipeline/reusable-nodes` carries a `usedBy` count on every row, because
**there is no library screen and there is not going to be one.** Reusable nodes
are offered where a node is added and the count belongs on the node itself, so
that list *is* the picker — a number that changes somebody's decision has to be
there before the click, not one request after it.

`POST pipeline/workflows/:id/nodes/:nodeId/save-as-reusable` lifts a node into
the library and answers with the `useId` to put on it. It does **not** edit the
graph: a route that stored one thing and silently rewrote another would move a
graph's version for a reason its author cannot see in their own diff.

## Why `minor` and not `major`

Nothing that exists changes behaviour. Every added field is optional and absent
means what the absence has always meant; `workflowGraphHash` appends the new
components only when they are present, so **not one of the 13 stored graphs is
renumbered** — the same rule `edge.branch` follows, and it is pinned by a test.
Every store method is optional on `CatalogPipelineStore` behind
`supportsReusableNodes` / `supportsTransformPins`, so a host's own store keeps
compiling and keeps working, and a graph with no pins runs on a store that has
neither. The new table is additive and created by the existing fingerprint-gated
`schema.update`.

This is 0.x, so `minor` is the strongest signal available for "new surface, no
removals", and that is what this is. The one thing worth knowing before upgrading
is stated above rather than hidden behind a version number: **a pin that cannot
be resolved stops a load.** Nothing is pinned until somebody pins it.
