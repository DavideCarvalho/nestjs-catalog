// @vitest-environment jsdom
//
// The docblock below must stay attached to the FIRST import in source order, and that import must
// be the one Biome's `organizeImports` would sort first — otherwise the sorter moves another
// import above this line, Vitest stops finding the environment hint, and every test here fails in
// `node` with `document is not defined`.
/**
 * "What have I changed since I last saved?" — which this console could not answer.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The history sheet compared RECORDED revisions against each other, and nothing else. The SQL in
 * the editor — the version somebody is actually deciding about — was never on either side of the
 * comparison, so the one diff a person mid-edit wants was the one diff they could not get.
 *
 * The reason it was left out is written down in `SavedQueryPanel`, and it is half right:
 * `SavedQuery` carries no `version` counter, so unsaved SQL has no number that anything else in
 * the system would agree with, and inventing one would put a version on text that exists in one
 * browser tab. True. But "cannot be NAMED" is not "cannot be COMPARED", and the newest recorded
 * revision is a perfectly good thing to diff against. So the buffer goes in unnamed, as
 * `Unsaved edits`.
 *
 * What is asserted here is the boundary of that, because the failure modes are quiet ones: the
 * buffer belongs to the EDITOR, not to any particular row, so offering it under some other query's
 * history would diff two unrelated bodies and present the result as a change; and folding it into
 * a subject with no recorded history at all would replace an honest "nothing is recorded" with a
 * screen claiming every line was added.
 *
 * `toBeChecked` / `toBeDisabled` are NOT available — this repo registers no jest-dom setup, and
 * they throw rather than fail. Rendered code is read through the shadow root the diff renders
 * into, since Testing Library's queries stop at the host element.
 */
import type { CatalogRevision, SavedQuery } from '@dudousxd/nestjs-catalog/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { installCodeSurfaceDom } from '../../../../test/jsdom-code-surface';
import { QueryConsole } from '../QueryConsole';
import { CatalogProvider, type CatalogTransport } from '../context';

declare global {
  // React refuses to believe a test is a test without this, and warns on every state update.
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

installCodeSurfaceDom();
Element.prototype.scrollIntoView = () => {};

afterEach(cleanup);

const SAVED_SQL = 'SELECT assetId FROM subwo';

function savedQuery(id: string, name: string, sql: string): SavedQuery {
  return {
    id,
    name,
    sql,
    createdBy: 'ana',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cacheTtlSeconds: 0,
    visualization: { kind: 'table' },
    shared: false,
  };
}

function revision(version: number, body: string): CatalogRevision {
  return {
    id: `r${version}`,
    subjectId: 'q-1',
    version,
    body,
    authoredBy: 'ana',
    authoredAt: '2026-01-01T00:00:00.000Z',
  };
}

/** A relation to click, which is the only way a test can put text into the editor. */
const RELATIONS = [
  {
    name: 'mvr',
    objectType: 'Mvr',
    kind: 'current' as const,
    description: 'The committed snapshot.',
    columns: [],
  },
];

function fakeTransport(answers: Record<string, unknown>) {
  const paths: string[] = [];
  // The suppression has to be the line immediately above, so the reason goes here:
  // `CatalogTransport` is generic on its response and a fixture map cannot be, and this is what
  // lets the fake satisfy it without an assertion. Same seam, same reason, as `screens.spec.tsx`.
  // biome-ignore lint/suspicious/noExplicitAny: see above.
  const answer = (path: string): Promise<any> => {
    paths.push(path);
    if (!(path in answers)) return Promise.reject(new Error(`No fake answer for ${path}`));
    return Promise.resolve(answers[path]);
  };
  const transport: CatalogTransport = {
    get: (path) => answer(path),
    post: (path) => answer(path),
    patch: (path) => answer(path),
    delete: (path) => answer(path),
  };
  return { transport, paths };
}

function withCatalog(transport: CatalogTransport, children: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <CatalogProvider transport={transport}>{children}</CatalogProvider>
    </QueryClientProvider>
  );
}

/**
 * The rows of the rendered comparison, by what happened to each.
 *
 * The LAST `diffs-container` on the page, not the first. This screen has two: the SQL editor, which
 * mounts with the console, and the diff inside the history sheet, which mounts after it. Reading
 * the first one gets the editor's own single unchanged line and no additions at all — which is a
 * green-looking nothing, and how this helper was wrong the first time.
 */
function linesOfType(type: 'change-addition' | 'change-deletion'): string[] {
  const containers = [...document.querySelectorAll('diffs-container')];
  const root = containers[containers.length - 1]?.shadowRoot;
  const found =
    root?.querySelectorAll(`[data-content] [data-line-type="${type}"]:not([data-no-newline])`) ??
    [];
  return [...found].map((node) => node.textContent ?? '');
}

