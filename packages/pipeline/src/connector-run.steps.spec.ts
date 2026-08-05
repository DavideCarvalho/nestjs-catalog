import { FatalError, type RemoteTask, runStepHandler } from '@dudousxd/nestjs-durable-core';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import {
  CONNECTOR_RUN_STEP,
  type ConnectorRunStepInput,
  ConnectorRunSteps,
} from './connector-run.steps';
import { passthroughScope } from './seams';

/** See the note in `pipeline.module.integration.spec.ts`: the package cannot load here. */
vi.mock('@dudousxd/nestjs-durable', () => ({
  WorkflowEngine: class WorkflowEngine {},
  Step: () => (_target: unknown, _key: unknown, descriptor: unknown) => descriptor,
  Workflow: () => (target: unknown) => target,
}));

/**
 * Only `run` is ever reached — the step calls nothing else on the runner — so
 * the rest of `ConnectorRunnerService` is deliberately absent rather than
 * stubbed into something that could quietly answer a call this test is not
 * expecting.
 */
function steps(run: () => Promise<never>): ConnectorRunSteps {
  const runner = { run };
  return new ConnectorRunSteps(Object.assign(Object.create(null), runner), passthroughScope);
}

/** The step's own input, typed. `task.input` is `unknown` on the wire type. */
const INPUT: ConnectorRunStepInput = {
  connectorId: 'c1',
  principalId: 'p1',
  snapshotId: 'snap-1',
};

const task: RemoteTask = {
  runId: 'run-1',
  seq: 1,
  stepId: 'run-1:1',
  name: CONNECTOR_RUN_STEP,
  // Typed as the real `RemoteTask` rather than inferred from the literal. The
  // literal was missing `group` and `attempt`, which nothing noticed because
  // these files were never typechecked.
  group: 'connector-run',
  attempt: 1,
  input: INPUT,
};

/**
 * The engine's own re-admission predicate, copied from durable core rather than
 * described: `existing.error?.retryable !== false`. An absent field is
 * retryable, which is the entire defect — `FatalError` carries `message` and
 * `code` and no `retryable`, so a step that threw one was re-dispatched all
 * three times.
 */
function wouldRetry(error: { retryable?: boolean } | undefined): boolean {
  return error?.retryable !== false;
}

/**
 * Serialise the throw the way the dispatch boundary does.
 *
 * `runStepHandler` is durable core's real function, not a re-implementation:
 * the worker runs the handler through it and returns the `{message, code,
 * retryable}` envelope it produces. Asserting on the thrown *class* instead
 * would pass on the unfixed code, because `FatalError` is honoured only in the
 * engine's local retry loop and every `ctx.step` here is dispatched.
 */
function isConnectorRunInput(value: unknown): value is ConnectorRunStepInput {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    typeof Reflect.get(Object(value), 'connectorId') === 'string'
  );
}

async function dispatch(subject: ConnectorRunSteps) {
  const result = await runStepHandler(task, (input, log) => {
    // `RemoteTask.input` is `unknown` by design — a worker deserialises whatever
    // came off the wire, and the step is the thing that knows its own shape. So
    // the narrowing belongs here rather than being asserted away: this is the
    // same boundary the real worker crosses.
    if (!isConnectorRunInput(input)) throw new Error('The task carried the wrong input.');
    return subject.runConnector(input, log);
  });
  if (result.status !== 'failed') throw new Error(`Expected a failed step, got ${result.status}.`);
  return result.error;
}

describe('ConnectorRunSteps: a connector that is gone or switched off', () => {
  it('tells the engine over the wire not to try a deleted connector again', async () => {
    const error = await dispatch(
      steps(() => Promise.reject(new NotFoundException('No connector c1'))),
    );

    expect(error?.retryable).toBe(false);
    expect(wouldRetry(error)).toBe(false);
  });

  it('says the same about a disabled one', async () => {
    const error = await dispatch(
      steps(() => Promise.reject(new BadRequestException('"Nightly" is disabled.'))),
    );

    expect(wouldRetry(error)).toBe(false);
  });

  it('keeps the code and the message the operator has to read', async () => {
    const error = await dispatch(
      steps(() => Promise.reject(new NotFoundException('No connector c1'))),
    );

    expect(error?.code).toBe('connector_unavailable');
    expect(error?.message).toBe('No connector c1');
  });

  // Extending `FatalError` rather than replacing it is what keeps the *local*
  // retry loop — `err instanceof FatalError` — correct as well, so the step is
  // right whichever way the engine chose to run it.
  it('is still a FatalError, so the in-process path stops too', async () => {
    await expect(
      steps(() => Promise.reject(new NotFoundException('No connector c1'))).runConnector(INPUT),
    ).rejects.toBeInstanceOf(FatalError);
  });

  // The safer default, and the reason this is not simply `retries: 0`: a source
  // that is briefly unreachable arrives as an ordinary `Error`, and those are
  // exactly what the three attempts exist to survive.
  it('leaves an ordinary failure retryable', async () => {
    const error = await dispatch(steps(() => Promise.reject(new Error('ECONNREFUSED'))));

    expect(error?.retryable).toBeUndefined();
    expect(wouldRetry(error)).toBe(true);
  });
});
