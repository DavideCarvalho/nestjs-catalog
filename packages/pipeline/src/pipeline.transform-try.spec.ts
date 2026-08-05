import {
  CATALOG_PIPELINE_STORE,
  CATALOG_STORE,
  type CatalogConnection,
  type CatalogConnector,
  type CatalogObjectTypeDef,
  type CatalogPipelineStore,
  type CatalogPrincipal,
  type CatalogReadResult,
  type CatalogStoreCapabilities,
  type CatalogTransform,
  type CatalogWriteStore,
  type ConnectorRun,
  type SnapshotRef,
} from '@dudousxd/nestjs-catalog';
import { type CanActivate, type ExecutionContext, Injectable, Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CatalogPipelineModule } from './pipeline.module';
import {
  CATALOG_PIPELINE_EM,
  CATALOG_PIPELINE_REGISTRY,
  type CatalogPipelineRegistry,
} from './seams';

/** See the note in `pipeline.module.integration.spec.ts`: the package cannot load here. */
vi.mock('@dudousxd/nestjs-durable', () => ({
  WorkflowEngine: class WorkflowEngine {},
  Step: () => (_target: unknown, _key: unknown, descriptor: unknown) => descriptor,
  Workflow: () => (target: unknown) => target,
}));

/**
 * `POST transforms/try` takes code and runs it in this process, so who may
 * reach it is the whole of the control.
 *
 * Driven over HTTP through the real controller and the real
 * `SubprocessTransformRunner`, because every one of these failures is invisible
 * to a unit test of a predicate. The route did not call a predicate. It read no
 * principal at all — the only route on this controller that did not — and a
 * test that called `assertMayRunCode` directly would have passed against the
 * unfixed code, which is exactly the mistake `pipeline.grants.spec.ts` records
 * having been made once already.
 *
 * The code each case posts is deliberately harmless (`return []`). What is under
 * test is whether the request is *refused*, and a payload that actually read
 * `/proc/<ppid>/environ` to prove the point would be a test that leaks its own
 * runner's environment into a CI log on the day it regresses.
 */

/**
 * Four principals, differing only in the axis each case is about.
 *
 * `writeTypes` is the interesting one. `catalog:write` with no grant is a
 * perfectly ordinary principal — `catalog.principal.ts` says an unlisted type is
 * a denied write — and it is precisely the principal that can cause no load on
 * any other route on this surface. If it can run code here, the scope is
 * claiming a bound it does not have.
 */
const PERSON_WITH_GRANT: CatalogPrincipal = {
  id: 'console#ana@example.com',
  applicationId: 'console',
  actor: { id: 'ana@example.com', displayName: 'Ana' },
  scopes: ['catalog:read', 'catalog:write'],
  writeTypes: ['Mvr'],
};

const PERSON_WITHOUT_GRANT: CatalogPrincipal = {
  id: 'console#bo@example.com',
  applicationId: 'console',
  actor: { id: 'bo@example.com' },
  scopes: ['catalog:read', 'catalog:write'],
  writeTypes: [],
};

/** A nightly publisher: every grant a person has, and nobody behind it. */
const MACHINE_WITH_GRANT: CatalogPrincipal = {
  id: 'nightly-publisher',
  scopes: ['catalog:read', 'catalog:write'],
  writeTypes: ['*'],
};

/** Admin implies every scope — and still no `writeTypes`, which is the point. */
const ADMIN_MACHINE: CatalogPrincipal = {
  id: 'ops-robot',
  scopes: ['catalog:admin'],
  writeTypes: ['*'],
};

const PRINCIPALS: Record<string, CatalogPrincipal> = {
  'person-with-grant': PERSON_WITH_GRANT,
  'person-without-grant': PERSON_WITHOUT_GRANT,
  'machine-with-grant': MACHINE_WITH_GRANT,
  'admin-machine': ADMIN_MACHINE,
};

/**
 * Whoever the request said it was, and nobody when it said nothing.
 *
 * The "nobody" case is not padding: it is how the route behaved for every
 * caller. A host guard that authenticates and then leaves `request.principal`
 * unset — or a route reached before the guard populates it — met a handler that
 * never looked, so the header being absent here stands in for the whole class.
 */
@Injectable()
class HeaderPrincipalGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request: { headers?: Record<string, unknown>; principal?: CatalogPrincipal } = context
      .switchToHttp()
      .getRequest();
    const who = request.headers?.['x-principal'];
    if (typeof who === 'string' && PRINCIPALS[who]) request.principal = PRINCIPALS[who];
    return true;
  }
}

