---
"@dudousxd/nestjs-catalog": minor
---

Every catalog route says what it needs, and deleting a shared thing is recorded

**Read this before upgrading if your guard enforces `REQUIRED_SCOPES`.** Routes
that admitted any authenticated caller now refuse principals that do not hold the
scope named below. That is the point of the change, and it will produce 403s on
the day you deploy it.

## The declarations

Only the three `embed` routes carried `@RequireScopes`. Everything else on the
catalog controller declared nothing — which, per `catalog.route-auth.ts`'s own
model, is not "undecided" but "authenticated is enough". So arbitrary SQL, both
curation `PATCH`es, the overlay reset and every workspace write were open to any
principal a host's guard let past the door, while `packages/pipeline` had
declared its scopes on all 20 of its routes since it shipped.

| Routes | Scope |
| --- | --- |
| `GET /`, `graph`, `types/:name`, `objects/:name`, `objects/:name/snapshots`, `query/relations`, `workspace/capabilities`, `events`, `events/traces`, `events/traces/:id` | `catalog:read` |
| `GET saved-queries`, `saved-queries/:id`, `saved-queries/:id/export.csv`, `POST saved-queries/:id/run`, `GET dashboards`, `dashboards/:id` | `catalog:read` |
| `PATCH types/:name`, `PATCH types/:name/properties/:property`, `POST reset` | `catalog:curate` |
| `DELETE saved-queries/:id`, `POST/PATCH/DELETE dashboards` | `catalog:curate` |
| `POST query`, `POST saved-queries`, `PATCH saved-queries/:id` | `catalog:admin` |
| `GET embed`, `embed/dashboards/:id`, `embed/charts/:id` | `catalog:embed` (unchanged) |

**`POST query` is `catalog:admin`, not `catalog:read`, and that is the one worth
arguing.** Read-only is not the same as bounded. `catalog:read` is documented as
"read object metadata and rows" — rows of a catalogued type, through a route that
names one — whereas an ad-hoc statement is whatever the store's read connection
can reach. In the shipped MikroORM store that connection is the catalog's own
schema, so `SELECT * FROM catalog_principal` returns every principal's scopes,
grants and `keyHash`, the SHA-256 of its static key. Nothing else on this
controller exposes that, and handing it to a reporting principal is an
escalation, not a read. `queryRelations` lists only the catalogued types, but it
is a schema panel for the editor, not a restriction on the statement.

The two saved-query write routes follow it because they accept a `sql` field:
`POST saved-queries` plus `POST saved-queries/:id/run` is `POST query` in two
requests, and gating one without the others would make the strict declaration
decoration. Running a saved query stayed at `catalog:read` — what is held back is
*choosing what SQL runs*, not *seeing a result*, and gating execution instead
would both stop an analyst opening a dashboard and let an unprivileged caller
plant a statement for a privileged one to run.

`POST reset` is `catalog:curate` rather than `catalog:admin`: it discards exactly
what the two `PATCH`es write, and a curator can already blank every label one
request at a time, so requiring admin would deny nothing while pushing a routine
console action into the scope that manages principals.

### Who breaks, and what to do

- **A principal with only `catalog:read` that curates.** Renaming a type or a
  property, and resetting the overlay, now need `catalog:curate`. Add it to the
  principals that do the curating — that is what the scope is for.
- **A principal with only `catalog:read` that uses the SQL editor, or saves and
  edits saved queries.** Now needs `catalog:admin`. If you want analysts writing
  SQL without the rest of admin, the options are: give the catalog's read
  connection a database role that cannot see the `catalog_*` tables, in which
  case `catalog:read` is an honest declaration for your deployment and you can
  say so with `controller: false` and your own route; or grant `catalog:admin`
  deliberately, knowing what it reaches.
- **A principal with only `catalog:read` that creates or edits dashboards.** Now
  needs `catalog:curate`.
- **`catalog:admin` holders are unaffected** — it expands to every scope.
- **Hosts that pass no guard, or a guard that ignores `REQUIRED_SCOPES`, are
  unaffected.** This library declares; it has never enforced.

One consequence stated rather than left to be found: `shared` rides on the
dashboard write routes, so `catalog:curate` carries the power to hand a board to
an outside application. Splitting it would mean a route whose only job is to flip
a boolean. What makes it accountable is that the act is audited — which is the
other half of this release.

## Deleting a shared thing was silent

`query.shared` and `dashboard.shared` fired on the toggle but not on the delete
button, which is how access actually gets revoked. The trail could not answer
"when did this stop being reachable from outside" except by noticing that
something had stopped appearing — an inference from an absence, which is the
exact failure the event was added to remove.

Deleting a **shared** saved query or dashboard now emits the same event with
`shared: false` and `deleted: true`. The same event name is the decision here:
anybody asking that question filters on `query.shared` and reads the last entry,
so a `query.deleted` beside it would leave that filter reporting `shared: true`
forever for something nobody can fetch. `deleted` distinguishes "revoked, still
there" from "gone", and the payload carries the name as it last read, because
after a deletion there is nothing left to look up.

Deleting an **unshared** one emits nothing. That is the existing transition rule
rather than an exception to it: something that was not reachable from outside
before is not reachable after, so no access changed, and recording it would put
entries carrying neither a grant nor a revocation on the one channel whose
entries all carry one. A host that wants every deletion in the trail wants a
workspace-lifecycle event, which is a different event and is not this one.

**API change:** `CatalogService.deleteSavedQuery(id)` and `deleteDashboard(id)`
now take the actor as a second argument, matching `saveQuery` and
`updateSavedQuery`. Required rather than defaulted — a default would quietly
attribute revocations to nobody in every caller that was not updated. The
built-in controller passes the host-resolved principal, falling back to
`"console"`; a host with its own controller passes whatever it resolves. The
`CatalogWorkspaceStore` interface is unchanged: the store takes no actor, because
a store that emitted would emit on every path into it and could not tell a
revocation from a cascade.

## Still true and not fixed here

`POST reset` discards every curation edit in the catalog and emits nothing, while
`patchType` and `patchProperty` each emit `type.curated`. The trail can therefore
say who renamed a column but not who reverted every name at once. It needs an
event `CATALOG_EVENTS` does not have — `type.curated` requires a `typeName` and a
reset has no single one — so it is named rather than papered over.
