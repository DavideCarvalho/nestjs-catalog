# @dudousxd/nestjs-catalog-dashboard

## 0.1.0

### Minor Changes

- 3098014: The catalog console

  Every other Aviary library ships one — `nestjs-durable-dashboard`, `nestjs-agent-dashboard`,
  `nestjs-media-dashboard`, `nestjs-telescope-ui` — and the catalog did not, which is why its API had
  no user interface anywhere. The screens already existed in `@dudousxd/nestjs-catalog-react`; what was
  missing was the package that mounts them, serves their assets and guards the way in.

  Nine tabs: Model, Objects, Query, Dashboards, Connectors, Workflows, Lineage, Activity, Access.

  It does **not** proxy the API. The catalog's HTTP surface is already mounted by `CatalogModule` and
  `CatalogPipelineModule`; a second copy behind this console would be a second set of routes to keep
  authorised. `apiPath` only tells the SPA where to call.

  Auth is opt-in, and the console is open without it. That is stated in the option rather than left as
  a default to drift into, because this console can rewrite a catalog's model and run its connectors.

  `catalogDashboardMountPaths()` is the piece a host cannot infer: without it, a host calling
  `setGlobalPrefix('api')` moves the console to `/api/catalog` while the SPA still asks for
  `/catalog/assets/…`, and it loads as a blank page with 404s — which reads as a broken build rather
  than a routing mistake.
