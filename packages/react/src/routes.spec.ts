/**
 * The paths behind the pipeline and access screens.
 *
 * Unlike `catalogRoutes`, these describe endpoints mounted wherever the host decided — by a
 * separate package for the pipeline ones, by `accessPath` for the access ones, as `routes.ts`
 * argues at length. Either way this package is guessing until it is told, which makes the builder
 * the single place a mistake can be made, and the mistake is always silent: a wrong path is a 404
 * at runtime, with no compile error and nothing on screen but an empty list.
 */
import { pipelineExpectationRoutes } from '@dudousxd/nestjs-catalog/client';
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
      callableWorkflows: routes.callableWorkflows(),
      connections: routes.connections(),
      connection: routes.connection('c1'),
      checkConnection: routes.checkConnection('c1'),
      connectionWorkflows: routes.connectionWorkflows('c1'),
      connectors: routes.connectors(),
      runs: routes.runs(),
      transforms: routes.transforms(),
      transform: routes.transform('t1'),
      transformRevisions: routes.transformRevisions('t1'),
      tryTransform: routes.tryTransform(),
      workflows: routes.workflows(),
      workflow: routes.workflow('w1'),
      publishWorkflow: routes.publishWorkflow('w1'),
      unpublishWorkflow: routes.unpublishWorkflow('w1'),
      runWorkflow: routes.runWorkflow('w1'),
      workflowSchedule: routes.workflowSchedule('w1'),
      workflowReleases: routes.workflowReleases('w1'),
      workflowLive: routes.workflowLive('w1'),
      discoverSourceSchema: routes.discoverSourceSchema('w1', 'src_1'),
      loadExpectations: routes.loadExpectations(),
      loadExpectation: routes.loadExpectation('Mvr'),
    }).toEqual({
      capabilities: '/api/pipeline/capabilities',
      callableWorkflows: '/api/pipeline/callable-workflows',
      connections: '/api/pipeline/connections',
      connection: '/api/pipeline/connections/c1',
      checkConnection: '/api/pipeline/connections/c1/check',
      connectionWorkflows: '/api/pipeline/connections/c1/workflows',
      connectors: '/api/pipeline/connectors',
      runs: '/api/pipeline/runs',
      transforms: '/api/pipeline/transforms',
      transform: '/api/pipeline/transforms/t1',
      transformRevisions: '/api/pipeline/transforms/t1/revisions',
      tryTransform: '/api/pipeline/transforms/try',
      workflows: '/api/pipeline/workflows',
      workflow: '/api/pipeline/workflows/w1',
      publishWorkflow: '/api/pipeline/workflows/w1/publish',
      unpublishWorkflow: '/api/pipeline/workflows/w1/unpublish',
      runWorkflow: '/api/pipeline/workflows/w1/run',
      workflowSchedule: '/api/pipeline/workflows/w1/schedule',
      workflowReleases: '/api/pipeline/workflows/w1/releases',
      workflowLive: '/api/pipeline/workflows/w1/live',
      discoverSourceSchema: '/api/pipeline/workflows/w1/nodes/src_1/discover',
      loadExpectations: '/api/pipeline/expectations',
      loadExpectation: '/api/pipeline/expectations/Mvr',
    });
  });

  it('has no builder for a connector route that was removed', () => {
    // The four that went with `POST connectors`, `DELETE connectors/:id`,
    // `POST connectors/:id/run` and `POST connectors/:id/discover`. A builder left behind is a
    // path a screen can still ask for, and asking for it is a 404 that reads as an empty list —
    // which is exactly the failure this file's header describes. `connectors()` stays: the GET is
    // still served, and is where a run history and a watermark are keyed.
    //
    // Read through an index signature rather than off the interface, because the interface no
    // longer declares them and naming one directly would not compile — which is the point, and
    // is also why that alone is not enough: an implementation may still carry a key its type has
    // stopped mentioning.
    const routes: Record<string, unknown> = { ...pipelineRoutes() };

    for (const gone of [
      'connector',
      'runConnector',
      'discoverConnectorSchema',
      'connectionConnectors',
    ]) {
      expect(routes[gone]).toBeUndefined();
    }
  });

  it('hands back exactly what the catalog client builds for the expectation paths', () => {
    // These two are the only paths here NOT written out in `routes.ts` — it borrows
    // `pipelineExpectationRoutes` from `@dudousxd/nestjs-catalog/client`, which is also what the
    // pipeline controller's own spec checks its `@Get`/`@Put`/`@Delete` decorators against. The
    // literals above say what the strings are; this says they are the SAME strings, so a route
    // moved in the catalog package moves here rather than leaving the console asking for a path
    // that stopped existing.
    const base = '/api/pipeline';
    const client = pipelineExpectationRoutes(base);
    const routes = pipelineRoutes(base);

    expect(routes.loadExpectations()).toBe(client.expectations());
    expect(routes.loadExpectation('Mvr')).toBe(client.expectation('Mvr'));
    expect(routes.loadExpectation('a/b')).toBe(client.expectation('a/b'));
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
