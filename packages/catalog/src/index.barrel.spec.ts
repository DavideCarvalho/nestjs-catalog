import { describe, expect, it } from 'vitest';
import * as access from './catalog.access';
import * as barrel from './index';

/**
 * That the barrel re-exports what a host has to import to implement a seam.
 *
 * Written after 0.3.0 shipped `CATALOG_DIRECTORY` and `CatalogDirectory` but
 * NOT `CatalogDirectoryQuery` or `CatalogPeoplePage` — the argument and the
 * return type of the one method a host implements. The seam was importable and
 * unimplementable without restating both by hand.
 *
 * Nothing here could have caught it. Every spec in this package imports from a
 * source path, so a missing re-export is invisible; the only thing that noticed
 * was the first application to compile against the published package. This is
 * the cheap version of that consumer.
 *
 * Runtime exports only — types are erased by the time this runs. That is enough
 * to guard the failure mode, because the failure was a hand-maintained list
 * falling behind the file it listed, and a list that drops a type drops its
 * neighbours too. The barrel now uses `export *`, under which the two cannot
 * diverge at all.
 */

/** Every module whose exports a host is expected to reach through the barrel. */
const SEAMS: Array<[string, Record<string, unknown>]> = [['catalog.access', access]];

describe('the public barrel', () => {
  for (const [name, module_] of SEAMS) {
    it(`re-exports everything from ${name}`, () => {
      const missing = Object.keys(module_).filter((key) => !(key in barrel));

      expect(missing).toEqual([]);
    });
  }

  it('carries the directory seam by name', () => {
    // Spelled out as well as covered by the sweep above, because these three
    // are what a host writes down when wiring the Access screen, and a rename
    // should fail here rather than in somebody else's build.
    expect(barrel.CATALOG_DIRECTORY).toBe(access.CATALOG_DIRECTORY);
    expect(barrel.CATALOG_DIRECTORY_PAGE).toBe(access.CATALOG_DIRECTORY_PAGE);
    expect(barrel.CATALOG_DIRECTORY_MAX_PAGE).toBe(access.CATALOG_DIRECTORY_MAX_PAGE);
  });

  it('keeps the page ceiling above the default', () => {
    // Inverted, the cap would silently shrink every request rather than only
    // the greedy ones — and the endpoint would still look like it was paging.
    expect(barrel.CATALOG_DIRECTORY_MAX_PAGE).toBeGreaterThan(barrel.CATALOG_DIRECTORY_PAGE);
  });
});
