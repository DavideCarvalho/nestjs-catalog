// @vitest-environment jsdom
//
// The docblock below must stay attached to the FIRST import in source order, and that import must
// be the one Biome's `organizeImports` would sort first — otherwise the sorter moves another
// import above this line, Vitest stops finding the environment hint, and every test here fails in
// `node` with `document is not defined`.
/**
 * The schema-discovery panel, rendered for real inside the connector editor.
 *
 * WHAT THESE TESTS ARE ABOUT
 * --------------------------
 * One thing: that the screen never lets a guess become a type. Discovery reports columns it could
 * not type, and the console's job is to keep those visibly out of the proposal until a person says
 * what they are — so most of what is asserted below is the DISABLED state of the create button and
 * the reason printed beside it.
 *
 * The panel is reached the way a person reaches it, through the connectors tab and the editor,
 * rather than by rendering an internal component: what a host installs is `<PipelineConsole />`,
 * and a test that mounted the panel directly would keep passing after the wiring that puts it on
 * the screen was removed.
 *
 * Nothing here relies on layout. jsdom has none — no `getClientRects`, no canvas — so the panel
 * uses a native `<select>` and a native checkbox, which are real form controls a keyboard, a
 * screen reader and this test can all operate.
 */
import type { CatalogConnector, CatalogTransform } from '@dudousxd/nestjs-catalog/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ConnectorSchemaDiscovery,
  type DiscoveredTypeDraft,
  PipelineConsole,
  type SchemaDiscoveryBridge,
  initialChoices,
  proposalFrom,
} from './PipelineConsole';
import { CatalogProvider, type CatalogTransport } from './context';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// `screen` queries `document.body`, so a screen left mounted makes the NEXT test's queries
// ambiguous — and the failure reads as a duplicate element rather than as a leak.
afterEach(cleanup);

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

const TRANSFORM: CatalogTransform = {
  id: 't1',
  name: 'Fleet mapper',
  language: 'javascript',
  code: 'return records',
  version: 3,
  createdBy: 'ana',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function discovery(overrides: Partial<ConnectorSchemaDiscovery> = {}): ConnectorSchemaDiscovery {
  return {
    connectorId: 'c1',
    connectorName: 'Nightly fleet load',
    targetType: 'Mvr',
    typeExists: false,
    basis: 'driver',
    sampled: 0,
    caveat: 'Read from the driver, so the names and types are the database’s own.',
    columns: [
      {
        name: 'plate',
        type: 'string',
        confidence: 'reported',
        sourceType: 'oid 1043',
        nullable: false,
      },
      {
        name: 'seen_at',
        type: null,
        confidence: 'unknown',
        sourceType: 'oid 1186',
        nullable: null,
        note: 'Nothing is mapped to Postgres type 1186.',
      },
    ],
    drift: null,
    ...overrides,
  };
}

/** A transport that answers the four reads the connectors tab makes, and nothing else. */
function fakeTransport(extra: Record<string, unknown> = {}): CatalogTransport {
  // The transport is generic on its response and a fixture map cannot be. Same seam, and same
  // reason, as `screens.spec.tsx`.
  // biome-ignore lint/suspicious/noExplicitAny: see above
  const answers: Record<string, any> = {
    '/pipeline/capabilities': { languages: ['javascript'], pythonPackages: [] },
    '/pipeline/connectors': [CONNECTOR],
    '/pipeline/transforms': [TRANSFORM],
    '/pipeline/connections': [],
    '/pipeline/runs': [],
    ...extra,
  };
  const answer = (path: string) =>
    path in answers
      ? Promise.resolve(answers[path])
      : Promise.reject(new Error(`No fake answer for ${path}`));

  return {
    get: (path) => answer(path),
    post: (path) => answer(path),
    patch: (path) => answer(path),
    delete: (path) => answer(path),
  };
}

function renderConsole(
  schemaDiscovery?: SchemaDiscoveryBridge,
  transportAnswers: Record<string, unknown> = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <CatalogProvider transport={fakeTransport(transportAnswers)}>
        <PipelineConsole schemaDiscovery={schemaDiscovery} />
      </CatalogProvider>
    </QueryClientProvider>,
  );
}

/**
 * Open the editor for the one connector, the way a person does.
 *
 * The card's route into the editor is its transform button, which is why the fixture carries a
 * transform — this is the existing shape of the screen, not something these tests arrange.
 */
