// @vitest-environment jsdom
//
// The docblock below must stay attached to the FIRST import in source order, and that import must
// be the one Biome's `organizeImports` would sort first — otherwise the sorter moves another
// import above this line, Vitest stops finding the environment hint, and every test here fails in
// `node` with `document is not defined`.
/**
 * The load-expectation section, reached the way a person reaches it: through the Model screen.
 *
 * WHAT THESE TESTS ARE ABOUT
 * --------------------------
 * Two claims, and both of them are claims about what the screen REFUSES to do.
 *
 * 1. A `because` cannot be skipped. It is the entire mechanism — what the policy polices is not
 *    which strategy was chosen but that somebody chose one and wrote down why — so a form that let
 *    an empty one through would store a sentence nobody can be held to and satisfy the check
 *    anyway. Asserted twice per strategy: the button is disabled, AND submitting the form directly
 *    sends nothing. A disabled button is a statement about the pointer; Enter in a text field is
 *    not a pointer.
 * 2. A field the host fixed in code is shown, explained and DISABLED. Hiding it would leave a
 *    screen that cannot explain why the type behaves the way it does; leaving it editable would
 *    offer a write the server answers 409 to, which is the failure this section was built to
 *    prevent.
 *
 * The whole `CatalogManager` is mounted rather than the section on its own, because what a host
 * installs is the screen: a test that rendered the section directly would keep passing after the
 * line that puts it on the Model panel was deleted.
 *
 * Nothing here relies on layout. jsdom has none — no `getClientRects`, no canvas — so the
 * assertions are on text, attributes and what reached the transport. `toBeDisabled` and
 * `toBeChecked` are unavailable in this package (no jest-dom setup) and THROW rather than fail;
 * `toHaveProperty('disabled', true)` is the equivalent that works, as `workflow-canvas.spec.tsx`
 * records.
 */
import type { CatalogObjectTypeDef, CatalogSnapshot } from '@dudousxd/nestjs-catalog/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { CatalogManager } from './CatalogManager';
import {
  CatalogProvider,
  type CatalogTransport,
  type ResolvedLoadExpectation,
  type StoredLoadExpectation,
} from './context';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// `screen` queries `document.body`, so a screen left mounted makes the NEXT test's queries
// ambiguous — and the failure reads as a duplicate element rather than as a leak.
afterEach(cleanup);

const EXPECTATION_PATH = '/pipeline/expectations/Mvr';

interface Call {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  body?: unknown;
}

/**
 * A transport that answers from a path→value map and records every call.
 *
 * `put` is implemented, and that is not incidental: `setLoadExpectation` refuses by name on a
 * transport without it rather than resolving having done nothing, so a fake missing it would make
 * every save here fail for a reason that has nothing to do with what is being tested.
 */
function fakeTransport(answers: Record<string, unknown>) {
  const calls: Call[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: the seam under test is generic on its response.
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
    put: (path, body) => {
      calls.push({ method: 'PUT', path, body });
      return answer(path);
    },
    delete: (path) => {
      calls.push({ method: 'DELETE', path });
      return answer(path);
    },
  };

  const writes = () => calls.filter((call) => call.method === 'PUT' || call.method === 'DELETE');

  return { transport, calls, writes };
}

