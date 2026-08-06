/**
 * That `@dudousxd/nestjs-catalog-react`'s barrel carries what a host has to name.
 *
 * The same guard `packages/store-mikro-orm/src/index.barrel.spec.ts` grew, after the same thing
 * happened a third time. There, a hand-maintained list named two entity classes and not the
 * relation types beside them, and exported both connection tokens but not the only supported way
 * to satisfy them. Here, `PipelineConsoleProps` was exported and every type reachable from its
 * `schemaDiscovery` prop was not, so a host writing the bridge that prop demands could only name
 * its argument through an indexed access on a component's props — and `CatalogClient` was
 * exported without the page its one paged method answers with.
 *
 * **It lives in the console, not in the library, because the console is the library's first
 * host.** "Can somebody outside this package name this?" is a question only somebody outside it
 * can ask; asked from inside, every relative import answers yes.
 *
 * **It reads source text rather than importing.** Almost everything missing here was a TYPE, and
 * types do not exist at runtime — the store's version says so itself and gives that half up,
 * leaning on another package's `tsc` to catch it. Nothing in this repo typechecks a spec (every
 * build config excludes them, deliberately, so they are never published), so there is no `tsc` to
 * lean on and a type-level assertion here would be checked by nothing at all. Reading the two
 * files and comparing the names they declare against the names the barrel re-exports is the only
 * version of this that actually runs. The runtime half below is kept for what it is good at: that
 * the value exports resolve to the same functions, not merely to a matching identifier.
 *
 * The only spec in this directory that does not ask for the jsdom environment, and on purpose:
 * nothing here renders, `import.meta.url` — which the files being read are resolved against — is
 * a `file:` URL under `node` and is not under jsdom, and importing the barrel under `node` proves
 * something extra, namely that reaching it costs a host no DOM.
 *
 * The environment is NOT named in full anywhere in this file. Vitest finds that directive by
 * scanning the source for it, not by requiring it on the first line, so a docblock that quotes it
 * — as this one first did — silently switches the environment it is explaining the absence of.
 *
 * What this deliberately does NOT do is sweep every module in the package. The barrel is curated
 * on purpose — `WorkflowCanvas` is withheld because it would drag `@xyflow/react` into every
 * consumer's bundle, and the chart renderers live on subpaths for the same reason. A blanket
 * sweep would fail on those and be silenced with an exception list, which is how a curated list
 * rots in the first place. What it sweeps is the five modules the barrel already re-exports
 * from, in full: having decided a module is public, dropping one name out of it is exactly the
 * failure being guarded.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_PUBLISH_BASE_PATH,
  initialChoices,
  proposalFrom,
} from '@dudousxd/nestjs-catalog-react';
import { describe, expect, it } from 'vitest';

const REACT_SRC = fileURLToPath(new URL('../../../react/src/', import.meta.url));

const read = (file: string) => readFileSync(`${REACT_SRC}${file}`, 'utf8');

const BARREL = read('index.ts');

/**
 * The modules the barrel has already declared public, and the file each one is.
 *
 * Keyed by the specifier as the barrel writes it, because that is what makes the check say
 * something: a name re-exported from the wrong module is a different bug from a name left out,
 * and matching on the specifier catches both.
 */
const SEAMS: Array<[specifier: string, file: string]> = [
  ['./PipelineConsole', 'PipelineConsole.tsx'],
  ['./schema-discovery', 'schema-discovery.tsx'],
  ['./context', 'context.tsx'],
  ['./routes', 'routes.ts'],
  ['./workflow/model', 'workflow/model.ts'],
  ['./workflow/validate', 'workflow/validate.ts'],
];

/** Every top-level declaration a module exports under its own name. */
function declaredExports(source: string): string[] {
  const pattern =
    /^export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|let|class|interface|type|enum)\s+([A-Za-z0-9_$]+)/gm;
  return [...source.matchAll(pattern)].flatMap((match) => (match[1] ? [match[1]] : []));
}

/**
 * Every name the barrel re-exports from one specifier.
 *
 * Comments are stripped before the split rather than after, because the prose inside these
 * blocks contains commas — and a fragment cut mid-sentence looks exactly like a missing name.
 */
function reExportedFrom(specifier: string): Set<string> {
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const blocks = BARREL.matchAll(
    new RegExp(`export\\s*\\{([^}]*)\\}\\s*from\\s*'${escaped}';`, 'g'),
  );
  const names = new Set<string>();
  for (const block of blocks) {
    for (const fragment of (block[1] ?? '').replace(/\/\/[^\n]*/g, '').split(',')) {
      const name = fragment
        .trim()
        .replace(/^type\s+/, '')
        .trim();
      if (name) names.add(name);
    }
  }
  return names;
}

describe('the React package barrel', () => {
  for (const [specifier, file] of SEAMS) {
    it(`re-exports everything ${file} declares`, () => {
      const exported = reExportedFrom(specifier);
      // Not empty, or a renamed specifier would make every module below vacuously pass — the
      // check would report a healthy barrel by finding nothing to compare against.
      expect(exported.size).toBeGreaterThan(0);

      const missing = declaredExports(read(file)).filter((name) => !exported.has(name));

      expect(missing).toEqual([]);
    });
  }

  it('carries the schema-discovery bridge by name, not only through a props lookup', () => {
    // Spelled out as well as covered by the sweep above, because this is the list a host writes
    // down to implement `SchemaDiscoveryBridge`, and it is the list that fell behind. A rename
    // should fail here rather than in somebody else's build.
    //
    // It moved out of `PipelineConsole` when the connector stopped being an authored object:
    // discovery is per source node now, and the canvas — which is behind its own entry point,
    // because it imports React Flow — has to be able to mount the panel. So the module the barrel
    // must re-export these from moved with it, and this test moving is the point rather than
    // collateral.
    const exported = reExportedFrom('./schema-discovery');

    for (const name of [
      'SchemaDiscoveryBridge',
      'ConnectorSchemaDiscovery',
      'DiscoveredColumn',
      'SchemaDrift',
      'DiscoveredTypeDraft',
      'ColumnChoice',
    ]) {
      expect(exported).toContain(name);
    }
  });

  it('carries the two types the access surface takes and answers with', () => {
    // `AccessRoutes.people(query)` and `CatalogClient.listPeople(query)` are both exported and
    // both were unnameable end to end: the argument lived in routes.ts, the reply in context.tsx.
    expect(reExportedFrom('./routes')).toContain('PeopleQuery');
    expect(reExportedFrom('./context')).toContain('CatalogPeoplePage');
  });

  it('resolves the value exports to the real things, not to a matching identifier', () => {
    // The half a text sweep cannot do. A barrel that re-exports the right name from the wrong
    // module compiles and reads correctly; this is what notices.
    expect(DEFAULT_PUBLISH_BASE_PATH).toBe('/publish');
    expect(typeof initialChoices).toBe('function');
    expect(typeof proposalFrom).toBe('function');
  });
});
