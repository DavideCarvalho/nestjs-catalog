import { CATALOG_PIPELINE_STORE, CATALOG_STORE } from '@dudousxd/nestjs-catalog';
import type { WorkflowEngine } from '@dudousxd/nestjs-durable';
import type { AnnouncedWorkflow } from '@dudousxd/nestjs-durable-core';
import type { INestApplication } from '@nestjs/common';
import { type CanActivate, Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CatalogPipelineModule } from './pipeline.module';
import { CATALOG_PIPELINE_EM, CATALOG_PIPELINE_REGISTRY } from './seams';
import { WorkflowLauncher } from './workflow-launcher.service';
import type { WorkflowRunnerService } from './workflow-runner.service';

/** See the note in `pipeline.module.integration.spec.ts`: the package cannot load here. */
vi.mock('@dudousxd/nestjs-durable', () => ({
  WorkflowEngine: class WorkflowEngine {},
  Step: () => (_target: unknown, _key: unknown, descriptor: unknown) => descriptor,
  Workflow: () => (target: unknown) => target,
}));

/**
 * That the list behind the call node's picker keeps the three things the durable
 * announce registry refuses to lose.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The call node was built with two typed fields and a docblock explaining that a
 * picker could not be built honestly: nothing could enumerate a deployment's
 * registrations, because `workflowBody(name, version)` answers only for the
 * process asking and a missing body means "not registered here" *or* "registered
 * through `registerRemote` against another SDK" *or* "a group resolved by
 * convention against a live worker". `announcedWorkflows()` (durable 0.65.0)
 * changed that by asking live workers what they can execute instead of inferring
 * it.
 *
 * What the adapter must not do is quietly make the answer tidier than it is, so
 * every test here is about a fact being CARRIED rather than resolved:
 *
 * 1. **A bare name stays a bare name.** An un-upgraded worker announces a name
 *    with no version. No version may be invented for it from a sibling entry,
 *    and it must not be offerable as a pin.
 * 2. **Two groups stay two groups.** Nothing here may pick one, because two
 *    groups means nobody can say which queue a run would land on.
 * 3. **"Nobody could be asked" is not "there are none".** With no durable engine
 *    the answer is `supported: false`, never a bare empty list — a screen that
 *    read the second as the first would tell somebody their workflow does not
 *    exist.
 */

/**
 * A stand-in for the durable engine, prototype-bearing for the reason
 * `workflow-launcher.durability.spec.ts` states: `durability()` reports the
 * class that resolved, and a bare literal would report `Object`.
 */
function asEngine(stub: object): WorkflowEngine {
  return Object.assign(Object.create(Object.getPrototypeOf(stub)), stub);
}

class AnnouncingEngine {
  constructor(private readonly answer: AnnouncedWorkflow[] | Error) {}

  async announcedWorkflows(): Promise<AnnouncedWorkflow[]> {
    if (this.answer instanceof Error) throw this.answer;
    return this.answer;
  }
}

/** One announcement, with the fleet speaking with one voice unless told otherwise. */
function announced(overrides: Partial<AnnouncedWorkflow> = {}): AnnouncedWorkflow {
  const name = overrides.name ?? 'billing.reconcile';
  const version = 'version' in overrides ? overrides.version : '2';
  return {
    // The ordinary tier: a live worker published a descriptor. A test about the
    // weaker one says `evidence: 'observed'` and drops the version, because that
    // is the only shape the engine ever produces it in.
    evidence: 'declared',
    key: version === undefined ? name : `${name}@${version}`,
    name,
    version,
    groups: ['billing'],
    origins: [],
    requires: [],
    runtimes: ['python'],
    instances: ['worker-1'],
    disagreements: [],
    ...overrides,
  };
}

/** Only what the launcher reaches for; see the note in the durability spec. */
function runnerStub(): WorkflowRunnerService {
  return Object.assign(Object.create(null), {
    requireWorkflow: async () => {
      throw new Error('Nothing here runs a graph.');
    },
  });
}