function withCatalog(transport: CatalogTransport, children: ReactNode) {
  const queryClient = new QueryClient({
    // No retries: a refusal should reach the screen once, not four times over 30 seconds.
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>
      <CatalogProvider transport={transport}>{children}</CatalogProvider>
    </QueryClientProvider>
  );
}

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

const SNAPSHOT: CatalogSnapshot = {
  version: 3,
  generatedAt: '2026-01-01T00:00:00.000Z',
  stats: { types: 1, properties: 0, relations: 0, enrichedTypes: 1 },
  types: [TYPE],
};

const STORED: StoredLoadExpectation = {
  typeName: 'Mvr',
  deletes: { strategy: 'accepted', because: 'The fleet ledger only ever appends rows.' },
  setBy: 'console-app',
  setByActor: 'ana@example.mil',
  setAt: '2026-02-03T09:30:00.000Z',
};

function view(overrides: Partial<ResolvedLoadExpectation> = {}): ResolvedLoadExpectation {
  return {
    typeName: 'Mvr',
    resolved: {
      deletes: STORED.deletes,
      rowCount: { maxShrink: 0.5, minRows: 100 },
    },
    deletesFrom: 'stored',
    rowCountFrom: 'default',
    stored: STORED,
    hostLocked: { deletes: false, rowCount: false },
    ...overrides,
  };
}

/** Nothing at any layer says how this type reconciles deletes. */
function undeclared(): ResolvedLoadExpectation {
  return {
    typeName: 'Mvr',
    resolved: { rowCount: { maxShrink: 0.5, minRows: 100 } },
    deletesFrom: 'none',
    rowCountFrom: 'default',
    hostLocked: { deletes: false, rowCount: false },
  };
}

function mount(expectation: unknown) {
  const fake = fakeTransport({ '/catalog': SNAPSHOT, [EXPECTATION_PATH]: expectation });
  render(withCatalog(fake.transport, <CatalogManager />));
  return fake;
}

const strategySelect = () =>
  screen.getByRole('combobox', { name: 'Delete reconciliation strategy' });

const saveButton = () => screen.getByRole('button', { name: /Save expectation/ });

/**
 * The provenance table, once the section has loaded.
 *
 * Found by its own header rather than as "the table on the screen": the Model panel already has
 * one, for the type's properties, and it is rendered SYNCHRONOUSLY while this section is still
 * fetching. A test that took the first table would silently assert against that one and report a
 * missing row as a missing field.
 */
async function provenanceTable() {
  await screen.findByRole('button', { name: /Save expectation/ });
  const table = screen
    .getAllByRole('table')
    .find((candidate) => candidate.textContent?.includes('Where it came from'));
  if (!table) throw new Error('The provenance table is not on the screen.');
  return within(table);
}

/**
 * Choose a strategy from the vendored select.
 *
 * Keyboard rather than a click on the option, and the reason is worth recording: Base UI commits a
 * selection on the pointer sequence a real mouse produces, which `fireEvent.click` alone is not —
 * the click lands, the popup closes, and nothing is selected, so the test passes for the wrong
 * reason. Enter on the highlighted item is a real way to operate the control and one jsdom can
 * deliver faithfully.
 */
async function chooseStrategy(match: RegExp) {
  fireEvent.click(strategySelect());
  const option = await screen.findByRole('option', { name: match });
  fireEvent.keyDown(option, { key: 'Enter' });
  fireEvent.keyUp(option, { key: 'Enter' });
  await waitFor(() => expect(screen.queryByRole('option', { name: match })).toBeNull());
}

/** Submit the form itself, past the disabled button — what Enter in a field does. */
function submitForm() {
  const form = saveButton().closest('form');
  if (!form) throw new Error('The save button is not in a form.');
  fireEvent.submit(form);
}

describe('the load expectation on the Model screen', () => {
  it('says plainly that an undeclared type has its incremental loads refused', async () => {
    // The state the section exists for. A blank strategy field reads as "not filled in yet", which
    // is the opposite of what it means: the load is already being refused, today, silently.
    mount(undeclared());

    expect(
      await screen.findByText(
        /Nothing declares how Vehicle reconciles deletes, so an incremental load of it will be refused/,
      ),
    ).toBeDefined();
    // …and it says what is NOT blocked, because "loads are refused" sends somebody to look at a
    // nightly full load that is working exactly as intended.
    expect(screen.getByText(/A full load still commits/)).toBeDefined();
  });

  it('shows the strategy, the reason as prose, and who signed it', async () => {
    mount(view());

    // `selector: 'p'` because the same sentence is also the textarea's value, and the two are the
    // point of the distinction: one is prose somebody signed, the other is the field for editing
    // it. A query that matched both would pass on a screen that had lost the prose entirely.
    expect(
      await screen.findByText('The fleet ledger only ever appends rows.', { selector: 'p' }),
    ).toBeDefined();
    // The actor first and the principal after it: the audit's real subject is the person, and a
    // line naming only the application key would be the attribution failure this whole feature is
    // about.
    expect(screen.getByText(/Set by ana@example\.mil, through console-app on /)).toBeDefined();
    expect(screen.queryByText(/will be refused/)).toBeNull();
  });

  it('reports where every field came from, field by field', async () => {
    // One badge for the whole expectation would have to pick a layer and be wrong about the other
    // half: a host can pin the row-count bound and say nothing about deletes.
    mount(view({ deletesFrom: 'stored', rowCountFrom: 'host' }));

    // Scoped to the table, because the form below it labels its fields with the same words — which
    // is right, they are the same fields — and an unscoped query would match either.
    const table = await provenanceTable();
    expect(table.getByText('Delete reconciliation')).toBeDefined();
    expect(table.getByText('Max shrink')).toBeDefined();
    expect(table.getByText('0.5 of the served snapshot')).toBeDefined();
    // Absent growth is the documented behaviour, not a value somebody forgot.
    expect(table.getByText('growth is never refused')).toBeDefined();
    expect(table.getByText('100 rows')).toBeDefined();

    expect(table.getAllByText('Set here, by an operator')).toHaveLength(1);
    expect(table.getAllByText('Fixed in code by this deployment')).toHaveLength(3);
  });

  it('offers exactly three strategies', async () => {
    // The fourth answer — tombstones off a change feed — is deliberately absent, and a dropdown
    // offering a strategy nothing implements is the lie this codebase refuses everywhere else.
    mount(view());

    fireEvent.click(
      await screen.findByRole('combobox', { name: 'Delete reconciliation strategy' }),
    );

    // The count is the assertion. The three below only pin which three they are — a fourth would
    // pass every one of them and fail this.
    expect(await screen.findAllByRole('option')).toHaveLength(3);
    expect(screen.getByRole('option', { name: /^Accepted/ })).toBeDefined();
    expect(screen.getByRole('option', { name: /^Soft-deleted at the source/ })).toBeDefined();
    expect(screen.getByRole('option', { name: /^Periodic full reload/ })).toBeDefined();
  });

  for (const [label, match] of [
    ['accepted', /Accepted/],
    ['soft-deleted-at-source', /Soft-deleted/],
    ['periodic-full-reload', /Periodic full reload/],
  ] as const) {
    it(`will not store ${label} without a because`, async () => {
      const { writes } = mount(undeclared());

      await screen.findByRole('combobox', { name: 'Delete reconciliation strategy' });
      await chooseStrategy(match);
      // `periodic-full-reload` needs an interval as well; filled in so that the ONLY thing missing
      // is the sentence, and this test cannot pass on the strength of the other rule.
      if (label === 'periodic-full-reload') {
        fireEvent.change(screen.getByLabelText(/^Reconcile within/), {
          target: { value: '86400000' },
        });
      }

      expect(saveButton()).toHaveProperty('disabled', true);
      expect(screen.getByText(/Required\. Say why this is the right answer/)).toBeDefined();

      submitForm();
      await waitFor(() => expect(screen.queryByText('Saving…')).toBeNull());
      expect(writes()).toEqual([]);
    });
  }

  it('refuses a periodic full reload with no interval, and one that is not positive', async () => {
    // The interval is what makes this strategy enforceable at all: `refuseStaleReconciliation`
    // stops incremental commits once the newest full load is older than it. Zero would stop them
    // immediately, which is not what anybody picking this means.
    const { writes } = mount(undeclared());

    await screen.findByRole('combobox', { name: 'Delete reconciliation strategy' });
    await chooseStrategy(/Periodic full reload/);
    fireEvent.change(screen.getByLabelText(/^Because/), {
      target: { value: 'Reconciled by the nightly full load.' },
    });

    expect(saveButton()).toHaveProperty('disabled', true);
    expect(screen.getByText(/Required, and greater than zero/)).toBeDefined();

    fireEvent.change(screen.getByLabelText(/^Reconcile within/), { target: { value: '0' } });
    expect(saveButton()).toHaveProperty('disabled', true);

    submitForm();
    await waitFor(() => expect(screen.queryByText('Saving…')).toBeNull());
    expect(writes()).toEqual([]);

    fireEvent.change(screen.getByLabelText(/^Reconcile within/), {
      target: { value: '86400000' },
    });
    expect(saveButton()).toHaveProperty('disabled', false);
  });

  it('stores what the form holds, then reads the resolved answer back', async () => {
    const { transport, calls, writes } = mount(undeclared());

    await screen.findByRole('combobox', { name: 'Delete reconciliation strategy' });
    await chooseStrategy(/Soft-deleted/);
    fireEvent.change(screen.getByLabelText(/^Because/), {
      target: { value: 'The source flips deleted_at, so the watermark sees it.' },
    });
    fireEvent.change(screen.getByLabelText(/^Column/), {
      target: { value: 'deleted_at' },
    });
    fireEvent.change(screen.getByLabelText(/^Max shrink/), { target: { value: '0.8' } });

    fireEvent.click(saveButton());

    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({
      method: 'PUT',
      path: EXPECTATION_PATH,
      body: {
        deletes: {
          strategy: 'soft-deleted-at-source',
          because: 'The source flips deleted_at, so the watermark sees it.',
          column: 'deleted_at',
        },
        rowCount: { maxShrink: 0.8 },
      },
    });
    expect(transport.put).toBeDefined();

    // The write's answer is not believed: what belongs on screen is the RESOLVED expectation, and
    // resolving a stored row against what the host declares in code is the server's job. So a
    // successful save is followed by a second GET, not by a cache write.
    await waitFor(() =>
      expect(
        calls.filter((call) => call.method === 'GET' && call.path === EXPECTATION_PATH).length,
      ).toBeGreaterThan(1),
    );
  });

  it('drops the stored row through the route that drops it, not by storing a blank one', async () => {
    const { writes } = mount(view());

    fireEvent.click(await screen.findByRole('button', { name: /Clear the stored one/ }));

    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({ method: 'DELETE', path: EXPECTATION_PATH });
  });

  it('offers no clear when there is nothing stored to clear', async () => {
    // The host's layer survives a clear, so a button here would either do nothing or read as an
    // offer to delete something written in a commit.
    mount(undeclared());

    await screen.findByRole('combobox', { name: 'Delete reconciliation strategy' });
    expect(screen.queryByRole('button', { name: /Clear the stored one/ })).toBeNull();
  });

  describe('when the host has fixed a field in code', () => {
    const locked = () =>
      view({
        deletesFrom: 'host',
        resolved: {
          deletes: {
            strategy: 'periodic-full-reload',
            because: 'Reconciled by the 03:00 full load; the source cannot soft-delete.',
            withinMs: 86_400_000,
          },
          rowCount: { maxShrink: 0.5, minRows: 100 },
        },
        stored: undefined,
        hostLocked: { deletes: true, rowCount: false },
      });

    it('shows the value and disables the controls rather than hiding them', async () => {
      mount(locked());

      // Shown: a screen that hid it could not explain why the type behaves as it does.
      expect(
        await screen.findByText(
          'Reconciled by the 03:00 full load; the source cannot soft-delete.',
          {
            selector: 'p',
          },
        ),
      ).toBeDefined();
      // The interval in the unit somebody would have said it in. `86400000` beside a strategy is a
      // number a reader has to divide before they know whether it means an hour or a fortnight.
      expect(screen.getByText(/reconciled every 24 hours/)).toBeDefined();

      // Disabled: an edit that silently fails server-side is worse than no edit.
      expect(strategySelect()).toHaveProperty('disabled', true);
      expect(screen.getByLabelText(/^Because/)).toHaveProperty('disabled', true);
      expect(screen.getByLabelText(/^Reconcile within/)).toHaveProperty('disabled', true);
      // …and said out loud, naming the thing that fixed it.
      expect(screen.getByText(/fixed the delete strategy in code/)).toBeDefined();

      // The half the host did NOT lock is still editable, because the resolution is field by field.
      expect(screen.getByLabelText(/^Max shrink/)).toHaveProperty('disabled', false);
    });

    it('sends nothing about a locked field, even when the form is submitted directly', async () => {
      // The server answers 409 for a write to a field the host owns, so echoing its value back
      // would turn every save of the other half into that refusal.
      const { writes } = mount(locked());

      fireEvent.change(await screen.findByLabelText(/^Max shrink/), { target: { value: '0.9' } });
      submitForm();

      await waitFor(() => expect(writes()).toHaveLength(1));
      expect(writes()[0]).toEqual({
        method: 'PUT',
        path: EXPECTATION_PATH,
        body: { rowCount: { maxShrink: 0.9 } },
      });
    });

    it('has nothing to save when the host owns every field', async () => {
      const { writes } = mount(
        view({
          deletesFrom: 'host',
          rowCountFrom: 'host',
          stored: undefined,
          hostLocked: { deletes: true, rowCount: true },
        }),
      );

      await screen.findByText(/Every field here is fixed in code/);
      // Both halves say so, separately, because they are locked separately.
      expect(screen.getByText(/fixed the delete strategy in code/)).toBeDefined();
      expect(screen.getByText(/fixed the row-count bounds in code/)).toBeDefined();
      expect(saveButton()).toHaveProperty('disabled', true);
      expect(screen.getByLabelText(/^Max shrink/)).toHaveProperty('disabled', true);

      submitForm();
      await waitFor(() => expect(screen.queryByText('Saving…')).toBeNull());
      expect(writes()).toEqual([]);
    });
  });

  it('says it could not read the expectation rather than implying there is none', async () => {
    // "Nothing is declared" and "we could not ask" lead to opposite conclusions, and only one of
    // them means an incremental load is being refused. The endpoints belong to the host, so a
    // deployment that mounts no pipeline controller reaches this every time.
    mount(new Error('Request failed with status code 404'));

    expect(await screen.findByText('Could not read the load expectation.')).toBeDefined();
    expect(screen.getByText(/Request failed with status code 404/)).toBeDefined();
    expect(screen.queryByText(/will be refused/)).toBeNull();
  });
});
