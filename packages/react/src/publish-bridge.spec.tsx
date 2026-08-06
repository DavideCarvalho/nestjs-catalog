// @vitest-environment jsdom
//
// The docblock below must stay attached to the FIRST import in source order, and that import must
// be the one Biome's `organizeImports` would sort first — otherwise the sorter moves another
// import above this line, Vitest stops finding the environment hint, and every test here fails in
// `node` with `document is not defined`.
/**
 * The calls that moved when the connector stopped being an authored object.
 *
 * Five methods on `CatalogClient` addressed routes that no longer exist —
 * `saveConnector`, `deleteConnector`, `runConnector`, `discoverConnectorSchema`
 * and `connectionConnectors` — and every one of them would have 404'd. Three of
 * them had somewhere to go and this file pins where: discovery is per source
 * NODE now, the acknowledgement that lets a shrinking load past the row-count
 * bound rides on the workflow run, and "who reads through this connection" is a
 * question about pipelines.
 *
 * Asserting the path by shape rather than by "post was called" is deliberate:
 * the two ends are in different packages and nothing else would notice them
 * drifting apart. A wrong path is a 404 at run time with no compile error and
 * nothing on screen but an empty list.
 *
 * Publishing a type is the only write here that does not go through the
 * catalog's own routes, and it is a `PUT` because it is an idempotent upsert of
 * a whole shape. The transport predates that, so `put` is optional — which makes
 * the refusal path worth pinning: a button that resolves without creating
 * anything is exactly the failure the panel exists to prevent.
 */
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { CatalogProvider, type CatalogTransport, useCatalogClient } from './context';

function clientOver(transport: Partial<CatalogTransport>) {
  const full: CatalogTransport = {
    get: vi.fn(),
    post: vi.fn().mockResolvedValue({}),
    patch: vi.fn(),
    delete: vi.fn(),
    ...transport,
  };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <CatalogProvider transport={full}>{children}</CatalogProvider>
  );
  const { result } = renderHook(() => useCatalogClient(), { wrapper });
  return { client: result.current, transport: full };
}

describe('discovering a source schema', () => {
  it('asks about one source node of one graph, on the route the server serves', async () => {
    const { client, transport } = clientOver({});

    await client.discoverSourceSchema('wf 1', 'src/1');

    expect(transport.post).toHaveBeenCalledWith(
      '/pipeline/workflows/wf%201/nodes/src%2F1/discover',
      {},
    );
  });

  it('carries no method that would address a removed connector route', () => {
    // The five the server took away. Left on the client, each one is a button
    // somewhere that 404s — or, worse, a call somebody wraps in a `catch` and
    // turns into silence. Read off a widened record rather than named directly,
    // because naming one no longer compiles and this has to survive a client
    // whose object still carries a key its interface has stopped declaring.
    const { client } = clientOver({});
    const widened: Record<string, unknown> = { ...client };

    for (const gone of [
      'saveConnector',
      'deleteConnector',
      'runConnector',
      'discoverConnectorSchema',
      'connectionConnectors',
    ]) {
      expect(widened[gone]).toBeUndefined();
    }
  });
});

describe('what a connection is holding up', () => {
  it('asks which pipelines read through it, not which connectors', async () => {
    // The rename is the question actually being asked. An operator presses this
    // before deleting a connection and needs the list of things that would
    // break, which is a list of graphs — a connector's name is an
    // implementation detail of one and names no screen anybody can open.
    const { client, transport } = clientOver({ get: vi.fn().mockResolvedValue([]) });

    await client.connectionWorkflows('c 1');

    expect(transport.get).toHaveBeenCalledWith('/pipeline/connections/c%201/workflows');
  });
});

