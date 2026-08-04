// @vitest-environment jsdom
//
// The docblock below must stay attached to the FIRST import in source order, and that import must
// be the one Biome's `organizeImports` would sort first — otherwise the sorter moves another
// import above this line, Vitest stops finding the environment hint, and every test here fails in
// `node` with `document is not defined`.
/**
 * That the two screens show the links, from both ends.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A type carries one row per link it DECLARES, which is the honest shape and half the truth:
 * `@ManyToOne(() => Base)` on `Mvr` leaves `Base` with an empty relations list, and the catalog
 * screen said in as many words that nothing linked to or from it. Base is one of the most
 * linked-to types in any fleet schema. The inbound half is derived here from the snapshot the
 * screen already holds, and derived is what it stays — nothing about it is stored or counted.
 *
 * The other two failures were quieter. A link whose target this catalog does not hold rendered as
 * an ordinary button, and clicking it selected whichever type happened to be first — so a missing
 * type looked like a working link to the wrong place. And a link could not be renamed from the one
 * screen that lists links, because the control was a single button that navigated.
 *
 * `FlowView` gets the half that belongs to it: a link that crosses a publisher boundary. A lane
 * says how a load has been going; it cannot say whether the load is useful, and rows pointing at a
 * type nobody has loaded join to nothing while every timestamp on the screen stays green.
 */
import type {
  CatalogAuditEvent,
  CatalogObjectTypeDef,
  CatalogSnapshot,
} from '@dudousxd/nestjs-catalog/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { CatalogManager } from './CatalogManager';
import { FlowView } from './FlowView';
import { CatalogProvider, type CatalogTransport } from './context';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

function fakeTransport(answers: Record<string, unknown>) {
  const calls: Call[] = [];
  // The suppression has to be the line immediately above, so the reason goes here: `CatalogTransport`
  // is generic on its response and a fixture map cannot be, and this is what lets the fake satisfy it
  // without an assertion. Same seam, same reason, as `screens.spec.tsx`.
  // biome-ignore lint/suspicious/noExplicitAny: see above.
  const answer = (path: string): Promise<any> =>
    path in answers
      ? Promise.resolve(answers[path])
      : Promise.reject(new Error(`No fake answer for ${path}`));

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
  return { transport, calls };
}

function withCatalog(transport: CatalogTransport, children: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <CatalogProvider transport={transport}>{children}</CatalogProvider>
    </QueryClientProvider>
  );
}

type Relation = CatalogObjectTypeDef['relations'][number];

function relation(overrides: Partial<Relation> & Pick<Relation, 'name'>): Relation {
  return {
    displayName: overrides.name,
    kind: 'm:1',
    targetType: 'Base',
    nullable: true,
    hidden: false,
    order: 0,
    owner: true,
    targetPublished: true,
    enriched: false,
    ...overrides,
  };
}

function objectType(overrides: Partial<CatalogObjectTypeDef> = {}): CatalogObjectTypeDef {
  return {
    name: 'Mvr',
    displayName: 'Vehicle',
    pluralDisplayName: 'Vehicles',
    tableName: 'mvr',
    group: 'Fleet',
    primaryKey: ['id'],
    enriched: true,
    properties: [],
    relations: [],
    ...overrides,
  };
}

function snapshot(types: CatalogObjectTypeDef[]): CatalogSnapshot {
  return {
    version: 3,
    generatedAt: '2026-01-01T00:00:00.000Z',
    stats: {
      types: types.length,
      properties: types.reduce((n, t) => n + t.properties.length, 0),
      relations: types.reduce((n, t) => n + t.relations.length, 0),
      enrichedTypes: types.filter((t) => t.enriched).length,
    },
    types,
  };
}

/** `Base` and `Mvr`, with one foreign key from the vehicle to the base. */
function fleet(overrides: { linked?: boolean; targetPublished?: boolean } = {}) {
  const mvr = objectType({
    relations: [
      relation({
        name: 'base',
        displayName: 'Home base',
        localKey: 'base_id',
        ...(overrides.linked ? { inverseName: 'mvrs' } : {}),
        ...(overrides.targetPublished === false ? { targetPublished: false } : {}),
      }),
    ],
  });
  const base = objectType({
    name: 'Base',
    displayName: 'Installation',
    pluralDisplayName: 'Installations',
    tableName: 'base',
    relations: overrides.linked
      ? [
          relation({
            name: 'mvrs',
            displayName: 'Vehicles here',
            kind: '1:m',
            targetType: 'Mvr',
            owner: false,
            inverseName: 'base',
          }),
        ]
      : [],
  });
  return overrides.targetPublished === false ? [mvr] : [base, mvr];
}

