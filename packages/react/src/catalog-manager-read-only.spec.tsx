// @vitest-environment jsdom
//
// The docblock below must stay attached to the FIRST import in source order, and that import must
// be the one Biome's `organizeImports` would sort first — otherwise the sorter moves another
// import above this line, Vitest stops finding the environment hint, and every test here fails in
// `node` with `document is not defined`.
/**
 * The Model screen for a viewer who may read the catalog but not change it, and without the
 * host's pipeline sections.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A host that shows the model to people who cannot curate it had two bad options: mount the
 * editable screen and let every click on a name open an editor whose save always 403s, or not
 * mount it at all. `canEdit={false}` is the third, and what it promises is checked here by what
 * reaches the transport: a read-only screen issues no write, whatever is clicked. `pipeline={false}`
 * promises the same about the host's pipeline endpoints — not asked for at all, not merely hidden.
 *
 * The other half is the editable default, which used to drop a refused edit without a word: the
 * field went back to its old value and nothing said why.
 *
 * jsdom has no layout, so every assertion is about text, roles and calls. `toBeDisabled` and the
 * other jest-dom matchers are not set up in this package and THROW rather than fail.
 */
import type { CatalogObjectTypeDef, CatalogSnapshot } from '@dudousxd/nestjs-catalog/client';
import { catalogRoutes } from '@dudousxd/nestjs-catalog/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { CatalogManager } from './CatalogManager';
import { LoadExpectationSection } from './LoadExpectationSection';
import { CatalogProvider, type CatalogTransport, type ResolvedLoadExpectation } from './context';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// `screen` queries `document.body`, so a screen left mounted makes the NEXT test's queries
// ambiguous — and the failure reads as a duplicate element rather than as a leak.
afterEach(cleanup);

const EXPECTATION_PATH = '/pipeline/expectations/Mvr';
const WORKFLOWS_PATH = '/pipeline/workflows';

interface Call {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
}

/**
 * A transport that answers from a path→value map and records every call. An `Error` value is
 * answered as a rejection, and so is a path with no answer — which is what makes "nothing else
 * was asked for" visible as a call in the list rather than a hang.
 */