describe('running a workflow', () => {
  it('posts an empty body when nobody said anything about the load', async () => {
    // `expectShrink` ABSENT is a third state, not a synonym for false: the
    // server reads a body with no such key as "nobody said anything, let the
    // bound decide", and a client that always sent the field would turn every
    // ordinary run into one carrying an empty acknowledgement — which is
    // refused with a 400.
    const { client, transport } = clientOver({});

    await client.runWorkflow('w1');

    expect(transport.post).toHaveBeenCalledWith('/pipeline/workflows/w1/run', {});
  });

  it('carries the reason when somebody acknowledged a shrink', async () => {
    // THE method that had to survive. `POST connectors/:id/run` is gone, and it
    // was the only place this could be said — without it an operator's recourse
    // for a refused load is raising `rowCount.maxShrink` in the type's policy,
    // which stands the guard down for every future load of that type rather
    // than for the one snapshot in front of them.
    const { client, transport } = clientOver({});

    await client.runWorkflow('w1', { expectShrink: 'Hurlburt left the feed on the 3rd.' });

    expect(transport.post).toHaveBeenCalledWith('/pipeline/workflows/w1/run', {
      expectShrink: 'Hurlburt left the feed on the 3rd.',
    });
  });

  it('does not send a snapshot id nobody asked for', async () => {
    const { client, transport } = clientOver({});

    await client.runWorkflow('w1', { snapshotId: 's-7' });

    expect(transport.post).toHaveBeenCalledWith('/pipeline/workflows/w1/run', {
      snapshotId: 's-7',
    });
  });
});

describe('publishing and scheduling a graph', () => {
  it('publishes and unpublishes on their own routes', async () => {
    const { client, transport } = clientOver({});

    await client.publishWorkflow('w1');
    await client.unpublishWorkflow('w1');

    expect(transport.post).toHaveBeenCalledWith('/pipeline/workflows/w1/publish', {});
    expect(transport.post).toHaveBeenCalledWith('/pipeline/workflows/w1/unpublish', {});
  });

  it('PUTs a schedule, and refuses by name when the transport cannot', () => {
    // Same shape as `publishType` below: `put` is optional so a transport
    // written before it keeps compiling, and a screen handed one has to hear
    // that rather than watch a cron silently not be stored.
    const put = vi.fn().mockResolvedValue({});
    const { client } = clientOver({ put });

    client.scheduleWorkflow('w1', { schedule: '0 3 * * *', enabled: true });

    expect(put).toHaveBeenCalledWith('/pipeline/workflows/w1/schedule', {
      schedule: '0 3 * * *',
      enabled: true,
    });

    const { client: cannot } = clientOver({});
    expect(() => cannot.scheduleWorkflow('w1', { enabled: false })).toThrow(/cannot PUT/);
  });
});

describe('publishing a type', () => {
  it('PUTs the schema to the publish route, under the type name', async () => {
    const put = vi.fn().mockResolvedValue({});
    const { client } = clientOver({ put });

    await client.publishType('Mvr', { displayName: 'MVR', properties: [] });

    expect(put).toHaveBeenCalledWith('/publish/Mvr/schema', {
      displayName: 'MVR',
      properties: [],
    });
  });

  it('escapes a name that would otherwise change the path', () => {
    const put = vi.fn().mockResolvedValue({});
    const { client } = clientOver({ put });

    client.publishType('a/b', {});

    expect(put).toHaveBeenCalledWith('/publish/a%2Fb/schema', {});
  });

  it('refuses by name when the transport cannot PUT', () => {
    // THE case. `put` is optional so transports written before this keep
    // compiling — which means the console can be handed one that cannot
    // publish. Resolving quietly there would leave somebody pressing "Create
    // type" and reading an empty catalog, with nothing anywhere saying why.
    const { client } = clientOver({});

    expect(() => client.publishType('Mvr', {})).toThrow(/cannot PUT/);
  });

  it('does not reach for any other verb when PUT is missing', () => {
    // Falling back to `post` would hit a route that does not exist and turn a
    // legible refusal into a 404 from somebody else's server.
    const { client, transport } = clientOver({});

    expect(() => client.publishType('Mvr', {})).toThrow();
    expect(transport.post).not.toHaveBeenCalled();
    expect(transport.patch).not.toHaveBeenCalled();
  });
});
