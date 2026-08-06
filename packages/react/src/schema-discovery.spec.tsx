// @vitest-environment jsdom
//
// The docblock below must stay attached to the FIRST import in source order, and that import must
// be the one Biome's `organizeImports` would sort first — otherwise the sorter moves another
// import above this line, Vitest stops finding the environment hint, and every test here fails in
// `node` with `document is not defined`.
/**
 * The schema-discovery panel: where it is reached from now, and what it refuses to publish.
 *
 * WHAT THESE TESTS ARE ABOUT
 * --------------------------
 * Two things.
 *
 * **1. That discovery survived the move, and works on a draft.** It used to be reached through the
 * connectors tab and `POST connectors/:id/discover`; the connector stopped being an authored
 * object and both went. The route is per source NODE now, and it deliberately answers before a
 * graph is published — a sink cannot commit into a type that does not exist, so requiring a
 * published graph would require publishing a graph whose target type cannot be created until it
 * is. That ordering is the whole reason the route exists, so it is asserted through the canvas,
 * against a graph whose status is `draft`, on the path the server actually serves.
 *
 * **2. That the screen never lets a guess become a type.** Discovery reports columns it could not
 * type, and the console's job is to keep those visibly out of the proposal until a person says
 * what they are — so most of what is asserted below is the DISABLED state of the create button and
 * the reason printed beside it.
 *
 * WHY BOTH A CANVAS AND A DIRECT MOUNT
 * ------------------------------------
 * The wiring — that a source node offers this at all, that it asks about the node somebody opened,
 * that it will not run against edits nobody has saved — can only be checked through the screen,
 * because a test that mounted the panel itself would keep passing after the wiring was removed.
 * The column table and the confirmation are rules of the panel, and the panel is an exported
 * component a host may mount on its own inspector; driving those through a React Flow canvas would
 * buy nothing and cost a canvas mount per assertion.
 *
 * Nothing here relies on layout. jsdom has none — no `getClientRects`, no canvas — so the panel
 * uses a native `<select>` and a native checkbox, which are real form controls a keyboard, a
 * screen reader and this test can all operate.
 *
 * `toBeChecked` / `toBeDisabled` are NOT available — this repo registers no jest-dom setup, and
 * they throw rather than fail. `toHaveProperty('disabled', true)` is the equivalent that works.
 */
import type { CatalogSnapshot, CatalogWorkflow } from '@dudousxd/nestjs-catalog/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installCodeSurfaceDom } from '../../../test/jsdom-code-surface';
import { WorkflowCanvas } from './WorkflowCanvas';
import { CatalogProvider, type CatalogTransport } from './context';
import {
  type ConnectorSchemaDiscovery,
  type DiscoveredTypeDraft,
  type SchemaDiscoveryBridge,
  SchemaDiscoveryPanel,
  initialChoices,
  proposalFrom,
} from './schema-discovery';

// The canvas opens a transform node's code, and the editor is a real code surface: it needs canvas
// metrics, a firing ResizeObserver and constructable stylesheets, none of which jsdom has. Without
// the shim React throws `sheet.replaceSync is not a function` from inside `renderRootSync`, which
// lands as an UNHANDLED rejection rather than a failed assertion — so vitest exits non-zero while
// every test still reports green.
installCodeSurfaceDom();

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The browser APIs React Flow and Base UI reach for that jsdom does not implement.
 *
 * All of them are measurement, and jsdom does no layout, so none can have an observable effect
 * here — they are stubbed so the canvas mounts. Same set, and same reason, as
 * `workflow-canvas.spec.tsx`.
 */
class NoopResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = NoopResizeObserver;

class FlatDOMMatrix {
  m22 = 1;
}
Object.defineProperty(globalThis, 'DOMMatrixReadOnly', { value: FlatDOMMatrix, writable: true });
Object.defineProperty(globalThis, 'DOMMatrix', { value: FlatDOMMatrix, writable: true });
Object.defineProperties(globalThis.HTMLElement.prototype, {
  offsetHeight: { get: () => 80, configurable: true },
  offsetWidth: { get: () => 224, configurable: true },
});
Object.defineProperty(globalThis.SVGElement.prototype, 'getBBox', {
  value: () => ({ x: 0, y: 0, width: 0, height: 0 }),
  configurable: true,
});

// `screen` queries `document.body`, so a screen left mounted makes the NEXT test's queries
// ambiguous — and the failure reads as a duplicate element rather than as a leak.
afterEach(cleanup);

