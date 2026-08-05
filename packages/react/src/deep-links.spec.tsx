// @vitest-environment jsdom
//
// The docblock below must stay attached to the FIRST import in source order, and that import must
// be the one Biome's `organizeImports` would sort first — otherwise the sorter moves another
// import above this line, Vitest stops finding the environment hint, and every test here fails in
// `node` with `document is not defined`.
/**
 * That the query and dashboard screens open what the URL names.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The search box shipped with links that were half-honest. `#objects?type=Mvr` worked end to end,
 * because `ObjectExplorer` has taken a `type` prop and read `?type=` for itself since before the
 * box existed. `#query?savedQuery=…` and `#dashboards?dashboard=…` did not: `QueryConsole` took
 * only `onGenerate` and `maxRows`, `DashboardBoard` took no props at all and held its selection in
 * internal state, and a grep for `URLSearchParams` across this package hit exactly two files. So
 * both links landed on the right SCREEN and stopped. The id rode in the address bar unread, and
 * somebody who clicked a result for a specific dashboard got whichever board the component had
 * picked for itself — which is worse than not navigating, because nothing on screen says so.
 *
 * Three behaviours are asserted here, and the third is the one that is easy to get wrong.
 *
 * - **The id is read**, from the prop the host passes and, failing that, from the URL. Both,
 *   because that is `ObjectExplorer`'s argued precedent: the host is the one that knows where its
 *   router keeps parameters, and the self-read is the convenience for a host that does not route.
 * - **The selection is reported**, so a host can put it back in the address and a link can be
 *   copied out of it. A screen that reads a URL and never writes one can be followed and never
 *   produced.
 * - **An id naming something GONE is refused out loud.** A deleted board, a saved query somebody
 *   else removed. Falling back to the first row is what makes a stale link look like a working
 *   link showing the wrong thing, and the fallback has to survive for the case it is right for —
 *   nobody named anything — which is why "still opens the first board when nothing was named" is
 *   in here beside its opposite.
 *
 * `toBeChecked` / `toBeDisabled` are NOT available — this repo registers no jest-dom setup, and
 * they throw rather than fail. `toHaveProperty` is the equivalent that works.
 *
 * The SQL box is read through {@link editorText} rather than by finding a form control and asking
 * for its `value`. It has not been a `<textarea>` since it became `@pierre/diffs`: it is a
 * contenteditable inside a shadow root, which Testing Library's queries stop at, so
 * `getByLabelText('SQL query')` finds nothing at all. That also means the editor needs a DOM jsdom
 * does not have — see `installCodeSurfaceDom`, without which it renders an EMPTY shadow root and
 * every assertion here fails for a reason unrelated to what it is asserting.
 */
import type { Dashboard, SavedQuery } from '@dudousxd/nestjs-catalog/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installCodeSurfaceDom } from '../../../test/jsdom-code-surface';
import { DashboardBoard } from './DashboardBoard';
import { QueryConsole } from './QueryConsole';
import { CatalogProvider, type CatalogTransport } from './context';
import { codeEditorText } from './ui/code-editor';

