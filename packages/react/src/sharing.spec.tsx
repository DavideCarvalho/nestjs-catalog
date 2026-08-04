// @vitest-environment jsdom
//
// The docblock below must stay attached to the FIRST import in source order, and that import must
// be the one Biome's `organizeImports` would sort first — otherwise the sorter moves another
// import above this line, Vitest stops finding the environment hint, and every test here fails in
// `node` with `document is not defined`.
/**
 * Sharing, from the two screens that perform it.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `shared` is the entire access boundary of the embed API, and the console could not move it. The
 * client's `updateDashboard` type simply did not name the field, so `updateDashboard(id, { shared:
 * true })` was a compile error and no dashboard a shipped console produced was ever embeddable —
 * `<EmbeddedDashboard>` answered "Nothing on this dashboard has been shared" for every board in
 * existence, which reads as an empty board rather than as a feature that cannot be switched on.
 * Saved queries had the weaker version: `shared` was settable when the query was first saved and
 * from nowhere afterwards, so a mistaken grant could only be revoked by deleting the query.
 *
 * Neither failure is visible to `tsc` once the types are fixed — a type that permits a field says
 * nothing about a screen that never sends it. So every assertion below is a click, and what is
 * asserted is the REQUEST: which path, which body. The wording of the control is asserted through
 * its accessible name, so a share button that arrives as an icon with no label fails too.
 */
import type { Dashboard, SavedQuery } from '@dudousxd/nestjs-catalog/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { DashboardBoard } from './DashboardBoard';
import { SavedQueryPanel } from './SavedQueryPanel';
import { CatalogProvider, type CatalogTransport } from './context';
import { shareActionLabel, shareStatement } from './sharing';