function discovery(overrides: Partial<ConnectorSchemaDiscovery> = {}): ConnectorSchemaDiscovery {
  return {
    workflowId: 'wf1',
    nodeId: 'src_1',
    nodeName: 'Feed',
    kind: 'sql',
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

/* --- the rules, which need no DOM at all ---------------------------------- */

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

/* --- the panel, mounted the way a host composing its own inspector would --- */

function withQueries(children: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function bridgeFor(
  value: ConnectorSchemaDiscovery,
  createType?: (draft: DiscoveredTypeDraft) => Promise<unknown>,
): SchemaDiscoveryBridge {
  return { discover: () => Promise.resolve(value), ...(createType ? { createType } : {}) };
}

/** Mount the panel, press discover, and wait for the report. */
async function discoverIn(bridge: SchemaDiscoveryBridge) {
  render(withQueries(<SchemaDiscoveryPanel workflowId="wf1" nodeId="src_1" bridge={bridge} />));
  fireEvent.click(screen.getByRole('button', { name: 'Discover schema' }));
  await screen.findByRole('table');
}

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

  it('says what the server said the report can prove', async () => {
    await discoverIn(bridgeFor(discovery()));
    expect(screen.getByText(/Read from the driver/)).toBeTruthy();
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

  it('reports a source that could not be read, rather than an empty table', async () => {
    render(
      withQueries(
        <SchemaDiscoveryPanel
          workflowId="wf1"
          nodeId="src_1"
          bridge={{
            discover: () => Promise.reject(new Error('password authentication failed')),
          }}
        />,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Discover schema' }));
    expect(await screen.findByText(/password authentication failed/)).toBeTruthy();
  });

  it('says why it cannot be pressed, instead of hiding itself', async () => {
    // A panel that vanished would leave somebody hunting for a button that was there a minute
    // ago. The two reasons are both about the graph being STORED — never about it being
    // published, which is the thing this route deliberately does not require.
    render(
      withQueries(
        <SchemaDiscoveryPanel
          workflowId="wf1"
          nodeId="src_1"
          bridge={bridgeFor(discovery())}
          disabledReason="Save first — discovery reads the stored node."
        />,
      ),
    );
    expect(screen.getByRole('button', { name: 'Discover schema' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByText(/Save first — discovery reads the stored node/)).toBeTruthy();
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
    // Read through the draft rather than off `mock.calls[0][0]`: the spy is declared with no
    // argument types, so its calls are an empty tuple and indexing one is an error the spec
    // typecheck reports. Asserting the length first also means a spy that was never called fails
    // HERE, naming that, instead of throwing on a property of undefined three lines down.
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

  // The draft case the route exists for, at its most awkward: a graph with a source and no sink
  // yet. There is no type to create and nothing to compare against, and the honest thing is to
  // say so — an empty `Create ` button would be a control naming nothing.
  it('offers no type to create when no sink has said which one', async () => {
    await discoverIn(bridgeFor(discovery({ targetType: '', typeExists: false })));
    expect(screen.queryByRole('button', { name: /^Create/ })).toBeNull();
    expect(screen.getByText(/no sink naming an object type yet/)).toBeTruthy();
    // …and the columns are still reported, because knowing what is in there is the point.
    expect(within(screen.getByRole('table')).getByText('plate')).toBeTruthy();
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

/* --- and the wiring, which only the screen can prove ---------------------- */

/** A DRAFT graph, deliberately: discovery must not require a published one. */
function draftWorkflow(overrides: Partial<CatalogWorkflow> = {}): CatalogWorkflow {
  return {
    id: 'wf1',
    name: 'Fleet',
    enabled: true,
    version: 1,
    status: 'draft',
    graphHash: 'hash-1',
    targetType: 'Mvr',
    createdBy: 'ana',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    nodes: [
      {
        id: 'src_1',
        name: 'Feed',
        kind: 'source',
        sourceKind: 'sql',
        config: { query: 'SELECT * FROM vehicles' },
        position: { x: 0, y: 0 },
      },
      {
        id: 'src_2',
        name: 'Other feed',
        kind: 'source',
        sourceKind: 'http',
        config: { url: 'https://example.test/other' },
        position: { x: 0, y: 200 },
      },
      { id: 'snk_1', name: 'Out', kind: 'sink', targetType: 'Mvr', position: { x: 320, y: 0 } },
    ],
    edges: [
      { from: 'src_1', to: 'snk_1' },
      { from: 'src_2', to: 'snk_1' },
    ],
    ...overrides,
  };
}

function snapshot(): CatalogSnapshot {
  return {
    version: 1,
    generatedAt: '2026-01-01T00:00:00.000Z',
    stats: { types: 1, properties: 0, relations: 0, enrichedTypes: 1 },
    types: [
      {
        name: 'Mvr',
        displayName: 'Vehicle',
        pluralDisplayName: 'Vehicles',
        tableName: 'mvr',
        group: 'Fleet',
        primaryKey: ['id'],
        enriched: true,
        properties: [],
        relations: [],
      },
    ],
  };
}

interface Posted {
  path: string;
  body: unknown;
}

function canvasTransport(extra: Record<string, unknown> = {}) {
  const posts: Posted[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: the seam under test is generic over its response.
  const answers: Record<string, any> = {
    '/pipeline/workflows': [draftWorkflow()],
    '/pipeline/transforms': [],
    '/pipeline/connections': [],
    '/pipeline/connectors': [],
    '/pipeline/capabilities': { languages: ['javascript'], pythonPackages: [] },
    '/catalog': snapshot(),
    ...extra,
  };
  const answer = (path: string) => {
    if (!(path in answers)) return Promise.reject(new Error(`No fake answer for ${path}`));
    const value = answers[path];
    const resolved = typeof value === 'function' ? value() : value;
    return resolved instanceof Error ? Promise.reject(resolved) : Promise.resolve(resolved);
  };

  const transport: CatalogTransport = {
    get: (path) => answer(path),
    post: (path, body) => {
      posts.push({ path, body });
      return answer(path);
    },
    patch: (path) => answer(path),
    delete: (path) => answer(path),
    put: (path, body) => {
      posts.push({ path, body });
      return answer(path);
    },
  };

  return { transport, posts };
}

async function openCanvas(transport: CatalogTransport) {
  render(
    withQueries(<CatalogProvider transport={transport}>{<WorkflowCanvas />}</CatalogProvider>),
  );
  await screen.findAllByText('Feed');
}

/** Open a stored node's inspector the way a pointer does: click the box. */
async function inspect(nodeLabel: string) {
  const node = document.querySelector(`.react-flow__node[aria-label^="${nodeLabel}"]`);
  if (!node) throw new Error(`No canvas node whose description starts "${nodeLabel}"`);
  fireEvent.click(
    within(node instanceof HTMLElement ? node : document.body).getByRole('button', {
      name: new RegExp(nodeLabel.split(', ')[1] ?? ''),
    }),
  );
  return within(await screen.findByRole('dialog'));
}

describe('reaching discovery from a source node', () => {
  it('asks about that node of that graph, on a graph nobody has published', async () => {
    // THE assertion this whole move turns on. The status is `draft` and the route still answers:
    // a sink cannot commit into a type that does not exist, so requiring a published graph would
    // require publishing a graph whose target type cannot be created until it is.
    const { transport, posts } = canvasTransport({
      '/pipeline/workflows/wf1/nodes/src_1/discover': discovery(),
    });
    await openCanvas(transport);

    const sheet = await inspect('source node, Feed');
    fireEvent.click(sheet.getByRole('button', { name: 'Discover schema' }));

    await waitFor(() => expect(screen.getByRole('table')).toBeTruthy());
    expect(posts.map((post) => post.path)).toContain(
      '/pipeline/workflows/wf1/nodes/src_1/discover',
    );
  });

  it('asks about the node that was opened, not about the other source', async () => {
    // A graph may have several sources — which the connector-shaped route could not express at
    // all — so the node id is the part that has to be right.
    const { transport, posts } = canvasTransport({
      '/pipeline/workflows/wf1/nodes/src_2/discover': discovery({
        nodeId: 'src_2',
        nodeName: 'Other feed',
      }),
    });
    await openCanvas(transport);

    const sheet = await inspect('source node, Other feed');
    fireEvent.click(sheet.getByRole('button', { name: 'Discover schema' }));

    await waitFor(() => expect(screen.getByRole('table')).toBeTruthy());
    expect(posts.map((post) => post.path)).toContain(
      '/pipeline/workflows/wf1/nodes/src_2/discover',
    );
  });

  it('names a server answer it does not recognise, instead of crashing on it', async () => {
    // The console mirrors a shape held in `@dudousxd/nestjs-catalog-pipeline`, which it cannot
    // import — that package carries database drivers and must never enter a browser bundle. So a
    // console talking to an older server gets a body it half understands, and without the guard
    // the first thing that happens is `undefined.map` somewhere inside the column table: a stack
    // trace naming a component, for a problem that is a version mismatch.
    const { transport } = canvasTransport({
      '/pipeline/workflows/wf1/nodes/src_1/discover': { nodeId: 'src_1', caveat: 'sure' },
    });
    await openCanvas(transport);

    const sheet = await inspect('source node, Feed');
    fireEvent.click(sheet.getByRole('button', { name: 'Discover schema' }));

    expect(await screen.findByText(/does not recognise/)).toBeTruthy();
  });

  it('will not discover against edits nobody has saved, and says so', async () => {
    // Discovery reads the STORED node. Running it over a source somebody has just re-pointed
    // would describe the address it used to have and report drift against the wrong thing — and
    // the reason has to name saving rather than publishing, because publishing is exactly what
    // this route does not require.
    const { transport } = canvasTransport({
      '/pipeline/workflows/wf1/nodes/src_1/discover': discovery(),
    });
    await openCanvas(transport);

    const sheet = await inspect('source node, Feed');
    fireEvent.change(sheet.getByLabelText(/^Name/), { target: { value: 'Renamed feed' } });

    await waitFor(() =>
      expect(sheet.getByRole('button', { name: 'Discover schema' })).toHaveProperty(
        'disabled',
        true,
      ),
    );
    expect(sheet.getByText(/Save first — discovery reads the stored node/)).toBeTruthy();
  });
});
