import type { CanActivate, DynamicModule, INestApplication, Type } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CATALOG_DIRECTORY,
  CATALOG_DIRECTORY_MAX_PAGE,
  CATALOG_DIRECTORY_PAGE,
  type CatalogApplicationSummary,
  type CatalogDirectory,
  type CatalogDirectoryQuery,
  type CatalogPeoplePage,
  type CatalogPersonInput,
  type CatalogPersonSummary,
  type CatalogPersonUpsertResult,
} from './catalog.access';
import { CatalogModule } from './catalog.module';
import { InMemoryCatalogOverlayStore } from './catalog.overlay-store';
import { CatalogRegistry } from './catalog.registry.base';
import { CATALOG_STORE, type CatalogReadResult, type CatalogReadStore } from './catalog.store';
import type { CatalogGraph, CatalogObjectTypeDef, CatalogSnapshot } from './catalog.types';

/**
 * The Access surface is a seam with an absent implementation as its NORMAL
 * state, which makes "nothing is wired" the case most worth pinning: a host
 * that embeds the catalog gets applications for free and people only if it
 * supplies them, and the difference between "no directory" and "no such route"
 * is the difference between a console that tells an operator what to wire and
 * one that looks broken.
 *
 * Over HTTP rather than against the class, because every claim here — where it
 * mounts, what status an unimplemented half returns, whether the guards took —
 * is one that compiles perfectly while being wrong.
 */

const APPLICATION: CatalogApplicationSummary = {
  id: 'flip-nestjs',
  displayName: 'FLIP',
  scopes: ['catalog:read', 'catalog:write'],
  writeTypes: ['Vehicle'],
  readTypes: null,
  classifications: [],
  active: true,
  authMethod: 'token',
  lastSeenAt: null,
  ownedTypes: ['Vehicle'],
};

const PERSON: CatalogPersonSummary = {
  email: 'ana@example.com',
  displayName: 'Ana',
  role: 'curator',
  active: true,
  principalId: 'catalog-console#ana@example.com',
  hasPassword: false,
  createdAt: new Date(0).toISOString(),
  lastLoginAt: null,
  liveSessions: 0,
  effective: { scopes: ['catalog:curate'], writeTypes: [], readTypes: null, classifications: [] },
};

/** Applications only — the shape this library ships and the one hosts inherit. */
class ApplicationsOnlyDirectory implements CatalogDirectory {
  async listApplications(): Promise<CatalogApplicationSummary[]> {
    return [APPLICATION];
  }
}

/** A host that has a user store and lets the console write to it. */
class FullDirectory extends ApplicationsOnlyDirectory {
  upsert = vi.fn(
    async (input: CatalogPersonInput): Promise<CatalogPersonUpsertResult> => ({
      email: input.email,
      created: true,
      sessionsRevoked: false,
    }),
  );
  people = vi.fn(
    async (query: CatalogDirectoryQuery): Promise<CatalogPeoplePage> => ({
      people: [PERSON],
      total: 1_340,
      limit: query.limit,
      offset: query.offset,
    }),
  );
  listPeople(query: CatalogDirectoryQuery): Promise<CatalogPeoplePage> {
    return this.people(query);
  }
  upsertPerson(input: CatalogPersonInput): Promise<CatalogPersonUpsertResult> {
    return this.upsert(input);
  }
}

@Injectable()
class StubRegistry extends CatalogRegistry {
  getSnapshot(): CatalogSnapshot {
    return {
      version: 1,
      generatedAt: new Date(0).toISOString(),
      stats: { types: 0, properties: 0, relations: 0, enrichedTypes: 0 },
      types: [],
    };
  }
  getType(): CatalogObjectTypeDef | undefined {
    return undefined;
  }
  getGraph(): CatalogGraph {
    return { nodes: [], edges: [] };
  }
  patchType(): Promise<CatalogObjectTypeDef | undefined> {
    return Promise.resolve(undefined);
  }
  patchProperty(): Promise<CatalogObjectTypeDef | undefined> {
    return Promise.resolve(undefined);
  }
  resetOverlay(): Promise<void> {
    return Promise.resolve();
  }
}

@Injectable()
class StubStore implements CatalogReadStore {
  readonly capabilities = { snapshots: 'none', writable: false, timeTravel: false } as const;
  read(): Promise<CatalogReadResult> {
    return Promise.resolve({ rows: [], total: 0 });
  }
}

@Injectable()
class DenyGuard implements CanActivate {
  canActivate(): boolean {
    return false;
  }
}

/**
 * The directory arrives the way a real host's does: through a module that
 * exports the token, handed to `forRoot`'s `imports`.
 *
 * Not as a provider on the test's root module, which would not work — Nest
 * resolves a controller's dependencies from the injector of the module that
 * DECLARES it, and that is this library's module. `CatalogMikroOrmStoreModule`
 * exports `CATALOG_DIRECTORY` for exactly this reason.
 */
