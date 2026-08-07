// @vitest-environment jsdom
//
// The docblock below must stay attached to the FIRST import in source order, and that import must
// be the one Biome's `organizeImports` would sort first — otherwise the sorter moves another
// import above this line, Vitest stops finding the environment hint, and every test here fails in
// `node` with `document is not defined`.
/**
 * Creating the address a source reads through, from the source node itself.
 *
 * WHAT THIS IS ABOUT
 * ------------------
 * The sink node has always been able to make the thing it needs — its schema-discovery panel turns
 * confirmed columns into an object type, on a draft, without leaving the canvas. The source node
 * could only *choose* an address, so a graph whose connection did not exist yet meant leaving the
 * canvas, opening the Connections tab, making one, coming back and finding the node again.
 *
 * WHY THE TESTS BELOW ARE MOSTLY ABOUT REFUSALS
 * ---------------------------------------------
 * Because a connection is the credential and the address boundary, and an inline form is exactly
 * where the protections around it get quietly dropped in the name of convenience. Each of these
 * pins one of them:
 *
 *  - the address is REACHED before it is stored, through the unsaved-check route, with no id on it;
 *  - a failed check keeps the server's own words, which is where the redacted host and user are;
 *  - a deployment that refuses a credential at rest has its refusal printed verbatim, and nothing
 *    is attached to the node when it does;
 *  - the redaction placeholder is never posted as if it were the password — the case with no
 *    server-side backstop at all, because a create has no stored row to restore the real one from.
 *
 * WHAT THESE TESTS DO NOT ASSERT
 * ------------------------------
 * Anything about geometry. jsdom does no layout, and the canvas is only mounted here because that
 * is where this form lives — the ResizeObserver/DOMMatrix stubs below are the same ones
 * `workflow-canvas.spec.tsx` installs, and for the same reason.
 *
 * `toBeChecked` / `toBeDisabled` are NOT available: this repo registers no jest-dom setup, and they
 * throw rather than fail. `toHaveProperty('disabled', true)` is the equivalent that works.
 */
import type {
  CatalogConnection,
  CatalogSnapshot,
  CatalogWorkflow,
  ConnectorKind,
} from '@dudousxd/nestjs-catalog/client';
import { CONNECTOR_KINDS } from '@dudousxd/nestjs-catalog/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { installCodeSurfaceDom } from '../../../test/jsdom-code-surface';
import { WorkflowCanvas } from './WorkflowCanvas';
import { CONNECTABLE_KINDS, CONNECTION_KINDS } from './connection-form';
import { CatalogProvider, type CatalogTransport } from './context';
import { usesConnection } from './source-fields';

installCodeSurfaceDom();

