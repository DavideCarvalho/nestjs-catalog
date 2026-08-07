import type { CallableWorkflowRef, CatalogWorkflow, ConnectorRun } from '@dudousxd/nestjs-catalog';
import { liveWorkflowVersion } from '@dudousxd/nestjs-catalog';
import { WorkflowEngine } from '@dudousxd/nestjs-durable';
import type { AnnouncedWorkflow } from '@dudousxd/nestjs-durable-core';
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

/**
 * What a call node could be pointed at, and whether the question was answerable.
 *
 * `supported` first because it is the field that stops the list being misread.
 * An empty `workflows` means "nothing is announced" when `supported` is true and
 * "nobody could be asked" when it is false, and those are opposite facts about a
 * deployment: the first says every callable workflow is unregistered or its
 * workers are down, the second says this pod has no durable engine at all. A
 * bare `[]` says neither, and a picker rendering "no workflows found" over it
 * would be inventing the first.
 */
export interface CallableWorkflowList {
  supported: boolean;
  workflows: CallableWorkflowRef[];
  /**
   * When the fleet was asked, ISO-8601.
   *
   * On the answer rather than left to the reader's clock, because this is a
   * snapshot with a resolution of about one worker heartbeat and a screen that
   * showed it without a time would be presenting a moment as a standing fact.
   */
  observedAt: string;
  /** Why, in a full sentence, addressed to whoever is looking at the picker. */
  detail: string;
}

/**
 * One announcement, as the shape a picker takes.
 *
 * Every narrowing here is a refusal to invent. `version` is copied only when an
 * announcer stated one — never taken from a sibling entry, because a worker that
 * said nothing did not agree with one that did. `group` is set only when the
 * announcers named exactly one; more than one is left absent and reported as a
 * disagreement instead, so nothing downstream can read a single group off an
 * entry where the queue is genuinely undetermined.
 *
 * `origins` becomes a `description` only when the fleet agrees on exactly one:
 * "declared by @acme/billing" is the most useful prose available about a
 * workflow whose body is in another repository, and printing several of them as
 * though they were one description would state a package as the owner when two
 * claim to be. When they disagree, the axis is already in `disagreements` and
 * the picker shows it there.
 */
