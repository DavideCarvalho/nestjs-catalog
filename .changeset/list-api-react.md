---
"@dudousxd/nestjs-catalog-react": minor
"@dudousxd/nestjs-catalog-dashboard": minor
---

The console speaks the Aviary list API. Requires `@dudousxd/nestjs-catalog` >= 0.36.0.

- `CatalogClient.objects` sends `objectQueryParams()` (`sort=-column`, `filter[property][op]=value`) and returns `{ data, meta, type, columns }`.
- `CatalogClient.search(term, size)` returns `CatalogSearchResponse` (`data` instead of `hits`); `<CatalogSearch limit>` is now `size`.
- `listEvents(query)` takes `{ event, typeName, principalId, since, size }` and returns `{ data }`; `listTraces(query)` takes `TraceListQuery` (`page`/`size`) and returns `CatalogTracePage`; `listRuns(connectorId, size)` returns `{ data }`. `auditFilterParams` builds the `filter[...]` params.
- `listPeople` and `accessRoutes().people()` take `{ search, page, size }`; `CatalogPeoplePage` is now `OffsetPage<CatalogPersonSummary>`.
- `CatalogTraceSource.listTraces` takes `TraceListQuery` and returns `CatalogTracePage`.
- Dashboard: removes the unused, stale `api.people()` (it typed the paged response as an array) and its `PersonSummary` type.
