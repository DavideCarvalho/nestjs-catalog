---
"@dudousxd/nestjs-catalog-store-mikro-orm": patch
---

The routing proxies forward what they stand in front of, and the build says so now

`RoutingPipelineStore` and `RoutingWorkspaceStore` are hand-written proxies, and
they had lost four methods: `publishWorkflow`, `unpublishWorkflow`,
`listTransformRevisions` and `listSavedQueryRevisions`. So in a multi-environment
deployment, publishing a workflow failed and both revision routes answered "this
store keeps no revisions" about a store that keeps them.

Omitting an optional member does not make a proxy answer *no*. It makes the
member ABSENT, and a caller probing structurally reads absent as "cannot". The
proxy answers on behalf of the store, and it answered wrongly.

This is the third time — `currentSnapshot` was the first, and the fix then was a
test with a hand-written list of method names, which is the same mechanism that
lost the first three and duly went on passing while these four were missing.

The mechanism is now a type-level assertion: every optional member of the
interfaces must appear on the proxy, and omitting one fails the build with an
error naming it. `implements` already covers the required ones.
