---
"@dudousxd/nestjs-catalog-store-mikro-orm": patch
---

A dashboard card's `library` override is now read back. The store saved it and then dropped it on every read, so the console drew the card with the query's own library. The shared workspace contract, which this store and the new Drizzle store now both run, caught it.

An edit that changes nothing no longer moves a dashboard's or a saved query's `updatedAt`. On Postgres, `jsonb` stores the cards and the visualization with their keys reordered, so resending the same value read as a change. Both are now compared as JSON before they are assigned.
