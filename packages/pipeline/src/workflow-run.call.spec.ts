import type {
  CatalogPipelineStore,
  CatalogWorkflow,
  WorkflowNodeStepOutput,
} from '@dudousxd/nestjs-catalog';
import {
  type RemoteTask,
  VERSION_UNDECLARED_TAG,
  type WorkflowCtx,
  WorkflowSuspended,
  runStepHandler,
} from '@dudousxd/nestjs-durable-core';
import { describe, expect, it, vi } from 'vitest';
import { passthroughScope } from './seams';
import {
  WORKFLOW_CALL_CHECK_STEP,
  type WorkflowCallCheckInput,
  WorkflowRunSteps,
} from './workflow-run.steps';
import { type CatalogWorkflowRunInput, CatalogWorkflowRunWorkflow } from './workflow-run.workflow';
import {
  type WorkflowFinishInput,
  type WorkflowPlanResult,
  WorkflowRunnerService,
} from './workflow-runner.service';
import { toGraph } from './workflow-view';

/** See the note in `pipeline.module.integration.spec.ts`: the package cannot load here. */
vi.mock('@dudousxd/nestjs-durable', () => ({
  WorkflowEngine: class WorkflowEngine {},
  Step: () => (_target: unknown, _key: unknown, descriptor: unknown) => descriptor,
  Workflow: () => (target: unknown) => target,
}));

/**
 * A stand-in with only the members a test actually drives.
 *
 * `Object.create(null)` rather than a cast, so nothing here claims to be a
 * complete `WorkflowCtx` or a complete engine — a member this code reaches for
 * and the test did not provide is a `TypeError` naming it, which is what a
 * missing stub should look like.
 */
function stub<T>(members: Record<string, unknown>): T {
  return Object.assign(Object.create(null), members);
}

const INPUT: CatalogWorkflowRunInput = {
  workflowId: 'wf-1',
  workflowVersion: 3,
  workflowName: 'Nightly',
  connectorId: 'conn-1',
  principalId: 'p-1',
};

/** `call` → `sink`: the smallest graph that hands a step to another workflow. */
function planFor(overrides: Partial<WorkflowPlanResult> = {}): WorkflowPlanResult {
  return {
    runRowId: 'row-1',
    workflowVersion: 3,
    targetType: 'Mvr',
    order: [
      {
        nodeId: 'c',
        name: 'Reconcile',
        kind: 'call',
        inputs: [],
        call: { name: 'billing.reconcile', version: '2', config: { region: 'gov-west' } },
      },
      { nodeId: 'out', name: 'Sink', kind: 'sink', inputs: ['c'] },
    ],
    ...overrides,
  };
}

/** The exact sentence a refused start arrives as. See `isCalleeBusy`. */
const BUSY =
  'child "wf-run-1.call.c.0" failed: child workflow "billing.reconcile" failed to start: singleton queue for billing.reconcile key "ledger" is full (maxQueueDepth=1); retry later';

interface Harness {
  run(): Promise<unknown>;
  starts: Array<{ name: string; childId: string; input: unknown }>;
  joins: string[];
  checks: WorkflowCallCheckInput[];
  sleeps: number[];
  nodeInputs: Array<{ nodeId: string; inputs: unknown }>;
  /** The whole step input, for the fields `nodeInputs` deliberately does not name. */
  nodeSteps: unknown[];
  finished: WorkflowFinishInput[];
}

/**
 * The workflow body, driven with a context that resolves instead of suspending.
 *
 * A real `ctx.step`/`ctx.child` dispatches and then throws to give up the
 * thread, and the run comes back through as many turns as it has positions.
 * That machinery is durable core's and is tested there; what is tested here is
 * the body's *decisions* — which child ids it starts, when it re-checks, when
 * it waits — so the context answers immediately and records what it was asked.
 */
