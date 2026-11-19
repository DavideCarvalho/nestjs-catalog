// @vitest-environment jsdom
//
// The docblock below must stay attached to the FIRST import in source order, and that import must
// be the one Biome's `organizeImports` would sort first — otherwise the sorter moves another
// import above this line, Vitest stops finding the environment hint, and every test here fails in
// `node` with `document is not defined`.
/**
 * The console as a host that shows only part of it serves it.
 *
 * A host that mounts the console inside its own application, with its own sign-in, and serves
 * only the model and its objects, used to get every tab anyway, each landing on an error state, a
 * `/auth/me` it does not serve, the Model screen asking for pipeline endpoints it does not mount,
 * and an environment picker that failed on `/environments`. `config.js` now says which screens
 * exist, whether the pipeline is there and who owns identity; this file renders the console under
 * exactly that config and checks what is on screen and, above all, what reached the network.
 *
 * `toBeChecked` / `toBeDisabled` are NOT available (no jest-dom setup here) and throw rather than
 * fail. jsdom has no layout, so the tab strip's observers are stubbed as in the other App specs.
 */
import type { CatalogObjectTypeDef } from '@dudousxd/nestjs-catalog/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

class NoopResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = NoopResizeObserver;
Element.prototype.scrollIntoView = () => {};

/**
 * What `config.js` writes for this host, set before `App` is imported because the console reads it
 * once at module scope, the same way it always read `__CATALOG_HOST_AUTH__`.
 */
Object.assign(window, {
  __CATALOG_HOST_AUTH__: true,
  __CATALOG_CONSOLE__: { screens: ['model', 'objects'], pipeline: false, identity: false },
});
const { App } = await import('./App');

const TYPE: CatalogObjectTypeDef = {
  name: 'Mvr',
  displayName: 'Vehicle',
  pluralDisplayName: 'Vehicles',
  tableName: 'mvr',
  group: 'Fleet',
  primaryKey: ['id'],
  enriched: true,
  properties: [],
  relations: [],
};

/** Every request the console made, by path. */
let requested: string[] = [];

/**
 * This host's API: the catalog and its objects, and nothing else. Every other path is a 404, as it
 * is on a host that does not mount it, so a screen that asks for one anyway shows up here.
 */
function hostFetch() {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(String(input), window.location.origin);
    requested.push(url.pathname);
    if (url.pathname === '/api/catalog') {
      return Response.json({
        version: 1,
        generatedAt: '2026-01-01T00:00:00.000Z',
        stats: { types: 1, properties: 0, relations: 0, enrichedTypes: 1 },
        types: [TYPE],
      });
    }
    if (url.pathname === '/api/catalog/objects/Mvr') {
      return Response.json({
        type: 'Mvr',
        data: [],
        meta: { total: 0, perPage: 25, currentPage: 1, lastPage: 1, firstPage: 1 },
        columns: [],
      });
    }
    return Response.json({ message: `Cannot GET ${url.pathname}` }, { status: 404 });
  };
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  requested = [];
  globalThis.fetch = hostFetch();
  window.location.hash = '';
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  window.location.hash = '';
});

function mount() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
}

/** The Model screen, with its one type's detail pane open. */
async function loaded() {
  await screen.findByRole('heading', { name: 'Properties' });
}

/** Let every request a render started reach `fetch`, so "never asked" means never asked. */
async function settle() {
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
}

describe('a console that shows only Model and Objects', () => {
  it('has a tab for each of those, and no other', async () => {
    mount();
    await loaded();

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent?.trim())).toEqual([
      'Model',
      'Objects',
    ]);
    // Search is a screen too, and it is hidden with the rest: no button, and no shortcut.
    expect(screen.queryByRole('button', { name: 'Search' })).toBeNull();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(window.location.hash).toBe('');
  });

  it('lands an address naming a hidden screen on the first one shown', async () => {
    window.location.hash = '#query';
    mount();

    await loaded();
    expect(screen.queryByText(/saved quer/i)).toBeNull();
  });

  it('asks only for what it shows: no identity, no pipeline, no hidden screen', async () => {
    mount();
    await loaded();
    // The type's detail pane is open, which is when Loaded by and Load expectation would mount.
    await settle();

    expect(screen.queryByText('Loaded by')).toBeNull();
    expect(screen.queryByText('Load expectation')).toBeNull();
    expect(requested.filter((path) => path === '/api/auth/me')).toEqual([]);
    expect(requested.filter((path) => path.startsWith('/api/pipeline/'))).toEqual([]);
    expect(requested.filter((path) => path.startsWith('/api/query-ai'))).toEqual([]);
  });

  it('reads a 404 on /environments as one environment, and shows no picker for it', async () => {
    mount();
    await loaded();
    await waitFor(() => expect(requested).toContain('/api/environments'));
    await settle();

    expect(screen.queryByLabelText('Environment')).toBeNull();
  });

  it('shows no sign-in, because the host already knows who this is', async () => {
    mount();
    await loaded();
    expect(screen.queryByLabelText(/password/i)).toBeNull();
  });
});
