import { SubprocessTransformRunner } from '@dudousxd/nestjs-catalog';
import {
  type DynamicModule,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationBootstrap,
  Optional,
  type Provider,
  type Type,
} from '@nestjs/common';
import { ConnectionChecker } from './connection-checker.service';
import { CATALOG_ADOPT_CONNECTORS, ConnectorAdoption } from './connector-adoption.service';
import { ConnectorRunSteps } from './connector-run.steps';
import { ConnectorRunWorkflow } from './connector-run.workflow';
import { ConnectorRunnerService } from './connector-runner.service';
import { CATALOG_SCHEDULER_ENABLED, ConnectorScheduler } from './connector-scheduler.service';
import {
  CATALOG_LOAD_EXPECTATIONS,
  type CatalogLoadExpectations,
  DEFAULT_ROW_COUNT_BOUND,
} from './load-expectations';
import { createPipelineController } from './pipeline.controller';
import { createPublishController } from './publish.controller';
import { PublishService } from './publish.service';
import { AbandonedRunReconciler, CATALOG_RECONCILE_RUNS } from './run-reconciler.service';
import {
  CATALOG_PIPELINE_EM,
  CATALOG_PIPELINE_REGISTRY,
  CATALOG_PIPELINE_SCOPE,
  passthroughScope,
} from './seams';
import {
  SECRET_ENV_ALLOW_VAR,
  describeSecretEnvAllowlist,
  installSecretEnvAllowlist,
  secretEnvAllowlist,
  secretEnvAllowlistSource,
} from './secret-env-allowlist';
import { WorkflowLauncher } from './workflow-launcher.service';
import { WorkflowRunSteps } from './workflow-run.steps';
import { CatalogWorkflowRunWorkflow } from './workflow-run.workflow';
import { WorkflowRunnerService } from './workflow-runner.service';