/**
 * Open the console on a saved query, edit it, and open that query's history.
 *
 * Through the real screen rather than by mounting `RevisionHistory` with a `buffer` prop, because
 * the thing being asserted is that the SQL in the editor REACHES the sheet — a test that handed it
 * over itself would keep passing after the wiring was removed.
 */
async function openHistoryAfterEditing(revisions: CatalogRevision[]) {
  const { transport } = fakeTransport({
    '/catalog/query/relations': RELATIONS,
    '/catalog/saved-queries': [savedQuery('q-1', 'Risk by base', SAVED_SQL)],
    '/catalog/saved-queries/q-1/revisions': revisions,
  });
  render(withCatalog(transport, <QueryConsole savedQueryId="q-1" />));

  // The relation name lands at the end, since jsdom gives the editor no caret.
  fireEvent.click(await screen.findByText('mvr'));
  fireEvent.click(await screen.findByRole('button', { name: 'History of Risk by base' }));
}

describe('the SQL in the editor, against the last version saved', () => {
  it('compares what is being edited with the newest recorded revision', async () => {
    // The whole feature. Nothing before this could put an unsaved body on either side of the
    // comparison, so "did I change anything since I saved" had no answer on this screen at all.
    await openHistoryAfterEditing([revision(2, SAVED_SQL), revision(1, 'SELECT 1')]);

    await waitFor(() => expect(linesOfType('change-addition').length).toBeGreaterThan(0));
    expect(linesOfType('change-addition')).toEqual([`${SAVED_SQL}mvr`]);
    expect(linesOfType('change-deletion')).toEqual([SAVED_SQL]);
  });

  it('calls it `Unsaved edits`, having no version number to call it', async () => {
    // `SavedQuery` has no `version` field, so there is no number that anything else in the system
    // would agree with. The name says what it is instead of inventing one — and it says it in the
    // picker, so the two sides of the comparison are legible without reading the SQL.
    await openHistoryAfterEditing([revision(2, SAVED_SQL), revision(1, 'SELECT 1')]);

    await waitFor(() =>
      expect(screen.getByLabelText('Against version').textContent).toContain('Unsaved edits'),
    );
    // And the recorded side keeps its number, so the pair reads "v2 → Unsaved edits".
    expect(screen.getByLabelText('Compare version').textContent).toContain('v2');
  });

  it('says the two are identical when nothing has been typed since the save', async () => {
    // The state that is easy to render as a bug. Somebody who opens history without editing must
    // be told there is no difference, not shown an empty panel they have to interpret.
    const { transport } = fakeTransport({
      '/catalog/query/relations': RELATIONS,
      '/catalog/saved-queries': [savedQuery('q-1', 'Risk by base', SAVED_SQL)],
      '/catalog/saved-queries/q-1/revisions': [revision(2, SAVED_SQL), revision(1, 'SELECT 1')],
    });
    render(withCatalog(transport, <QueryConsole savedQueryId="q-1" />));

    fireEvent.click(await screen.findByRole('button', { name: 'History of Risk by base' }));

    expect(await screen.findByText('These two versions are identical.')).toBeTruthy();
  });

  it('does not offer the editor buffer under a query that is not the one open', async () => {
    // The quiet failure. `currentSql` belongs to the EDITOR, not to the row whose history button
    // was pressed, so handing it to every row would diff one query's SQL against another's history
    // and present the result as a change somebody made.
    const { transport } = fakeTransport({
      '/catalog/query/relations': RELATIONS,
      '/catalog/saved-queries': [
        savedQuery('q-1', 'Risk by base', SAVED_SQL),
        savedQuery('q-2', 'Work orders', 'SELECT id FROM wo'),
      ],
      '/catalog/saved-queries/q-2/revisions': [revision(2, 'SELECT id FROM wo'), revision(1, 'x')],
    });
    render(withCatalog(transport, <QueryConsole savedQueryId="q-1" />));

    fireEvent.click(await screen.findByRole('button', { name: 'History of Work orders' }));

    await waitFor(() =>
      expect(screen.getByLabelText('Against version').textContent).toContain('v2'),
    );
    expect(screen.queryByText('Unsaved edits')).toBeNull();
  });

  it('leaves an empty history saying nothing is recorded, rather than diffing against nothing', async () => {
    // "No history is recorded" is a true statement about the store. Folding an unsaved buffer in
    // beside it would replace it with a comparison claiming every line was just added, which is a
    // statement about the code and a false one.
    await openHistoryAfterEditing([]);

    expect(await screen.findByText(/No history is recorded for/)).toBeTruthy();
    expect(screen.queryByText('Unsaved edits')).toBeNull();
  });
});
