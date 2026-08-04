# @dudousxd/nestjs-catalog-store-mikro-orm

## 0.2.1

### Patch Changes

- f8a10d6: Fork the EntityManager, so `/access/principals` is not a 500

  `MikroOrmCatalogDirectory` read through the injected EntityManager, which is the
  **global** one. MikroORM refuses context-specific calls on it — `Using global
EntityManager instance methods for context specific actions is disallowed` — and
  a read from a request handler is exactly that, so every call to the endpoint
  answered 500.

  Nothing caught it: it compiles, the module boots, the route mounts, and the
  guard in front of it answers 401 to an unauthenticated probe — which looks
  identical to a working endpoint. A unit test with a stubbed EntityManager would
  also have passed, because a stub has no request context to be outside of. It is
  now covered by a `*.db.spec.ts` against a real MySQL, where reverting the fix
  fails four cases with that exact message.

## 0.2.0

### Minor Changes

- 5d10b69: Serve the Access screen, through a directory the host can own — and page it.

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

## 0.1.1

### Patch Changes

- 21b2d71: Ship a README

  The package published with none, so its npm page was blank — for the one adapter whose
  misconfiguration is silent. `contextName` is the option worth reading before installing: omit it and
  the store resolves the _default_ EntityManager, creating the catalog's tables and loading every
  snapshot into the host application's schema, with no error raised, because writing to the wrong
  database is not a type error and the rows land successfully.

  Also documents keeping a host's migration differ away from the library's tables
  (`catalogManagedTables()`, `MARKER_TABLE`, and why `obj_*` is deliberately absent from both).
