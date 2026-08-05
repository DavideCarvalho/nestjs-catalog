---
"@dudousxd/nestjs-catalog": minor
"@dudousxd/nestjs-catalog-store-mikro-orm": minor
---

The curation trail can finally name who.

`type.curated` fires whenever somebody renames a column, changes a unit, hides a property or sets a
classification, and its own docblock justifies its existence: *"who renamed this column and when is a
governance question, and the answer is otherwise nowhere."* Its payload carried `typeName`, `property`
and `changed` — so it answered *when* and *what*, and never *who*. `overlay.reset`, added last
release for the catalog-wide revert, shipped with the same hole and a docblock explaining it as a
limit rather than a decision.

Two things made that worth fixing rather than documenting. `query.shared` and `dashboard.shared`
have named their actor since the day they were added, so the trail was inconsistent in a way that
reads as a bug in whichever half you look at second. And curation is the one act this library
describes as surviving the publisher's next deploy — a decision that outlives deployments and could
not name its author.

**Both events now carry `principalId`**, threaded from the route that resolves a principal down to
the registry that emits. It holds the whole `CatalogPrincipal.id`, composite half included, matching
`query.shared`: `parsePrincipalId` recovers the application from an `<app>#<person>` id, so nothing
is lost by carrying the person, while dropping to `applicationId` would file a curator's decision
under the console they signed into. It is spelled `principalId` and not `curatedBy` because that is
the key `CatalogAuditRecorder` lifts into the audit table's indexed column.

## 💥 Breaking: `CatalogRegistry` takes the actor

`patchType`, `patchProperty` and `resetOverlay` each take the acting principal's id as a new, final,
**required** argument.

- **Your call sites need it.** `registry.patchType(name, patch)` becomes
  `registry.patchType(name, patch, principal.id)`; `patchProperty` gains a fourth argument and
  `resetOverlay` a first. The compiler names every one. `CatalogService`'s three forwarders take it
  too, so a host that wrote its own controller against the service is updated the same way.
- **Your subclasses keep compiling, and that is the part to check by hand.** TypeScript lets an
  override take fewer parameters than it promised, so a registry of your own that still declares
  `patchType(typeName, patch)` is a legal implementation and will not be flagged. What *will* fail
  to compile is its emit: `CatalogEventPayloads['type.curated']` now requires `principalId`, so any
  implementation that emits its own curation event has to have one to put there. Add the parameter
  and pass it through.
- **Required rather than optional, deliberately**, on the argument `CatalogService.deleteSavedQuery`
  already makes about its own `deletedBy`: a default quietly attributes the act to nobody in every
  caller that was not updated, and naming somebody is the entire value of the record.
- **No value is ever empty.** A producer with no principal in hand emits the exported
  `UNATTRIBUTED_PRINCIPAL_ID` (`"unattributed"`) via the exported `curationActor()`. The recorder
  writes a falsy actor as NULL, and NULL in that column reads as "nobody did this" rather than "this
  was not captured" — and an unauthenticated mount gets `"console"` from the controller, the same
  fallback the sharing routes use, which is the narrower and more useful claim.

The emit stays inside each registry rather than moving up to the service or the controller. A host
calling `patchProperty` from a migration script or an admin job would otherwise emit nothing, which
would quietly redefine the trail as "curation that happened to go through the bundled controller" —
the same class of gap the actor was missing from. The registries also know things the layer above
does not: the stored one decides whether a patch landed on a column or a link, and only the in-app
one can summarise the overlay it is about to destroy.

## The environment hop

`RoutingCatalogRegistry` forwards these calls by hand, and it forwards the actor with them. This is
the hop the field would have been lost at, and it fails differently from a dropped method: the patch
lands, the response is a 200, the audit row is written — and its actor says `unattributed`, in
exactly the multi-environment deployments that have a governance team reading the trail.
`environment.routing.curation.spec.ts` asserts what the registry *behind* the proxy received, because
every other observable is identical whether the actor was forwarded or not.

`StoredCatalogRegistry.resetOverlay` still refuses and still emits nothing, and it declares no actor
parameter — accepting one would advertise a record it never writes.
