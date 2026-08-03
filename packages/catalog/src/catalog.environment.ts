/**
 * Which copy of the world a caller is looking at.
 *
 * A catalog that only ever has one copy of everything is a catalog where the
 * first time a transform runs against real data is the time it runs against the
 * data people depend on. Environments fix that, and the whole design turns on
 * one distinction that is easy to blur and expensive to get wrong:
 *
 * - **Data never moves between environments.** Not by a button, not by an
 *   export, not by an accident of a missing `WHERE` clause. Production's rows
 *   are production's, and dev's rows are whatever dev loaded for itself.
 * - **Configuration is promoted between them.** The model (object types and the
 *   labels somebody curated onto them) and the pipeline (connectors, transforms)
 *   are things you write once, try in dev, and then *release* to production.
 *
 * Isolation is therefore physical — one database per environment, so a
 * statement issued on the dev connection cannot name a production table — and
 * promotion is a deliberate, previewable release rather than a copy. See
 * {@link planPromotion} for exactly what crosses and what is refused.
 *
 * This is not the same axis as a durable *tenant*. A tenant answers "who
 * executes this work"; an environment answers "which copy of the world is it
 * executing against". They are related only in that each environment must get
 * its own durable keyspace ({@link durableKeyspaceFor}), for the reason spelled
 * out there.
 */

import { createHash } from 'node:crypto';
// Type-only, and from the file that owns these vocabularies rather than a
// second copy of them. A promotable connector whose `kind` was merely a string
// would have to be re-narrowed on the way into the store, and a re-narrowing
// that falls back to a default turns "the kind you chose" into "the kind that
// happened to be first" — which is precisely the drift `isConnectorKind` exists
// to prevent.
import type {
  ConnectorKind,
  TransformLanguage,
  WorkflowEdge,
  WorkflowNode,
} from './catalog.pipeline';

/**
 * Where a request declares its environment.
 *
 * A header rather than a subdomain or a port, because the whole point is that
 * one deployment can serve several environments and the choice has to be
 * visible in the request itself — a proxy rule or a DNS entry is a place the
 * answer can be wrong without anybody reading it.
 */
export const CATALOG_ENVIRONMENT_HEADER = 'x-catalog-environment';

/**
 * The query-parameter spelling, for a browser that cannot set a header — a
 * `<img>` pointing at an embedded chart, a link somebody pastes into a ticket.
 *
 * Deliberately *lower* precedence than the header (see
 * {@link environmentIdFromRequest}). A query string travels in referrers, logs
 * and bookmarks; a header does not, so when both are present the one that was
 * set deliberately by the client wins.
 */
export const CATALOG_ENVIRONMENT_QUERY = 'environment';

/** An environment's name. Short, lowercase, and safe as a SQL identifier. */
export type CatalogEnvironmentId = string;

/**
 * Deliberately narrow, and narrow for a reason that is not aesthetic.
 *
 * An environment id becomes a database name, a MikroORM context name and a
 * Redis key prefix. All three are places where a hyphen, a quote or a
 * non-ASCII character turns into either a syntax error at the worst possible
 * moment or, worse, an identifier that has to be quoted and therefore an
 * identifier somebody will eventually forget to quote. Twenty-four characters
 * is well inside MySQL's 64-character limit even after a database-name prefix
 * is glued on.
 */
const ENVIRONMENT_ID_PATTERN = /^[a-z][a-z0-9_]{0,23}$/;

/**
 * Names an environment may not take.
 *
 * `default` is the important one and it is here for the same reason the durable
 * module refuses it as a tenant: "default" is the value that means "no
 * namespace at all", so an environment called `default` would derive the bare
 * keyspace and quietly share a results queue with every other engine on the
 * Redis. The rest are MySQL's own schemas, which an environment must never be
 * pointed at.
 */
const RESERVED_ENVIRONMENT_IDS: readonly string[] = [
  'default',
  'information_schema',
  'mysql',
  'performance_schema',
  'sys',
];

export function isEnvironmentId(value: unknown): value is CatalogEnvironmentId {
  return (
    typeof value === 'string' &&
    ENVIRONMENT_ID_PATTERN.test(value) &&
    !RESERVED_ENVIRONMENT_IDS.includes(value)
  );
}

/**
 * Narrows an id or throws, with the rule in the message.
 *
 * Throwing rather than sanitising: an id that had to be repaired is an id that
 * no longer matches whatever the operator wrote in their configuration, and the
 * two would disagree about which database the environment lives in.
 */
