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
