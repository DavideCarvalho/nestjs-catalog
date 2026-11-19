# @dudousxd/nestjs-catalog-dashboard

The console for [`@dudousxd/nestjs-catalog`](https://www.npmjs.com/package/@dudousxd/nestjs-catalog):
Model, Objects, Query, Dashboards, Connectors, Workflows, Lineage, Activity, Access.

The screens come from [`@dudousxd/nestjs-catalog-react`](https://www.npmjs.com/package/@dudousxd/nestjs-catalog-react).
This package is the part a component library cannot do for itself: mounting them, serving their
assets, and guarding the way in.

```bash
pnpm add @dudousxd/nestjs-catalog-dashboard
```

## Mount it

```ts
import { CatalogDashboardModule } from '@dudousxd/nestjs-catalog-dashboard';

CatalogDashboardModule.forRoot({
  path: '/catalog',                 // where the console is served
  apiPath: '/api/catalog-service',  // where its API already lives
  auth: { secret, session, revalidate },
});
```

`forRootAsync` is the same mount with the auth built from DI, for when validating a session means
asking a user store or a session service.

**It does not proxy the API.** `apiPath` only tells the SPA where to call — the catalog's HTTP
surface is mounted by `CatalogModule` and `CatalogPipelineModule`, and a second copy behind this
console would be a second set of routes to keep authorised.

## Two things a host must get right

**Exclude the console from a global API prefix.** A host calling `setGlobalPrefix('api')` otherwise
moves it to `/api/catalog` while the SPA still asks for `/catalog/assets/…`, and it loads as a blank
page with 404s — which reads as a broken build rather than a routing mistake.

```ts
setGlobalPrefix('api', {
  exclude: [...catalogDashboardMountPaths({ path: '/catalog' })],
});
```

The helper derives its paths from the same defaulting `forRoot` mounts with, so the two cannot drift.

**Decide whether it is open.** Omit `auth` and the console is open — and it can rewrite a catalog's
model and run its connectors. A host that would rather be shut than open passes a denying `guards`
entry, which needs no secret, no DI and no session:

```ts
guards: process.env.CONSOLE_SECRET ? [] : [DenyEverythingGuard],
```

`auth` and `guards` are separate for exactly this: `auth` describes how a session is *validated*, so
a host that has not configured it yet has an open console. `guards` is what makes "unconfigured" mean
shut.

## Opening it from your own UI

Minting the session is this library's business, so it ships the call rather than documenting an
endpoint. Three levels:

```ts
import { openCatalogConsole } from '@dudousxd/nestjs-catalog-dashboard/client';
import {
  useOpenCatalogConsole,
  OpenCatalogConsoleButton,
} from '@dudousxd/nestjs-catalog-dashboard/react';
```

- `openCatalogConsole(...)` — no React, you own everything
- `useOpenCatalogConsole(...)` — state for a launcher, you own the markup
- `<OpenCatalogConsoleButton />` — drop-in, unstyled

`openCatalogConsoleMutationOptions` wires the same call into TanStack Query without this package
depending on TanStack. React is an optional peer: a host that only mounts the NestJS module never
pulls it in.

When the host authenticates, the SPA skips its own sign-in entirely — a console embedded in an
application that already knows who you are has no business asking again.

## Showing part of the console

Three options shape what the SPA shows and asks for. Each defaults to today's behaviour.

```ts
CatalogDashboardModule.forRoot({
  path: '/admin/ontology',
  apiPath: '/api/catalog',
  screens: ['model', 'objects'], // only these tabs; the rest get no tab, no panel, no requests
  pipeline: false,               // Model leaves out Loaded by and Load expectation
  hostAuthenticates: true,       // no sign-in, and no call to /auth/me
});
```

- `screens` lists the screens to show: `model`, `objects`, `query`, `dashboards`, `workflows`,
  `connections`, `lineage`, `activity`, `access` and `search` (the `⌘K` screen, which has no tab).
  Default: all of them. An address naming a hidden screen lands on the first one shown. An unknown
  name, or a list with no screen other than `search`, fails at module definition.
- `pipeline: false` is for a host that does not mount the pipeline endpoints. The Model screen then
  renders neither section and never requests `/pipeline/workflows` or `/pipeline/expectations/:type`.
- `hostAuthenticates: true` is for a host that authenticates every request itself and serves no
  `/auth/me`. Configuring `auth` already hides the sign-in, but keeps asking `/auth/me` for the
  Access screen.

Whatever the options, a host that serves no `/environments` (a 404) is read as one environment, and
the environment picker is left out instead of failing.

## How the console is served

The page loads nothing from another origin and runs no inline script, so it works under a strict
Content-Security-Policy (`script-src 'self'`) and in an air-gapped deployment. The values it needs
(asset base, API base, the options above) come from `<path>/config.js`, a small script the module
serves and `index.html` loads first in its head. The fonts are named in the stylesheet and fall back
to the system's; nothing is fetched from Google Fonts.

`index.html` is rendered once (asset URLs rewritten to `path`, the `config.js` tag added) and kept in
memory. Each request checks the file's mtime and size, and renders it again when they change, so a
rebuilt bundle is picked up without a restart. It is always sent `Cache-Control: no-store`. Files
under `assets/` are streamed from disk with a `Content-Length`; a path that is not a file is a 404.
