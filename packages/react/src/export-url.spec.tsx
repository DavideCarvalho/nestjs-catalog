// @vitest-environment jsdom
//
// The docblock below must stay attached to the FIRST import in source order, and that import must
// be the one Biome's `organizeImports` would sort first — otherwise the sorter moves another
// import above this line, Vitest stops finding the environment hint, and every test here fails in
// `node` with `document is not defined`.
/**
 * Where the CSV export actually points.
 *
 * `exportUrl` was the one method on `CatalogClient` that bypassed the injected transport: it
 * answered `` `/api${path}` ``, a hardcoded mount point, in a package whose `routes.ts` argues at
 * length that only the transport knows where the API lives. It was wrong for every host that did
 * not happen to mount the catalog under `/api` — and the component it broke first is
 * `<EmbeddedChart>`, which by definition renders inside somebody else's application.
 *
 * Asserted through the rendered `href` rather than by calling the client directly, because the
 * href is the thing a person clicks; a client method that returns the right string into a link
 * nobody builds is not a fix.
 */
import type { SavedQuery } from '@dudousxd/nestjs-catalog/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { SavedQueryPanel } from './SavedQueryPanel';
import { CatalogProvider, type CatalogTransport } from './context';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(cleanup);

const QUERY: SavedQuery = {
  id: 'q-1',
  name: 'Vehicles by base',
  sql: 'select 1',
  createdBy: 'ana',
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
  cacheTtlSeconds: 0,
  visualization: { kind: 'table' },
  shared: false,
};

/** Only the reads the panel makes; the export is a link, so nothing is fetched for it. */
function listing(url?: (path: string) => string): CatalogTransport {
  const base: CatalogTransport = {
    // biome-ignore lint/suspicious/noExplicitAny: the seam under test is generic on the response.
    get: (): Promise<any> => Promise.resolve([QUERY]),
    post: () => Promise.reject(new Error('not used')),
    patch: () => Promise.reject(new Error('not used')),
    delete: () => Promise.reject(new Error('not used')),
  };
  return url ? { ...base, url } : base;
}

function mount(transport: CatalogTransport, children: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <CatalogProvider transport={transport}>{children}</CatalogProvider>
    </QueryClientProvider>,
  );
}

async function exportHref(transport: CatalogTransport): Promise<string> {
  mount(transport, <SavedQueryPanel currentSql="" onLoad={() => {}} />);
  const link = await screen.findByLabelText('Export Vehicles by base');
  return link.getAttribute('href') ?? '';
}

describe('the CSV export link', () => {
  it('is built by the transport, wherever the host mounted the catalog', async () => {
    // The host's transport prepends `/gateway/v2`; so must the export, or the
    // one control that leaves this library's control gets a 404.
    const href = await exportHref(listing((path) => `/gateway/v2${path}`));

    expect(href).toBe('/gateway/v2/catalog/saved-queries/q-1/export.csv');
  });

  it('never invents `/api` for a transport that did not ask for one', async () => {
    // The defect, stated as an assertion: a transport with no base has no `/api`
    // in it, and neither should the link it produces.
    const href = await exportHref(listing());

    expect(href).toBe('/catalog/saved-queries/q-1/export.csv');
    expect(href.startsWith('/api')).toBe(false);
  });
});
