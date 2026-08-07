/**
 * Reading what one environment has, and releasing it into another.
 *
 * The two halves are deliberately separate functions with the pure
 * {@link planPromotion} between them, and the separation is the feature: the
 * thing a person approves is a plain object computed from two reads, and the
 * thing that runs is driven by that same object. There is no code path that
 * changes the target without having first produced the plan describing the
 * change.
 *
 * What never appears in this file is a row of data. Not a snapshot, not an
 * `obj_*` table, not a `catalog_snapshot` entry. Promotion moves the model and
 * the pipeline; the data in an environment is that environment's, loaded there,
 * by that environment's connectors, through that environment's connections.
 */

import type {
  CatalogAuditEvent,
  CatalogEnvironment,
  CatalogPipelineStore,
  CatalogPromotableSet,
  CatalogPromotionPlan,
  CatalogWorkspaceStore,
  PromotableConnector,
  PromotableObjectType,
  PromotableTransform,
} from '@dudousxd/nestjs-catalog';
import {
  PROMOTION_AUDIT_EVENT,
  effectiveChanges,
  isPromotable,
  supportsWorkflows,
  transformMode,
} from '@dudousxd/nestjs-catalog';
import type { EntityManager } from '@mikro-orm/sql';
import { BadRequestException, Logger } from '@nestjs/common';
import { ObjectTypeRow, PropertyRow, type StoredRelation, relationsOf } from './entities/model';
import type { CatalogEnvironmentBundle } from './environment.bundle';
import { tableFor } from './identifiers';
import type { StoredCatalogRegistry } from './stored-registry.service';
import type { MikroOrmWarehouseStore } from './warehouse.store';

/**
 * Everything promotable in one environment.
 *
 * The connections come back as bare identities on purpose — see
 * `PROMOTION_WITHHELD_CONNECTION_FIELDS`. Reading their config here and then
 * carefully not using it would put an environment's credentials references into
 * an object that gets serialised into an HTTP preview response, which is a
 * leak waiting for the first person who logs the response body.
 */
export async function readPromotable(
  bundle: CatalogEnvironmentBundle,
): Promise<CatalogPromotableSet> {
  const em = bundle.em.fork();
  const [typeRows, transforms, workflows, connectors, connections] = await Promise.all([
    em.find(ObjectTypeRow, {}, { populate: ['properties'], orderBy: { name: 'asc' } }),
    bundle.pipeline.listTransforms(),
    supportsWorkflows(bundle.pipeline) ? bundle.pipeline.listWorkflows() : Promise.resolve([]),
    bundle.pipeline.listConnectors(),
    bundle.pipeline.listConnections(),
  ]);

  return {
    objectTypes: typeRows.map(toPromotableType),
    transforms: transforms.map(
      (transform): PromotableTransform => ({
        id: transform.id,
        name: transform.name,
        description: transform.description,
        language: transform.language,
        code: transform.code,
        mode: transformMode(transform),
        version: transform.version,
      }),
    ),
    connectors: connectors.map(
      (connector): PromotableConnector => ({
        id: connector.id,
        name: connector.name,
        description: connector.description,
        kind: connector.kind,
        targetType: connector.targetType,
        config: connector.config,
        connectionId: connector.connectionId,
        transformId: connector.transformId,
        workflowId: connector.workflowId,
        schedule: connector.schedule,
        mode: connector.mode,
        // `state`, `secretEnvVar`, `enabled`, `lastRunAt` and `lastRunStatus`
        // are absent from this shape rather than filtered later. A field that
        // is never read cannot be promoted by a future edit that forgets why it
        // was being skipped.
      }),
    ),
    // **Drafts are not in the promotable set at all**, which is a stronger
    // statement than "a draft promotion is refused" and is the one worth making.
    // A draft is a graph nobody has declared finished; it may have no sink, and
    // therefore no target type, so there is not even a well-formed thing to
    // describe to a reviewer. Filtering here rather than blocking later also
    // cannot hide a surprise: a connector may only point at a `ready` workflow,
    // so no connector in this set can reference one of the graphs left out, and
    // `connectorBlockers` has nothing it could newly complain about. What
    // crosses an environment is what somebody declared ready.
    workflows: workflows
      .filter((workflow) => workflow.status === 'ready')
      .map((workflow) => ({
        id: workflow.id,
        name: workflow.name,
        description: workflow.description,
        targetType: workflow.targetType,
        // The hash, not the version — a version counts edits inside one database
        // and means nothing in the other.
        graphHash: workflow.graphHash,
        version: workflow.version,
        nodes: workflow.nodes,
        edges: workflow.edges,
      })),
    connections: connections.map((connection) => ({
      id: connection.id,
      name: connection.name,
      kind: connection.kind,
    })),
  };
}