function fakeTransport(answers: Record<string, unknown>) {
  const calls: Call[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: the seam under test is generic on the response.
  const answer = (path: string): Promise<any> => {
    if (!(path in answers)) return Promise.reject(new Error(`No fake answer for ${path}`));
    const value = answers[path];
    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
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

  const writes = () => calls.filter((call) => call.method !== 'GET');
  return { transport, calls, writes };
}

function withCatalog(transport: CatalogTransport, children: ReactNode) {
  const queryClient = new QueryClient({
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
  icon: '🚚',
  description: 'A vehicle in the fleet.',
  primaryKey: ['id'],
  enriched: true,
  properties: [
    {
      name: 'id',
      displayName: 'Identifier',
      type: 'string',
      columnName: 'id',
      nullable: false,
      primary: true,
      hidden: false,
      order: 0,
      enriched: true,
    },
    {
      name: 'odometer',
      displayName: 'Odometer',
      type: 'number',
      columnName: 'odometer',
      nullable: true,
      primary: false,
      hidden: true,
      order: 1,
      enriched: true,
      unit: 'km',
      description: 'Distance driven.',
    },
  ],
  // One link this type declares, so its label is on screen to be (not) edited. Its target is
  // unpublished on purpose: a published one is a navigate button, and the "click everything" case
  // below would then move the detail pane to another type halfway through its loop.
  relations: [
    {
      name: 'base',
      displayName: 'Home base',
      kind: 'm:1',
      targetType: 'Base',
      nullable: true,
      hidden: false,
      order: 0,
      owner: true,
      localKey: 'base_id',
      targetPublished: false,
      enriched: true,
    },
  ],
};

const SNAPSHOT: CatalogSnapshot = {
  version: 3,
  generatedAt: '2026-01-01T00:00:00.000Z',
  stats: { types: 1, properties: 2, relations: 1, enrichedTypes: 1 },
  types: [TYPE],
};

const EXPECTATION: ResolvedLoadExpectation = {
  typeName: 'Mvr',
  resolved: {
    deletes: { strategy: 'accepted', because: 'The fleet ledger only ever appends rows.' },
    rowCount: { maxShrink: 0.5, minRows: 100 },
  },
  deletesFrom: 'stored',
  rowCountFrom: 'default',
  stored: {
    typeName: 'Mvr',
    deletes: { strategy: 'accepted', because: 'The fleet ledger only ever appends rows.' },
    setBy: 'console-app',
    setAt: '2026-02-03T09:30:00.000Z',
  },
  hostLocked: { deletes: false, rowCount: false },
};

/** Every answer the full screen asks for, so a missing one cannot pass as "not requested". */
const ALL_ANSWERS = {
  '/catalog': SNAPSHOT,
  [EXPECTATION_PATH]: EXPECTATION,
  [WORKFLOWS_PATH]: [],
};

/**
 * Lets every write a click may have started reach the transport before a "no writes" assertion.
 *
 * TanStack Query runs a mutation's `mutationFn` after the click returns, not inside it, so a
 * synchronous `writes()` straight after the clicks is empty whatever the screen did. Waiting a
 * real 50 ms inside `act` lets those calls land and any state they set flush, so an empty list
 * then means nothing was asked for.
 */
async function settle() {
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
}

/** The detail pane, once the type has loaded. */
async function detail() {
  return within(await screen.findByRole('main'));
}

describe('CatalogManager canEdit={false}', () => {
  it('renders every curated field as text, with nothing to click that edits it', async () => {
    const { transport } = fakeTransport(ALL_ANSWERS);
    render(withCatalog(transport, <CatalogManager canEdit={false} />));
    const pane = await detail();

    // The values are all there…
    expect(pane.getByText('Vehicle')).toBeDefined();
    expect(pane.getByText('A vehicle in the fleet.')).toBeDefined();
    expect(pane.getByText('Fleet')).toBeDefined();
    expect(pane.getByText('Vehicles')).toBeDefined();
    expect(pane.getByText('Identifier')).toBeDefined();
    expect(pane.getByText('km')).toBeDefined();
    expect(pane.getByText('Home base')).toBeDefined();
    expect(await pane.findByText('Distance driven.')).toBeDefined();

    // …and none of them is a control. Every editor in the screen is named "Edit <field>".
    expect(screen.queryAllByRole('button', { name: /^Edit / })).toEqual([]);
    expect(screen.queryAllByRole('button', { name: /^(Hide|Show) / })).toEqual([]);
    expect(screen.queryByText('Reset edits')).toBeNull();
    // The state the toggle carried is still said, for the row that is hidden.
    expect(pane.getByRole('img', { name: 'Odometer is hidden' })).toBeDefined();
  });

  it('issues no write, whatever is clicked', async () => {
    const { transport, writes } = fakeTransport(ALL_ANSWERS);
    render(withCatalog(transport, <CatalogManager canEdit={false} />));
    const pane = await detail();
    // Wait for the pipeline sections too, so their controls (if any) are on screen to click.
    await pane.findByText('The fleet ledger only ever appends rows.');

    for (const text of ['Vehicle', 'Fleet', 'Vehicles', 'Identifier', 'km', 'Home base']) {
      fireEvent.click(pane.getByText(text));
    }
    for (const button of screen.queryAllByRole('button')) fireEvent.click(button);

    // A click that opened an editor would have put a textbox on screen; none should exist in the
    // detail pane (the sidebar's filter is the screen's one input, and it is not in `main`).
    expect(pane.queryAllByRole('textbox')).toEqual([]);
    await settle();
    expect(writes()).toEqual([]);
  });

  it('shows the load expectation in force without the form that sets it', async () => {
    const { transport } = fakeTransport(ALL_ANSWERS);
    render(withCatalog(transport, <CatalogManager canEdit={false} />));
    const pane = await detail();

    expect(await pane.findByText('The fleet ledger only ever appends rows.')).toBeDefined();
    expect(pane.queryByText('Save expectation')).toBeNull();
    expect(pane.queryByText('Clear the stored one')).toBeNull();
    expect(pane.queryByText(/^Set it for/)).toBeNull();
  });

  it('describes the screen without inviting edits', async () => {
    const { transport } = fakeTransport(ALL_ANSWERS);
    render(withCatalog(transport, <CatalogManager canEdit={false} />));
    await detail();

    expect(screen.queryByText(/yours to change/)).toBeNull();
  });
});

describe('CatalogManager pipeline={false}', () => {
  it('leaves out Loaded by and Load expectation, and never asks the pipeline endpoints', async () => {
    const { transport, calls } = fakeTransport(ALL_ANSWERS);
    render(withCatalog(transport, <CatalogManager pipeline={false} />));
    const pane = await detail();

    expect(pane.getByText('Properties')).toBeDefined();
    expect(pane.getByText('Links')).toBeDefined();
    expect(pane.queryByText('Loaded by')).toBeNull();
    expect(pane.queryByText('Load expectation')).toBeNull();
    // Given the same moment the full screen takes to ask: the snapshot has rendered, which is
    // when the sections would have mounted and fetched.
    await waitFor(() => expect(calls.map((call) => call.path)).toEqual(['/catalog']));
  });

  it('asks for both by default', async () => {
    const { transport, calls } = fakeTransport(ALL_ANSWERS);
    render(withCatalog(transport, <CatalogManager />));
    await detail();

    await waitFor(() =>
      expect(new Set(calls.map((call) => call.path))).toEqual(
        new Set(['/catalog', EXPECTATION_PATH, WORKFLOWS_PATH]),
      ),
    );
  });
});

describe('CatalogManager edits', () => {
  it('still offers every editor by default', async () => {
    const { transport } = fakeTransport(ALL_ANSWERS);
    render(withCatalog(transport, <CatalogManager />));
    await detail();

    expect(screen.getByRole('button', { name: 'Edit display name' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Edit Group' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Hide Identifier' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Edit label for base' })).toBeDefined();
    expect(screen.getByText('Reset edits')).toBeDefined();
  });

  it('says so when the server refuses an edit, instead of quietly reverting it', async () => {
    const { transport, writes } = fakeTransport({
      ...ALL_ANSWERS,
      [catalogRoutes.type('Mvr')]: new Error('Forbidden'),
    });
    render(withCatalog(transport, <CatalogManager />));
    await detail();

    fireEvent.click(screen.getByRole('button', { name: 'Edit Group' }));
    const input = screen.getByRole('textbox', { name: 'Group' });
    fireEvent.change(input, { target: { value: 'Trucks' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('That edit was not saved: Forbidden');
    expect(writes()).toEqual([
      { method: 'PATCH', path: catalogRoutes.type('Mvr'), body: { group: 'Trucks' } },
    ]);

    fireEvent.click(within(alert).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says so when the server refuses the reset', async () => {
    const { transport } = fakeTransport({
      ...ALL_ANSWERS,
      [catalogRoutes.reset()]: new Error('Forbidden'),
    });
    render(withCatalog(transport, <CatalogManager />));
    await detail();

    fireEvent.click(screen.getByText('Reset edits'));

    expect((await screen.findByRole('alert')).textContent).toContain(
      'The reset was not saved: Forbidden',
    );
  });
});

describe('LoadExpectationSection canEdit={false}', () => {
  it('renders the expectation and no form', async () => {
    const { transport, writes } = fakeTransport({ [EXPECTATION_PATH]: EXPECTATION });
    render(
      withCatalog(
        transport,
        <LoadExpectationSection typeName="Mvr" displayName="Vehicle" canEdit={false} />,
      ),
    );

    expect(await screen.findByText('The fleet ledger only ever appends rows.')).toBeDefined();
    expect(document.querySelector('form')).toBeNull();
    expect(screen.queryByText('Save expectation')).toBeNull();
    for (const button of screen.queryAllByRole('button')) fireEvent.click(button);
    await settle();
    expect(writes()).toEqual([]);
  });
});
