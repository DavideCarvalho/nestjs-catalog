---
"@dudousxd/nestjs-catalog": minor
"@dudousxd/nestjs-catalog-store-mikro-orm": minor
"@dudousxd/nestjs-catalog-pipeline": minor
"@dudousxd/nestjs-catalog-react": minor
---

Workflow releases, and the version a schedule actually runs

## Editing a graph was deploying it, on a cron, silently

`ConnectorScheduler.fire` put `workflow.version` into the run payload — the
version on the row, which is to say the latest save. A `ready` graph stays ready
through an edit, deliberately: `saveWorkflow` refuses to demote one, because
demoting would disable a scheduled load with nothing said to anybody. So there
was no step between editing a live pipeline and the next cron tick executing what
had just been typed. The only gate was `ready` versus `draft`, and an edit does
not cross it. Somebody dragging a box on a canvas at 02:59 changed what ran at
03:00.

So: a graph can be **released**, and a released version can be made **live**.
A scheduled window runs the live version. Editing bumps a counter nothing reads.

- `POST workflows/:id/releases` freezes the graph as it currently stands and
  **deploys nothing**.
- `PUT workflows/:id/live` chooses which released version runs. This is the
  deploy, and the same call with a smaller number is the rollback.
- `POST workflows/:id/run` takes an optional `version`, so a new release can be
  tried without becoming what the cron executes.

**Nothing is backfilled.** `liveVersion` absent means follow the latest save,
which is what every graph in every deployment does today and what every existing
graph keeps doing until somebody deliberately releases and deploys one. Pointing
every existing graph at its current version would have been a deploy of every
pipeline on the deployment, performed by a migration, at a moment nobody chose.

## The argument against archiving graphs, answered rather than ignored

`CatalogWorkflow` states that a graph is not revisioned, and the decisive reason
it gives is the counter: `version` is bumped on **draft** edits by design — so a
run's `workflowVersion` can never mean two different graphs — and archiving one
body per version would therefore store every autosave of a canvas somebody is
still dragging boxes around on, under a bounded archive that would then evict the
versions which actually ran.

That argument is correct and this change does not weaken it. It is an argument
against archiving **saves**, and this archives **releases**. `saveWorkflow` writes
nothing to `catalog_workflow_release`; neither does `publishWorkflow`, which is
idempotent and is what an environment promotion presses — a release minted there
would appear in an environment as a side effect of promoting configuration into
it. One route mints one, and a person presses it. The counter stays cheap to
inflate and the archive stays sparse, because they are counting different things.

The other half of that docblock — that a graph is a structure and a line differ
over serialised JSON reports a dragged box as a change — is untouched. This is
not a diff feature. It stores a graph so a version can be *run*.

## Releases are never evicted, unlike revisions

`catalog_revision` is capped per subject at `CATALOG_REVISION_LIMIT`, and that
cap is right for code: revisions grow with how often somebody edits, which nobody
meters, and each row carries a whole body. Adding a `workflow` subject to it was
the obvious move and is the wrong one, for a reason sharper than the `text`
column. The row a live pointer names is the graph **production is running**, and
an eviction rule that could delete it would stop a working pipeline to enforce a
storage policy.

So `catalog_workflow_release` is its own table and nothing evicts from it. That
makes it unbounded, which this codebase is careful about, and it earns that on
the same test `catalog_audit_event` and `catalog_connector_run` pass: one row per
thing a person deliberately did, at a rate an operator reads off their own change
process.

Releases are also immutable, and there is no route that removes one — which is
the strongest available form of "refuse to delete the version that is live":
there is no operation to refuse. The exception is `deleteWorkflow`, which already
takes the connector and the entire run history, so the releases go too; nothing
that could still cite one survives. (Deleting a *transform* leaves its revisions,
for the opposite reason: the runs that ran them do survive.)

## A pointer on the workflow, not an environment table

The request named the environment — "which version is in production in the
environment" — and this catalog has a real environment concept. It isolates them
*physically*, one database each, so a `catalog_workflow` row already exists once
per environment and a pointer on it is already per-environment. The environment
is the connection. A second dimension keyed on the environment id would be a
table whose every query filtered on a constant.

It is `liveVersion` rather than `productionVersion` because "production" here is
the *name of an environment*, and a column called that on a row which lives inside
exactly one environment would read as naming a different one.

`liveVersion` deliberately **does not cross a promotion**. `planPromotion` is
explicit that version numbers do not cross — a version counts edits made in the
environment it lives in, so dev's v7 and production's v7 are unrelated numbers —
and a pointer *to* a version inherits that argument whole. A promoted graph
arrives following the latest, exactly as a newly created one does.

## A run now finishes on the graph it started on

Every step used to load the head and refuse if the version had moved, which was
the only honest answer available when a graph kept nothing but its latest shape:
a load edited at node three died at node three. With the archive there is a third
answer, and `requireWorkflowAt` takes it — a run is pinned to its version for its
whole life, so a deploy mid-run does not swap the graph underneath it.

Where the archive cannot answer, **nothing falls back to the head**. That is the
same stand the call node's version check takes, in the same words: running the
newest thing available while the graph says otherwise is exactly the substitution
a pin was written down to prevent. A store from before this change reaches the
identical refusal through the capability predicate rather than a `TypeError`.

## Migration

Additive, and it renumbers nothing. One nullable column, `catalog_workflow.live_version`,
with **no default** — the opposite of the `status` and `enabled` defaults beside
it, and by the same test: those default to something because leaving them empty
would stop a working pipeline, and this defaults to nothing because filling it in
would change what a working pipeline runs. One new table,
`catalog_workflow_release`. `workflowGraphHash` is not touched at all, so no
stored hash moves and no stored graph is invalidated.
