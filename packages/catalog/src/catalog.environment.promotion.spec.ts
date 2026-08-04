import { describe, expect, it } from 'vitest';
import {
  type CatalogPromotableSet,
  type CatalogPromotionChange,
  type CatalogPromotionPlan,
  PROMOTION_WITHHELD_CONNECTOR_FIELDS,
  type PromotableConnector,
  type PromotableKind,
  type PromotableObjectType,
  type PromotableTransform,
  type PromotableWorkflow,
  type PromotionConnectionRef,
  effectiveChanges,
  isPromotable,
  planPromotion,
} from './catalog.environment';

/**
 * `planPromotion` decides what moves between environments, and both of its
 * failure modes are silent: promoting something that should have been withheld,
 * or withholding something an operator is waiting on. Neither throws, so these
 * are the only thing standing between a refactor and a bad release.
 *
 * Everything here goes through the exported `planPromotion` rather than the
 * per-section helpers, which are deliberately module-private. The composition —
 * what order the sections run in, and what they can see of each other — is
 * precisely the part that a split into nine functions could get wrong.
 */

function objectType(
  name: string,
  overrides: Partial<PromotableObjectType> = {},
): PromotableObjectType {
  return {
    name,
    ownerPrincipalId: 'app-1',
    displayName: name,
    pluralDisplayName: `${name}s`,
    group: 'Fleet',
    primaryKey: ['id'],
    properties: [],
    ...overrides,
  };
}

function transform(id: string, overrides: Partial<PromotableTransform> = {}): PromotableTransform {
  return {
    id,
    name: id,
    language: 'javascript',
    code: 'rows => rows',
    version: 1,
    ...overrides,
  };
}

function workflow(id: string, overrides: Partial<PromotableWorkflow> = {}): PromotableWorkflow {
  return {
    id,
    name: id,
    targetType: 'Mvr',
    graphHash: 'hash-aaaaaaaa',
    version: 1,
    nodes: [],
    edges: [],
    ...overrides,
  };
}

function connector(id: string, overrides: Partial<PromotableConnector> = {}): PromotableConnector {
  return { id, name: id, kind: 'http', targetType: 'Mvr', config: {}, ...overrides };
}

function connection(
  id: string,
  overrides: Partial<PromotionConnectionRef> = {},
): PromotionConnectionRef {
  return { id, name: id, kind: 'http', ...overrides };
}

function set(overrides: Partial<CatalogPromotableSet> = {}): CatalogPromotableSet {
  return {
    objectTypes: [],
    transforms: [],
    workflows: [],
    connectors: [],
    connections: [],
    ...overrides,
  };
}

/** A plan with the clock pinned, so `createdAt` never makes two runs disagree. */
function plan(
  source: CatalogPromotableSet,
  target: CatalogPromotableSet,
  select?: readonly string[],
): CatalogPromotionPlan {
  return planPromotion({
    from: 'dev',
    to: 'prod',
    source,
    target,
    ...(select ? { select } : {}),
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  });
}

const kinds = (p: CatalogPromotionPlan): PromotableKind[] => p.changes.map((c) => c.kind);

function change(
  p: CatalogPromotionPlan,
  kind: PromotableKind,
  id: string,
): CatalogPromotionChange | undefined {
  return p.changes.find((c) => c.kind === kind && c.id === id);
}

const only = (p: CatalogPromotionPlan, kind: PromotableKind): CatalogPromotionChange[] =>
  p.changes.filter((c) => c.kind === kind);

/** One of everything, all creates, and nothing that would block. */
const oneOfEach = set({
  objectTypes: [objectType('Mvr')],
  transforms: [transform('tx')],
  workflows: [workflow('wf')],
  connectors: [connector('cn')],
});

describe('planPromotion / apply order', () => {
  /**
   * The order changes are listed in is the order they must be applied, which is
   * why this is asserted as a sequence and not as a set. A connector applied
   * before the workflow it runs points at nothing for as long as the apply
   * takes, and a type applied after the transform that writes into it has no
   * table to receive the rows.
   */
  it('lists the sections in the order they must be applied', () => {
    expect(kinds(plan(oneOfEach, set()))).toEqual([
      'objectType',
      'transform',
      'workflow',
      'connector',
    ]);
  });

  it('keeps that order when only some sections have anything to say', () => {
    const source = set({
      transforms: [transform('tx')],
      connectors: [connector('cn')],
    });
    expect(kinds(plan(source, set()))).toEqual(['transform', 'connector']);
  });
});

