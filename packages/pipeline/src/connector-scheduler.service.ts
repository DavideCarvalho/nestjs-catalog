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
 * The thing that reads `workflow.schedule` and starts a run for its window.
 *
 * **It used to read `connector.schedule`, and moving it is the point of this
 * class's current shape.** A schedule is a statement about a pipeline, and a
 * pipeline is a graph now — the connector is what a published graph runs as. Two
 * copies of a cron, one on each row, is how the two come to disagree the first
 * time somebody edits one, so there is one authority and this reads it. The
 * connector still carries a copy, and this deliberately never looks at it; see
 * `CatalogConnector.schedule`.
 *
 * The design decision worth stating is that this holds **no schedule state of
 * its own**. Every tick reloads every workflow from the store and rebuilds the
 * schedule list from scratch, so an edit in the console — a changed cron, a
 * cleared one, a graph unpublished or deleted — takes effect within one poll
 * interval, with no restart, no cache to invalidate and no registration to
 * withdraw. A scheduler that registered schedules at boot would be a second copy
 * of a database column, and the two would disagree the first time somebody
 * edited one.
 *
 * ## What it takes to be scheduled, and why each part is said out loud
 *
 * Three things: a graph that is `ready`, `enabled`, and carrying a cron. Each is
 * a way a schedule can be stored and never fire, and **every one of them is
 * logged rather than skipped quietly**. That is not defensive style. Cron was
 * silently broken for every scheduled connector on this deployment until
 * recently, and the symptom was this loop announcing that it was watching
 * schedules every 30000ms while parsing nothing at all — a log line that reads
 * exactly like health. A skip with no sentence attached is the same failure
 * wearing a different cause, so a graph that carries a cron and will not run
 * says which of the three it is missing, once, until that changes.
 *
 * Starting a run is `runSchedules` from durable core, unchanged. It derives the
 * run id from the schedule key and the cron's fire time
 * (`sched:connector:<id>:<fireMs>`), and `engine.start` is idempotent by run id
 * — so every tick of every replica racing on the same window starts that window
 * **exactly once**. That is the guarantee that stops two workers double-loading
 * a pipeline, and it is a property of the store, not of this loop.
 *
 * The key stays `connector:<connectorId>` rather than becoming
 * `workflow:<workflowId>`, and that is deliberate: the key is half the run id
 * and the run id is the snapshot id, so re-keying it would make every scheduled
 * pipeline's next window look like a run it had never done before — and the
 * connector id is also what the singleton mutex serialises on, so the two have
 * to name the same thing.
 *
 * What it does *not* stop is window N+1 starting while window N is still
 * running. `runSchedules`' own `overlap: 'skip'` only applies to fixed-interval
 * schedules, so for cron the guard is the workflow's `singleton` mutex — which
 * the engine enforces in `own` mode and, because a control plane resolves a
 * foreign workflow by convention and a convention-resolved registration carries
 * no singleton config, does **not** enforce in `attach` mode. An `attach`
 * deployment whose graphs can outrun their own schedule needs a cron with
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
      const store = this.pipeline;
      if (!supportsWorkflows(store)) {
        // Once, not per tick. A store that cannot hold a graph cannot hold a
        // schedule either, so this is a deployment fault rather than a state
        // that resolves itself — and it is exactly the case that must not be a
        // silent no-op, because everything downstream of it looks idle.
        this.complain(
          'store',
          "This deployment's pipeline store cannot hold workflows, so no schedule can be read and nothing will ever run on one. Nothing here will retry into working.",
        );
        return;
      }

      const workflows = await store.listWorkflows();
      const scheduled = workflows.filter(hasCron);
      this.announce(scheduled);
      this.reportUnrunnable(scheduled);
      // One `runSchedules` call per graph, not one for all of them: the
      // library's loop is sequential and awaits each start, so a single graph
      // whose start throws would silently swallow every graph after it — and
      // `listWorkflows` orders by name, so it would be the same ones every time.
      for (const workflow of scheduled.filter(isRunnable)) {
        await this.fire(engine, workflow, now);
      }
    } catch (error) {
      this.logger.warn(`Could not read workflow schedules this tick: ${say(error)}`);
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Name every graph that carries a cron and will not run on it.
   *
   * The half of this loop that the incident behind it argues for. A draft with a
   * schedule, or a disabled one, is stored exactly like a working one and reads
   * on every screen as scheduled — the only place the difference is observable
   * is here, at the moment this loop decides not to fire it. Saying nothing is
   * how "watching schedules" and "watching nothing" became the same log line.
   *
   * Deduplicated per graph through {@link complain}, so a graph parked as a
   * draft for a month costs one line rather than one per tick.
   */
  private reportUnrunnable(scheduled: CatalogWorkflow[]): void {
    for (const workflow of scheduled) {
      if (isRunnable(workflow)) {
        this.forgive(`${workflow.id}:unrunnable`);
        continue;
      }
      this.complain(
        `${workflow.id}:unrunnable`,
        workflow.status !== 'ready'
          ? `"${workflow.name}" has a schedule ("${workflow.schedule}") and is still a draft, so nothing will run it. Only a ready graph is scheduled — publish it, or clear the schedule so the row stops claiming something that is not happening.`
          : `"${workflow.name}" has a schedule ("${workflow.schedule}") and is disabled, so nothing will run it.`,
      );
    }
  }

  private async fire(
    engine: WorkflowEngine,
    workflow: CatalogWorkflow,
    now: number,
  ): Promise<void> {
    const cron = (workflow.schedule ?? '').trim();

    let fireMs: number;
    try {
      fireMs = prevCronFireMs(cron, now, this.timezone);
    } catch (error) {
      // A schedule nobody can parse is the author's to fix, and naming the
      // graph and the expression is the only useful thing to say about it. It
      // must not take the other graphs down with it.
      this.complain(
        `${workflow.id}:cron`,
        `"${workflow.name}" has a schedule this service cannot read ("${cron}"): ${say(error)}`,
      );
      return;
    }
    // Only the parse complaint. Clearing every complaint here would clear the
    // start-failure one below on the next tick and then log it again, turning a
    // deduplicated warning back into one per tick.
    this.forgive(`${workflow.id}:cron`);

    // The connector this graph runs as, which is what the run is keyed and
    // serialised on. Resolved per window rather than cached, for the reason this
    // whole loop holds no state: a graph unpublished and re-published between
    // two windows is a connector that was disabled and re-enabled, and a cached
    // answer would keep firing into the disabled one.
    const connector = await this.connectorFor(workflow);
    if (!connector) return;

    // The current cron window is whatever fired most recently, which for a
    // daily schedule can be twenty hours ago. Firing it is right when a worker
    // was down through it — that is catch-up, and for a catalog catch-up is
    // what you want. It is wrong when the schedule did not exist yet: a graph
    // published at 23:00 with `0 3 * * *` would load immediately, and so would
    // one whose cron was just edited.
    //
    // `updatedAt` separates the two, and it is read off the **connector** rather
    // than the workflow deliberately. The connector's is bumped by every edit
    // *and* by every run's start and finish, which is what makes this test mean
    // "newer than the last thing that happened to this pipeline"; a workflow's
    // is bumped only by edits, so a graph nobody has touched since it was
    // published would re-fire its most recent window on every boot forever.
    //
    // This is a filter, not the guarantee — the guarantee is the deterministic
    // run id below, which is what makes a redundant start a no-op.
    const changedAt = Date.parse(connector.updatedAt);
    if (Number.isFinite(changedAt) && fireMs <= changedAt) return;

    const schedule: ScheduledWorkflow = {
      // The key is half the run id, so it must identify the pipeline and
      // nothing about it that can change. The connector id, therefore — not the
      // workflow's, because the run id derived from this is the snapshot id and
      // the connector is what a snapshot's history and watermark hang off, and
      // not the name.
      key: `connector:${connector.id}`,
      workflow: CATALOG_WORKFLOW_RUN,
      input: {
        workflowId: workflow.id,
        workflowVersion: workflow.version,
        workflowName: workflow.name,
        connectorId: connector.id,
        principalId: SCHEDULER_PRINCIPAL,
        // No `expectShrink`, and its absence is the rule rather than an
        // omission: this window is unattended, and an acknowledgement that
        // fires every night is the row-count bound switched off in a costume.
        // A refused scheduled load is re-driven by hand, with a reason. See
        // `CatalogWorkflowRunInput.expectShrink`.
      } satisfies CatalogWorkflowRunInput,
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
      if (runId && this.started.get(workflow.id) !== runId) {
        this.started.set(workflow.id, runId);
        this.logger.log(
          `${workflow.name}: started ${runId} for the ${new Date(fireMs).toISOString()} window.`,
        );
      }
    } catch (error) {
      this.complain(`${workflow.id}:start`, `Could not start "${workflow.name}": ${say(error)}`);
    }
  }

  /**
   * The connector a published graph runs as.
   *
   * There is exactly one, minted by `publishWorkflow`, and a graph that is
   * `ready` with none is a state that should not exist — so it complains rather
   * than starting anything. Starting a run with the workflow's own id standing
   * in for a connector was the tempting shortcut and is the wrong one: that id
   * would become the mutex key and the snapshot's owner, so the graph's history
   * would silently split in two the moment its real connector appeared, and
   * nothing would be serialising the two against each other in the meantime.
   *
   * More than one is reported and the first used, rather than refused. It can
   * only happen on a deployment that had several connectors pointing at one
   * graph before this change, which is exactly the deployment that must keep
   * loading while somebody reconciles it.
   */
  private async connectorFor(workflow: CatalogWorkflow): Promise<CatalogConnector | undefined> {
    const store = this.pipeline;
    if (!supportsWorkflows(store)) return undefined;

    const using = (await store.connectorsUsingWorkflow(workflow.id)).filter(
      (connector) => connector.enabled,
    );
    if (using.length === 0) {
      this.complain(
        `${workflow.id}:connector`,
        `"${workflow.name}" is ready and scheduled and there is no enabled connector running it, so its windows pass with nothing to key a run on. Publishing it again mints one; that is the supported repair.`,
      );
      return undefined;
    }
    if (using.length > 1) {
      this.complain(
        `${workflow.id}:connector`,
        `${using.length} connectors run "${workflow.name}": ${using
          .map((connector) => connector.name)
          .join(
            ', ',
          )}. Only ${using[0].name} is scheduled — the rest are rows from before a workflow minted its own connector, and each one is a separate run history nothing is writing to.`,
      );
      return using[0];
    }
    this.forgive(`${workflow.id}:connector`);
    return using[0];
  }

  /**
   * Say what is scheduled, but only when it changes.
   *
   * This is the observable that answers "did my edit take?" — it is logged the
   * tick after somebody saves a connector, and never again until the next edit.
   */
  private announce(scheduled: CatalogWorkflow[]): void {
    const fingerprint = scheduled
      .map(
        (workflow) => `${workflow.id}@${workflow.schedule}@${workflow.status}@${workflow.enabled}`,
      )
      .sort()
      .join('|');
    if (fingerprint === this.announced) return;
    this.announced = fingerprint;

    const runnable = scheduled.filter(isRunnable);
    if (scheduled.length === 0) {
      this.logger.log('No workflow carries a schedule.');
      return;
    }
    // The count of what will actually fire, said separately from the count of
    // what carries a cron. One number for both is what let "watching schedules"
    // mean "watching nothing" — `reportUnrunnable` names each of the difference.
    this.logger.log(
      `Scheduling ${runnable.length} of ${scheduled.length} workflow(s) carrying a cron: ${
        runnable.length > 0
          ? runnable.map((workflow) => `${workflow.name} (${workflow.schedule})`).join(', ')
          : 'none of them are ready and enabled'
      }.`,
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
      const store = this.pipeline;
      const waiting = supportsWorkflows(store) ? (await store.listWorkflows()).filter(hasCron) : [];
      if (waiting.length === 0) {
        this.logger.log(
          'No durable engine here, and no workflow has a schedule — nothing is going unrun.',
        );
        return;
      }
      this.logger.warn(
        `${waiting.length} workflow(s) have a schedule and nothing will run them: ${waiting
          .map((workflow) => workflow.name)
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

/**
 * Carrying something to interpret.
 *
 * Split from {@link isRunnable} on purpose, where the connector version had them
 * as one test. A graph that has a cron and cannot run it is the case worth
 * naming — it is the shape of the incident this loop exists to stop repeating —
 * and one combined predicate makes it indistinguishable from a graph nobody ever
 * scheduled.
 */
function hasCron(workflow: CatalogWorkflow): boolean {
  return (workflow.schedule ?? '').trim().length > 0;
}

/** Published, and switched on. Both, or its cron is a row nothing acts on. */
function isRunnable(workflow: CatalogWorkflow): boolean {
  return workflow.status === 'ready' && workflow.enabled;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function say(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