function harness(options: {
  plan?: WorkflowPlanResult;
  /** One entry per attempt: what the join does. A string throws; anything else resolves. */
  childResults: unknown[];
  checks?: Array<{ started: boolean; version?: string; versionDeclared?: boolean }>;
  /** The run's own input, when a test is about a field of it rather than the graph. */
  input?: CatalogWorkflowRunInput;
}): Harness {
  const starts: Harness['starts'] = [];
  const joins: string[] = [];
  const checks: WorkflowCallCheckInput[] = [];
  const sleeps: number[] = [];
  const nodeInputs: Harness['nodeInputs'] = [];
  const nodeSteps: unknown[] = [];
  const finished: WorkflowFinishInput[] = [];
  const plan = options.plan ?? planFor();
  let attempt = 0;
  let clock = 1_000;

  const steps = stub<WorkflowRunSteps>({
    plan: async () => plan,
    runNode: async (input: {
      nodeId: string;
      inputs: unknown;
    }): Promise<WorkflowNodeStepOutput> => {
      nodeInputs.push({ nodeId: input.nodeId, inputs: input.inputs });
      nodeSteps.push(input);
      return {
        nodeId: input.nodeId,
        committed: { snapshotId: 'wf-run-1', rowCount: 1_200 },
        rows: 1_200,
        elapsedMs: 5,
        logs: [],
      };
    },
    checkCall: async (input: WorkflowCallCheckInput) => {
      checks.push(input);
      return options.checks?.[checks.length - 1] ?? { started: true, version: input.callVersion };
    },
    finish: async (input: WorkflowFinishInput) => {
      finished.push(input);
      return { status: input.status };
    },
  });

  const ctx = stub<WorkflowCtx>({
    runId: 'wf-run-1',
    now: async () => {
      clock += 500;
      return clock;
    },
    step: async (ref: (input: unknown) => Promise<unknown>, input: unknown) => ref(input),
    startChild: async (name: string, input: unknown, opts: { childId: string }) => {
      starts.push({ name, childId: opts.childId, input });
      return opts.childId;
    },
    child: async (_name: string, _input: unknown, opts: { childId: string }) => {
      joins.push(opts.childId);
      const answer = options.childResults[attempt];
      attempt += 1;
      if (typeof answer === 'string') throw new Error(answer);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    sleep: async (ms: number) => {
      sleeps.push(typeof ms === 'number' ? ms : -1);
    },
  });

  const runner = new WorkflowRunnerService(stub({}), stub({}), stub({}));
  const workflow = new CatalogWorkflowRunWorkflow(steps, runner);

  return {
    run: () => workflow.run(ctx, options.input ?? INPUT),
    starts,
    joins,
    checks,
    sleeps,
    nodeInputs,
    nodeSteps,
    finished,
  };
}

describe('a call node, executed by the workflow body', () => {
  it('starts the workflow it names, with the version it pinned checked before the join', async () => {
    const test = harness({ childResults: [{ batches: 3, rowCount: 1_200 }] });

    await test.run();

    expect(test.starts).toHaveLength(1);
    expect(test.starts[0].name).toBe('billing.reconcile');
    // Started, then checked, then joined — in that order, so a wrong version is
    // stopped while the child is still getting going.
    expect(test.checks).toHaveLength(1);
    expect(test.checks[0]).toEqual({
      childRunId: 'wf-run-1.call.c.0',
      nodeId: 'c',
      nodeName: 'Reconcile',
      callName: 'billing.reconcile',
      callVersion: '2',
    });
    expect(test.joins).toEqual(['wf-run-1.call.c.0']);
  });

  it('hands the child handles and the authored parameters, never rows', async () => {
    const test = harness({ childResults: [{ batches: 1, rowCount: 10 }] });

    await test.run();

    const envelope = test.starts[0].input;
    expect(envelope).toEqual({
      catalog: {
        contract: 1,
        runId: 'wf-run-1',
        nodeId: 'c',
        workflowId: 'wf-1',
        workflowVersion: 3,
        principalId: 'p-1',
        inputs: [],
      },
      input: { region: 'gov-west' },
    });
    // The author's parameters live under their own key, so one called `runId`
    // could never shadow the run id.
    expect(Object.keys(Object(envelope))).toEqual(['catalog', 'input']);
  });

  /**
   * The one field of the run that a call node deliberately does not forward.
   *
   * `expectShrink` is an operator standing the row-count bound down for **this
   * snapshot**, and the bound is applied by the sink step — so the body hands
   * it to every node step and to no child. Forwarding it into the envelope
   * would put a one-time acknowledgement into an arbitrary workflow's `input`
   * with nothing on this side able to say what was done with it; dropping it
   * from the node steps would silently refuse the re-run the operator came
   * here to do. Both halves are asserted, because the two edits that break
   * them are one line apart.
   */
  it('hands the acknowledgement to every node step and to no callee', async () => {
    const test = harness({
      childResults: [{ batches: 1, rowCount: 10 }],
      input: { ...INPUT, expectShrink: 'the 442nd was cut from the contract in March' },
    });

    await test.run();

    expect(test.nodeSteps).toEqual([
      expect.objectContaining({
        nodeId: 'out',
        expectShrink: 'the 442nd was cut from the contract in March',
      }),
    ]);
    expect(JSON.stringify(test.starts[0].input)).not.toContain('442nd');
  });

  it('joins the child it started, rather than starting a second one', async () => {
    const test = harness({ childResults: [{ batches: 1, rowCount: 10 }] });

    await test.run();

    expect(test.joins).toEqual(test.starts.map((start) => start.childId));
  });

  it('passes what the child staged on to the next node as a handle', async () => {
    const test = harness({ childResults: [{ batches: 3, rowCount: 1_200 }] });

    await test.run();

    // The sink reads `(runId, nodeId, 1..batches)` — the same addressing every
    // other node uses, which is what lets a callee stage rows for the graph.
    expect(test.nodeInputs).toEqual([
      {
        nodeId: 'out',
        inputs: [{ runId: 'wf-run-1', nodeId: 'c', batches: 3, rowCount: 1_200 }],
      },
    ]);
    expect(test.finished[0].nodeOutcomes.c).toMatchObject({ status: 'succeeded', rows: 1_200 });
  });

  // A workflow called for its effect answers however it likes. The node reports
  // zero rows and says why, rather than failing on somebody else's return type.
  it('reports a call that returned nothing readable as zero rows, out loud', async () => {
    const test = harness({ childResults: [{ ok: true }] });

    await test.run();

    expect(test.finished[0].nodeOutcomes.c).toMatchObject({ status: 'succeeded', rows: 0 });
    expect(test.finished[0].logs.join(' ')).toContain('returned nothing this graph can read');
  });

  /**
   * The step warned on its own log; this is the other screen.
   *
   * Somebody reading a load's nodes sees `Called billing.reconcile@2` — a
   * sentence naming a version — and would otherwise have nothing telling them
   * that the version in it was assumed rather than kept.
   */
  it("says on the node's own log that nothing verified the pin", async () => {
    const test = harness({
      childResults: [{ batches: 1, rowCount: 5 }],
      checks: [{ started: true, version: '1', versionDeclared: false }],
    });

    await test.run();

    const logs = test.finished[0].logs.join(' ');
    expect(logs).toContain('Nothing verified the pin on billing.reconcile@2');
    expect(logs).toContain('version:undeclared');
    // The load itself is unaffected: an undeclared callee is called, not refused.
    expect(test.finished[0].nodeOutcomes.c).toMatchObject({ status: 'succeeded', rows: 5 });
  });

  it('says nothing of the sort when the callee declared its version', async () => {
    const test = harness({
      childResults: [{ batches: 1, rowCount: 5 }],
      checks: [{ started: true, version: '2', versionDeclared: true }],
    });

    await test.run();

    expect(test.finished[0].logs.join(' ')).not.toContain('Nothing verified the pin');
  });

  // What an in-flight run's checkpoint replays as, written before the field
  // existed. Read as "declared", so a resumed run says exactly what it said
  // when it suspended rather than growing a caveat mid-flight.
  it('invents no caveat for a check that predates the question', async () => {
    const test = harness({
      childResults: [{ batches: 1, rowCount: 5 }],
      checks: [{ started: true, version: '2' }],
    });

    await test.run();

    expect(test.finished[0].logs.join(' ')).not.toContain('Nothing verified the pin');
  });

  // The first check found no run row, so what the pin was worth is whatever the
  // re-check after the join found — the first answer knows nothing about it.
  it('takes what the pin was worth from the re-check, when there was one', async () => {
    const test = harness({
      childResults: [{ batches: 1, rowCount: 5 }],
      checks: [{ started: false }, { started: true, version: '1', versionDeclared: false }],
    });

    await test.run();

    expect(test.checks).toHaveLength(2);
    expect(test.finished[0].logs.join(' ')).toContain('Nothing verified the pin');
  });

  it('fails the node when the child answers with half a staging contract', async () => {
    const test = harness({ childResults: [{ batches: 2 }] });

    await expect(test.run()).rejects.toThrow(/cannot read what it returned/);

    expect(test.finished[0].status).toBe('failed');
    // Named: the node, the workflow and the child run, because the fault is in
    // another repository and the message is what points at it.
    expect(test.finished[0].error).toContain('Reconcile');
    expect(test.finished[0].error).toContain('billing.reconcile@2');
    expect(test.finished[0].error).toContain('wf-run-1.call.c.0');
  });

  it('fails the load when the child fails, and says which call it was', async () => {
    const test = harness({ childResults: ['child "x" failed: the ledger was locked'] });

    await expect(test.run()).rejects.toThrow(/billing\.reconcile@2 failed as child run/);

    expect(test.finished[0].status).toBe('failed');
    expect(test.finished[0].nodeOutcomes.c.status).toBe('failed');
    // Everything after it is skipped rather than left with no entry at all.
    expect(test.finished[0].nodeOutcomes.out).toEqual({ status: 'skipped', rows: 0 });
  });

  // A suspension is how a durable body gives up its thread. Catching one as a
  // failed call would record a failure for a call that has not happened yet and
  // dispatch the finish step at a position the next node will occupy.
  it('rethrows a suspension untouched instead of treating it as a failed call', async () => {
    const suspended = new WorkflowSuspended();
    const test = harness({ childResults: [suspended] });

    await expect(test.run()).rejects.toBe(suspended);

    expect(test.finished).toEqual([]);
  });

  describe('when the callee is busy', () => {
    it('waits and tries again rather than painting the load red', async () => {
      const test = harness({ childResults: [BUSY, { batches: 1, rowCount: 5 }] });

      await test.run();

      expect(test.sleeps).toEqual([30_000]);
      expect(test.finished[0].status).toBe('succeeded');
    });

    // Load-bearing rather than tidy: `ctx.child` starts a child only when no run
    // exists under the id, so reusing an id whose run had already settled would
    // park this run on a wait nothing will ever signal.
    it('gives every attempt its own child id', async () => {
      const test = harness({ childResults: [BUSY, { batches: 1, rowCount: 5 }] });

      await test.run();

      expect(test.starts.map((start) => start.childId)).toEqual([
        'wf-run-1.call.c.0',
        'wf-run-1.call.c.1',
      ]);
      expect(new Set(test.joins).size).toBe(2);
    });

    it('backs off, doubling, and gives up saying it was contention', async () => {
      const test = harness({ childResults: [BUSY, BUSY, BUSY, BUSY, BUSY] });

      await expect(test.run()).rejects.toThrow(/was busy on every one of 5 attempts/);

      expect(test.sleeps).toEqual([30_000, 60_000, 120_000, 240_000]);
      expect(test.starts).toHaveLength(5);
      // The engine's own words are kept, so "busy" is checkable rather than a
      // claim this package makes about somebody else's run.
      expect(test.finished[0].error).toContain('maxQueueDepth=1');
    });

    it('does not wait on a failure that is not contention', async () => {
      const test = harness({ childResults: ['child "x" failed: no such table'] });

      await expect(test.run()).rejects.toThrow(/no such table/);

      expect(test.sleeps).toEqual([]);
      expect(test.starts).toHaveLength(1);
    });
  });

  // The row is created on a microtask by the engine that ran the body, so an
  // absent one all but means the start was refused — which only the join can
  // explain. When the child turns out to have started after all, the version
  // still has to be checked before this run uses what it produced.
  it('checks again after the join when the run row had not appeared yet', async () => {
    const test = harness({
      childResults: [{ batches: 1, rowCount: 5 }],
      checks: [{ started: false }, { started: true, version: '2' }],
    });

    await test.run();

    expect(test.checks).toHaveLength(2);
    expect(test.checks[1].childRunId).toBe('wf-run-1.call.c.0');
  });

  it('does not check twice when the first check saw the run', async () => {
    const test = harness({ childResults: [{ batches: 1, rowCount: 5 }] });

    await test.run();

    expect(test.checks).toHaveLength(1);
  });
});

/* --- the pin itself ---------------------------------------------------- */

const CHECK: WorkflowCallCheckInput = {
  childRunId: 'wf-run-1.call.c.0',
  nodeId: 'c',
  nodeName: 'Reconcile',
  callName: 'billing.reconcile',
  callVersion: '2',
};

function checkSteps(engine: Record<string, unknown> | undefined): WorkflowRunSteps {
  return new WorkflowRunSteps(
    stub({}),
    passthroughScope,
    engine === undefined ? undefined : stub(engine),
  );
}

/**
 * Serialised the way the dispatch boundary does it.
 *
 * The engine reads `retryable !== false` off the returned envelope and nothing
 * else — a `FatalError`'s class is honoured only in the local retry loop, and
 * every step here is dispatched. Asserting on the thrown class would pass on a
 * refusal the engine would go on to retry three times.
 */
async function dispatchCheck(subject: WorkflowRunSteps) {
  const task: RemoteTask = {
    runId: 'wf-run-1',
    seq: 4,
    stepId: 'wf-run-1:4',
    name: WORKFLOW_CALL_CHECK_STEP,
    group: 'catalog',
    attempt: 1,
    input: CHECK,
  };
  return runStepHandler(task, (input) => subject.checkCall(stub(Object(input))));
}

describe('checking that the child is the version the node pinned', () => {
  it('accepts the child when the started version is the pinned one', async () => {
    const steps = checkSteps({
      getRun: async () => ({ id: CHECK.childRunId, workflowVersion: '2' }),
    });

    expect(await steps.checkCall(CHECK)).toEqual({
      started: true,
      version: '2',
      versionDeclared: true,
    });
  });

  // The engine starts the newest registered version and takes no version
  // argument, so this is where a pin is actually kept: observe, cancel, refuse.
  it('cancels the child and refuses the load when a different version started', async () => {
    const cancelled: string[] = [];
    const steps = checkSteps({
      getRun: async () => ({ id: CHECK.childRunId, workflowVersion: '3' }),
      cancel: async (runId: string) => {
        cancelled.push(runId);
      },
    });

    await expect(steps.checkCall(CHECK)).rejects.toThrow(/pins billing\.reconcile@2/);
    expect(cancelled).toEqual([CHECK.childRunId]);
  });

  it('names both versions and the child run, so the mismatch is checkable', async () => {
    const steps = checkSteps({
      getRun: async () => ({ id: CHECK.childRunId, workflowVersion: '3' }),
      cancel: async () => undefined,
    });

    await expect(steps.checkCall(CHECK)).rejects.toThrow(
      /started billing\.reconcile@3 as child run wf-run-1\.call\.c\.0/,
    );
  });

  it('still refuses when the wrong-version child could not be cancelled', async () => {
    const steps = checkSteps({
      getRun: async () => ({ id: CHECK.childRunId, workflowVersion: '3' }),
      cancel: async () => {
        throw new Error('no store on this instance');
      },
    });

    await expect(steps.checkCall(CHECK)).rejects.toThrow(/may still be running/);
  });

  it('tells the engine not to retry a version mismatch', async () => {
    const steps = checkSteps({
      getRun: async () => ({ id: CHECK.childRunId, workflowVersion: '3' }),
      cancel: async () => undefined,
    });

    const result = await dispatchCheck(steps);

    // `retryable !== false` is the engine's own re-admission predicate. Waiting
    // three minutes does not make a deployment register another version.
    expect(result.error?.retryable).toBe(false);
  });

  it('reports a run row that is not there rather than guessing why', async () => {
    const steps = checkSteps({ getRun: async () => null });

    expect(await steps.checkCall(CHECK)).toEqual({ started: false });
  });

  // "Unchecked" and "checked and fine" must not read the same, so the one step
  // in this package that cannot do its job says so instead of waving it through.
  it('refuses when the process running it has no engine to check against', async () => {
    await expect(checkSteps(undefined).checkCall(CHECK)).rejects.toThrow(
      /no durable engine it can read a run from/,
    );
  });

  // A thin/tenant worker gets a start-only facade under the same DI token: it
  // has no `getRun` and its `cancel` throws. Calling it would be a TypeError
  // inside a step, which reads as a bug here rather than as a deployment fact.
  it('refuses a start-only engine facade the same way', async () => {
    await expect(checkSteps({ start: async () => undefined }).checkCall(CHECK)).rejects.toThrow(
      /no durable engine it can read a run from/,
    );
  });
});

/* --- a callee nobody declared a version for ----------------------------- */

/**
 * The run row a convention-resolved remote produces when the fleet says nothing.
 *
 * `workflowVersion: '1'` is the engine's routing default rather than an
 * observation, and `version:undeclared` is what durable core 0.66.0 stamps to
 * say so. Both together, because a test that set only one of them would be
 * testing a row the engine cannot produce.
 */
function undeclaredRun(version = '1') {
  return {
    id: CHECK.childRunId,
    workflowVersion: version,
    tags: [VERSION_UNDECLARED_TAG],
  };
}

describe('a pin against a callee whose version nobody declared', () => {
  // The defect this whole change is about: `'1' === '1'` was reported as a
  // version that had been checked, when the `'1'` on both sides was a
  // placeholder the engine wrote before anybody was asked.
  it('does not report a match it did not make when the placeholder equals the pin', async () => {
    const steps = checkSteps({ getRun: async () => undeclaredRun() });

    expect(await steps.checkCall({ ...CHECK, callVersion: '1' })).toEqual({
      started: true,
      version: '1',
      versionDeclared: false,
    });
  });

  // The same defect wearing the other face. Refusing here would be acting on
  // the same placeholder, and would make every callee on an older SDK
  // uncallable with any pin but `1` — remediable only by changing the callee,
  // which is the rule durable rejected one layer down.
  it('does not refuse on the placeholder either, whatever the pin says', async () => {
    const cancelled: string[] = [];
    const steps = checkSteps({
      getRun: async () => undeclaredRun(),
      cancel: async (runId: string) => {
        cancelled.push(runId);
      },
    });

    expect(await steps.checkCall({ ...CHECK, callVersion: '7' })).toEqual({
      started: true,
      version: '1',
      versionDeclared: false,
    });
    expect(cancelled).toEqual([]);
  });

  it('says so on the step log, where the engine records what a step did', async () => {
    const warnings: string[] = [];
    const steps = checkSteps({ getRun: async () => undeclaredRun() });

    await steps.checkCall(CHECK, stub({ warn: (line: string) => warnings.push(line) }));

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/nothing checked it/);
    expect(warnings[0]).toMatch(/version:undeclared/);
  });

  it('takes no log line at all rather than failing when the step has no logger', async () => {
    const steps = checkSteps({ getRun: async () => undeclaredRun() });

    expect(await steps.checkCall(CHECK)).toEqual({
      started: true,
      version: '1',
      versionDeclared: false,
    });
  });

  // The tag is the whole of the signal. A callee that DOES declare a version is
  // the case durable just made work, and nothing here may soften it.
  it('still keeps the pin against a callee that declares a version', async () => {
    const cancelled: string[] = [];
    const steps = checkSteps({
      getRun: async () => ({ id: CHECK.childRunId, workflowVersion: '3', tags: ['nightly'] }),
      cancel: async (runId: string) => {
        cancelled.push(runId);
      },
    });

    await expect(steps.checkCall(CHECK)).rejects.toThrow(/pins billing\.reconcile@2/);
    expect(cancelled).toEqual([CHECK.childRunId]);
  });

  // The row crosses a wire and a store. A `tags` that arrived as something else
  // reads as "no tag" — the check it would otherwise skip is the check that
  // keeps a pin — rather than throwing inside a step.
  it('reads a tags field that is not an array as carrying no tag', async () => {
    const steps = checkSteps({
      getRun: async () => ({ id: CHECK.childRunId, workflowVersion: '2', tags: 'nightly' }),
    });

    expect(await steps.checkCall(CHECK)).toEqual({
      started: true,
      version: '2',
      versionDeclared: true,
    });
  });
});