/** The detail pane, which is where the links live. Scoped, because type names appear in the list too. */
async function detail() {
  return within(await screen.findByRole('main'));
}

/** Select a type in the sidebar by its display name. */
async function open(displayName: string) {
  const list = within(await screen.findByRole('navigation'));
  fireEvent.click(list.getByText(displayName));
}

describe('the links on a type', () => {
  it('lists what this type points at, by the target’s display name', async () => {
    // `Base` is what the code calls it; `Installation` is what a person does, and the whole point
    // of the catalog is that the second one is what a screen shows.
    const { transport } = fakeTransport({ '/catalog': snapshot(fleet()) });
    render(withCatalog(transport, <CatalogManager />));
    await open('Vehicle');

    const pane = await detail();
    expect(pane.getByText('Vehicle points at')).toBeDefined();
    expect(pane.getByText('Installation')).toBeDefined();
    // The join column, so somebody can go and check the link in the database.
    expect(pane.getByText(/base · base_id/)).toBeDefined();
  });

  it('shows what points AT a type, which nothing on the type records', async () => {
    // THE case. Only `Mvr` declares this link, so `Base.relations` is empty and this screen used
    // to report that nothing linked to or from one of the most linked-to types there is.
    const { transport } = fakeTransport({ '/catalog': snapshot(fleet()) });
    render(withCatalog(transport, <CatalogManager />));
    await open('Installation');

    const pane = await detail();
    expect(pane.getByText('Points at Installation')).toBeDefined();
    expect(pane.getByText('m:1 · Mvr.base')).toBeDefined();
    expect(pane.queryByText(/Nothing links to or from/)).toBeNull();
  });

  it('opens the type an inbound link comes from', async () => {
    // Found by mutation: the two headings were asserted but not the one thing
    // they are for. Following a link back to whatever points at you is the move
    // this section exists to make possible — an inbound entry that renders and
    // does nothing is a worse screen than one that renders nothing.
    const { transport } = fakeTransport({ '/catalog': snapshot(fleet()) });
    render(withCatalog(transport, <CatalogManager />));

    fireEvent.click((await detail()).getByRole('button', { name: /Mvr\.base/ }));

    expect((await detail()).getByText('Vehicle points at')).toBeDefined();
  });

  it('does not list a link declared at both ends twice', async () => {
    // Two rows, one foreign key. Showing `Base.mvrs` under "points at" and `Mvr.base` under
    // "points at Installation" would say there are two links between these types.
    const { transport } = fakeTransport({ '/catalog': snapshot(fleet({ linked: true })) });
    render(withCatalog(transport, <CatalogManager />));
    await open('Installation');

    const pane = await detail();
    expect(pane.getByText('Vehicles here')).toBeDefined();
    expect(pane.queryByText('Points at Installation')).toBeNull();
  });

  it('lists a link a type has to itself once, not twice', async () => {
    // Found by mutation: nothing else here covers a self-reference, so a build
    // that dropped the "same type" guard passed every other test. A parent
    // pointer is one of the most common links in any hierarchy, and it is
    // genuinely both outbound and inbound — listing it under both headings says
    // a type is linked to itself twice.
    const { transport } = fakeTransport({
      '/catalog': snapshot([
        objectType({
          name: 'Unit',
          displayName: 'Unit',
          pluralDisplayName: 'Units',
          tableName: 'unit',
          relations: [relation({ name: 'parent', displayName: 'Parent unit', targetType: 'Unit' })],
        }),
      ]),
    });
    render(withCatalog(transport, <CatalogManager />));

    const pane = await detail();
    expect(pane.getByText('Unit points at')).toBeDefined();
    expect(pane.queryByText('Points at Unit')).toBeNull();
  });

  it('still says so when there is genuinely nothing', async () => {
    const { transport } = fakeTransport({ '/catalog': snapshot([objectType()]) });
    render(withCatalog(transport, <CatalogManager />));

    expect(await screen.findByText(/Nothing links to or from Vehicle yet/)).toBeDefined();
  });
});

