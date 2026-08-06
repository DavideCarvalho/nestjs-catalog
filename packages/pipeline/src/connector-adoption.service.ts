import {
  CATALOG_PIPELINE_STORE,
  type CatalogPipelineStore,
  supportsWorkflows,
} from '@dudousxd/nestjs-catalog';
import { Inject, Injectable, Logger, type OnApplicationBootstrap, Optional } from '@nestjs/common';
import { CATALOG_PIPELINE_SCOPE, type CatalogPipelineScope, passthroughScope } from './seams';

/**
 * Whether this process should adopt connectors that predate workflows.
 *
 * The same axis the scheduler loads on, and for the same reason: adoption
 * writes, and a deployment with six API replicas should not have six processes
 * racing to wrap the same twelve connectors. The writes are individually safe —
 * `adoptConnector` answers `undefined` for anything that already has a
 * `workflowId`, so a loser of the race does nothing — but six copies of the
 * report is six chances to read the important line as noise.
 *
 * Default on, because a host that mounts the pipeline module at all has
 * connectors it wants running, and the failure mode of leaving this off is the
 * one this whole service exists to prevent: connectors nothing can edit and
 * nobody was told about.
 */
export const CATALOG_ADOPT_CONNECTORS = Symbol('CATALOG_ADOPT_CONNECTORS');

/**
 * Wrapping every pre-workflow connector into the graph it always was, at boot.
 *
 * ## Why this exists at all
 *
 * A workflow is the only thing anybody authors now. `POST connectors` and
 * `DELETE connectors/:id` are gone, and so is `POST connectors/:id/run` — so a
 * connector that was authored directly, before any of this, is a running load
 * with no screen, no route and no way to change it. A dev deployment has
 * thirteen of them and twelve are serving real data. Removing the ability to
 * author a connector must not orphan them, and "they still run, you just cannot
 * touch them" is orphaning them with extra steps.
 *
 * ## Why migrate rather than freeze
 *
 * Three outcomes were available: migrate them into workflows, leave them
 * readable but not editable, or require somebody to rebuild each by hand.
 *
 * Freezing is the one that looks safest and is not. It leaves the deployment in
 * exactly the half-unified state this change exists to get out of — two kinds of
 * connector, one of which is explicable only by history — and it defers the work
 * to whoever next needs to change a load, at the moment they need to change it.
 * Rebuilding by hand is the same cost paid twelve times, with twelve chances to
 * transcribe a query wrongly.
 *
 * Migrating is chosen because **the target shape was already exactly
 * representable**: a connector is a single-source, single-sink graph with at
 * most one transform in the middle. Nothing is invented. See
 * `CatalogWorkflowStore.adoptConnector` for what is preserved — the connector
 * id, so the run history and the mutex key survive; the watermark, re-keyed
 * under the new source node; and the schedule, moved to the graph.
 *
 * ## Why it is loud
 *
 * Because the bar here is "nobody is surprised" rather than "no downtime", and a
 * migration that runs perfectly and says nothing is indistinguishable at 9am
 * from one that did not run. So: a line naming every connector before anything
 * is written, a line per adoption, a summary, and — the case that actually
 * matters — a **warning that survives**, per connector, for anything that could
 * not be adopted. A connector that cannot be wrapped keeps running exactly as it
 * was; adoption never leaves a pipeline in a worse state than it found it.
 *
 * ## Why it is not a migration script
 *
 * It needs the store's credential handling. A connector's `config` may hold a
 * sealed credential, sealed under a `SecretContext` of `('connector', id)`, and
 * a graph's source node seals under `('workflow', id)` — so a script copying the
 * column across would write ciphertext that decrypts under a context nothing
 * will present. Going through `getConnector` and `saveWorkflow` opens and
 * re-seals it correctly, and those are methods rather than SQL.
 */
@Injectable()
export class ConnectorAdoption implements OnApplicationBootstrap {
  private readonly logger = new Logger(ConnectorAdoption.name);