export function assertEnvironmentId(value: unknown): CatalogEnvironmentId {
  if (isEnvironmentId(value)) return value;
  const shown = typeof value === 'string' ? `"${value}"` : String(value);
  throw new Error(
    `${shown} is not a usable environment id. It must match ${ENVIRONMENT_ID_PATTERN} and must not be one of ${RESERVED_ENVIRONMENT_IDS.join(', ')} — an environment id becomes a database name, a connection name and a Redis key prefix, so it cannot be repaired for you without the repaired name disagreeing with the one in your configuration.`,
  );
}

/**
 * One copy of the world.
 *
 * Everything that distinguishes an environment from its siblings is a physical
 * address of some kind, which is the point: there is no field here that a
 * `WHERE` clause could be built out of, because a filter is precisely the sort
 * of isolation that fails silently the one time somebody forgets it.
 */
export interface CatalogEnvironment {
  id: CatalogEnvironmentId;
  displayName: string;
  /**
   * The physical database this environment's tables live in.
   *
   * Not a schema *within* a shared database, and in MySQL those are the same
   * word anyway — `CREATE SCHEMA` is an alias for `CREATE DATABASE`. What
   * matters is that the store's table names are fixed (`catalog_object_type`,
   * `obj_<type>`) and carry no environment in them, so two environments in one
   * database would collide on every table. Separate databases make the
   * collision impossible and make MySQL's own `GRANT` the enforcement point.
   */
  databaseName: string;
  /**
   * The MikroORM context name this environment's connection is registered
   * under. Feeds `CatalogMikroOrmStoreModule.forRoot({ contextName })`.
   */
  contextName: string;
  /** The durable keyspace. Always derived — see {@link durableKeyspaceFor}. */
  durableKeyspace: string;
  /**
   * How far along the release path this environment sits. Lower is earlier.
   *
   * Its only job is to let a promotion refuse to run backwards. Promoting
   * production's connectors into dev sounds harmless and is not: it would
   * overwrite the very edits somebody is in the middle of testing, and the
   * lost work has no version to recover from.
   */
  rank: number;
  /**
   * Whether this environment refuses changes that did not arrive as a reviewed
   * promotion.
   *
   * True for production. It does not lock the environment — an operator can
   * still fix something by hand — it means the API demands the explicit
   * confirmation described on {@link CatalogPromotionApproval} rather than
   * accepting a plan somebody generated in another tab ten minutes ago.
   */
  protected: boolean;
}

/**
 * The caller named no environment.
 *
 * Its own class, and never folded into "unknown environment", because the two
 * have different fixes: this one is a client that has not been taught to say
 * which world it wants, and the other is a client that named one nobody has
 * created. A single error message would send everybody to the wrong place.
 */
export class UnresolvedEnvironmentError extends Error {
  constructor() {
    super(
      `No environment was named on this request. Send the "${CATALOG_ENVIRONMENT_HEADER}" header (or "?${CATALOG_ENVIRONMENT_QUERY}="). There is deliberately no default: the environment that a silent default would pick is production, and a request that reached production because nobody said otherwise is exactly the accident environments exist to prevent.`,
    );
  }
}

/** The caller named an environment this deployment does not run. */
export class UnknownEnvironmentError extends Error {
  constructor(
    readonly requested: string,
    known: readonly CatalogEnvironmentId[],
  ) {
    super(
      `"${requested}" is not an environment this catalog runs. Known: ${known.join(', ') || '(none configured)'}.`,
    );
  }
}

/**
 * Reads the requested environment id off a request, without deciding whether it
 * exists.
 *
 * Total and side-effect free so it can be used anywhere a request-like object
 * is in hand — a guard, a middleware, a test. Returns undefined rather than
 * throwing, because "nobody said" and "they said something wrong" are different
 * refusals and the caller is the one that knows which message to produce.
 */
export function environmentIdFromRequest(request: unknown): string | undefined {
  if (!request || typeof request !== 'object') return undefined;

  const headers = Reflect.get(request, 'headers');
  if (headers && typeof headers === 'object') {
    const presented = Reflect.get(headers, CATALOG_ENVIRONMENT_HEADER);
    if (typeof presented === 'string' && presented.length > 0) return presented;
    // Node lowercases incoming header names, but a caller constructing a
    // request-like object by hand may not have. Checking both costs nothing and
    // removes a class of "it works in production and not in the test".
    const upper = Reflect.get(headers, CATALOG_ENVIRONMENT_HEADER.toUpperCase());
    if (typeof upper === 'string' && upper.length > 0) return upper;
  }

  const query = Reflect.get(request, 'query');
  if (query && typeof query === 'object') {
    const named = Reflect.get(query, CATALOG_ENVIRONMENT_QUERY);
    if (typeof named === 'string' && named.length > 0) return named;
  }

  return undefined;
}