async function openEditor(
  schemaDiscovery?: SchemaDiscoveryBridge,
  transportAnswers: Record<string, unknown> = {},
) {
  renderConsole(schemaDiscovery, transportAnswers);
  fireEvent.click(await screen.findByRole('button', { name: /Fleet mapper/ }));
  return screen.findByPlaceholderText('Nightly fleet load');
}

/** Open the editor, press discover, and wait for the report. */
async function discoverIn(bridge: SchemaDiscoveryBridge) {
  await openEditor(bridge);
  fireEvent.click(screen.getByRole('button', { name: 'Discover schema' }));
  await screen.findByRole('table');
}

function bridgeFor(
  value: ConnectorSchemaDiscovery,
  createType?: (draft: DiscoveredTypeDraft) => Promise<unknown>,
): SchemaDiscoveryBridge {
  return { discover: () => Promise.resolve(value), ...(createType ? { createType } : {}) };
}

describe('the proposal a set of choices makes', () => {
  // The single decision this file exists to protect: a column discovery could not type starts
  // OUT. Pre-selecting it with a plausible default is how a guess becomes a column in a lake.
  it('leaves an untyped column unselected and untyped', () => {
    const choices = initialChoices(discovery().columns);
    expect(choices).toEqual([
      { include: true, type: 'string' },
      { include: false, type: '' },
    ]);
  });

  it('refuses to propose an included column with no type, naming it', () => {
    const found = discovery();
    const { problems, draft } = proposalFrom(found, [
      { include: true, type: 'string' },
      { include: true, type: '' },
    ]);
    expect(problems.join(' ')).toContain('"seen_at"');
    expect(draft.properties.map((property) => property.name)).toEqual(['plate']);
  });

  it('refuses a proposal with nothing in it, rather than sending an empty type', () => {
    const { problems } = proposalFrom(discovery(), [
      { include: false, type: 'string' },
      { include: false, type: '' },
    ]);
    expect(problems.join(' ')).toMatch(/Nothing is selected/);
  });

  // The store matches records to properties by property NAME, so the property has to be spelled
  // the way the source spells it. `columnName` goes along as the same string.
  it('takes the source spelling for both the property and its column', () => {
    const { draft } = proposalFrom(
      discovery({ columns: [{ ...discovery().columns[0], name: 'first_name' }] }),
      [{ include: true, type: 'string' }],
    );
    expect(draft.properties[0]).toMatchObject({ name: 'first_name', columnName: 'first_name' });
  });

  // Not stated is published nullable: a NOT NULL column the source sometimes leaves empty is a
  // load that fails at 3am, and a nullable column that never holds a null costs nothing.
  it('publishes a column whose nullability was never stated as nullable', () => {
    const { draft } = proposalFrom(discovery(), [
      { include: true, type: 'string' },
      { include: true, type: 'date' },
    ]);
    expect(draft.properties).toEqual([
      { name: 'plate', columnName: 'plate', type: 'string', nullable: false },
      { name: 'seen_at', columnName: 'seen_at', type: 'date', nullable: true },
    ]);
  });

  // Two columns of one name reach a record as one key, so only one of them can ever be loaded.
  it('refuses two included columns that share a name', () => {
    const twice = discovery({
      columns: [discovery().columns[0], { ...discovery().columns[0] }],
    });
    const { problems } = proposalFrom(twice, [
      { include: true, type: 'string' },
      { include: true, type: 'string' },
    ]);
    expect(problems.join(' ')).toMatch(/appears more than once/);
  });
});