/* --- the plan, and the boundary a graph arrives over --------------------- */

/**
 * A store with the members `plan` reaches for and nothing else.
 *
 * The capability probes are what `requireStore` narrows on — a store may
 * legitimately not hold workflows at all — so they have to be present as
 * functions for the runner to accept it. `supportsWorkflows` asks for each by
 * name rather than inferring the set from one of them, so a probe added there
 * is a probe that has to appear here; `saveWorkflowSchedule` arrived that way,
 * once a schedule became something authored on the graph.
 *
 * `listRuns` answers empty, which is the state that matters for these tests
 * rather than an omission: `plan` now scans a connector's recent runs on its
 * way in — to close attempts abandoned at this snapshot and to sweep stale
 * stages — and an empty list is "there was nothing before this run", so neither
 * housekeeping rule has anything to say and the plan under test is the plan.
 */
function storeHolding(workflow: CatalogWorkflow): CatalogPipelineStore {
  return stub({
    listWorkflows: async () => [workflow],
    getWorkflow: async () => workflow,
    saveWorkflow: async () => workflow,
    publishWorkflow: async () => workflow,
    saveWorkflowSchedule: async () => workflow,
    writeStage: async () => undefined,
    readStage: async () => [],
    listRuns: async () => [],
    startRun: async (input: { snapshotId: string }) => ({
      id: 'row-1',
      connectorId: 'conn-1',
      snapshotId: input.snapshotId,
      principalId: 'p-1',
      status: 'running',
      fetched: 0,
      written: 0,
      logs: [],
      startedAt: '2026-01-01T00:00:00.000Z',
    }),
  });
}