function toPromotableType(row: ObjectTypeRow): PromotableObjectType {
  return {
    name: row.name,
    ownerPrincipalId: row.ownerPrincipalId,
    displayName: row.displayName,
    pluralDisplayName: row.pluralDisplayName,
    description: row.description,
    icon: row.icon,
    group: row.group,
    titleProperty: row.titleProperty,
    primaryKey: row.primaryKey,
    properties: row.properties
      .getItems()
      .sort((a, b) => a.position - b.position)
      .map((property) => ({
        name: property.name,
        displayName: property.displayName,
        description: property.description,
        type: property.type,
        sourceColumn: property.sourceColumn,
        nullable: property.nullable,
        primary: property.primary,
        hidden: property.hidden,
        position: property.position,
        unit: property.unit,
        classification: property.classification,
      })),
    // Through `relationsOf`, so a row written before the column existed reads as
    // no links rather than throwing here and taking the whole promotion preview
    // down with it.
    //
    // Copied, and sorted onto a copy. The array on the row is the entity's own
    // JSON value: sorting it in place would reorder what MikroORM is tracking,
    // and handing the very objects out means the apply in the *other*
    // environment would write the source environment's objects into the target's
    // row. Sorted at all so that two environments holding the same links in a
    // different stored order do not read as a difference.
    relations: [...relationsOf(row)]
      .sort((a, b) => a.position - b.position)
      .map((relation) => storedRelation(relation)),
  };
}

/**
 * One link, copied into a fresh object with nothing undefined left behind.
 *
 * Used on both ends — reading a promotable set out of one environment and
 * writing it into another — so a link makes the trip without either side sharing
 * an object with the other, and without `"localKey": null` landing in the target's
 * JSON column, where it would read as a decision somebody made.
 */
function storedRelation(
  relation: NonNullable<PromotableObjectType['relations']>[number],
): StoredRelation {
  return {
    name: relation.name,
    kind: relation.kind,
    targetType: relation.targetType,
    displayName: relation.displayName,
    nullable: relation.nullable,
    hidden: relation.hidden,
    position: relation.position,
    owner: relation.owner,
    ...(relation.description === undefined ? {} : { description: relation.description }),
    ...(relation.localKey === undefined ? {} : { localKey: relation.localKey }),
    ...(relation.inverseName === undefined ? {} : { inverseName: relation.inverseName }),
  };
}

export interface PromotionOutcome {
  applied: number;
  objectTypes: string[];
  transforms: string[];
  workflows: string[];
  connectors: string[];
}

/**
 * What applying a plan needs from the environment it is being applied to.
 *
 * A {@link CatalogEnvironmentBundle} is the only thing production passes, and
 * the class declares that it satisfies this — so the two cannot drift. It is
 * written structurally, and named down to the five members an apply actually
 * touches, for one reason: the audit row this function writes is a governance
 * record, and a record whose only test boots MySQL in a container is a record
 * whose test does not run on the machine where it would catch the regression.
 * With this, the trail can be asserted against stubs.
 */
export interface PromotionTarget {
  readonly environment: Pick<CatalogEnvironment, 'id'>;
  readonly em: Pick<EntityManager, 'fork'>;
  readonly registry: Pick<StoredCatalogRegistry, 'reload' | 'getType'>;
  readonly store: Pick<MikroOrmWarehouseStore, 'ensureType'>;
  /** Whole, because {@link supportsWorkflows} narrows the store, not a method. */
  readonly pipeline: CatalogPipelineStore;
  readonly workspace: Pick<CatalogWorkspaceStore, 'recordEvent'>;
}

