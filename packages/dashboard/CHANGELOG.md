# @dudousxd/nestjs-catalog-dashboard

## 0.2.4

### Patch Changes

- d19b182: Don't ask for a password the host already checked

  Mounted inside an application, the console showed its own sign-in form and then failed with
  `Cannot GET /api/auth/me`. Two faults behind one symptom.

  The SPA hardcoded `/api` as the API base, ignoring the `apiPath` the mount configures — so every call
  went to the host's own API root instead of the catalog's. And it always rendered its local-password
  gate, which only exists for the standalone deployment; a console embedded in an app that just
  authenticated you has no business asking again, and the credential it wants does not exist.

  The server now tells the SPA both things: where the API is, and whether the host authenticates. When
  it does, the gate is skipped and the host's session cookie carries the request. The injected globals
  are also renamed off `__DURABLE_*`, which they had been carrying since this package was templated
  from the durable console.

## 0.2.3

### Patch Changes

- 4cb250a: `catalogDashboardMountPaths` returns the shape `exclude` actually matches

  Plain strings with a `{*splat}` wildcard, like every other Aviary console helper. The object form it
  returned before is accepted by `setGlobalPrefix`'s type but does not match, and the symptom is a
  quiet one: the console mounts, logs itself as initialised, and answers on `/api/<path>` while 404ing
  at `/<path>`.

## 0.2.2

### Patch Changes

- d05d7f0: Actually mount the console at its configured path

  The controllers carry no path of their own — that is what makes `path` configurable, since a
  decorator argument is fixed at class-definition time — but nothing was supplying the prefix, so they
  inherited the host's global one and answered on `/api`. The console 404'd at its configured path
  while the module reported itself initialised, which is a confusing pair of symptoms to hold at once.

  `RouterModule.register` binds the module to `path`, the way the other Aviary consoles do it.

## 0.2.1

### Patch Changes

- 481b594: `useDashboardAuth` may return `undefined`

  A host whose signing secret is unset has no way to mint a session, and the honest answer is "no auth
  mechanism" — paired with a denying `guards` entry, which is what turns that into a CLOSED console
  rather than an open one. The type forced a return, which would have pushed hosts to invent an auth
  object around an absent secret: a cookie signed with nothing.

  Found while mounting it, which is the only place a signature like this gets tested.

## 0.2.0

### Minor Changes

- 70ec7f0: `guards` and `forRootAsync`, so a host can shut the console

  `auth` alone was not enough to mount this the way the other Aviary consoles are mounted. It describes
  how a session is _validated_, which means a host that has not configured it yet has an **open**
  console — and this one can rewrite a catalog's model and run its connectors.

  `guards` is the answer to that, and it is deliberately separate: a denying guard needs no secret, no
  DI and no session, so a host with nothing configured can still be shut rather than open. It is bound
  at module-definition time, which is also why it cannot come from the async form.

  `forRootAsync` covers the other half: validating a session usually means asking something the host
  owns — a user store, a session service — and `forRoot` cannot reach DI.

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
