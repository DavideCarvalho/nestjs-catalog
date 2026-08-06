import type { CatalogWorkflow, ConnectorRun } from '@dudousxd/nestjs-catalog';
import type { WorkflowEngine } from '@dudousxd/nestjs-durable';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowLauncher } from './workflow-launcher.service';
import { CATALOG_WORKFLOW_RUN } from './workflow-run.workflow';
import type { WorkflowRunnerService } from './workflow-runner.service';

/**
 * The same stub every other spec in this package installs, for the same reason:
 * `@dudousxd/nestjs-durable` imports `@dudousxd/durable-worker` at module scope
 * while declaring it an OPTIONAL peer, so pnpm never installs it and the import
 * throws before a single test runs.
 *
 * Nothing under test is faked by it. `WorkflowEngine` is only ever an
 * `@Optional()` injection token here, and the engines below are hand-built
 * stands-in either way — which is the point of the `engine` assertions: what
 * `durability()` reports has to be the class that actually resolved, not the
 * one this package imported.
 */
vi.mock('@dudousxd/nestjs-durable', () => ({
  WorkflowEngine: class WorkflowEngine {},
  Step: () => (_target: unknown, _key: unknown, descriptor: unknown) => descriptor,
  Workflow: () => (target: unknown) => target,
}));

/**
 * A stand-in for the durable engine, built by hand rather than mocked.
 *
 * Prototype-bearing on purpose: `durability()` reports `engine` as the class
 * that resolved, so a bare object literal would test the wrong thing — it would
 * report `Object` no matter what the launcher did. `Object.create` of the stub's
 * own prototype is the same idiom the store-capability specs use for a partial
 * interface, and it keeps the constructor name honest.
 */
function asEngine(stub: object): WorkflowEngine {
  return Object.assign(Object.create(Object.getPrototypeOf(stub)), stub);
}

class FakeEngine {
  readonly started: Array<{ workflow: string; input: unknown; runId: string }> = [];

  async start(workflow: string, input: unknown, runId: string) {
    this.started.push({ workflow, input, runId });
    return { runId, status: 'pending' };
  }
}

/** A differently named class, so "the class name" cannot be a constant in disguise. */
class AttachedEngine extends FakeEngine {}

