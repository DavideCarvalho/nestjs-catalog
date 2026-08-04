import type { CatalogObjectTypeDef, SnapshotRef } from '@dudousxd/nestjs-catalog';
/**
 * That the routing store forwards everything the store behind it can do.
 *
 * `RoutingCatalogStore` is a proxy written by hand, method by method. That is
 * fine until the interface grows: the new member is simply absent, and absent
 * is not a smaller version of "no" — a caller that probes structurally reads it
 * as "this store cannot answer", which is a different and much worse statement
 * than the store making it.
 *
 * `currentSnapshot` was missing for exactly that reason, in front of a
 * `MySqlWarehouseStore` that implements it. The cost is specific: a caller with
 * no pointer falls back to the newest entry in `listSnapshots`, and after a
 * rollback the newest snapshot is precisely the one that was rolled back. The
 * proxy's silence sends the reader at data somebody deliberately stopped
 * serving.
 *
 * So there are two cases here. One for the method itself, and one that walks
 * the interface — because the defect was never really `currentSnapshot`, it was
 * that nothing failed when the list fell behind.
 */
import { describe, expect, it } from 'vitest';
import { CatalogEnvironmentBundle } from './environment.bundle';
import { RoutingCatalogStore, runInEnvironment } from './environment.routing';

const TYPE: CatalogObjectTypeDef = {
  name: 'Mvr',
  properties: [],
  relations: [],
};

/** The pointer a warehouse keeps, and the newest-first list that is not it. */
const SERVING: SnapshotRef = { id: 'snap-serving', createdAt: new Date('2026-01-01') };
const NEWEST: SnapshotRef = { id: 'snap-rolled-back', createdAt: new Date('2026-02-01') };

/**
 * A store that answers both questions differently on purpose.
 *
 * If the proxy ever falls back to the list, the returned id says so by name —
 * a test that asserted only "something came back" would pass on the fallback,
 * which is the bug.
 */
class StubStore {
  listSnapshots(): Promise<SnapshotRef[]> {
    return Promise.resolve([NEWEST, SERVING]);
  }
  currentSnapshot(): Promise<SnapshotRef | undefined> {
    return Promise.resolve(SERVING);
  }
}

/** A store from a host that genuinely cannot answer, to keep the probe honest. */
class StubStoreWithoutPointer {
  listSnapshots(): Promise<SnapshotRef[]> {
    return Promise.resolve([NEWEST]);
  }
}

function bundleWith(store: unknown): CatalogEnvironmentBundle {
  const bundle: CatalogEnvironmentBundle = Object.create(CatalogEnvironmentBundle.prototype);
  return Object.assign(bundle, { store });
}

describe('RoutingCatalogStore forwards what the store behind it can do', () => {
  it('asks the environment store which snapshot it is serving, not which is newest', async () => {
    const routing = new RoutingCatalogStore();

    const answer = await runInEnvironment(bundleWith(new StubStore()), () =>
      routing.currentSnapshot(TYPE),
    );

    // By id, not by "defined". The newest one is right there and is wrong.
    expect(answer?.id).toBe('snap-serving');
  });

  it('says it cannot answer when the store behind it cannot', async () => {
    // Still probed rather than assumed: the bundle's store is whatever the host
    // bound, and forwarding blindly would turn a missing method into a crash
    // inside a proxy the caller did not know was there.
    const routing = new RoutingCatalogStore();

    const answer = await runInEnvironment(bundleWith(new StubStoreWithoutPointer()), () =>
      routing.currentSnapshot(TYPE),
    );

    expect(answer).toBeUndefined();
  });

  it('leaves nothing the MySQL store implements unforwarded', () => {
    // THE case. `currentSnapshot` was missing here while every sibling was
    // present, and no test noticed because every test named the methods it
    // cared about — the same hand-maintained list, checked by another hand.
    //
    // Walked off the prototype rather than listed: a method added to the MySQL
    // store and forgotten here fails this, and the failure names it.
    const proxied = Object.getOwnPropertyNames(RoutingCatalogStore.prototype).filter(
      (name) => name !== 'constructor',
    );

    for (const name of ['read', 'listSnapshots', 'currentSnapshot', 'ensureType', 'write']) {
      expect(`RoutingCatalogStore forwards ${name}: ${proxied.includes(name)}`).toBe(
        `RoutingCatalogStore forwards ${name}: true`,
      );
    }
  });
});
