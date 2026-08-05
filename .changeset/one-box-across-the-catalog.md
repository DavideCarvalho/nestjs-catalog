---
"@dudousxd/nestjs-catalog": minor
"@dudousxd/nestjs-catalog-react": minor
---

One search box across the whole catalog

Finding anything in a catalog meant already knowing which screen it lived on:
object types and their properties on Model, saved queries on Query, boards on
Dashboards. At two hundred types that *is* the experience, and the thing a
person actually types is a word they half-remember.

`GET /catalog/search?q=…` answers across four kinds in one call — object types
(name, display name, plural, description, group), properties (name, display
name, description, unit), saved queries (name, description, folder) and
dashboards (name, description) — ranked as one list. `CatalogClient.search(term)`
and `<CatalogSearch />` are the client half; the component takes the same
`explorerHref` prop the model screen does, plus optional `savedQueryHref` and
`dashboardHref`, and renders a row as a plain row rather than a dead link where
the host mounted no screen for that kind.

**The ranking is four named tiers, not a score.** `exact`, `prefix` and `name`
for a match on what a thing is *called*; `text` for one in what somebody *wrote
about* it — a description, a group, a unit. Ties break by kind (type, property,
saved query, dashboard) and then by label, so the same term always gives the
same order. Every hit carries the tier and the field it matched, which is what a
row shows instead of a number nobody can predict.

**Results are filtered by the caller, which is a deliberate exception to this
library's read path.** Every other read here applies no grants — the host wraps
them, see the note above `mayWrite` in `catalog.principal.ts` — and that
position does not survive a search box: a host can wrap a read whose subject it
knows, and cannot wrap one whose result set is chosen by a stranger's typing.
So `GET search` looks at `request.principal`, drops every type `mayRead`
refuses **and its properties with it**, and drops every property whose
classification the caller does not hold. The name is the disclosure in both
cases — "there is a type called `PayrollAdjustment`" and "there is a column
called `settlementAmount`" are answers, even with no row attached — and `total`
is counted after the filter so the count cannot report what the rows do not.

An absent principal filters nothing, and that is not a fail-open: in a
deployment with no guard `GET /catalog` already hands over the whole snapshot,
so search is exactly as open as the route beside it and strictly narrower the
moment a principal appears.

**What a hit does not carry:** no `sql`, no property list, no card layout —
enough to draw a row and follow it. The matcher is not given a saved query's
statement at all, so a search cannot become a code search and a fragment of SQL
cannot end up in a dropdown.

**Connectors and transforms are deliberately out.** They are served by
`@dudousxd/nestjs-catalog-pipeline`, which this package does not depend on, and
folding them into a route declared `catalog:read` would re-grant a surface
carrying connection references and `secretEnvVar` under a scope their owner
never agreed to. A console that wants them in the same box makes a second call
against the pipeline's own routes, under the pipeline's own guard — which is
honest about the fact that they are two permissions.

Nothing is mounted for you: export `CatalogSearch` from
`@dudousxd/nestjs-catalog-react` and place it wherever your shell wants a search.
