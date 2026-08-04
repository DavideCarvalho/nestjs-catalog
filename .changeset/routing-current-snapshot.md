---
"@dudousxd/nestjs-catalog-store-mikro-orm": patch
---

The routing store now forwards `currentSnapshot`

`RoutingCatalogStore` proxies a `MySqlWarehouseStore`, which implements
`currentSnapshot`, and did not forward it. That did not make the proxy answer
"no" — it made the method absent, and a caller probing structurally reads absent
as "this store cannot answer".

What that costs is not hypothetical. A caller with no pointer falls back to the
newest entry in `listSnapshots`, which `catalog.store.ts` calls not survivable:
after a rollback the newest snapshot is precisely the one that was rolled back,
so the fallback aims the reader at data somebody deliberately stopped serving.

Still probed rather than assumed — the bundle's store is whatever the host bound,
and forwarding blindly would turn a missing method into a crash inside a proxy
the caller did not know was there.

The real defect was that a hand-written proxy had no test that fails when the
list falls behind. It has one now.