declare global {
  // React refuses to believe a test is a test without this, and warns on every state update.
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(cleanup);

interface Call {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
}

/** Answers from a path→value map and records every call, like the other screen specs. */
function fakeTransport(answers: Record<string, unknown>) {
  const calls: Call[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: `CatalogTransport` is generic on the response and a fixture map cannot be.
  const answer = (path: string): Promise<any> => {
    if (!(path in answers)) return Promise.reject(new Error(`No fake answer for ${path}`));
    const value = answers[path];
    const resolved = typeof value === 'function' ? value() : value;
    return resolved instanceof Error ? Promise.reject(resolved) : Promise.resolve(resolved);
  };

  const transport: CatalogTransport = {
    get: (path) => {
      calls.push({ method: 'GET', path });
      return answer(path);
    },
    post: (path, body) => {
      calls.push({ method: 'POST', path, body });
      return answer(path);
    },
    patch: (path, body) => {
      calls.push({ method: 'PATCH', path, body });
      return answer(path);
    },
    delete: (path) => {
      calls.push({ method: 'DELETE', path });
      return answer(path);
    },
  };

  const lastCallTo = (path: string) => calls.filter((call) => call.path === path).at(-1);
  return { transport, calls, lastCallTo };
}

function mount(transport: CatalogTransport, children: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <CatalogProvider transport={transport}>{children}</CatalogProvider>
    </QueryClientProvider>,
  );
}

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

const BOARD: Dashboard = {
  id: 'd-1',
  name: 'Fleet',
  createdBy: 'ana',
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
  cards: [],
  shared: false,
};

describe('sharing a dashboard', () => {
  it('sends `shared: true` when the board is shared from the console', async () => {
    // THE case, and the one the whole embed surface waited on. `updateDashboard`'s
    // input type did not name `shared`, so this call site could not be written at all.
    const fake = fakeTransport({
      '/catalog/dashboards': [BOARD],
      '/catalog/saved-queries': [],
      '/catalog/dashboards/d-1': { ...BOARD, shared: true },
    });
    mount(fake.transport, <DashboardBoard />);

    const button = await screen.findByRole('button', {
      name: `${shareActionLabel('dashboard', false)}: Fleet`,
    });
    fireEvent.click(button);

    await waitFor(() => {
      expect(fake.lastCallTo('/catalog/dashboards/d-1')).toEqual({
        method: 'PATCH',
        path: '/catalog/dashboards/d-1',
        body: { shared: true },
      });
    });
  });

  it('offers the way back out, and sends `shared: false`', async () => {
    // The server audits the transition in BOTH directions, so a console that can
    // only grant is a console that cannot answer for a grant made by mistake.
    const fake = fakeTransport({
      '/catalog/dashboards': [{ ...BOARD, shared: true }],
      '/catalog/saved-queries': [],
      '/catalog/dashboards/d-1': BOARD,
    });
    mount(fake.transport, <DashboardBoard />);

    const button = await screen.findByRole('button', {
      name: `${shareActionLabel('dashboard', true)}: Fleet`,
    });
    fireEvent.click(button);

    await waitFor(() => {
      expect(fake.lastCallTo('/catalog/dashboards/d-1')?.body).toEqual({ shared: false });
    });
  });

  it('states what the current state means before offering to change it', async () => {
    // The reason this is a row of prose and a verb button rather than a switch:
    // `catalog:embed` is the actual boundary, and somebody deciding whether to
    // cross it should be able to read who ends up on the other side.
    const fake = fakeTransport({
      '/catalog/dashboards': [{ ...BOARD, shared: true }],
      '/catalog/saved-queries': [],
    });
    mount(fake.transport, <DashboardBoard />);

    expect(await screen.findByText(shareStatement('dashboard', true))).toBeTruthy();
  });

  it('says so when the server refuses the change', async () => {
    // Sharing is the one act whose failure is invisible in its own result: the
    // board looks identical, and the person walks away believing the grant landed.
    const fake = fakeTransport({
      '/catalog/dashboards': [BOARD],
      '/catalog/saved-queries': [],
      '/catalog/dashboards/d-1': new Error('catalog:curate is required'),
    });
    mount(fake.transport, <DashboardBoard />);

    fireEvent.click(
      await screen.findByRole('button', {
        name: `${shareActionLabel('dashboard', false)}: Fleet`,
      }),
    );

    expect(await screen.findByText('catalog:curate is required')).toBeTruthy();
  });
});

describe('sharing a saved query', () => {
  it('un-shares through `updateSavedQuery`, which had no call site at all', async () => {
    const fake = fakeTransport({
      '/catalog/saved-queries': [{ ...QUERY, shared: true }],
      '/catalog/saved-queries/q-1': QUERY,
    });
    mount(fake.transport, <SavedQueryPanel currentSql="" onLoad={() => {}} />);

    const button = await screen.findByRole('button', {
      name: `${shareActionLabel('query', true)}: Vehicles by base`,
    });
    fireEvent.click(button);

    await waitFor(() => {
      expect(fake.lastCallTo('/catalog/saved-queries/q-1')).toEqual({
        method: 'PATCH',
        path: '/catalog/saved-queries/q-1',
        body: { shared: false },
      });
    });
  });

  it('marks a shared query in the list without waiting to be hovered', async () => {
    // Every other control in the row appears on hover because it is an action.
    // The badge is not an action, it is the answer to "which of these can an
    // outside application already read" — and an answer you have to hunt for
    // one row at a time is not one.
    const fake = fakeTransport({ '/catalog/saved-queries': [{ ...QUERY, shared: true }] });
    mount(fake.transport, <SavedQueryPanel currentSql="" onLoad={() => {}} />);

    expect(await screen.findByText('Shared')).toBeTruthy();
  });

  it('leaves an unshared query unmarked, and offers to share it', async () => {
    const fake = fakeTransport({
      '/catalog/saved-queries': [QUERY],
      '/catalog/saved-queries/q-1': { ...QUERY, shared: true },
    });
    mount(fake.transport, <SavedQueryPanel currentSql="" onLoad={() => {}} />);

    const button = await screen.findByRole('button', {
      name: `${shareActionLabel('query', false)}: Vehicles by base`,
    });
    expect(screen.queryByText('Shared')).toBeNull();

    fireEvent.click(button);

    await waitFor(() => {
      expect(fake.lastCallTo('/catalog/saved-queries/q-1')?.body).toEqual({ shared: true });
    });
  });
});

describe('the copy', () => {
  it('names the scope that actually decides, in both statements', () => {
    // "Other apps" reads as "the apps you have integrated". The truth is
    // anything holding `catalog:embed`, which may be more than the person
    // clicking has in mind — so the scope is in the sentence, not a footnote.
    expect(shareStatement('dashboard', true)).toContain('catalog:embed');
    expect(shareStatement('query', true)).toContain('catalog:embed');
  });

  it('names the transition rather than the state, in the button', () => {
    expect(shareActionLabel('query', false)).toBe('Share this query');
    expect(shareActionLabel('query', true)).toBe('Stop sharing this query');
  });
});
