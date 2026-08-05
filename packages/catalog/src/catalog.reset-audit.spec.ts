import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import type { EntityProperty } from '@mikro-orm/core';
import { EntityMetadata, MetadataStorage, MikroORM, ReferenceKind } from '@mikro-orm/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CATALOG_EVENTS,
  CATALOG_EVENT_PHASE,
  catalogEventPhase,
  channelNameFor,
} from './catalog.events';
import { InMemoryCatalogOverlayStore } from './catalog.overlay-store';
import { MikroOrmCatalogRegistry } from './catalog.registry';

/**
 * That reverting every curated value leaves a trail, and that the trail says
 * what was in it.
 *
 * `patchType` and `patchProperty` were audited from the start, on the argument
 * that "who renamed this column and when" is a governance question with no other
 * answer. `resetOverlay` discards every one of those decisions catalog-wide,
 * under the same `catalog:curate` scope, and emitted nothing — so the trail
 * could name the person who renamed one column and not the person who reverted
 * every name at once. Un-classifying a property this way also re-admits its name
 * to search results, because `visibleToPrincipal` filters on `classification`.
 *
 * These assert through a subscriber rather than a spy on `emitCatalog`, for the
 * reason the sharing-audit spec gives: a spy passes on an event name no recorder
 * subscribes to, which is a trail that reaches nothing. The recorder below
 * iterates `CATALOG_EVENTS` exactly as the shipped one does, so membership in
 * that list is part of what is under test.
 */

function entity(className: string, props: Array<Partial<EntityProperty>>): EntityMetadata {
  const meta = new EntityMetadata({
    className,
    tableName: className.toLowerCase(),
    primaryKeys: ['id'],
  });
  for (const prop of props) meta.addProperty(prop);
  return meta;
}

function scalar(name: string): Partial<EntityProperty> {
  return { name, kind: ReferenceKind.SCALAR, type: 'string' };
}

/** A MikroORM whose only method is the one the registry calls. */
function ormOver(metas: EntityMetadata[]): MikroORM {
  const storage = new MetadataStorage(
    Object.fromEntries(metas.map((meta) => [meta.className, meta])),
  );
  const orm = Object.create(MikroORM.prototype);
  orm.getMetadata = () => storage;
  return orm;
}

interface Recorded {
  event: string;
  payload: Record<string, unknown>;
}

/**
 * The shipped recorder's contract restated: subscribe to every name in
 * `CATALOG_EVENTS`, keep the payload. An event emitted under a name absent from
 * that list arrives here exactly as it would arrive in production — not at all.
 */
class TestAuditRecorder {
  readonly events: Recorded[] = [];
  private readonly handlers = new Map<string, (message: unknown) => void>();

  constructor() {
    for (const event of CATALOG_EVENTS) {
      const channel = channelNameFor(event);
      const handler = (message: unknown): void => {
        const envelope = message && typeof message === 'object' ? message : {};
        const raw = Reflect.get(envelope, 'payload');
        const payload = raw && typeof raw === 'object' ? raw : {};
        this.events.push({ event, payload: { ...payload } });
      };
      subscribe(channel, handler);
      this.handlers.set(channel, handler);
    }
  }

  of(event: string): Array<Record<string, unknown>> {
    return this.events.filter((recorded) => recorded.event === event).map((r) => r.payload);
  }

  stop(): void {
    for (const [channel, handler] of this.handlers) unsubscribe(channel, handler);
    this.handlers.clear();
  }
}

function registryOver(metas: EntityMetadata[]): MikroOrmCatalogRegistry {
  return new MikroOrmCatalogRegistry(ormOver(metas), {}, new InMemoryCatalogOverlayStore());
}

/** Two types with something to curate on each. */
function catalogOfTwo(): MikroOrmCatalogRegistry {
  return registryOver([
    entity('Dispute', [scalar('id'), scalar('settlementAmount')]),
    entity('WorkOrder', [scalar('id'), scalar('acftSn')]),
  ]);
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function asRecords(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
  );
}

