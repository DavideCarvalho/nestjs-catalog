import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import {
  CATALOG_EVENTS,
  UNATTRIBUTED_PRINCIPAL_ID,
  channelNameFor,
} from '@dudousxd/nestjs-catalog';
import { afterEach, describe, expect, it } from 'vitest';
import { SnapshotRow } from './entities/governance';
import { ObjectTypeRow, PropertyRow } from './entities/model';
import { StoredCatalogRegistry } from './stored-registry.service';

/**
 * That the *stored* registry names the curator too.
 *
 * There are two implementations of `CatalogRegistry` and they emit `type.curated`
 * independently: the in-app one from its overlay, this one from the rows a
 * publisher wrote. Threading the actor through one of them and not the other
 * would leave the trail's answer to "who renamed this" depending on which
 * registry the deployment happens to run — and this is the one a real deployment
 * runs, because it serves types whose entity classes are not in the process.
 *
 * Asserted through a channel subscriber rather than a spy on `emitCatalog`, for
 * the reason the sibling audit specs give: a spy passes on a payload no recorder
 * lifts anything out of. The tap below reads `principalId` exactly where
 * `CatalogAuditRecorder` reads it.
 */

const ANA = 'catalog-console#ana@example.com';

/** Every catalog event that came past, with its payload. */
class ChannelTap {
  readonly events: Array<{ event: string; payload: Record<string, unknown> }> = [];
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

/** A row as MikroORM would hand one back, so the entity's own accessors run. */
function typeRow(name: string): ObjectTypeRow {
  const row: ObjectTypeRow = Object.create(ObjectTypeRow.prototype);
  return Object.assign(row, {
    name,
    displayName: name,
    pluralDisplayName: `${name}s`,
    physicalTable: name.toLowerCase(),
    group: 'default',
    primaryKey: ['id'],
    properties: { getItems: () => [] },
    relations: [],
  });
}

function propertyRow(typeName: string, name: string): PropertyRow {
  const row: PropertyRow = Object.create(PropertyRow.prototype);
  return Object.assign(row, {
    id: `${typeName}.${name}`,
    name,
    displayName: name,
    type: 'string',
    sourceColumn: name,
    nullable: true,
    primary: false,
    hidden: false,
    position: 0,
  });
}

/**
 * A registry over one type and one column, wired by hand.
 *
 * Constructed off the prototype rather than through `new`, the way
 * `stored-registry.reset.spec.ts` does: the only paths exercised here are the two
 * patches and the reload they trigger, and standing up a real ORM to reach them
 * would put a database between this assertion and the line it is about.
 */
function registryOver(): StoredCatalogRegistry {
  const type = typeRow('Mvr');
  const property = propertyRow('Mvr', 'acftSn');
  const fork = () => ({
    find: async (entity: unknown) => {
      if (entity === ObjectTypeRow) return [type];
      if (entity === SnapshotRow) return [];
      throw new Error('unexpected entity in reload');
    },
    findOne: async (entity: unknown) => {
      if (entity === PropertyRow) return property;
      if (entity === ObjectTypeRow) return type;
      throw new Error('unexpected entity in findOne');
    },
    flush: async () => undefined,
    // See `stored-registry.freshness.spec.ts`: `reload` asks which snapshots are
    // serving before hydrating any, and no fixture here commits a load. An empty
    // answer means the snapshot read is skipped altogether.
    getConnection: () => ({
      execute: async (sql: string) => (sql.includes('catalog_snapshot') ? [] : WATERMARK_ANSWER),
    }),
  });

  const registry: StoredCatalogRegistry = Object.create(StoredCatalogRegistry.prototype);
  return Object.assign(registry, {
    em: { fork },
    // Never reached: `ensureCatalogSchema` runs from `onModuleInit`, which this
    // registry is never given. Left undefined rather than faked, so a path that
    // starts using it fails here loudly instead of against a stub that lies.
    orm: undefined,
    // The background staleness check off: these fixtures are about what
    // `reload` builds, not about a sibling process noticing a write.
    options: { staleAfterMs: 0 },
    snapshot: { version: 0, generatedAt: '', stats: {}, types: [] },
  });
}

/**
 * `reload` reads a staleness watermark over the model tables before anything
 * else, so the fakes below have to answer it or the rebuild stops there. Its
 * contents do not matter here — the check that would consult it is turned off,
 * with `staleAfterMs: 0` — and what it does is
 * `stored-registry.staleness.spec.ts`'s subject.
 */
const WATERMARK_ANSWER = [
  { type_rows: 0, type_at: null, property_rows: 0, property_at: null, db_now: new Date(0) },
];

describe('the stored registry names the curator', () => {
  let tap: ChannelTap | undefined;

  afterEach(() => {
    tap?.stop();
    tap = undefined;
  });

  function recording(): ChannelTap {
    tap = new ChannelTap();
    return tap;
  }

  it('carries the acting principal on a type patch', async () => {
    const registry = registryOver();
    const trail = recording();

    await registry.patchType('Mvr', { displayName: 'Vehicle' }, ANA);

    expect(trail.of('type.curated')[0]).toMatchObject({
      typeName: 'Mvr',
      changed: ['displayName'],
      principalId: ANA,
    });
  });

  it('carries it on a property patch', async () => {
    const registry = registryOver();
    const trail = recording();

    await registry.patchProperty('Mvr', 'acftSn', { displayName: 'Tail number' }, ANA);

    expect(trail.of('type.curated')[0]).toMatchObject({
      typeName: 'Mvr',
      property: 'acftSn',
      principalId: ANA,
    });
  });

  it('says "unattributed" rather than nothing when the caller named nobody', async () => {
    // The caller the required parameter cannot bind: a host script, or an
    // override compiled against the older argument list. An empty string here
    // would be written as NULL by the recorder, which reads as "nobody did this"
    // rather than "this was not captured".
    const registry = registryOver();
    const trail = recording();

    // `unknown` and `Reflect.apply`, because `Reflect.get` keeps the declared
    // signature for a known key — a direct call would be checked for the argument
    // this case exists to omit.
    const call: unknown = Reflect.get(registry, 'patchType');
    if (typeof call !== 'function') throw new Error('patchType is not callable');
    await Reflect.apply(call, registry, ['Mvr', { displayName: 'Vehicle' }]);

    expect(trail.of('type.curated')[0]?.principalId).toBe(UNATTRIBUTED_PRINCIPAL_ID);
  });
});