function launcher(answer?: AnnouncedWorkflow[] | Error, detail?: string): WorkflowLauncher {
  const engine = answer === undefined ? undefined : asEngine(new AnnouncingEngine(answer));
  return new WorkflowLauncher(runnerStub(), engine, detail);
}

describe('what a call node could be pointed at', () => {
  it('reports every announced version as its own entry', async () => {
    // One entry per VERSION and never per name: an option that resolved the
    // version would undo the pin the node exists for.
    const answer = await launcher([
      announced({ version: '1', key: 'billing.reconcile@1' }),
      announced({ version: '2', key: 'billing.reconcile@2' }),
    ]).callableWorkflows();

    expect(answer.supported).toBe(true);
    expect(answer.workflows).toEqual([
      {
        evidence: 'declared',
        name: 'billing.reconcile',
        version: '1',
        group: 'billing',
        workers: 1,
      },
      {
        evidence: 'declared',
        name: 'billing.reconcile',
        version: '2',
        group: 'billing',
        workers: 1,
      },
    ]);
  });

  it('says when it looked, because this is a snapshot and not a registry', async () => {
    const answer = await launcher([announced()]).callableWorkflows();

    expect(Number.isNaN(new Date(answer.observedAt).getTime())).toBe(false);
    expect(answer.detail).toContain('read just now');
  });

  it('counts the workers announcing one, so a single point of failure is visible', async () => {
    const answer = await launcher([
      announced({ instances: ['worker-1', 'worker-2', 'worker-3'] }),
    ]).callableWorkflows();

    expect(answer.workflows[0].workers).toBe(3);
  });

  it('keeps a bare name bare, inventing no version for it', async () => {
    // THE UN-UPGRADED WORKER. It announces a name and nothing else, and a
    // version taken from the entry beside it would be this adapter asserting
    // something no worker said.
    const answer = await launcher([
      announced({ name: 'legacy.sweep', version: undefined, groups: [], key: 'legacy.sweep' }),
      announced({ name: 'billing.reconcile', version: '2' }),
    ]).callableWorkflows();

    const bare = answer.workflows.find((ref) => ref.name === 'legacy.sweep');
    expect(bare).toBeDefined();
    expect(bare?.version).toBeUndefined();
    expect(bare?.group).toBeUndefined();
  });

  /**
   * The weaker tier, carried across rather than flattened into "no version".
   *
   * An `'observed'` entry is on the list because a live routing token of that
   * name exists and nothing else — no descriptor, no version, no runtime. It is
   * exactly the callee whose runs come back tagged `version:undeclared`, so an
   * author reading the picker can be told that a version typed against it will
   * not be verified, which is the only place that could be known before a load
   * ran.
   */
  it('carries how strong the fleet claim is, not merely whether a version came with it', async () => {
    const answer = await launcher([
      announced({
        evidence: 'observed',
        name: 'processing',
        version: undefined,
        key: 'processing',
        groups: ['processing'],
        origins: [],
        runtimes: [],
      }),
      announced({ name: 'billing.reconcile', version: '2' }),
    ]).callableWorkflows();

    expect(answer.workflows.find((ref) => ref.name === 'processing')?.evidence).toBe('observed');
    expect(answer.workflows.find((ref) => ref.name === 'billing.reconcile')?.evidence).toBe(
      'declared',
    );
  });

  it('names the group only when the announcers agree on exactly one', async () => {
    const answer = await launcher([
      announced({
        groups: ['billing', 'billing-legacy'],
        disagreements: [{ axis: 'group', values: ['billing', 'billing-legacy'] }],
      }),
    ]).callableWorkflows();

    // Not "the first one", not "the alphabetically smallest one". Absent.
    expect(answer.workflows[0].group).toBeUndefined();
    expect(answer.workflows[0].disagreements).toEqual([
      { axis: 'group', values: ['billing', 'billing-legacy'] },
    ]);
  });

  it('carries a disagreement about origin without letting it hide the group', async () => {
    // Origin is worth showing and is NOT a refusal: it does not change which
    // queue a run goes to, so a pin that is otherwise exactly determined stays
    // choosable.
    const answer = await launcher([
      announced({
        origins: ['@acme/billing', '@acme/billing-next'],
        disagreements: [{ axis: 'origin', values: ['@acme/billing', '@acme/billing-next'] }],
      }),
    ]).callableWorkflows();

    expect(answer.workflows[0].group).toBe('billing');
    expect(answer.workflows[0].description).toBeUndefined();
    expect(answer.workflows[0].disagreements).toEqual([
      { axis: 'origin', values: ['@acme/billing', '@acme/billing-next'] },
    ]);
  });

  it('describes a workflow by its declaring package when exactly one claims it', async () => {
    const answer = await launcher([announced({ origins: ['@acme/billing'] })]).callableWorkflows();

    expect(answer.workflows[0].description).toBe('declared by @acme/billing');
  });

  it('distinguishes "nobody could be asked" from "there are none"', async () => {
    // The whole value of the flag. Both answers carry an empty list, and only
    // one of them means the deployment has no callable workflows.
    const noEngine = await launcher().callableWorkflows();
    const nothingAnnounced = await launcher([]).callableWorkflows();

    expect(noEngine.supported).toBe(false);
    expect(noEngine.workflows).toEqual([]);
    expect(noEngine.detail).toContain('No durable engine resolved in this process');

    expect(nothingAnnounced.supported).toBe(true);
    expect(nothingAnnounced.workflows).toEqual([]);
  });

  it('adds whatever the host wanted said, rather than replacing what was observed', async () => {
    const answer = await launcher(undefined, 'This pod serves dev.').callableWorkflows();

    expect(answer.detail).toContain('No durable engine resolved in this process');
    expect(answer.detail).toContain('This pod serves dev.');
  });

  it('answers "cannot enumerate" when the read itself fails, and does not throw', async () => {
    // This route only ever feeds a convenience. A picker whose backing read is
    // down must not take the inspector — and the two typed fields on it — down
    // with it.
    const answer = await launcher(new Error('redis is unreachable')).callableWorkflows();

    expect(answer.supported).toBe(false);
    expect(answer.workflows).toEqual([]);
    expect(answer.detail).toContain('redis is unreachable');
  });
});

