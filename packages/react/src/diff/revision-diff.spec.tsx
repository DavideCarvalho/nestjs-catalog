// @vitest-environment jsdom
//
// The docblock below must stay attached to the FIRST import in source order, and that import must
// be the one Biome's `organizeImports` would sort first — otherwise the sorter moves another
// import above this line, Vitest stops finding the environment hint, and every test here fails in
// `node` with `document is not defined`.
/**
 * The history screen, and the three places somebody reaches it from.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Neither of the two things in this catalog whose text a person edits kept any history: a
 * transform's `version` counts saves of a row that is overwritten in place, so the `code v3` a
 * connector run records has been naming code that existed nowhere. Revisions fix the storage. What
 * is asserted here is the part storage cannot fix — that the screen built on top of them tells the
 * truth about what it has, including when it has nothing.
 *
 * Four kinds of nothing live in this feature and three of them are NOT "nothing changed":
 *
 * - nothing recorded, because the edits predate revisions;
 * - one version recorded, so there is nothing before it to compare against;
 * - a run naming a version the recorded history does not contain;
 * - and two versions that really are byte-identical, which is the only one allowed to say so.
 *
 * Rendering any of the first three as the fourth tells somebody their code did not change when it
 * did, which is the single worst thing this screen could do, so each has its own test below and
 * each asserts on the ABSENCE of the "identical" sentence as well as on its own.
 *
 * The entry points are exercised through the real screens — `PipelineConsole`, `QueryConsole`,
 * `TransformEditor` — rather than by mounting the sheet, because a test that mounted it directly
 * would keep passing after the control that puts it on screen was removed. That is the same
 * argument `schema-discovery.spec.tsx` makes at the top of itself.
 *
 * `toBeChecked` / `toBeDisabled` are NOT available — this repo registers no jest-dom setup, and
 * they throw rather than fail. `toHaveProperty` is the equivalent that works. jsdom also does no
 * layout, so nothing here asserts on scroll position or size; the row cap is asserted by counting
 * rendered rows, which is a fact about the DOM rather than about a viewport.
 */
import type {
  CatalogConnector,
  CatalogRevision,
  CatalogTransform,
  SavedQuery,
} from '@dudousxd/nestjs-catalog/client';
import { CATALOG_REVISION_LIMIT } from '@dudousxd/nestjs-catalog/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { PipelineConsole } from '../PipelineConsole';
import { QueryConsole } from '../QueryConsole';
import { TransformEditor } from '../TransformEditor';
import { CatalogProvider, type CatalogTransport } from '../context';
import { DiffBody, RevisionHistory } from './RevisionDiff';

