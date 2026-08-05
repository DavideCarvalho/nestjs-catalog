/**
 * The paths behind the pipeline and access screens.
 *
 * Unlike `catalogRoutes`, these describe endpoints this library does NOT serve — the host mounts
 * them wherever it likes and tells the provider where. That makes the builder the single place a
 * mistake can be made, and the mistake is always silent: a wrong path is a 404 at runtime, with no
 * compile error and nothing on screen but an empty list.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ACCESS_BASE_PATH,
  DEFAULT_PIPELINE_BASE_PATH,
  accessRoutes,
  embedRoutes,
  pipelineRoutes,
} from './routes';

describe('embedRoutes', () => {
  it('matches the paths the catalog controller actually serves', () => {
    // Unlike everything else in this file these ARE library-served — `@Get('embed')`,
    // `@Get('embed/charts/:id')` and `@Get('embed/dashboards/:id')` on the catalog controller,
    // behind `catalog:embed`. A wrong path here is a 404 that reads as "this chart was never
    // shared", which sends whoever is debugging it into the sharing settings instead.
    expect(embedRoutes.embeddable()).toBe('/catalog/embed');
    expect(embedRoutes.chart('q1')).toBe('/catalog/embed/charts/q1');
    expect(embedRoutes.dashboard('d1')).toBe('/catalog/embed/dashboards/d1');
  });

  it('escapes an id into its own segment', () => {
    // Saved query ids are server-generated today, but the builder is what stands between an id
    // holding a slash and a request to an endpoint nobody meant to call.
    expect(embedRoutes.chart('a/b')).toBe('/catalog/embed/charts/a%2Fb');
    expect(embedRoutes.dashboard('a?b=1')).toBe('/catalog/embed/dashboards/a%3Fb%3D1');
  });
});

describe('pipelineRoutes', () => {
  it('defaults to the mount the README documents', () => {
    expect(DEFAULT_PIPELINE_BASE_PATH).toBe('/pipeline');
    expect(pipelineRoutes().connectors()).toBe('/pipeline/connectors');
  });

  it('builds every path under the base it was given', () => {
    // Listed exhaustively rather than spot-checked: these are the contract a host has to satisfy
    // with its own controllers, so a new one appearing — or an existing one moving — should be a
    // decision somebody makes, not a diff nobody reads.
    const routes = pipelineRoutes('/api/pipeline');

    expect({
      capabilities: routes.capabilities(),
      connections: routes.connections(),
      connection: routes.connection('c1'),
      checkConnection: routes.checkConnection('c1'),
      connectionConnectors: routes.connectionConnectors('c1'),
      connectors: routes.connectors(),
      connector: routes.connector('k1'),
      runConnector: routes.runConnector('k1'),
      runs: routes.runs(),
      transforms: routes.transforms(),
      transform: routes.transform('t1'),
      transformRevisions: routes.transformRevisions('t1'),
      tryTransform: routes.tryTransform(),
      workflows: routes.workflows(),
      workflow: routes.workflow('w1'),
      runWorkflow: routes.runWorkflow('w1'),
    }).toEqual({
      capabilities: '/api/pipeline/capabilities',
      connections: '/api/pipeline/connections',
      connection: '/api/pipeline/connections/c1',
      checkConnection: '/api/pipeline/connections/c1/check',
      connectionConnectors: '/api/pipeline/connections/c1/connectors',
      connectors: '/api/pipeline/connectors',
      connector: '/api/pipeline/connectors/k1',
      runConnector: '/api/pipeline/connectors/k1/run',
      runs: '/api/pipeline/runs',
      transforms: '/api/pipeline/transforms',
      transform: '/api/pipeline/transforms/t1',
      transformRevisions: '/api/pipeline/transforms/t1/revisions',
      tryTransform: '/api/pipeline/transforms/try',
      workflows: '/api/pipeline/workflows',
      workflow: '/api/pipeline/workflows/w1',
      runWorkflow: '/api/pipeline/workflows/w1/run',
    });
  });

  it('strips a trailing slash rather than doubling it', () => {
    // `/api/pipeline/` is not a mistake worth an exception, but concatenating it produces
    // `//connectors`, which most routers treat as a different path — a 404 nobody can read out of
    // the network tab.
    expect(pipelineRoutes('/api/pipeline/').connectors()).toBe('/api/pipeline/connectors');
  });

  it('escapes ids into the path', () => {
    // Connection and transform ids are server-generated today, but the builder is what stands
    // between an id containing a slash or a question mark and a request to another endpoint
    // entirely — or to the right one with a query string somebody did not write.
    const routes = pipelineRoutes();

    expect(routes.connection('a/b')).toBe('/pipeline/connections/a%2Fb');
    expect(routes.transform('a?b=1')).toBe('/pipeline/transforms/a%3Fb%3D1');
    expect(routes.runWorkflow('a b')).toBe('/pipeline/workflows/a%20b/run');
  });

  it('keeps the id inside its own segment', () => {
    // The suffix has to survive escaping: `.../c1/check` is a different endpoint from
    // `.../c1%2Fcheck`, and only one of them exists.
    expect(pipelineRoutes().checkConnection('c/1')).toBe('/pipeline/connections/c%2F1/check');
  });
});

describe('accessRoutes', () => {
  it('defaults to the mount the README documents', () => {
    expect(DEFAULT_ACCESS_BASE_PATH).toBe('/access');
    expect(accessRoutes().principals()).toBe('/access/principals');
    expect(accessRoutes().people()).toBe('/access/people');
  });

  it('moves with the base it was given, trailing slash or not', () => {
    expect(accessRoutes('/admin/access').people()).toBe('/admin/access/people');
    expect(accessRoutes('/admin/access/').people()).toBe('/admin/access/people');
  });
});
