import { CATALOG_PIPELINE_STORE, type CatalogPipelineStore } from '@dudousxd/nestjs-catalog';
import { WorkflowEngine } from '@dudousxd/nestjs-durable';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import {
  RECONCILE_SCAN_LIMIT,
  closeRunsTheEngineHasFinished,
  engineRunView,
} from './abandoned-runs';
import { CATALOG_PIPELINE_SCOPE, type CatalogPipelineScope, passthroughScope } from './seams';

/**
 * Whether this process reconciles open run rows against the engine.
 *
 * The same axis the scheduler and the adoption pass load on, and for the same
 * reason: this writes, and a deployment with six API replicas should not have
 * six processes racing to close the same row. The writes are individually
 * harmless — the second one finds the row already `failed` and skips it — but
 * six copies of a warning is six chances to read the important line as noise.
 *
 * Defaulted to the scheduler's answer rather than to an independent `true`, so
 * a host that has already declared which pods do the background work does not
 * declare it a second time. See `CatalogPipelineModuleOptions.reconcileRuns`.
 */
export const CATALOG_RECONCILE_RUNS = Symbol('CATALOG_RECONCILE_RUNS');

/**
 * How often a pass runs.
 *
 * Five minutes, which is chosen for what it costs rather than for how fresh it
 * keeps anything. The rows this closes are already dead — nothing is waiting on
 * the closure, and a row that stays wrong for five more minutes has been wrong
 * for two hours already — so there is no benefit to be bought by paying more.
 * What it costs at this interval is twelve bounded queries an hour on one pod.
 *
 * The scheduler's 30s tick was the tempting place to hang this and is the wrong
 * one twice over: it would be a hundredfold the queries for no gain, and it
 * would put a write into the loop whose one job is to start loads on time.
 */
const DEFAULT_RECONCILE_MS = 5 * 60_000;

/**
 * Closing the run rows that nothing else will ever come back to.
 *
 * ## What it is for
 *
 * `closeAbandonedAttempts` closes a row left `running` when the **next attempt
 * at the same snapshot** opens. That covers a step being retried and an operator
 * re-driving a failed load, and by construction it cannot cover a durable run
 * that dies without reaching its finish step: the next run mints a new snapshot,
 * so no second attempt at the old one is ever made. Those rows — a two-hour
 * execution timeout, a cancellation, a worker that never resumed — sit at
 * `running` with `fetched = 0` and no error, indefinitely. This is the trigger
 * that revisits them, because nothing else does.
 *
 * ## Why a timer, and what it costs
 *
 * The three candidates were a boot pass, a read path, and a loop.
 *
 * - **Boot only** is the cheapest and does not work: the failure happens
 *   mid-afternoon, and a pod that is not restarted until Thursday leaves the row
 *   `running` until Thursday — which is the silence this exists to end, on a
 *   longer timescale. A boot pass is kept, as the first tick of the loop, because
 *   it is also the moment a pod that has just replaced a killed one can see what
 *   the killed one left.
 * - **A read path** — reconciling when somebody opens the runs list — is the
 *   cheapest thing that is always fresh, and it is refused on principle: it makes
 *   a `GET` write to a governance record, so what a run row says would depend on
 *   who had looked at it and when. It also costs an engine round-trip per open
 *   row on every page render, which is exactly the kind of tax this package must
 *   not levy on the app embedding it.
 * - **A loop** costs, per pass: one `ORDER BY started_at DESC LIMIT n` over the
 *   run table, one `listConnectors` for the names, and one `engine.getRun` per
 *   row that is *currently* `running` and durable — which on a healthy
 *   deployment is nought or one. Nothing in that grows with the data a load
 *   moves, and every part of it is bounded before it is issued. A pass that finds
 *   something to close pays one further read of the run list, for the race
 *   described on {@link closeRunsTheEngineHasFinished}.
 *
 * On one pod, at {@link DEFAULT_RECONCILE_MS}. `CATALOG_RUN_RECONCILE_MS`
 * moves the interval and `CATALOG_RUN_RECONCILE_SCAN` the window.
 *
 * ## When the engine cannot be asked
 *
 * Nothing is written, and the reason is said once at boot rather than per pass.
 * Two shapes of that, reported differently because they are different facts:
 *
 * - **No engine resolved.** `CATALOG_DURABLE=off`, so every run here is
 *   `inline`, so there is no row this rule could apply to. Not a fault, and
 *   logged as the ordinary state it is.
 * - **An engine resolved and cannot answer.** A thin tenant worker is given
 *   `DurableStartClient` under the `WorkflowEngine` token — a store-less
 *   start-only facade with no `getRun` at all. Durable runs exist on that
 *   deployment and this pod cannot see any of them, so this is a warning: the
 *   rows will accumulate, and somebody has to know which pod to move this onto.
 *
 * Neither is allowed to become a guess. An outcome written onto a run row is
 * what an operator later audits a load by, and a `failed` invented because the
 * engine was unreachable is worse than the `running` it replaced.
 */
