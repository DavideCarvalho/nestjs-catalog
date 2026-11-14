---
"@dudousxd/nestjs-catalog-pipeline": minor
---

`GET runs` moves to the Aviary list API: `filter[connector]=id` and `size` (default 50, capped at 200) replace `connector` and `limit`, and it answers `{ data }` instead of a bare array. An unknown filter, a `sort` other than `-startedAt`, or a non-numeric `size` is a 400. The run store has no count or cursor, so the endpoint stays a newest-N list rather than a paged one.