/** Nothing on this route touches the store; it throws rather than invent rows. */
class UnusedPipelineStore implements CatalogPipelineStore {
  private unused(method: string): never {
    throw new Error(`UnusedPipelineStore.${method} is not reached by the try route.`);
  }
  listConnectors(): Promise<CatalogConnector[]> {
    return this.unused('listConnectors');
  }
  getConnector(): Promise<CatalogConnector | undefined> {
    return this.unused('getConnector');
  }
  saveConnector(): Promise<CatalogConnector> {
    return this.unused('saveConnector');
  }
  deleteConnector(): Promise<boolean> {
    return this.unused('deleteConnector');
  }
  saveConnectorState(): Promise<void> {
    return this.unused('saveConnectorState');
  }
  listConnections(): Promise<CatalogConnection[]> {
    return this.unused('listConnections');
  }
  getConnection(): Promise<CatalogConnection | undefined> {
    return this.unused('getConnection');
  }
  saveConnection(): Promise<CatalogConnection> {
    return this.unused('saveConnection');
  }
  deleteConnection(): Promise<boolean> {
    return this.unused('deleteConnection');
  }
  recordConnectionCheck(): Promise<void> {
    return this.unused('recordConnectionCheck');
  }
  connectorsUsingConnection(): Promise<CatalogConnector[]> {
    return this.unused('connectorsUsingConnection');
  }
  listTransforms(): Promise<CatalogTransform[]> {
    return this.unused('listTransforms');
  }
  getTransform(): Promise<CatalogTransform | undefined> {
    return this.unused('getTransform');
  }
  saveTransform(): Promise<CatalogTransform> {
    return this.unused('saveTransform');
  }
  deleteTransform(): Promise<boolean> {
    return this.unused('deleteTransform');
  }
  startRun(): Promise<ConnectorRun> {
    return this.unused('startRun');
  }
  finishRun(): Promise<ConnectorRun | undefined> {
    return this.unused('finishRun');
  }
  listRuns(): Promise<ConnectorRun[]> {
    return this.unused('listRuns');
  }
}

class UnusedWriteStore implements CatalogWriteStore {
  readonly capabilities: CatalogStoreCapabilities = {
    snapshots: 'emulated',
    writable: true,
    timeTravel: false,
  };
  read(): Promise<CatalogReadResult> {
    return Promise.resolve({ rows: [], total: 0 });
  }
  ensureType(): Promise<void> {
    return Promise.resolve();
  }
  write(): Promise<{ written: number }> {
    throw new Error('Nothing here writes.');
  }
  commit(): Promise<SnapshotRef> {
    throw new Error('Nothing here commits.');
  }
  dropSnapshot(): Promise<void> {
    return Promise.resolve();
  }
}

const registryStub: CatalogPipelineRegistry = {
  reload: () => Promise.resolve(),
  getType: (): CatalogObjectTypeDef | undefined => undefined,
};

@Module({
  providers: [
    { provide: CATALOG_PIPELINE_STORE, useClass: UnusedPipelineStore },
    { provide: CATALOG_STORE, useClass: UnusedWriteStore },
  ],
  exports: [CATALOG_PIPELINE_STORE, CATALOG_STORE],
})
class FakeStoreModule {}

const BASE = '/catalog/pipeline';