@Injectable()
class LetEverybodyIn implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

@Module({
  providers: [
    { provide: CATALOG_PIPELINE_STORE, useValue: { listConnectors: () => Promise.resolve([]) } },
    { provide: CATALOG_STORE, useValue: {} },
  ],
  exports: [CATALOG_PIPELINE_STORE, CATALOG_STORE],
})
class FakeStoreModule {}

describe('GET pipeline/callable-workflows', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        CatalogPipelineModule.forRoot({
          path: 'catalog',
          guards: [LetEverybodyIn],
          imports: [FakeStoreModule],
          em: {
            provide: CATALOG_PIPELINE_EM,
            useValue: () => {
              throw new Error('Nothing here publishes a type.');
            },
          },
          registry: { provide: CATALOG_PIPELINE_REGISTRY, useValue: { getType: () => undefined } },
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

  it('is served, and is not folded into capabilities', async () => {
    // Separate routes because the two are cached on opposite terms: capabilities
    // cannot change without a redeploy, and this is a snapshot about one worker
    // heartbeat wide. One payload cannot hold both lifetimes.
    const list = await request(app.getHttpServer()).get('/catalog/pipeline/callable-workflows');
    const capabilities = await request(app.getHttpServer()).get('/catalog/pipeline/capabilities');

    expect(list.status).toBe(200);
    expect(capabilities.body.callableWorkflows).toBeUndefined();
  });

  it('says nobody could be asked, rather than answering with a bare empty list', async () => {
    // No engine is registered in this module, so an empty list here would be a
    // lie about the deployment rather than a fact about it.
    const response = await request(app.getHttpServer()).get('/catalog/pipeline/callable-workflows');

    expect(response.body.supported).toBe(false);
    expect(response.body.workflows).toEqual([]);
    expect(typeof response.body.detail).toBe('string');
    expect(response.body.detail.length).toBeGreaterThan(0);
    expect(typeof response.body.observedAt).toBe('string');
  });
});
