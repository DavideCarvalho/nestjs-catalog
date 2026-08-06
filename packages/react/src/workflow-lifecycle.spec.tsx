// @vitest-environment jsdom
//
// The docblock below must stay attached to the FIRST import in source order, and that import must
// be the one Biome's `organizeImports` would sort first — otherwise the sorter moves another
// import above this line, Vitest stops finding the environment hint, and every test here fails in
// `node` with `document is not defined`.
/**
 * What happens to a graph after it is drawn — and the three things that had nowhere to go.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `#connectors` and `#workflows` were two screens for one concept, and merging them meant the
 * canvas had to grow everything the connector screen was the only home for. Three of those are
 * not conveniences:
 *
 * **1. `expectShrink`.** A load that loses more rows than its type allows is refused, and the
 * previous snapshot keeps serving — because a broken `WHERE`, a source-side filter change and a
 * partial outage all look identical from here. The acknowledgement that stands that bound down for
 * ONE snapshot used to ride on `POST connectors/:id/run`, which is gone. If it is not reachable,
 * an operator's only remaining lever is `rowCount.maxShrink` in the type's policy — which turns
 * the guard off for every future load of that type, including the ones nobody is watching. So the
 * tests below assert it is reachable, that it will not be sent blank, and that an ordinary run
 * does not carry it.
 *
 * **2. Publishing.** A connector is what a published graph runs as. Without a publish control
 * nothing on this console can produce one at all, and every graph would be a draft that never
 * fires.
 *
 * **3. Adoption.** Thirteen connectors on the dev deployment were wrapped into graphs at boot and
 * published as `ready` without a person declaring them finished. An operator opening a pipeline
 * they never drew, marked ready, deserves to be told where it came from — so `createdBy` is read
 * and said out loud rather than left to be inferred from a description that is often absent.
 *
 * WHAT IS NOT ASSERTED
 * --------------------
 * Anything about geometry. jsdom does no layout, so every element is 0×0 and a test about position
 * would pass for the wrong reason. `toBeChecked` / `toBeDisabled` are NOT available either — this
 * repo registers no jest-dom setup and they throw rather than fail; `toHaveProperty('disabled',
 * true)` is the equivalent that works.
 */
import type {
  CatalogConnector,
  CatalogSnapshot,
  CatalogWorkflow,
  ConnectorRun,
} from '@dudousxd/nestjs-catalog/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { installCodeSurfaceDom } from '../../../test/jsdom-code-surface';
import { WorkflowCanvas } from './WorkflowCanvas';
import { CatalogProvider, type CatalogTransport } from './context';

installCodeSurfaceDom();

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** The measurement APIs React Flow and Base UI need. Same set as `workflow-canvas.spec.tsx`. */
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

interface Sent {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  body?: unknown;
}

function workflow(overrides: Partial<CatalogWorkflow> = {}): CatalogWorkflow {
  return {
    id: 'wf1',
    name: 'Fleet',
    enabled: true,
    version: 1,
    status: 'ready',
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
        sourceKind: 'http',
        config: {},
        position: { x: 0, y: 0 },
      },
      { id: 'snk_1', name: 'Out', kind: 'sink', targetType: 'Mvr', position: { x: 320, y: 0 } },
    ],
    edges: [{ from: 'src_1', to: 'snk_1' }],
    ...overrides,
  };
}

