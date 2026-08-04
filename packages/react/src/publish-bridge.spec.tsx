// @vitest-environment jsdom
//
// The docblock below must stay attached to the FIRST import in source order, and that import must
// be the one Biome's `organizeImports` would sort first — otherwise the sorter moves another
// import above this line, Vitest stops finding the environment hint, and every test here fails in
// `node` with `document is not defined`.
/**
 * The two calls that let the console create a type from a source.
 *
 * Schema discovery reports what a source's columns are; publishing is what
 * turns that report into an object type. Until both existed on the client the
 * panel was built and unreachable — it took a bridge as a prop and nothing
 * supplied one, and its "Create type" button had nowhere to go.
 *
 * Publishing is the only write here that does not go through the catalog's own
 * routes, and it is a `PUT` because it is an idempotent upsert of a whole
 * shape. The transport predates that, so `put` is optional — which makes the
 * refusal path the one worth pinning: a button that resolves without creating
 * anything is exactly the failure the panel exists to prevent.
 */
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { CatalogProvider, type CatalogTransport, useCatalogClient } from './context';

function clientOver(transport: Partial<CatalogTransport>) {
  const full: CatalogTransport = {
    get: vi.fn(),
    post: vi.fn().mockResolvedValue({}),
    patch: vi.fn(),
    delete: vi.fn(),
    ...transport,
  };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <CatalogProvider transport={full}>{children}</CatalogProvider>
  );
  const { result } = renderHook(() => useCatalogClient(), { wrapper });
  return { client: result.current, transport: full };
}

describe('discovering a source schema', () => {
  it('asks about the connector, on the route the server actually serves', async () => {
    // The path is the contract with `POST connectors/:id/discover`. Asserting it
    // by shape rather than by "post was called" is deliberate: the two ends are
    // in different packages and nothing else would notice them drifting apart.
    const { client, transport } = clientOver({});

    await client.discoverConnectorSchema('mvr nightly');

    expect(transport.post).toHaveBeenCalledWith('/pipeline/connectors/mvr%20nightly/discover', {});
  });
});

describe('publishing a type', () => {
  it('PUTs the schema to the publish route, under the type name', async () => {
    const put = vi.fn().mockResolvedValue({});
    const { client } = clientOver({ put });

    await client.publishType('Mvr', { displayName: 'MVR', properties: [] });

    expect(put).toHaveBeenCalledWith('/publish/Mvr/schema', {
      displayName: 'MVR',
      properties: [],
    });
  });

  it('escapes a name that would otherwise change the path', () => {
    const put = vi.fn().mockResolvedValue({});
    const { client } = clientOver({ put });

    client.publishType('a/b', {});

    expect(put).toHaveBeenCalledWith('/publish/a%2Fb/schema', {});
  });

  it('refuses by name when the transport cannot PUT', () => {
    // THE case. `put` is optional so transports written before this keep
    // compiling — which means the console can be handed one that cannot
    // publish. Resolving quietly there would leave somebody pressing "Create
    // type" and reading an empty catalog, with nothing anywhere saying why.
    const { client } = clientOver({});

    expect(() => client.publishType('Mvr', {})).toThrow(/cannot PUT/);
  });

  it('does not reach for any other verb when PUT is missing', () => {
    // Falling back to `post` would hit a route that does not exist and turn a
    // legible refusal into a 404 from somebody else's server.
    const { client, transport } = clientOver({});

    expect(() => client.publishType('Mvr', {})).toThrow();
    expect(transport.post).not.toHaveBeenCalled();
    expect(transport.patch).not.toHaveBeenCalled();
  });
});
