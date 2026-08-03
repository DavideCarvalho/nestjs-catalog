# @dudousxd/nestjs-catalog-pipeline

## 0.2.0

### Minor Changes

- 6f739d9: Ship the pipeline and publish controllers

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

## 0.1.1

### Patch Changes

- af85ebe: Export `SubprocessTransformRunner`

  A host that declares its own pipeline controllers needs it, and Nest resolves a controller's
  dependencies from the module that declares the controller — so without the export the host fails at
  boot with `Nest can't resolve dependencies of the PipelineController ... SubprocessTransformRunner at
index [1] is available in the ... module`.

  Exported rather than left to the host to provide, because this module owns the configured instance:
  it is the one built with `pythonVenv`. A host supplying a second one would be running transforms
  through a runner configured somewhere else, which is the kind of difference that only shows up when a
  transform cannot find its interpreter.

## 0.1.0

### Minor Changes

- d00c67d: The connector pipeline, as a package

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