function connector(overrides: Partial<CatalogConnector> = {}): CatalogConnector {
  return {
    id: 'c1',
    name: 'Fleet',
    kind: 'http',
    targetType: 'Mvr',
    config: {},
    workflowId: 'wf1',
    enabled: true,
    createdBy: 'ana',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function run(overrides: Partial<ConnectorRun> = {}): ConnectorRun {
  return {
    id: 'run-1',
    connectorId: 'c1',
    snapshotId: 'snap-1',
    principalId: 'ana',
    status: 'succeeded',
    fetched: 10,
    written: 10,
    logs: [],
    startedAt: '2026-01-02T00:00:00.000Z',
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

/**
 * A transport that answers from a path→value map and records every write.
 *
 * Reads and writes share the map, which is safe here only because nothing below asks a path to
 * answer differently by method. `workflow-canvas.spec.tsx` splits them for the one place that
 * does — `GET /pipeline/workflows` lists and `POST` saves — and the note there says why.
 */
function fakeTransport(answers: Record<string, unknown>) {
  const sent: Sent[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: the seam under test is generic over its response.
  const answer = (path: string): Promise<any> => {
    if (!(path in answers)) return Promise.reject(new Error(`No fake answer for ${path}`));
    const value = answers[path];
    const resolved = typeof value === 'function' ? value() : value;
    return resolved instanceof Error ? Promise.reject(resolved) : Promise.resolve(resolved);
  };

  const transport: CatalogTransport = {
    get: (path) => answer(path),
    post: (path, body) => {
      sent.push({ method: 'POST', path, body });
      return answer(path);
    },
    put: (path, body) => {
      sent.push({ method: 'PUT', path, body });
      return answer(path);
    },
    patch: (path) => answer(path),
    delete: (path) => {
      sent.push({ method: 'DELETE', path });
      return answer(path);
    },
  };

  const lastTo = (path: string) => sent.filter((call) => call.path === path).at(-1);
  return { transport, sent, lastTo };
}

function answersFor(
  workflows: CatalogWorkflow[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    '/pipeline/workflows': workflows,
    '/pipeline/transforms': [],
    '/pipeline/connections': [],
    '/pipeline/connectors': [],
    '/pipeline/runs': [],
    '/pipeline/capabilities': {
      languages: ['javascript'],
      pythonPackages: [],
      durable: { available: true },
    },
    '/catalog': snapshot(),
    ...extra,
  };
}

function withCatalog(transport: CatalogTransport, children: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>
      <CatalogProvider transport={transport}>{children}</CatalogProvider>
    </QueryClientProvider>
  );
}

async function openCanvas(transport: CatalogTransport) {
  render(withCatalog(transport, <WorkflowCanvas />));
  await screen.findAllByText('Feed');
}

/** A panel of the rail beside the canvas, by its heading. */
function panel(heading: string) {
  const rail = within(screen.getByLabelText('Workflow wiring and problems'));
  const section = rail.getByText(heading).closest('section');
  if (!section) throw new Error(`No section around "${heading}"`);
  return within(section);
}

describe('a graph nobody drew', () => {
  it('says an adopted pipeline was adopted, rather than letting "ready" imply somebody agreed', async () => {
    // Adoption publishes a wrapped connector as `ready` at boot. "Ready" then means "it
    // validated", not "a person looked at it and said it was finished", and the difference is
    // invisible unless the screen says it.
    const { transport } = fakeTransport(
      answersFor([workflow({ createdBy: 'connector-adoption' })]),
    );
    await openCanvas(transport);

    expect(screen.getByText('adopted')).toBeTruthy();
    expect(screen.getByText(/was not drawn by anybody/)).toBeTruthy();
    expect(screen.getByText(/run history and incremental watermark carried over/)).toBeTruthy();
  });

  it('says nothing of the sort about a graph a person authored', async () => {
    // The badge has to be a signal, not decoration. Rendering it for everything would make the
    // one case it exists for unreadable.
    const { transport } = fakeTransport(answersFor([workflow()]));
    await openCanvas(transport);

    expect(screen.queryByText('adopted')).toBeNull();
    expect(screen.queryByText(/was not drawn by anybody/)).toBeNull();
  });
});

describe('declaring a graph finished', () => {
  it('publishes a draft on the route that mints its connector', async () => {
    // The list answers `draft` until the publish lands and `ready` afterwards, because publishing
    // invalidates it — a fixture that kept answering `draft` would refetch the old status over the
    // new one and this would be asserting the fake rather than the screen.
    let stored = workflow({ status: 'draft' });
    const { transport, lastTo } = fakeTransport(
      answersFor([], {
        '/pipeline/workflows': () => [stored],
        '/pipeline/workflows/wf1/publish': () => {
          stored = workflow({ status: 'ready' });
          return stored;
        },
      }),
    );
    await openCanvas(transport);

    fireEvent.click(screen.getByRole('button', { name: /^Publish$/ }));

    await waitFor(() => expect(lastTo('/pipeline/workflows/wf1/publish')).toBeDefined());
    // …and the status the screen shows comes from the answer, not from optimism.
    await waitFor(() => expect(screen.getByText('ready')).toBeTruthy());
  });

  it('prints the server refusal rather than a generic failure', async () => {
    // The server knows which types exist and who may write to them. Its sentence names the node
    // to go and fix; "could not publish" names nothing.
    const { transport } = fakeTransport(
      answersFor([workflow({ status: 'draft' })], {
        '/pipeline/workflows/wf1/publish': new Error(
          'Sink "Out" commits Mvr, which you may not write.',
        ),
      }),
    );
    await openCanvas(transport);

    fireEvent.click(screen.getByRole('button', { name: /^Publish$/ }));

    expect(await screen.findByText(/which you may not write/)).toBeTruthy();
  });

  it('will not publish what is on screen while it differs from what is stored', async () => {
    // Publishing validates the STORED graph. Pressed with unsaved edits it would report on a
    // shape nobody is looking at — and succeed on it.
    const { transport } = fakeTransport(answersFor([workflow({ status: 'draft' })]));
    await openCanvas(transport);

    // Renaming, rather than adding a node: adding one opens its inspector, which is a modal, and
    // Base UI hides the rest of the document from the accessibility tree while it is open — so
    // the button under test would be unfindable for a reason that has nothing to do with this.
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Fleet readiness' } });

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Publish$/ })).toHaveProperty('disabled', true),
    );
  });

  it('takes a ready graph back to draft only after saying what that stops', async () => {
    const { transport, lastTo } = fakeTransport(
      answersFor([workflow()], {
        '/pipeline/workflows/wf1/unpublish': workflow({ status: 'draft' }),
      }),
    );
    await openCanvas(transport);

    fireEvent.click(screen.getByRole('button', { name: /^Unpublish$/ }));

    // Nothing has been sent yet: the id, the history and the watermark surviving is the fact
    // somebody needs before they agree, not after.
    expect(lastTo('/pipeline/workflows/wf1/unpublish')).toBeUndefined();
    expect(
      await screen.findByText(/the run history and the incremental watermark stay/),
    ).toBeTruthy();

    // The dialog's own action, which is the second of two buttons reading "Unpublish" — the
    // first is the one that opened it, and it is behind the modal now.
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.click(dialog.getByRole('button', { name: /Unpublish/ }));
    await waitFor(() => expect(lastTo('/pipeline/workflows/wf1/unpublish')).toBeDefined());
  });
});