const CALLING_GRAPH: CatalogWorkflow = {
  id: 'wf-1',
  name: 'Nightly',
  status: 'ready',
  version: 3,
  graphHash: 'hash-1',
  targetType: 'Mvr',
  enabled: true,
  createdBy: 'someone',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  nodes: [
    {
      id: 'c',
      name: 'Reconcile',
      kind: 'call',
      callName: 'billing.reconcile',
      callVersion: '2',
      config: { region: 'gov-west' },
    },
    { id: 'out', name: 'Sink', kind: 'sink', targetType: 'Mvr' },
  ],
  edges: [{ from: 'c', to: 'out' }],
};

describe('the plan a call node is executed from', () => {
  // The body must not read a database — a read there answers differently on
  // replay — so everything a call needs travels on the plan, which is a
  // checkpoint. Without this the body would dispatch the node as an ordinary
  // step, and it would refuse for want of an engine to start a child with.
  it('carries the workflow, the version and the parameters the node named', async () => {
    const runner = new WorkflowRunnerService(storeHolding(CALLING_GRAPH), stub({}), stub({}));

    const plan = await runner.plan({
      workflowId: 'wf-1',
      workflowVersion: 3,
      snapshotId: 'wf-run-1',
      connectorId: 'conn-1',
      principalId: 'p-1',
      mode: 'durable',
    });

    expect(plan.order[0]).toEqual({
      nodeId: 'c',
      name: 'Reconcile',
      kind: 'call',
      inputs: [],
      // Empty, and asserted rather than left off: this is what says the node's
      // inbound wires carry no branch label, which is what makes it run
      // unconditionally. A plan that lost this map would make every node with a
      // labelled inbound wire look unconditional too.
      inputBranches: {},
      // The mode is resolved here rather than in the body, so a graph repointed
      // between two nodes cannot change what a half-finished run puts on the
      // wire. Spelled out even when it is the default, because a checkpoint is
      // read by people as well as by the replay.
      call: {
        name: 'billing.reconcile',
        version: '2',
        config: { region: 'gov-west' },
        mode: 'envelope',
      },
    });
  });

  it('leaves every other kind of node without a call target', async () => {
    const runner = new WorkflowRunnerService(storeHolding(CALLING_GRAPH), stub({}), stub({}));

    const plan = await runner.plan({
      workflowId: 'wf-1',
      workflowVersion: 3,
      snapshotId: 'wf-run-1',
      connectorId: 'conn-1',
      principalId: 'p-1',
      mode: 'durable',
    });

    expect(plan.order[1].call).toBeUndefined();
  });
});

