import type { CatalogApplicationSummary, CatalogDirectory } from '@dudousxd/nestjs-catalog';
import { asc } from 'drizzle-orm';
import { type CatalogDrizzleRun, catalogDrizzleRunner } from './connection';
import { type CatalogDrizzleTables, catalogDrizzleTables } from './schema';
import type { CatalogDrizzleStoreOptions } from './workspace.store';

/**
 * The half of the directory the catalog owns: applications, read from the
 * `principal` table, each with the types it owns. The Drizzle twin of
 * `MikroOrmCatalogDirectory`.
 *
 * No `listPeople` or `upsertPerson`: this package defines no user table, and a
 * host has one of its own. Extend this class to add people from wherever they
 * live:
 *
 * ```ts
 * class MyDirectory extends DrizzleCatalogDirectory {
 *   async listPeople(query) { ... }
 * }
 * ```
 */
export class DrizzleCatalogDirectory implements CatalogDirectory {
  protected readonly run: CatalogDrizzleRun;
  protected readonly t: CatalogDrizzleTables;

  constructor(options: CatalogDrizzleStoreOptions) {
    this.run = catalogDrizzleRunner(options);
    this.t = catalogDrizzleTables(options);
  }

  listApplications(): Promise<CatalogApplicationSummary[]> {
    const principal = this.t.principal;
    const objectType = this.t.objectType;
    return this.run(async (db) => {
      const principals = await db.select().from(principal).orderBy(asc(principal.displayName));
      // Ownership lives on the type, so it is one query for all types rather
      // than one per principal.
      const types = await db
        .select({ name: objectType.name, owner: objectType.ownerPrincipalId })
        .from(objectType);
      const owned = new Map<string, string[]>();
      for (const type of types) {
        const list = owned.get(type.owner);
        if (list) list.push(type.name);
        else owned.set(type.owner, [type.name]);
      }
      return principals.map((row) => ({
        id: row.id,
        displayName: row.displayName,
        scopes: row.scopes,
        writeTypes: row.writeTypes,
        // Absent and null both mean every type; the wire says null.
        readTypes: row.readTypes ?? null,
        classifications: row.classifications,
        active: row.active,
        // Derived, never the credential: no key hash means the application
        // authenticates elsewhere and is only described here.
        authMethod: row.keyHash ? 'key' : 'token',
        lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
        ownedTypes: (owned.get(row.id) ?? []).sort(),
      }));
    });
  }
}
