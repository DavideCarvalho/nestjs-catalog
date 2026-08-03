import { SubprocessTransformRunner } from '@dudousxd/nestjs-catalog';
import { type DynamicModule, Module, type Provider, type Type } from '@nestjs/common';
import { ConnectionChecker } from './connection-checker.service';
import { ConnectorRunSteps } from './connector-run.steps';
import { ConnectorRunWorkflow } from './connector-run.workflow';
import { ConnectorRunnerService } from './connector-runner.service';
import { CATALOG_SCHEDULER_ENABLED, ConnectorScheduler } from './connector-scheduler.service';
import { PublishService } from './publish.service';
import {
  CATALOG_PIPELINE_EM,
  CATALOG_PIPELINE_REGISTRY,
  CATALOG_PIPELINE_SCOPE,
  passthroughScope,
} from './seams';
import { WorkflowRunSteps } from './workflow-run.steps';
import { CatalogWorkflowRunWorkflow } from './workflow-run.workflow';
import { WorkflowRunnerService } from './workflow-runner.service';

export interface CatalogPipelineModuleOptions {
  /**
   * Whatever the host needs in scope for `em`, `registry` and `scope` to resolve
   * — typically the module that exports its catalog store.
   */
  imports?: DynamicModule['imports'];
  /** Resolves the EntityManager a write lands on. See `CATALOG_PIPELINE_EM`. */
  em: Provider;
  /** The registry the engine reads the model from. See `CATALOG_PIPELINE_REGISTRY`. */
  registry: Provider;
  /**
   * Enters the host's scope around durable steps and scheduler ticks. Omit for a
   * host with a single connection, which has nothing to enter.
   */
  scope?: Provider;
  /**
   * Whether THIS process runs the scheduler loop. Default true. A host that
   * splits API and worker roles should pass false on the roles that do not poll
   * — not for safety (a duplicate start is a no-op, the run id is derived from
   * the cron fire time) but so every replica does not read the store on a timer.
   */
  scheduler?: boolean;
  /** Passed to `SubprocessTransformRunner` for Python transforms. */
  pythonVenv?: string;
}

/**
 * Fetch, transform, publish — the connector pipeline, as a module.
 *
 * This was application code in two places at once: the standalone catalog
 * service and the copy of it mounted inside flip. That is why it is a package
 * now. The two had already drifted — flip was missing the scheduler entirely, so
 * `connector.schedule` was a column nothing acted on until it was ported by
 * hand, which is the failure mode duplication always produces eventually.
 *
 * Nothing here decides *when* a load runs; the scheduler starts runs and a human
 * can press the button. Two systems believing they decide when a load happens is
 * the failure this design exists to avoid.
 *
 * The workflows and steps are ordinary providers: a durable engine discovers
 * `@Workflow`/`@Step` classes wherever they are declared, so this module never
 * imports anything durable and a host without an engine simply never dispatches
 * them.
 */
@Module({})
export class CatalogPipelineModule {
  static forRoot(options: CatalogPipelineModuleOptions): DynamicModule {
    const providers: Provider[] = [
      options.em,
      options.registry,
      options.scope ?? {
        provide: CATALOG_PIPELINE_SCOPE,
        useValue: passthroughScope,
      },
      {
        provide: CATALOG_SCHEDULER_ENABLED,
        useValue: options.scheduler ?? true,
      },
      {
        // Constructed rather than auto-wired so the venv path is visible beside
        // the rest of this module's configuration.
        provide: SubprocessTransformRunner,
        useFactory: () => new SubprocessTransformRunner({ pythonVenv: options.pythonVenv }),
      },
      PublishService,
      ConnectorRunnerService,
      WorkflowRunnerService,
      ConnectionChecker,
      ConnectorScheduler,
      ConnectorRunSteps,
      ConnectorRunWorkflow,
      WorkflowRunSteps,
      CatalogWorkflowRunWorkflow,
    ];

    return {
      module: CatalogPipelineModule,
      imports: options.imports,
      providers,
      exports: [PublishService, ConnectorRunnerService, WorkflowRunnerService, ConnectionChecker],
    };
  }
}

/** Re-exported so a host can name the providers it is asked to supply. */
export const CATALOG_PIPELINE_TOKENS = {
  em: CATALOG_PIPELINE_EM,
  registry: CATALOG_PIPELINE_REGISTRY,
  scope: CATALOG_PIPELINE_SCOPE,
  schedulerEnabled: CATALOG_SCHEDULER_ENABLED,
} as const;

export type { Type };