describe('re-driving a load the row-count bound refused', () => {
  it('sends nothing about a shrink on an ordinary run', async () => {
    // ABSENT is a third state and not a synonym for false: the server reads a body with no such
    // key as "nobody said anything, let the bound decide". A console that always sent the field
    // would turn every run into an acknowledgement with no reason, which is a 400.
    const { transport, lastTo } = fakeTransport(
      answersFor([workflow()], {
        '/pipeline/workflows/wf1/run': {
          id: 'r1',
          workflowId: 'wf1',
          snapshotId: 'snap-2',
          status: 'succeeded',
          durable: true,
          nodes: [],
          startedAt: '2026-01-03T00:00:00.000Z',
        },
      }),
    );
    await openCanvas(transport);

    fireEvent.click(screen.getByRole('button', { name: /^Run$/ }));

    await waitFor(() => expect(lastTo('/pipeline/workflows/wf1/run')).toBeDefined());
    expect(lastTo('/pipeline/workflows/wf1/run')?.body).toEqual({});
  });

  it('will not submit an acknowledgement with no reason behind it', async () => {
    // The reason is written into the snapshot's labels and is the only answer anybody will have
    // in six months to "why was this load allowed to collapse?". The server refuses a blank one
    // with a 400; refusing it here means the round trip is never spent on a request that cannot
    // succeed, and the reader is told what the box is for while it is still empty.
    const { transport } = fakeTransport(answersFor([workflow()]));
    await openCanvas(transport);

    fireEvent.click(
      screen.getByLabelText('Run, acknowledging that this load is expected to lose rows'),
    );

    const confirm = await screen.findByRole('button', { name: 'Run with this reason' });
    expect(confirm).toHaveProperty('disabled', true);
    expect(screen.getByText(/A blank reason is refused/)).toBeTruthy();
  });

  it('carries the reason to the one route that still accepts it', async () => {
    const { transport, lastTo } = fakeTransport(
      answersFor([workflow()], {
        '/pipeline/workflows/wf1/run': {
          id: 'r2',
          workflowId: 'wf1',
          snapshotId: 'snap-3',
          status: 'succeeded',
          durable: true,
          nodes: [],
          startedAt: '2026-01-03T00:00:00.000Z',
        },
      }),
    );
    await openCanvas(transport);

    fireEvent.click(
      screen.getByLabelText('Run, acknowledging that this load is expected to lose rows'),
    );
    fireEvent.change(await screen.findByLabelText(/Why is this load expected to lose rows/), {
      target: { value: 'Hurlburt left the feed on the 3rd.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run with this reason' }));

    await waitFor(() => expect(lastTo('/pipeline/workflows/wf1/run')).toBeDefined());
    expect(lastTo('/pipeline/workflows/wf1/run')?.body).toEqual({
      expectShrink: 'Hurlburt left the feed on the 3rd.',
    });
  });

  it('offers the way through from the refusal itself, where somebody is actually reading', async () => {
    // The lever an operator reaches for otherwise is `rowCount.maxShrink` in the type's policy,
    // which stands the bound down for every load of that type from then on. Putting the one-shot
    // acknowledgement in front of them at the moment of the refusal is what makes the wrong lever
    // the less obvious one.
    const refusal =
      'Snapshot snap-4 of Mvr holds 40 rows where snap-1 holds 4000: a loss of 99%, past the 50% ' +
      'this type allows in one load. If the load is right, set "_expectShrink" in its labels or ' +
      'raise rowCount.maxShrink for Mvr.';
    const { transport } = fakeTransport(
      answersFor([workflow()], {
        '/pipeline/workflows/wf1/run': {
          id: 'r3',
          workflowId: 'wf1',
          snapshotId: 'snap-4',
          status: 'failed',
          durable: true,
          nodes: [{ nodeId: 'snk_1', status: 'failed', error: refusal }],
          startedAt: '2026-01-03T00:00:00.000Z',
        },
      }),
    );
    await openCanvas(transport);

    fireEvent.click(screen.getByRole('button', { name: /^Run$/ }));

    const again = await screen.findByRole('button', { name: /Re-run, acknowledging the shrink/ });
    expect(screen.getByText(/past the 50% this type allows/)).toBeTruthy();

    fireEvent.click(again);
    // The same dialog, so there is one description of what an acknowledgement is rather than two.
    expect(await screen.findByLabelText(/Why is this load expected to lose rows/)).toBeTruthy();
  });
});