/**
 * Apply a plan, and record in the target that it was applied.
 *
 * Refuses a blocked plan outright rather than applying the unblocked part. A
 * partially applied promotion leaves the target holding a connector whose
 * transform never arrived, or a type whose connector was refused — states
 * neither environment has ever been in, and which nobody has a plan for
 * reversing.
 *
 * The caller is expected to have re-run {@link planPromotion} immediately
 * before this and confirmed the fingerprint matches what the reviewer approved.
 * That check lives with the caller because it is a policy decision about who is
 * allowed to approve what, and this function is the mechanism.
 *
 * Every exit that touched the target writes one `promotion.applied` row into
 * the target's audit table — see {@link promotionAuditEvent} for why one, and
 * why written here rather than emitted on the diagnostics channel. Including
 * the exit that threw: an apply is not atomic, so the half-finished promotion
 * is the one whose record is worth most, and it is the only account of what is
 * now in the target that does not depend on somebody remembering.
 */
export async function applyPromotion(input: {
  source: CatalogPromotableSet;
  target: PromotionTarget;
  plan: CatalogPromotionPlan;
  /** Recorded as the author of everything this creates in the target. */
  promotedBy: string;
  /**
   * The operator's `CatalogPromotionApproval.reason`, verbatim.
   *
   * Carried through to the audit row and never parsed. It is the only part of
   * "who promoted what into production, when, and why" that no amount of
   * inspecting the target afterwards can reconstruct — the changes are visible
   * in the databases, the actor and the clock are columns, and the reason
   * exists nowhere unless it was written down at this moment.
   */
  reason?: string;
}): Promise<PromotionOutcome> {
  const { source, target, plan, promotedBy, reason } = input;
  const logger = new Logger('CatalogPromotion');

  if (!isPromotable(plan)) {
    throw new Error(
      `This promotion has ${plan.blockers.length} blocker(s) and will not be applied in part: ${plan.blockers.map((blocker) => blocker.reason).join(' ')}`,
    );
  }

  // The plan names the environment it was reviewed against; the bundle is the
  // one that will be written to and the one whose audit table takes the record.
  // Nothing else in this function compares them, so a caller that resolved the
  // wrong bundle would release an approved-for-staging plan into production and
  // then file the record of it under `to: "staging"` — a trail that is worse
  // than none, because it reads as an answer.
  if (plan.to !== target.environment.id) {
    throw new Error(
      `This plan promotes into "${plan.to}" but was handed the "${target.environment.id}" environment. Refusing: the changes would land in one world and the record of them would name another.`,
    );
  }

  const changes = effectiveChanges(plan);
  const outcome: PromotionOutcome = {
    applied: 0,
    objectTypes: [],
    transforms: [],
    workflows: [],
    connectors: [],
  };

  // Model first, then transforms, then connectors, and the order is load
  // bearing rather than tidy. A connector references a transform and a target
  // type; arriving before either exists would mean a window — however short —
  // in which the target holds a connector that cannot run. Doing it in
  // dependency order means the target is never in a state it could not have
  // been put into by hand.
  const step: PromotionStep = { source, target, changes, promotedBy, outcome };
  try {
    await promoteObjectTypes(step);
    await promoteTransforms(step);
    await promoteWorkflows(step);
    await promoteConnectors(step);
  } catch (error) {
    await target.workspace.recordEvent(
      promotionAuditEvent({ plan, promotedBy, reason, outcome, error }),
    );
    throw error;
  }

  await target.workspace.recordEvent(promotionAuditEvent({ plan, promotedBy, reason, outcome }));
  logger.log(
    `Promoted ${plan.from} -> ${plan.to} by ${promotedBy}: ${outcome.objectTypes.length} types, ${outcome.transforms.length} transforms, ${outcome.connectors.length} connectors (${plan.fingerprint.slice(0, 12)}).`,
  );
  return outcome;
}

