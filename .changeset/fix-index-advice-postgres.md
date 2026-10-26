---
"@dudousxd/nestjs-catalog-store-mikro-orm": patch
---

When an object-table index cannot be added, the warning's advice now matches the engine. MySQL is
still told to run the `ADD INDEX` it tried, which is online. Postgres is given the
`CREATE INDEX CONCURRENTLY` form instead of being told the plain `CREATE INDEX` does not block
writes, which it does.