describe('a call node arriving over HTTP', () => {
  function canvasCall(overrides: Record<string, unknown> = {}) {
    return {
      name: 'Fleet',
      nodes: [
        {
          id: 'c',
          label: 'Reconcile',
          kind: 'call',
          callName: 'billing.reconcile',
          callVersion: '2',
          config: { region: 'gov-west' },
          ...overrides,
        },
        { id: 'out', label: 'Sink', kind: 'sink', targetType: 'Mvr' },
      ],
      edges: [{ from: 'c', to: 'out' }],
    };
  }

  it('is stored with both halves of what it calls', () => {
    const graph = toGraph(canvasCall());

    expect(graph.nodes[0]).toMatchObject({
      id: 'c',
      name: 'Reconcile',
      kind: 'call',
      callName: 'billing.reconcile',
      callVersion: '2',
      config: { region: 'gov-west' },
    });
  });

  // Refused at the boundary rather than left to `validateWorkflow`, which a
  // draft is stored without running: a call node saved with an empty version
  // would run whichever version is registered on the day it is published.
  it('is refused when it names a workflow but no version', () => {
    expect(() => toGraph(canvasCall({ callVersion: '' }))).toThrow(
      /no version of the workflow it calls/,
    );
  });

  it('is refused when it names no workflow at all', () => {
    expect(() => toGraph(canvasCall({ callName: undefined }))).toThrow(/no workflow to call/);
  });
});