/**
 * One promotion, as one row in the target environment's audit table.
 *
 * **One row per promotion, not one per change.** A promotion is a single act —
 * one person, one approved fingerprint, one reason — over a plan that happens
 * to span four kinds. Split into a row per change it stops being an act at all:
 * the reason is repeated forty times, nothing says which forty rows were the
 * same release, and the flat trail everybody reads first becomes unreadable at
 * exactly the moment somebody is trying to read it. What a single row must not
 * do is lose *what* moved, so every promoted id is in the detail, kept apart by
 * kind — "which types went to production in March" is answerable from
 * `objectTypes`, and a promotion that carried only connectors is visibly
 * different from one that reshaped the model.
 *
 * **Written here rather than emitted on `aviary:catalog:*`.** That is the
 * instruction on {@link PROMOTION_AUDIT_EVENT} and the reason is worth
 * repeating: the recorder that turns channel events into rows writes through
 * whichever environment is in scope, and a promotion is the one act that is
 * about two of them at once. Written directly, the row is in the target's own
 * database because that is the database this call was given, which is not a
 * fact any later reader has to take on trust.
 *
 * **No `snapshotId`.** The trace view groups on that column, and a promotion
 * that borrowed it would appear on the loads screen as a trace that started and
 * never finished — for ever, since nothing about a promotion emits the terminal
 * events that grade one. Left empty, it lands in the unlinked list beside
 * `type.curated` and `query.shared`, which is the right company: acts a person
 * performed on the catalog, rather than steps of a load.
 *
 * Pure, and separate from the call that writes it, so that the exit that threw
 * and the exit that finished cannot build the row two different ways.
 */
export function promotionAuditEvent(input: {
  plan: CatalogPromotionPlan;
  promotedBy: string;
  reason?: string;
  outcome: PromotionOutcome;
  /** Absent on the path that finished. Present, and reported, on the one that did not. */
  error?: unknown;
  now?: () => Date;
}): Omit<CatalogAuditEvent, 'id'> {
  const { plan, promotedBy, reason, outcome, error } = input;
  const failure = error === undefined ? undefined : messageOf(error);

  return {
    event: PROMOTION_AUDIT_EVENT,
    // The indexed actor column, which is what makes "everything this person did"
    // a query rather than a scan of JSON.
    principalId: promotedBy,
    detail: {
      from: plan.from,
      to: plan.to,
      // Whole, not the shortened form the log line prints: this is the value an
      // incident review compares against the approval that was recorded
      // elsewhere, and a prefix cannot be compared with confidence.
      fingerprint: plan.fingerprint,
      // Both outcomes under one event name, following `connector.run.finished`:
      // anybody watching promotions has to watch the successes anyway to notice
      // the ones that stopped halfway.
      status: failure === undefined ? 'succeeded' : 'failed',
      error: failure,
      reason,
      applied: outcome.applied,
      // Copied rather than referenced. `outcome` is mutated in place by the
      // phases, and a detail holding the live arrays would be a record that
      // kept changing after the moment it claims to describe.
      objectTypes: [...outcome.objectTypes],
      transforms: [...outcome.transforms],
      workflows: [...outcome.workflows],
      connectors: [...outcome.connectors],
    },
    occurredAt: (input.now?.() ?? new Date()).toISOString(),
  };
}

/**
 * A thrown value as one line of the record.
 *
 * `String(error)` is not used: a thrown object renders as `[object Object]`,
 * which occupies the field where the reason the promotion stopped was supposed
 * to be and looks like it was filled in.
 */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string' && error.length > 0) return error;
  return `The promotion stopped on a thrown ${typeof error} carrying no message.`;
}

/**
 * Everything one phase of {@link applyPromotion} needs.
 *
 * `outcome` is deliberately shared and mutated in place: the phases run in
 * dependency order and an apply is not atomic, so what has already been written
 * when a later phase throws is exactly the information the caller needs, and a
 * phase that returned its own tally would lose it on the throw.
 */
interface PromotionStep {
  source: CatalogPromotableSet;
  target: PromotionTarget;
  changes: ReturnType<typeof effectiveChanges>;
  promotedBy: string;
  outcome: PromotionOutcome;
}

/** Phase 1: the model, then the physical tables that hold it. */
async function promoteObjectTypes({
  source,
  target,
  changes,
  outcome,
}: PromotionStep): Promise<void> {
  for (const change of changes.filter((c) => c.kind === 'objectType')) {
    const type = source.objectTypes.find((t) => t.name === change.id);
    if (!type) continue;
    await promoteType(target, type);
    outcome.objectTypes.push(type.name);
    outcome.applied += 1;
  }

  // Reloaded once, after all of the model writes, so `ensureType` below sees
  // every promoted type. Reloading per type would be the same answer computed
  // N times.
  if (outcome.objectTypes.length === 0) return;
  await target.registry.reload();
  for (const name of outcome.objectTypes) {
    const def = target.registry.getType(name);
    if (!def) {
      throw new Error(
        `${name} was written into ${target.environment.id} and then could not be read back. Refusing to continue: the physical table would not be created and the next load into it would fail.`,
      );
    }
    // Additive DDL, the same call a publish makes. The table arrives empty —
    // there is no data path here, by design.
    await target.store.ensureType(def);
  }
}

