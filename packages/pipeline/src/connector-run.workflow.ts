import { Workflow } from '@dudousxd/nestjs-durable';
import type { WorkflowCtx } from '@dudousxd/nestjs-durable-core';
import { Injectable } from '@nestjs/common';
import { type ConnectorRunStepOutput, ConnectorRunSteps } from './connector-run.steps';

/**
 * The workflow name, on the wire.
 *
 * The scheduler starts runs by name (that is the only form a
 * {@link import("@dudousxd/nestjs-durable-core").ScheduledWorkflow} takes), and
 * in `attach` mode the control plane that creates the run is a different
 * process that only ever sees this string. One exported constant so the two
 * ends cannot drift.
 */
export const CONNECTOR_RUN_WORKFLOW = 'catalog.connector-run';

export interface ConnectorRunInput {
  connectorId: string;
  /** Carried purely so a run list reads as names rather than as UUIDs. */
  connectorName: string;
  principalId: string;
}

/**
 * How long a single connector run may take before the engine gives up on it.
 *
 * A backstop for the mutex below, not a performance knob: a run wedged forever
 * on a socket that never closes holds its connector's singleton slot forever,
 * and the visible symptom is a connector that quietly stops being scheduled.
 * Better to cancel it and let the next window try.
 */
const EXECUTION_TIMEOUT = process.env.CATALOG_CONNECTOR_RUN_TIMEOUT ?? '2h';

/**
 * One scheduled connector run.
 *
 * The body is one line on purpose. Everything that could fail lives in the
 * step, and everything that decides *when* lives in the scheduler — a workflow
 * that also fetched, or also looked at the clock, would be a third place with
 * an opinion about when a load happens.
 *
 * `singleton` is the part that matters most, and it is the answer to "what
 * stops two workers running one connector twice": the engine serializes runs
 * sharing a key, so window N+1 waits (suspended, costing nothing) while window
 * N is still going instead of racing it into the same target type. Note the
 * limit of this — it is enforced by the engine that *owns* the run, so it holds
 * in `own` mode and does not hold in `attach`, where the control plane resolves
 * this workflow by convention and a convention-resolved registration carries
 * none of this metadata. See the note in the scheduler.
 *
 * `maxQueueDepth: 1` is the other half. A connector that reliably takes longer
 * than its own cron period would otherwise queue one waiting run per window,
 * for as long as that stays true — a backlog nobody asked for, of loads whose
 * data is stale by the time they run. One may wait; the rest are refused at
 * `start`, which the scheduler logs. A connector that cannot keep up with its
 * schedule has the wrong schedule, and that should be visible rather than
 * absorbed.
 */
@Workflow({
  name: CONNECTOR_RUN_WORKFLOW,
  version: '1',
  tags: ['catalog', 'connector'],
  singleton: { key: connectorMutexKey, maxQueueDepth: 1 },
  executionTimeout: EXECUTION_TIMEOUT,
})
@Injectable()
export class ConnectorRunWorkflow {
  constructor(private readonly steps: ConnectorRunSteps) {}

  async run(ctx: WorkflowCtx, input: ConnectorRunInput): Promise<ConnectorRunStepOutput> {
    return ctx.step(this.steps.runConnector, {
      connectorId: input.connectorId,
      principalId: input.principalId,
      // The durable run id *is* the snapshot id, which is the whole reason a
      // retried run replaces its batches instead of loading the data twice.
      // Deterministic across replay by definition — it is this run's identity —
      // so a recovered run rejoins the snapshot it had already started.
      snapshotId: ctx.runId,
    });
  }
}

/**
 * The mutex key, derived from the input the engine hands back as `unknown`.
 *
 * It throws rather than falling back. A key that quietly degraded to a constant
 * would serialize every connector in the deployment behind one another, and the
 * symptom — loads mysteriously taking turns — names nothing that would lead
 * anybody here.
 */
function connectorMutexKey(input: unknown): string {
  if (input !== null && typeof input === 'object') {
    const connectorId = Reflect.get(input, 'connectorId');
    if (typeof connectorId === 'string' && connectorId.length > 0) {
      return `catalog.connector:${connectorId}`;
    }
  }
  throw new Error(
    `${CONNECTOR_RUN_WORKFLOW} was started without a connectorId. There is no connector to serialize on, so this run has no honest mutex key.`,
  );
}
