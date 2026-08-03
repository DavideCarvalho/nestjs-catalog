# nestjs-catalog

A catalog / semantic-layer for NestJS, in the [Aviary](https://davidecarvalho.github.io/aviary/)
family of plug-n-play libraries under the `@dudousxd` scope.

| Package | What it is |
|---|---|
| [`@dudousxd/nestjs-catalog`](./packages/catalog) | The core: object types, properties, snapshots, the query surface, connectors, transforms and workflow graphs. |
| [`@dudousxd/nestjs-catalog-react`](./packages/react) | The React console: explorer, query console, dashboards, pipeline and workflow editors. |
| [`@dudousxd/nestjs-catalog-store-mikro-orm`](./packages/store-mikro-orm) | MikroORM store: boot-managed schema, the registry read from the catalog's own tables, and a MySQL warehouse store over `obj_*` snapshot tables. |
| [`@dudousxd/nestjs-catalog-store-clickhouse`](./packages/store-clickhouse) | ClickHouse store. |
| [`@dudousxd/nestjs-catalog-store-fanout`](./packages/store-fanout) | Fan-out store, for writing one snapshot into several backends. |
| [`@dudousxd/nestjs-catalog-telescope`](./packages/telescope) | Telescope watcher for catalog events. |

## Development

```bash
pnpm install
pnpm build        # turbo, respects the dependency graph
pnpm lint         # biome
```

Releases go through [changesets](https://github.com/changesets/changesets): add one with
`pnpm changeset`, and merging to `main` opens a "Version Packages" PR whose merge publishes to npm.

### Publishing: trusted publishing (OIDC), not a token

This repo has **no `NPM_TOKEN` secret**. `.github/workflows/release.yml` requests
`id-token: write` and npm mints a short-lived credential for the job, which means there is no
long-lived token to leak or rotate. Two things make it work, and both are easy to undo by accident:

- **Each package names this repo and `release.yml` as its trusted publisher**, configured per
  package on npmjs.com (Settings -> Trusted Publisher). A package without it fails the publish with
  `E404 - PUT https://registry.npmjs.org/<pkg>`: npm answers 404 rather than 403 for an
  unauthorized package, so the error reads as "no such package" rather than "not authenticated".
- **npm must be >= 11.5.1**, which is where OIDC landed. `.nvmrc` pins Node 22, which ships npm
  10.9.x, so the workflow upgrades npm explicitly before publishing.

The workflow also passes **no `NODE_AUTH_TOKEN`**, deliberately. `setup-node` writes
`//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}` into `~/.npmrc`, so wiring an unset secret
there leaves an *empty* credential that npm sends instead of falling through to the OIDC exchange.
Absent and empty are not the same thing here.

A brand-new package cannot be created this way: trusted publishing is configured on a package that
already exists, so the first version of anything new has to be published with a token or from a
maintainer's machine.