  constructor(
    @Inject(CATALOG_PIPELINE_STORE)
    private readonly pipeline: CatalogPipelineStore,
    @Optional()
    @Inject(CATALOG_ADOPT_CONNECTORS)
    private readonly enabled: boolean = true,
    // A bootstrap hook carries no ambient scope, exactly like a durable step or
    // a scheduler tick. Every read and write below goes through it, or a
    // multi-environment deployment would adopt nothing and throw
    // `UnresolvedEnvironmentError` at the first store call.
    @Optional()
    @Inject(CATALOG_PIPELINE_SCOPE)
    private readonly scope: CatalogPipelineScope = passthroughScope,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.enabled) return;
    // Not awaited, and deliberately: adoption reads and writes a database, and a
    // boot that blocks on it turns a slow store into a pod that never becomes
    // ready. Nothing downstream depends on it having finished — an unadopted
    // connector keeps running on the path it was already on.
    void this.scope.run(() => this.adopt());
  }

  /**
   * One pass. Reports before it writes, and again after.
   *
   * Sequential rather than concurrent. Twelve connectors is not a throughput
   * problem, and each adoption is several dependent writes; interleaving them
   * would make the log unreadable at exactly the moment somebody is reading it
   * to find out what happened to their pipeline.
   */
  async adopt(): Promise<void> {
    try {
      const store = this.pipeline;
      if (!supportsWorkflows(store)) {
        // Worth saying rather than returning quietly. A store that cannot hold a
        // workflow cannot adopt anything into one, and on this deployment that
        // means every connector it holds is now uneditable with no path forward.
        const stranded = (await store.listConnectors()).filter(
          (connector) => !connector.workflowId,
        );
        if (stranded.length > 0) {
          this.logger.warn(
            `${stranded.length} connector(s) predate workflows and this deployment's pipeline store cannot hold one, so they cannot be adopted: ${stranded
              .map((connector) => connector.name)
              .join(
                ', ',
              )}. They keep running, and there is no longer any route that can edit them. Configure a store that supports workflows before changing any of these loads.`,
          );
        }
        return;
      }

      const pending = (await store.listConnectors()).filter((connector) => !connector.workflowId);
      if (pending.length === 0) return;

      // Said before a single write, so that a crash halfway through still leaves
      // the list of what was being attempted.
      this.logger.log(
        `${pending.length} connector(s) predate workflows and will be wrapped into one each, keeping their id, run history, watermark and schedule: ${pending
          .map((connector) => connector.name)
          .join(', ')}.`,
      );

      let adopted = 0;
      const failed: string[] = [];
      for (const connector of pending) {
        try {
          const result = await store.adoptConnector(connector.id, ADOPTION_ACTOR);
          if (result) adopted += 1;
        } catch (error) {
          // Per connector, and it does not stop the others. One connector with a
          // config nothing can wrap must not be the reason the other eleven stay
          // stranded — and it keeps running exactly as it was either way.
          failed.push(connector.name);
          this.logger.error(
            `Could not wrap connector "${connector.name}" (${connector.id}) into a workflow: ${say(
              error,
            )}. It keeps running as it is, and no route can edit it until this is resolved.`,
          );
        }
      }

      this.logger.log(
        `Adopted ${adopted} of ${pending.length} connector(s) into workflows.${
          failed.length > 0
            ? ` ${failed.length} could not be wrapped and are still running unedited: ${failed.join(', ')}.`
            : ''
        }`,
      );
    } catch (error) {
      this.logger.error(
        `Could not check for connectors predating workflows: ${say(error)}. Any that exist keep running and stay uneditable; this is worth resolving rather than ignoring.`,
      );
    }
  }
}

/**
 * Who an adoption is attributed to.
 *
 * Not the connector's author — they wrote a connector, they did not decide to
 * publish a graph — and not a real principal, because this path is past
 * authorisation entirely. A name that reads correctly in `createdBy` and in the
 * audit trail is the honest answer, and it is the same reasoning
 * `SCHEDULER_PRINCIPAL` is chosen by one file over.
 */
const ADOPTION_ACTOR = 'connector-adoption';

function say(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