export interface CatalogPipelineModuleOptions {
  /**
   * Route prefix the controllers mount under, giving `<path>/pipeline` and
   * `<path>/publish`. Omit to mount no controllers at all — a worker-only host
   * wants the engine and the scheduler without an HTTP surface.
   */
  path?: string;
  /**
   * Guards for those controllers. Handed in rather than chosen here, because a
   * library that picks the auth for routes which can rewrite a catalog's schema
   * is deciding something only the host can. The routes still DECLARE what they
   * need, with `RequireScopes`/`RequireHuman` from `@dudousxd/nestjs-catalog`;
   * the guard is what reads those declarations.
   */
  guards?: Type<unknown>[];
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
   * What this catalog's types expect of a load: how deleted rows reach each
   * type, and how far one load may move its row count.
   *
   * A `Provider` for {@link CATALOG_LOAD_EXPECTATIONS}, alongside `em` and
   * `registry` and for the same reason — it is a thing only the host can say,
   * and a library that guessed it would be guessing about somebody else's data.
   * A module in `imports` that exports the token still works and always did;
   * this is the seam for the far more common host that has no natural module to
   * hang it on and was otherwise writing one for a single `useValue`.
   *
   * **A host running incremental connectors declares them here or an operator
   * declares them through the API, and this is the layer that wins.** The
   * refusals ship on: an incremental load of a type with no declared delete
   * strategy does not commit, on any path — connector, workflow sink, or an
   * application POSTing to the publish API. What satisfies that is a strategy
   * from either layer; what this one buys is that a type named in `byType` can
   * no longer be changed from the API at all, which is how a deployment pins a
   * type it has argued about. See `PUT <path>/pipeline/expectations/:type` and
   * `resolveLoadExpectation` for the precedence. That is
   * deliberate. An incremental read asks its source for what changed since a
   * watermark, a row deleted at the source never changes again, so it is never
   * returned again and the carry-forward copies it into every later snapshot
   * indefinitely. Nothing goes wrong at any step; the catalog simply never finds
   * out, and no freshness signal can report it. What is being asked for is not
   * a fix — it is that somebody chose, and wrote down why.
   *
   * ```ts
   * CatalogPipelineModule.forRoot({
   *   // …em, registry, imports…
   *   expectations: {
   *     provide: CATALOG_PIPELINE_TOKENS.expectations,
   *     useValue: {
   *       // Applied to every type with no entry of its own.
   *       default: { rowCount: { maxShrink: 0.5, minRows: 100 } },
   *       byType: {
   *         AuditEvent: {
   *           deletes: { strategy: 'accepted', because: 'append-only ledger, nothing is removed' },
   *         },
   *         Employee: {
   *           deletes: {
   *             strategy: 'soft-deleted-at-source',
   *             because: 'HR sets deleted_at, so the watermark sees the removal',
   *             column: 'deleted_at',
   *           },
   *         },
   *         Mvr: {
   *           deletes: {
   *             strategy: 'periodic-full-reload',
   *             because: 'the nightly connector reads the whole fleet',
   *             withinMs: 86_400_000,
   *           },
   *           rowCount: { maxShrink: 0.3 },
   *         },
   *       },
   *     } satisfies CatalogLoadExpectations,
   *   },
   * })
   * ```
   *
   * Three things worth knowing before writing that object:
   *
   * - **`because` is a required field**, and an empty one is refused as hard as
   *   an absent strategy. It is the only part of the decision still legible in
   *   six months, when somebody is asking why the count does not match the
   *   source.
   * - **`periodic-full-reload` is the one strategy that is policed.** Once the
   *   newest full snapshot of the type is older than `withinMs`, incremental
   *   loads of it stop committing — which is how an interval becomes a
   *   mechanism rather than a note.
   * - **The row-count bound applies with no configuration at all**, at
   *   `maxShrink: 0.5` above `minRows: 100`, plus an absolute rule at any size:
   *   a snapshot of zero rows never replaces a non-empty one. Growth is
   *   unbounded until a type sets `maxGrowth`. One load that is legitimately
   *   smaller is admitted by acknowledging it — `_expectShrink` in the labels
   *   of a publish, or `expectShrink` on a by-hand `ConnectorRunnerService.run`
   *   — rather than by raising the bound, which would stand it down for every
   *   later load too.
   *
   * Omitting this is a boot that succeeds and says so, once, in a line naming
   * what will happen. Binding an empty object is a different statement — "this
   * host has looked and nothing applies" — and is not warned about. See
   * {@link describeExpectationsBinding}.
   */
  expectations?: Provider;
  /**
   * Which environment variables a connector, a connection or a workflow source
   * node may name as the place its credential lives.
   *
   * **A host that runs any authenticating connector has to bind this**, and a
   * deployment upgrading onto this release has to bind it before the upgrade
   * lands or its connectors stop running. The refusal ships on: a
   * `secretEnvVar` naming anything not on this list is refused, and the caller
   * is told only that no credential is available.
   *
   * That is deliberate and it is the fix. `secretEnvVar` is chosen by whoever
   * writes the connector, and `resolveSecretEnv` did `process.env[name]` with
   * nothing in between — so a principal holding `catalog:write` on one narrow
   * object type could point a connector at `DATABASE_URL`, run it, and read the
   * host application's own database back out of a catalog type at
   * `catalog:read`. Every guard on that path passed honestly; there was simply
   * nothing that asked whether the *name* was one this deployment meant to
   * offer. `secret-env-allowlist.ts` sets out the whole route.
   *
   * ```ts
   * CatalogPipelineModule.forRoot({
   *   // …em, registry, imports, expectations…
   *   secretEnvAllowlist: ['FLEET_DB_URL', 'DPAS_API_TOKEN', 'VENDOR_*'],
   * })
   * ```
   *
   * Three things worth knowing before writing that array:
   *
   * - **An entry is an exact name or a prefix ending in one `*`.** A `*`
   *   anywhere else is refused at boot rather than interpreted — `*_URL` reads
   *   like a tidy way to admit connection strings and it admits `DATABASE_URL`.
   * - **The list to write is already on your screen.** Every connector and
   *   connection shows the variable it reads, as `Credential env var`; the
   *   union of those is the migration.
   * - **`['*']` is the escape hatch and is not a policy.** It restores the
   *   previous behaviour — every variable in the pod readable by anyone who can
   *   write a connector — and warns at every boot. It exists so an upgrade under
   *   time pressure has one honest, greppable line rather than a pin to the
   *   previous release.
   *
   * Omitting this falls through to `CATALOG_SECRET_ENV_ALLOW` in the
   * environment, comma- or whitespace-separated, which is the same policy for
   * the operator who owns the manifest rather than the code. When both are set
   * **this option wins**, and the boot line says which is in force — so setting
   * the variable and seeing nothing change has an answer on screen. Binding
   * neither is a boot that succeeds and warns, naming both levers.
   *
   * Not a `Provider`, unlike `expectations`, and the asymmetry is forced rather
   * than chosen: the fetchers reach the credential through a free function
   * called from four places, one of which is a controller this module does not
   * construct, and a policy that had to be injected would be a policy one of
   * them could be written without. See {@link installSecretEnvAllowlist}.
   */
  secretEnvAllowlist?: readonly string[];
  /**
   * Whether THIS process runs the scheduler loop. Default true. A host that
   * splits API and worker roles should pass false on the roles that do not poll
   * — not for safety (a duplicate start is a no-op, the run id is derived from
   * the cron fire time) but so every replica does not read the store on a timer.
   */
  scheduler?: boolean;
  /**
   * Whether THIS process wraps pre-workflow connectors into workflows at boot.
   * Defaults to whatever {@link scheduler} is, and then to true.
   *
   * The default is the interesting part. It is deliberately *not* an
   * independent `true`: adoption writes, and the same reasoning that stops every
   * replica polling the store on a timer stops every replica racing to wrap the
   * same twelve connectors. Defaulting it to the scheduler's answer means a host
   * that has already declared which pods do the background work does not have to
   * declare it a second time — and a second lever that has to be kept in step
   * with the first is a second lever somebody forgets.
   *
   * Passing false everywhere is supported and its consequence is stated rather
   * than hidden: any connector predating workflows keeps running exactly as it
   * is, and no route can edit it. See {@link ConnectorAdoption}.
   */
  adoptConnectors?: boolean;
  /**
   * Whether THIS process closes run rows whose durable run the engine has
   * finished with. Defaults to whatever {@link scheduler} is, and then to true.
   *
   * The third thing on that axis and defaulted the same way as
   * {@link adoptConnectors}, for the same reason: it writes, and six replicas
   * racing to close one row is six copies of the warning about it.
   *
   * Passing false everywhere is supported and its consequence is stated rather
   * than hidden: a durable run that dies before reaching its finish step — an
   * execution timeout, a cancellation, a worker that never resumed — leaves a
   * row marked `running` with no error, and nothing will ever revisit it,
   * because the next run of that pipeline mints a new snapshot. The
   * next-attempt rule still covers a step being retried. See
   * {@link AbandonedRunReconciler}.
   */
  reconcileRuns?: boolean;
  /** Passed to `SubprocessTransformRunner` for Python transforms. */
  pythonVenv?: string;
}

