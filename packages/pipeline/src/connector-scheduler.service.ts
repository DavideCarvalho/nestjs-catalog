import {
  CATALOG_PIPELINE_STORE,
  type CatalogConnector,
  type CatalogPipelineStore,
  type CatalogWorkflow,
  supportsWorkflows,
} from '@dudousxd/nestjs-catalog';
import { WorkflowEngine } from '@dudousxd/nestjs-durable';
import {
  type ScheduledWorkflow,
  prevCronFireMs,
  runSchedules,
} from '@dudousxd/nestjs-durable-core';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import { CONNECTOR_RUN_WORKFLOW, type ConnectorRunInput } from './connector-run.workflow';
import { CATALOG_PIPELINE_SCOPE, type CatalogPipelineScope, passthroughScope } from './seams';
import { CATALOG_WORKFLOW_RUN, type CatalogWorkflowRunInput } from './workflow-run.workflow';

/**
 * Who a scheduled load is attributed to.
 *
 * Not the connector's author: they wrote the connector, they did not run it,
 * and a snapshot that names them is a snapshot that answers "who can be asked
 * about this data?" with the wrong person. Not a real principal either — this
 * path is already past authorisation — so a name that reads correctly in the
 * runs list and in `catalog_snapshot.principal_id` is the honest answer.
 */
const SCHEDULER_PRINCIPAL = 'scheduler';

/**
 * Half a minute, because the finest granularity a five-field cron can express
 * is a minute: polling at half the shortest expressible period is what makes
 * "every minute" mean every minute rather than most of them. A six-field cron
 * (leading seconds) needs this lowered to match, and nothing here can detect
 * that for you.
 */
const DEFAULT_POLL_MS = 30_000;

/**
 * Whether this process should run the loop.
 *
 * A decision for the host, not for this package: it depends on how the host
 * splits its roles. A host with separate API and worker processes runs it on
 * single-process deployment wants it always on. Default on, because a host that
 * mounts the scheduler at all has said it wants schedules to fire.
 *
 * Starting a run from the "wrong" process would be correct anyway — the run id
 * is derived from the cron fire time and `engine.start` is idempotent, so a
 * duplicate start is a no-op. This is about load, not safety.
 */
export const CATALOG_SCHEDULER_ENABLED = Symbol('CATALOG_SCHEDULER_ENABLED');

/**
 * The thing that was missing: something that reads `connector.schedule`.
 *
 * The design decision worth stating is that this holds **no schedule state of
 * its own**. Every tick reloads every connector from the store and rebuilds the
 * schedule list from scratch, so an edit in the console — a changed cron, a
 * cleared one, a connector disabled or deleted — takes effect within one poll
 * interval, with no restart, no cache to invalidate and no registration to
 * withdraw. A scheduler that registered schedules at boot would be a second
 * copy of a database column, and the two would disagree the first time somebody
 * edited one.
 *
 * Starting a run is `runSchedules` from durable core, unchanged. It derives the
 * run id from the schedule key and the cron's fire time
 * (`sched:connector:<id>:<fireMs>`), and `engine.start` is idempotent by run id
 * — so every tick of every replica racing on the same window starts that window
 * **exactly once**. That is the guarantee that stops two workers double-loading
 * a connector, and it is a property of the store, not of this loop.
 *
 * What it does *not* stop is window N+1 starting while window N is still
 * running. `runSchedules`' own `overlap: 'skip'` only applies to fixed-interval
 * schedules, so for cron the guard is the workflow's `singleton` mutex — which
 * the engine enforces in `own` mode and, because a control plane resolves a
 * foreign workflow by convention and a convention-resolved registration carries
 * no singleton config, does **not** enforce in `attach` mode. An `attach`
 * deployment whose connectors can outrun their own schedule needs a cron with
 * enough headroom.
 */
