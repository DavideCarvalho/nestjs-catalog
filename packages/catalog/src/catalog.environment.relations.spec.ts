import { describe, expect, it } from 'vitest';
import {
  type CatalogPromotableSet,
  type CatalogPromotionPlan,
  type PromotableObjectType,
  planPromotion,
} from './catalog.environment';

/**
 * That a promotion whose only content is a link is a promotion.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `PromotableObjectType` carried properties and no relations, so `diffObjectType`
 * had nothing to compare and a type whose only difference was a link came back
 * `unchanged`. That is the quietest failure available here: the plan an operator
 * reads says "nothing to promote", the apply is driven by that same plan and so
 * does nothing, and the type already in production keeps looking complete —
 * right properties, right table, right owner — while its graph shows it as an
 * island. Nothing errors, at any point.
 *
 * The plan is what somebody approves. A change invisible in the plan is a change
 * nobody approved, and the fingerprint they approved has to distinguish it from
 * every other change — which is why removals are asserted here down to what the
 * hash sees, and not only to what the diff lists.
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

/** One link, as `Mvr.base` would be stored: the many end, holding the key. */
function link(
  name: string,
  overrides: Partial<NonNullable<PromotableObjectType['relations']>[number]> = {},
): NonNullable<PromotableObjectType['relations']>[number] {
  return {
    name,
    displayName: name,
    kind: 'm:1',
    targetType: 'Base',
    localKey: `${name}_id`,
    nullable: true,
    hidden: false,
    position: 0,
    owner: true,
    ...overrides,
  };
}

function set(objectTypes: PromotableObjectType[]): CatalogPromotableSet {
  return { objectTypes, transforms: [], workflows: [], connectors: [], connections: [] };
}

/** The clock pinned, so `createdAt` never makes two runs disagree. */
function plan(source: CatalogPromotableSet, target: CatalogPromotableSet): CatalogPromotionPlan {
  return planPromotion({
    from: 'dev',
    to: 'prod',
    source,
    target,
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  });
}

/** The one object-type change, insisted upon rather than assumed. */
function typeChange(p: CatalogPromotionPlan) {
  const change = p.changes.find((c) => c.kind === 'objectType' && c.id === 'Mvr');
  expect(change).toBeDefined();
  return change;
}

const fields = (p: CatalogPromotionPlan): string[] =>
  (typeChange(p)?.fields ?? []).map((field) => field.field);

describe('a promotion that only moves a link', () => {
  it('is an update rather than "nothing to promote"', () => {
    // The whole feature in one assertion. Without relations on the diff this is
    // `unchanged`, the plan is empty, and the apply — which is driven by the
    // plan — writes nothing.
    const p = plan(
      set([objectType('Mvr', { relations: [link('base')] })]),
      set([objectType('Mvr')]),
    );

    expect(typeChange(p)?.action).toBe('update');
    expect(fields(p)).toContain('relations.added');
  });

  it('names the link that arrived', () => {
    const p = plan(
      set([
        objectType('Mvr', { relations: [link('base'), link('depot', { targetType: 'Depot' })] }),
      ]),
      set([objectType('Mvr', { relations: [link('base')] })]),
    );

    expect(typeChange(p)?.fields).toContainEqual({
      field: 'relations.added',
      from: [],
      to: ['depot'],
    });
  });

  it('reports a link whose structure moved as changed', () => {
    // The join column is the field a stale copy of makes into a link that no
    // longer exists, so it has to reach the reviewer.
    const p = plan(
      set([objectType('Mvr', { relations: [link('base', { localKey: 'home_base_id' })] })]),
      set([objectType('Mvr', { relations: [link('base')] })]),
    );

    expect(typeChange(p)?.action).toBe('update');
    expect(typeChange(p)?.fields).toContainEqual({
      field: 'relations.changed',
      from: ['base'],
      to: ['base'],
    });
  });

  it('reports a curated label on a link as changed, because promotion carries curation', () => {
    const p = plan(
      set([objectType('Mvr', { relations: [link('base', { displayName: 'Home base' })] })]),
      set([objectType('Mvr', { relations: [link('base')] })]),
    );

    expect(fields(p)).toEqual(['relations.changed']);
  });

  it('says a link was REMOVED, not that it is merely absent from the source', () => {
    // The word is the contract. `properties.absentFromSource` is soft because
    // nothing acts on it — `ensureType` never drops a column, so the data stays.
    // A link that vanished from the source really is deleted in the target, and
    // a reviewer reading the plan has to be able to tell those two apart.
    const p = plan(
      set([objectType('Mvr')]),
      set([objectType('Mvr', { relations: [link('base')] })]),
    );

    expect(typeChange(p)?.action).toBe('update');
    expect(fields(p)).toEqual(['relations.removed']);
    expect(fields(p)).not.toContain('relations.absentFromSource');
  });

  it('leaves an identical set of links reported as unchanged', () => {
    // The boundary. A diff that pushed a field whenever relations existed would
    // report every re-promotion as a change and train everybody to click through
    // the preview.
    const p = plan(
      set([objectType('Mvr', { relations: [link('base')] })]),
      set([objectType('Mvr', { relations: [link('base')] })]),
    );

    expect(typeChange(p)?.action).toBe('unchanged');
    expect(typeChange(p)?.fields).toEqual([]);
  });

  it('treats an environment predating the relations column as holding none', () => {
    // Those rows hold NULL, so the set built from them carries no `relations` at
    // all. Comparing absent against empty as a difference would make the first
    // promotion after this shipped report every type as changed.
    const p = plan(set([objectType('Mvr', { relations: [] })]), set([objectType('Mvr')]));

    expect(typeChange(p)?.action).toBe('unchanged');
  });
});

describe('the fingerprint an approval is compared against', () => {
  it('moves when a link is added', () => {
    // Otherwise a plan approved before the link existed stays applicable after
    // it does, which is the check that exists to make approval mean something.
    const before = plan(set([objectType('Mvr')]), set([objectType('Mvr')]));
    const after = plan(
      set([objectType('Mvr', { relations: [link('base')] })]),
      set([objectType('Mvr')]),
    );

    expect(before.fingerprint).not.toEqual(after.fingerprint);
  });

  it('tells one removed link apart from another', () => {
    // The hash is built from each field's `to` value. A removal reported with an
    // empty `to` would hash the same however many links, and whichever ones,
    // were being dropped — so an approval to drop the link to Base would be
    // presentable as an approval to drop the link to Depot.
    const target = set([
      objectType('Mvr', {
        relations: [link('base'), link('depot', { targetType: 'Depot', position: 1 })],
      }),
    ]);
    const dropsBase = plan(
      set([
        objectType('Mvr', { relations: [link('depot', { targetType: 'Depot', position: 1 })] }),
      ]),
      target,
    );
    const dropsDepot = plan(set([objectType('Mvr', { relations: [link('base')] })]), target);

    expect(fields(dropsBase)).toEqual(['relations.removed']);
    expect(fields(dropsDepot)).toEqual(['relations.removed']);
    expect(dropsBase.fingerprint).not.toEqual(dropsDepot.fingerprint);
  });

  it('tells one added link apart from another', () => {
    const source = (name: string, targetType: string) =>
      set([objectType('Mvr', { relations: [link(name, { targetType })] })]);
    const addsBase = plan(source('base', 'Base'), set([objectType('Mvr')]));
    const addsDepot = plan(source('depot', 'Depot'), set([objectType('Mvr')]));

    expect(addsBase.fingerprint).not.toEqual(addsDepot.fingerprint);
  });
});