describe('when a graph runs on its own', () => {
  it('PUTs the cron and the enabled flag on the schedule route', async () => {
    // Its own write, not fields folded into the save a canvas performs on every drag: a cron that
    // rides along with an autosave is one a stale tab can silently revert.
    const { transport, lastTo } = fakeTransport(
      answersFor([workflow()], {
        '/pipeline/workflows/wf1/schedule': {
          ...workflow({ schedule: '0 3 * * *' }),
          warning: null,
        },
      }),
    );
    await openCanvas(transport);

    fireEvent.change(panel('Schedule').getByLabelText(/^Cron/), {
      target: { value: '0 3 * * *' },
    });
    fireEvent.click(panel('Schedule').getByRole('button', { name: /Save schedule/ }));

    await waitFor(() => expect(lastTo('/pipeline/workflows/wf1/schedule')).toBeDefined());
    expect(lastTo('/pipeline/workflows/wf1/schedule')?.body).toEqual({
      schedule: '0 3 * * *',
      enabled: true,
    });
  });

  it('prints the server warning that a stored schedule will never fire', async () => {
    // The incident behind this route: a scheduler that logged it was watching schedules every 30
    // seconds while parsing nothing. Every way a cron can be stored and not fire is named by the
    // server, and a screen that dropped the sentence would reproduce the silence exactly.
    const { transport } = fakeTransport(
      answersFor([workflow()], {
        '/pipeline/workflows/wf1/schedule': {
          ...workflow({ schedule: 'every tuesday' }),
          warning:
            'Workflow "Fleet" has a schedule of "every tuesday", which is not a cron this scheduler can parse, so it will never fire.',
        },
      }),
    );
    await openCanvas(transport);

    fireEvent.change(panel('Schedule').getByLabelText(/^Cron/), {
      target: { value: 'every tuesday' },
    });
    fireEvent.click(panel('Schedule').getByRole('button', { name: /Save schedule/ }));

    expect(await screen.findByText(/which is not a cron this scheduler can parse/)).toBeTruthy();
  });

  it('says a draft will not fire before anybody types a cron into it', async () => {
    const { transport } = fakeTransport(answersFor([workflow({ status: 'draft' })]));
    await openCanvas(transport);

    expect(
      panel('Schedule').getByText(/nothing here will fire whatever the cron says/),
    ).toBeTruthy();
  });
});