describe('POST transforms/try is code execution, and is authorised as such', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        CatalogPipelineModule.forRoot({
          path: 'catalog',
          guards: [HeaderPrincipalGuard],
          imports: [FakeStoreModule],
          em: {
            provide: CATALOG_PIPELINE_EM,
            useValue: () => {
              throw new Error('No EntityManager here; nothing in this file publishes a type.');
            },
          },
          registry: { provide: CATALOG_PIPELINE_REGISTRY, useValue: registryStub },
          scheduler: false,
        }),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const tryTransform = (who: string | undefined, body: object) => {
    const post = request(app.getHttpServer()).post(`${BASE}/transforms/try`);
    return (who ? post.set('x-principal', who) : post).send(body);
  };

  const harmless = { language: 'javascript', code: 'return [];', records: [] };

  describe('who may run it', () => {
    it('runs it for a signed-in person holding a write grant', async () => {
      // The case the route exists for. Everything below is refused, so this is
      // what stops the fix from being "turn the feature off".
      const response = await tryTransform('person-with-grant', {
        language: 'javascript',
        code: 'return records.map((r) => ({ n: r.n * 2 }));',
        records: [{ n: 21 }],
      }).expect(201);
      expect(response.body.rows).toEqual([{ n: 42 }]);
    });

    it('refuses a caller the guard left no principal for', async () => {
      // The heart of it: this route never called `requirePrincipal`. A missing
      // principal reached `transforms.run` and the code ran.
      await tryTransform(undefined, harmless).expect(500);
    });

    it('refuses a principal with catalog:write and no write grant', async () => {
      // `writeTypes: []` can cause no load on any other route on this surface —
      // not a connector, not a graph, not a run. This was the one place it could
      // still cause code to execute, which is precisely the bound
      // `catalog.principal.ts` claims `writeTypes` provides.
      await tryTransform('person-without-grant', harmless).expect(403);
    });

    it('refuses a machine principal, however granted', async () => {
      // A nightly publisher has no reason to open a try pane, and its key is the
      // credential that leaks — `StaticKeyPrincipalResolver` says so itself.
      await tryTransform('machine-with-grant', harmless).expect(403);
    });

    it('refuses an admin machine too, because admin is not a person', async () => {
      // `hasScope` treats `catalog:admin` as implying every scope, so a scope
      // check alone lets this through. The requirement is orthogonal to scopes,
      // which is the entire argument in `RequireHuman`'s docblock.
      await tryTransform('admin-machine', harmless).expect(403);
    });

    it('says which of the two refusals it is', async () => {
      // A 403 that does not distinguish "ask for a grant" from "stop using a
      // service account" sends the reader to the wrong screen.
      const noGrant = await tryTransform('person-without-grant', harmless).expect(403);
      expect(JSON.stringify(noGrant.body)).toContain('granted no object type');

      const machine = await tryTransform('machine-with-grant', harmless).expect(403);
      expect(JSON.stringify(machine.body)).toContain('is an application');
    });
  });

  describe('what it will accept as a language', () => {
    it('refuses a language that is not one, naming the ones that are', async () => {
      // `saveTransform` validated this and `tryTransform` did not, so an unknown
      // language fell through the runner's `language === "python"` test and ran
      // as JavaScript.
      const response = await tryTransform('person-with-grant', {
        language: 'ruby',
        code: 'return [];',
      }).expect(400);
      expect(JSON.stringify(response.body)).toContain('javascript');
    });

    it('refuses a language that is not even a string', async () => {
      await tryTransform('person-with-grant', { language: { evil: true }, code: 'return [];' })
        .expect(400)
        .expect((response) => {
          expect(JSON.stringify(response.body)).not.toContain('Internal server error');
        });
    });

    it('accepts typescript, which the old annotation excluded', async () => {
      // The body was typed `'javascript' | 'python'`, so TypeScript — a language
      // the runner has always supported and `TRANSFORM_LANGUAGES` names — was
      // excluded by an annotation that checked nothing anyway.
      const response = await tryTransform('person-with-grant', {
        language: 'typescript',
        code: 'const out: { ok: boolean }[] = [{ ok: true }]; return out;',
      }).expect(201);
      expect(response.body.rows).toEqual([{ ok: true }]);
    });

    it('refuses before it runs anything', async () => {
      // Ordering, not decoration: validation after the spawn would mean the
      // refusal arrived once the code had already had its ten seconds.
      const started = Date.now();
      await tryTransform('person-with-grant', {
        language: 'ruby',
        code: 'const until = Date.now() + 3000; while (Date.now() < until) {}; return [];',
      }).expect(400);
      expect(Date.now() - started).toBeLessThan(2_000);
    });

    it('refuses a refused caller before it runs anything', async () => {
      const started = Date.now();
      await tryTransform('machine-with-grant', {
        language: 'javascript',
        code: 'const until = Date.now() + 3000; while (Date.now() < until) {}; return [];',
      }).expect(403);
      expect(Date.now() - started).toBeLessThan(2_000);
    });
  });

  describe('what it leaves behind', () => {
    it('names the principal in the log, because nothing else records the run', async () => {
      // This route stores no transform row and no run row, so the log line is
      // the only evidence that code ran in this process and on whose say-so.
      const logged: string[] = [];
      const logger = vi
        .spyOn(await import('@nestjs/common').then((m) => m.Logger.prototype), 'log')
        .mockImplementation((message: unknown) => {
          logged.push(String(message));
        });

      await tryTransform('person-with-grant', harmless).expect(201);
      logger.mockRestore();

      expect(logged.some((line) => line.includes('console#ana@example.com'))).toBe(true);
    });
  });
});
