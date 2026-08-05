/**
 * That a replica notices a write it did not make.
 *
 * The bug: `StoredCatalogRegistry` holds the model in memory and rebuilt it only
 * when something in its own process wrote. A deployment with two replicas
 * therefore answered `PUT publish/:type/schema` with a 200 from one pod, and
 * refused a connector run against the same type from the other — "SchedMx has
 * not been published yet" — for as long as that pod lived. Which one a request
 * hit was load-balancer luck.
 *
 * Every case below runs **two registries over one store**, because that is the
 * only shape in which the bug exists at all. A single registry that reloads
 * after its own write has always been correct, and a suite built on one would
 * pass whether or not any of this works.
 *
 * The store is a fake, and deliberately a *stateful* one rather than a stub
 * returning canned rows: what is under test is whether reading the database
 * twice, either side of somebody else's write, produces two different answers.
 * `stored-registry.staleness.db.spec.ts` runs the same argument against MySQL 8,
 * where the watermark statement itself is executed rather than imitated.
 */
import type { MikroORM } from '@mikro-orm/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ObjectTypeRow } from './entities/model';
import type { CatalogStoreModuleOptions } from './options';
import { StoredCatalogRegistry } from './stored-registry.service';

/** A published column, with the timestamp the watermark reads. */
interface FakeProperty {
  name: string;
  displayName: string;
  type: string;
  sourceColumn: string;
  nullable: boolean;
  primary: boolean;
  hidden: boolean;
  position: number;
  updatedAt: Date;
}

/** A published type, with the timestamp the watermark reads. */
interface FakeType {
  name: string;
  updatedAt: Date;
  properties: FakeProperty[];
}

