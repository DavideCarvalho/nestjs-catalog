---
"@dudousxd/nestjs-catalog-store-mikro-orm": patch
---

A dashboard card's `library` override is now read back. The store saved it and then dropped it on every read, so the console drew the card with the query's own library. The shared workspace contract, which this store and the new Drizzle store now both run, caught it.