const workflow: CatalogWorkflow = {
  id: 'wf-1',
  name: 'Nightly fleet',
  nodes: [],
  edges: [],
  status: 'ready',
  enabled: true,
  version: 4,
  graphHash: 'abcdef0123456789',
  targetType: 'Mvr',
  createdBy: 'someone',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function finished(snapshotId: string): ConnectorRun {
  return {
    id: snapshotId,
    connectorId: 'conn-1',
    snapshotId,
    principalId: 'p-1',
    status: 'succeeded',
    fetched: 3,
    written: 3,
    logs: [],
    startedAt: '2026-01-01T00:00:00.000Z',
  };
}

/**
 * Only the five members `WorkflowLauncher` actually reaches for.
 *
 * Annotated rather than asserted — the same shape `catalog.pipeline.spec.ts`
 * uses for a partial store — because a launcher that started calling a sixth
 * method should fail here loudly rather than be quietly satisfied by a cast.
 */
function runnerStub(inline: ConnectorRun[] = [], found: ConnectorRun | undefined = undefined) {
  const calls: { inline: number } = { inline: 0 };
  const service: WorkflowRunnerService = Object.assign(Object.create(null), {
    requireWorkflow: async () => workflow,
    attributionFor: async () => 'conn-1',
    runInline: async (input: { snapshotId: string }) => {
      calls.inline += 1;
      const run = finished(input.snapshotId);
      inline.push(run);
      return run;
    },
    findRun: async (_connectorId: string, snapshotId: string) => found ?? finished(snapshotId),
  });
  return { service, calls };
}

function launcher(engine?: WorkflowEngine, detail?: string): WorkflowLauncher {
  return new WorkflowLauncher(runnerStub().service, engine, detail);
}

describe('durability, with no engine in the injector', () => {
  it('says so, rather than promising a checkpoint', () => {
    const answer = launcher().durability();
    expect(answer.available).toBe(false);
    expect(answer.detail).toContain('No durable engine resolved in this process');
  });

  // "Absent when nothing can checkpoint here" — the field's own contract.
  it('names no engine', () => {
    expect(launcher().durability().engine).toBeUndefined();
  });

  // `CATALOG_PIPELINE_DURABILITY_DETAIL` is documented as something that "only
  // ever ADDS to what the package observed", and it was substituting: a host
  // binding a true and specific sentence erased the one part that had actually
  // been checked, leaving a reader with no idea whether an engine resolved.
  it("adds the host's detail to the observation instead of replacing it", () => {
    const answer = launcher(undefined, 'APP_TYPE=API here, so no worker serves this.').durability();
    expect(answer.detail).toContain('No durable engine resolved in this process');
    expect(answer.detail).toContain('APP_TYPE=API here, so no worker serves this.');
  });

  it('puts the observation first, since it is the part that was checked', () => {
    const answer = launcher(undefined, 'Host says so.').durability();
    expect(answer.detail.indexOf('No durable engine')).toBeLessThan(
      answer.detail.indexOf('Host says so.'),
    );
  });
});

describe('durability, with an engine in the injector', () => {
  it('reports the checkpoint it can honestly promise', () => {
    const answer = launcher(asEngine(new FakeEngine())).durability();
    expect(answer.available).toBe(true);
    expect(answer.detail).toContain('A durable engine resolved here');
  });

  // Declared on `WorkflowDurability` as something a console can print, and the
  // body never populated it — so the React banner's `checkpointing: <engine>`
  // label could not have rendered a name in any deployment.
  it('names the engine that resolved', () => {
    expect(launcher(asEngine(new FakeEngine())).durability().engine).toBe('FakeEngine');
  });

  it('reads the class rather than printing a constant', () => {
    expect(launcher(asEngine(new AttachedEngine())).durability().engine).toBe('AttachedEngine');
  });

  it("adds the host's detail to the observation instead of replacing it", () => {
    const answer = launcher(
      asEngine(new FakeEngine()),
      'This pod registers no workflow handlers.',
    ).durability();
    expect(answer.detail).toContain('A durable engine resolved here');
    expect(answer.detail).toContain('This pod registers no workflow handlers.');
  });

  /**
   * The decision the docblock now states plainly: one check, and it is whether
   * an engine resolved — nothing is asked OF the engine.
   *
   * Pinned as a test because the tempting next step is to consult
   * `workflowBody()` and call an unregistered name "not durable". That answer is
   * only half available — no body is equally a remote registration or a
   * convention-routed worker — and a false "no" routes a durable run inline,
   * which carries none of the singleton mutex and lets two workers load one
   * connector's type at once. An engine that throws on every access proves
   * nothing is being asked.
   */
  it('does not interrogate the engine to answer', () => {
    // `Object.create(null)` rather than `{}`: it is typed `any`, so the Proxy is
    // too and satisfies the `WorkflowEngine` parameter without an assertion —
    // the same trick the store specs use, and the reason is the same. A real
    // `WorkflowEngine` has 130 members and this fixture must have NONE that can
    // be read without throwing, which is the whole assertion.
    const hostile = new Proxy(Object.create(null), {
      get(_target, property) {
        if (property === 'constructor') return FakeEngine;
        throw new Error(`durability() asked the engine for "${String(property)}".`);
      },
    });
    const answer = new WorkflowLauncher(runnerStub().service, hostile).durability();
    expect(answer.available).toBe(true);
    expect(answer.engine).toBe('FakeEngine');
  });
});

/**
 * The routing `durability()` feeds, kept beside it because the two are one
 * decision: the same method answers "what should the console say" and "how does
 * this run execute", so a change to the sentence must not move the run.
 */
describe('run', () => {
  it('runs inline when no engine resolved', async () => {
    const { service, calls } = runnerStub();
    const run = await new WorkflowLauncher(service).run({
      workflowId: 'wf-1',
      principalId: 'p-1',
    });
    expect(calls.inline).toBe(1);
    expect(run.status).toBe('succeeded');
  });

  it('starts a durable run when one did, under the snapshot id it minted', async () => {
    const engine = new FakeEngine();
    const { service, calls } = runnerStub();
    const run = await new WorkflowLauncher(service, asEngine(engine)).run({
      workflowId: 'wf-1',
      principalId: 'p-1',
    });
    expect(calls.inline).toBe(0);
    expect(engine.started).toHaveLength(1);
    // The durable run id, the snapshot and the stage key are one string — that
    // is what makes a retried run rejoin its own snapshot rather than open a
    // second one.
    expect(engine.started[0]?.workflow).toBe(CATALOG_WORKFLOW_RUN);
    expect(engine.started[0]?.runId).toBe(run.snapshotId);
  });

  // The escape hatch for re-driving a failed run: a retry that opened a NEW
  // snapshot would leave the half-written one behind and load the data twice.
  it('resumes onto a snapshot id the caller supplied', async () => {
    const engine = new FakeEngine();
    const { service } = runnerStub();
    await new WorkflowLauncher(service, asEngine(engine)).run({
      workflowId: 'wf-1',
      principalId: 'p-1',
      snapshotId: 'wf-already-open',
    });
    expect(engine.started[0]?.runId).toBe('wf-already-open');
  });
});

describe('a graph that calls another workflow, on a pod that cannot', () => {
  /** The same stub, over a graph whose first node hands off to another workflow. */
  function callingRunner() {
    const calls: { inline: number } = { inline: 0 };
    const graph: CatalogWorkflow = {
      ...workflow,
      nodes: [
        {
          id: 'c',
          name: 'Reconcile',
          kind: 'call',
          callName: 'billing.reconcile',
          callVersion: '2',
          config: {},
        },
        { id: 'out', name: 'Sink', kind: 'sink', targetType: 'Mvr' },
      ],
      edges: [{ from: 'c', to: 'out' }],
    };
    const service: WorkflowRunnerService = Object.assign(Object.create(null), {
      requireWorkflow: async () => graph,
      attributionFor: async () => 'conn-1',
      runInline: async (input: { snapshotId: string }) => {
        calls.inline += 1;
        return finished(input.snapshotId);
      },
      findRun: async (_connectorId: string, snapshotId: string) => finished(snapshotId),
    });
    return { service, calls };
  }

  // Refused before a run row is opened. The node would refuse it too, but by
  // then the load looks like something that went wrong partway through rather
  // than like a graph this pod was never able to run.
  it('refuses the run rather than starting one that will fail at the node', async () => {
    const { service, calls } = callingRunner();

    await expect(
      new WorkflowLauncher(service).run({ workflowId: 'wf-1', principalId: 'p-1' }),
    ).rejects.toThrow(/durable child run/);

    expect(calls.inline).toBe(0);
  });

  it('names the node and the workflow it would have called', async () => {
    const { service } = callingRunner();

    await expect(
      new WorkflowLauncher(service).run({ workflowId: 'wf-1', principalId: 'p-1' }),
    ).rejects.toThrow(/"Reconcile" → billing\.reconcile@2/);
  });

  it('says why this pod cannot, in the words durability() used', async () => {
    const { service } = callingRunner();

    await expect(
      new WorkflowLauncher(service).run({ workflowId: 'wf-1', principalId: 'p-1' }),
    ).rejects.toThrow(/No durable engine resolved in this process/);
  });

  // The refusal is about the engine, not about the shape of the graph: with one
  // the same workflow starts normally.
  it('starts normally on a pod that has an engine', async () => {
    const engine = new FakeEngine();
    const { service } = callingRunner();

    await new WorkflowLauncher(service, asEngine(engine)).run({
      workflowId: 'wf-1',
      principalId: 'p-1',
    });

    expect(engine.started).toHaveLength(1);
  });
});