/**
 * Fetch, transform, publish — the connector pipeline, as a module.
 *
 * This was application code, copied between the applications that needed it,
 * which is why it is a package now. The copies had already drifted: one of them
 * had no scheduler at all, so `connector.schedule` was a column nothing acted on
 * until it was ported across by hand. That is the failure duplication always
 * produces eventually, and the reason the engine belongs in one place.
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
    // Here rather than in a provider, and it is the one side effect in this
    // method. The policy has to be in force before anything can resolve a
    // credential, and the earliest thing that can resolve one is the scheduler
    // — which starts on a timer from `onApplicationBootstrap`, the same hook a
    // provider installing this would run in, with no ordering between them. A
    // module built is strictly before a module booted, so this cannot lose that
    // race. A malformed pattern throws from here, which is a boot that fails
    // naming the pattern rather than a boot that succeeds and refuses every
    // load for a reason that reads like the allow-list working.
    if (options.secretEnvAllowlist) installSecretEnvAllowlist(options.secretEnvAllowlist);

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
        // Defaulted to the scheduler's own answer rather than to `true`, which
        // is the difference between one process adopting and every replica
        // adopting. A host that has said "this pod does not run schedules" has
        // already said which pods do the writing; making it say so twice is how
        // the two come to disagree.
        provide: CATALOG_ADOPT_CONNECTORS,
        useValue: options.adoptConnectors ?? options.scheduler ?? true,
      },
      {
        // Same axis, same default, and the same argument: one process does the
        // background writing. See `CatalogPipelineModuleOptions.reconcileRuns`.
        provide: CATALOG_RECONCILE_RUNS,
        useValue: options.reconcileRuns ?? options.scheduler ?? true,
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
      WorkflowLauncher,
      ConnectionChecker,
      ConnectorScheduler,
      ConnectorAdoption,
      AbandonedRunReconciler,
      LoadExpectationsAnnouncer,
      SecretEnvAllowlistAnnouncer,
      ConnectorRunSteps,
      ConnectorRunWorkflow,
      WorkflowRunSteps,
      CatalogWorkflowRunWorkflow,
    ];

    // Only when the host gave one. Binding the token unconditionally — to
    // `undefined`, say — would make this module's own provider shadow a token
    // exported by a module in `imports`, which is how every host that already
    // binds these does it. The two ways in stay compatible, and when a host uses
    // both, the nearer one wins: a provider declared here beats one imported,
    // which is Nest's ordinary rule and the one anybody debugging it will reach
    // for first.
    if (options.expectations) providers.push(options.expectations);

    // No path, no controllers: a worker-only host runs the engine and the
    // scheduler and serves nothing.
    const controllers = options.path
      ? [
          createPipelineController(options.path, options.guards ?? []),
          createPublishController(options.path, options.guards ?? []),
        ]
      : [];

    return {
      module: CatalogPipelineModule,
      imports: options.imports,
      controllers,
      providers,
      exports: [
        PublishService,
        ConnectorRunnerService,
        WorkflowRunnerService,
        WorkflowLauncher,
        ConnectionChecker,
        // Exported because a host's own controllers need it: this module owns the
        // instance (it is the one configured with `pythonVenv`), and a host that
        // provided a second one would be running transforms through a runner
        // configured somewhere else. Nest resolves a controller's dependencies
        // from the module that declares it, so without this the host fails at
        // boot with "SubprocessTransformRunner is not available".
        SubprocessTransformRunner,
      ],
    };
  }
}

/** Re-exported so a host can name the providers it is asked to supply. */
export const CATALOG_PIPELINE_TOKENS = {
  em: CATALOG_PIPELINE_EM,
  registry: CATALOG_PIPELINE_REGISTRY,
  scope: CATALOG_PIPELINE_SCOPE,
  schedulerEnabled: CATALOG_SCHEDULER_ENABLED,
  adoptConnectors: CATALOG_ADOPT_CONNECTORS,
  reconcileRuns: CATALOG_RECONCILE_RUNS,
  expectations: CATALOG_LOAD_EXPECTATIONS,
} as const;

