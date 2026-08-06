---
'@dudousxd/nestjs-catalog-react': minor
---

A path between the model and the workflows, in both directions.

`#model` and `#workflows` were siblings with no navigation between them. A sink node knew exactly
which object type it committed and could not take you there; an object type said nothing about what
loaded it, so "there is an `af_fleet` workflow — how is that tied to this type?" had no answer on
either screen.

**Workflow → model.** `WorkflowCanvas` takes a `modelHref(typeName)`, and the sink inspector — the
one node whose configuration names a type in this catalog — renders a link to the type it commits.
Nothing is rendered for a sink with no type chosen: `?type=` names nothing, and the model screen's
fallback is its first type, so the link would land somewhere plausible and unrelated.

**Model → workflow.** A new `LoadedBySection`, mounted on the type panel directly above the load
expectation — the two are one question in two halves, who loads this and what is checked when they
do. It lists every graph whose SINKS commit the type, which is deliberately not the stored
`CatalogWorkflow.targetType`: that is one string, and a graph may commit several types. Each row
says whether the graph would actually run — a draft is scheduled by nothing, a published graph may
be turned off, and one with no cron runs only when somebody starts it — because naming a type at a
sink is not the same as loading it.

The list is honest about being incomplete. An application holding a key can publish straight into a
type through the publish API, and no workflow will ever explain that load, so the caveat is
rendered whether the list is empty or not: "none" means "no graph", never "nothing". A read that
failed says so rather than rendering the empty state, because a host that mounts no pipeline
endpoints is not a deployment where nothing loads the type.

`CatalogManager` gains `type` and `workflowHref`. `type` follows the same three-step fallback as
`ObjectExplorer`'s — prop, then `?type=` in the hash, then the first type — with one difference
that is the point of it: a name this catalog does not hold is reported rather than replaced by the
first type, since a sink may name a type nothing has published yet.
