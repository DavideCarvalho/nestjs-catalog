import {
  CATALOG_PIPELINE_STORE,
  CATALOG_STORE,
  type CatalogObjectTypeDef,
  type CatalogReadResult,
  type CatalogStoreCapabilities,
  type SnapshotRef,
} from '@dudousxd/nestjs-catalog';
import { type INestApplication, Logger, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CATALOG_LOAD_EXPECTATIONS,
  type CatalogLoadExpectations,
  LoadExpectationError,
} from './load-expectations';
import { CatalogPipelineModule, describeExpectationsBinding } from './pipeline.module';
import { PublishService } from './publish.service';
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

const TYPE: CatalogObjectTypeDef = {
  name: 'Mvr',
  displayName: 'Mvr',
  pluralDisplayName: 'Mvrs',
  group: 'Fleet',
  tableName: 'catalog_mvr',
  primaryKey: ['id'],
  enriched: false,
  properties: [],
  relations: [],
};

const DECLARED: CatalogLoadExpectations = {
  byType: {
    Mvr: { deletes: { strategy: 'accepted', because: 'this fleet extract never deletes' } },
  },
};

/* ---------------------------------------------------------------------------
 * The sentence itself. Absent and empty produce the same refusals and are not
 * the same statement.
 * ------------------------------------------------------------------------- */

describe('describeExpectationsBinding', () => {
  it('warns when nothing is bound, and names the token somebody has to bind', () => {
    const { level, message } = describeExpectationsBinding(undefined);

    expect(level).toBe('warn');
    expect(message).toContain('CATALOG_LOAD_EXPECTATIONS');
    // The consequence, not just the absence. A line that said only "not
    // configured" leaves the reader to discover the refusal from a failed load.
    expect(message).toContain('refused');
  });

  it('does not warn about a host that bound an empty policy', () => {
    // The distinction this function exists for. "Nobody has thought about it"
    // and "we looked and nothing applies" are different statements, and only
    // the first is a surprise worth interrupting a boot for.
    const { level, message } = describeExpectationsBinding({});

    expect(level).toBe('log');
    expect(message).toContain('declare nothing');
  });

  it('names the declared types, so a deploy can be checked against what was written', () => {
    const { level, message } = describeExpectationsBinding({
      default: { rowCount: { maxShrink: 0.2 } },
      byType: { Mvr: DECLARED.byType?.Mvr ?? {}, Subwo: {} },
    });

    expect(level).toBe('log');
    expect(message).toContain('Mvr');
    expect(message).toContain('Subwo');
    expect(message).toContain('house default');
  });
});

/* ---------------------------------------------------------------------------
 * The seam. A host with no module of its own to hang the token on.
 * ------------------------------------------------------------------------- */

class FakeWriteStore {
  readonly capabilities: CatalogStoreCapabilities = {
    snapshots: 'emulated',
    writable: true,
    timeTravel: false,
  };
  carried = 0;
  read(): Promise<CatalogReadResult> {
    return Promise.resolve({ rows: [], total: 0 });
  }
  ensureType(): Promise<void> {
    return Promise.resolve();
  }
  write(): Promise<{ written: number }> {
    return Promise.resolve({ written: 0 });
  }
  commit(): Promise<SnapshotRef> {
    throw new Error('No case here commits.');
  }
  dropSnapshot(): Promise<void> {
    return Promise.resolve();
  }
  listSnapshots(): Promise<SnapshotRef[]> {
    return Promise.resolve([]);
  }
  // Present because `supportsCarryForward` is a method check: without it the
  // merge is refused for a reason that has nothing to do with expectations,
  // and every case below would pass while proving nothing.
  carryForward(): Promise<{ carried: number; total: number }> {
    this.carried += 1;
    return Promise.resolve({ carried: 0, total: 0 });
  }
}

const writeStore = new FakeWriteStore();

const registryStub: CatalogPipelineRegistry = {
  reload: () => Promise.resolve(),
  getType: (name: string): CatalogObjectTypeDef | undefined => (name === 'Mvr' ? TYPE : undefined),
};

class FakePipelineStore {
  listConnectors(): Promise<[]> {
    return Promise.resolve([]);
  }
}

@Module({
  providers: [
    { provide: CATALOG_PIPELINE_STORE, useClass: FakePipelineStore },
    { provide: CATALOG_STORE, useValue: writeStore },
  ],
  exports: [CATALOG_PIPELINE_STORE, CATALOG_STORE],
})
class FakeStoreModule {}

function host(expectations?: CatalogLoadExpectations) {
  return CatalogPipelineModule.forRoot({
    imports: [FakeStoreModule],
    em: {
      provide: CATALOG_PIPELINE_EM,
      useValue: () => {
        throw new Error('No EntityManager here; nothing in this file publishes a type.');
      },
    },
    registry: { provide: CATALOG_PIPELINE_REGISTRY, useValue: registryStub },
    // `scheduler: false` for the reason given in the integration spec: its
    // interval is deliberately not unref'd and would hold the worker open.
    scheduler: false,
    ...(expectations !== undefined
      ? { expectations: { provide: CATALOG_LOAD_EXPECTATIONS, useValue: expectations } }
      : {}),
  });
}

async function boot(expectations?: CatalogLoadExpectations) {
  const moduleRef = await Test.createTestingModule({ imports: [host(expectations)] }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

describe('CatalogPipelineModule.forRoot({ expectations })', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    writeStore.carried = 0;
    vi.restoreAllMocks();
  });

  it('reaches the enforcement point, so a declared type may be loaded incrementally', async () => {
    // The claim is not that the token is bound — it is that the binding arrives
    // where the refusal lives. `carryForwardAsSystem` is the one method every
    // incremental load passes through, and it refuses an undeclared type.
    app = await boot(DECLARED);

    await app.get(PublishService).carryForwardAsSystem('ana', 'Mvr', 'snap-1', {
      source: 'connector',
    });

    expect(writeStore.carried).toBe(1);
  });

  it('still refuses the same load when the host bound nothing', async () => {
    // The other half, and the reason the case above proves something: without
    // the binding this is the behaviour, and it is the intended one.
    app = await boot();

    await expect(
      app.get(PublishService).carryForwardAsSystem('ana', 'Mvr', 'snap-1', { source: 'connector' }),
    ).rejects.toBeInstanceOf(LoadExpectationError);
    expect(writeStore.carried).toBe(0);
  });

  it('says at boot that nothing was bound', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    app = await boot();

    expect(warn.mock.calls.flat().join('\n')).toContain('CATALOG_LOAD_EXPECTATIONS');
  });

  it('stays quiet about a host that bound one', async () => {
    // The line is a diagnosis, not a banner. A warning that also fires on the
    // correct configuration is one people learn to filter out, taking the real
    // one with it.
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    app = await boot(DECLARED);

    expect(warn.mock.calls.flat().join('\n')).not.toContain('CATALOG_LOAD_EXPECTATIONS');
  });
});
