/**
 * What the file-backed overlay does with a file somebody edited by hand.
 *
 * Editing it by hand is the point — it is a JSON file precisely so a deployment
 * without a control plane can curate the catalog with an editor. Which means
 * its contents are exactly as trustworthy as whoever last saved it, and the
 * shapes worth pinning are the ones that come back from `JSON.parse` looking
 * close enough to pass a careless check.
 *
 * The failure this guards is quiet rather than loud: a `types` that is `null`
 * or an array satisfies `typeof x === 'object'`, so an assertion would hand the
 * registry something the whole catalog then reads as "nobody has curated
 * anything" — every label, unit and classification somebody wrote silently
 * stops applying, and nothing reports an error.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { FileCatalogOverlayStore } from './catalog.overlay-store';

let path: string;

beforeEach(async () => {
  path = join(await mkdtemp(join(tmpdir(), 'catalog-overlay-')), 'overlay.json');
});

async function loadAfterWriting(contents: string) {
  await writeFile(path, contents, 'utf8');
  return new FileCatalogOverlayStore(path).load();
}

describe('reading an overlay off disk', () => {
  it('reads back what it wrote', async () => {
    const store = new FileCatalogOverlayStore(path);
    await store.save({ types: { Mvr: { displayName: 'MVR' } } });

    expect(await store.load()).toEqual({ types: { Mvr: { displayName: 'MVR' } } });
  });

  it('treats a missing file as no curation rather than an error', async () => {
    // The ordinary state of a fresh deployment, and it must not stop a boot.
    expect(await new FileCatalogOverlayStore(join(tmpdir(), 'nope', 'x.json')).load()).toEqual({
      types: {},
    });
  });

  it('refuses a file whose `types` is null', async () => {
    // `typeof null === 'object'`, so this is the shape that walks past a
    // careless check. Downstream it reads as an empty overlay — which is the
    // same thing this returns, but by decision rather than by accident, and
    // without handing the registry a `null` to index into.
    expect(await loadAfterWriting('{"types": null}')).toEqual({ types: {} });
  });

  it('refuses a file whose `types` is an array', async () => {
    // Also `typeof === 'object'`. An array has no string keys, so every lookup
    // misses and the catalog quietly loses every curated name.
    expect(await loadAfterWriting('{"types": []}')).toEqual({ types: {} });
  });

  it('refuses a file that is not an object at all', async () => {
    expect(await loadAfterWriting('"just a string"')).toEqual({ types: {} });
    expect(await loadAfterWriting('null')).toEqual({ types: {} });
  });

  it('refuses a file that is not JSON', async () => {
    expect(await loadAfterWriting('{ this is not json')).toEqual({ types: {} });
  });

  it('keeps entries it cannot vouch for, rather than discarding the file', async () => {
    // The nesting below `types` is deliberately not validated: every consumer
    // reads it defensively, because "this type has no curation" is the ordinary
    // case. Refusing the whole file over one malformed entry would throw away
    // every good entry beside it — which is the expensive direction, since what
    // is lost is somebody's work and there is no other copy.
    const overlay = await loadAfterWriting('{"types": {"Mvr": {"displayName": "MVR"}, "Bad": 7}}');

    expect(overlay.types.Mvr).toEqual({ displayName: 'MVR' });
    expect('Bad' in overlay.types).toBe(true);
  });
});
