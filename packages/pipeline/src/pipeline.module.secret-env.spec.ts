import { CATALOG_PIPELINE_STORE, CATALOG_STORE } from '@dudousxd/nestjs-catalog';
import { type INestApplication, Logger, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CatalogPipelineModule } from './pipeline.module';
import { CATALOG_PIPELINE_EM, CATALOG_PIPELINE_REGISTRY } from './seams';
import {
  ALLOW_EVERY_SECRET_ENV,
  SECRET_ENV_ALLOW_VAR,
  installSecretEnvAllowlist,
  secretEnvAllowlist,
} from './secret-env-allowlist';
import { resolveSecretEnv } from './sources';

/** See the note in `pipeline.module.integration.spec.ts`: the package cannot load here. */
vi.mock('@dudousxd/nestjs-durable', () => ({
  WorkflowEngine: class WorkflowEngine {},
  Step: () => (_target: unknown, _key: unknown, descriptor: unknown) => descriptor,
  Workflow: () => (target: unknown) => target,
}));

class FakePipelineStore {
  listConnectors(): Promise<[]> {
    return Promise.resolve([]);
  }
}

@Module({
  providers: [
    { provide: CATALOG_PIPELINE_STORE, useClass: FakePipelineStore },
    { provide: CATALOG_STORE, useValue: {} },
  ],
  exports: [CATALOG_PIPELINE_STORE, CATALOG_STORE],
})
class FakeStoreModule {}

function host(secretEnvAllowed?: readonly string[]) {
  return CatalogPipelineModule.forRoot({
    imports: [FakeStoreModule],
    em: {
      provide: CATALOG_PIPELINE_EM,
      useValue: () => {
        throw new Error('No EntityManager here; nothing in this file publishes a type.');
      },
    },
    registry: {
      provide: CATALOG_PIPELINE_REGISTRY,
      useValue: { reload: () => Promise.resolve(), getType: () => undefined },
    },
    // `scheduler: false` for the reason given in the integration spec: its
    // interval is deliberately not unref'd and would hold the worker open.
    scheduler: false,
    ...(secretEnvAllowed === undefined ? {} : { secretEnvAllowlist: secretEnvAllowed }),
  });
}

async function boot(secretEnvAllowed?: readonly string[]): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [host(secretEnvAllowed)] }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

const previous = process.env[SECRET_ENV_ALLOW_VAR];
let app: INestApplication | undefined;

beforeEach(() => {
  installSecretEnvAllowlist(undefined);
  delete process.env[SECRET_ENV_ALLOW_VAR];
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  installSecretEnvAllowlist(undefined);
  if (previous === undefined) delete process.env[SECRET_ENV_ALLOW_VAR];
  else process.env[SECRET_ENV_ALLOW_VAR] = previous;
  vi.restoreAllMocks();
});

/* ---------------------------------------------------------------------------
 * The seam. A host stating which credentials its connectors may read.
 * ------------------------------------------------------------------------- */

describe('CatalogPipelineModule.forRoot({ secretEnvAllowlist })', () => {
  it('puts the host’s list in force', async () => {
    app = await boot(['FLEET_DB_URL', 'VENDOR_*']);
    expect(secretEnvAllowlist()).toEqual(['FLEET_DB_URL', 'VENDOR_*']);
  });

  // The policy has to be in force before anything can resolve a credential, and
  // the earliest thing that can is the scheduler — which starts from
  // `onApplicationBootstrap`, the same hook a provider installing this would run
  // in, with no ordering between the two. Building the module is strictly before
  // booting it, so installing at `forRoot` cannot lose that race.
  it('is in force from the moment the module is built, before anything boots', () => {
    host(['FLEET_DB_URL']);
    expect(secretEnvAllowlist()).toEqual(['FLEET_DB_URL']);
  });

  it('falls through to the operator’s variable when the host says nothing', async () => {
    process.env[SECRET_ENV_ALLOW_VAR] = 'FLEET_DB_URL';
    app = await boot();
    expect(secretEnvAllowlist()).toEqual(['FLEET_DB_URL']);
  });

  it('refuses a malformed pattern at boot rather than at three in the morning', () => {
    // A boot that fails naming the pattern, instead of a boot that succeeds and
    // refuses every load for a reason that reads exactly like the allow-list
    // working correctly.
    expect(() => host(['*_URL'])).toThrow(/\*_URL/);
  });

  it('actually decides what a connector may read', async () => {
    const name = 'CATALOG_SPEC_MODULE_VAR';
    process.env[name] = 'a credential';
    app = await boot([name]);

    expect(resolveSecretEnv(name)).toBe('a credential');
    expect(() => resolveSecretEnv('DATABASE_URL')).toThrow(/No credential is available/);

    delete process.env[name];
  });
});

/* ---------------------------------------------------------------------------
 * The boot line, which is what makes a fail-closed default survivable.
 * ------------------------------------------------------------------------- */

describe('what a boot says about the policy', () => {
  function captureLogs() {
    const warned: string[] = [];
    const logged: string[] = [];
    vi.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
      warned.push(String(message));
    });
    vi.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
      logged.push(String(message));
    });
    return { warned, logged };
  }

  // The whole reason the refusal is survivable. Without this line the first
  // anybody hears of the upgrade is a run at 03:00 being told — correctly, and
  // by design — that it may not say why it failed.
  it('warns when nothing is in force, naming both levers and where to find the list', async () => {
    const { warned } = captureLogs();
    app = await boot();

    const line = warned.find((message) => message.includes(SECRET_ENV_ALLOW_VAR));
    expect(line).toBeDefined();
    expect(line).toContain('secretEnvAllowlist');
    expect(line).toContain('Credential env var');
    expect(line).toContain('refused');
  });

  it('warns on every boot that runs under the escape hatch', async () => {
    const { warned } = captureLogs();
    app = await boot([ALLOW_EVERY_SECRET_ENV]);

    expect(warned.some((message) => message.includes('DATABASE_URL'))).toBe(true);
  });

  // "Did my entry take?" is the question this answers on the morning after a
  // deploy, and a count cannot answer it.
  it('names the admitted variables, and does not warn, for a real policy', async () => {
    const { warned, logged } = captureLogs();
    app = await boot(['FLEET_DB_URL', 'VENDOR_*']);

    const line = logged.find((message) => message.includes('allow-list in force'));
    expect(line).toContain('FLEET_DB_URL');
    expect(line).toContain('VENDOR_*');
    expect(warned.some((message) => message.includes('credential allow-list'))).toBe(false);
  });

  it('says which lever won, so setting the variable and seeing nothing has an answer', async () => {
    const { logged } = captureLogs();
    process.env[SECRET_ENV_ALLOW_VAR] = 'FROM_THE_ENVIRONMENT';
    app = await boot(['FROM_THE_MODULE']);

    const line = logged.find((message) => message.includes('allow-list in force'));
    expect(line).toContain('takes precedence over');
    expect(line).toContain('FROM_THE_MODULE');
    expect(line).not.toContain('FROM_THE_ENVIRONMENT');
  });
});