@Injectable()
export class AbandonedRunReconciler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(AbandonedRunReconciler.name);
  private readonly everyMs = positiveInt(
    process.env.CATALOG_RUN_RECONCILE_MS,
    DEFAULT_RECONCILE_MS,
  );

  private timer?: NodeJS.Timeout;
  /** Guarded against re-entry rather than against slowness — see {@link pass}. */
  private working = false;

  constructor(
    @Inject(CATALOG_PIPELINE_STORE)
    private readonly pipeline: CatalogPipelineStore,
    // Optional for the same reason it is on the scheduler: a host may mount this
    // module with `CATALOG_DURABLE=off` and no engine at all, and that is a
    // state to report rather than a reason to fail the boot.
    //
    // Injected by explicit token and typed `object`, which is the one place in
    // this package that does so and is deliberate. `WorkflowEngine` is the DI
    // token here, not a promise about what is behind it: a thin tenant worker
    // binds `DurableStartClient` under it — a store-less, start-only facade with
    // no `getRun` at all. Declaring the class as the *type* would state a
    // contract this token does not keep, and the compiler would then agree that
    // `engine.getRun` exists on a deployment where it does not. The question is
    // asked instead, by {@link engineRunView}, and is allowed to answer no.
    @Optional()
    @Inject(WorkflowEngine)
    private readonly engine?: object,
    @Optional()
    @Inject(CATALOG_RECONCILE_RUNS)
    private readonly enabled: boolean = true,
    // A timer callback carries no ambient scope, exactly like a durable step or
    // a scheduler tick. Every read and write below goes through it, or a
    // multi-environment host would throw `UnresolvedEnvironmentError` at the
    // first store call and reconcile nothing.
    @Optional()
    @Inject(CATALOG_PIPELINE_SCOPE)
    private readonly scope: CatalogPipelineScope = passthroughScope,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.enabled) return;

    if (!this.engine) {
      this.logger.log(
        'No durable engine resolved here, so every run this process can see executed inline and there is no durable run to reconcile one against. Nothing is checked, and nothing needs to be.',
      );
      return;
    }
    if (!engineRunView(this.engine)) {
      // The case `WorkflowLauncher.durability` warns about from the other side:
      // something resolved under the token and it is not an engine that can be
      // read. Named precisely, because the fix is a deployment change and the
      // symptom otherwise is run rows quietly accumulating at `running`.
      this.logger.warn(
        `A ${nameOf(this.engine)} is bound to the WorkflowEngine token here and it cannot read a run — a thin worker is given a store-less, start-only facade under that token. Durable run rows left open by a run that died before its finish step will not be closed by this process. Mount this on a process whose engine has a store, or leave it off here and on there.`,
      );
      return;
    }

    // Not unref'd, for the reason the scheduler's is not: with `APP_TYPE=WORKER`
    // the process calls `app.init()` and never listens on a port, so an unref'd
    // timer would let Node decide there was nothing left to do and exit.
    this.timer = setInterval(() => void this.scope.run(() => this.pass()), this.everyMs);
    this.logger.log(
      `Reconciling open run rows against the engine every ${this.everyMs}ms, over the ${RECONCILE_SCAN_LIMIT} most recently started runs.`,
    );
    // The first pass now rather than in five minutes, and deliberately not
    // awaited: this reads and writes a database, and a boot that blocks on it
    // turns a slow store into a pod that never becomes ready. Nothing downstream
    // waits on it — the rows it closes are rows nothing was going to touch.
    void this.scope.run(() => this.pass());
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * One pass, or nothing at all.
   *
   * Re-entry is refused rather than queued: a pass that outlives its interval
   * means the store is struggling, and a second engine round-trip per row on top
   * of the first is the wrong way to find that out.
   *
   * Public so a host that would rather drive this from its own scheduler — or a
   * spec that would rather not own a timer — can call it directly. It resolves
   * the engine's view itself for that reason; a caller reaching past
   * `onApplicationBootstrap` has not been through the checks there.
   */
  async pass(): Promise<void> {
    if (this.working) return;
    const view = engineRunView(this.engine);
    if (!view) return;

    this.working = true;
    try {
      const outcome = await closeRunsTheEngineHasFinished(this.pipeline, view, this.logger, {
        names: await this.connectorNames(),
      });
      // Only when something happened. A line every five minutes saying nothing
      // was wrong is how the line that says something *is* wrong stops being
      // read — the exact failure mode `ConnectorScheduler` documents about
      // announcing that it was watching schedules while parsing none.
      if (outcome.closed > 0) {
        this.logger.log(
          `Closed ${outcome.closed} run row(s) whose durable run the engine has finished with, of ${outcome.examined} still marked running.`,
        );
      }
    } finally {
      this.working = false;
    }
  }

  /**
   * Connector id → name, so a closed row names the pipeline rather than a UUID.
   *
   * One read per pass, bounded by the number of connectors a deployment has
   * rather than by anything a load moves. A failure here costs the names and not
   * the pass: an empty map falls back to the connector id, which is worse to
   * read and is still the identifier somebody can look the pipeline up by.
   */
  private async connectorNames(): Promise<ReadonlyMap<string, string>> {
    try {
      const connectors = await this.pipeline.listConnectors();
      return new Map(connectors.map((connector) => [connector.id, connector.name] as const));
    } catch (error) {
      this.logger.warn(
        `Could not read connector names for this reconciling pass, so any row it closes names an id: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return new Map();
    }
  }
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * What to call the thing bound to the token, in the one line that has to name
 * it.
 *
 * Defensive about `constructor` on purpose. This runs at boot, inside the branch
 * that already knows the injected value is not what it claims to be, and a
 * null-prototype object would turn a warning about a misconfigured deployment
 * into a crash of the process that was trying to report it.
 */
function nameOf(engine: object): string {
  const name = Reflect.get(engine, 'constructor')?.name;
  return typeof name === 'string' && name.length > 0 ? name : 'value';
}
