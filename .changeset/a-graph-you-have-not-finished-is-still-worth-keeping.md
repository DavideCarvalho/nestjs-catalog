---
"@dudousxd/nestjs-catalog": minor
"@dudousxd/nestjs-catalog-store-mikro-orm": minor
"@dudousxd/nestjs-catalog-pipeline": minor
---

A workflow can be saved unfinished, and publishing is what validates it

Validation used to be the gate on *saving*. `MySqlPipelineStore.saveWorkflow` ran
`validateWorkflow` and refused anything with an issue — `"<name>" cannot run as
drawn.` — so a graph you had not finished could not be written down at all, and
closing the tab lost it. A saved workflow was, by definition, one that runs.

That also made the canvas lie about ordinary work. Clicking **+ Sink** produced a
node that "is not reachable from any source" and "does not say which object type
it writes": both true, both useless one second after the click, because a
just-added node is unwired by construction.

So the gate moved rather than loosened. `CatalogWorkflow` gains
`status: 'draft' | 'ready'`. A draft saves without validating; only a `ready`
graph runs, is schedulable, or is promoted. The same `validateWorkflow` still
decides — a draft is not a graph that skipped the rules, it is a graph nobody has
claimed is finished yet.

## What a host does on upgrade

**The schema gains one column, and its default is the decision.**
`catalog_workflow.status` is `varchar(16) NOT NULL DEFAULT 'ready'`, applied by
`ensureCatalogSchema` like every other change in this package — there is nothing
to run by hand. It backfills every existing row to `ready`, deliberately: each
one got there through a save that refused anything invalid, so each is a graph
that was valid when it was written, which is exactly what `ready` asserts.
Defaulting to `draft` would have been the conservative-looking choice and would
have silently stopped every scheduled connector on the deployment the moment the
migration ran, because a connector may only run a ready graph. A default that
turns an upgrade into an outage is the wrong default.

**New graphs now arrive as drafts.** Anything automating `POST workflows` and
expecting the result to be immediately runnable must now call
`POST workflows/:id/publish`. This is the one behavioural break: a script that
created a workflow and attached a connector to it in the same breath will now be
refused at the connector save until it publishes.

**Two new routes**, both `catalog:write`: `POST workflows/:id/publish` and
`POST workflows/:id/unpublish`. Publishing is a transition rather than a field on
save because "ready" is a claim that has to be checked, and a check that fails
owes an explanation naming the nodes — a boolean on a save request has nowhere to
put that which is not an error on an operation the author thought was about
something else.

**Two new store methods.** `CatalogWorkflowStore` gains `publishWorkflow` and
`unpublishWorkflow`, and `supportsWorkflows` now asks for `publishWorkflow` by
name. A custom store implementing the interface must add both; one that has the
save and not the transition would narrow cleanly and then fail one call into a
promotion that had already written types and transforms into the target.

## The three refusals worth knowing about

**A connector may only point at a `ready` workflow, refused at save.** The check
could equally have lived in the runner, and that is the version worth arguing
against: it would move the error from the person wiring the connector — who is
looking at the screen and can fix it in one edit — to a scheduled window at 3am.

**A published workflow edited into an invalid state is refused, not demoted.**
Silently dropping it back to `draft` was the alternative, and it is the one that
loses a running pipeline without saying so: connectors may only run ready graphs,
so the demotion would disable a scheduled load with nothing reported. Unpublish
it explicitly to park a broken idea on a live graph.

**Unpublishing is refused while any connector still runs the graph**, naming
them, exactly as `deleteWorkflow` already did. Cascading — disabling those
connectors here — was rejected on principle: turning off somebody's loads as a
side effect of an edit to something else is the silent action this status exists
to prevent.

## Promotion

Drafts are not in the promotable set at all, which is stronger than refusing a
draft promotion and is the statement worth making: a draft may have no sink, so
there is not even a well-formed thing to describe to a reviewer. Nothing can be
hidden by the omission, because no connector can reference one. `promoteWorkflows`
now saves *and publishes*, since a save drafts and the connector phase that
follows cannot attach to a draft — and the publish re-validates the graph against
the transforms that actually arrived in the target rather than trusting that it
was ready in the source.
