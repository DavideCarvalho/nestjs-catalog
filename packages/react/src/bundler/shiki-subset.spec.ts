/**
 * The Shiki pruner, and the two ways it is allowed to fail.
 *
 * It may refuse to build. It may not quietly stop working — a pruner that
 * matches nothing prunes nothing, emits the 317 chunks it exists to remove, and
 * leaves a green suite behind it. So half of what is asserted here is the
 * BUILD-time complaint, not the rewrite.
 *
 * The registry fragments below are copied from the shape the real packages emit
 * — `(() => import("@shikijs/langs/x"))` out of Shiki's generated
 * `langs-bundle-full`, and the bare `() => import("@shikijs/themes/x")` out of
 * `@pierre/theming`'s collection, which does NOT wrap the arrow. Both forms are
 * here on purpose: the plugin matches the `import()` and not the wrapper
 * precisely because the two differ.
 */
import { describe, expect, it } from 'vitest';
import { CATALOG_CODE_LANGUAGES, CATALOG_CODE_THEMES } from '../ui/code-languages';
import { PRUNED, shikiSubset } from './shiki-subset';

/** Shiki's language registry, in miniature. */
const LANGS = `const bundledLanguagesInfo = [
	{ "id": "abap", "name": "ABAP", "import": (() => import("@shikijs/langs/abap")) },
	{ "id": "sql", "name": "SQL", "import": (() => import("@shikijs/langs/sql")) },
	{ "id": "json", "name": "JSON", "import": (() => import("@shikijs/langs/json")) },
	{ "id": "tsx", "name": "TSX", "import": (() => import("@shikijs/langs/tsx")) },
	{ "id": "python", "name": "Python", "import": (() => import("@shikijs/langs/python")) },
	{ "id": "zig", "name": "Zig", "import": (() => import("@shikijs/langs/zig")) }
];`;

/** `@pierre/theming`'s two collections, in miniature. */
const THEMES = `const SHIKI_THEME_IMPORTS = {
	dracula: () => import("@shikijs/themes/dracula"),
	nord: () => import("@shikijs/themes/nord")
};
const PIERRE_THEME_IMPORTS = {
	"pierre-dark": () => import("@pierre/theme/pierre-dark"),
	"pierre-light": () => import("@pierre/theme/pierre-light"),
	"pierre-dark-soft": () => import("@pierre/theme/pierre-dark-soft")
};`;

/** The plugin's answer for one module, as text. */
function rewrite(code: string): string {
  const result = shikiSubset().transform(code);
  return result === null ? code : result.code;
}

/** Every dynamic import still standing, by specifier. */
function survivors(code: string): string[] {
  return [...code.matchAll(/\bimport\(['"]([^'"]+)['"]\)/g)].map((match) => match[1] ?? '');
}

/** A whole build: both registries through one plugin instance, then `buildEnd`. */
function build(modules: string[] = [LANGS, THEMES]) {
  const plugin = shikiSubset();
  const out = modules.map((code) => plugin.transform(code)?.code ?? code);
  return { out, finish: () => plugin.buildEnd() };
}