/**
 * Turns a request into exactly one environment, or refuses.
 *
 * There is no fallback branch in this function and there must never be one.
 * The failure this prevents is the one that has no symptom: a request that
 * meant dev and was served by production returns perfectly plausible rows, and
 * the only way anybody finds out is by noticing later that a number is wrong.
 */
export function resolveEnvironment(
  request: unknown,
  known: readonly CatalogEnvironment[],
): CatalogEnvironment {
  const requested = environmentIdFromRequest(request);
  if (!requested) throw new UnresolvedEnvironmentError();

  const found = known.find((environment) => environment.id === requested);
  if (!found) {
    throw new UnknownEnvironmentError(
      requested,
      known.map((environment) => environment.id),
    );
  }
  return found;
}

/**
 * The Redis keyspace an environment's durable engine owns.
 *
 * Derived rather than configured, and that is the whole safety property. A
 * deployment that sets `DURABLE_TENANT` by hand per environment has a
 * copy-paste away from two environments on one keyspace, and the resulting
 * failure is the one this project has already lived through: every
 * `BullMQTransport` built on the bare `durable-*` prefix consumes a *single*
 * `durable-results` queue, so one engine silently eats another's step results,
 * the originating run's checkpoint stays `pending` forever, and nothing
 * anywhere logs a word about it.
 *
 * The prefix keeps environments of different *services* apart on a shared
 * Redis; the environment id keeps environments of this service apart from each
 * other. Both halves are needed: `dev` alone would collide with any other
 * product's dev engine.
 */
export function durableKeyspaceFor(
  environmentId: CatalogEnvironmentId,
  prefix = 'catalog',
): string {
  const id = assertEnvironmentId(environmentId);
  const keyspace = `${prefix}-${id}`;
  // Belt and braces. `assertEnvironmentId` already refuses "default", but this
  // is the exact string whose meaning is "no namespace", and the cost of
  // checking the composed value as well is one comparison against a constant.
  if (keyspace === 'default') {
    throw new Error(
      `A durable keyspace of "default" means the bare durable-* prefix, which is how two engines end up consuming each other's results queue.`,
    );
  }
  return keyspace;
}

/**
 * The database name an environment's tables live in.
 *
 * Composed here so the same rule is used by the thing that creates the database
 * and the thing that connects to it. An operator may still override it per
 * environment; what they may not do is have the two disagree.
 */
export function catalogDatabaseNameFor(base: string, environmentId: CatalogEnvironmentId): string {
  return `${base}_${assertEnvironmentId(environmentId)}`;
}

// -----------------------------------------------------------------------------
// Attribution.
// -----------------------------------------------------------------------------

/**
 * An audit event, told with the environment it happened in.
 *
 * With a database per environment the environment is *implied* by which
 * database the row sits in, and for a single-environment read that is enough.
 * It stops being enough the moment anyone asks a governance question across
 * environments — "everything this person did this week" has to be answerable
 * without the reader having to remember which of three lists they are looking
 * at — so the environment is stamped onto every event as it leaves its store.
 *
 * Stamped on read rather than stored in a column on purpose: a stored column
 * can be wrong, because nothing in the database stops a row in the production
 * table saying `environment: "dev"`. A value derived from which connection the
 * row was read through cannot be.
 */
export interface EnvironmentStampedAuditEvent {
  environment: CatalogEnvironmentId;
}

/** Stamps a batch of events with the environment they were read from. */
export function stampEnvironment<T>(
  environment: CatalogEnvironmentId,
  events: readonly T[],
): Array<T & EnvironmentStampedAuditEvent> {
  return events.map((event) => ({ ...event, environment }));
}

// -----------------------------------------------------------------------------
// Promotion: moving configuration, and refusing to move anything else.
// -----------------------------------------------------------------------------

/** What a promotion is allowed to carry. */
export const PROMOTABLE_KINDS = [
  /** The model: a type and its properties, including curated labels. */
  'objectType',
  /** The code that shapes rows. */
  'transform',
  /**
   * The graph that wires transforms together.
   *
   * Listed after the transforms it names and before the connectors that run it,
   * because this order is also the order an apply walks: a graph arriving
   * before its code, or a connector before its graph, points at something
   * missing for as long as the apply takes.
   */
  'workflow',
  /** The declaration of a load: what it reads, through what, on what schedule. */
  'connector',
] as const;

