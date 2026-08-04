import type { StartedMySqlContainer } from '@testcontainers/mysql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CatalogDatabase, openCatalogDatabase, startMySql } from '../test/mysql-harness';
import { MikroOrmCatalogDirectory } from './directory.service';
import { PrincipalRow } from './entities/governance';

/**
 * The shipped directory, against a real MySQL.
 *
 * Against an engine rather than a stub, and the reason is the bug this suite
 * exists because of: the first version called `this.em.find(...)` on the
 * INJECTED EntityManager, which is the global one, and MikroORM refuses
 * context-specific calls on it — `Using global EntityManager instance methods
 * for context specific actions is disallowed`. Every request to
 * `/access/principals` was a 500.
 *
 * Nothing caught it. It compiles, the module boots, and a unit test handing in a
 * stubbed EntityManager would have passed happily, because a stub has no notion
 * of a request context to be outside of. Only a real ORM raises it, so that is
 * what this uses.
 */

let container: StartedMySqlContainer;
let db: CatalogDatabase;

beforeAll(async () => {
  container = await startMySql();
  db = await openCatalogDatabase(container, 'directory');
}, 300_000);

afterAll(async () => {
  await db?.close();
  await container?.stop();
});

async function seed(rows: Array<Partial<PrincipalRow> & { id: string }>): Promise<void> {
  const em = db.em.fork();
  await em.nativeDelete(PrincipalRow, {});
  for (const row of rows) {
    const principal = new PrincipalRow();
    Object.assign(principal, {
      displayName: row.id,
      scopes: [],
      writeTypes: [],
      classifications: [],
      active: true,
      createdAt: new Date(),
      ...row,
    });
    em.persist(principal);
  }
  await em.flush();
}

describe('MikroOrmCatalogDirectory', () => {
  it('reads principals off the global EntityManager without being refused', async () => {
    // THE regression. `db.em` is the same global instance the Nest module
    // injects, so constructing the directory with it reproduces production
    // exactly — a directory that forgot to fork throws here rather than
    // returning a wrong answer.
    await seed([{ id: 'publisher', displayName: 'Publisher', scopes: ['catalog:write'] }]);

    const directory = new MikroOrmCatalogDirectory(db.em);
    const applications = await directory.listApplications();

    expect(applications).toHaveLength(1);
    expect(applications[0]).toMatchObject({ id: 'publisher', displayName: 'Publisher' });
  });

  it('derives authMethod from the presence of a key, never the key', async () => {
    await seed([{ id: 'keyed', keyHash: 'a'.repeat(64) }, { id: 'tokened' }]);

    const byId = new Map(
      (await new MikroOrmCatalogDirectory(db.em).listApplications()).map((a) => [a.id, a]),
    );

    expect(byId.get('keyed')?.authMethod).toBe('key');
    expect(byId.get('tokened')?.authMethod).toBe('token');
    // The digest is not a credential, but it is not a thing to hand a browser
    // either — and the summary type has no field that could carry it, so this
    // asserts the serialised shape rather than a property name.
    expect(JSON.stringify([...byId.values()])).not.toContain('a'.repeat(64));
  });

  it('reports an absent readTypes as null, meaning every type', async () => {
    // `undefined` on the row and `null` on the wire are the same statement, and
    // JSON has no `undefined` to round-trip. A summary that dropped the key
    // entirely would read to a client as "no types" — the opposite.
    await seed([{ id: 'reader' }]);

    const [application] = await new MikroOrmCatalogDirectory(db.em).listApplications();

    expect(application.readTypes).toBeNull();
    expect('readTypes' in application).toBe(true);
  });

  it('attributes owned types to the principal that owns them', async () => {
    await seed([{ id: 'owner' }, { id: 'bystander' }]);
    await db.publish({
      name: 'Widget',
      displayName: 'Widget',
      pluralDisplayName: 'Widgets',
      group: 'default',
      tableName: 'widget',
      enriched: false,
      primaryKey: ['id'],
      properties: [
        {
          name: 'id',
          displayName: 'Id',
          type: 'string',
          columnName: 'id',
          nullable: false,
          primary: true,
          hidden: false,
          order: 0,
          enriched: false,
        },
      ],
      relations: [],
    });
    await db.execute("UPDATE catalog_object_type SET owner_principal_id = 'owner'");

    const byId = new Map(
      (await new MikroOrmCatalogDirectory(db.em).listApplications()).map((a) => [a.id, a]),
    );

    // Ownership is what actually decides a re-publish, so a screen showing only
    // the grant can show an application that appears able to load a type it
    // will then be refused on.
    expect(byId.get('owner')?.ownedTypes).toEqual(['Widget']);
    expect(byId.get('bystander')?.ownedTypes).toEqual([]);
  });

  it('has no people, and says so by not implementing the method', async () => {
    // Not an oversight and worth pinning: the controller branches on the
    // METHOD being absent to answer 501, so an implementation that grew an
    // empty `listPeople` would turn "people live in your IdP" into "nobody can
    // sign in", which is the misreading the 501 exists to prevent.
    expect(new MikroOrmCatalogDirectory(db.em).listPeople).toBeUndefined();
    expect(new MikroOrmCatalogDirectory(db.em).upsertPerson).toBeUndefined();
  });
});