/**
 * What to say at boot about the load expectations this host bound.
 *
 * **An absent binding and an empty one are different statements, and only one
 * of them is worth interrupting somebody about.** The refusal they produce is
 * identical — `expectationFor` reads a missing policy and an empty policy the
 * same way, and every incremental load of an undeclared type is refused either
 * way — so this is not about behaviour. It is about which of the two a reader
 * is looking at:
 *
 * - **Nothing bound.** Nobody has thought about deletes here, and the first
 *   incremental connector to run will be refused by something the boot log
 *   never mentioned. That is a surprise, and it is cheap to remove: one line,
 *   naming the token and what happens without it.
 * - **Bound and empty.** Somebody looked, decided nothing applies, and wrote it
 *   down — the same act as `because` on a strategy. Warning about it would be
 *   telling a host off for having answered, and a warning that fires on the
 *   correct configuration is a warning people learn to filter.
 *
 * Returned rather than logged so the sentences can be tested without reading a
 * log, and so the one caller that logs them stays a three-line class.
 */
export function describeExpectationsBinding(expectations: CatalogLoadExpectations | undefined): {
  level: 'warn' | 'log';
  message: string;
} {
  if (!expectations) {
    return {
      level: 'warn',
      message: `Nothing binds CATALOG_LOAD_EXPECTATIONS, so this deployment declares nothing in code about how rows deleted at a source reach a type — and every incremental load will be refused at the merge unless an operator has stored an expectation for that type through PUT <path>/pipeline/expectations/:type. Bind it as CatalogPipelineModule.forRoot({ expectations }), or export the token from a module in imports. Row counts are still bounded meanwhile, at the built-in maxShrink ${DEFAULT_ROW_COUNT_BOUND.maxShrink} above ${DEFAULT_ROW_COUNT_BOUND.minRows} rows. A host that has looked and decided nothing applies binds an empty object, which this line stops asking about.`,
    };
  }

  const declared = Object.keys(expectations.byType ?? {});
  if (declared.length === 0 && !expectations.default) {
    return {
      level: 'log',
      message:
        'Load expectations are bound and declare nothing: no default and no types. Taken as said rather than as missing — nothing is pinned in code, so every incremental load stays refused until an operator stores an expectation for its type, and the row-count bound stays at its built-in value.',
    };
  }

  // Named rather than counted. The question this line answers on the morning
  // after a deploy is "did my entry take?", and a number cannot answer it.
  return {
    level: 'log',
    message: `Load expectations declared for ${declared.length} type(s)${
      declared.length > 0 ? `: ${declared.join(', ')}` : ''
    }${expectations.default ? ', over a house default' : ', with no house default'}.`,
  };
}

