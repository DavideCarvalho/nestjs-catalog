// @vitest-environment jsdom
//
// The docblock below must stay attached to the FIRST import in source order, and that import must
// be the one Biome's `organizeImports` would sort first — otherwise the sorter moves another
// import above this line, Vitest stops finding the environment hint, and every test here fails in
// `node` with `window is not defined`.
/**
 * The console's own transport, as the thing that knows where the API is.
 *
 * `CatalogTransport.url` exists because the React package used to build the CSV export link from a
 * hardcoded `/api`. Moving that decision here is only a fix if this transport actually answers —
 * the method is optional on the interface, so a transport that quietly does not implement it
 * compiles perfectly and produces a root-relative link that 404s in this app.
 *
 * The second case is the one that would have caught the original bug: `__CATALOG_API__` is how a
 * host says the API is somewhere other than `/api`, and it is exactly the configuration the
 * hardcoded prefix ignored.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { transport } from './transport';

const configurable = window as { __CATALOG_API__?: string };

afterEach(() => {
  configurable.__CATALOG_API__ = undefined;
});

describe('transport.url', () => {
  it('is implemented at all — the export link has nowhere else to come from', () => {
    expect(typeof transport.url).toBe('function');
  });

  it('prepends the same default base as every fetch this console makes', () => {
    expect(transport.url?.('/catalog/saved-queries/q-1/export.csv')).toBe(
      `${window.location.origin}/api/catalog/saved-queries/q-1/export.csv`,
    );
  });

  it('follows the host to wherever it mounted the API', () => {
    // The whole reason the hardcoded `/api` was wrong: this is a supported
    // configuration, and it moved every fetch except the export link.
    configurable.__CATALOG_API__ = '/gateway/catalog-service';

    expect(transport.url?.('/catalog/saved-queries/q-1/export.csv')).toBe(
      `${window.location.origin}/gateway/catalog-service/catalog/saved-queries/q-1/export.csv`,
    );
  });
});