describe('planPromotion / the sections are independent', () => {
  /**
   * The target holds one of everything, so each section reports `unchanged`
   * unless the edit under test is its own. That matters: if the target were
   * empty, every section would report `create` in both halves of the
   * comparison, and a section contaminated by another's content would still
   * come out `create` and slip through as equal.
   */
  const target = set({
    objectTypes: [objectType('Mvr')],
    transforms: [transform('tx')],
    workflows: [workflow('wf')],
    connectors: [connector('cn')],
  });

  it('an edit to a transform leaves the object-type section untouched', () => {
    const before = plan(
      set({ objectTypes: [objectType('Mvr')], transforms: [transform('tx')] }),
      target,
    );
    const after = plan(
      set({
        objectTypes: [objectType('Mvr')],
        transforms: [transform('tx', { code: 'rows => []' })],
      }),
      target,
    );

    // The edit really did land, so the comparison below is not vacuous.
    expect(change(after, 'transform', 'tx')?.action).toBe('update');
    expect(only(after, 'objectType')).toEqual(only(before, 'objectType'));
  });

  it('an edit to an object type leaves the transform section untouched', () => {
    const before = plan(
      set({ objectTypes: [objectType('Mvr')], transforms: [transform('tx')] }),
      target,
    );
    const after = plan(
      set({
        objectTypes: [objectType('Mvr', { displayName: 'Vehicle' })],
        transforms: [transform('tx')],
      }),
      target,
    );

    expect(change(after, 'objectType', 'Mvr')?.action).toBe('update');
    expect(only(after, 'transform')).toEqual(only(before, 'transform'));
  });

  it('an edit to a workflow leaves the connector section untouched', () => {
    const base = { workflows: [workflow('wf')], connectors: [connector('cn')] };
    const before = plan(set(base), target);
    const after = plan(
      set({ ...base, workflows: [workflow('wf', { graphHash: 'hash-bbbbbbbb' })] }),
      target,
    );

    expect(change(after, 'workflow', 'wf')?.action).toBe('update');
    // The connector is `unchanged` on both sides, so a connector section that
    // had started reading workflow content would show up as a differing action.
    expect(change(before, 'connector', 'cn')?.action).toBe('unchanged');
    expect(only(after, 'connector')).toEqual(only(before, 'connector'));
  });
});

describe('planPromotion / only connectors produce blockers and withheld', () => {
  /**
   * Deliberate asymmetry, pinned because it reads as an oversight. A connector
   * is the only promotable thing that *points at* something else — a connection
   * that must already exist in the target, and code that must be there or be
   * arriving. Nothing else has a dependency to refuse or a per-environment
   * field to keep back.
   */
  it('reports neither for a promotion of types, transforms and workflows alone', () => {
    const source = set({
      objectTypes: [objectType('Mvr')],
      transforms: [transform('tx')],
      workflows: [workflow('wf')],
    });
    const p = plan(source, set({ transforms: [transform('tx', { code: 'rows => []' })] }));

    // Non-vacuous: all three sections did report something.
    expect(kinds(p)).toEqual(['objectType', 'transform', 'workflow']);
    expect(p.blockers).toEqual([]);
    expect(p.withheld).toEqual([]);
  });

  it('is the connector that introduces withheld entries', () => {
    const p = plan(set({ connectors: [connector('cn')] }), set());

    expect(p.withheld.length).toBeGreaterThan(0);
    for (const entry of p.withheld) {
      expect(['connector', 'connection']).toContain(entry.kind);
    }
  });
});