describe('shikiSubset', () => {
  describe('what survives', () => {
    it('keeps every grammar the console renders, untouched', () => {
      const code = rewrite(LANGS);

      // Untouched matters as much as kept: the four that survive are
      // byte-identical to what Shiki shipped, so the runtime for them is the
      // runtime that was there before this plugin existed.
      for (const language of CATALOG_CODE_LANGUAGES) {
        expect(code).toContain(`(() => import("@shikijs/langs/${language}"))`);
      }
    });

    it('drops every grammar it does not', () => {
      expect(survivors(rewrite(LANGS)).sort()).toEqual(
        CATALOG_CODE_LANGUAGES.map((language) => `@shikijs/langs/${language}`).sort(),
      );
    });

    it('keeps both Pierre palettes and drops Shiki’s own', () => {
      // The console never names a Shiki theme, so the whole of that registry
      // goes; the Pierre pair is what `DEFAULT_THEMES` resolves to.
      expect(survivors(rewrite(THEMES)).sort()).toEqual(
        CATALOG_CODE_THEMES.map((theme) => `@pierre/theme/${theme}`).sort(),
      );
    });

    it('leaves a module that names no registry alone', () => {
      // `null`, not a rewritten copy — Vite would otherwise re-emit the module
      // with a sourcemap this plugin does not produce.
      expect(shikiSubset().transform('export const x = () => import("./local.js");')).toBeNull();
    });

    it('leaves a module that names a registry but changes nothing alone', () => {
      const onlyKept = 'const m = { sql: (() => import("@shikijs/langs/sql")) };';

      expect(shikiSubset().transform(onlyKept)).toBeNull();
    });
  });

  describe('what a pruned name does when something asks for it', () => {
    it('rejects, naming the specifier and this plugin', async () => {
      const code = rewrite(LANGS);
      const helper = code.slice(0, code.indexOf('\n'));
      // Evaluated rather than pattern-matched: what matters is that the loader
      // this plugin writes is callable and rejects, not that it reads a
      // particular way.
      const loader: (specifier: string) => Promise<never> = new Function(
        `${helper}; return ${PRUNED};`,
      )();

      await expect(loader('@shikijs/langs/zig')).rejects.toThrow(
        /@shikijs\/langs\/zig was pruned from this bundle by catalog-shiki-subset/,
      );
    });

    it('builds nothing until it is called', () => {
      // A `Promise.reject` constructed at module scope is an unhandled rejection
      // in every one of the ~317 registry entries nobody touches. The helper
      // takes the specifier as an argument for exactly this reason.
      expect(rewrite(LANGS)).not.toContain('Promise.reject(new Error("@shikijs');
    });
  });

  describe('when it stops working', () => {
    it('passes when both registries were found and pruned', () => {
      expect(() => build().finish()).not.toThrow();
    });

    it('fails the build when a kept grammar is not in the registry', () => {
      // Shiki renaming or dropping `tsx`, or a typo in CATALOG_CODE_LANGUAGES.
      // Silently, this ships a transform editor that renders flat grey.
      const withoutTsx = LANGS.replace('(() => import("@shikijs/langs/tsx"))', 'null');

      expect(() => build([withoutTsx, THEMES]).finish()).toThrow(
        /@shikijs\/langs\/ offers no grammar named tsx/,
      );
    });

    it('fails the build when a kept theme is not in the registry', () => {
      const withoutLight = THEMES.replace('() => import("@pierre/theme/pierre-light")', 'null');

      expect(() => build([LANGS, withoutLight]).finish()).toThrow(
        /@pierre\/theme\/ offers no theme named pierre-light/,
      );
    });

    it('fails the build when a registry never appears at all', () => {
      // The shape changing out from under the regex — a template literal, an
      // `await import`, a bundler that inlines the map. Nothing is pruned and
      // nothing complains, which is the exact failure this assertion exists for.
      expect(() => build([THEMES]).finish()).toThrow(/@shikijs\/langs\/…/);
    });

    it('says nothing when the build already failed', () => {
      // The real error is upstream; a complaint about registries a broken build
      // never reached would bury it.
      const plugin = shikiSubset();

      expect(() => plugin.buildEnd(new Error('something else went wrong'))).not.toThrow();
    });
  });

  it('is a build-only, pre-ordered plugin', () => {
    // Not decoration. A dev server pre-bundles dependencies with esbuild, so
    // `transform` would see a fraction of the registries and `buildEnd` would
    // fail the run over an absence that means nothing; and `pre` is what puts
    // this ahead of anything that would rewrite a dynamic import first.
    const plugin = shikiSubset();

    expect(plugin.apply).toBe('build');
    expect(plugin.enforce).toBe('pre');
  });
});
