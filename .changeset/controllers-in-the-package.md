---
'@dudousxd/nestjs-catalog': minor
'@dudousxd/nestjs-catalog-pipeline': minor
---

Ship the pipeline and publish controllers

The engine moved into this package but its HTTP surface did not, so the 19 routes under
`<path>/pipeline` and `<path>/publish` stayed hand-written in every host — the same duplication the
engine had, one level up.

They are factories, matching `createCatalogController`: the route prefix and the guards come from
`forRoot`, because a library that hardcodes the auth for routes which can rewrite a catalog's schema
is deciding something only the host can. Omit `path` and no controllers are mounted at all, which is
what a worker-only host wants.

`@dudousxd/nestjs-catalog` now owns the vocabulary those routes declare with — `RequireScopes`,
`RequireHuman`, and the two metadata keys behind them. It already owned `CatalogScope`,
`CatalogPrincipal` and `hasScope`, and the alternative is every package that ships routes inventing
its own key, which would force a host to write one guard per package instead of one guard for the
catalog. Declaring stays separate from enforcing: the library says what a route needs, the host's
guard decides who the caller is.
