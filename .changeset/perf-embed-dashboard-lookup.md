---
"@dudousxd/nestjs-catalog": patch
"@dudousxd/nestjs-catalog-store-mikro-orm": patch
---

Read an embedded dashboard's saved queries in one lookup instead of one per card. Workspace stores
gain an optional `getSavedQueries(ids)` (implemented by the MikroORM store as one `IN` query, and
forwarded by the environment-routing store); a store without it, or a batch read that fails, falls
back to one lookup per card as before, and the cards that are skipped are the same.
