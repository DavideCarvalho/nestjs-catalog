import type { EntityProperty } from '@mikro-orm/core';
import { EntityMetadata, MetadataStorage, MikroORM, ReferenceKind } from '@mikro-orm/core';
import { describe, expect, it } from 'vitest';
import { InMemoryCatalogOverlayStore } from './catalog.overlay-store';
import { MikroOrmCatalogRegistry } from './catalog.registry';

/**
 * What a mounted catalog costs an API process **before it serves anything**.
 *
 * ## Why this is measured separately from the timers
 *
 * The two loops this package runs are gated off on an API-role process — a host
 * passes `scheduler: false` there, and `reconcileRuns` defaults to it — so an
 * API pod pays no polling tax at all. What it does pay, unconditionally, is
 * boot: `MikroOrmCatalogRegistry` walks the host's entire MikroORM metadata
 * graph and builds a catalog out of it, synchronously, in `onModuleInit`.
 *
 * That is the shape of thing that shows up as event-loop lag and not as CPU: it
 * is one uninterrupted stretch of work, it happens while the process is coming
 * up alongside everything else the host is doing, and it is invisible in an
 * average taken over an hour of uptime.
 *
 * ## The size
 *
 * Taken from a real deployment's own boot log — "Catalog built: 60 object types,
 * 902 properties, 68 relations" — rather than invented, so the number this
 * prints is the number that deployment pays. It is a **lower** bound on a host
 * with more entities, and it scales linearly: the build is two passes over the
 * metadata and one sort.
 *
 * The timing is reported and never asserted. What is asserted is the shape —
 * that the fixture really is the size it claims to be — because a fixture that
 * silently shrank would make the measurement meaningless while still passing.
 */

/** From the deployment's boot log. Not a round number on purpose. */
const TYPES = 60;
const PROPERTIES = 902;
const RELATIONS = 68;

function scalar(name: string, index: number): Partial<EntityProperty> {
  return {
    name,
    kind: ReferenceKind.SCALAR,
    type: index % 3 === 0 ? 'number' : index % 3 === 1 ? 'string' : 'Date',
    fieldNames: [name],
    nullable: index % 4 === 0,
  };
}

function relation(name: string, target: string): Partial<EntityProperty> {
  return {
    name,
    kind: ReferenceKind.MANY_TO_ONE,
    type: target,
    fieldNames: [`${name}_id`],
  };
}

/**
 * A metadata graph the size of the one the deployment reported.
 *
 * Properties are spread evenly rather than piled onto one type, and every
 * relation points at a type that is also published — which is the *expensive*
 * arrangement, because a relation whose target is published is the one the
 * second pass has to describe rather than drop.
 */
function hostMetadata(): EntityMetadata[] {
  const names = Array.from({ length: TYPES }, (_, index) => `HostEntity${index}Record`);
  const scalarsPer = Math.floor((PROPERTIES - RELATIONS) / TYPES);
  const extra = PROPERTIES - RELATIONS - scalarsPer * TYPES;

  return names.map((className, typeIndex) => {
    const meta = new EntityMetadata({
      className,
      tableName: className.toLowerCase(),
      primaryKeys: ['id'],
    });
    const count = scalarsPer + (typeIndex < extra ? 1 : 0);
    for (let index = 0; index < count; index += 1) {
      meta.addProperty(scalar(index === 0 ? 'id' : `someColumnName${index}`, index));
    }
    // The relations, dealt round-robin: one each, and a second to as many as it
    // takes to reach the count the deployment reported.
    const links = 1 + (typeIndex < RELATIONS - TYPES ? 1 : 0);
    for (let index = 0; index < links; index += 1) {
      meta.addProperty(relation(`linkedRecord${index}`, names[(typeIndex + index + 1) % TYPES]));
    }
    return meta;
  });
}

/** The registry only ever calls `getMetadata()`, so this is that one method. */
function ormOver(metas: EntityMetadata[]): MikroORM {
  const storage = new MetadataStorage(
    Object.fromEntries(metas.map((meta) => [meta.className, meta])),
  );
  const orm = Object.create(MikroORM.prototype);
  orm.getMetadata = () => storage;
  return orm;
}

describe('what a catalog costs an API process at boot', () => {
  it('builds the whole catalog from the host metadata in one synchronous stretch', async () => {
    const registry = new MikroOrmCatalogRegistry(
      ormOver(hostMetadata()),
      {},
      new InMemoryCatalogOverlayStore(),
    );

    const started = performance.now();
    await registry.onModuleInit();
    const built = performance.now() - started;

    const { stats } = registry.getSnapshot();
    console.log(
      `[boot-cost] registry build: ${stats.types} types, ${stats.properties} properties, ${stats.relations} relations in ${Math.round(built * 100) / 100}ms`,
    );

    // The fixture is the size it claims to be. Without this the timing above
    // would go on printing happily while measuring a tenth of the work.
    expect(stats.types).toBe(TYPES);
    expect(stats.properties + stats.relations).toBe(PROPERTIES);
    expect(stats.relations).toBe(RELATIONS);
  });

  /**
   * The same build again, because it is not only a boot cost.
   *
   * Every tier-0 curation edit — a display name, a description, hiding a column
   * — calls `persist`, which rebuilds the entire snapshot from scratch. That is
   * the same synchronous stretch as above, on a request thread, and a console
   * user renaming six columns pays it six times.
   */
  it('pays the same stretch again on every curation edit', async () => {
    const registry = new MikroOrmCatalogRegistry(
      ormOver(hostMetadata()),
      {},
      new InMemoryCatalogOverlayStore(),
    );
    await registry.onModuleInit();
    const first = registry.getSnapshot().types[0];

    const started = performance.now();
    await registry.patchType(first.name, { description: 'Curated.' }, 'ana');
    const rebuilt = performance.now() - started;

    console.log(`[boot-cost] one curation edit: ${Math.round(rebuilt * 100) / 100}ms`);
    expect(registry.getType(first.name)?.description).toBe('Curated.');
  });

  /**
   * What `GET /catalog` costs the main thread once the snapshot exists.
   *
   * The route hands back the whole ontology as data, so every console page load
   * serialises it — 60 types and 902 properties — and Nest does that
   * synchronously with `JSON.stringify` after the handler returns. This is
   * per-request main-thread work that no database is involved in, which is
   * exactly the shape that reads as event-loop lag against a flat CPU line, so
   * it is worth having the number rather than assuming it.
   */
  it('serialises the whole ontology on every request for it', async () => {
    const registry = new MikroOrmCatalogRegistry(
      ormOver(hostMetadata()),
      {},
      new InMemoryCatalogOverlayStore(),
    );
    await registry.onModuleInit();

    // Ten, and the mean reported, because one pass is dominated by whether the
    // shape happened to be warm.
    const started = performance.now();
    let bytes = 0;
    for (let index = 0; index < 10; index += 1) {
      bytes = JSON.stringify(registry.getSnapshot()).length;
    }
    const each = (performance.now() - started) / 10;

    console.log(
      `[boot-cost] GET /catalog: ${Math.round(bytes / 1024)}KB serialised in ${Math.round(each * 100) / 100}ms`,
    );
    expect(bytes).toBeGreaterThan(0);
  });
});