describe('planPromotion / create, update, unchanged', () => {
  /**
   * The three outcomes, per kind. Genuinely one shape — "is it in the target,
   * and does anything differ" — so it is worth one table rather than twelve
   * near-identical tests. `unchanged` is the boundary that matters: four copies
   * of this ternary were consolidated into one `actionFor`, and an item that is
   * present with nothing changed must not be reported as an update.
   */
  const cases = [
    {
      kind: 'objectType' as const,
      id: 'Mvr',
      source: set({ objectTypes: [objectType('Mvr')] }),
      identical: set({ objectTypes: [objectType('Mvr')] }),
      differing: set({ objectTypes: [objectType('Mvr', { displayName: 'Vehicle' })] }),
    },
    {
      kind: 'transform' as const,
      id: 'tx',
      source: set({ transforms: [transform('tx')] }),
      identical: set({ transforms: [transform('tx')] }),
      differing: set({ transforms: [transform('tx', { code: 'rows => []' })] }),
    },
    {
      kind: 'workflow' as const,
      id: 'wf',
      source: set({ workflows: [workflow('wf')] }),
      identical: set({ workflows: [workflow('wf')] }),
      differing: set({ workflows: [workflow('wf', { graphHash: 'hash-bbbbbbbb' })] }),
    },
    {
      kind: 'connector' as const,
      id: 'cn',
      source: set({ connectors: [connector('cn')] }),
      identical: set({ connectors: [connector('cn')] }),
      differing: set({ connectors: [connector('cn', { schedule: '0 * * * *' })] }),
    },
  ];

  describe.each(cases)('$kind', ({ kind, id, source, identical, differing }) => {
    it('is a create when the target does not have it', () => {
      expect(change(plan(source, set()), kind, id)?.action).toBe('create');
    });

    it('is unchanged, with no field diffs, when the target has it identically', () => {
      const entry = change(plan(source, identical), kind, id);
      expect(entry?.action).toBe('unchanged');
      expect(entry?.fields).toEqual([]);
    });

    it('is an update when a field differs', () => {
      const entry = change(plan(source, differing), kind, id);
      expect(entry?.action).toBe('update');
      expect(entry?.fields.length).toBeGreaterThan(0);
    });
  });

  it('effectiveChanges drops the unchanged ones', () => {
    const source = set({ transforms: [transform('tx'), transform('ty')] });
    const target = set({ transforms: [transform('tx'), transform('ty', { code: 'rows => []' })] });
    const p = plan(source, target);

    expect(p.changes).toHaveLength(2);
    expect(effectiveChanges(p).map((c) => c.id)).toEqual(['ty']);
  });
});

describe('planPromotion / a connector and its connection', () => {
  it('blocks when the connection does not exist in the target', () => {
    const source = set({
      connectors: [connector('cn', { connectionId: 'conn-1' })],
      connections: [connection('conn-1')],
    });
    const p = plan(source, set());

    expect(p.blockers).toHaveLength(1);
    expect(p.blockers[0]).toMatchObject({ kind: 'connection', id: 'conn-1' });
    expect(isPromotable(p)).toBe(false);
  });

  it('withholds, and does not block, when the target has its own of the same kind', () => {
    const source = set({
      connectors: [connector('cn', { connectionId: 'conn-1' })],
      connections: [connection('conn-1')],
    });
    const target = set({ connections: [connection('conn-1', { name: 'prod warehouse' })] });
    const p = plan(source, target);

    expect(p.blockers).toEqual([]);
    expect(isPromotable(p)).toBe(true);
    // The target's address and credential stay as the target has them.
    expect(p.withheld.some((w) => w.kind === 'connection' && w.id === 'conn-1')).toBe(true);
  });

  it('blocks when the target connection has the same id but a different kind', () => {
    const source = set({
      connectors: [connector('cn', { kind: 'sql', connectionId: 'conn-1' })],
      connections: [connection('conn-1', { kind: 'sql' })],
    });
    const target = set({ connections: [connection('conn-1', { kind: 's3' })] });
    const p = plan(source, target);

    expect(p.blockers).toHaveLength(1);
    expect(p.blockers[0].kind).toBe('connection');
    expect(isPromotable(p)).toBe(false);
  });

  it('notes, rather than blocks, a connector that carries its own configuration', () => {
    const p = plan(set({ connectors: [connector('cn')] }), set());

    expect(p.blockers).toEqual([]);
    expect(change(p, 'connector', 'cn')?.notes.join(' ')).toContain('own source configuration');
  });
});