export type PromotableKind = (typeof PROMOTABLE_KINDS)[number];

export function isPromotableKind(value: unknown): value is PromotableKind {
  return PROMOTABLE_KINDS.some((kind) => kind === value);
}

/**
 * Connector fields a promotion never carries, and why each one would be a bug.
 *
 * - `state` is where the last run got to — a watermark, a continuation token, a
 *   last-seen id. Carrying dev's watermark into production tells production it
 *   has already read everything up to that point, so the next production run
 *   skips real data and reports success. Carrying production's into dev makes
 *   dev replay. Either way the corruption is invisible: both runs finish green.
 * - `lastRunAt` / `lastRunStatus` describe something that happened in the other
 *   environment. A production connector showing a green run it never performed
 *   is a lie told by the screen people check first.
 * - `secretEnvVar` names the credential. It is only a *name*, so promoting it
 *   leaks nothing — but the name is how the environment finds its own key, and
 *   production reading `DEV_WAREHOUSE_PASSWORD` is production pointed at dev.
 * - `enabled` is withheld on create only, so a newly promoted connector arrives
 *   switched off. Arriving enabled means the first scheduler tick runs, in
 *   production, code nobody has yet watched run there. On update the target
 *   keeps whatever it had: re-promoting a transform must not silently
 *   re-enable a connector an operator deliberately turned off.
 */
export const PROMOTION_WITHHELD_CONNECTOR_FIELDS: readonly string[] = [
  'state',
  'lastRunAt',
  'lastRunStatus',
  'secretEnvVar',
  'enabled',
];

/**
 * A connection is matched, never copied — every field of it is withheld.
 *
 * A connection *is* an address and a credential reference, and those are the
 * two things that most define what an environment is. Promoting dev's
 * connection config into production would repoint production at the dev
 * database, and the load that followed would be a successful load of the wrong
 * data. So promotion requires a connection with the same id to already exist in
 * the target, configured by whoever owns that environment, and reports its
 * absence as a blocker rather than creating one.
 */
export const PROMOTION_WITHHELD_CONNECTION_FIELDS: readonly string[] = [
  'config',
  'secretEnvVar',
  'lastCheckedAt',
  'lastCheckOk',
  'lastCheckError',
];

/** A type and its properties, reduced to what a promotion carries. */
export interface PromotableObjectType {
  name: string;
  /**
   * The application that publishes this type.
   *
   * Carried on create and never on update, which is why it is absent from
   * {@link diffObjectType}'s field list. It has to be carried at all because a
   * type owned by nobody in the target is a type its publisher would be refused
   * from publishing into — the store checks ownership by exactly this string.
   * It must never be *changed* by a promotion, because that would be a way to
   * take a type away from the application that owns it without anybody
   * approving an ownership change.
   */
  ownerPrincipalId: string;
  displayName: string;
  pluralDisplayName: string;
  description?: string;
  icon?: string;
  group: string;
  titleProperty?: string;
  primaryKey: string[];
  properties: Array<{
    name: string;
    displayName: string;
    description?: string;
    type: string;
    sourceColumn: string;
    nullable: boolean;
    primary: boolean;
    hidden: boolean;
    position: number;
    unit?: string;
    classification?: string;
  }>;
}

export interface PromotableTransform {
  id: string;
  name: string;
  description?: string;
  language: TransformLanguage;
  code: string;
  /** The source's version, carried for the record only — see {@link planPromotion}. */
  version: number;
}

export interface PromotableConnector {
  id: string;
  name: string;
  description?: string;
  kind: ConnectorKind;
  targetType: string;
  config: Record<string, unknown>;
  connectionId?: string;
  transformId?: string;
  /**
   * The graph it runs, when it runs one instead of a single transform.
   *
   * Carried for the same reason `transformId` is: a connector promoted without
   * the thing that shapes its rows arrives pointing at nothing. It was missed
   * once already — workflows were added to the connector while this file was
   * being written — and the symptom would have been a load failing on its first
   * scheduled run in the target, which is the worst place to find out.
   */
  workflowId?: string;
  schedule?: string;
  mode?: 'full' | 'incremental';
}