describe('what a published graph runs as', () => {
  it('names the connector the run history is keyed on, without printing its config', async () => {
    // The read that survived. A connector is not authored any more, but its id is what
    // `GET runs?connector=` is keyed on and what an operator greps a log for — and its config is
    // deliberately absent, because the server redacts a URL password on the way out and a screen
    // that rendered `REDACTED` beside a real host would teach people this console shows
    // credentials.
    const { transport } = fakeTransport(
      answersFor([workflow()], {
        '/pipeline/connectors': [
          connector({ config: { url: 'https://svc:REDACTED@vendor.test' } }),
        ],
        '/pipeline/runs': [run({ transformVersion: 3 })],
      }),
    );
    await openCanvas(transport);

    const runsAs = panel('Runs as');
    await waitFor(() => expect(runsAs.getByText('c1')).toBeTruthy());
    await waitFor(() => expect(runsAs.getByText('snap-1')).toBeTruthy());
    expect(runsAs.getByText('10 fetched · 10 written')).toBeTruthy();
    expect(screen.queryByText(/REDACTED/)).toBeNull();
    expect(screen.queryByText(/vendor\.test/)).toBeNull();
  });

  it('says a draft has nothing behind it yet, and what would give it one', async () => {
    // Not an empty panel and not a missing one. "No runs" and "nothing has ever been published"
    // are different facts, and only the second tells somebody which button to press.
    const { transport } = fakeTransport(answersFor([workflow({ status: 'draft' })]));
    await openCanvas(transport);

    await waitFor(() =>
      expect(panel('Runs as').getByText(/Publishing is what mints the connector/)).toBeTruthy(),
    );
  });

  it('offers no connector create, delete or run of its own', async () => {
    // The routes are gone. A control here would 404, and one that quietly did nothing would be
    // worse — the whole point of merging the two screens is that there is one place a pipeline is
    // acted on, and it is the graph.
    const { transport } = fakeTransport(
      answersFor([workflow()], {
        '/pipeline/connectors': [connector()],
        '/pipeline/runs': [run()],
      }),
    );
    await openCanvas(transport);

    const runsAs = panel('Runs as');
    await waitFor(() => expect(runsAs.getByText('c1')).toBeTruthy());
    await waitFor(() => expect(runsAs.getByText('snap-1')).toBeTruthy());
    expect(runsAs.queryByRole('button', { name: /New connector/ })).toBeNull();
    expect(runsAs.queryByRole('button', { name: /Run now/ })).toBeNull();
    expect(runsAs.queryByRole('button', { name: /Delete/ })).toBeNull();
    // …and it says so, rather than leaving somebody who remembers the old card
    // hunting for controls that are simply absent.
    expect(runsAs.getByText(/Running, scheduling and deleting are all done on the/)).toBeTruthy();
  });
});
