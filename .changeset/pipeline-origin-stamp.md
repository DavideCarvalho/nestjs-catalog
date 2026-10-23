---
"@dudousxd/nestjs-catalog-pipeline": patch
---

Guarantee catalog runs are stamped with `origin: '@dudousxd/nestjs-catalog-pipeline'`, so the durable
console's ORIGIN facet separates `catalog.connector-run` / `catalog.workflow-run` from the app's own
runs. The origin is derived by `@dudousxd/nestjs-durable` from the `@Workflow` classes' declaring
file, which only happens from 0.40.0 on, so the peer range moves from `>=0.39.0` to `>=0.40.0`.