describe('resetting the overlay is audited', () => {
  let recorder: TestAuditRecorder | undefined;

  afterEach(() => {
    recorder?.stop();
    recorder = undefined;
  });

  function recording(): TestAuditRecorder {
    recorder = new TestAuditRecorder();
    return recorder;
  }

  it('records the reset, under a name a recorder is listening for', async () => {
    const registry = catalogOfTwo();
    await registry.patchType('Dispute', { displayName: 'Case' });

    const trail = recording();
    await registry.resetOverlay();

    expect(trail.of('overlay.reset')).toHaveLength(1);
  });

  it('names every type whose curation it destroyed', async () => {
    const registry = catalogOfTwo();
    await registry.patchType('Dispute', { displayName: 'Case' });
    await registry.patchProperty('WorkOrder', 'acftSn', { displayName: 'Tail number' });

    const trail = recording();
    await registry.resetOverlay();

    const [payload] = trail.of('overlay.reset');
    expect(asStrings(payload?.typeNames).sort()).toEqual(['Dispute', 'WorkOrder']);
  });

  it('counts the property entries that went with them', async () => {
    const registry = catalogOfTwo();
    await registry.patchProperty('Dispute', 'settlementAmount', { hidden: true });
    await registry.patchProperty('WorkOrder', 'acftSn', { displayName: 'Tail number' });
    // A second patch of the same property is still one entry: the payload counts
    // what was lost, not how many times somebody typed it.
    await registry.patchProperty('WorkOrder', 'acftSn', { order: 3 });

    const trail = recording();
    await registry.resetOverlay();

    expect(trail.of('overlay.reset')[0]?.properties).toBe(2);
  });

  /**
   * The one part of the payload that is about access rather than presentation.
   * A classification is what search filters on, so this list is the record of
   * which property names became visible to principals who could not see them a
   * moment earlier — and the value is carried because re-typing it is the only
   * recovery available once the overlay is gone.
   */
  it('lists every classification that stopped applying, with its value', async () => {
    const registry = catalogOfTwo();
    await registry.patchProperty('Dispute', 'settlementAmount', { classification: 'CUI' });
    await registry.patchProperty('WorkOrder', 'acftSn', { displayName: 'Tail number' });

    const trail = recording();
    await registry.resetOverlay();

    expect(asRecords(trail.of('overlay.reset')[0]?.classifications)).toEqual([
      { typeName: 'Dispute', property: 'settlementAmount', classification: 'CUI' },
    ]);
  });

  it('records a reset that destroyed nothing, with zeroes', async () => {
    const registry = catalogOfTwo();

    const trail = recording();
    await registry.resetOverlay();

    const [payload] = trail.of('overlay.reset');
    expect(payload).toEqual({ typeNames: [], properties: 0, classifications: [] });
  });

  /**
   * The deliberate limit, pinned. The payload is a summary because an audit row
   * holding a verbatim copy of the overlay is a backup nobody designed — and the
   * way that would arrive is somebody adding "just the labels too" and then "just
   * the descriptions". This is the assertion that has to be edited first.
   */
  it('carries a summary and not the overlay', async () => {
    const registry = catalogOfTwo();
    await registry.patchType('Dispute', { displayName: 'Case', description: 'Money at stake' });
    await registry.patchProperty('Dispute', 'settlementAmount', {
      displayName: 'Amount',
      unit: 'USD',
    });

    const trail = recording();
    await registry.resetOverlay();

    const [payload] = trail.of('overlay.reset');
    expect(Object.keys(payload ?? {}).sort()).toEqual([
      'classifications',
      'properties',
      'typeNames',
    ]);
    expect(JSON.stringify(payload)).not.toContain('Money at stake');
    expect(JSON.stringify(payload)).not.toContain('USD');
  });

  it('is one event, not one per curated type', async () => {
    const registry = catalogOfTwo();
    await registry.patchType('Dispute', { displayName: 'Case' });
    await registry.patchType('WorkOrder', { displayName: 'Work Order' });

    const trail = recording();
    await registry.resetOverlay();

    expect(trail.events.map((e) => e.event)).toEqual(['overlay.reset']);
  });

  it('still puts the catalog back, which is what it was for', async () => {
    const registry = catalogOfTwo();
    await registry.patchType('Dispute', { displayName: 'Case' });

    const trail = recording();
    await registry.resetOverlay();

    expect(registry.getType('Dispute')?.displayName).toBe('Dispute');
    expect(trail.of('overlay.reset')).toHaveLength(1);
  });

  /**
   * Ranked beside the event it undoes. Neither carries a snapshot id, so neither
   * rank is ever consulted while ordering a trace — what this pins is that the
   * name was placed deliberately rather than falling through to the unknown-event
   * default, which is the reading "this library does not recognise it".
   */
  it('is ranked with curation rather than left to the fallback', () => {
    expect(catalogEventPhase('overlay.reset')).toBe(CATALOG_EVENT_PHASE['type.curated']);
  });
});