/** Elapsed real milliseconds, for letting a staleness window close. */
function elapse(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A promise something else resolves. Written out rather than reached for from
 * the platform, because `Promise.withResolvers` needs Node 22 and this package
 * supports what its peers support. */
function deferred(): { promise: Promise<void>; release: () => void } {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/**
 * The two model tables, shared by every registry opened over them.
 *
 * The clock is a field rather than `Date.now()` for one reason that is not
 * convenience: `updated_at` is a `DATETIME`, so MySQL stores it to the second,
 * and the registry has a rule about a watermark read inside the second of its
 * own newest write. A test of that rule has to be able to keep two writes inside
 * one second on purpose, and then let the second close. Truncation is applied on
 * write, exactly where the engine applies it.
 */
class FakeCatalogStore {
  private readonly types = new Map<string, FakeType>();
  private now = Date.UTC(2026, 7, 5, 9, 0, 0);
  /** Every statement the store was asked to run, in order. */
  readonly statements: string[] = [];
  /** Set to make the next watermark read fail, as a database going away does. */
  failing = false;
  /** Set to hold every statement open until it is released. */
  gate?: ReturnType<typeof deferred>;

  /** Move the database's clock on, so a write's second can close. */
  advance(ms: number): void {
    this.now += ms;
  }

  private stamp(): Date {
    // Truncated to the second, which is what a `DATETIME` column does to it.
    return new Date(Math.floor(this.now / 1000) * 1000);
  }

  publish(name: string, properties: string[] = ['id']): void {
    const at = this.stamp();
    this.types.set(name, {
      name,
      updatedAt: at,
      properties: properties.map((property, index) => ({
        name: property,
        displayName: property,
        type: 'string',
        sourceColumn: property,
        nullable: true,
        primary: index === 0,
        hidden: false,
        position: index,
        updatedAt: at,
      })),
    });
  }

  /**
   * Rename one field. The write `patchProperty` makes, and the one that touches
   * `catalog_property` and nothing else.
   */
  renameProperty(typeName: string, propertyName: string, displayName: string): void {
    const property = this.types.get(typeName)?.properties.find((p) => p.name === propertyName);
    if (!property) throw new Error(`no such property ${typeName}.${propertyName}`);
    property.displayName = displayName;
    property.updatedAt = this.stamp();
  }

  /** The EntityManager a registry is constructed over. */
  entityManager(): { fork: () => unknown } {
    return { fork: () => this.fork() };
  }

  private fork(): unknown {
    const find = async (entity: unknown) => {
      if (entity !== ObjectTypeRow) return [];
      return [...this.types.values()].map((type) => this.row(type));
    };
    const execute = async (sql: string) => {
      this.statements.push(sql);
      if (this.gate) await this.gate.promise;
      if (this.failing) throw new Error('Lost connection to the catalog database');
      // No committed loads in these fixtures, which is what a catalog whose
      // types are published and not yet loaded looks like. `servingSnapshots`
      // then issues no snapshot read at all, so the model rows are the whole
      // subject here.
      if (sql.includes('catalog_snapshot')) return [];
      return [this.watermark()];
    };
    return { find, getConnection: () => ({ execute }) };
  }

  /** What `WATERMARK_SQL` would answer over the current contents. */
  private watermark(): Record<string, unknown> {
    const types = [...this.types.values()];
    const properties = types.flatMap((type) => type.properties);
    return {
      type_rows: types.length,
      type_at: newest(types.map((type) => type.updatedAt)),
      property_rows: properties.length,
      property_at: newest(properties.map((property) => property.updatedAt)),
      db_now: this.stamp(),
    };
  }

  /** An `ObjectTypeRow` as `reload` reads one. */
  private row(type: FakeType): ObjectTypeRow {
    const row = Object.create(ObjectTypeRow.prototype);
    return Object.assign(row, {
      name: type.name,
      displayName: type.name,
      pluralDisplayName: `${type.name}s`,
      physicalTable: type.name.toLowerCase(),
      group: 'default',
      primaryKey: ['id'],
      properties: { getItems: () => type.properties },
    });
  }
}

function newest(dates: Date[]): Date | null {
  if (dates.length === 0) return null;
  return new Date(Math.max(...dates.map((date) => date.getTime())));
}

/**
 * One process's registry over the shared store.
 *
 * Built by hand rather than through Nest, because what a case needs is two of
 * them over one store — which is what two pods are — and the constructor's three
 * arguments are the whole of the wiring. `logger` is assigned because
 * `Object.create` runs no field initialisers, and the failure case below reaches
 * it.
 */
function registryOver(
  store: FakeCatalogStore,
  options: CatalogStoreModuleOptions = {},
): { registry: StoredCatalogRegistry; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  const registry: StoredCatalogRegistry = Object.create(StoredCatalogRegistry.prototype);
  const orm: MikroORM | undefined = undefined;
  Object.assign(registry, {
    logger: { log: () => {}, warn },
    em: store.entityManager(),
    orm,
    options,
    snapshot: { version: 0, generatedAt: '', stats: {}, types: [] },
    watermark: undefined,
    lastCheckedAt: 0,
    refreshing: false,
    warnedAboutWatermark: false,
  });
  return { registry, warn };
}

/** The watermark statements the store was asked to run. */
function watermarkReads(store: FakeCatalogStore): string[] {
  return store.statements.filter((sql) => !sql.includes('catalog_snapshot'));
}

describe('a replica notices a write another replica made', () => {
  let store: FakeCatalogStore;

  beforeEach(() => {
    store = new FakeCatalogStore();
    store.publish('Mvr');
    // Past the second the fixture was written in, so a registry opening over it
    // starts from a watermark it is allowed to trust. Otherwise every case would
    // begin with the same-second rule firing, and would be testing that instead
    // of what it says it tests.
    store.advance(1_000);
  });

  it('serves a type published by its sibling, without being told', async () => {
    // THE case, and the one the incident is: `PUT publish/:type/schema` returns
    // 200 from the pod that handled it, and the connector run lands on the
    // other. Nothing here tells the second registry anything — the only thing
    // between the two of them is the store.
    const publisher = registryOver(store, { staleAfterMs: 5 }).registry;
    const { registry: sibling } = registryOver(store, { staleAfterMs: 5 });
    await publisher.reload();
    await sibling.reload();
    expect(sibling.getType('SchedMx')).toBeUndefined();

    store.publish('SchedMx');
    await publisher.reload();

    // A second of database time, so the write's own second closes, and enough
    // real time for the sibling's staleness window to elapse.
    store.advance(1_000);
    await elapse(10);

    sibling.getSnapshot();
    await vi.waitFor(() => expect(sibling.getType('SchedMx')).toBeDefined());
  });

  it('notices a rename that touched no type row at all', async () => {
    // `patchProperty` writes one row of `catalog_property` and nothing else, so
    // a watermark that watched only `catalog_object_type` would call this write
    // invisible — and the sibling would keep serving the old label for the life
    // of the process. Mutating the statement to drop its two `catalog_property`
    // aggregates fails here and nowhere else.
    const { registry: sibling } = registryOver(store, { staleAfterMs: 5 });
    await sibling.reload();
    expect(sibling.getType('Mvr')?.properties[0].displayName).toBe('id');

    store.advance(1_000);
    store.renameProperty('Mvr', 'id', 'Registration number');
    store.advance(1_000);
    await elapse(10);

    sibling.getSnapshot();
    await vi.waitFor(() =>
      expect(sibling.getType('Mvr')?.properties[0].displayName).toBe('Registration number'),
    );
  });

  it('trusts no watermark read inside the second of its own newest write', async () => {
    // `updated_at` is a `DATETIME`, so two writes in one second share a maximum.
    // A registry that recorded the first one's watermark as final would never
    // see the second — the key it compares against would already equal the key
    // the table reports.
    //
    // Which is exactly how this is arranged. The two writes land in one second,
    // and the second is a rename, so it moves no row count either: after it, the
    // watermark is byte-identical to the one read after the publish. The only
    // thing that can make the sibling look again is having declined to trust
    // that first reading. Making `settledAt` return a constant `true` fails
    // here.
    const { registry: sibling } = registryOver(store, { staleAfterMs: 5 });
    await sibling.reload();

    store.publish('SchedMx');
    await elapse(10);
    sibling.getSnapshot();
    await vi.waitFor(() => expect(sibling.getType('SchedMx')).toBeDefined());

    // Same second: no clock advance between the two writes.
    store.renameProperty('Mvr', 'id', 'Registration number');
    store.advance(1_000);
    await elapse(10);

    sibling.getSnapshot();
    await vi.waitFor(() =>
      expect(sibling.getType('Mvr')?.properties[0].displayName).toBe('Registration number'),
    );
  });
});

describe('what the check costs', () => {
  let store: FakeCatalogStore;

  beforeEach(() => {
    store = new FakeCatalogStore();
    store.publish('Mvr');
    // Past the second the fixture was written in, so a registry opening over it
    // starts from a watermark it is allowed to trust. Otherwise every case would
    // begin with the same-second rule firing, and would be testing that instead
    // of what it says it tests.
    store.advance(1_000);
  });

  it('asks the database once per window, not once per call', async () => {
    // The bound that makes this affordable on the hot path. A thousand reads
    // inside one window are one statement, so the rate is set by `staleAfterMs`
    // and not by traffic.
    const { registry } = registryOver(store, { staleAfterMs: 60_000 });
    await registry.reload();
    const before = watermarkReads(store).length;

    for (let i = 0; i < 1_000; i++) {
      registry.getSnapshot();
      registry.getType('Mvr');
    }
    await elapse(10);

    expect(watermarkReads(store).length - before).toBe(0);
  });

  it('rebuilds nothing when the watermark has not moved', async () => {
    // The other half of the bound: the window elapsing costs a watermark read,
    // and a watermark read that says nothing changed costs nothing else.
    // Removing the comparison — reloading whenever the window elapses — fails
    // here, because every check would drag the model rows over again.
    const { registry } = registryOver(store, { staleAfterMs: 5 });
    await registry.reload();
    const reads = watermarkReads(store).length;
    const version = registry.getSnapshot().version;

    await elapse(10);
    registry.getSnapshot();
    await vi.waitFor(() => expect(watermarkReads(store).length).toBeGreaterThan(reads));
    await elapse(10);

    expect(registry.getSnapshot().version).toBe(version);
  });

  it('opens one check at a time however many callers arrive', async () => {
    // A slow database must not accumulate a check per request behind it. The
    // window guard alone does not cover this — it has already elapsed for the
    // second caller — so the in-flight guard is what this case kills.
    const { registry } = registryOver(store, { staleAfterMs: 1 });
    await registry.reload();
    const before = watermarkReads(store).length;
    await elapse(10);

    const gate = deferred();
    store.gate = gate;
    registry.getSnapshot();
    await elapse(10);
    registry.getSnapshot();
    await elapse(10);

    expect(watermarkReads(store).length - before).toBe(1);
    store.gate = undefined;
    gate.release();
  });

  it('watches both model tables, and asks the engine for the aggregate', async () => {
    // The statement, because the fake above cannot test it: it answers from its
    // own contents whatever it is asked, so a version of `WATERMARK_SQL` that
    // had stopped watching `catalog_property` would pass every other case here.
    // The engine-side proof is `stored-registry.staleness.db.spec.ts`; what this
    // catches is the statement quietly losing half its subject.
    const { registry } = registryOver(store, { staleAfterMs: 5 });
    await registry.reload();
    const [statement] = watermarkReads(store);

    for (const table of ['catalog_object_type', 'catalog_property']) {
      expect(statement).toMatch(new RegExp(`COUNT\\(\\*\\)\\s+FROM ${table}`, 'i'));
      expect(statement).toMatch(new RegExp(`MAX\\(updated_at\\)\\s+FROM ${table}`, 'i'));
    }
    // And the database's own clock, not this process's — see `settledAt`. A pod
    // whose clock ran a second fast would otherwise trust a watermark it should
    // have treated as provisional.
    expect(statement).toMatch(/NOW\(\)/i);
  });

  it('does not retry once per request while the database is down', async () => {
    // The window is stamped when a check STARTS, not when it succeeds. Stamped
    // on success only, a database that is refusing connections would get an
    // attempt from every request that arrived — which is the shape of an
    // outage made worse by the thing meant to survive it.
    const { registry } = registryOver(store, { staleAfterMs: 200 });
    await registry.reload();
    store.failing = true;
    const before = watermarkReads(store).length;

    await elapse(250);
    registry.getSnapshot();
    await elapse(20);
    registry.getSnapshot();
    await elapse(20);
    registry.getSnapshot();
    await elapse(20);

    expect(watermarkReads(store).length - before).toBe(1);
  });

  it('issues no statement at all when the check is turned off', async () => {
    // `staleAfterMs: 0` is what a single-process deployment sets to get exactly
    // the behaviour and exactly the query count it had before this existed.
    const { registry } = registryOver(store, { staleAfterMs: 0 });
    await registry.reload();
    const before = store.statements.length;

    await elapse(10);
    registry.getSnapshot();
    registry.getType('Mvr');
    await elapse(10);

    expect(store.statements.length).toBe(before);
  });
});

describe('a check that fails', () => {
  it('keeps serving the model it already had', async () => {
    // The failure mode worth refusing is a registry that empties itself when the
    // database blinks: it would answer "no such type" for everything, which is a
    // far worse lie than a model that is a minute old. Nothing is cleared before
    // the replacement is in hand.
    const store = new FakeCatalogStore();
    store.publish('Mvr');
    store.advance(1_000);
    const { registry, warn } = registryOver(store, { staleAfterMs: 5 });
    await registry.reload();

    store.failing = true;
    await elapse(10);
    registry.getSnapshot();
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());

    expect(registry.getType('Mvr')).toBeDefined();
    expect(registry.getSnapshot().stats.types).toBe(1);
  });

  it('recovers on the next window rather than needing a restart', async () => {
    const store = new FakeCatalogStore();
    store.publish('Mvr');
    store.advance(1_000);
    const { registry } = registryOver(store, { staleAfterMs: 5 });
    await registry.reload();

    store.failing = true;
    await elapse(10);
    registry.getSnapshot();
    await elapse(10);

    store.publish('SchedMx');
    store.advance(1_000);
    store.failing = false;
    await elapse(10);

    registry.getSnapshot();
    await vi.waitFor(() => expect(registry.getType('SchedMx')).toBeDefined());
  });
});
