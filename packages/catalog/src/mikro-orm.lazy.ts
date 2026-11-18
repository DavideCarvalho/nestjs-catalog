import { forwardRef } from '@nestjs/common';

/**
 * `@mikro-orm/core`, loaded on first use rather than at import.
 *
 * MikroORM is an optional peer. The two MikroORM defaults (the derived
 * registry and the read store) are what need it, and a host that binds its own
 * `registry` and `store` never instantiates either. Importing the package at
 * the top of their files would still load it the moment anything imported
 * `@dudousxd/nestjs-catalog`, because the module and the index both reference
 * those classes, and a Drizzle or Prisma host would crash at boot on a package
 * it never uses.
 */
export function loadMikroOrmCore(): typeof import('@mikro-orm/core') {
  try {
    return require('@mikro-orm/core');
  } catch (error) {
    throw new Error(
      '@dudousxd/nestjs-catalog: the default registry and store read your MikroORM ' +
        'entities, so they need @mikro-orm/core installed. Install it, or pass your own ' +
        '`registry` and `store` to CatalogModule.forRoot().',
      { cause: error },
    );
  }
}

/**
 * Injection tokens for the MikroORM classes, resolved only when Nest builds a
 * provider that asks for them.
 *
 * `forwardRef` is what defers it: Nest unwraps the callback while resolving the
 * constructor, not when the decorator runs. The parameter types are imported
 * with `import type`, so the emitted `design:paramtypes` say `Object` and load
 * nothing; the explicit `@Inject` is what names the real token.
 */
export const MIKRO_ORM = forwardRef(() => loadMikroOrmCore().MikroORM);
export const MIKRO_ORM_ENTITY_MANAGER = forwardRef(() => loadMikroOrmCore().EntityManager);
