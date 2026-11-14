---
"@dudousxd/nestjs-catalog-pipeline": minor
---

`GET runs` moves to the Aviary list API: `filter[connector]=id` and `size` (default 50, capped at 200) replace `connector` and `limit`, and it answers `{ data }` instead of a bare array. An unknown filter, a `sort` other than `-startedAt`, or a non-numeric `size` is a 400. The run store has no count or cursor, so the endpoint stays a newest-N list rather than a paged one.

Every list endpoint answers 400 for a query param it does not read — the removed forms (`limit`, `offset`, `dir`, `q`, a bare filter field such as `?connector=` or `?outcome=`) and `page` on a top-N — naming the replacement, instead of ignoring it and answering with defaults.
