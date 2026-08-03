/**
 * Which MikroORM connection this store reads and writes.
 *
 * Kept in its own file for the same reason as `options.ts`: the module needs
 * these providers and every service needs the tokens, so declaring them beside
 * the module would make the module and its own services import each other.
 */

import { MikroORM } from '@mikro-orm/core';
// Value imports, not type-only. These two classes are the *injection tokens*
// `@mikro-orm/nestjs` registers for the default connection, so they have to
// survive into the emitted JavaScript.
import { EntityManager } from '@mikro-orm/mysql';
import type { Provider } from '@nestjs/common';

/**
 * The EntityManager every service in this package injects.
 *
 * Indirect on purpose. Injecting `EntityManager` positionally resolves to
 * whichever connection `@mikro-orm/nestjs` registered as the default, which is
 * correct in a single-connection app and silently wrong in a host that has its
 * own database and mounts this catalog beside it: the store would create and
 * fill the catalog's tables inside the host's schema, and nothing would report
 * an error because writing to the wrong database is not a type error.
 */
export const CATALOG_STORE_ENTITY_MANAGER = Symbol('CATALOG_STORE_ENTITY_MANAGER');

/**
 * The MikroORM instance whose schema this package manages at boot.
 *
 * Separate from the EntityManager because `ensureCatalogSchema` needs the ORM
 * itself — the schema generator and the discovered metadata hang off it — and
 * because getting *that* one wrong is the failure with the largest blast
 * radius available here: `schema.update()` against the host's ORM would reason
 * about the host's tables.
 */
export const CATALOG_STORE_MIKRO_ORM = Symbol('CATALOG_STORE_MIKRO_ORM');

/**
 * How `@mikro-orm/nestjs` names a named connection's providers.
 *
 * Reproduced rather than imported. `@mikro-orm/nestjs` exports these as
 * `getEntityManagerToken` / `getMikroORMToken`, but it is a pure-ESM package
 * and this one compiles to CommonJS, and it is not currently a dependency of
 * this package at all — taking one on, for two string templates, to gain a
 * hard ESM/CJS interop constraint, is the worse trade.
 *
 * Verified against `@mikro-orm/nestjs` 7.0.1
 * (`mikro-orm.common.js`: `` const getEntityManagerToken = name => `${name}_EntityManager` ``).
 * If a future release renames them, the failure is a Nest resolution error
 * naming this exact token at boot — loud, immediate, and impossible to mistake
 * for anything else.
 */
function nestEntityManagerToken(contextName: string): string {
  return `${contextName}_EntityManager`;
}

function nestMikroOrmToken(contextName: string): string {
  return `${contextName}_MikroORM`;
}

/**
 * Bind this package's two connection tokens to a real connection.
 *
 * With no `contextName` the aliases point at exactly the tokens the services
 * used to inject positionally — `EntityManager` from `@mikro-orm/mysql` (which
 * is `SqlEntityManager`, the driver-specific class `@mikro-orm/nestjs`
 * registers for the default connection) and core's `MikroORM`. So an
 * application that says nothing gets the behaviour it had before this option
 * existed, resolved through the same providers as before.
 *
 * With a `contextName` they point at the string tokens `@mikro-orm/nestjs`
 * publishes for that connection. Note that a named connection gets *only* those
 * string tokens: `MikroOrmCoreModule` skips creating the driver-specific
 * `SqlEntityManager` / `MySqlMikroORM` aliases whenever a context name is set,
 * which is precisely why positional injection cannot be made to work here and
 * an explicit token was needed.
 */
export function catalogConnectionProviders(contextName?: string): Provider[] {
  if (!contextName) {
    return [
      { provide: CATALOG_STORE_ENTITY_MANAGER, useExisting: EntityManager },
      { provide: CATALOG_STORE_MIKRO_ORM, useExisting: MikroORM },
    ];
  }

  return [
    {
      provide: CATALOG_STORE_ENTITY_MANAGER,
      useExisting: nestEntityManagerToken(contextName),
    },
    {
      provide: CATALOG_STORE_MIKRO_ORM,
      useExisting: nestMikroOrmToken(contextName),
    },
  ];
}