describe('a link whose target this catalog does not hold', () => {
  it('marks it and refuses to navigate', async () => {
    // It used to render as an ordinary button pointing at a type that is not in the list, so
    // clicking it silently selected whichever type happened to be first — a missing type looked
    // exactly like a working link to the wrong place.
    const { transport } = fakeTransport({
      '/catalog': snapshot(fleet({ targetPublished: false })),
    });
    render(withCatalog(transport, <CatalogManager />));

    const pane = await detail();
    // Present, because the foreign key is real and its target being out of reach is the useful
    // fact — but as text, not as something to press.
    expect(pane.getByText('Base')).toBeDefined();
    expect(pane.queryByRole('button', { name: 'Base' })).toBeNull();
  });

  it('navigates when the target IS held', async () => {
    // The other side of the same switch, so a change that made every link inert passes nothing.
    const { transport } = fakeTransport({ '/catalog': snapshot(fleet()) });
    render(withCatalog(transport, <CatalogManager />));
    await open('Vehicle');

    fireEvent.click((await detail()).getByRole('button', { name: 'Installation' }));

    expect((await detail()).getByText('Points at Installation')).toBeDefined();
  });
});

describe('renaming a link', () => {
  it('patches it through the property route', async () => {
    // No new endpoint: a relation is a property to whoever is looking, and the console does not
    // have to know which `base` is before it can pick a URL.
    const patched = objectType({
      relations: [relation({ name: 'base', displayName: 'Assigned base', localKey: 'base_id' })],
    });
    const { transport, calls } = fakeTransport({
      '/catalog': snapshot(fleet()),
      '/catalog/types/Mvr/properties/base': patched,
    });
    render(withCatalog(transport, <CatalogManager />));
    await open('Vehicle');

    fireEvent.click((await detail()).getByLabelText('Edit label for base'));
    const input = (await detail()).getByLabelText('label for base');
    fireEvent.change(input, { target: { value: 'Assigned base' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(calls.at(-1)).toEqual({
        method: 'PATCH',
        path: '/catalog/types/Mvr/properties/base',
        body: { displayName: 'Assigned base' },
      }),
    );
  });
});

/** An audit event, as the flow screen reads them. */
function event(overrides: Partial<CatalogAuditEvent> & Pick<CatalogAuditEvent, 'id'>) {
  return {
    event: 'snapshot.committed',
    typeName: 'Mvr',
    principalId: 'flip-nestjs',
    snapshotId: `s-${overrides.id}`,
    detail: { rowCount: 10 },
    occurredAt: '2026-08-01T09:00:00.000Z',
    ...overrides,
  } satisfies CatalogAuditEvent;
}

describe('the flow screen’s view of a link', () => {
  it('names the publisher a type depends on', async () => {
    // The failure it exists for: MVR rows can be loaded before the bases they point at, and the
    // join then comes back empty rather than failing. Every timestamp on this screen stays green
    // while it happens.
    const types = fleet();
    types[0] = { ...(types[0] as CatalogObjectTypeDef), lastPrincipalId: 'base-loader' };
    types[1] = { ...(types[1] as CatalogObjectTypeDef), lastPrincipalId: 'flip-nestjs' };
    const { transport } = fakeTransport({
      '/catalog': snapshot(types),
      '/catalog/events': [event({ id: '1' })],
    });

    render(withCatalog(transport, <FlowView />));

    expect(await screen.findByText('Installation · base-loader')).toBeDefined();
  });

  it('says when nothing has ever loaded the other end', async () => {
    // A different fact with a different fix, so it is reported separately rather than folded into
    // "somebody else loads it".
    const { transport } = fakeTransport({
      '/catalog': snapshot(fleet()),
      '/catalog/events': [event({ id: '1' })],
    });

    render(withCatalog(transport, <FlowView />));

    expect(await screen.findByText('Installation · nobody')).toBeDefined();
  });

  it('stays quiet about a link the same publisher feeds', async () => {
    // A type pointing at another type the same application loads is that application's own
    // ordering problem and it can already see it. Flagging it would bury the ones nobody owns.
    const types = fleet().map((type) => ({ ...type, lastPrincipalId: 'flip-nestjs' }));
    const { transport } = fakeTransport({
      '/catalog': snapshot(types),
      '/catalog/events': [event({ id: '1' })],
    });

    render(withCatalog(transport, <FlowView />));

    await screen.findByText('flip-nestjs');
    expect(screen.queryByText(/Installation ·/)).toBeNull();
    expect(screen.queryByText('needs')).toBeNull();
  });
});
