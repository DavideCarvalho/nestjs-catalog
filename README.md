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
