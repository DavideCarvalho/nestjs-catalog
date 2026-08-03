---
'@dudousxd/nestjs-catalog-pipeline': minor
---

The connector pipeline, as a package

Fetch, transform, publish was application code in two places at once: the standalone catalog service
and a copy of it mounted inside another app. The two had already drifted — one of them was missing
the scheduler entirely, so `connector.schedule` was a column nothing acted on until it was ported by
hand. That is the failure duplication always produces eventually, and it is why this is a package.

Two things the engine cannot decide for itself are injected rather than imported, because the two
applications it came from disagreed on both:

- `CATALOG_PIPELINE_EM` resolves the EntityManager a write lands on. It is a **function**, not a
  value: a multi-environment host picks the connection per call, and a value captured at construction
  would pin every write to whichever environment was current at boot. Writing to the wrong database
  is not a type error and the rows land successfully.
- `CATALOG_PIPELINE_REGISTRY` is the registry the engine reads the model from — only `reload()` and
  `getType()`, which is all either application used.

`CATALOG_PIPELINE_SCOPE` covers the third difference. A durable step is a message off a queue and a
scheduler tick is a timer callback, so neither carries an ambient scope; a host routing one store
across several environments enters one, and a single-connection host binds the pass-through default
and pays nothing.

The scheduler's "should this process poll?" is an option instead of the `APP_TYPE` check the copy
carried, which was one host's role split leaking into shared code.
