// `.js` on the specifier, because NODE resolves this one and does not guess
// extensions — see `bundler/index.ts` for why the importer is Node here.
import {
  CATALOG_CODE_LANGUAGES,
  CATALOG_CODE_THEMES,
  type CatalogCodeLanguage,
  type CatalogCodeTheme,
} from '../ui/code-languages.js';

/**
 * A Vite/Rollup plugin that prunes Shiki down to what this console renders.
 *
 * THE PROBLEM IT SOLVES
 * ---------------------
 * `@pierre/diffs` is the editor and the diff, and it resolves a grammar by
 * looking the name up in Shiki's `bundledLanguages` — an object of ~240 entries
 * whose values are `() => import('@shikijs/langs/<name>')`. Themes work the same
 * way through `@pierre/theming`'s collections. A bundler cannot tree-shake a
 * dynamic import selected by a runtime key, so it emits a chunk for every entry
 * whether or not the application can ever reach it. Measured on
 * `packages/dashboard`'s SPA before this plugin existed: 319 JS chunks, of which
 * 242 were grammars (7.47 MB minified) and 75 were themes (1.58 MB) — against a
 * console that renders SQL, JSON, TSX and Python in two Pierre palettes.
 *
 * WHAT IT IS NOT
 * --------------
 * It is NOT an entry-bundle saving, and claiming one would be a lie the first
 * `ls dist/spa/assets` would catch. Every one of those chunks is lazy: Shiki's
 * core, its JavaScript regex engine and the editor itself are in the entry, and
 * they stay there. What this removes is emitted-but-unreachable bytes and the
 * files carrying them.
 *
 * HOW IT WORKS, AND WHY REWRITING IS THE SOUND WAY
 * ------------------------------------------------
 * Every `import('<registry>/<name>')` for a name outside the subset is rewritten
 * to a rejected promise. Nothing else changes: the registry keeps its key, the
 * loader is still a function, and the arrow is still only called if something
 * asks for that name — at which point it rejects with a message naming the
 * specifier and this plugin. There is no chunk because there is no longer an
 * `import()` for Rollup to split on.
 *
 * The alternative — resolving those specifiers to a stub module — was rejected:
 * a stub is still a module, so Rollup still emits ~240 chunks, only tiny ones.
 * Deleting the entries from the registry object instead would mean rewriting
 * generated dependency source by shape rather than by specifier, and a
 * specifier is a package's public API where its bundler output is not.
 *
 * WHY IT CANNOT GO QUIET
 * ----------------------
 * A pruner that stops matching prunes nothing and says nothing — the build gets
 * slower and fatter and stays green. So {@link buildEnd} asserts the opposite of
 * the usual thing: not that names were REMOVED, but that every name that was
 * KEPT was actually there to keep, and that each registry was seen at all. A
 * Shiki release that renames `tsx`, a typo in `CATALOG_CODE_LANGUAGES`, a
 * `@pierre/theming` that stops naming its palettes as subpath imports — each
 * one fails the build with the name it could not find.
 *
 * USAGE
 * -----
 * ```ts
 * import { shikiSubset } from '@dudousxd/nestjs-catalog-react/bundler';
 *
 * export default defineConfig({ plugins: [react(), shikiSubset()] });
 * ```
 *
 * A host that wants a grammar this console does not — its own `<CodeEditor>` on
 * its own page — should not install this plugin, because the subset is this
 * package's set and not theirs. There is no option to extend it, deliberately:
 * an extensible allow-list is a list again, and the type that makes this one
 * safe is not extensible either.
 */
export function shikiSubset(): ShikiSubsetPlugin {
  const registries = REGISTRIES.map((registry) => ({
    ...registry,
    /** Which of `keep` this build actually found. The absentees fail the build. */
    found: new Set<string>(),
    /** Whether the registry was in the module graph at all. */
    seen: false,
  }));

  return {
    name: 'catalog-shiki-subset',
    // Before anything else rewrites a dynamic import — this reads the
    // dependency's own source, and wants it as the dependency wrote it.
    enforce: 'pre',
    // Build only. A dev server pre-bundles dependencies with esbuild, so this
    // hook would see a fraction of them and `buildEnd` would fail the run over
    // an absence that means nothing. Dev pays a slower cold start; nothing
    // about correctness differs, because a pruned grammar is one nothing asks
    // for.
    apply: 'build',

    transform(code: string) {
      if (!registries.some((registry) => code.includes(registry.prefix))) return null;

      let touched = false;
      const next = code.replace(DYNAMIC_IMPORT, (match, _quote: string, specifier: string) => {
        const registry = registries.find((candidate) => specifier.startsWith(candidate.prefix));
        if (!registry) return match;

        registry.seen = true;
        const name = specifier.slice(registry.prefix.length);
        if (registry.keep.has(name)) {
          registry.found.add(name);
          return match;
        }

        touched = true;
        return `${PRUNED}(${JSON.stringify(specifier)})`;
      });

      // `null` when nothing changed, so a module that merely MENTIONS a registry
      // — the resolver that reads it, say — is handed back untouched rather than
      // re-emitted with a sourcemap this plugin cannot honestly produce.
      return touched ? { code: `${prunedHelper()}\n${next}`, map: null } : null;
    },

    buildEnd(error?: unknown) {
      // A failed build has already said what is wrong, and the registries it
      // never reached would only add noise on top of the real error.
      if (error) return;

      const complaints: string[] = [];
      for (const registry of registries) {
        if (!registry.seen) {
          complaints.push(
            `no \`import('${registry.prefix}…')\` reached this plugin, so nothing was pruned from it`,
          );
          continue;
        }
        const missing = [...registry.keep].filter((name) => !registry.found.has(name));
        if (missing.length > 0) {
          complaints.push(
            `${registry.prefix} offers no ${registry.what} named ${missing.join(', ')}`,
          );
        }
      }

      if (complaints.length > 0) {
        throw new Error(`catalog-shiki-subset: ${complaints.join('; ')}. ${ADVICE}`);
      }
    },
  };
}