/**
 * A workflow as promotion sees it.
 *
 * `graphHash` rather than `version` is what decides whether two environments
 * hold the same graph. A version counts edits inside one database, so dev's v7
 * and production's v7 are unrelated numbers; the hash is over the nodes, their
 * executable config and the edges in order, so it means the same thing in both
 * places. Comparing versions across environments would report a difference
 * every time somebody edited dev twice and production once, and agreement every
 * time the counts happened to line up.
 */
export interface PromotableWorkflow {
  id: string;
  name: string;
  description?: string;
  targetType: string;
  graphHash: string;
  version: number;
  // The real graph types, not an opaque blob. A promotion that carried nodes as
  // `unknown` would push the narrowing onto whoever applies it, and the store
  // that receives them would have to re-validate a shape this side already had.
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

/** A connection as promotion sees it: an identity to match against, nothing more. */
export interface PromotionConnectionRef {
  id: string;
  name: string;
  kind: ConnectorKind;
}

/** Everything promotable, read out of one environment. */
export interface CatalogPromotableSet {
  objectTypes: PromotableObjectType[];
  transforms: PromotableTransform[];
  workflows: PromotableWorkflow[];
  connectors: PromotableConnector[];
  connections: PromotionConnectionRef[];
}

export type PromotionAction = 'create' | 'update' | 'unchanged';

/** One field that would change, with both sides shown. */
export interface PromotionFieldDiff {
  field: string;
  from: unknown;
  to: unknown;
}

export interface CatalogPromotionChange {
  kind: PromotableKind;
  id: string;
  name: string;
  action: PromotionAction;
  fields: PromotionFieldDiff[];
  /** Things a reviewer should read before approving. Never fatal. */
  notes: string[];
}

/**
 * Something that makes the plan unappliable.
 *
 * A blocker is not a warning. The plan is reported in full so a reviewer can
 * see everything that *would* happen, and then refused, because a promotion
 * that applies the half it can and skips the half it cannot leaves the target
 * in a state neither environment ever had.
 */
export interface CatalogPromotionBlocker {
  kind: PromotableKind | 'connection';
  id: string;
  name: string;
  reason: string;
}

/** Something the promotion deliberately left behind, named so the preview says so. */
export interface CatalogPromotionWithheld {
  kind: PromotableKind | 'connection';
  id: string;
  name: string;
  fields: readonly string[];
  why: string;
}

export interface CatalogPromotionPlan {
  from: CatalogEnvironmentId;
  to: CatalogEnvironmentId;
  createdAt: string;
  changes: CatalogPromotionChange[];
  blockers: CatalogPromotionBlocker[];
  withheld: CatalogPromotionWithheld[];
  /**
   * A hash of exactly what this plan would do.
   *
   * The point of a preview is that somebody read it. Without a fingerprint the
   * apply call is a fresh promotion that happens to have been preceded by a
   * preview, and anything that changed in between — a colleague editing the
   * transform, a connector deleted — goes in unreviewed. The apply endpoint
   * demands this value back, recomputes the plan, and refuses if the two
   * differ. That is what turns "we show a diff" into "you approved this diff".
   */
  fingerprint: string;
}

/**
 * The audit event name a completed promotion records.
 *
 * Deliberately *not* added to `CATALOG_EVENTS` and not emitted through
 * `emitCatalog`. That channel is for things the library itself does during a
 * load, and it is consumed by a recorder that writes wherever its workspace
 * store points — which, with environments in play, is whichever environment
 * happens to be in scope. A promotion is the one act that is genuinely about
 * two environments at once, so its record is written directly into the target's
 * audit table by the code that performed it, where there is no question about
 * which environment the row belongs to.
 */
export const PROMOTION_AUDIT_EVENT = 'promotion.applied';

/** What an apply call must present to prove which plan was approved. */
export interface CatalogPromotionApproval {
  fingerprint: string;
  /** Free text the operator typed. Recorded in the audit trail, never parsed. */
  reason?: string;
}

/**
 * Compute what promoting `source` into `target` would do.
 *
 * Pure, and pure on purpose: this is the function whose output a person reads
 * before agreeing to change production, so it must be runnable against two
 * plain objects, in a test, with no database anywhere near it.
 *
 * **Additive.** Nothing in the target that is absent from the source is
 * touched, let alone deleted. A promotion is a release of the things somebody
 * built, not a mirror of one environment onto another — and a production
 * connector that exists for a reason dev knows nothing about must survive a
 * colleague promoting an unrelated transform.
 *
 * **Version numbers do not cross.** A transform's `version` counts the edits
 * made *in the environment it lives in*. Copying dev's version onto production
 * would make production's own history unreadable — v7 following v3 with nothing
 * in between — so the target bumps its own, and the source version is carried
 * in the change note instead, which is what actually answers "which code is
 * this".
 */
export function planPromotion(input: {
  from: CatalogEnvironmentId;
  to: CatalogEnvironmentId;
  source: CatalogPromotableSet;
  target: CatalogPromotableSet;
  /**
   * Restrict the promotion to specific things, by `kind:id`
   * (`transform:abc`, `objectType:Mvr`). Undefined means everything promotable.
   *
   * Worth having rather than an all-or-nothing release: dev accumulates
   * experiments nobody intends to ship, and a promotion that could only carry
   * every one of them would be a promotion nobody dares run.
   */
  select?: readonly string[];
  now?: () => Date;
}): CatalogPromotionPlan {
  const { from, to, source, target } = input;
  const changes: CatalogPromotionChange[] = [];
  const blockers: CatalogPromotionBlocker[] = [];
  const withheld: CatalogPromotionWithheld[] = [];

  const selected = (kind: PromotableKind, id: string): boolean =>
    input.select === undefined || input.select.includes(`${kind}:${id}`);

  // --- The model -------------------------------------------------------------
  const targetTypes = new Map(target.objectTypes.map((t) => [t.name, t]));
  for (const type of source.objectTypes) {
    if (!selected('objectType', type.name)) continue;
    const existing = targetTypes.get(type.name);
    const fields = diffObjectType(existing, type);
    changes.push({
      kind: 'objectType',
      id: type.name,
      name: type.displayName,
      action: existing ? (fields.length ? 'update' : 'unchanged') : 'create',
      fields,
      notes: existing
        ? []
        : [
            // Worth saying explicitly, because "the type is now in production"
            // reads to most people as "the data is now in production".
            'Creates the type and its physical table in the target. No rows are carried — the table arrives empty and stays empty until something loads into it.',
          ],
    });
  }

  // --- Transforms ------------------------------------------------------------
  const targetTransforms = new Map(target.transforms.map((t) => [t.id, t]));
  for (const transform of source.transforms) {
    if (!selected('transform', transform.id)) continue;
    const existing = targetTransforms.get(transform.id);
    const fields = diffFields(existing, transform, ['name', 'description', 'language', 'code']);
    changes.push({
      kind: 'transform',
      id: transform.id,
      name: transform.name,
      action: existing ? (fields.length ? 'update' : 'unchanged') : 'create',
      fields,
      notes:
        existing && fields.length
          ? [
              `Source is v${transform.version}; the target will bump its own from v${existing.version} to v${existing.version + 1}. Version numbers count edits within an environment and deliberately do not cross.`,
            ]
          : [],
    });
  }

  // --- Workflows -------------------------------------------------------------
  // Before connectors, deliberately: the order changes are listed is the order
  // they must be applied, and a connector arriving before the graph it runs
  // would point at nothing for as long as the apply takes.
  const targetWorkflows = new Map(
    (target.workflows ?? []).map((workflow) => [workflow.id, workflow]),
  );
  for (const workflow of source.workflows ?? []) {
    if (!selected('workflow', workflow.id)) continue;
    const existing = targetWorkflows.get(workflow.id);
    // Compared on the hash, not field by field: node positions and names are in
    // the record but not in the hash, so moving a box on a canvas is correctly
    // reported as nothing to release.
    const fields = diffFields(existing, workflow, [
      'name',
      'description',
      'targetType',
      'graphHash',
    ]);
    changes.push({
      kind: 'workflow',
      id: workflow.id,
      name: workflow.name,
      action: existing ? (fields.length ? 'update' : 'unchanged') : 'create',
      fields,
      notes:
        existing && existing.graphHash !== workflow.graphHash
          ? [
              `The graph itself differs (${existing.graphHash.slice(0, 8)} → ${workflow.graphHash.slice(0, 8)}). Every transform the graph names must already be in ${to} or included here.`,
            ]
          : [],
    });
  }

  // --- Connectors ------------------------------------------------------------
  const targetConnectors = new Map(target.connectors.map((c) => [c.id, c]));
  const targetConnections = new Map(target.connections.map((c) => [c.id, c]));
  const targetTransformIds = new Set(target.transforms.map((t) => t.id));
  const promotedTransformIds = new Set(
    changes.filter((change) => change.kind === 'transform').map((change) => change.id),
  );
  const targetWorkflowIds = new Set((target.workflows ?? []).map((workflow) => workflow.id));
  const promotedWorkflowIds = new Set(
    changes.filter((change) => change.kind === 'workflow').map((change) => change.id),
  );

  for (const connector of source.connectors) {
    if (!selected('connector', connector.id)) continue;
    const existing = targetConnectors.get(connector.id);
    const fields = diffFields(existing, connector, [
      'name',
      'description',
      'kind',
      'targetType',
      'config',
      'connectionId',
      'transformId',
      'workflowId',
      'schedule',
      'mode',
    ]);
    const notes: string[] = [];

    // A connector reads through a connection, and the connection is the one
    // thing that is genuinely per-environment. Requiring it to pre-exist is
    // what stops a promotion from silently repointing the target at the
    // source's database.
    if (connector.connectionId) {
      const match = targetConnections.get(connector.connectionId);
      if (!match) {
        const sourceConnection = source.connections.find(
          (candidate) => candidate.id === connector.connectionId,
        );
        blockers.push({
          kind: 'connection',
          id: connector.connectionId,
          name: sourceConnection?.name ?? connector.connectionId,
          reason: `"${connector.name}" reads through connection ${connector.connectionId}, which does not exist in ${to}. Create it there, pointed at ${to}'s own system and with ${to}'s own credential, and run the preview again. A promotion will not create it: a connection is an address and a credential reference, and copying ${from}'s would point ${to} at ${from}'s data.`,
        });
      } else {
        withheld.push({
          kind: 'connection',
          id: match.id,
          name: match.name,
          fields: PROMOTION_WITHHELD_CONNECTION_FIELDS,
          why: `Matched by id to ${to}'s own "${match.name}". Its address and credential stay exactly as ${to} has them.`,
        });
        if (match.kind !== connector.kind) {
          blockers.push({
            kind: 'connection',
            id: match.id,
            name: match.name,
            reason: `${to}'s connection "${match.name}" is a ${match.kind} connection, but "${connector.name}" expects a ${connector.kind} one. Same id, different kind of system — the load would fail on its first run, or worse, read something that happens to parse.`,
          });
        }
      }
    } else {
      notes.push(
        `Carries its own source configuration rather than reading through a connection, so whatever address is in its config is being promoted verbatim. Check it names something ${to} should be reading.`,
      );
    }

    // A connector pointing at code that is not there is a load that fails on
    // its first scheduled run, at night, in the target — the worst place to
    // discover it. Caught here, where somebody is looking.
    if (
      connector.transformId &&
      !targetTransformIds.has(connector.transformId) &&
      !promotedTransformIds.has(connector.transformId)
    ) {
      blockers.push({
        kind: 'connector',
        id: connector.id,
        name: connector.name,
        reason: `"${connector.name}" runs transform ${connector.transformId}, which is neither in ${to} nor included in this promotion. Add it to the selection, or the connector would arrive pointing at code that does not exist.`,
      });
    }

    // The same hole, one level up. A workflow is a graph of transforms, so a
    // connector arriving without it is worse than one arriving without a
    // transform: nothing about the load is defined at all.
    if (
      connector.workflowId &&
      !targetWorkflowIds.has(connector.workflowId) &&
      !promotedWorkflowIds.has(connector.workflowId)
    ) {
      blockers.push({
        kind: 'connector',
        id: connector.id,
        name: connector.name,
        reason: `"${connector.name}" runs workflow ${connector.workflowId}, which is neither in ${to} nor included in this promotion. Promote the workflow first, or the connector would arrive pointing at a graph that does not exist.`,
      });
    }

    withheld.push({
      kind: 'connector',
      id: connector.id,
      name: connector.name,
      fields: existing
        ? PROMOTION_WITHHELD_CONNECTOR_FIELDS.filter((field) => field !== 'enabled')
        : PROMOTION_WITHHELD_CONNECTOR_FIELDS,
      why: existing
        ? `${to} keeps its own watermark, its own run history, its own credential reference and its own enabled/disabled switch.`
        : `Arrives disabled, with no watermark and no credential reference. Point it at ${to}'s secret and enable it when somebody is watching.`,
    });

    if (!existing) {
      notes.push('Arrives disabled. Enable it in the target once its connection has been checked.');
    }

    changes.push({
      kind: 'connector',
      id: connector.id,
      name: connector.name,
      action: existing ? (fields.length ? 'update' : 'unchanged') : 'create',
      fields,
      notes,
    });
  }

  const createdAt = (input.now?.() ?? new Date()).toISOString();
  return {
    from,
    to,
    createdAt,
    changes,
    blockers,
    withheld,
    fingerprint: fingerprintOf(from, to, changes, blockers),
  };
}

/** Whether a plan may be applied at all. */
export function isPromotable(plan: CatalogPromotionPlan): boolean {
  return plan.blockers.length === 0;
}

/** The changes that actually do something. Used by both the apply and the summary. */
export function effectiveChanges(plan: CatalogPromotionPlan): CatalogPromotionChange[] {
  return plan.changes.filter((change) => change.action !== 'unchanged');
}

/**
 * The hash the apply call has to present back.
 *
 * Built from the *effect* — what would change, from what, to what — and not
 * from the whole plan object, because `createdAt` and the withheld list would
 * make two identical previews taken a second apart disagree. A reviewer who
 * approved a set of changes has approved those changes, not the clock.
 *
 * Blockers are included so that a plan which becomes appliable between the
 * preview and the apply is not accepted under the old fingerprint: "it was
 * blocked when I looked at it" is not approval of the unblocked version.
 */
function fingerprintOf(
  from: string,
  to: string,
  changes: CatalogPromotionChange[],
  blockers: CatalogPromotionBlocker[],
): string {
  const effect = changes
    .filter((change) => change.action !== 'unchanged')
    .map((change) =>
      [
        change.kind,
        change.id,
        change.action,
        change.fields.map((field) => `${field.field}=${stable(field.to)}`).join(','),
      ].join('|'),
    )
    .sort();
  const refusals = blockers
    .map((blocker) => `${blocker.kind}:${blocker.id}:${blocker.reason}`)
    .sort();
  return createHash('sha256')
    .update([from, to, ...effect, '--', ...refusals].join('\n'))
    .digest('hex');
}

/**
 * A stable string for any value, so two structurally equal configs hash the
 * same however their keys happened to be ordered coming out of the database.
 *
 * Key order in a MySQL JSON column is not something either environment
 * controls, so comparing serialised forms without sorting would report a
 * difference on every promotion and train everybody to click through the diff.
 */
function stable(value: unknown): string {
  if (value === undefined) return ' undefined';
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

/** Field-by-field diff over a named subset. Absent target means "all of it is new". */
function diffFields<T extends object>(
  existing: T | undefined,
  incoming: T,
  fields: ReadonlyArray<keyof T & string>,
): PromotionFieldDiff[] {
  const diffs: PromotionFieldDiff[] = [];
  for (const field of fields) {
    const to = incoming[field];
    const from = existing ? existing[field] : undefined;
    if (stable(from) === stable(to)) continue;
    diffs.push({ field, from, to });
  }
  return diffs;
}

/**
 * The model's diff, which needs its own shape because a type's interesting
 * change is usually inside its property list rather than on the type row.
 *
 * Properties are compared as a whole rather than one row per property: a
 * reviewer asking "what changed about Mvr" wants "two properties added, one
 * relabelled", and a diff that emitted forty unchanged property entries to say
 * it would be a diff nobody reads.
 */
function diffObjectType(
  existing: PromotableObjectType | undefined,
  incoming: PromotableObjectType,
): PromotionFieldDiff[] {
  const diffs = diffFields(existing, incoming, [
    'displayName',
    'pluralDisplayName',
    'description',
    'icon',
    'group',
    'titleProperty',
    'primaryKey',
  ]);

  const before = new Map((existing?.properties ?? []).map((property) => [property.name, property]));
  const after = new Map(incoming.properties.map((property) => [property.name, property]));

  const added = [...after.keys()].filter((name) => !before.has(name));
  const changed = [...after.entries()]
    .filter(([name, property]) => {
      const previous = before.get(name);
      return previous !== undefined && stable(previous) !== stable(property);
    })
    .map(([name]) => name);
  // Reported, never acted on. The store's `ensureType` is additive by design —
  // it creates columns and never drops them — so a property that disappeared
  // from the source leaves the target's column and its data exactly where they
  // are. Saying so is the honest thing; silently listing it as a removal would
  // promise a cleanup that does not happen.
  const gone = [...before.keys()].filter((name) => !after.has(name));

  if (added.length) {
    diffs.push({ field: 'properties.added', from: [], to: added });
  }
  if (changed.length) {
    diffs.push({ field: 'properties.changed', from: changed, to: changed });
  }
  if (gone.length) {
    diffs.push({
      field: 'properties.absentFromSource',
      from: gone,
      to: gone,
    });
  }

  return diffs;
}
