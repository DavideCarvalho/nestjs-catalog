---
"@dudousxd/nestjs-catalog": minor
---

`@mikro-orm/core` is now an optional peer. The package used to load it on import, because the MikroORM registry and read store imported it at the top of their files, so a Drizzle or Prisma host crashed before it could bind its own `registry` and `store`. Both now load MikroORM only when Nest builds them. A host that passes its own `registry` and `store` never loads it, and one that relies on the defaults without MikroORM installed gets an error naming the two options. Nothing changes for MikroORM hosts.
