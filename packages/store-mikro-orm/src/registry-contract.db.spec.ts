import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe } from 'vitest';
import {
  type SeedModel,
  type SeedType,
  describeRegistryContract,
} from '../../../test/registry-contract';
import {
  type PostgresCatalogDatabase,
  openPostgresCatalogDatabase,
  startPostgres,
} from '../test/postgres-harness';
import { MikroOrmCatalogDirectory } from './directory.service';
import { PrincipalRow, SnapshotRow } from './entities/governance';
import { ObjectTypeRow, PropertyRow } from './entities/model';
import { StoredCatalogRegistry } from './stored-registry.service';

/**
 * The shared registry and directory contract on the MikroORM store, on
 * Postgres: the same cases `@dudousxd/nestjs-catalog-store-drizzle` passes.
 */
let container: StartedPostgreSqlContainer;
let db: PostgresCatalogDatabase;

beforeAll(async () => {
  container = await startPostgres();
  db = await openPostgresCatalogDatabase(container, 'registry_contract');
}, 300_000);

afterAll(async () => {
  await db?.close();
  await container?.stop();
});

type Em = PostgresCatalogDatabase['em'];

function seedTypes(em: Em, types: SeedType[]): void {
  const now = new Date();
  for (const type of types) {
    const row = em.create(ObjectTypeRow, {
      name: type.name,
      ownerPrincipalId: type.ownerPrincipalId,
      displayName: type.displayName,
      pluralDisplayName: type.pluralDisplayName,
      description: type.description,
      group: type.group,
      titleProperty: type.titleProperty,
      primaryKey: type.primaryKey,
      physicalTable: type.physicalTable,
      relations: type.relations ?? [],
      createdAt: now,
      updatedAt: now,
    });
    for (const property of type.properties) {
      em.create(PropertyRow, {
        id: `${type.name}.${property.name}`,
        objectType: row,
        name: property.name,
        displayName: property.displayName,
        description: property.description,
        type: property.type,
        sourceColumn: property.sourceColumn,
        physicalColumn: property.physicalColumn,
        nullable: property.nullable ?? true,
        primary: property.primary ?? false,
        hidden: property.hidden ?? false,
        position: property.position,
        classification: property.classification,
        unit: property.unit,
      });
    }
  }
}

function seedRest(em: Em, model: SeedModel): void {
  for (const snapshot of model.snapshots ?? []) {
    em.create(SnapshotRow, {
      ...snapshot,
      createdAt: new Date(snapshot.createdAt),
      committedAt: snapshot.committedAt ? new Date(snapshot.committedAt) : undefined,
    });
  }
  for (const principal of model.principals ?? []) {
    em.create(PrincipalRow, {
      ...principal,
      createdAt: new Date(),
      lastSeenAt: principal.lastSeenAt ? new Date(principal.lastSeenAt) : undefined,
    });
  }
}

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

describe('the MikroORM registry and directory', () => {
  describeRegistryContract(() => ({
    name: 'mikro-orm (postgres)',
    registry: ({ staleAfterMs }) =>
      new StoredCatalogRegistry(db.em, db.orm, { autoSchema: false, staleAfterMs }),
    directory: new MikroOrmCatalogDirectory(db.em),
    seed: async (model) => {
      const em = db.em.fork();
      seedTypes(em, model.types ?? []);
      seedRest(em, model);
      await em.flush();
    },
    rename: async (typeName, displayName) => {
      await db.execute(
        `UPDATE catalog_object_type SET display_name = ${quote(displayName)}, updated_at = NOW()
          WHERE name = ${quote(typeName)}`,
      );
    },
  }));
});
