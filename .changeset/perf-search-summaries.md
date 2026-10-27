---
"@dudousxd/nestjs-catalog": patch
"@dudousxd/nestjs-catalog-store-mikro-orm": patch
---

Search no longer loads every saved query's SQL and visualization and every dashboard's cards on
each request. Workspace stores gain optional `listSavedQuerySummaries()` and
`listDashboardSummaries()`, which return only the fields search ranks (in the same order as the
full lists); the MikroORM store selects just those columns and the environment-routing store
forwards them. A store without them is searched through the full lists exactly as before, and the
results are identical either way.
