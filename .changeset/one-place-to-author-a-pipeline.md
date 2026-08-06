---
'@dudousxd/nestjs-catalog-react': minor
'@dudousxd/nestjs-catalog-dashboard': minor
---

One place to author a pipeline, and no client method that 404s

The server half of this landed already: a connector stopped being an authored
object and became what a published workflow runs as. It shipped with five client
methods pointing at routes that no longer exist, and two screens for one concept.
This is the other half.

**`#connectors` and `#workflows` are one screen.** The canvas is where a workflow
is authored, end to end — draw it, save it, publish it, schedule it, run it, and
ask a source what its columns are. What is left of the old connectors screen is
`<PipelineConsole />`, which keeps the two objects a workflow *borrows* and does
not author: connections, which are the credential and address boundary somebody
manages independently of any graph, and transforms, which are code several graphs
may name. Its title, its tabs and its docblock all say so. The dashboard's tabs
are `Workflows` and `Connections`, and `#connectors` still resolves — to the
canvas, because authoring is what that screen was for.

**Every dead client method is gone rather than quietly broken.**

- `saveConnector`, `deleteConnector` — removed with the connector form. Authoring
  is `saveWorkflow` plus the new `publishWorkflow`; the fields those took are
  fields of nodes now. `ConnectorInput` went with them.
- `runConnector` — replaced by `runWorkflow(id, options)`.
- `discoverConnectorSchema(id)` — replaced by
  `discoverSourceSchema(workflowId, nodeId)`.
- `connectionConnectors(id)` — replaced by `connectionWorkflows(id)`, which is
  the question actually being asked before somebody deletes a connection.

New on `CatalogClient`: `publishWorkflow`, `unpublishWorkflow`,
`scheduleWorkflow`, `connectionWorkflows`, `discoverSourceSchema`, and a second
argument on `runWorkflow`. `pipelineRoutes()` gains the matching builders and
loses the four that addressed removed routes — a builder left behind is a path a
screen can still ask for.

**Discovery works before publication, which is the whole point of the route.** A
sink cannot commit into an object type that does not exist, so requiring a
published graph would require publishing a graph whose target type cannot be
created until it is. The panel lives on the source node's inspector, it is
enabled on a draft, and when it cannot run it says so — naming *saving*, never
publishing, because a reader told to publish first would go and find they cannot.
`SchemaDiscoveryPanel` moved out of `PipelineConsole` into its own module so both
entry points can mount it, and is exported.

**`expectShrink` is reachable, and says what it does where it is used.** It is
the acknowledgement that lets a deliberately collapsing load past the row-count
bound, it now exists on exactly one route, and without a way to reach it an
operator's only recourse is raising `rowCount.maxShrink` in the type's policy —
which stands the guard down for every future load of that type instead of for one
snapshot. So it is a control beside Run, it opens a dialog that states that
trade-off, it will not submit a blank reason, and a refused load grows a
"Re-run, acknowledging the shrink" button in the refusal itself.

**Adoption is said out loud.** A connector wrapped into a graph at boot is
published as `ready` without a person declaring it finished. An `adopted` badge
and a note on the canvas say where the graph came from and that "ready" here
means "it validated", not "somebody looked at it" — matched on `createdBy`, so a
connector that carried its own description is covered too.

Also: a `Runs as` panel showing the connector id the run history and watermark
are keyed on (and never its config — the server redacts, so the screen does not
render it at all); a `Schedule` panel that prints the server's warning when a
stored cron will never fire; `ConfirmDialog` gains `confirmDisabled`; the delete
dialog now says the connector and its history go too.

Nothing here changes what the canvas says about an unfinished node: a freshly
added node still reports its checks as work rather than as failure, and a graph
that would never run still cannot be saved quietly.
