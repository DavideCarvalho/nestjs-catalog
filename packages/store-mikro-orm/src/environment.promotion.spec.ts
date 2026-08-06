import {
  type CatalogAuditEvent,
  type CatalogConnection,
  type CatalogConnector,
  type CatalogPipelineStore,
  type CatalogPromotableSet,
  type CatalogTransform,
  type CatalogWorkflow,
  PROMOTION_AUDIT_EVENT,
  planPromotion,
} from '@dudousxd/nestjs-catalog';
import { describe, expect, it } from 'vitest';
import { type PromotionTarget, applyPromotion, promotionAuditEvent } from './environment.promotion';

/**
 * That promoting into an environment leaves a record in that environment.
 *
 * `PROMOTION_AUDIT_EVENT` shipped with a paragraph explaining where a promotion
 * is written down, and was referenced by nothing: `applyPromotion` moved types,
 * transforms, graphs and connectors into production and recorded none of it,
 * while `CatalogPromotionApproval.reason` told operators their typed
 * justification was "recorded in the audit trail". So these assert the row —
 * that it is written, what is in it, and that it survives the apply throwing
 * halfway — rather than that some function was called. A spy on `recordEvent`
 * would have passed on a detail payload with the promoted ids missing, which is
 * the version of this feature that is not worth having.
 */

const NOW = new Date('2026-03-04T09:15:00.000Z');

// ---------------------------------------------------------------------------
// Stubs. Only the members an apply touches do anything; the rest of the
// pipeline interface refuses loudly, so a phase that started calling something
// new fails here instead of silently passing.
// ---------------------------------------------------------------------------

class StubWorkspace {
  readonly recorded: Array<Omit<CatalogAuditEvent, 'id'>> = [];

  recordEvent(event: Omit<CatalogAuditEvent, 'id'>): Promise<void> {
    this.recorded.push(event);
    return Promise.resolve();
  }
}

class StubPipelineStore implements CatalogPipelineStore {
  readonly savedTransforms: string[] = [];
  readonly savedWorkflows: string[] = [];
  readonly publishedWorkflows: string[] = [];
  readonly savedConnectors: string[] = [];

  /** Thrown by `saveTransform`/`saveConnector` when set, to stop an apply mid-way. */
  failTransformWith?: unknown;
  failConnectorWith?: unknown;