/** Phase 2: the code, before the graphs and connectors that name it. */
async function promoteTransforms({
  source,
  target,
  changes,
  promotedBy,
  outcome,
}: PromotionStep): Promise<void> {
  for (const change of changes.filter((c) => c.kind === 'transform')) {
    const transform = source.transforms.find((t) => t.id === change.id);
    if (!transform) continue;
    // `version` is deliberately not passed: the store bumps the target's own
    // when the code changes, so the target's history counts the target's edits.
    await target.pipeline.saveTransform(
      {
        id: transform.id,
        name: transform.name,
        description: transform.description,
        language: transform.language,
        code: transform.code,
        // Carried, and it has to be: the mode decides what the code means, so
        // promoting the text without it would run the same transform under a
        // different contract in production than in dev. It is already resolved
        // on the promotable shape — see PromotableTransform.mode — so this is
        // the value the plan showed the operator, not a second resolution.
        mode: transform.mode,
      },
      promotedBy,
    );
    outcome.transforms.push(transform.id);
    outcome.applied += 1;
  }
}

/**
 * Phase 3: graphs after the code they name and before the connectors that run
 * them, matching the order PROMOTABLE_KINDS declares.
 *
 * An apply is not atomic, so the order decides what a half-finished one leaves
 * behind: a graph whose transforms are already there, rather than a connector
 * pointing at nothing.
 */
async function promoteWorkflows({
  source,
  target,
  changes,
  promotedBy,
  outcome,
}: PromotionStep): Promise<void> {
  for (const change of changes.filter((c) => c.kind === 'workflow')) {
    const workflow = source.workflows.find((w) => w.id === change.id);
    if (!workflow) continue;
    if (!supportsWorkflows(target.pipeline)) {
      throw new BadRequestException(
        `${target.environment.id} cannot hold workflows, so "${workflow.name}" has nowhere to land. Promote to an environment whose store supports them, or drop it from the selection.`,
      );
    }
    // `version` and `graphHash` are not passed: the store derives both from the
    // graph it is given, and accepting them would let this claim a hash the
    // stored nodes do not produce.
    await target.pipeline.saveWorkflow(
      {
        id: workflow.id,
        name: workflow.name,
        description: workflow.description,
        nodes: workflow.nodes,
        edges: workflow.edges,
      },
      promotedBy,
    );
    // Saved, then published, because a save creates a draft and a draft is not
    // something the next phase can attach a connector to — `saveConnector`
    // refuses one. Two calls rather than a `status` argument on the save, so the
    // graph goes through exactly the validation every other publish does: it was
    // ready in the source, but "ready over there" is a claim about a database
    // whose transforms are not these, and `publishWorkflow` re-checks it against
    // the transforms that actually arrived in phase 2.
    await target.pipeline.publishWorkflow(workflow.id, promotedBy);
    outcome.workflows.push(workflow.id);
    outcome.applied += 1;
  }
}

/** Phase 4: the connectors, last, once everything they reference exists. */
async function promoteConnectors({
  source,
  target,
  changes,
  promotedBy,
  outcome,
}: PromotionStep): Promise<void> {
  for (const change of changes.filter((c) => c.kind === 'connector')) {
    const connector = source.connectors.find((c) => c.id === change.id);
    if (!connector) continue;
    // Read the target's own copy rather than trusting the plan, because the two
    // fields being preserved here — the credential reference and the
    // enabled switch — are precisely the ones where a stale value would point
    // the target at the wrong secret or switch on a load somebody had turned
    // off.
    const existing = await target.pipeline.getConnector(connector.id);
    await target.pipeline.saveConnector(
      {
        id: connector.id,
        name: connector.name,
        description: connector.description,
        kind: connector.kind,
        targetType: connector.targetType,
        config: connector.config,
        connectionId: connector.connectionId,
        transformId: connector.transformId,
        workflowId: connector.workflowId,
        schedule: connector.schedule,
        mode: connector.mode,
        // The target's own, never the source's. Absent on create, which is what
        // makes a newly promoted connector arrive with no credential to reach
        // anything with — deliberate, and the reason it also arrives disabled.
        secretEnvVar: existing?.secretEnvVar,
        // False on create. A promotion that switched a connector on would mean
        // the first time this code ran in the target was unattended, on a
        // schedule, against data that matters.
        enabled: existing?.enabled ?? false,
      },
      promotedBy,
    );
    outcome.connectors.push(connector.id);
    outcome.applied += 1;
  }
}