@Injectable()
export class ConnectorScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ConnectorScheduler.name);
  private readonly pollMs = positiveInt(process.env.CATALOG_SCHEDULE_POLL_MS, DEFAULT_POLL_MS);
  private readonly timezone = process.env.CATALOG_SCHEDULE_TZ ?? 'UTC';

  private timer?: NodeJS.Timeout;
  private ticking = false;
  /** Last thing said about each connector, so a persistent fault is said once. */
  private readonly complaints = new Map<string, string>();
  /** Last window started per connector, so an idempotent re-start stays quiet. */
  private readonly started = new Map<string, string>();
  /** Fingerprint of the scheduled set, so a boot log is not repeated forever. */
  private announced?: string;

  constructor(
    @Inject(CATALOG_PIPELINE_STORE)
    private readonly pipeline: CatalogPipelineStore,
    // Optional because a host may mount this without a durable engine at all.
    // `WorkflowEngine` in both roles, so in practice this always resolves.
    // Kept optional because "no engine" is a state worth reporting rather than
    // a reason to fail the boot — and because the extracted service, which has
    // a real `CATALOG_DURABLE=off`, must not need this constructor changed back.
    @Optional() private readonly engine?: WorkflowEngine,
    @Optional()
    @Inject(CATALOG_SCHEDULER_ENABLED)
    private readonly enabled: boolean = true,
    // A timer callback carries no ambient scope, exactly like a durable step.
    // Every read this loop makes goes through it.
    @Optional()
    @Inject(CATALOG_PIPELINE_SCOPE)
    private readonly scope: CatalogPipelineScope = passthroughScope,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.engine) {
      void this.scope.run(() => this.reportUnschedulable());
      return;
    }

    // Only where the work is actually run. `CatalogServiceModule` is mounted on
    // every pod (its store and registry are needed everywhere), so without this
    // every API replica would also poll the store every 30s. Starting a run
    // from an API pod would be *correct* — `engine.start` is enqueue-only there
    // and the deterministic run id makes a duplicate start a no-op — so this is
    // about load, not about safety, and it is the same axis `WorkerModule`
    // already loads on.
    if (!this.enabled) {
      this.logger.log('This process is configured not to run connector schedules.');
      return;
    }

    this.probeCron();

    // Deliberately not `unref`'d. With `APP_TYPE=WORKER` the process calls
    // `app.init()` and returns without listening on a port, so an unref'd timer
    // would let Node decide there was nothing left to do and exit a pod whose
    // entire job is this loop.
    this.timer = setInterval(() => void this.scope.run(() => this.tick()), this.pollMs);
    this.logger.log(
      `Watching connector schedules every ${this.pollMs}ms, cron evaluated in ${this.timezone}.`,
    );
    void this.scope.run(() => this.tick());
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * One pass over every connector.
   *
   * Guarded against re-entry rather than against slowness: a tick that outlives
   * its interval means the store is struggling, and stacking a second read on
   * top of the first is the wrong way to find that out.
   */
  private async tick(): Promise<void> {
    const engine = this.engine;
    if (!engine || this.ticking) return;
    this.ticking = true;
    try {
      const now = Date.now();
      const connectors = await this.pipeline.listConnectors();
      const scheduled = connectors.filter(isScheduled);
      this.announce(scheduled);
      // One `runSchedules` call per connector, not one for all of them: the
      // library's loop is sequential and awaits each start, so a single
      // connector whose start throws would silently swallow every connector
      // after it — and `listConnectors` orders by name, so it would be the same
      // ones every time.
      for (const connector of scheduled) {
        await this.fire(engine, connector, now);
      }
    } catch (error) {
      this.logger.warn(`Could not read connectors this tick: ${say(error)}`);
    } finally {
      this.ticking = false;
    }
  }

  private async fire(
    engine: WorkflowEngine,
    connector: CatalogConnector,
    now: number,
  ): Promise<void> {
    const cron = (connector.schedule ?? '').trim();

    let fireMs: number;
    try {
      fireMs = prevCronFireMs(cron, now, this.timezone);
    } catch (error) {
      // A schedule nobody can parse is the author's to fix, and naming the
      // connector and the expression is the only useful thing to say about it.
      // It must not take the other connectors down with it.
      this.complain(
        `${connector.id}:cron`,
        `"${connector.name}" has a schedule this service cannot read ("${cron}"): ${say(error)}`,
      );
      return;
    }
    // Only the parse complaint. Clearing every complaint here would clear the
    // start-failure one below on the next tick and then log it again, turning a
    // deduplicated warning back into one per tick.
    this.forgive(`${connector.id}:cron`);

    // The current cron window is whatever fired most recently, which for a
    // daily schedule can be twenty hours ago. Firing it is right when a worker
    // was down through it — that is catch-up, and for a catalog catch-up is
    // what you want. It is wrong when the schedule did not exist yet: a
    // connector saved at 23:00 with `0 3 * * *` would load immediately, and so
    // would one whose cron was just edited.
    //
    // `updatedAt` separates the two, because the store bumps it on every edit
    // *and* on every run's start and finish. So a window older than the last
    // thing that happened to this connector has either already run or predates
    // the schedule that names it; a window newer than that is genuinely due.
    // This is a filter, not the guarantee — the guarantee is the deterministic
    // run id below, which is what makes a redundant start a no-op.
    const changedAt = Date.parse(connector.updatedAt);
    if (Number.isFinite(changedAt) && fireMs <= changedAt) return;

    // Which durable workflow this connector's window runs, decided by what the
    // connector delegates to and by nothing else. A connector with a
    // `workflowId` gets the per-node workflow, so a scheduled graph is
    // checkpointed node by node; one with a `transformId` gets the single step
    // it has always had. The store refuses a connector that sets both, so this
    // is a choice between two and never a guess.
    const graph = connector.workflowId ? await this.resolveGraph(connector) : undefined;
    if (connector.workflowId && !graph) return;

    const schedule: ScheduledWorkflow = {
      // The key is half the run id, so it must identify the connector and
      // nothing about it that can change. The id, therefore, not the name.
      // Deliberately the same key for both workflows: the run id derived from
      // it is the snapshot id, and a connector that was switched from a
      // transform to a graph must not be able to start two runs for one window.
      key: `connector:${connector.id}`,
      workflow: graph ? CATALOG_WORKFLOW_RUN : CONNECTOR_RUN_WORKFLOW,
      input: graph
        ? ({
            workflowId: graph.id,
            workflowVersion: graph.version,
            workflowName: graph.name,
            connectorId: connector.id,
            principalId: SCHEDULER_PRINCIPAL,
          } satisfies CatalogWorkflowRunInput)
        : ({
            connectorId: connector.id,
            connectorName: connector.name,
            principalId: SCHEDULER_PRINCIPAL,
          } satisfies ConnectorRunInput),
      cron,
      timezone: this.timezone,
    };

    try {
      // Same `now` the window was computed from: `runSchedules` recomputes the
      // fire time to build the run id, and a clock that moved between the two
      // would key the run on a window this tick never checked.
      const runId = (await runSchedules(engine, [schedule], now))[0];
      // A start is idempotent, so this call is a no-op for every tick between
      // the window opening and the run reaching the store — which would
      // otherwise print the same line two or three times. Log the run id once,
      // and let a repeat of the same id stay quiet.
      if (runId && this.started.get(connector.id) !== runId) {
        this.started.set(connector.id, runId);
        this.logger.log(
          `${connector.name}: started ${runId} for the ${new Date(fireMs).toISOString()} window.`,
        );
      }
    } catch (error) {
      this.complain(`${connector.id}:start`, `Could not start "${connector.name}": ${say(error)}`);
    }
  }

  /**
   * The graph a connector delegates to, at the version it has right now.
   *
   * Read per window rather than cached, for the reason this whole loop holds no
   * state of its own: an edited graph must take effect on the next run. The
   * version travels with the start so that a graph edited between the start and
   * the first node fails at the node rather than quietly executing half of one
   * graph and half of another.
   *
   * A connector pointing at a workflow that no longer exists complains once and
   * starts nothing. Starting a run that cannot resolve its own graph would burn
   * a window and record a failure whose cause is a missing row, which is the
   * author's to fix and not the engine's to retry.
   */
  private async resolveGraph(connector: CatalogConnector): Promise<CatalogWorkflow | undefined> {
    const store = this.pipeline;
    if (!supportsWorkflows(store)) {
      this.complain(
        `${connector.id}:workflow`,
        `"${connector.name}" runs a workflow and this deployment's pipeline store cannot hold one, so nothing will run it.`,
      );
      return undefined;
    }
    const workflow = connector.workflowId
      ? await store.getWorkflow(connector.workflowId)
      : undefined;
    if (!workflow) {
      this.complain(
        `${connector.id}:workflow`,
        `"${connector.name}" runs workflow ${connector.workflowId}, which does not exist. Point it at one that does, or its every window fails with nothing to execute.`,
      );
      return undefined;
    }
    this.forgive(`${connector.id}:workflow`);
    return workflow;
  }

  /**
   * Say what is scheduled, but only when it changes.
   *
   * This is the observable that answers "did my edit take?" — it is logged the
   * tick after somebody saves a connector, and never again until the next edit.
   */
  private announce(scheduled: CatalogConnector[]): void {
    const fingerprint = scheduled
      .map((connector) => `${connector.id}@${connector.schedule}`)
      .sort()
      .join('|');
    if (fingerprint === this.announced) return;
    this.announced = fingerprint;

    if (scheduled.length === 0) {
      this.logger.log('No connector is enabled with a schedule.');
      return;
    }
    this.logger.log(
      `Scheduling ${scheduled.length} connector(s): ${scheduled
        .map((connector) => `${connector.name} (${connector.schedule})`)
        .join(', ')}.`,
    );
  }

  /**
   * The `off` case, stated rather than skipped.
   *
   * A connector carrying a schedule that nothing will act on is precisely the
   * silent no-op this work exists to remove, so an installation that turned
   * durable off and then wrote a schedule should hear about it at every boot.
   */
  private async reportUnschedulable(): Promise<void> {
    try {
      const waiting = (await this.pipeline.listConnectors()).filter(isScheduled);
      if (waiting.length === 0) {
        this.logger.log(
          'No durable engine here, and no connector has a schedule — nothing is going unrun.',
        );
        return;
      }
      this.logger.warn(
        `${waiting.length} connector(s) have a schedule and nothing will run them: ${waiting
          .map((connector) => connector.name)
          .join(
            ', ',
          )}. No WorkflowEngine resolved here. Either this host mounts no durable engine, or its durable module failed to bind — check the boot log before clearing the schedules.`,
      );
    } catch (error) {
      this.logger.warn(`Could not check for orphaned schedules: ${say(error)}`);
    }
  }

  /**
   * Fail loudly at boot rather than once per connector per tick.
   *
   * Cron support in durable core is an optional peer dependency, and the
   * timezone comes from the environment — either being wrong makes every single
   * connector fail identically, and thirty of the same stack trace a minute
   * buries the one line that explains it.
   */
  private probeCron(): void {
    try {
      prevCronFireMs('* * * * *', Date.now(), this.timezone);
    } catch (error) {
      this.logger.error(
        `No connector will run on a schedule: ${say(error)}. Cron schedules need the optional peer dependency "cron-parser", and CATALOG_SCHEDULE_TZ must name an IANA timezone (currently "${this.timezone}").`,
      );
    }
  }

  /** Warn once per distinct message, so a standing fault is not said per tick. */
  private complain(key: string, message: string): void {
    if (this.complaints.get(key) === message) return;
    this.complaints.set(key, message);
    this.logger.warn(message);
  }

  private forgive(key: string): void {
    this.complaints.delete(key);
  }
}

/** Enabled, and carrying something to interpret. Both, or it is manual-only. */
function isScheduled(connector: CatalogConnector): boolean {
  return connector.enabled && (connector.schedule ?? '').trim().length > 0;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function say(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