declare global {
  // React refuses to believe a test is a test without this, and warns on every state update.
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Base UI's select and tooltip observe their anchor's size, which jsdom cannot compute and throws
 * about. Stubbed rather than asserted on: nothing here depends on what they measure.
 */
class NoopResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = NoopResizeObserver;
Element.prototype.scrollIntoView = () => {};

afterEach(cleanup);

const TRANSFORM: CatalogTransform = {
  id: 't1',
  name: 'Fleet mapper',
  language: 'javascript',
  code: 'return records.map(toRow)\n// current',
  version: 5,
  createdBy: 'ana',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const CONNECTOR: CatalogConnector = {
  id: 'c1',
  name: 'Nightly fleet load',
  kind: 'sql',
  targetType: 'Mvr',
  config: { query: 'SELECT * FROM vehicles' },
  transformId: 't1',
  enabled: true,
  createdBy: 'ana',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function revision(version: number, body: string, authoredBy = 'ana'): CatalogRevision {
  return {
    id: `r${version}`,
    subjectId: 't1',
    version,
    body,
    authoredBy,
    authoredAt: '2026-01-01T00:00:00.000Z',
  };
}

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

/** A transport that answers from a path→value map and records every path it was asked for. */
function fakeTransport(answers: Record<string, unknown>) {
  const paths: string[] = [];
  // The suppression has to be the line immediately above, so the reason goes here:
  // `CatalogTransport` is generic on its response and a fixture map cannot be, and this is what
  // lets the fake satisfy it without an assertion. Same seam, same reason, as `screens.spec.tsx`.
  // biome-ignore lint/suspicious/noExplicitAny: see above.
  const answer = (path: string): Promise<any> => {
    paths.push(path);
    if (!(path in answers)) return Promise.reject(new Error(`No fake answer for ${path}`));
    const value = answers[path];
    return Promise.resolve(typeof value === 'function' ? value() : value);
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
 * The rendered row a line of text sits in, as its own text content.
 *
 * The sign gutter is the assertion target on purpose. It is the only marker on a diff row that
 * survives a colourblind reader, a printout and a screen reader — the background tint does not —
 * so testing the sign is testing the thing a person actually reads. A row comes out as
 * `<before><after><sign><text>`, e.g. `33 return x` for an unchanged line and `3+return x` for an
 * added one.
 */
function rowOf(text: string): string {
  const found = screen.getByText(text).closest('div');
  return found?.textContent ?? '';
}

describe('the comparison itself', () => {
  it('marks the one line that changed and leaves the others unmarked', () => {
    // The whole point, at the level a person sees it. A row list that coloured every line — or
    // the wrong line — still renders as a plausible diff, which is why the unchanged rows are
    // asserted on too rather than only the changed ones.
    render(
      <DiffBody
        before={'const a = 1;\nreturn a + b;\n// done'}
        after={'const a = 1;\nreturn a * b;\n// done'}
      />,
    );

    expect(rowOf('return a + b;')).toBe('2−return a + b;');
    expect(rowOf('return a * b;')).toBe('2+return a * b;');
    // Unchanged, and saying so: both line numbers present, and the gutter blank.
    expect(rowOf('const a = 1;')).toBe('11 const a = 1;');
    expect(rowOf('// done')).toBe('33 // done');
  });

  it('says the two are identical only when they actually are', () => {
    render(<DiffBody before={'a\nb'} after={'a\nb'} />);

    expect(screen.getByText('These two versions are identical.')).toBeTruthy();
  });

  it('counts what changed rather than making somebody count rows', () => {
    render(<DiffBody before={'a\nb\nc'} after={'a\nB\nc\nd'} />);

    expect(screen.getByText('+2')).toBeTruthy();
    expect(screen.getByText('−1')).toBeTruthy();
    expect(screen.queryByText('These two versions are identical.')).toBeNull();
  });

  it('folds a long unchanged stretch and opens it again when asked', () => {
    // A transform is hundreds of lines and the answer is almost never more than a handful of
    // them. Folded rather than dropped: a diff that hides code with no way to see it is a diff
    // you cannot trust, and this is code somebody is about to make a decision about.
    const before = Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n');
    const after = before.replace('line 20', 'line 20 // touched');
    render(<DiffBody before={before} after={after} />);

    expect(screen.queryByText('line 0')).toBeNull();
    const fold = screen.getByText(/17 unchanged lines/);

    fireEvent.click(fold);

    expect(screen.getByText('line 0')).toBeTruthy();
  });

  it('caps the rows it paints and says how many it is holding back', () => {
    // Past a few hundred rows the browser is painting a wall nobody reads and the screen appears
    // frozen, which is its own dishonesty about what is happening. NOTE what is capped: rows.
    // Line CONTENT is never truncated, because two lines truncated into equality would be
    // reported as unchanged — see DIFF_MAX_ROWS for why `capLines` is not the model here.
    const before = Array.from({ length: 700 }, (_, index) => `old ${index}`).join('\n');
    const after = Array.from({ length: 700 }, (_, index) => `new ${index}`).join('\n');
    render(<DiffBody before={before} after={after} />);

    expect(screen.queryByText('old 600')).toBeNull();
    const more = screen.getByRole('button', { name: /Show the remaining \d+ lines/ });

    fireEvent.click(more);

    expect(screen.getByText('old 600')).toBeTruthy();
  });

  it('renders a long line whole rather than cutting it', () => {
    // The rule that makes the comparison trustworthy at all: two lines that differ only past a
    // character cap would be truncated into equality and reported as unchanged.
    const long = `x${'y'.repeat(900)}`;
    render(<DiffBody before={`${long}A`} after={`${long}B`} />);

    expect(screen.getByText(`${long}A`)).toBeTruthy();
    expect(screen.getByText(`${long}B`)).toBeTruthy();
  });
});

describe('the history screen', () => {
  const REVISIONS = [
    revision(5, 'return records.map(toRow)\n// current'),
    revision(4, 'return records.map(toRow)\n// four'),
    revision(3, 'return records.map(oldRow)\n// three', 'bruno'),
  ];

  function renderHistory(
    answers: Record<string, unknown>,
    props: Partial<Parameters<typeof RevisionHistory>[0]> = {},
  ) {
    const { transport, paths } = fakeTransport(answers);
    render(
      withCatalog(
        transport,
        <RevisionHistory
          subject={{ kind: 'transform', id: 't1', name: 'Fleet mapper' }}
          current={{ version: 5, body: TRANSFORM.code }}
          {...props}
        />,
      ),
    );
    return { paths };
  }

  it('opens on the version that ran against the version that is current', async () => {
    // THE default, and the reason this screen is reached from a run rather than from a pair of
    // dropdowns. Somebody standing in front of a load that came out wrong should not have to pick
    // two version numbers blind — the step where you pick the wrong one and conclude the code was
    // fine.
    renderHistory({ '/pipeline/transforms/t1/revisions': REVISIONS }, { ranVersion: 3 });

    await waitFor(() =>
      expect(screen.getByLabelText('Compare version').textContent).toContain('v3'),
    );
    expect(screen.getByLabelText('Against version').textContent).toContain('v5');
    // And the comparison really is v3 → v5, not v4 → v5.
    expect(screen.getByText('return records.map(oldRow)')).toBeTruthy();
    expect(screen.getByText('// current')).toBeTruthy();
  });

  it('falls back to the last change when no run named a version', async () => {
    // The transform editor's way in. Nobody named anything, so the useful default is "what
    // changed most recently", which is the previous version against the current one.
    renderHistory({ '/pipeline/transforms/t1/revisions': REVISIONS });

    await waitFor(() =>
      expect(screen.getByLabelText('Compare version').textContent).toContain('v4'),
    );
    expect(screen.getByLabelText('Against version').textContent).toContain('v5');
  });

  it('names a version a run used that the recorded history does not contain', async () => {
    // The backfill case, and it has to be sayable. A run that says `code v2` against a history
    // starting at v3 means the code that produced that load is gone — showing v3 → v5 with no
    // notice would let somebody conclude they were looking at what ran.
    renderHistory({ '/pipeline/transforms/t1/revisions': REVISIONS }, { ranVersion: 2 });

    expect(await screen.findByText(/recorded history does not contain/)).toBeTruthy();
    expect(screen.getByText('v2')).toBeTruthy();
    // Both reasons a version can be absent, and the retention number read from the store's own
    // constant rather than printed from a number this screen picked. `CATALOG_REVISION_LIMIT` is
    // exported as a value for exactly this — a console that hardcoded 50 would keep saying 50
    // after the store stopped keeping 50.
    expect(
      screen.getByText(new RegExp(`pushed out by the ${CATALOG_REVISION_LIMIT} newer ones`)),
    ).toBeTruthy();
    expect(screen.queryByText('These two versions are identical.')).toBeNull();
  });

  it('reads an empty history as nothing recorded, never as nothing changed', async () => {
    // Every transform predating this feature may have one revision or none, depending on what the
    // store decided about backfill. The second sentence of this panel is the whole assertion.
    renderHistory({ '/pipeline/transforms/t1/revisions': [] }, { current: undefined });

    expect(await screen.findByText(/No history is recorded for/)).toBeTruthy();
    expect(screen.getByText(/not the same as saying nothing has changed/)).toBeTruthy();
    expect(screen.queryByText('These two versions are identical.')).toBeNull();
  });

  it('says there is nothing before the only version it has', async () => {
    // Also not a claim that nothing changed: the earlier code was overwritten, which is a
    // statement about the store rather than about the code.
    renderHistory(
      { '/pipeline/transforms/t1/revisions': [revision(5, 'x')] },
      { current: undefined },
    );

    expect(await screen.findByText(/nothing before it to compare against/)).toBeTruthy();
    expect(screen.queryByText('These two versions are identical.')).toBeNull();
  });

  it('puts the newest version on the right even when the route answers out of order', async () => {
    // The contract says newest first and the bundled store will honour it. A store somebody else
    // wrote might not, and a screen that trusted the order would show v5 on the left and v3 on
    // the right — every addition rendered as a deletion, a comparison that is exactly backwards
    // and looks entirely plausible.
    renderHistory({ '/pipeline/transforms/t1/revisions': [...REVISIONS].reverse() });

    await waitFor(() =>
      expect(screen.getByLabelText('Against version').textContent).toContain('v5'),
    );
    expect(screen.getByLabelText('Compare version').textContent).toContain('v4');
  });

  it('includes the live row when the recorded history stops short of it', async () => {
    // A store that records on save but backfilled nothing leaves the running code ahead of
    // everything recorded. Treating the newest revision as "current" would compare two old
    // versions under a heading promising the current one.
    renderHistory({ '/pipeline/transforms/t1/revisions': [revision(3, 'old body')] });

    await waitFor(() =>
      expect(screen.getByLabelText('Against version').textContent).toContain('v5'),
    );
    expect(screen.getByText('return records.map(toRow)')).toBeTruthy();
  });

  it('reports a history it could not read instead of rendering an empty one', async () => {
    // A failed request that fell through to the empty state would say "no history is recorded",
    // which is a claim about the data made from a network error.
    renderHistory({});

    expect(await screen.findByText(/No fake answer for/)).toBeTruthy();
    expect(screen.queryByText(/No history is recorded for/)).toBeNull();
  });
});

describe('the ways in', () => {
  it('makes the version on a connector run the way into the comparison', async () => {
    // Where somebody is standing when the question occurs to them. The run row already says
    // `code v3`; making that the control means the number does not have to be carried anywhere.
    const { transport, paths } = fakeTransport({
      '/pipeline/capabilities': { languages: ['javascript'], pythonPackages: [] },
      '/pipeline/connectors': [CONNECTOR],
      '/pipeline/transforms': [TRANSFORM],
      '/pipeline/connections': [],
      '/pipeline/runs': [
        {
          id: 'run-1',
          connectorId: 'c1',
          snapshotId: 'snap-1',
          principalId: 'ana',
          status: 'succeeded',
          fetched: 10,
          written: 10,
          logs: [],
          startedAt: '2026-01-02T00:00:00.000Z',
          transformVersion: 3,
        },
      ],
      '/pipeline/transforms/t1/revisions': [
        revision(5, 'return records.map(toRow)\n// current'),
        revision(3, 'return records.map(oldRow)\n// three'),
      ],
    });
    render(withCatalog(transport, <PipelineConsole />));

    const control = await screen.findByRole('button', {
      name: /Compare the code that ran \(v3\) with the current code/,
    });
    fireEvent.click(control);

    await waitFor(() => expect(paths).toContain('/pipeline/transforms/t1/revisions'));
    // Opened on what ran, not on the last change.
    await waitFor(() =>
      expect(screen.getByLabelText('Compare version').textContent).toContain('v3'),
    );
    expect(screen.getByText('return records.map(oldRow)')).toBeTruthy();
  });

  it('offers the history from the transform editor', async () => {
    const { transport, paths } = fakeTransport({
      '/pipeline/transforms/t1/revisions': [revision(5, 'a'), revision(4, 'b')],
    });
    render(
      withCatalog(
        transport,
        <TransformEditor
          transform={TRANSFORM}
          languages={['javascript']}
          onClose={() => {}}
          onSaved={() => {}}
        />,
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: 'History' }));

    await waitFor(() => expect(paths).toContain('/pipeline/transforms/t1/revisions'));
  });

  it('offers no history for a transform that does not exist yet', () => {
    // A draft has no history, and a control that can only ever open an empty panel is a control
    // that teaches people to stop pressing it.
    const { transport } = fakeTransport({});
    render(
      withCatalog(
        transport,
        <TransformEditor languages={['javascript']} onClose={() => {}} onSaved={() => {}} />,
      ),
    );

    expect(screen.queryByRole('button', { name: 'History' })).toBeNull();
  });

  it('offers the history from the saved-query list, against the saved-query route', async () => {
    // A different endpoint from the transform side, and deliberately a different client method:
    // a saved query is the catalog library's own resource and a transform is the host's, so a
    // host can move one of the two and not the other.
    const { transport, paths } = fakeTransport({
      '/catalog/query/relations': [],
      '/catalog/saved-queries': [savedQuery('q-1', 'Risk by base', 'SELECT * FROM mvr')],
      '/catalog/saved-queries/q-1/revisions': [],
    });
    render(withCatalog(transport, <QueryConsole />));

    fireEvent.click(await screen.findByRole('button', { name: 'History of Risk by base' }));

    await waitFor(() => expect(paths).toContain('/catalog/saved-queries/q-1/revisions'));
  });
});
