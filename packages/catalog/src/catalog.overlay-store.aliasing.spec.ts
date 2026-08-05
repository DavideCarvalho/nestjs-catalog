/**
 * That an overlay store keeps its own copy, whichever store it is.
 *
 * The one sentence a store is for is "nothing is stored until save". The
 * in-memory store used to hand back the very object it holds and to keep the
 * very object it was given, and the registry edits the overlay in place —
 * `this.overlay.types[name] = { ...current, ...patch }` — so the store's state
 * moved on a patch, before any `save`, in both directions.
 *
 * The net behaviour never differed, because every edit in the registry is
 * followed by a persist. Two things did:
 *
 * - A test asserting "nothing is written yet" passed here vacuously. It could
 *   not fail, because there was no "yet" — which is a claim with evidence
 *   attached to it, and the expensive kind of wrong.
 * - `FileCatalogOverlayStore` round-trips through JSON and so never aliased.
 *   Every spec in this repository runs on the in-memory one, so the suite was
 *   validating a property the deployed store does not have.
 *
 * So the assertions below run against BOTH bundled stores, from one list. Two
 * stores that disagree about this are the bug; a spec that could only be
 * written about one of them would be the same bug in the tests.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type CatalogOverlayStore,
  FileCatalogOverlayStore,
  InMemoryCatalogOverlayStore,
} from './catalog.overlay-store';

const stores: Array<[string, () => Promise<CatalogOverlayStore>]> = [
  ['InMemoryCatalogOverlayStore', async () => new InMemoryCatalogOverlayStore()],
  [
    'FileCatalogOverlayStore',
    async () =>
      new FileCatalogOverlayStore(
        join(await mkdtemp(join(tmpdir(), 'catalog-overlay-aliasing-')), 'overlay.json'),
      ),
  ],
];

describe.each(stores)('%s: what it hands out and what it keeps', (_name, make) => {
  it('reads back what it was told to save', async () => {
    // The point of the thing, pinned first: everything below is about what a
    // store must NOT do, and a store that does none of it by storing nothing
    // would pass all of them.
    const store = await make();
    await store.save({ types: { Mvr: { displayName: 'MVR' } } });

    expect(await store.load()).toEqual({ types: { Mvr: { displayName: 'MVR' } } });
  });

  // The test that used to pass vacuously. Editing what `load` returned is
  // exactly what `MikroOrmCatalogRegistry.patchType` does before it persists,
  // so this is the real sequence and not a hypothetical one.
  it('does not change when the overlay it handed out is edited', async () => {
    const store = await make();
    await store.save({ types: { Mvr: { displayName: 'MVR' } } });

    const handed = await store.load();
    handed.types.WorkOrder = { displayName: 'Work Order' };
    const mvr = handed.types.Mvr;
    if (mvr) mvr.displayName = 'Something Else';

    expect(await store.load()).toEqual({ types: { Mvr: { displayName: 'MVR' } } });
  });

  it('does not change when the overlay it was given is edited after the save', async () => {
    const store = await make();
    const given = { types: { Mvr: { displayName: 'MVR' } } };
    await store.save(given);

    given.types.Mvr.displayName = 'Edited After The Write';

    expect(await store.load()).toEqual({ types: { Mvr: { displayName: 'MVR' } } });
  });

  // Two registries over one store — a second replica, or a test building a
  // second registry to prove the edits survived a restart. Neither may see the
  // other's half-applied edit with no write between them.
  it('gives two holders overlays that are not each other', async () => {
    const store = await make();
    await store.save({ types: { Mvr: { displayName: 'MVR' } } });

    const first = await store.load();
    const second = await store.load();
    first.types.WorkOrder = { displayName: 'Work Order' };

    expect(second.types.WorkOrder).toBeUndefined();
  });
});

/**
 * The one place the two stores are allowed to differ, said out loud.
 *
 * A `undefined` value survives an in-memory copy and does not survive a file:
 * `JSON.stringify` drops the key. That is a property of writing JSON to disk
 * rather than a decision, which is why it is asserted only of the store that
 * can hold it — and why the in-memory copy is a `structuredClone` and not a
 * JSON round-trip, so that the store which CAN keep the distinction does.
 */
describe('InMemoryCatalogOverlayStore: a key whose value is undefined', () => {
  it('keeps the key rather than dropping it in the copy', async () => {
    const store = new InMemoryCatalogOverlayStore();
    await store.save({ types: { Mvr: { displayName: undefined, group: 'Fleet' } } });

    const loaded = await store.load();

    expect('displayName' in (loaded.types.Mvr ?? {})).toBe(true);
    expect(loaded.types.Mvr?.group).toBe('Fleet');
  });
});