declare global {
  // React refuses to believe a test is a test without this, and warns on every state update.
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

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

afterEach(cleanup);

const CONNECTIONS = '/pipeline/connections';
const CHECK = '/pipeline/connections/check';
const WORKFLOWS = '/pipeline/workflows';

interface Call {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
}

/**
 * A transport that answers from a path→value map and records every call.
 *
 * GET and POST answers are kept in separate maps because the pipeline API serves both from one
 * path: `GET /pipeline/connections` lists and `POST /pipeline/connections` saves, and one map makes
 * a save answer the next list with whatever the save returned — an object where an array belongs,
 * which surfaces as `.map is not a function` deep inside a render.
 */
function fakeTransport(gets: Record<string, unknown>, posts: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: the seam under test is generic over its response.
  const answer = (from: Record<string, unknown>, path: string): Promise<any> => {
    if (!(path in from)) return Promise.reject(new Error(`No fake answer for ${path}`));
    const value = from[path];
    const resolved = typeof value === 'function' ? value() : value;
    return resolved instanceof Error ? Promise.reject(resolved) : Promise.resolve(resolved);
  };

  const transport: CatalogTransport = {
    get: (path) => {
      calls.push({ method: 'GET', path });
      return answer(gets, path);
    },
    post: (path, body) => {
      calls.push({ method: 'POST', path, body });
      return answer(path in posts ? posts : gets, path);
    },
    patch: (path, body) => {
      calls.push({ method: 'PATCH', path, body });
      return answer(gets, path);
    },
    delete: (path) => {
      calls.push({ method: 'DELETE', path });
      return answer(gets, path);
    },
  };

  const postsTo = (path: string) =>
    calls.filter((call) => call.method === 'POST' && call.path === path);
  const lastPostTo = (path: string) => postsTo(path).at(-1);

  return { transport, calls, postsTo, lastPostTo };
}

function withCatalog(transport: CatalogTransport, children: ReactNode) {
  const queryClient = new QueryClient({
    // No retries: a refusal should reach the screen once, not four times over 30 seconds.
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>
      <CatalogProvider transport={transport}>{children}</CatalogProvider>
    </QueryClientProvider>
  );
}

/** A source wired straight into a sink, reading through nothing yet. */
function workflowReading(sourceKind: ConnectorKind): CatalogWorkflow {
  return {
    id: 'wf1',
    name: 'Fleet',
    enabled: true,
    version: 1,
    status: 'ready',
    graphHash: 'hash-1',
    targetType: 'Mvr',
    createdBy: 'someone',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    nodes: [
      {
        id: 'src_1',
        name: 'Feed',
        kind: 'source',
        sourceKind,
        config: {},
        position: { x: 0, y: 0 },
      },
      { id: 'snk_1', name: 'Out', kind: 'sink', targetType: 'Mvr', position: { x: 320, y: 0 } },
    ],
    edges: [{ from: 'src_1', to: 'snk_1' }],
  };
}

function connection(overrides: Partial<CatalogConnection> = {}): CatalogConnection {
  return {
    id: 'con_new',
    name: 'Fleet warehouse',
    kind: 'http',
    config: { url: 'https://api.example.mil/v1' },
    createdBy: 'someone',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
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

function answersFor(
  workflows: CatalogWorkflow[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    [WORKFLOWS]: workflows,
    '/pipeline/transforms': [],
    [CONNECTIONS]: [],
    '/pipeline/capabilities': {
      languages: ['javascript'],
      pythonPackages: [],
      durable: { available: true },
    },
    '/catalog': snapshot(),
    ...extra,
  };
}

/** Mount the canvas and open the source node's inspector from the wiring rail. */
async function openSourceInspector(transport: CatalogTransport) {
  render(withCatalog(transport, <WorkflowCanvas />));
  await screen.findAllByText('Feed');
  fireEvent.click(within(screen.getByLabelText('Workflow wiring and problems')).getByText('Feed'));
  await screen.findByRole('dialog');
}

/**
 * The inspector sheet, scoped.
 *
 * The node's Name field and the workflow's Name field carry the same label, so an unscoped
 * `getByLabelText('Name')` matches both. The sheet is a real dialog — Base UI's — and scoping to it
 * is also what stops a query reaching a control on the canvas behind a modal that has focus.
 */
function inspector() {
  return within(screen.getByRole('dialog'));
}

/**
 * The inline connection form, scoped by the group it names itself with.
 *
 * Scoping is not tidiness here. The inspector around it has a "Name" of its own, and — while the
 * node still carries its own address — a "URL" as well, so an unscoped `getByLabelText('URL')`
 * matches both and fails as "multiple elements", which reads like a duplicate-render bug rather
 * than an over-broad query.
 */
function form() {
  return within(screen.getByRole('group', { name: /New .+ connection/ }));
}

/** Open the inline form, whatever the button happens to be called for this kind. */
async function openForm(label: RegExp) {
  fireEvent.click(await inspector().findByText(label));
  await screen.findByRole('group', { name: /New .+ connection/ });
}

/**
 * Type into one of the inline form's fields.
 *
 * Anchored rather than exact: the `<label>` wraps the field's hint text too, so its full text is
 * the label followed by a paragraph, and an exact matcher finds nothing.
 */
function type(label: RegExp, value: string) {
  fireEvent.change(form().getByLabelText(label), { target: { value } });
}

function press(label: string) {
  fireEvent.click(form().getByText(label));
}

/** The Save button on the canvas, whose text alternates with the draft's dirtiness. */
function saveButton(): HTMLButtonElement {
  const button = screen.getByText(/^Saved?$/).closest('button');
  if (!(button instanceof HTMLButtonElement)) throw new Error('Save is not a button');
  return button;
}

function readRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return {};
  const record: Record<string, unknown> = {};
  for (const key of Object.keys(value)) record[key] = Reflect.get(value, key);
  return record;
}

/** The source node out of a saved graph, narrowed field by field rather than asserted. */
function readSourceNode(body: unknown): Record<string, unknown> {
  const nodes = readRecord(body).nodes;
  if (!Array.isArray(nodes)) return {};
  return nodes.map(readRecord).find((node) => node.kind === 'source') ?? {};
}

describe('the kinds this form is derived from', () => {
  it('covers every connector kind, so a sixth cannot arrive without a decision', () => {
    // The reason the record is keyed by ConnectorKind and written with `satisfies`. A kind added to
    // the vocabulary and not to the record fails the BUILD; this is the runtime half, which catches
    // the record having been widened to shut the compiler up.
    for (const kind of CONNECTOR_KINDS) {
      expect(CONNECTION_KINDS[kind]).toBeDefined();
    }
    expect(Object.keys(CONNECTION_KINDS).sort()).toEqual([...CONNECTOR_KINDS].sort());
  });

  it('offers a connection for exactly the kinds a source can read one through', () => {
    // Two questions that must have one answer: which kinds the picker is shown for, and which the
    // creator beside it can make. They were separate lists, and separate lists are how a "New
    // connection" button comes to be offered for a kind whose form has no fields under it.
    for (const kind of CONNECTOR_KINDS) {
      expect(usesConnection(kind)).toBe(CONNECTION_KINDS[kind].connectable);
    }
    expect([...CONNECTABLE_KINDS]).toEqual(['http', 'sql', 's3']);
  });

  it('says why, for the kinds that cannot have one', () => {
    // A gap where the offer would be reads as a screen that failed to render. The two refusals are
    // the same ones `ConnectionChecker.probe` makes: there is no address to share, so a "Test
    // connection" here would be a green tick that means nothing.
    for (const kind of ['file', 'inline'] as const) {
      const spec = CONNECTION_KINDS[kind];
      expect(spec.connectable).toBe(false);
      if (!spec.connectable) expect(spec.because.length).toBeGreaterThan(0);
    }
  });
});

describe('a source with no connection of its kind', () => {
  it('offers to make the first one instead of only saying there are none', async () => {
    // THE DETOUR THIS REMOVES: leave the canvas, open Connections, make one, come back, find the
    // node. The picker still says the list is empty — that is true and worth knowing — but the way
    // out is now beside it rather than on another tab.
    const { transport } = fakeTransport(answersFor([workflowReading('http')]));
    await openSourceInspector(transport);

    expect(inspector().getByText(/No connections of this kind yet/)).toBeDefined();
    expect(inspector().getByText('Make the first http connection')).toBeDefined();
  });

  it('asks for what THIS kind needs, and nothing from another', async () => {
    // Derived from the record per kind. An S3 connection needs a bucket and non-AWS addressing; it
    // has no URL, and a form offering one would invite an address the checker never reads.
    const { transport } = fakeTransport(answersFor([workflowReading('s3')]));
    await openSourceInspector(transport);
    await openForm(/Make the first s3 connection/);

    expect(form().getByLabelText(/^Bucket/)).toBeDefined();
    expect(form().getByLabelText(/^Endpoint/)).toBeDefined();
    expect(form().queryByLabelText(/^Connection URL/)).toBeNull();
  });

  it('does not offer to make one for a kind that cannot have one', async () => {
    // A file's path belongs to the load, not to a shared address, so neither the picker nor the
    // creator appears. The node still configures itself perfectly well.
    const { transport } = fakeTransport(answersFor([workflowReading('file')]));
    await openSourceInspector(transport);

    expect(inspector().queryByLabelText('Connection')).toBeNull();
    expect(inspector().queryByText(/Make the first/)).toBeNull();
    expect(inspector().getByLabelText(/^File path or URL/)).toBeDefined();
  });
});

describe('reaching the address before storing it', () => {
  it('tests what was typed, stores nothing, and sends no id', async () => {
    // `POST connections/check` exists because the field most likely to be wrong is the one nobody
    // can verify by reading it. The absent id is the load-bearing part: the server puts a STORED
    // credential back where a caller posted the redaction of one, and it can only do that for a row
    // it can look up — so a create must reach exactly the address that was typed.
    const { transport, lastPostTo, postsTo } = fakeTransport(
      answersFor([workflowReading('http')]),
      {
        [CHECK]: { ok: true, detail: 'https://api.example.mil/v1 answered 200.', elapsedMs: 12 },
      },
    );
    await openSourceInspector(transport);
    await openForm(/Make the first http connection/);

    type(/^URL/, 'https://api.example.mil/v1');
    press('Test connection');

    await waitFor(() => expect(lastPostTo(CHECK)).toBeDefined());
    const sent = readRecord(lastPostTo(CHECK)?.body);
    expect(sent.id).toBeUndefined();
    expect(sent.kind).toBe('http');
    expect(readRecord(sent.config).url).toBe('https://api.example.mil/v1');
    // Nothing was written. A connection saved to discover a typo is a row somebody has to remember
    // to delete, which is the whole reason this route is not "save, then check".
    expect(postsTo(CONNECTIONS)).toHaveLength(0);
    // And the checker's own sentence, not "OK" — that would prove only that a port is open.
    expect(await form().findByText(/answered 200/)).toBeDefined();
  });

  it('keeps the server’s words when the check fails, host and all', async () => {
    // A failed check comes back with the password, the query string and the fragment removed and
    // the host and the user kept, because which host refused and as whom is the entire value of it.
    // A screen that printed only "Could not reach it" would throw that away.
    const { transport } = fakeTransport(answersFor([workflowReading('http')]), {
      [CHECK]: {
        ok: false,
        detail: 'Could not reach it.',
        elapsedMs: 30,
        error: 'https://api.example.mil/v1 answered 401.',
      },
    });
    await openSourceInspector(transport);
    await openForm(/Make the first http connection/);

    type(/^URL/, 'https://api.example.mil/v1');
    press('Test connection');

    expect(await form().findByText(/answered 401/)).toBeDefined();
  });

  it('will not reach an address that is not there yet', async () => {
    // The address is what the button needs; the name is not. The gate is the kind's own
    // completeness rule, so an empty URL leaves it off and typing one turns it on.
    const { transport } = fakeTransport(answersFor([workflowReading('http')]));
    await openSourceInspector(transport);
    await openForm(/Make the first http connection/);

    const button = form().getByText('Test connection').closest('button');
    expect(button).toHaveProperty('disabled', true);

    type(/^URL/, 'https://api.example.mil/v1');
    expect(form().getByText('Test connection').closest('button')).toHaveProperty('disabled', false);
  });
});

describe('saving one from the node', () => {
  it('creates it, points the node at it, and says the graph now needs saving', async () => {
    // The whole feature in one test. The connection is a real object afterwards — other sources can
    // read through it — and the node reads through it without anybody going and selecting it.
    //
    // The last assertion is the one that must not be dropped: selecting it is a real edit, so the
    // draft is dirty, and `dirty` is what disables schema discovery in this very panel. Saying so
    // here is the difference between an explanation and a control that has silently gone quiet.
    let stored: CatalogConnection[] = [];
    const created = connection();
    const { transport, lastPostTo } = fakeTransport(
      answersFor([workflowReading('http')], { [CONNECTIONS]: () => stored }),
      {
        [CONNECTIONS]: () => {
          stored = [created];
          return created;
        },
      },
    );
    await openSourceInspector(transport);
    await openForm(/Make the first http connection/);

    type(/^Name/, 'Fleet warehouse');
    type(/^URL/, 'https://api.example.mil/v1');
    press('Save and use it');

    await waitFor(() => expect(lastPostTo(CONNECTIONS)).toBeDefined());
    const sent = readRecord(lastPostTo(CONNECTIONS)?.body);
    expect(sent.name).toBe('Fleet warehouse');
    expect(sent.kind).toBe('http');
    expect(readRecord(sent.config).url).toBe('https://api.example.mil/v1');

    // The picker above now shows it, rather than "Configure the address here" for a node that has
    // one. This is what the cache write is for — the refetch has not landed yet.
    await waitFor(() =>
      expect(inspector().getByLabelText('Connection').textContent).toContain('Fleet warehouse'),
    );
    expect(inspector().getByText(/now has unsaved edits/)).toBeDefined();
  });

  it('sends the connection on the node when the graph is saved', async () => {
    // The selection has to survive as far as the stored graph. A connection attached to a node the
    // save does not carry is a change somebody watched happen and would lose on the next reload.
    let stored: CatalogConnection[] = [];
    const created = connection();
    const { transport, lastPostTo } = fakeTransport(
      answersFor([workflowReading('http')], { [CONNECTIONS]: () => stored }),
      {
        [CONNECTIONS]: () => {
          stored = [created];
          return created;
        },
        [WORKFLOWS]: { ...workflowReading('http'), version: 2 },
      },
    );
    await openSourceInspector(transport);
    await openForm(/Make the first http connection/);

    type(/^Name/, 'Fleet warehouse');
    type(/^URL/, 'https://api.example.mil/v1');
    press('Save and use it');
    await waitFor(() => expect(lastPostTo(CONNECTIONS)).toBeDefined());

    fireEvent.click(inspector().getByLabelText('Close'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(saveButton());

    await waitFor(() => expect(lastPostTo(WORKFLOWS)).toBeDefined());
    expect(readSourceNode(lastPostTo(WORKFLOWS)?.body).connectionId).toBe('con_new');
  });
});

describe('the protections an inline form is where people drop', () => {
  it('prints the deployment’s refusal of a credential at rest, and attaches nothing', async () => {
    // `allowInlineCredentials` is off by default, and the store refuses a URL carrying a password
    // with a message naming the field to use instead. Printed verbatim, because a paraphrase drops
    // the field name — and the node must be left alone, or somebody walks away believing the
    // address is wired up.
    const refusal =
      'Connection "Fleet warehouse" carries a password inside config.url. A connection URL is the credential, and this column is read by anyone holding catalog:read — put the URL in an environment variable and name it in "Credential env var" instead, which is where every fetcher already looks first.';
    const { transport } = fakeTransport(answersFor([workflowReading('sql')]), {
      [CONNECTIONS]: new Error(refusal),
    });
    await openSourceInspector(transport);
    await openForm(/Make the first sql connection/);

    type(/^Name/, 'Fleet warehouse');
    type(/^Connection URL/, 'mysql://root:hunter2@db.internal:3306/app');
    press('Save and use it');

    expect(await form().findByText(/carries a password inside config.url/)).toBeDefined();
    // The named field survives the trip to the screen, which is the part a paraphrase would eat.
    expect(form().getByText(/Credential env var/)).toBeDefined();
    // Nothing was attached: the picker still says this source carries its own address.
    expect(inspector().getByLabelText('Connection').textContent).toContain(
      'Configure the address here',
    );
  });

  it('refuses to post the redaction placeholder as if it were the password', async () => {
    // The one case with NO server-side backstop. A read serves `mysql://root:REDACTED@…`, and the
    // server puts the real password back only for a connection it can look up — a create has no
    // stored row, so the same string arrives with nothing to restore it from and the word REDACTED
    // becomes the password. It saves cleanly and fails at the first scheduled load.
    const { transport, postsTo } = fakeTransport(answersFor([workflowReading('sql')]));
    await openSourceInspector(transport);
    await openForm(/Make the first sql connection/);

    type(/^Name/, 'Fleet warehouse');
    type(/^Connection URL/, 'mysql://root:REDACTED@db.internal:3306/app');
    press('Save and use it');

    expect(
      await form().findByText(/what this catalog shows in place of a stored password/),
    ).toBeDefined();
    // Refused HERE, before anything left the browser — there is nothing downstream that could
    // catch it.
    expect(postsTo(CONNECTIONS)).toHaveLength(0);
  });

  it('clears a stale check the moment the address is edited', async () => {
    // A green tick beside a URL nobody has tested is worse than no tick. The result belongs to the
    // address as it was when the button was pressed.
    const { transport } = fakeTransport(answersFor([workflowReading('http')]), {
      [CHECK]: { ok: true, detail: 'https://api.example.mil/v1 answered 200.', elapsedMs: 12 },
    });
    await openSourceInspector(transport);
    await openForm(/Make the first http connection/);

    type(/^URL/, 'https://api.example.mil/v1');
    press('Test connection');
    expect(await form().findByText(/answered 200/)).toBeDefined();

    type(/^URL/, 'https://api.example.mil/v2');

    await waitFor(() => expect(form().queryByText(/answered 200/)).toBeNull());
  });
});
