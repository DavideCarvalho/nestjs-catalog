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
  displayName: 'MVR',
  pluralDisplayName: 'MVRs',
  tableName: 'mvr',
  group: 'fleet',
  primaryKey: ['id'],
  enriched: false,
  properties: [],
  relations: [],
};

/** The pointer a warehouse keeps, and the newest-first list that is not it. */
const SERVING: SnapshotRef = {
  id: 'snap-serving',
  createdAt: '2026-01-01T00:00:00.000Z',
  rowCount: 4200,
  principalId: 'flip-nestjs',
};
const NEWEST: SnapshotRef = {
  id: 'snap-rolled-back',
  createdAt: '2026-02-01T00:00:00.000Z',
  rowCount: 4300,
  principalId: 'flip-nestjs',
};

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
    // This test used to BE the mechanism, and it was a bad one. It listed the
    // methods it cared about — the same hand-maintained list it was written to
    // criticise, checked by another hand — so when `listTransformRevisions`,
    // `listSavedQueryRevisions`, `publishWorkflow` and `unpublishWorkflow` were
    // added to the interfaces and not to the proxies, it went on passing.
    //
    // The mechanism is now a type-level assertion at the bottom of
    // `environment.routing.ts`: every OPTIONAL member of the interfaces (the
    // required ones `implements` already enforces) must appear on the proxy, and
    // omitting one fails the BUILD with an error naming it. Deleting a
    // forwarding method to check this is a two-second experiment worth doing.
    //
    // What is left here is what a type cannot say: that a declared method
    // actually delegates rather than returning something of its own. So this
    // walks the prototype and the cases above exercise the delegation.
    const proxied = Object.getOwnPropertyNames(RoutingCatalogStore.prototype).filter(
      (name) => name !== 'constructor',
    );

    expect(proxied).toContain('currentSnapshot');
    expect(proxied.length).toBeGreaterThan(4);
  });
});