/**
 * The other wire format: the config, on its own, to a workflow that has never
 * heard of this catalog.
 *
 * The plans below wire the plain call to nothing, because that is the only
 * shape `validateWorkflow` will store — a plain call is told no run id, so it
 * has no key to stage rows under and nothing may read from it. See
 * `WORKFLOW_CALL_MODES`.
 */
describe('a plain call node, executed by the workflow body', () => {
  function plainPlan(overrides: Partial<WorkflowPlanResult> = {}): WorkflowPlanResult {
    return {
      runRowId: 'row-1',
      workflowVersion: 3,
      targetType: 'Mvr',
      order: [
        {
          nodeId: 'c',
          name: 'Run processing',
          kind: 'call',
          inputs: [],
          call: {
            name: 'processing',
            version: '1',
            config: { proc: 'mvr', base_id: 7, context: { tenant: 'usaf' } },
            mode: 'plain',
          },
        },
        { nodeId: 'out', name: 'Sink', kind: 'sink', inputs: [] },
      ],
      ...overrides,
    };
  }

  // The whole feature, in one assertion: the workflow receives exactly the keys
  // its author wrote and nothing of this catalog's. `data["proc"]` resolves.
  it('hands the child the parameters verbatim, with no envelope around them', async () => {
    const test = harness({ plan: plainPlan(), childResults: [{ context: { merged: true } }] });

    await test.run();

    expect(test.starts[0].input).toEqual({
      proc: 'mvr',
      base_id: 7,
      context: { tenant: 'usaf' },
    });
    // No `catalog` key, so nothing the catalog knows crosses — which is exactly
    // why an author's `runId` parameter has nothing here to shadow.
    expect(Object.keys(Object(test.starts[0].input))).toEqual(['proc', 'base_id', 'context']);
  });

  it('reports zero rows and says why, whatever the child returned', async () => {
    const test = harness({ plan: plainPlan(), childResults: [{ context: { merged: true } }] });

    await test.run();

    expect(test.finished[0].nodeOutcomes.c).toMatchObject({ status: 'succeeded', rows: 0 });
    const logs = test.finished[0].logs.join(' ');
    expect(logs).toContain('as a plain call');
    expect(logs).toContain('wf-run-1.call.c.0');
    expect(logs).toContain('nowhere to stage rows');
  });

  // On both modes, because the pin is a property of the call rather than of
  // what came back — and plain is, in practice, how a cross-SDK callee (the one
  // most likely to announce no version at all) is reached.
  it('says nothing verified the pin here too', async () => {
    const test = harness({
      plan: plainPlan(),
      childResults: [{ ok: true }],
      checks: [{ started: true, version: '1', versionDeclared: false }],
    });

    await test.run();

    expect(test.finished[0].logs.join(' ')).toContain('Nothing verified the pin');
  });

  /**
   * The decision this mode turns on, asserted rather than described.
   *
   * A callee that answers `{batches, rowCount}` meaning something of its own
   * would, if that answer were read, send this graph off to read a stage that
   * cannot exist — the callee was told no run id and no node id, so it could
   * not have written one. So the answer is not read at all.
   */
  it('does not read a staging contract out of a plain call, even a complete one', async () => {
    const test = harness({ plan: plainPlan(), childResults: [{ batches: 3, rowCount: 1_200 }] });

    await test.run();

    expect(test.finished[0].nodeOutcomes.c).toMatchObject({ status: 'succeeded', rows: 0 });
    expect(test.finished[0].fetched).toBe(0);
  });

  it('does not fail a plain call over half a staging contract either', async () => {
    // `{batches: 2}` fails an envelope call, and must not fail this one: it is
    // a shape this graph never asked for and has no standing to judge.
    const test = harness({ plan: plainPlan(), childResults: [{ batches: 2 }] });

    await test.run();

    expect(test.finished[0].status).toBe('succeeded');
    expect(test.finished[0].nodeOutcomes.c).toMatchObject({ status: 'succeeded', rows: 0 });
  });

  it('still checks the version pin before joining', async () => {
    // The pin is orthogonal to the payload, and dropping it here would be a
    // silent second change riding along with this one.
    const test = harness({ plan: plainPlan(), childResults: [{}] });

    await test.run();

    expect(test.checks).toEqual([
      {
        childRunId: 'wf-run-1.call.c.0',
        nodeId: 'c',
        nodeName: 'Run processing',
        callName: 'processing',
        callVersion: '1',
      },
    ]);
  });

  it('still fails the load when the child fails', async () => {
    const test = harness({
      plan: plainPlan(),
      childResults: ['child "x" failed: KeyError: proc'],
    });

    await expect(test.run()).rejects.toThrow(/processing@1 failed as child run/);
    expect(test.finished[0].status).toBe('failed');
  });

  // Backward compatibility, at the one place it is decided. A plan checkpointed
  // before this field existed replays with no `mode`, and must build exactly the
  // payload it built the first time.
  it('sends the envelope for a plan entry that names no mode', async () => {
    const test = harness({ childResults: [{ batches: 1, rowCount: 10 }] });

    await test.run();

    expect(Object.keys(Object(test.starts[0].input))).toEqual(['catalog', 'input']);
  });

  it('sends the envelope for a plan entry that names it explicitly', async () => {
    const plan = planFor();
    const entry = plan.order[0];
    if (entry.call) entry.call.mode = 'envelope';
    const test = harness({ plan, childResults: [{ batches: 1, rowCount: 10 }] });

    await test.run();

    expect(Object.keys(Object(test.starts[0].input))).toEqual(['catalog', 'input']);
  });
});

