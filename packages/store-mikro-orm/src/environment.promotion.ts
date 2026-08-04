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
  CatalogPromotableSet,
  CatalogPromotionPlan,
  PromotableConnector,
  PromotableObjectType,
  PromotableTransform,
} from '@dudousxd/nestjs-catalog';
import { effectiveChanges, isPromotable, supportsWorkflows } from '@dudousxd/nestjs-catalog';
import { BadRequestException, Logger } from '@nestjs/common';
import { ObjectTypeRow, PropertyRow } from './entities/model';
import type { CatalogEnvironmentBundle } from './environment.bundle';
import { tableFor } from './identifiers';

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
    workflows: workflows.map((workflow) => ({
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
 * Apply a plan.
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
 */
export async function applyPromotion(input: {
  source: CatalogPromotableSet;
  target: CatalogEnvironmentBundle;
  plan: CatalogPromotionPlan;
  /** Recorded as the author of everything this creates in the target. */
  promotedBy: string;
}): Promise<PromotionOutcome> {
  const { source, target, plan, promotedBy } = input;
  const logger = new Logger('CatalogPromotion');

  if (!isPromotable(plan)) {
    throw new Error(
      `This promotion has ${plan.blockers.length} blocker(s) and will not be applied in part: ${plan.blockers.map((blocker) => blocker.reason).join(' ')}`,
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
  await promoteObjectTypes(step);
  await promoteTransforms(step);
  await promoteWorkflows(step);
  await promoteConnectors(step);

  logger.log(
    `Promoted ${plan.from} -> ${plan.to} by ${promotedBy}: ${outcome.objectTypes.length} types, ${outcome.transforms.length} transforms, ${outcome.connectors.length} connectors (${plan.fingerprint.slice(0, 12)}).`,
  );
  return outcome;
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
  target: CatalogEnvironmentBundle;
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
async function promoteType(
  target: CatalogEnvironmentBundle,
  type: PromotableObjectType,
): Promise<void> {
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