/**
 * Write one type and its properties into the target.
 *
 * Additive in the same way `PublishService.upsertType` is, and for the same
 * reason: a property that disappeared from the source leaves the target's
 * column and whatever rows are in it exactly where they are. The plan says so
 * out loud as `properties.absentFromSource` rather than pretending a cleanup
 * happens.
 *
 * Curated values *do* cross, unlike a publish, and that is the difference
 * between the two paths. A publish fills in a label only when there is not one
 * already, because the publishing application redeploys constantly and would
 * otherwise reset a curator's work. A promotion is somebody deliberately
 * releasing the curation they did in dev, so it overwrites — that is what they
 * asked for, and the preview showed them the before and after.
 */
async function promoteType(target: PromotionTarget, type: PromotableObjectType): Promise<void> {
  const em = target.em.fork();
  const existing = await em.findOne(
    ObjectTypeRow,
    { name: type.name },
    { populate: ['properties'] },
  );

  const row =
    existing ??
    em.create(ObjectTypeRow, {
      name: type.name,
      // The source's owner, not the promoter's. See the field's docblock: the
      // publishing application has to keep publishing into the target, and the
      // store decides whether it may by comparing exactly this string.
      ownerPrincipalId: type.ownerPrincipalId,
      displayName: type.displayName,
      pluralDisplayName: type.pluralDisplayName,
      group: type.group,
      primaryKey: [],
      physicalTable: tableFor(type.name),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

  // `ownerPrincipalId` is conspicuously not assigned on the update path. A
  // promotion that could change it would be a way to transfer ownership of a
  // type without anybody approving a transfer of ownership.
  row.displayName = type.displayName;
  row.pluralDisplayName = type.pluralDisplayName;
  row.description = type.description;
  row.icon = type.icon;
  row.group = type.group;
  row.titleProperty = type.titleProperty;
  row.primaryKey = type.primaryKey;

  // ASSIGNED, not merged, and this is the one place the two paths that write
  // this column part company. `mergeRelations` exists for the publish wire,
  // where an application redeploys constantly and re-sends its whole shape, so a
  // label a curator wrote has to survive the sender. A promotion is the opposite
  // act: somebody read a plan of what the source holds, approved that
  // fingerprint, and asked for it to be released. Merging would mean a link the
  // source deliberately dropped survives in the target — invisibly, because the
  // plan says `relations.removed` and the apply would then not remove it, which
  // is the one outcome worse than either behaviour on its own. It is also safe
  // in a way dropping a property is not: a column may still hold rows, a link
  // holds nothing.
  //
  // A NEW array of NEW objects. MikroORM decides a JSON property changed by
  // comparing it against the snapshot taken at load, so mutating in place can
  // flush nothing while appearing to succeed — and the objects come from the
  // *source* environment's rows, which the target must not end up sharing.
  row.relations = (type.relations ?? []).map((relation) => storedRelation(relation));

  const known = new Map((existing ? row.properties.getItems() : []).map((p) => [p.name, p]));

  for (const property of type.properties) {
    const target_ =
      known.get(property.name) ??
      em.create(PropertyRow, {
        id: `${type.name}.${property.name}`,
        objectType: row,
        name: property.name,
        displayName: property.displayName,
        type: property.type,
        sourceColumn: property.sourceColumn,
        physicalColumn: property.name,
        nullable: property.nullable,
        primary: property.primary,
        hidden: property.hidden,
        position: property.position,
      });

    target_.displayName = property.displayName;
    target_.description = property.description;
    target_.type = property.type;
    target_.sourceColumn = property.sourceColumn;
    target_.nullable = property.nullable;
    target_.primary = property.primary;
    target_.hidden = property.hidden;
    target_.position = property.position;
    target_.unit = property.unit;
    target_.classification = property.classification;

    em.persist(target_);
  }

  em.persist(row);
  await em.flush();
}