/** The mode, across the boundary the canvas posts a graph through. */
describe('a call node arriving from the canvas', () => {
  function canvasNode(overrides: Record<string, unknown> = {}) {
    return {
      nodes: [
        {
          id: 'c',
          label: 'Run processing',
          kind: 'call',
          callName: 'processing',
          callVersion: '1',
          config: { proc: 'mvr' },
          ...overrides,
        },
        { id: 'out', label: 'Sink', kind: 'sink', targetType: 'Mvr' },
      ],
      edges: [],
    };
  }

  it('keeps a plain call plain', () => {
    expect(toGraph(canvasNode({ callMode: 'plain' })).nodes[0]).toMatchObject({
      kind: 'call',
      callMode: 'plain',
    });
  });

  // Stored with no key at all rather than with an explicit default, which is
  // what keeps `workflowGraphHash` still for every graph already in a database.
  it('stores no mode at all when the canvas sent none', () => {
    expect(toGraph(canvasNode()).nodes[0]).not.toHaveProperty('callMode');
    expect(toGraph(canvasNode({ callMode: null })).nodes[0]).not.toHaveProperty('callMode');
  });

  // Refused at the boundary rather than defaulted, for the reason a bad version
  // pin is: reading an unknown mode as the envelope would wrap a config that
  // was authored to travel bare, and the callee would die on its first key.
  it('is refused when it names a mode this build cannot send', () => {
    expect(() => toGraph(canvasNode({ callMode: 'flat' }))).toThrow(/callMode of "flat"/);
  });
});