describe('the connector editor', () => {
  it('offers discovery without the host wiring anything', async () => {
    // This used to assert the opposite, and the opposite used to be true: the
    // panel took a bridge as a prop and nothing supplied one, so the feature
    // was reachable only by a host that had read the source and written the two
    // calls itself. The console builds the bridge from its own client now, and
    // the prop is an override for a host routing discovery through a gateway of
    // its own.
    await openEditor();
    expect(screen.getByRole('button', { name: 'Discover schema' })).toBeTruthy();
  });

  it('prefers the bridge the host supplied over its own', async () => {
    // The override has to actually override. A default that quietly won would
    // send a host's gateway-routed discovery straight at the API it was wired
    // to avoid.
    const discover = vi.fn(() => Promise.resolve(discovery()));
    await discoverIn({ discover });
    expect(discover).toHaveBeenCalledTimes(1);
  });

  it('asks about the connector being edited, not about some other one', async () => {
    const discover = vi.fn(() => Promise.resolve(discovery()));
    await discoverIn({ discover });
    expect(discover).toHaveBeenCalledWith('c1');
  });

  // A second discovery is a new column list, and choices made against the old one may name
  // columns that no longer exist. Carrying them forward would silently confirm a schema nobody
  // looked at.
  it('drops the choices made against an earlier report when it runs again', async () => {
    await discoverIn(bridgeFor(discovery()));
    fireEvent.click(screen.getByLabelText('Include plate'));
    expect(screen.getByLabelText('Include plate')).toHaveProperty('checked', false);

    fireEvent.click(screen.getByRole('button', { name: 'Discover schema' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Include plate')).toHaveProperty('checked', true),
    );
  });

  it('says what the server said the report can prove', async () => {
    await discoverIn(bridgeFor(discovery()));
    expect(screen.getByText(/Read from the driver/)).toBeTruthy();
  });

  it('names a server answer it does not recognise, instead of crashing on it', async () => {
    // The console mirrors a shape held in `@dudousxd/nestjs-catalog-pipeline`,
    // which it cannot import — the package carries database drivers and must
    // never enter a browser bundle. So a console talking to an older server
    // gets a body it half understands, and without the guard the first thing
    // that happens is `undefined.map` somewhere inside the column table: a
    // stack trace naming a component, for a problem that is a version mismatch.
    //
    // Through the CLIENT path deliberately, with no bridge prop, because the
    // guard only exists on the bridge the console builds for itself.
    await openEditor(undefined, {
      '/pipeline/connectors/c1/discover': { connectorId: 'c1', caveat: 'sure' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Discover schema' }));

    expect(await screen.findByText(/does not recognise/)).toBeTruthy();
  });

  it('reports a source that could not be read, rather than an empty table', async () => {
    await openEditor({
      discover: () => Promise.reject(new Error('password authentication failed')),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Discover schema' }));
    expect(await screen.findByText(/password authentication failed/)).toBeTruthy();
  });
});

describe('the discovered columns', () => {
  it('lists every column the source reported', async () => {
    await discoverIn(bridgeFor(discovery()));
    const table = within(screen.getByRole('table'));
    expect(table.getByText('plate')).toBeTruthy();
    expect(table.getByText('seen_at')).toBeTruthy();
  });

  it('starts an untyped column excluded, and a typed one included', async () => {
    await discoverIn(bridgeFor(discovery()));
    // `toHaveProperty`, not jest-dom's `toBeChecked`: this repo registers no jest-dom setup file,
    // and `expect(el).toBeChecked()` throws "Invalid Chai property" rather than failing — a green
    // suite would have been one `.not.` away from meaning nothing.
    expect(screen.getByLabelText('Include plate')).toHaveProperty('checked', true);
    expect(screen.getByLabelText('Include seen_at')).toHaveProperty('checked', false);
  });

  it('will not create a type while an included column has no type', async () => {
    await discoverIn(bridgeFor(discovery(), () => Promise.resolve({})));
    fireEvent.click(screen.getByLabelText('Include seen_at'));
    expect(screen.getByRole('button', { name: 'Create Mvr' })).toHaveProperty('disabled', true);
    expect(screen.getByText(/Choose a type for "seen_at"/)).toBeTruthy();
  });

  // Three states, not two. "not stated" is what Postgres reports about every column, and
  // rendering it as "nullable" would be the screen inventing an answer the database never gave.
  it('says nullability was not stated rather than picking one', async () => {
    await discoverIn(bridgeFor(discovery()));
    const table = within(screen.getByRole('table'));
    expect(table.getByText('not stated')).toBeTruthy();
    expect(table.getByText('not null')).toBeTruthy();
  });

  it('marks an inferred type as inferred, so it does not read like the database speaking', async () => {
    const sampled = discovery({
      basis: 'sample',
      sampled: 12,
      columns: [
        { name: 'plate', type: 'string', confidence: 'inferred', sourceType: '', nullable: null },
      ],
    });
    await discoverIn(bridgeFor(sampled));
    expect(within(screen.getByRole('table')).getByText('inferred')).toBeTruthy();
  });

  it('shows the note explaining why a column could not be typed', async () => {
    await discoverIn(bridgeFor(discovery()));
    expect(screen.getByText(/Nothing is mapped to Postgres type 1186/)).toBeTruthy();
  });
});

describe('confirming', () => {
  it('sends exactly what was selected, with the type a person chose', async () => {
    const createType = vi.fn((_draft: DiscoveredTypeDraft) => Promise.resolve({}));
    await discoverIn(bridgeFor(discovery(), createType));

    fireEvent.click(screen.getByLabelText('Include seen_at'));
    fireEvent.change(screen.getByLabelText('Type for seen_at'), { target: { value: 'date' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Mvr' }));

    await waitFor(() => expect(createType).toHaveBeenCalled());
    expect(createType).toHaveBeenCalledWith({
      name: 'Mvr',
      properties: [
        { name: 'plate', columnName: 'plate', type: 'string', nullable: false },
        { name: 'seen_at', columnName: 'seen_at', type: 'date', nullable: true },
      ],
    });
  });

  it('leaves out a column somebody unchecked', async () => {
    const createType = vi.fn((_draft: DiscoveredTypeDraft) => Promise.resolve({}));
    await discoverIn(bridgeFor(discovery(), createType));

    fireEvent.click(screen.getByLabelText('Include plate'));
    fireEvent.click(screen.getByLabelText('Include seen_at'));
    fireEvent.change(screen.getByLabelText('Type for seen_at'), { target: { value: 'date' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Mvr' }));

    await waitFor(() => expect(createType).toHaveBeenCalled());
    // Read through the draft rather than off `mock.calls[0][0]`: the spy is
    // declared with no argument types, so its calls are an empty tuple and
    // indexing one is an error the spec typecheck now reports. Asserting the
    // length first also means a spy that was never called fails HERE, naming
    // that, instead of throwing on a property of undefined three lines down.
    const [draft] = createType.mock.lastCall ?? [];
    expect(draft).toBeDefined();
    expect(draft?.properties.map((property) => property.name)).toEqual(['seen_at']);
  });

  it('says the type now exists, so nobody presses it twice', async () => {
    await discoverIn(bridgeFor(discovery(), () => Promise.resolve({})));
    fireEvent.click(screen.getByRole('button', { name: 'Create Mvr' }));
    expect(await screen.findByText(/Mvr now exists/)).toBeTruthy();
  });

  it('offers to update rather than create when the type is already there', async () => {
    await discoverIn(
      bridgeFor(discovery({ typeExists: true, drift: null }), () => Promise.resolve({})),
    );
    expect(screen.getByRole('button', { name: 'Update Mvr' })).toBeTruthy();
  });

  it('reports a refusal from the publish route instead of looking like nothing happened', async () => {
    await discoverIn(
      bridgeFor(discovery(), () => Promise.reject(new Error('Mvr is owned by fleet-app'))),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create Mvr' }));
    expect(await screen.findByText(/owned by fleet-app/)).toBeTruthy();
  });

  // A host may deliberately keep type creation out of its console — the publish route is owned by
  // an application principal, or schema changes go through review. The screen has to say so and
  // still hand over what was approved.
  it('prints the request when the host wired no way to create a type', async () => {
    await discoverIn(bridgeFor(discovery()));
    expect(screen.queryByRole('button', { name: 'Create Mvr' })).toBeNull();
    expect(screen.getByText(/PUT \/publish\/Mvr\/schema/)).toBeTruthy();
    expect(screen.getByText(/"columnName": "plate"/)).toBeTruthy();
  });
});

describe('drift against a type that already exists', () => {
  const drifted = discovery({
    typeExists: true,
    drift: {
      added: ['trailer'],
      removed: ['owner'],
      retyped: [{ property: 'miles', was: 'number', now: 'string' }],
    },
  });

  it('names what the source gained, which every load drops today', async () => {
    await discoverIn(bridgeFor(drifted));
    expect(screen.getByText('trailer')).toBeTruthy();
    expect(screen.getByText(/dropped by every load/)).toBeTruthy();
  });

  it('names what the source lost, which every load writes as null today', async () => {
    await discoverIn(bridgeFor(drifted));
    expect(screen.getByText('owner')).toBeTruthy();
    expect(screen.getByText(/load as null/)).toBeTruthy();
  });

  it('names both ends of a type that moved', async () => {
    await discoverIn(bridgeFor(drifted));
    expect(screen.getByText(/is string in the source and number here/)).toBeTruthy();
  });

  // Silence would read as "no answer". A source that still matches has to say so, or somebody
  // re-runs discovery wondering whether it worked.
  it('says a quiet source is quiet', async () => {
    await discoverIn(
      bridgeFor(discovery({ typeExists: true, drift: { added: [], removed: [], retyped: [] } })),
    );
    expect(screen.getByText(/still matches Mvr/)).toBeTruthy();
  });

  it('says there is nothing to compare against when the type does not exist yet', async () => {
    await discoverIn(bridgeFor(discovery()));
    expect(screen.getByText(/does not exist yet/)).toBeTruthy();
  });
});
