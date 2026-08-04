import type { CatalogWorkflow, ConnectorRun } from '@dudousxd/nestjs-catalog';
import { requireEnvironmentBundle } from '@dudousxd/nestjs-catalog-store-mikro-orm';
import { WorkflowEngine } from '@dudousxd/nestjs-durable';
import { BadRequestException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { CATALOG_PIPELINE_DURABILITY_DETAIL } from './seams';
import { CATALOG_WORKFLOW_RUN, type CatalogWorkflowRunInput } from './workflow-run.workflow';
import { WorkflowRunnerService, newSnapshotId } from './workflow-runner.service';

/**
 * How long a synchronous run request waits for a durable run to finish before
 * answering with what it has.
 *
 * The console posts a run and renders the result, so *something* has to be
 * returned. Waiting forever is not it — a two-hour load would hold a socket for
 * two hours — and neither is answering immediately, because the overwhelming
 * majority of runs finish in seconds and a screen that always said "running"
 * would send everybody to the runs list to find out what happened. So: wait,
 * bounded, and answer honestly with `running` if the bound is reached. The run
 * is unaffected either way; it is durable, and the answer is a report of it.
 */
const RUN_WAIT_MS = positiveInt(process.env.CATALOG_WORKFLOW_RUN_WAIT_MS, 120_000);
const POLL_MS = 250;

/** What this pod can honestly promise about checkpointing a run. */
export interface WorkflowDurability {
  available: boolean;
  /** Named so a console can print it. Absent when nothing can checkpoint here. */
  engine?: string;
  /** Why, in a full sentence, addressed to whoever is about to press Run. */
  detail: string;
}

/**
 * Deciding how a workflow run executes, and starting it.
 *
 * Split from {@link WorkflowRunnerService} because they answer different
 * questions and have different dependencies: the runner knows how to execute a
 * graph and needs nothing but the store, while this knows whether a durable
 * engine is reachable *for this run* and needs the engine. Keeping the engine
 * out of the runner is what lets the same node code run on a pod that has no
 * engine at all.
 *
 * The rule it exists to enforce: **a run records how it actually executed**.
 * `executionMode` is a fact about the run rather than a reading of what
 * `CATALOG_DURABLE` says today, because a deployment can gain or lose its
 * engine between one run and the next, and a run list that reported the current
 * configuration would tell somebody a ten-node graph resumed at node seven when
 * it restarted from node one.
 */
@Injectable()
export class WorkflowLauncher {
  private readonly logger = new Logger(WorkflowLauncher.name);

  constructor(
    private readonly runner: WorkflowRunnerService,
    // Optional because `CATALOG_DURABLE=off` provides no engine at all, and a
    // catalog that only ever runs workflows by hand should not be made to run a
    // queue so that this constructor resolves. Absent means "inline", which is
    // a thing to say out loud rather than a reason to fail the boot.
    @Optional() private readonly engine?: WorkflowEngine,
    // What the host wants said about restartability, if it knows more than this
    // package can observe. See `CATALOG_PIPELINE_DURABILITY_DETAIL`.
    @Optional()
    @Inject(CATALOG_PIPELINE_DURABILITY_DETAIL)
    private readonly detail?: string,
  ) {}

  /**
   * Whether a run started here and now would be checkpointed per node.
   *
   * Three separate ways the answer is no, and they are kept separate because
   * each has a different fix. There is no engine at all; there is one but this
   * pod serves no handlers for it; or there is one and it belongs to a
   * different environment than the caller asked for. The last is the subtle
   * one and it is a correctness matter rather than a nicety: a worker serves
   * exactly one environment, so dispatching a run requested against `staging`
   * to a `dev` worker would load dev's data and report it under staging's
   * name. Running it inline, in the caller's own scope, is the only honest
   * answer available here.
   */
  durability(): WorkflowDurability {
    // Reported from what this package can OBSERVE — whether an engine resolved —
    // and nothing else. The application this came from decided the same question
    // from its own env (`CATALOG_DURABLE`, `APP_TYPE`, `CATALOG_ENVIRONMENT`),
    // which is host topology and cannot be read from a library without the
    // library inventing the host's deployment model.
    //
    // A host that knows more says so through `durabilityDetail`. What must not
    // happen is this reporting "checkpointed" on the strength of an engine being
    // injected somewhere that will not actually run the handlers: the console
    // renders this as a promise about restartability, and a graph built on a
    // false one is a graph nobody can restart.
    if (!this.engine) {
      return {
        available: false,
        detail:
          this.detail ??
          'No durable engine resolved in this process, so a workflow runs inline: it still commits atomically at the sink, but a failure at node seven re-runs node one.',
      };
    }
    return {
      available: true,
      detail:
        this.detail ??
        'A durable engine resolved here, so each node is checkpointed and a failed run resumes at the node that failed.',
    };
  }

  /**
   * Run a graph, the best way this pod can.
   *
   * The snapshot id is minted here and handed to the engine as the durable run
   * id, so the three identifiers a load is traced by — the durable run, the
   * snapshot it wrote, and the key its staged rows sit under — are one string.
   * That is what makes a retried run rejoin its own snapshot rather than open a
   * second one.
   */
  async run(input: {
    workflowId: string;
    connectorId?: string;
    principalId: string;
    /**
     * The identity of the load, when the caller owns it.
     *
     * Supplied by whoever is re-driving a run that failed — the same escape
     * hatch `POST /connectors/:id/run` has always had, and for the same reason:
     * a retry that opened a *new* snapshot would leave the half-written one
     * behind and load the data twice. Passing the id of a failed run resumes
     * onto its staged rows and replaces its batches rather than adding to them.
     * Omitted, one is minted, which is what a button press does.
     */
    snapshotId?: string;
  }): Promise<ConnectorRun> {
    const workflow = await this.runner.requireWorkflow(input.workflowId);
    const connectorId = input.connectorId ?? (await this.runner.attributionFor(workflow));
    const snapshotId = input.snapshotId ?? newSnapshotId('wf');
    const durability = this.durability();

    if (durability.available && this.engine) {
      return this.startDurable(workflow, connectorId, input.principalId, snapshotId);
    }

    this.logger.log(`Running "${workflow.name}" inline as ${snapshotId}: ${durability.detail}`);
    return this.runner.runInline({
      workflow,
      connectorId,
      principalId: input.principalId,
      snapshotId,
    });
  }

  private async startDurable(
    workflow: CatalogWorkflow,
    connectorId: string,
    principalId: string,
    snapshotId: string,
  ): Promise<ConnectorRun> {
    const engine = this.engine;
    if (!engine) {
      throw new BadRequestException(
        'There is no durable engine on this pod, which should have been caught before starting a run.',
      );
    }

    const payload: CatalogWorkflowRunInput = {
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      workflowName: workflow.name,
      connectorId,
      principalId,
    };

    try {
      await engine.start(CATALOG_WORKFLOW_RUN, payload, snapshotId);
    } catch (error) {
      // Deliberately **not** a fallback to inline. The reasons a start is
      // refused are that another run of this connector is already in flight
      // (the singleton mutex) or that this pod cannot route the workflow at
      // all; quietly running the graph inline instead would defeat the first
      // by loading the same type twice at once, which is the exact thing the
      // mutex exists to prevent.
      throw new BadRequestException(
        `Could not start a durable run of "${workflow.name}": ${say(error)}`,
      );
    }

    this.logger.log(`Started "${workflow.name}" as durable run ${snapshotId} for ${connectorId}.`);
    return this.awaitRun(workflow, connectorId, principalId, snapshotId);
  }

  /**
   * Wait for the run row to reach a terminal state, then report it.
   *
   * Polling the run row rather than the durable run, because the row is what
   * the answer is made of and it is written by the finish step — so a row that
   * says `succeeded` means the load committed *and* recorded itself, which is
   * a stronger statement than the engine's own "the workflow returned".
   */
  private async awaitRun(
    workflow: CatalogWorkflow,
    connectorId: string,
    principalId: string,
    snapshotId: string,
  ): Promise<ConnectorRun> {
    const deadline = Date.now() + RUN_WAIT_MS;
    let latest: ConnectorRun | undefined;
    while (Date.now() < deadline) {
      latest = await this.runner.findRun(connectorId, snapshotId);
      if (latest && latest.status !== 'running') return latest;
      await delay(POLL_MS);
    }

    if (latest) return latest;
    // The planning step has not opened the row yet — a worker that is busy, or
    // one that has not picked the run up. Reported as what it is rather than as
    // a failure: the run exists, it is durable, and it will finish without this
    // request being there to watch.
    return {
      id: snapshotId,
      connectorId,
      snapshotId,
      principalId,
      status: 'running',
      fetched: 0,
      written: 0,
      logs: [`Started as durable run ${snapshotId}; no worker has opened its run row yet.`],
      startedAt: new Date().toISOString(),
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      graphHash: workflow.graphHash,
      executionMode: 'durable',
    };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run something that may throw because configuration is absent, quietly. */
function safely(read: () => string): string | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function say(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
