---
'@dudousxd/nestjs-catalog': minor
'@dudousxd/nestjs-catalog-pipeline': minor
'@dudousxd/nestjs-catalog-store-mikro-orm': minor
---

The workflow is the only thing anybody authors

A connector stops being an authored object. It becomes what a published workflow
runs as: minted by `publishWorkflow`, removed with the graph, with no route to
create one directly. `minor` and not `major` on purpose — this is 0.x, and the
project versions on that basis rather than on whether a route was removed.

**Routes gone.** `POST connectors`, `DELETE connectors/:id`,
`POST connectors/:id/run`, `POST connectors/:id/discover`, and
`GET workflows/:id/connectors`. `GET connectors` stays, as a read: it is where a
run history and a watermark are actually keyed, and an internal record no route
exposes is one an operator debugs by opening the database.

**Routes arrived.** `PUT workflows/:id/schedule`, because a schedule is a
statement about a pipeline and a pipeline is a graph; and
`POST workflows/:id/nodes/:nodeId/discover`, because discovery is how a type gets
its shape before anything can be published into it. `GET connections/:id/connectors`
became `GET connections/:id/workflows`, which is the question an operator is
actually asking before they delete one.

**Three things had to move rather than be dropped, and each was load-bearing.**

*Discovery.* `discoverConnectorSchema` refused any connector carrying a
`workflowId`, telling the caller to discover from the graph's source node
instead — correct advice pointing at something that did not exist. Every
connector carries one now, so the old shape would have refused every connector
there is. It takes a `DiscoverySource` and resolves through
`WorkflowRunnerService.resolveSourceNode`, the same method a run resolves with,
so a discovery cannot describe a source the load never touches. It answers on a
**draft**, deliberately: a sink cannot commit into a type that does not exist, so
requiring a published graph would require publishing a graph whose target type
cannot be created until it is published.

*The schedule.* Authored on `CatalogWorkflow` now, and `ConnectorScheduler` reads
workflows. The connector keeps a copy for evidence and nothing reads it. Every
way a schedule can exist and not fire — a draft, a disabled graph, an unparseable
cron, a ready graph with no connector — is now logged by name rather than skipped:
this loop once announced it was watching schedules every 30000ms while parsing
nothing, and a silent skip is that failure wearing a different cause.

*`expectShrink`.* The acknowledgement that lets a deliberately collapsing load
past the row-count bound reached it only through `POST connectors/:id/run`.
Removing that route without moving this would have left an operator unable to
re-drive a refused load at all, which pushes them to raise the bound in policy —
standing the guard down for every future load of the type rather than for one
snapshot. It is on `POST workflows/:id/run`, carried through the durable step
input, and a scheduled window still has no field for it.

**Existing connectors are migrated, not frozen.** `ConnectorAdoption` wraps every
connector that predates workflows into the graph it always was — one source,
optionally one transform, one sink — at boot, idempotently, and loudly. It keeps
the connector **id**, so the run history, the singleton mutex key and the
watermark stay attached to the same pipeline; **re-keys the watermark** under the
new source node, so the first run after the upgrade does not re-read an
incremental source from the beginning; and moves the schedule onto the graph. A
connector whose wrap does not validate is refused and keeps running exactly as it
was. Turn it off with `adoptConnectors: false`, and be aware of the consequence:
those connectors keep loading and no route can edit them.

**Unpublishing and deleting a workflow now cascade.** Both used to refuse while a
connector still ran the graph, on the reasoning that "point them elsewhere first"
was advice somebody could act on. It no longer is — a published graph runs as
exactly one connector, its own — so the old check would refuse every unpublish
there has ever been. Unpublishing **disables** the connector, keeping the id and
the history so re-publishing resumes the same pipeline; deleting removes it,
which takes the run history with it.

**Not included: the console.** `#connectors` and `#workflows` are still two
screens, and `CatalogClient.saveConnector`, `deleteConnector`, `runConnector`,
`discoverConnectorSchema` and `connectionConnectors` still address routes this
release removes, so those actions 404. Merging the two screens into one place to
author a pipeline is the other half of this work and is deliberately not
half-done here.
