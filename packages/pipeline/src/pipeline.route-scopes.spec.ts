import { REQUIRED_SCOPES } from '@dudousxd/nestjs-catalog';
import { PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it, vi } from 'vitest';
import { createPipelineController } from './pipeline.controller';
import { createPublishController } from './publish.controller';

/** See the note in `pipeline.module.integration.spec.ts`: the package cannot load here. */
vi.mock('@dudousxd/nestjs-durable', () => ({
  WorkflowEngine: class WorkflowEngine {},
  Step: () => (_target: unknown, _key: unknown, descriptor: unknown) => descriptor,
  Workflow: () => (target: unknown) => target,
}));

/**
 * That no route in this package is left undeclared.
 *
 * The catalog package has swept its own controllers for this since
 * `catalog.route-scopes.integration.spec.ts` was written, and it says why at
 * length: an *absent* declaration is a declaration. `catalog.route-auth.ts`
 * states that absence means "authenticated is enough", so a route nobody
 * decorated tells a host's guard to let anybody in — which is how three access
 * routes shipped unscoped under a sweep whose name claimed otherwise.
 *
 * **This package had no sweep at all.** Its controllers carry the routes that
 * run code in this process, save credentials and commit snapshots, and until now
 * nothing failed when one arrived without a scope. The gap was noticed while
 * adding `GET transforms/:id/revisions`, and closing it belongs with that change
 * rather than in a ticket: a completeness check written the day after the route
 * it was meant to cover is a check that starts one route behind.
 *
 * ## Metadata, not HTTP — and only here
 *
 * The catalog's sweep boots an application and asks every route from both sides:
 * the declared scope alone gets in, everything else is refused. That is the
 * stronger test and it is affordable there, because those controllers need a
 * registry and two stores. These need a transform runner, a connector runner, a
 * connection checker, two workflow services and a registry seam, and a fixture
 * that large is one whose own gaps become the reason a test passes. What is
 * asserted here instead is the thing that was actually missing: every handler
 * says what it needs, and adding one that does not fails.
 *
 * The scopes themselves are asserted where they are argued — `pipeline.grants.spec.ts`
 * and `pipeline.transform-try.spec.ts` cover the routes whose scope is a
 * decision rather than a default.
 *
 * Whoever adds a third factory to this package must add it here. There is no way
 * to enumerate them without booting the module, and booting it needs exactly the
 * providers this file is written to avoid.
 */

/** Both factories, built with no guards: nothing here calls a handler. */
const CONTROLLERS: Array<[string, { prototype: object }]> = [
  ['pipeline', createPipelineController('catalog')],
  ['publish', createPublishController('catalog/publish')],
];

/** The methods Nest will route to, by the path metadata its decorators leave. */
function handlersOf(prototype: object): string[] {
  return Object.getOwnPropertyNames(prototype).filter((name) => {
    if (name === 'constructor') return false;
    const method = Reflect.get(prototype, name);
    return typeof method === 'function' && Reflect.getMetadata(PATH_METADATA, method) !== undefined;
  });
}

describe('every pipeline route declares what it needs', () => {
  for (const [name, controller] of CONTROLLERS) {
    it(`leaves no handler on the ${name} controller undeclared`, () => {
      const prototype = controller.prototype;
      const handlers = handlersOf(prototype);

      // A sweep that finds nothing to sweep passes for the wrong reason — the
      // failure it has to survive is a rename of the factory.
      expect(handlers.length).toBeGreaterThan(0);

      const undeclared = handlers.filter((handler) => {
        // Handler first, then the class, exactly as a host's guard reads it:
        // `createPublishController` declares one scope for the whole controller,
        // and a per-handler-only check would report all four of its routes as
        // open while they are the best-declared routes in the package.
        const onHandler = Reflect.getMetadata(REQUIRED_SCOPES, Reflect.get(prototype, handler));
        const onClass = Reflect.getMetadata(REQUIRED_SCOPES, controller);
        return onHandler === undefined && onClass === undefined;
      });

      expect(undeclared).toEqual([]);
    });
  }

  it('declares a scope on the revisions route, which is what found the gap', () => {
    // Named as well as swept: this is the route the sweep was written alongside,
    // and it reads back a body that `GET transforms` already serves under
    // `catalog:read`. A future tightening to `catalog:write` would lock the diff
    // screen out of history a reader can already see the head of.
    const prototype = createPipelineController('catalog').prototype;
    const scopes = Reflect.getMetadata(
      REQUIRED_SCOPES,
      Reflect.get(prototype, 'transformRevisions'),
    );

    expect(scopes).toEqual(['catalog:read']);
  });
});
