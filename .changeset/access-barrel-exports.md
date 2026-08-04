---
"@dudousxd/nestjs-catalog": patch
---

Export the types `CatalogDirectory` is written in

`CATALOG_DIRECTORY` and `CatalogDirectory` shipped without
`CatalogDirectoryQuery` or `CatalogPeoplePage` — the argument and the return of
the one method a host is expected to implement. Implementing the seam meant
restating both by hand.

The barrel now re-exports the module wholesale rather than naming members, since
the failure was a list that fell behind the file it was listing.
