---
"@dudousxd/nestjs-catalog": minor
"@dudousxd/nestjs-catalog-store-mikro-orm": minor
"@dudousxd/nestjs-catalog-react": minor
---

Serve the Access screen, through a directory the host can own — and page it.

`GET /access/principals`, `GET /access/people` and `POST /access/people` had no
server implementation at all. The React screens called endpoints nothing
answered, so the whole screen read as a broken build.

They are now served from `CATALOG_DIRECTORY`, split along who actually owns the
answer. Applications come from `catalog_principal` and are shipped:
`CatalogMikroOrmStoreModule` binds `MikroOrmCatalogDirectory` and hosts get that
half for free. People are the host's — `listPeople` and `upsertPerson` are
optional, and a directory implementing neither is a complete implementation
rather than a half-finished one, because a catalog embedded in an application is
embedded in one that already has a user store. Standing up a second one beside
it is how you get two lists of employees that disagree about who was offboarded.

An unimplemented half answers **501 naming the seam** instead of returning an
empty list, so an operator can tell "not wired" from "nobody is there".

**`listPeople` is paged, and the bound is not advisory.** The host's user table
is its whole directory, so `GET /access/people` takes `search`/`limit`/`offset`,
caps the limit at 500 whatever is asked for, and hands the query DOWN to the
directory so it reaches the database rather than slicing a list that was already
materialised. The response is a page carrying `total`, and the screen renders
"Showing 1–50 of 1,340" plus a search box — a bounded list that cannot report
what it is bounding is indistinguishable from a complete one, and an operator
reading it as complete concludes somebody has no access when they were merely on
the next page.

Bind your own directory with the new `directory` option on
`CatalogModule.forRoot` — via the option rather than only exporting the token
from an imported module, since a provider declared inside the module shadows one
exported by its imports. Routes mount at the new `accessPath`, a sibling of
`path` by default.
