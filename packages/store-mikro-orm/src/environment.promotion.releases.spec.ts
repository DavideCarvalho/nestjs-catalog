import type { CatalogWorkflow } from '@dudousxd/nestjs-catalog';
import { describe, expect, it } from 'vitest';
import type { CatalogEnvironmentBundle } from './environment.bundle';
import { readPromotable } from './environment.promotion';

/**
 * That a live version does not cross an environment.
 *
 * ## Why this is the test the whole feature turns on
 *
 * The maintainer's request named the environment: "which version is in
 * production **in the environment**". It is tempting to read that as a request
 * for an environment dimension on the pointer, and it is not one — this catalog
 * isolates environments *physically*, one database each, so a `catalog_workflow`
 * row already exists once per environment and the pointer on it is already
 * per-environment. The environment is the connection.
 *
 * What that leaves is a hazard pointing the other way. `planPromotion` carries
 * configuration between environments, and it is explicit that **version numbers
 * do not cross**: a version counts the edits made in the environment it lives
 * in, so dev's v7 and production's v7 are unrelated numbers and the target bumps
 * its own. A pointer *to* a version inherits that argument whole. Carrying
 * `liveVersion` would set production's live pointer to a number that means
 * whatever production's own seventh edit happened to be — which is a deploy of
 * an arbitrary graph, performed by a promotion of something else.
 *
 * `readPromotable` builds `PromotableWorkflow` field by field, so the omission
 * is currently structural. This is what stops the field being added the next
 * time somebody lists the workflow's columns and copies them across.
 */

const WHEN = '2020-01-01T00:00:00.000Z';

function workflow(overrides: Partial<CatalogWorkflow> = {}): CatalogWorkflow {
  return {
    id: 'w1',
    name: 'Nightly Subwo',
    nodes: [
      { id: 'in', name: 'in', kind: 'source', sourceKind: 'inline', config: {} },
      { id: 'out', name: 'out', kind: 'sink', targetType: 'Subwo' },
    ],
    edges: [{ from: 'in', to: 'out' }],
    status: 'ready',
    version: 9,
    graphHash: 'hash-of-v9',
    targetType: 'Subwo',
    enabled: true,
    createdBy: 'ana',
    createdAt: WHEN,
    updatedAt: WHEN,
    ...overrides,
  };
}

/** Answers the reads `readPromotable` makes, with a pipeline that holds graphs. */
function bundleOver(workflows: CatalogWorkflow[]): CatalogEnvironmentBundle {
  const bundle = Object.create(null);
  return Object.assign(bundle, {
    em: { fork: () => ({ find: () => Promise.resolve([]) }) },
    pipeline: {
      listTransforms: () => Promise.resolve([]),
      listConnectors: () => Promise.resolve([]),
      listConnections: () => Promise.resolve([]),
      // All four, because `supportsWorkflows` asks for each by name — a stub
      // missing one narrows to false and this file would assert about an empty
      // list while claiming to assert about a graph.
      listWorkflows: () => Promise.resolve(workflows),
      getWorkflow: (id: string) => Promise.resolve(workflows.find((found) => found.id === id)),
      saveWorkflow: () => Promise.reject(new Error('unused')),
      publishWorkflow: () => Promise.reject(new Error('unused')),
      saveWorkflowSchedule: () => Promise.reject(new Error('unused')),
    },
  });
}

describe('what a promotion carries about a graph', () => {
  it('does not carry the live version, which means nothing in the target', async () => {
    const set = await readPromotable(bundleOver([workflow({ version: 9, liveVersion: 6 })]));

    expect(set.workflows).toHaveLength(1);
    expect(Object.hasOwn(set.workflows[0], 'liveVersion')).toBe(false);
  });

  /**
   * And the graph itself still crosses, which is the half that has to keep
   * working. Not carrying the pointer is a deliberate omission, not a graph that
   * stopped being promotable.
   */
  it('still carries the graph, and the hash that identifies it across databases', async () => {
    const set = await readPromotable(bundleOver([workflow({ liveVersion: 6 })]));

    expect(set.workflows[0].graphHash).toBe('hash-of-v9');
    expect(set.workflows[0].nodes).toHaveLength(2);
  });

  /**
   * A promoted graph therefore lands following its latest save — the state every
   * newly created graph is in — and somebody in the target environment has to
   * release and deploy it there deliberately. That is the same "no backfill that
   * changes what runs" rule the upgrade path follows, arrived at from the other
   * direction.
   */
  it('leaves a promoted graph following the latest save in the target', async () => {
    const set = await readPromotable(bundleOver([workflow({ liveVersion: 6 })]));

    expect(Reflect.get(set.workflows[0], 'liveVersion')).toBeUndefined();
  });
});
