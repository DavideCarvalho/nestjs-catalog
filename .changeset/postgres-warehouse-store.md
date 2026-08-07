---
'@dudousxd/nestjs-catalog-store-mikro-orm': minor
'@dudousxd/nestjs-catalog': minor
---

A PostgreSQL warehouse store, behind the same interfaces and the same test suite as the MySQL one.

The store package shipped four classes named `MySql*` and only one of them had earned the name. The pipeline, workspace and trace stores reach their tables through MikroORM's entity API, which is dialect-agnostic; the one thing binding them to MySQL was a type-only import of `EntityManager` from `@mikro-orm/mysql`, which re-exports `@mikro-orm/sql`'s `SqlEntityManager` — the same class `@mikro-orm/postgresql` re-exports.

The warehouse store writes SQL by hand, so it gets a seam: `CatalogSqlDialect`, with `MYSQL_DIALECT` and `POSTGRES_DIALECT` as values rather than subclasses. `MySqlWarehouseStore` and the new `PostgresWarehouseStore` are one implementation with different dialects bound, and both run `test/catalog-store-contract.ts` — the suite the ClickHouse adapter already runs — against a real engine in testcontainers.

**Nothing about the MySQL behaviour changes.** The statements it emits are byte-identical and its specs pass untouched.

**New:** `CatalogMikroOrmStoreModule.forRoot({ dialect: 'postgres' })`. A Postgres host that sets no `contextName` also needs `entityManagerToken`/`mikroOrmToken`, because `@mikro-orm/postgresql` registers its own `EntityManager` subclass; passing a `contextName` avoids the question and is the better answer anyway. `pg` is never a dependency of this package — it arrives through the host's own install, as `mysql2` always has.

**Two differences a Postgres deployment has to know about**, because closing either would mean the package lying about its engine:

- Column names are case-sensitive. `assetId` and `AssetID` are two columns on Postgres and one on MySQL, so a model Postgres accepts can be refused by MySQL.
- Search stays case-insensitive: the dialect uses `ILIKE`, because MySQL's default collation is case-insensitive and leaving `LIKE` would have made a Postgres catalog's search box quietly return fewer rows.

The environment model is unchanged — one database per environment, not one schema, on both engines. `catalog.environment.ts` now argues why, and its reserved-id list refuses both engines' system databases on both engines so the answer cannot change under a migration.