declare global {
  // React refuses to believe a test is a test without this, and warns on every state update.
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

installCodeSurfaceDom();

/**
 * The two things these screens use that jsdom does not implement, because it does no layout.
 *
 * Base UI's tooltips and selects observe their anchor's size, and `@dnd-kit` scrolls a dragged
 * card into view. Neither has an observable effect without layout and both throw, so they are
 * stubbed rather than asserted on — nothing here depends on what they compute.
 */
class NoopResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = NoopResizeObserver;
Element.prototype.scrollIntoView = () => {};

afterEach(() => {
  cleanup();
  window.location.hash = '';
});

/** A transport that answers from a path→value map and records every call. */
function fakeTransport(answers: Record<string, unknown>) {
  const calls: Array<{ method: string; path: string }> = [];
  // The suppression has to be the line immediately above, so the reason goes here: `CatalogTransport`
  // is generic on its response and a fixture map cannot be, and this is what lets the fake satisfy
  // it without an assertion. Same seam, same reason, as `screens.spec.tsx`.
  // biome-ignore lint/suspicious/noExplicitAny: see above.
  const answer = (path: string): Promise<any> => {
    if (!(path in answers)) return Promise.reject(new Error(`No fake answer for ${path}`));
    // A function is CALLED, so a path can answer later than the render that asked — which is the
    // only way to test what a screen says while a list is still in flight.
    const value = answers[path];
    return Promise.resolve(typeof value === 'function' ? value() : value);
  };

  const transport: CatalogTransport = {
    get: (path) => {
      calls.push({ method: 'GET', path });
      return answer(path);
    },
    post: (path) => {
      calls.push({ method: 'POST', path });
      return answer(path);
    },
    patch: (path) => {
      calls.push({ method: 'PATCH', path });
      return answer(path);
    },
    delete: (path) => {
      calls.push({ method: 'DELETE', path });
      return answer(path);
    },
  };
  return { transport, calls };
}

function withCatalog(
  transport: CatalogTransport,
  children: ReactNode,
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  return (
    <QueryClientProvider client={queryClient}>
      <CatalogProvider transport={transport}>{children}</CatalogProvider>
    </QueryClientProvider>
  );
}

function savedQuery(id: string, name: string, sql: string): SavedQuery {
  return {
    id,
    name,
    sql,
    createdBy: 'someone',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cacheTtlSeconds: 0,
    visualization: { kind: 'table' },
    shared: false,
  };
}

function board(id: string, name: string): Dashboard {
  return {
    id,
    name,
    createdBy: 'someone',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    // No cards, on purpose: a card runs its own saved query and draws a chart, and none of that is
    // what these tests are about. An empty board still has a title, which is the whole assertion.
    cards: [],
    shared: false,
  };
}

const QUERIES = [
  savedQuery('q-1', 'Risk by base', 'SELECT * FROM mvr'),
  savedQuery('q-7', 'Work orders per vehicle', 'SELECT assetId FROM subwo'),
];

const BOARDS = [board('d-1', 'Fleet overview'), board('d-3', 'Risk overview')];

/**
 * One relation, so there is a way to EDIT the SQL box from a test.
 *
 * Clicking a relation name inserts it at the caret, and that is now the only user action in reach
 * that changes the editor's text: it is a contenteditable in a shadow root, so `fireEvent.change`
 * has nothing to change and jsdom types nothing into it. The insert path is real — the same one a
 * person uses — and it goes through `onChange` exactly as typing does.
 */
const RELATIONS = [
  {
    name: 'mvr',
    objectType: 'Mvr',
    kind: 'current' as const,
    description: 'The committed snapshot.',
    columns: [],
  },
];

/** Everything either screen asks for on mount. */
const ANSWERS = {
  '/catalog/query/relations': RELATIONS,
  '/catalog/saved-queries': QUERIES,
  '/catalog/dashboards': BOARDS,
};

/** The SQL box, which is where "which saved query is open" is actually visible. */
const editorText = () => codeEditorText(document.body);

describe('the query console opens the saved query the URL names', () => {
  it('opens what the host named, rather than the starter SQL', async () => {
    const { transport } = fakeTransport(ANSWERS);
    render(withCatalog(transport, <QueryConsole savedQueryId="q-7" />));

    await waitFor(() => expect(editorText()).toContain('SELECT assetId FROM subwo'));
  });

  it('reads ?savedQuery= out of the hash when the host passes nothing', async () => {
    // The precedent `ObjectExplorer` sets and this follows rather than reinvents: the prop is what
    // a routing host passes, and this is the convenience for a host that has not wired one up. The
    // hash rather than `location.search`, because a console like this is very often hash-routed
    // and `#query?savedQuery=q-7` leaves the real query string empty.
    window.location.hash = '#query?savedQuery=q-7';
    const { transport } = fakeTransport(ANSWERS);
    render(withCatalog(transport, <QueryConsole />));

    await waitFor(() => expect(editorText()).toContain('SELECT assetId FROM subwo'));
  });

  it('switches when the host names a different query, not only on the first render', async () => {
    // Navigating from one saved query to another is the ordinary way to arrive here a second time.
    // A screen that reads the prop once shows the previous query under an address naming the new
    // one — the same bug `ObjectExplorer`'s "the prop wins whenever it changes" comment records.
    const { transport } = fakeTransport(ANSWERS);
    const view = render(withCatalog(transport, <QueryConsole savedQueryId="q-1" />));
    await waitFor(() => expect(editorText()).toContain('SELECT * FROM mvr'));

    view.rerender(withCatalog(transport, <QueryConsole savedQueryId="q-7" />));

    await waitFor(() => expect(editorText()).toContain('SELECT assetId FROM subwo'));
  });

  it('names the saved query a dead link asked for, and opens nothing in its place', async () => {
    // The failure mode this file exists for, in its query-screen form. Silently leaving the
    // starter SQL up reads as a click that never registered; silently opening some OTHER saved
    // query would be worse still.
    const { transport } = fakeTransport(ANSWERS);
    render(withCatalog(transport, <QueryConsole savedQueryId="q-gone" />));

    expect(await screen.findByText(/not in this catalog/)).toBeTruthy();
    // The id itself, because it is the only actionable part of a broken link — it is what you send
    // back to whoever sent you the link, and what tells you it belongs to another environment.
    expect(screen.getByText('q-gone')).toBeTruthy();
    // And nothing was substituted for it.
    expect(editorText()).toContain('SELECT * FROM ');
    expect(editorText()).not.toContain('SELECT * FROM mvr');
  });

  it('says nothing about a missing query while the list is still in flight', async () => {
    // A notice that flashes on every correct link is a notice people learn to ignore. Until the
    // saved list has arrived the id is merely unresolved, which is not the same as gone.
    let release: (queries: SavedQuery[]) => void = () => {};
    const pending = new Promise<SavedQuery[]>((resolve) => {
      release = resolve;
    });
    const { transport } = fakeTransport({ ...ANSWERS, '/catalog/saved-queries': () => pending });
    render(withCatalog(transport, <QueryConsole savedQueryId="q-7" />));

    // Nothing yet — and nothing claiming the link is dead.
    expect(screen.queryByText(/not in this catalog/)).toBeNull();

    await act(async () => {
      release(QUERIES);
      await pending;
    });
    await waitFor(() => expect(editorText()).toContain('SELECT assetId FROM subwo'));
  });

  it('reports what you opened, so the host can put it in the address', async () => {
    // The half that makes a link produceable rather than only followable. The screen reports and
    // the host writes — see the prop's docblock for why the write is not self-service.
    const onSavedQueryChange = vi.fn();
    const { transport } = fakeTransport(ANSWERS);
    render(withCatalog(transport, <QueryConsole onSavedQueryChange={onSavedQueryChange} />));

    fireEvent.click(await screen.findByText('Work orders per vehicle'));

    await waitFor(() => expect(onSavedQueryChange).toHaveBeenCalledWith('q-7'));
    expect(editorText()).toContain('SELECT assetId FROM subwo');
  });

  it('does not overwrite what you have typed when the saved list changes underneath', async () => {
    // The other half of "open what the URL names": having opened it, STOP. The saved list is
    // refetched whenever anything on this screen saves, deletes or shares a query, and each
    // refetch hands the effect a fresh list naming the same id — so without a guard on "already
    // open" the console reaches back into the editor and undoes your edits, which is the query
    // screen's version of losing your work to a poll.
    const answers: Record<string, unknown> = { ...ANSWERS };
    const { transport } = fakeTransport(answers);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(withCatalog(transport, <QueryConsole savedQueryId="q-7" />, queryClient));
    await waitFor(() => expect(editorText()).toContain('SELECT assetId FROM subwo'));

    fireEvent.click(await screen.findByText('mvr'));
    await waitFor(() => expect(editorText()).toContain('SELECT assetId FROM subwomvr'));
    // A genuinely DIFFERENT list, because react-query shares structure: handing back a deeply
    // equal answer keeps the previous reference and would not re-run the effect at all, so a test
    // built on that would pass with or without the guard.
    answers['/catalog/saved-queries'] = [...QUERIES, savedQuery('q-9', 'Newer', 'SELECT 9')];
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['catalog', 'saved-queries'] });
    });

    await screen.findByText('Newer');
    expect(editorText()).toContain('SELECT assetId FROM subwomvr');
  });

  it('marks which of the saved queries a link opened, in the list', async () => {
    // The visible answer to "where did this SQL come from". A console that opens a query from a
    // link and then shows a list where every row looks identical has told you the editor was
    // filled from somewhere without saying from what — and the next thing that happens is
    // somebody saving a second copy of a query they already had open.
    const { transport } = fakeTransport(ANSWERS);
    render(withCatalog(transport, <QueryConsole savedQueryId="q-7" />));

    const row = await screen.findByText('Work orders per vehicle');
    await waitFor(() => expect(row.getAttribute('aria-current')).toBe('true'));
    expect(screen.getByText('Risk by base').getAttribute('aria-current')).toBeNull();
  });

  it('clears its own dead-link notice once you open something that is there', async () => {
    // Without this the notice would outlive its truth on any host that passes no callback — and a
    // banner only a host can dismiss is a banner that never goes away on the hosts that need it.
    const { transport } = fakeTransport(ANSWERS);
    render(withCatalog(transport, <QueryConsole savedQueryId="q-gone" />));
    await screen.findByText(/not in this catalog/);

    fireEvent.click(screen.getByText('Risk by base'));

    await waitFor(() => expect(screen.queryByText(/not in this catalog/)).toBeNull());
  });
});

