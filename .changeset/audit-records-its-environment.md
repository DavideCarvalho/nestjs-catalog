---
"@dudousxd/nestjs-catalog-store-mikro-orm": minor
"@dudousxd/nestjs-catalog": patch
---

An audit event can finally say which environment it happened in, and a trace can say when its steps happened

**The recorder injects `CATALOG_WORKSPACE_STORE` instead of `MySqlWorkspaceStore`.**
This is the release-visible one. `environment.routing.ts` explained at length that
handing `CatalogAuditRecorder` the routing store is what makes "every audit event
records its environment" true by construction — but the recorder asked for
`MySqlWorkspaceStore` *by class*, and `RoutingWorkspaceStore` implements the
interface rather than extending the class, so no host could ever substitute it.
In a multi-environment process every audit row landed in whichever single
database the recorder happened to be constructed against, under no environment
column: a dev event sitting in the production audit table, reading exactly like a
production one. Every sibling in the package already injected by token; the
recorder was the only one that did not.

The single-environment default is unchanged — `CatalogMikroOrmStoreModule` already
binds that token to `MySqlWorkspaceStore`. A host that constructs the recorder
itself and provides only the concrete class must now bind the token too.

**`stampEnvironment` has a call site.** It shipped with a paragraph about
answering "everything this person did this week" across environments and was
referenced by nothing. `RoutingWorkspaceStore.listEvents` now stamps what it read
and widens its return type to say so. It happens there and cannot happen anywhere
else: that reader is the only one that resolved an environment in order to choose
the connection, which is the whole reason the value is stamped on read rather
than stored in a column a row could lie in.

**`CLOCK_RESOLUTION_MS` was stale by three orders of magnitude.** The audit
column was widened to `datetime(3)` and this constant went on saying `1_000`, so
`coarse` was set for every trace that finished inside a second — which is most of
them. The explorer answered with a dashed track and "there is no internal timing
to draw" over spans whose real spacing was sitting in the rows, on exactly the
loads a waterfall exists for. Rows written before the widening are still whole
seconds and still come back `coarse`, which is the truth about them.

**And three docblocks corrected rather than built.** `TransformRow` claimed a row
per version; there is one row, overwritten in place, and `saveTransform` bumps a
counter on it — real versioning is a schema change with its own retention
question, and the console rendering `code v3` was already inviting operators to
believe a bad load's source was recoverable. `CatalogPromotionPlan.fingerprint`
claimed an apply endpoint that recomputes and refuses; there is none in this
repository, and the check belongs to the host, phrased the way `applyPromotion`
already phrases it. `CatalogEnvironment.protected` claimed the API demands
confirmation; nothing server-side reads it and the only reader paints a badge, so
it is now documented as advisory until a host enforces it.