function toCallableWorkflowRef(announced: AnnouncedWorkflow): CallableWorkflowRef {
  const disagreements = announced.disagreements.map((entry) => ({
    axis: entry.axis,
    values: [...entry.values],
  }));
  const ref: CallableWorkflowRef = {
    name: announced.name,
    workers: announced.instances.length,
  };
  if (announced.version !== undefined) ref.version = announced.version;
  if (announced.groups.length === 1) ref.group = announced.groups[0];
  if (announced.origins.length === 1) ref.description = `declared by ${announced.origins[0]}`;
  if (disagreements.length > 0) ref.disagreements = disagreements;
  return ref;
}

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
   * **One check, because one is all this package can make honestly.** The
   * question asked is whether a `WorkflowEngine` resolved in this injector, and
   * the answer is reported as the observation it is. This docblock used to
   * describe three checks — an engine, whether this pod serves handlers for it,
   * and whether that engine belongs to the environment the caller asked for —
   * and the body has only ever performed the first. The other two are written
   * out here rather than dropped, because "not checked" and "checked and fine"
   * are the same silence from the outside, and each is a real way a run can be
   * routed wrongly:
   *
   * - **Handlers.** An engine can resolve in a process that never registers
   *   `CATALOG_WORKFLOW_RUN`. The engine's `workflowBody(name, version)` answers
   *   only half of it: a body means definitely registered, but *no* body is
   *   equally a `registerRemote` worker in another SDK or a group this pod
   *   resolves by convention against a live worker — both of which run the graph
   *   perfectly well. Treating that half-answer as "no" would send a durable run
   *   inline, and an inline run carries none of the singleton mutex, so two
   *   workers would load one connector's type at once. That is a worse failure
   *   than the one it would be guarding against, and the genuinely-unregistered
   *   case already fails loudly: `engine.start` throws "workflow … is not
   *   registered", which {@link startDurable} turns into a refusal rather than a
   *   quiet fallback.
   * - **Environment.** A worker serves exactly one environment, so dispatching a
   *   run requested against `staging` to a `dev` worker would load dev's data and
   *   report it under staging's name. It is the one with real damage behind it
   *   and it is the one least available from here: a `WorkflowEngine` carries no
   *   environment identity that this package can read, so the most this could
   *   ever compute is which environment the *caller* is in — half a comparison,
   *   which is exactly why the fossilised `requireEnvironmentBundle` import and
   *   the `safely()` helper that would have read it through were both left
   *   unused. Whichever environment a run belongs to, the host decided it, from
   *   `CATALOG_DURABLE`, `APP_TYPE` and `CATALOG_ENVIRONMENT` — topology a
   *   library cannot read without inventing the host's deployment model.
   *
   * Both are therefore reported rather than detected: a host that knows either
   * answer says so through {@link CATALOG_PIPELINE_DURABILITY_DETAIL}, which is
   * added to the sentence below rather than replacing it. What must not happen
   * is this claiming "checkpointed" on the strength of an engine merely being
   * injectable — the console renders this as a promise about restartability, and
   * a graph built on a false one is a graph nobody can restart. So the sentence
   * says what was observed, in those words, and leaves the deployment's own
   * caveats to the deployment.
   */
  durability(): WorkflowDurability {
    if (!this.engine) {
      return {
        available: false,
        detail: this.withHostDetail(
          'No durable engine resolved in this process, so a workflow runs inline: it still commits atomically at the sink, but a failure at node seven re-runs node one.',
        ),
      };
    }
    return {
      available: true,
      // The class that resolved, which is the whole of what "which engine" can
      // mean here. Declared on {@link WorkflowDurability} as something a console
      // can print and never populated until now — a third promise in this method
      // that the body was not keeping. It is a weak signal and worth naming as
      // one: it distinguishes a real engine from a host's stand-in or decorator,
      // and says nothing at all about which broker or which environment is
      // behind it.
      engine: this.engine.constructor.name,
      detail: this.withHostDetail(
        'A durable engine resolved here, so each node is checkpointed and a failed run resumes at the node that failed.',
      ),
    };
  }

  /**
   * The observation, then whatever the host wanted added to it.
   *
   * Composed rather than substituted, which is what {@link
   * CATALOG_PIPELINE_DURABILITY_DETAIL} has always said it is for — "only ever
   * ADDS to what the package observed". It was substituting: a host binding the
   * detail to something true and specific ("this pod registers no workflow
   * handlers") replaced the sentence that said an engine had not resolved at
   * all, so the one line a reader gets about why their run was not checkpointed
   * lost the part that was actually checked. The seam exists because a host
   * knows things a library cannot; it was never meant to cost the reader the
   * things the library does know.
   */
  private withHostDetail(observed: string): string {
    return this.detail ? `${observed} ${this.detail}` : observed;
  }

  /**
   * What a call node could be pointed at: every workflow the LIVE fleet says it
   * can execute right now.
   *
   * ## Why this can be answered at all, and could not before
   *
   * `CallInspector` on the canvas asked for a name and a version as typed text,
   * and its docblock said why there was no picker: nothing could enumerate a
   * deployment's registrations. {@link WorkflowEngine.workflowBody} answers for
   * the process asking, and a missing body is ambiguous — "not registered here"
   * reads identically to "registered through `registerRemote` against another
   * SDK" and to "a group this pod resolves by convention against a live worker".
   * A list inferred from it would have differed per replica and would have
   * omitted exactly the cross-SDK workflows a call node exists to reach.
   *
   * `@dudousxd/nestjs-durable-core` **0.65.0** added
   * {@link WorkflowEngine.announcedWorkflows}, which is not inferred: a worker
   * publishes what it can execute on the descriptor keyspace, and every pod
   * folds the same published statements. This method is the adapter onto
   * {@link CallableWorkflowRef}, and it is deliberately thin — the aggregate
   * already refuses to guess, and the job here is not to start guessing on its
   * behalf.
   *
   * ## Three things this must not flatten
   *
   * - **Runnable now, not known about.** The announcer is always the queue's
   *   CONSUMER, so nothing here is a list of what was declared: a `registerRemote`
   *   entry is announced by the worker that serves it or not at all, and an
   *   operator running bodies inline announces nothing. An empty list is
   *   therefore a real and unremarkable answer on a deployment whose workers
   *   have not been upgraded, which is why the manual fields on the node stay.
   * - **A snapshot, roughly one heartbeat wide.** Announcements live on keys
   *   with the worker-heartbeat TTL. Nothing is cached here — the read is on
   *   demand, per request, and the answer carries {@link CallableWorkflowList.observedAt}
   *   so a screen can say when it looked rather than implying it still holds.
   * - **Disagreements survive.** Two workers claiming one `name@version` from
   *   two groups produce a `group` entry in `disagreements`, and
   *   {@link callableWorkflowBlock} is what refuses such an entry. Choosing one
   *   here would be acting on a claim nobody made.
   *
   * ## What "no engine" answers
   *
   * `supported: false` and an empty list, never an empty list on its own. The
   * distinction is the one `GET expectations` already draws and it is the whole
   * value of this route: "this deployment cannot enumerate its workflows" and
   * "this deployment has none to enumerate" would otherwise be the same `[]`,
   * and a picker cannot tell an author which of those it is looking at. A
   * screen that read silence as "there are none" would hide a workflow that is
   * running perfectly well and offer no explanation.
   */
  async callableWorkflows(): Promise<CallableWorkflowList> {
    const observedAt = new Date().toISOString();
    if (!this.engine) {
      return {
        supported: false,
        workflows: [],
        observedAt,
        detail: this.withHostDetail(
          'No durable engine resolved in this process, so nothing here can read what the fleet announces. A call node still works — type the workflow name and the version to pin.',
        ),
      };
    }
    // `announcedWorkflows` is a live read over a transport, so it can fail in
    // every way a network call can. Reported as "cannot enumerate" rather than
    // rethrown: this route only ever feeds a convenience, and a picker whose
    // backing read is down must not take the inspector down with it. The text
    // fields behind it are the whole point of keeping them.
    let announced: AnnouncedWorkflow[];
    try {
      announced = await this.engine.announcedWorkflows();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Could not read what the fleet announces: ${reason}`);
      return {
        supported: false,
        workflows: [],
        observedAt,
        detail: this.withHostDetail(
          `The durable engine here could not be asked what the fleet announces (${reason}). A call node still works — type the workflow name and the version to pin.`,
        ),
      };
    }
    return {
      supported: true,
      workflows: announced.map(toCallableWorkflowRef),
      observedAt,
      detail: this.withHostDetail(
        'Every workflow a live worker announces it can execute, read just now. A worker that stops beating drops off this list within about half a minute, and one that was never upgraded to announce its registrations is not on it at all — so a name that is missing here can still be typed.',
      ),
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
     *
     * **It is also the durable run id, so naming a run that already SUCCEEDED
     * replays it rather than running anything.** `engine.start` is keyed on this
     * value; an id it has already carried to completion is not started again,
     * and `awaitRun` then finds the original run row and answers with it —
     * `succeeded`, the original counts, the original `workflowVersion` and
     * `graphHash`. Nothing is wrong with any of those numbers; they are simply
     * about the earlier run. So "re-run with the same snapshot id to pick up my
     * edit" does not pick up the edit, and says `succeeded` while not saying so.
     *
     * The response carries the version and hash that actually ran, which is the
     * only reason this is detectable at all — compare them against the graph you
     * meant to run. To genuinely re-run an edited graph, leave this out and let
     * a fresh id be minted; reserve it for re-driving a run that *failed*, which
     * is what it was added for.
     */
    snapshotId?: string;
    /**
     * The operator's reason for expecting this load to lose rows.
     *
     * Forwarded, never defaulted, and the distinction is the same one
     * `POST connectors/:id/run` used to make: `undefined` means nobody said
     * anything, and an empty string means somebody sent the field with nothing
     * behind it — which the sink refuses. Collapsing the two here would turn
     * that refusal into silence, and silence is what lets an acknowledgement
     * with no author attached to a snapshot.
     */
    expectShrink?: string;
    /**
     * Which version to run, when the caller means a particular one.
     *
     * Absent is the ordinary case and means "whatever this graph is set to run"
     * — the live version if one is set, its latest save otherwise. Present is
     * the escape hatch the maintainer asked for by name: a new version can be
     * released and tried without becoming what the cron executes, by naming it
     * here rather than by pointing the graph at it.
     *
     * Note which way round that is. Naming a version does **not** deploy it, and
     * nothing about this call moves `liveVersion`. Running is running; deploying
     * is `setLiveWorkflowVersion`, and keeping them apart is the whole point.
     */
    version?: number;
  }): Promise<ConnectorRun> {
    const head = await this.runner.requireWorkflow(input.workflowId);
    // Resolved once, here, so the durable payload, the inline path and the row
    // this answers with cannot disagree about which graph ran. `head` is only
    // used for its identity from this line down.
    const version = input.version ?? liveWorkflowVersion(head);
    const workflow =
      version === head.version
        ? head
        : await this.runner.requireWorkflowAt(input.workflowId, version);
    const connectorId = input.connectorId ?? (await this.runner.attributionFor(workflow));
    const snapshotId = input.snapshotId ?? newSnapshotId('wf');
    const durability = this.durability();

    if (durability.available && this.engine) {
      return this.startDurable(
        workflow,
        connectorId,
        input.principalId,
        snapshotId,
        input.expectShrink,
      );
    }

    // Refused before a run row is opened, rather than at the node.
    //
    // A call node runs as a durable child run and there is nothing inline that
    // resembles one, so this graph cannot run here at all. The node would say
    // so itself — `executeNode` refuses it — but by then a run row is open, the
    // nodes before it have staged their rows, and the failure reads as
    // something that went wrong partway through a load rather than as a graph
    // this pod was never able to run. Said up front, it is a sentence about the
    // deployment.
    const calls = workflow.nodes.filter((node) => node.kind === 'call');
    if (calls.length > 0) {
      throw new BadRequestException(
        `"${workflow.name}" hands ${calls.length === 1 ? 'a step' : `${calls.length} steps`} to another workflow (${calls
          .map((node) =>
            node.kind === 'call'
              ? `"${node.name}" → ${node.callName}@${node.callVersion}`
              : node.name,
          )
          .join(
            ', ',
          )}), which runs as a durable child run. ${durability.detail} There is nothing to start a child with, so this run is refused rather than started and failed partway.`,
      );
    }

    this.logger.log(`Running "${workflow.name}" inline as ${snapshotId}: ${durability.detail}`);
    return this.runner.runInline({
      workflow,
      connectorId,
      principalId: input.principalId,
      snapshotId,
      expectShrink: input.expectShrink,
    });
  }

  private async startDurable(
    workflow: CatalogWorkflow,
    connectorId: string,
    principalId: string,
    snapshotId: string,
    expectShrink?: string,
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
      // Spread conditionally so the field is ABSENT rather than explicitly
      // `undefined` on a run nobody acknowledged. The payload is serialised into
      // the durable store and read back on replay, and an explicit `undefined`
      // is not a thing JSON has — so a field written one way and read back the
      // other is exactly the kind of difference that makes a replay diverge from
      // its first attempt.
      ...(expectShrink === undefined ? {} : { expectShrink }),
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

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function say(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