  saveTransform(
    input: Pick<CatalogTransform, 'name' | 'language' | 'code'> & { id?: string },
    createdBy: string,
  ): Promise<CatalogTransform> {
    if (this.failTransformWith !== undefined) return Promise.reject(this.failTransformWith);
    const id = input.id ?? 'generated';
    this.savedTransforms.push(id);
    return Promise.resolve({
      id,
      name: input.name,
      language: input.language,
      code: input.code,
      version: 1,
      createdBy,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
  }

  saveWorkflow(
    input: Pick<CatalogWorkflow, 'name' | 'nodes' | 'edges'> & { id?: string },
    createdBy: string,
  ): Promise<CatalogWorkflow> {
    const id = input.id ?? 'generated';
    this.savedWorkflows.push(id);
    return Promise.resolve({
      id,
      name: input.name,
      targetType: 'Mvr',
      graphHash: 'hash',
      // A save drafts, exactly as the real store does. `promoteWorkflows`
      // publishes immediately afterwards, which is what these tests then get to
      // assert rather than assume.
      status: 'draft',
      enabled: true,
      version: 1,
      nodes: input.nodes,
      edges: input.edges,
      createdBy,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
  }

  /**
   * Recorded rather than ignored, because "it arrived ready" is the assertion.
   *
   * A promotion that saved a graph and left it drafted would put a workflow in
   * the target that the very next phase cannot attach a connector to — the store
   * refuses a connector pointing at a draft — so the publish is load-bearing and
   * a spy on it is what stops that regressing silently.
   */
  publishWorkflow(id: string): Promise<CatalogWorkflow> {
    this.publishedWorkflows.push(id);
    return Promise.resolve({
      id,
      name: id,
      targetType: 'Mvr',
      graphHash: 'hash',
      status: 'ready',
      enabled: true,
      version: 1,
      nodes: [],
      edges: [],
      createdBy: 'promoter',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
  }

  /** Undefined is the create path, which is what a first promotion exercises. */
  getConnector(): Promise<CatalogConnector | undefined> {
    return Promise.resolve(undefined);
  }

  saveConnector(
    input: Omit<CatalogConnector, 'id' | 'createdAt' | 'updatedAt' | 'createdBy'> & { id?: string },
    createdBy: string,
  ): Promise<CatalogConnector> {
    if (this.failConnectorWith !== undefined) return Promise.reject(this.failConnectorWith);
    const id = input.id ?? 'generated';
    this.savedConnectors.push(id);
    return Promise.resolve({
      ...input,
      id,
      enabled: input.enabled ?? false,
      createdBy,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
  }

  // `supportsWorkflows` narrows on these two being present alongside
  // `saveWorkflow`, so they exist rather than being left off.
  listWorkflows(): Promise<CatalogWorkflow[]> {
    return this.unused('listWorkflows');
  }
  getWorkflow(): Promise<CatalogWorkflow | undefined> {
    return this.unused('getWorkflow');
  }

  listConnectors(): Promise<CatalogConnector[]> {
    return this.unused('listConnectors');
  }
  deleteConnector(): Promise<boolean> {
    return this.unused('deleteConnector');
  }
  saveConnectorState(): Promise<void> {
    return this.unused('saveConnectorState');
  }
  listConnections(): Promise<CatalogConnection[]> {
    return this.unused('listConnections');
  }
  getConnection(): Promise<CatalogConnection | undefined> {
    return this.unused('getConnection');
  }
  saveConnection(): Promise<CatalogConnection> {
    return this.unused('saveConnection');
  }
  deleteConnection(): Promise<boolean> {
    return this.unused('deleteConnection');
  }
  recordConnectionCheck(): Promise<void> {
    return this.unused('recordConnectionCheck');
  }
  connectorsUsingConnection(): Promise<CatalogConnector[]> {
    return this.unused('connectorsUsingConnection');
  }
  listTransforms(): Promise<CatalogTransform[]> {
    return this.unused('listTransforms');
  }
  getTransform(): Promise<CatalogTransform | undefined> {
    return this.unused('getTransform');
  }
  deleteTransform(): Promise<boolean> {
    return this.unused('deleteTransform');
  }
  deleteWorkflow(): Promise<boolean> {
    return this.unused('deleteWorkflow');
  }
  connectorsUsingWorkflow(): Promise<CatalogConnector[]> {
    return this.unused('connectorsUsingWorkflow');
  }
  startRun(): Promise<never> {
    return this.unused('startRun');
  }
  finishRun(): Promise<never> {
    return this.unused('finishRun');
  }
  listRuns(): Promise<never> {
    return this.unused('listRuns');
  }

  private unused(method: string): never {
    throw new Error(`applyPromotion is not expected to call ${method}().`);
  }
}

interface Rig {
  target: PromotionTarget;
  workspace: StubWorkspace;
  pipeline: StubPipelineStore;
}

function rig(environmentId = 'production'): Rig {
  const workspace = new StubWorkspace();
  const pipeline = new StubPipelineStore();
  const target: PromotionTarget = {
    environment: { id: environmentId },
    // These three belong to the object-type phase, which writes through the ORM
    // and so is only reachable with a real database. The plans below carry no
    // object types, which makes reaching any of them a bug — so they say so
    // rather than quietly returning something plausible.
    em: {
      fork: () => {
        throw new Error('applyPromotion is not expected to fork an EntityManager here.');
      },
    },
    registry: {
      reload: () => {
        throw new Error('applyPromotion is not expected to reload the registry here.');
      },
      getType: () => {
        throw new Error('applyPromotion is not expected to read the registry here.');
      },
    },
    store: {
      ensureType: () => {
        throw new Error('applyPromotion is not expected to run DDL here.');
      },
    },
    pipeline,
    workspace,
  };
  return { target, workspace, pipeline };
}

// ---------------------------------------------------------------------------
// The promotable sets the plans below are computed from.
// ---------------------------------------------------------------------------

const WAREHOUSE: CatalogPromotableSet['connections'][number] = {
  id: 'warehouse',
  name: 'Warehouse',
  kind: 'sql',
};

function sourceSet(): CatalogPromotableSet {
  return {
    objectTypes: [],
    transforms: [
      {
        id: 'normalise-mvr',
        name: 'Normalise MVR',
        language: 'javascript',
        code: 'return records;',
        version: 4,
      },
    ],
    workflows: [],
    connectors: [
      {
        id: 'mvr-nightly',
        name: 'MVR nightly',
        kind: 'sql',
        targetType: 'Mvr',
        config: { query: 'select 1' },
        connectionId: 'warehouse',
        transformId: 'normalise-mvr',
        schedule: '0 2 * * *',
        mode: 'full',
      },
    ],
    connections: [WAREHOUSE],
  };
}

/** The target as it is before the promotion: the connection, and nothing else. */
function targetSet(): CatalogPromotableSet {
  return {
    objectTypes: [],
    transforms: [],
    workflows: [],
    connectors: [],
    connections: [WAREHOUSE],
  };
}

function planFor(to = 'production'): ReturnType<typeof planPromotion> {
  return planPromotion({ from: 'dev', to, source: sourceSet(), target: targetSet() });
}

/** The one audit row, insisted upon rather than assumed. */
function onlyRecord(workspace: StubWorkspace): Omit<CatalogAuditEvent, 'id'> {
  expect(workspace.recorded).toHaveLength(1);
  return workspace.recorded[0];
}

describe('applyPromotion records what it did', () => {
  it('writes one promotion.applied row naming the operator, the reason and every promoted id', async () => {
    const { target, workspace, pipeline } = rig();
    const plan = planFor();

    const outcome = await applyPromotion({
      source: sourceSet(),
      target,
      plan,
      promotedBy: 'ana@example.com',
      reason: 'Q3 vehicle-registration release, approved in CAB-118.',
    });

    expect(pipeline.savedTransforms).toEqual(['normalise-mvr']);
    expect(pipeline.savedConnectors).toEqual(['mvr-nightly']);
    expect(outcome.applied).toBe(2);

    const record = onlyRecord(workspace);
    expect(record.event).toBe(PROMOTION_AUDIT_EVENT);
    // The indexed actor column, not a field inside the JSON: "everything Ana
    // did" has to be a query.
    expect(record.principalId).toBe('ana@example.com');
    // No snapshot id, so it lands in the unlinked list rather than appearing on
    // the loads screen as a trace that never finishes.
    expect(record.snapshotId).toBeUndefined();
    expect(record.detail).toEqual({
      from: 'dev',
      to: 'production',
      fingerprint: plan.fingerprint,
      status: 'succeeded',
      error: undefined,
      reason: 'Q3 vehicle-registration release, approved in CAB-118.',
      applied: 2,
      objectTypes: [],
      transforms: ['normalise-mvr'],
      workflows: [],
      connectors: ['mvr-nightly'],
    });
  });

  it('records the partial promotion, and the reason it stopped, when a phase throws', async () => {
    const { target, workspace, pipeline } = rig();
    pipeline.failConnectorWith = new Error('Deadlock found when trying to get lock');

    await expect(
      applyPromotion({
        source: sourceSet(),
        target,
        plan: planFor(),
        promotedBy: 'ana@example.com',
        reason: 'Q3 release.',
      }),
    ).rejects.toThrow('Deadlock found when trying to get lock');

    const record = onlyRecord(workspace);
    expect(record.detail.status).toBe('failed');
    expect(record.detail.error).toBe('Deadlock found when trying to get lock');
    // The transform did land. A record that reported the whole promotion as
    // failed, or reported nothing at all, would leave somebody reconciling
    // production by hand.
    expect(record.detail.transforms).toEqual(['normalise-mvr']);
    expect(record.detail.connectors).toEqual([]);
    expect(record.detail.applied).toBe(1);
    expect(record.detail.reason).toBe('Q3 release.');
  });

  it('reports a thrown non-Error as a sentence rather than as [object Object]', async () => {
    const { target, workspace, pipeline } = rig();
    pipeline.failTransformWith = { code: 'ER_LOCK_DEADLOCK' };

    await expect(
      applyPromotion({
        source: sourceSet(),
        target,
        plan: planFor(),
        promotedBy: 'ana@example.com',
      }),
    ).rejects.toBeDefined();

    const record = onlyRecord(workspace);
    expect(record.detail.error).toBe(
      'The promotion stopped on a thrown object carrying no message.',
    );
    expect(record.detail.status).toBe('failed');
  });

  it('leaves the reason out when the operator typed none, and never invents one', async () => {
    const { target, workspace } = rig();

    await applyPromotion({
      source: sourceSet(),
      target,
      plan: planFor(),
      promotedBy: 'ana@example.com',
    });

    const record = onlyRecord(workspace);
    expect(record.detail.reason).toBeUndefined();
    expect(record.detail.status).toBe('succeeded');
  });

  it('records what had been promoted at the moment it finished, not whatever the outcome later says', async () => {
    const { target, workspace } = rig();

    const outcome = await applyPromotion({
      source: sourceSet(),
      target,
      plan: planFor(),
      promotedBy: 'ana@example.com',
    });

    // The outcome is handed back to the caller and is mutable. A detail holding
    // the same arrays would be a record that changed after the fact.
    outcome.transforms.push('invented-afterwards');
    expect(onlyRecord(workspace).detail.transforms).toEqual(['normalise-mvr']);
  });

  it('refuses, and records nothing, when the plan was approved for another environment', async () => {
    const { target, workspace, pipeline } = rig('staging');

    await expect(
      applyPromotion({
        source: sourceSet(),
        // Reviewed against production; handed the staging bundle.
        plan: planFor('production'),
        target,
        promotedBy: 'ana@example.com',
      }),
    ).rejects.toThrow(/promotes into "production" but was handed the "staging" environment/);

    expect(workspace.recorded).toEqual([]);
    expect(pipeline.savedTransforms).toEqual([]);
  });

  it('records nothing for a blocked plan, which changed nothing', async () => {
    const { target, workspace, pipeline } = rig();
    // The target has no connection with that id, which is the blocker the plan
    // exists to raise.
    const plan = planPromotion({
      from: 'dev',
      to: 'production',
      source: sourceSet(),
      target: { ...targetSet(), connections: [] },
    });
    expect(plan.blockers).not.toHaveLength(0);

    await expect(
      applyPromotion({ source: sourceSet(), target, plan, promotedBy: 'ana@example.com' }),
    ).rejects.toThrow(/blocker/);

    expect(workspace.recorded).toEqual([]);
    expect(pipeline.savedConnectors).toEqual([]);
  });
});

describe('promotionAuditEvent', () => {
  const plan = planFor();

  it('keeps the promoted ids apart by kind, so the trail says which types moved', () => {
    const event = promotionAuditEvent({
      plan,
      promotedBy: 'ana@example.com',
      outcome: {
        applied: 5,
        objectTypes: ['Mvr', 'Mel'],
        transforms: ['normalise-mvr'],
        workflows: ['mvr-graph'],
        connectors: ['mvr-nightly'],
      },
      now: () => NOW,
    });

    expect(event.detail.objectTypes).toEqual(['Mvr', 'Mel']);
    expect(event.detail.workflows).toEqual(['mvr-graph']);
    expect(event.detail.applied).toBe(5);
    expect(event.occurredAt).toBe('2026-03-04T09:15:00.000Z');
  });

  it('carries the whole fingerprint, which is what an approval is compared against', () => {
    const event = promotionAuditEvent({
      plan,
      promotedBy: 'ana@example.com',
      outcome: { applied: 0, objectTypes: [], transforms: [], workflows: [], connectors: [] },
    });

    expect(event.detail.fingerprint).toBe(plan.fingerprint);
    expect(plan.fingerprint.length).toBeGreaterThan(12);
  });
});
