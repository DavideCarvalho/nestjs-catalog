import type { CatalogApplicationSummary, CatalogDirectory } from '@dudousxd/nestjs-catalog';
import type { EntityManager } from '@mikro-orm/mysql';
import { Inject, Injectable } from '@nestjs/common';
import { CATALOG_STORE_ENTITY_MANAGER } from './context';
import { PrincipalRow } from './entities/governance';
import { ObjectTypeRow } from './entities/model';

/**
 * The half of the directory the catalog genuinely owns: applications, read from
 * `catalog_principal`.
 *
 * No `listPeople`, and that is the design rather than a gap. This package
 * defines no user table, and a host embedding the catalog already has one — see
 * the docblock on `CatalogDirectory`. Extend this class to add people from
 * wherever they actually live:
 *
 * ```ts
 * class MyDirectory extends MikroOrmCatalogDirectory {
 *   async listPeople() { return this.users.findAll().map(toPersonSummary); }
 * }
 * ```
 */
@Injectable()
export class MikroOrmCatalogDirectory implements CatalogDirectory {
  constructor(
    @Inject(CATALOG_STORE_ENTITY_MANAGER)
    protected readonly em: EntityManager,
  ) {}

  async listApplications(): Promise<CatalogApplicationSummary[]> {
    // Forked, and not optional: the injected EntityManager is the GLOBAL one,
    // and MikroORM refuses context-specific calls on it — `Using global
    // EntityManager instance methods for context specific actions is
    // disallowed`. A read from a request handler is exactly that, so without
    // this every call to these endpoints is a 500. Nothing catches it at build
    // time, and a unit test with a stubbed EntityManager will not either.
    const em = this.em.fork();
    const [principals, types] = await Promise.all([
      em.find(PrincipalRow, {}, { orderBy: { displayName: 'asc' } }),
      // Ownership lives on the type, not the principal, so it cannot be read
      // from `catalog_principal` alone. One query for all of them rather than
      // one per principal: this list is small, and the N+1 would be invisible
      // until a catalog had enough applications to make the screen slow.
      em.find(ObjectTypeRow, {}, { fields: ['name', 'ownerPrincipalId'] }),
    ]);

    const owned = new Map<string, string[]>();
    for (const type of types) {
      const list = owned.get(type.ownerPrincipalId);
      if (list) list.push(type.name);
      else owned.set(type.ownerPrincipalId, [type.name]);
    }

    return principals.map((principal) => ({
      id: principal.id,
      displayName: principal.displayName,
      scopes: principal.scopes,
      writeTypes: principal.writeTypes,
      // `undefined` on the row and `null` on the wire mean the same thing here
      // — every type — and the summary type says `null` because JSON has no
      // undefined to round-trip.
      readTypes: principal.readTypes ?? null,
      classifications: principal.classifications,
      active: principal.active,
      // Derived, never the credential. A row with no `keyHash` is an
      // application that authenticates against the IdP and is only described
      // here; see the entity's docblock.
      authMethod: principal.keyHash ? 'key' : 'token',
      lastSeenAt: principal.lastSeenAt?.toISOString() ?? null,
      ownedTypes: (owned.get(principal.id) ?? []).sort(),
    }));
  }
}