/**
 * Says once, at boot, which of those two a host is running.
 *
 * A provider rather than a branch inside `forRoot`, because `forRoot` cannot
 * tell the difference it is reporting on: at the time it builds the module the
 * only thing it knows is whether IT was handed a provider, and a host binding
 * the token from a module in `imports` — the way every host did before the
 * option existed — would be warned at exactly the moment it had done the right
 * thing. Injecting the token is the only question whose answer covers both
 * routes in.
 */
@Injectable()
class LoadExpectationsAnnouncer implements OnApplicationBootstrap {
  // Named for the token rather than for this class: the reader of the line
  // cares which binding it is about, and `LoadExpectationsAnnouncer` is an
  // implementation detail they cannot grep for in their own configuration.
  private readonly logger = new Logger('CatalogLoadExpectations');

  constructor(
    @Optional()
    @Inject(CATALOG_LOAD_EXPECTATIONS)
    private readonly expectations?: CatalogLoadExpectations,
  ) {}

  onApplicationBootstrap(): void {
    const { level, message } = describeExpectationsBinding(this.expectations);
    if (level === 'warn') this.logger.warn(message);
    else this.logger.log(message);
  }
}

/**
 * Says once, at boot, which credentials this deployment will let a connector
 * read.
 *
 * The refusal it is announcing is correct and arrives far too late to be the
 * first anybody hears of it: an operator whose upgrade turned every
 * authenticating connector off would otherwise learn that from a run at three in
 * the morning being told — correctly, and by design — that it may not say why.
 * One line at boot, naming both levers, is what makes the fail-closed default
 * survivable.
 *
 * A provider rather than a branch inside `forRoot`, for the same reason
 * {@link LoadExpectationsAnnouncer} is: `forRoot` knows only whether IT was
 * handed a list, and the operator who set `CATALOG_SECRET_ENV_ALLOW` in the
 * manifest would be warned at exactly the moment they had done the right thing.
 * Reading the effective policy is the only question whose answer covers both
 * routes in.
 */
@Injectable()
class SecretEnvAllowlistAnnouncer implements OnApplicationBootstrap {
  // Named for the thing being announced rather than for this class, and the same
  // name `resolveSecretEnv` logs its refusals under — so an operator told to
  // read the log for the reason a credential was unavailable has one context to
  // filter on and finds the boot line sitting in it.
  private readonly logger = new Logger('CatalogSecretEnv');

  onApplicationBootstrap(): void {
    const { level, message } = describeSecretEnvAllowlist(
      secretEnvAllowlist(),
      secretEnvAllowlistSource(),
    );
    if (level === 'warn') this.logger.warn(message);
    else this.logger.log(message);
  }
}

/** Re-exported so a deployment can name the variable it has to set. */
export { SECRET_ENV_ALLOW_VAR };

export type { Type };
