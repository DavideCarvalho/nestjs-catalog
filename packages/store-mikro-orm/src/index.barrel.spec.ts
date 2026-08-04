import { describe, expect, it } from 'vitest';
import * as context from './context';
import * as governance from './entities/governance';
import * as model from './entities/model';
import * as pipeline from './entities/pipeline';
import * as workspace from './entities/workspace';
import * as promotion from './environment.promotion';
import * as routing from './environment.routing';
import * as identifiers from './identifiers';
import * as barrel from './index';
import * as query from './query';
import * as schema from './schema';

/**
 * That the barrel re-exports what a host has to import to use this package.
 *
 * The same guard the catalog package grew, written after the same thing happened
 * again here. Relations shipped as a column on `ObjectTypeRow` — with
 * `StoredRelation`, `PublishedRelation` and `relationsOf` beside it — and the
 * hand-maintained list in `index.ts` still named exactly the two entity classes
 * it had always named. So the publisher that has to *describe* a link could not
 * name the type of one, and the reader that has to survive a row predating the
 * column could not reach the accessor that does, without deep-importing a file
 * inside `dist/`. `catalogConnectionProviders` had fallen behind the same way:
 * both of the connection tokens were exported and the only supported way to
 * satisfy them was not.
 *
 * Runtime exports only — types are erased by the time this runs, so this cannot
 * see `StoredRelation` or `PublishedRelation`. That half is guarded for real
 * somewhere better: `publish.service.ts` in the pipeline package imports
 * `PublishedRelation` from this package's public entry point, and that package's
 * `tsc` resolves it through the built `dist/index.d.ts`. A type dropped from the
 * barrel fails that build. The sweep below is for the other half, and for the
 * same reason the catalog's version exists: a list that drops one name drops its
 * neighbours too.
 */

/** Every module whose exports a host is expected to reach through the barrel. */
const SEAMS: Array<[string, Record<string, unknown>]> = [
  ['context', context],
  ['entities/governance', governance],
  ['entities/model', model],
  ['entities/pipeline', pipeline],
  ['entities/workspace', workspace],
  ['environment.promotion', promotion],
  ['environment.routing', routing],
  ['identifiers', identifiers],
  ['query', query],
  ['schema', schema],
];

describe('the public barrel', () => {
  for (const [name, module_] of SEAMS) {
    it(`re-exports everything from ${name}`, () => {
      const missing = Object.keys(module_).filter((key) => !(key in barrel));

      expect(missing).toEqual([]);
    });
  }

  it('carries the relations seam by name', () => {
    // Spelled out as well as covered by the sweep, because this is what a host
    // writes down to read a link off a row safely, and a rename should fail here
    // rather than in somebody else's build.
    expect(barrel.relationsOf).toBe(model.relationsOf);
  });

  it('carries the entity every relation hangs off, and the providers that bind it', () => {
    expect(barrel.ObjectTypeRow).toBe(model.ObjectTypeRow);
    expect(barrel.catalogConnectionProviders).toBe(context.catalogConnectionProviders);
  });

  it('lists every entity this package manages, so none is created only by luck', () => {
    // Being absent from `catalogStoreEntities` is invisible until the first read
    // — the table is never created and the query dies on missing metadata. The
    // entity modules are the source of truth for what exists.
    // By the `*Row` suffix every entity in this package is named with, rather
    // than by asking MikroORM: its metadata is assembled at discovery, which is
    // the very thing being skipped when a class is missing from the list.
    const entities = [governance, model, pipeline, workspace].flatMap((module_) =>
      Object.values(module_).filter(
        (value): value is { name: string } =>
          typeof value === 'function' && value.name.endsWith('Row'),
      ),
    );

    expect(entities.length).toBeGreaterThan(0);

    for (const entity of entities) {
      expect(barrel.catalogStoreEntities).toContain(entity);
    }
  });
});
