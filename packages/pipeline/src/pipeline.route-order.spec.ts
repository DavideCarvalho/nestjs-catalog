import { Controller, Get } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
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
 * That no route on these controllers is unreachable because of the order it was
 * declared in.
 *
 * **Nest matches in declaration order.** A `:param` route declared before a
 * literal one at the same position captures the literal, and the literal route
 * is then dead — reachable by nothing, failing no test, answering with whatever
 * the parameter route makes of a word it was never meant to receive. It is a
 * 200, which is why it survives a status-code assertion, and the handler that
 * was supposed to run simply never does.
 *
 * This has already cost something here. `POST connections/check` carries a
 * docblock saying it is "declared BEFORE `connections/:id/check`, and it has to
 * be", which is a note that only gets written after somebody has watched
 * `:id` swallow the word "check". `transforms/:id/revisions` carries the
 * opposite note — that its order is not load-bearing because the literal
 * sibling under `transforms/` is a POST and a GET `:id` cannot capture it.
 * Both notes are true and neither is enforced by anything, so both are one
 * refactor away from being wrong.
 *
 * So: a sweep, over the real controllers, in the order Nest will read them. It
 * is a property of the whole surface rather than of any one route, and the four
 * expectation routes added under `expectations/` are exactly the kind of block
 * that makes it worth having — the next literal added under there
 * (`expectations/locked`, say) is the one that would go quietly missing.
 *
 * **It finds nothing today, and that is the intended state.** A check that has
 * never failed is also a check that may not work, so the last two cases below
 * run it against controllers written both ways round: a sweep proven only by the
 * absence of a finding is a sweep nobody should trust.
 */

/** A route as Nest will register it: the verb, and the path split into segments. */
interface DeclaredRoute {
  handler: string;
  /** The `RequestMethod` enum value; `ALL` is 4 and matches every verb. */
  method: number;
  segments: string[];
}

const ALL_METHODS = 4;

/**
 * The routes on a controller, IN DECLARATION ORDER.
 *
 * `Object.getOwnPropertyNames` on a class prototype answers in definition
 * order, which is the order Nest's `RouterExplorer` walks and therefore the
 * order Express receives them in. That is the whole basis of this file: a check
 * against a sorted or otherwise re-ordered list would be checking a route table
 * nothing serves.
 */
function declaredRoutes(prototype: object): DeclaredRoute[] {
  const routes: DeclaredRoute[] = [];
  for (const handler of Object.getOwnPropertyNames(prototype)) {
    if (handler === 'constructor') continue;
    const method = Reflect.get(prototype, handler);
    if (typeof method !== 'function') continue;
    const path: unknown = Reflect.getMetadata(PATH_METADATA, method);
    if (typeof path !== 'string') continue;
    const verb: unknown = Reflect.getMetadata(METHOD_METADATA, method);
    routes.push({
      handler,
      method: typeof verb === 'number' ? verb : ALL_METHODS,
      segments: path.split('/').filter((segment) => segment.length > 0),
    });
  }
  return routes;
}

/**
 * Would the earlier route swallow the later one?
 *
 * Same verb (or `ALL`), same number of segments, every segment of the earlier
 * either identical or a `:param` — and at least one place where the earlier has
 * a parameter and the later has a literal. That last clause is what keeps two
 * genuinely different literal paths, and a route and itself, out of the answer.
 */
function shadows(earlier: DeclaredRoute, later: DeclaredRoute): boolean {
  if (earlier.method !== later.method && earlier.method !== ALL_METHODS) return false;
  if (earlier.segments.length !== later.segments.length) return false;

  let capturesALiteral = false;
  for (const [index, segment] of earlier.segments.entries()) {
    const against = later.segments[index] ?? '';
    if (segment.startsWith(':')) {
      if (!against.startsWith(':')) capturesALiteral = true;
      continue;
    }
    if (segment !== against) return false;
  }
  return capturesALiteral;
}

function shadowedPairs(prototype: object): string[] {
  const routes = declaredRoutes(prototype);
  const found: string[] = [];
  for (const [index, later] of routes.entries()) {
    for (const earlier of routes.slice(0, index)) {
      if (shadows(earlier, later)) {
        found.push(`${earlier.handler} captures ${later.handler}`);
      }
    }
  }
  return found;
}

const CONTROLLERS: Array<[string, { prototype: object }]> = [
  ['pipeline', createPipelineController('catalog')],
  ['publish', createPublishController('catalog/publish')],
];

describe('no route is declared where an earlier one would capture it', () => {
  for (const [name, controller] of CONTROLLERS) {
    it(`leaves nothing unreachable on the ${name} controller`, () => {
      const routes = declaredRoutes(controller.prototype);
      // A sweep that finds nothing to sweep passes for the wrong reason.
      expect(routes.length).toBeGreaterThan(0);

      expect(shadowedPairs(controller.prototype)).toEqual([]);
    });
  }

  it('declares the expectations block collection-first, which is the habit that keeps it safe', () => {
    // Named as well as swept, and worth being exact about what it does and does
    // not claim. `GET expectations` is one segment and `GET expectations/:type`
    // is two, so today NEITHER can capture the other whichever order they are
    // in — the ordering here is a convention, not a fix. What makes it worth
    // asserting is the route after next: a literal under `expectations/` is two
    // segments, `:type` would capture it, and a block already written
    // collection-first is one where the obvious place to add it is the safe
    // place. The sweep above is what catches it if somebody adds it anyway.
    const routes = declaredRoutes(createPipelineController('catalog').prototype);
    const at = (handler: string) => routes.findIndex((route) => route.handler === handler);

    expect(at('loadExpectations')).toBeGreaterThanOrEqual(0);
    expect(at('loadExpectations')).toBeLessThan(at('loadExpectation'));
  });

  it('catches the mistake it exists for', () => {
    // The sweep above is only worth its line if it can fail. This is the same
    // check against a controller declared the wrong way round: `:name` first,
    // and the literal `locked` behind it, which is precisely what would happen
    // if somebody added a route under `expectations/` without reading the note.
    @Controller('spec')
    class MisorderedController {
      @Get('expectations/:name')
      one() {
        return undefined;
      }
      @Get('expectations/locked')
      two() {
        return undefined;
      }
    }

    expect(shadowedPairs(MisorderedController.prototype)).toEqual(['one captures two']);
  });

  it('does not cry wolf over a literal that only looks similar', () => {
    @Controller('spec')
    class FineController {
      @Get('expectations/locked')
      one() {
        return undefined;
      }
      @Get('expectations/:name')
      two() {
        return undefined;
      }
      // A different verb cannot capture a GET, which is the argument the
      // `transforms/:id/revisions` docblock makes about `transforms/try`.
      @Get('expectations')
      three() {
        return undefined;
      }
    }

    expect(shadowedPairs(FineController.prototype)).toEqual([]);
  });
});