describe('the dashboard board opens the board the URL names', () => {
  it('opens what the host named, not the first one', async () => {
    // `d-3` is second in the list, so a screen that ignored the id would show "Fleet overview" and
    // look entirely healthy doing it.
    const { transport } = fakeTransport(ANSWERS);
    render(withCatalog(transport, <DashboardBoard dashboardId="d-3" />));

    expect(await screen.findByRole('heading', { name: 'Risk overview' })).toBeTruthy();
  });

  it('reads ?dashboard= out of the hash when the host passes nothing', async () => {
    window.location.hash = '#dashboards?dashboard=d-3';
    const { transport } = fakeTransport(ANSWERS);
    render(withCatalog(transport, <DashboardBoard />));

    expect(await screen.findByRole('heading', { name: 'Risk overview' })).toBeTruthy();
  });

  it('still opens the first board when nothing was named', async () => {
    // The other side of the switch, and the reason the refusal below has to be narrow. Defaulting
    // to the first board is RIGHT when nobody asked for one; it is only wrong when somebody did.
    const { transport } = fakeTransport(ANSWERS);
    render(withCatalog(transport, <DashboardBoard />));

    expect(await screen.findByRole('heading', { name: 'Fleet overview' })).toBeTruthy();
  });

  it('refuses to fall back to the first board when the named one is gone, and says which', async () => {
    // THE case. `?dashboard=d-9` used to render "Fleet overview" under a URL promising something
    // else, with nothing on screen to suggest the link had failed — a stale link that looks like a
    // working link showing the wrong thing.
    const { transport } = fakeTransport(ANSWERS);
    render(withCatalog(transport, <DashboardBoard dashboardId="d-9" />));

    expect(await screen.findByText('That dashboard is not here')).toBeTruthy();
    expect(screen.getByText('d-9')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Fleet overview' })).toBeNull();
  });

  it('says nothing about a missing board while the list is still in flight', async () => {
    let release: (boards: Dashboard[]) => void = () => {};
    const pending = new Promise<Dashboard[]>((resolve) => {
      release = resolve;
    });
    const { transport } = fakeTransport({ ...ANSWERS, '/catalog/dashboards': () => pending });
    render(withCatalog(transport, <DashboardBoard dashboardId="d-3" />));

    expect(screen.queryByText('That dashboard is not here')).toBeNull();

    await act(async () => {
      release(BOARDS);
      await pending;
    });
    expect(await screen.findByRole('heading', { name: 'Risk overview' })).toBeTruthy();
  });

  it('reports the board you clicked, so the host can put it in the address', async () => {
    const onDashboardChange = vi.fn();
    const { transport } = fakeTransport(ANSWERS);
    render(withCatalog(transport, <DashboardBoard onDashboardChange={onDashboardChange} />));

    fireEvent.click(await screen.findByText('Risk overview'));

    await waitFor(() => expect(onDashboardChange).toHaveBeenCalledWith('d-3'));
  });

  it('clears the address when the board that was open is deleted', async () => {
    // Otherwise the parameter outlives the board and the next reload greets its author with a
    // "that board is gone" notice about their own deliberate act.
    const onDashboardChange = vi.fn();
    const { transport } = fakeTransport({ ...ANSWERS, '/catalog/dashboards/d-3': null });
    render(
      withCatalog(
        transport,
        <DashboardBoard dashboardId="d-3" onDashboardChange={onDashboardChange} />,
      ),
    );
    await screen.findByRole('heading', { name: 'Risk overview' });

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(onDashboardChange).toHaveBeenCalledWith(undefined));
  });
});