/**
 * Every dynamic import, by the only part of it that is a public contract.
 *
 * A package's subpath exports are declared in its `package.json` and are what a
 * caller is allowed to write; the file its bundler emitted them into is not.
 * So this matches `import('…')` and reads the specifier, rather than matching
 * the `(() => import(…))` wrapper Shiki's generator happens to produce and
 * `@pierre/theming`'s does not.
 */
const DYNAMIC_IMPORT = /\bimport\(\s*(['"])([^'"]+)\1\s*\)/g;

/** What to do about it, which is the same answer whichever way the subset went wrong. */
const ADVICE =
  'The subset in `ui/code-languages.ts` is out of step with the packages it prunes — left alone ' +
  'this plugin would silently stop pruning, or prune a grammar the console renders. Fix the ' +
  'names, or drop the plugin.';

/** The registries pruned, and what survives each. */
const REGISTRIES: readonly {
  prefix: string;
  what: string;
  keep: ReadonlySet<string>;
}[] = [
  {
    prefix: '@shikijs/langs/',
    what: 'grammar',
    keep: new Set<CatalogCodeLanguage>(CATALOG_CODE_LANGUAGES),
  },
  {
    // Every one. The console is painted by Pierre's palettes below, and Shiki's
    // own 65 are reachable only by naming one, which nothing here does.
    prefix: '@shikijs/themes/',
    what: 'theme',
    keep: new Set<string>(),
  },
  {
    prefix: '@pierre/theme/',
    what: 'theme',
    keep: new Set<CatalogCodeTheme>(CATALOG_CODE_THEMES),
  },
];

/** The name each pruned `import()` is rewritten to call. */
export const PRUNED = '__catalogPrunedShikiImport';

/**
 * What a pruned name evaluates to, declared ONCE per rewritten module.
 *
 * A rejected promise rather than a throw, because the registry's value is a
 * loader that both `@pierre/diffs` and `@pierre/theming` `await` — so a
 * rejection surfaces where the caller already handles one, while a synchronous
 * throw from inside an arrow would surface somewhere neither of them looks.
 * Nothing is constructed until the loader is called, so there is no promise
 * sitting around to go unhandled.
 *
 * A shared helper rather than the sentence inlined at each of the ~320 call
 * sites, and that is measured rather than tidy: inlined, the message added
 * 58 KB to `packages/dashboard`'s ENTRY chunk — the one chunk this change was
 * not supposed to touch — because the registry object it lives in is in the
 * entry path even when every grammar it names is not. Hoisted, the call sites
 * are shorter than the `import()` they replace once the minifier has renamed
 * the helper, and the entry comes out smaller than before.
 *
 * The specifier is passed because the type that normally catches this
 * (`CatalogCodeLanguage`) only sees literals written in this package; a `lang`
 * inferred from a filename at runtime is the case that gets here, and "which
 * one" is the whole question then.
 *
 * A function DECLARATION, so hoisting makes it valid above the registry no
 * matter where in the module the imports sat.
 */
function prunedHelper() {
  const advice =
    ' was pruned from this bundle by catalog-shiki-subset. Add it to ' +
    'CATALOG_CODE_LANGUAGES / CATALOG_CODE_THEMES in @dudousxd/nestjs-catalog-react, ' +
    'or stop asking for it.';
  return `function ${PRUNED}(specifier){return Promise.reject(new Error(specifier+${JSON.stringify(advice)}))}`;
}

/**
 * The plugin, typed structurally.
 *
 * Written out rather than imported from `vite` or `rollup`, because this package
 * ships React components and taking a build tool as a dependency to name one
 * interface would put it in every consumer's install. Vite accepts any object of
 * this shape; the five fields are the five it reads.
 */
export interface ShikiSubsetPlugin {
  name: string;
  enforce: 'pre';
  apply: 'build';
  transform(code: string): { code: string; map: null } | null;
  buildEnd(error?: unknown): void;
}
