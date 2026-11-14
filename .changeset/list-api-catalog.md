---
"@dudousxd/nestjs-catalog": minor
---

Move the HTTP list endpoints to the Aviary unified list API. No aliases for the old params or shapes.

- `GET objects/:name`: `filter[property][op]=value` replaces `filter=property:op:value`, `sort=-column` replaces `sort` + `dir`, `page`/`size`/`search`/`snapshot` stay. Answers `{ data, meta: { total, perPage, currentPage, lastPage, firstPage } }` with `type`, `columns` and `snapshot` beside them; `rows`, `page`, `size`, `total` and `pages` are gone. An unknown sort column is now a 400 instead of falling back to the primary key; so is an unknown filter property or operator, and a non-numeric `page`/`size`.
- `GET search`: `search` + `size` replace `q` + `limit`. Answers `{ data: hits, term, total, truncated }` (`CatalogSearchResponse`). Still a ranked top-N, not paged.
- `GET events`: `filter[event]`, `filter[type]`, `filter[principal]`, `filter[occurredAt][gte]` and `size` replace `event`, `type`, `principal`, `since` and `limit`. Answers `{ data }`.
- `GET events/traces`: the same filters plus `filter[outcome]`, with `page`/`size` replacing `limit`/`offset`. Answers the offset envelope plus `unlinked`, `unlinkedTotal` and `clockResolutionMs` (`CatalogTracePage`).
- `GET access/people`: `page`/`size` replace `limit`/`offset`; answers `{ data, meta }`. A non-numeric `size` is a 400; over the cap is clamped.
- `/client`: `objectQueryParams()` and `objectFilterParam()` build the new wire; `encodeObjectFilter` and `parseObjectFilter` are removed. `ObjectQueryParams` is now `{ page, size, search, sort, filters, snapshot }`. `CatalogObjectQuery.filters` and `resolveObjectFilters` take `CatalogObjectFilter` objects instead of strings. The `OffsetPage`/`CursorPageResponse` envelope types are exported.

Store SPIs (`listEvents`, `listTraces`, `listPeople`, `read`) are unchanged; the HTTP layer translates.