describe('planPromotion / a connector and the code it runs', () => {
  it('blocks a connector whose transform is neither in the target nor arriving', () => {
    const p = plan(set({ connectors: [connector('cn', { transformId: 'tx' })] }), set());

    expect(p.blockers).toHaveLength(1);
    expect(p.blockers[0]).toMatchObject({ kind: 'connector', id: 'cn' });
    expect(isPromotable(p)).toBe(false);
  });

  it('accepts a connector whose transform already exists in the target', () => {
    const p = plan(
      set({ connectors: [connector('cn', { transformId: 'tx' })] }),
      set({ transforms: [transform('tx')] }),
    );

    expect(p.blockers).toEqual([]);
  });

  /**
   * The one real dependency between sections: whether a connector's code is
   * acceptable depends on what *this same promotion* is carrying. It only works
   * because connectors are planned after transforms and are handed what came
   * before — run the connector section first and this becomes a false blocker
   * on a promotion that is perfectly correct.
   */
  it('accepts a connector whose transform is arriving in this same promotion', () => {
    const source = set({
      transforms: [transform('tx')],
      connectors: [connector('cn', { transformId: 'tx' })],
    });
    const p = plan(source, set());

    expect(p.blockers).toEqual([]);
    expect(kinds(p)).toEqual(['transform', 'connector']);
  });

  it('blocks a connector whose workflow is neither in the target nor arriving', () => {
    const p = plan(set({ connectors: [connector('cn', { workflowId: 'wf' })] }), set());

    expect(p.blockers).toHaveLength(1);
    expect(p.blockers[0]).toMatchObject({ kind: 'connector', id: 'cn' });
  });

  it('accepts a connector whose workflow is arriving in this same promotion', () => {
    const source = set({
      workflows: [workflow('wf')],
      connectors: [connector('cn', { workflowId: 'wf' })],
    });

    expect(plan(source, set()).blockers).toEqual([]);
  });

  it('blocks when the arriving transform was deselected out of the promotion', () => {
    const source = set({
      transforms: [transform('tx')],
      connectors: [connector('cn', { transformId: 'tx' })],
    });
    const p = plan(source, set(), ['connector:cn']);

    expect(kinds(p)).toEqual(['connector']);
    expect(p.blockers).toHaveLength(1);
    expect(p.blockers[0]).toMatchObject({ kind: 'connector', id: 'cn' });
  });
});

describe('planPromotion / what a connector never carries', () => {
  /**
   * `enabled` is withheld on create only. A newly promoted connector arrives
   * switched off, so nothing runs in the target before somebody watches it. On
   * update the target keeps whatever it had, because re-promoting a transform
   * must not silently re-enable a connector an operator deliberately turned off.
   */
  it('arrives disabled on create, withholding every per-environment field', () => {
    const p = plan(set({ connectors: [connector('cn')] }), set());
    const entry = p.withheld.find((w) => w.kind === 'connector');

    expect(entry?.fields).toEqual(PROMOTION_WITHHELD_CONNECTOR_FIELDS);
    expect(entry?.fields).toContain('enabled');
    expect(change(p, 'connector', 'cn')?.notes.join(' ')).toContain('Arrives disabled');
  });

  it('leaves the enabled switch alone on update', () => {
    const p = plan(
      set({ connectors: [connector('cn', { schedule: '0 * * * *' })] }),
      set({ connectors: [connector('cn')] }),
    );
    const entry = p.withheld.find((w) => w.kind === 'connector');

    expect(change(p, 'connector', 'cn')?.action).toBe('update');
    expect(entry?.fields).not.toContain('enabled');
    expect(entry?.fields).toContain('state');
  });
});

describe('planPromotion / selection', () => {
  it('carries only what was selected, by kind and id', () => {
    const p = plan(oneOfEach, set(), ['transform:tx', 'objectType:Mvr']);

    expect(kinds(p)).toEqual(['objectType', 'transform']);
  });

  it('carries everything when nothing was selected', () => {
    expect(kinds(plan(oneOfEach, set()))).toHaveLength(4);
  });
});

describe('planPromotion / fingerprint', () => {
  it('is the same for two previews of the same effect taken at different times', () => {
    const shape = { from: 'dev', to: 'prod', source: oneOfEach, target: set() } as const;
    const first = planPromotion({ ...shape, now: () => new Date('2026-01-01T00:00:00.000Z') });
    const second = planPromotion({ ...shape, now: () => new Date('2026-06-30T12:34:56.000Z') });

    expect(first.createdAt).not.toEqual(second.createdAt);
    expect(first.fingerprint).toEqual(second.fingerprint);
  });

  it('differs once a change would do something different', () => {
    const before = plan(set({ transforms: [transform('tx')] }), set());
    const after = plan(set({ transforms: [transform('tx', { code: 'rows => []' })] }), set());

    expect(before.fingerprint).not.toEqual(after.fingerprint);
  });

  /**
   * "It was blocked when I looked at it" is not approval of the unblocked
   * version, so a plan that becomes appliable in between must not be accepted
   * under the old fingerprint.
   */
  it('differs between a blocked plan and the same plan unblocked', () => {
    const source = set({ connectors: [connector('cn', { transformId: 'tx' })] });
    const blocked = plan(source, set());
    const unblocked = plan(source, set({ transforms: [transform('tx')] }));

    expect(isPromotable(blocked)).toBe(false);
    expect(isPromotable(unblocked)).toBe(true);
    expect(blocked.fingerprint).not.toEqual(unblocked.fingerprint);
  });
});
