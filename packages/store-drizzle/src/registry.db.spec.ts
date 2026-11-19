import { CATALOG_DIRECTORY, CatalogRegistry } from '@dudousxd/nestjs-catalog';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type SeedModel,
  type SeedType,
  describeRegistryContract,
} from '../../../test/registry-contract';
import { catalogDrizzleSql } from './ddl';
import { DrizzleCatalogDirectory } from './directory';
import { DrizzleCatalogRegistry } from './registry';
import { catalogDrizzleTables } from './schema';
import { CatalogDrizzleStoreModule } from './store.module';

/**
 * The Drizzle registry and directory on Postgres, through the contract the
 * MikroORM ones pass, run as an application role with only SELECT, INSERT,
 * UPDATE and DELETE.
 */
let container: StartedPostgreSqlContainer;
let appPool: Pool;

const PREFIX = 'reg_';
const tables = catalogDrizzleTables({ prefix: PREFIX });

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('catalog')
    .withUsername('postgres')
    .withPassword('postgres')
    .start();
  const admin = new Pool({ connectionString: container.getConnectionUri() });
  await admin.query(catalogDrizzleSql({ prefix: PREFIX }));
  await admin.query(`
    CREATE ROLE catalog_app LOGIN PASSWORD 'app' NOSUPERUSER NOCREATEDB NOCREATEROLE;
    GRANT USAGE ON SCHEMA public TO catalog_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO catalog_app;
  `);
  await admin.end();
  appPool = new Pool({
    connectionString: `postgres://catalog_app:app@${container.getHost()}:${container.getPort()}/catalog`,
  });
}, 300_000);

afterAll(async () => {
  await appPool?.end();
  await container?.stop();
});

type Tx = Parameters<Parameters<ReturnType<typeof drizzle>['transaction']>[0]>[0];

async function seedTypes(tx: Tx, types: SeedType[]): Promise<void> {
  const now = new Date();
  for (const type of types) {
    await tx.insert(tables.objectType).values({
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
      await tx.insert(tables.property).values({
        id: `${type.name}.${property.name}`,
        objectTypeName: type.name,
        ...property,
        updatedAt: now,
      });
    }
  }
}

async function seedRest(tx: Tx, model: SeedModel): Promise<void> {
  for (const snapshot of model.snapshots ?? []) {
    await tx.insert(tables.snapshot).values({
      ...snapshot,
      createdAt: new Date(snapshot.createdAt),
      committedAt: snapshot.committedAt ? new Date(snapshot.committedAt) : null,
    });
  }
  for (const principal of model.principals ?? []) {
    await tx.insert(tables.principal).values({
      ...principal,
      createdAt: new Date(),
      lastSeenAt: principal.lastSeenAt ? new Date(principal.lastSeenAt) : null,
    });
  }
}

describe('the Drizzle registry and directory', () => {
  describeRegistryContract(() => {
    const db = drizzle(appPool);
    return {
      name: 'drizzle (postgres)',
      registry: ({ staleAfterMs }) =>
        new DrizzleCatalogRegistry({ db, prefix: PREFIX, staleAfterMs }),
      directory: new DrizzleCatalogDirectory({ db, prefix: PREFIX }),
      seed: (model) =>
        db.transaction(async (tx) => {
          await seedTypes(tx, model.types ?? []);
          await seedRest(tx, model);
        }),
      rename: async (typeName, displayName) => {
        await db
          .update(tables.objectType)
          .set({ displayName, updatedAt: sql`NOW()` })
          .where(eq(tables.objectType.name, typeName));
      },
    };
  });

  it('is the module’s CatalogRegistry, loaded when the module starts', async () => {
    const db = drizzle(appPool);
    const name = `module_${Date.now()}`;
    const now = new Date();
    await db.insert(tables.objectType).values({
      name,
      ownerPrincipalId: 'p',
      displayName: 'Module type',
      pluralDisplayName: 'Module types',
      primaryKey: [],
      physicalTable: `obj_${name}`,
      createdAt: now,
      updatedAt: now,
    });
    const moduleRef = await Test.createTestingModule({
      imports: [
        CatalogDrizzleStoreModule.forRoot({ db, prefix: PREFIX, audit: false, staleAfterMs: 0 }),
      ],
    }).compile();
    await moduleRef.init();
    try {
      const registry = moduleRef.get(CatalogRegistry);
      expect(registry).toBeInstanceOf(DrizzleCatalogRegistry);
      expect(registry.getType(name)?.displayName).toBe('Module type');
      expect(moduleRef.get(CATALOG_DIRECTORY)).toBeInstanceOf(DrizzleCatalogDirectory);
    } finally {
      await moduleRef.close();
    }
  });

  it('deletes a type’s properties with it', async () => {
    const db = drizzle(appPool);
    const name = `cascade_${Date.now()}`;
    const now = new Date();
    await db.insert(tables.objectType).values({
      name,
      ownerPrincipalId: 'p',
      displayName: 'C',
      pluralDisplayName: 'Cs',
      primaryKey: [],
      physicalTable: `obj_${name}`,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(tables.property).values({
      id: `${name}.id`,
      objectTypeName: name,
      name: 'id',
      displayName: 'Id',
      type: 'string',
      sourceColumn: 'id',
      physicalColumn: 'id',
    });
    await db.delete(tables.objectType).where(eq(tables.objectType.name, name));
    const left = await db
      .select()
      .from(tables.property)
      .where(eq(tables.property.objectTypeName, name));
    expect(left).toHaveLength(0);
  });
});
