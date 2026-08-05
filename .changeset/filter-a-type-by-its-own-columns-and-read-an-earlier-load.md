---
'@dudousxd/nestjs-catalog': minor
'@dudousxd/nestjs-catalog-store-mikro-orm': minor
'@dudousxd/nestjs-catalog-react': minor
---

Filter a type by its own columns, and read it as of an earlier load

The object explorer offered paging, a search box and a sort. Two things it did
not offer are now here, and both are derived rather than configured.

**Filters come from the type.** `GET objects/:name` now answers with
`filterOperators` on every column — computed from the column's own scalar type
by `filterOperatorsFor`, then narrowed to what the mounted store declares it can
apply. Nothing anywhere lists a filterable column, which matters because these
types are created at runtime by `PUT publish/:type/schema`: a column published
this morning is filterable this morning, with no list for it to be missing from.
`?filter=property:operator:value` may be repeated, and a range is `gte` and
`lte` on one property. A filter is resolved against the type before any store
sees it and carries the property *definition*, so a caller's string is never a
column name; a filter that cannot be honoured is refused by name rather than
dropped, because a dropped filter comes back as an unfiltered page presented as
the matching rows. Classified columns take no filters at all — a range filter
lets a reader binary-search a value they may not see.

**A store says whether it filters.** `CatalogFilteringReadStore` +
`supportsObjectFilters`; the MikroORM read store and the MySQL warehouse store
declare all nine operators. A store that declares none offers no controls and
refuses a filter rather than answering unfiltered.

**And a snapshot picker.** Every earlier load is still in the type's physical
table — the machine for time travel was already built and nothing exposed it.
The explorer now lists a type's loads and reads as of one, defaulting to
current, saying unmistakably when it is not, and never touching the SQL view the
query console selects from. `CatalogReadResult` and the object page carry
`{ id, current }` from the store, so the warning is driven by what was read
rather than by what the screen believes it asked for.