function directoryModule(directory: CatalogDirectory): DynamicModule {
  return {
    module: class DirectoryModule {},
    providers: [{ provide: CATALOG_DIRECTORY, useValue: directory }],
    exports: [CATALOG_DIRECTORY],
  };
}

function host(options: {
  path?: string;
  accessPath?: string;
  guards?: Type<unknown>[];
  directory?: CatalogDirectory;
  controller?: boolean;
}) {
  return CatalogModule.forRoot({
    ...(options.path !== undefined ? { path: options.path } : {}),
    ...(options.accessPath !== undefined ? { accessPath: options.accessPath } : {}),
    ...(options.guards !== undefined ? { guards: options.guards } : {}),
    ...(options.controller !== undefined ? { controller: options.controller } : {}),
    ...(options.directory ? { imports: [directoryModule(options.directory)] } : {}),
    registry: { provide: CatalogRegistry, useClass: StubRegistry },
    store: { provide: CATALOG_STORE, useClass: StubStore },
    overlayStore: new InMemoryCatalogOverlayStore(),
  });
}

async function boot(imports: Parameters<typeof Test.createTestingModule>[0]['imports']) {
  const moduleRef = await Test.createTestingModule({ imports: imports ?? [] }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

describe('Access endpoints (integration)', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('mounts beside the catalog path, not underneath it', async () => {
    // The console builds `<apiPath>/catalog` and `<apiPath>/access` as
    // siblings. Nesting them under the catalog prefix is the mistake that
    // 404s one screen while every other screen works, so both halves are
    // asserted: it answers where the console asks, and NOT where it doesn't.
    app = await boot([
      host({ path: 'api/catalog-service/catalog', directory: new ApplicationsOnlyDirectory() }),
    ]);

    await request(app.getHttpServer()).get('/api/catalog-service/access/principals').expect(200);
    await request(app.getHttpServer())
      .get('/api/catalog-service/catalog/access/principals')
      .expect(404);
  });

  it('honours an explicit accessPath over the derived sibling', async () => {
    app = await boot([
      host({
        path: 'api/catalog',
        accessPath: 'internal/who',
        directory: new ApplicationsOnlyDirectory(),
      }),
    ]);

    await request(app.getHttpServer()).get('/internal/who/principals').expect(200);
    await request(app.getHttpServer()).get('/api/access/principals').expect(404);
  });

  it('answers 501 with the token to wire when no directory is bound', async () => {
    // NOT 404, and this is the whole point of mounting the routes
    // unconditionally: an operator looking at a console that says "cannot GET"
    // goes looking for a broken build, and the thing that is actually missing
    // is one provider.
    app = await boot([host({ path: 'api/catalog' })]);

    const response = await request(app.getHttpServer()).get('/api/access/principals').expect(501);
    expect(response.body.message).toContain('CATALOG_DIRECTORY');
  });

  it('serves applications and refuses people when the directory has no people', async () => {
    // The shipped implementation's exact shape: a host inherits applications
    // and supplies people or does not. Refusing rather than returning `[]`,
    // because the screen renders a failed read and an empty list very
    // differently — and "nobody can sign in yet" invites an operator to create
    // an account that already exists somewhere else.
    app = await boot([host({ path: 'api/catalog', directory: new ApplicationsOnlyDirectory() })]);

    const applications = await request(app.getHttpServer())
      .get('/api/access/principals')
      .expect(200);
    expect(applications.body).toEqual([APPLICATION]);

    const people = await request(app.getHttpServer()).get('/api/access/people').expect(501);
    expect(people.body.message).toContain('listPeople');
  });

  it('refuses to write into a read-only directory', async () => {
    app = await boot([host({ path: 'api/catalog', directory: new ApplicationsOnlyDirectory() })]);

    const response = await request(app.getHttpServer())
      .post('/api/access/people')
      .send({ email: 'ana@example.com', role: 'curator' })
      .expect(501);
    expect(response.body.message).toContain('upsertPerson');
  });

  it('lists and upserts people through a host directory that implements both', async () => {
    const directory = new FullDirectory();
    app = await boot([host({ path: 'api/catalog', directory })]);

    const listed = await request(app.getHttpServer()).get('/api/access/people').expect(200);
    expect(listed.body).toEqual({
      people: [PERSON],
      // Reported, not implied. A page that cannot say what it is a page OF is
      // indistinguishable from the whole list, and an operator reading it as
      // whole concludes somebody has no access when they were merely not on it.
      total: 1_340,
      limit: CATALOG_DIRECTORY_PAGE,
      offset: 0,
    });

    await request(app.getHttpServer())
      .post('/api/access/people')
      .send({ email: 'bo@example.com', role: 'administrator', active: true })
      .expect(201)
      .expect((response) => {
        expect(response.body).toEqual({
          email: 'bo@example.com',
          created: true,
          sessionsRevoked: false,
        });
      });
    expect(directory.upsert).toHaveBeenCalledWith({
      email: 'bo@example.com',
      role: 'administrator',
      active: true,
    });
  });

  it('rejects an unknown role before the directory sees it', async () => {
    // The library ships no `class-validator` dependency and cannot assume the
    // host mounted a global ValidationPipe, so the parsing is by hand — which
    // is exactly the kind of code that silently stops running. Asserting the
    // directory was never called is what distinguishes "validated" from
    // "happened to fail downstream".
    const directory = new FullDirectory();
    app = await boot([host({ path: 'api/catalog', directory })]);

    await request(app.getHttpServer())
      .post('/api/access/people')
      .send({ email: 'bo@example.com', role: 'root' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/access/people')
      .send({ role: 'viewer' })
      .expect(400);

    expect(directory.upsert).not.toHaveBeenCalled();
  });

  it('applies the host guards to the access routes', async () => {
    // This surface enumerates every application that may write to the catalog,
    // and the grants that let it. A host guard that covered the catalog routes
    // but not these would leak exactly the list an attacker wants first.
    app = await boot([
      host({
        path: 'api/catalog',
        guards: [DenyGuard],
        directory: new ApplicationsOnlyDirectory(),
      }),
    ]);

    await request(app.getHttpServer()).get('/api/access/principals').expect(403);
    await request(app.getHttpServer()).get('/api/access/people').expect(403);
    await request(app.getHttpServer()).post('/api/access/people').send({}).expect(403);
  });

  it('lets a `directory` provider win over one an imported module exports', async () => {
    // The shadowing this option exists for. A host that binds
    // `CatalogMikroOrmStoreModule` — which exports an applications-only
    // directory — AND its own implementation gets the shipped one from the
    // import, silently, because a provider declared inside a module beats the
    // same token exported by one of its imports. `directory` is how the host
    // lands on the winning side of that rule instead of the losing one.
    const own = new FullDirectory();
    app = await boot([
      CatalogModule.forRoot({
        path: 'api/catalog',
        imports: [directoryModule(new ApplicationsOnlyDirectory())],
        directory: { provide: CATALOG_DIRECTORY, useValue: own },
        registry: { provide: CatalogRegistry, useClass: StubRegistry },
        store: { provide: CATALOG_STORE, useClass: StubStore },
        overlayStore: new InMemoryCatalogOverlayStore(),
      }),
    ]);

    // The imported one has no `listPeople` and would answer 501 here.
    const people = await request(app.getHttpServer()).get('/api/access/people').expect(200);
    expect(people.body.people).toEqual([PERSON]);
  });

  it('bounds the people read before the directory is asked', async () => {
    // The seam hands the limit DOWN so it can reach the database. A host's user
    // table is its whole directory, and an unbounded read here is one that gets
    // slower every time somebody is hired — so the endpoint must never pass on
    // "no limit", whatever the caller asked for.
    const directory = new FullDirectory();
    app = await boot([host({ path: 'api/catalog', directory })]);

    await request(app.getHttpServer()).get('/api/access/people').expect(200);
    expect(directory.people).toHaveBeenLastCalledWith({
      limit: CATALOG_DIRECTORY_PAGE,
      offset: 0,
    });

    await request(app.getHttpServer())
      .get('/api/access/people?search=ana&limit=10&offset=20')
      .expect(200);
    expect(directory.people).toHaveBeenLastCalledWith({
      search: 'ana',
      limit: 10,
      offset: 20,
    });

    // The ceiling, and the two ways a caller tries to get past it: asking for
    // more than the cap, and sending something that does not parse in the hope
    // that "no number" reads as "no limit".
    await request(app.getHttpServer()).get('/api/access/people?limit=100000').expect(200);
    expect(directory.people).toHaveBeenLastCalledWith({
      limit: CATALOG_DIRECTORY_MAX_PAGE,
      offset: 0,
    });

    await request(app.getHttpServer()).get('/api/access/people?limit=all&offset=-5').expect(200);
    expect(directory.people).toHaveBeenLastCalledWith({
      limit: CATALOG_DIRECTORY_PAGE,
      offset: 0,
    });
  });

  it('mounts nothing when the host takes over the HTTP surface', async () => {
    // `controller: false` means the host publishes its own routes. Leaving the
    // access ones behind would double-publish a governance endpoint the host
    // thought it owned.
    app = await boot([
      host({ path: 'api/catalog', controller: false, directory: new FullDirectory() }),
    ]);

    await request(app.getHttpServer()).get('/api/access/principals').expect(404);
    await request(app.getHttpServer()).get('/api/access/people').expect(404);
  });
});
