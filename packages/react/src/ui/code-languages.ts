import type { TransformLanguage } from '@dudousxd/nestjs-catalog/client';

/**
 * Every Shiki grammar and theme a code surface in this package can ask for.
 *
 * WHY A LIST EXISTS AT ALL
 * ------------------------
 * `@pierre/diffs` resolves a language through Shiki's `bundledLanguages`, which
 * is a map of ~240 dynamic imports, and a theme through `@pierre/theming`'s
 * collections, which are another ~75. A bundler cannot tree-shake a dynamic
 * import behind a runtime key, so it emits a chunk for every one of them:
 * measured on `packages/dashboard`'s SPA, 242 language chunks totalling 7.47 MB
 * minified and 75 theme chunks totalling 1.58 MB, against four grammars and two
 * themes this console will ever render. None of it is in the entry path — see
 * `bundler/shiki-subset.ts` for what that does and does not buy — but a
 * `dist/spa` where nine tenths of the files are grammars for languages the
 * catalog cannot execute is not a thing to ship to a host.
 *
 * So the set is stated here, once, and `shikiSubset()` prunes the registries
 * down to it at build time.
 *
 * WHY THIS LIST CANNOT GO QUIET
 * -----------------------------
 * A hand-maintained list of "languages we support" is exactly the shape that
 * stops being true the day somebody adds a case, and the failure is silent: an
 * unpruned grammar renders, a pruned one does not, and both look like code in a
 * box. Three things make that impossible here rather than merely unlikely.
 *
 * 1. {@link CatalogCodeLanguage} is derived from this array, and it is the type
 *    of `CodeEditor`'s `language` prop and `DiffBody`'s. A `language` this
 *    bundle does not carry is a COMPILE error at the call site.
 * 2. {@link TRANSFORM_HIGHLIGHTED_AS} `satisfies Record<TransformLanguage, …>`,
 *    so a language added to `TRANSFORM_LANGUAGES` in `@dudousxd/nestjs-catalog`
 *    is a compile error here until somebody says what it is highlighted as —
 *    and can only be answered with a grammar named above.
 * 3. `shikiSubset()` fails the BUILD if any name below is absent from the
 *    registry it prunes, so a typo, a rename, or a Shiki release that drops a
 *    grammar stops the build rather than quietly shipping plain text.
 */
export const CATALOG_CODE_LANGUAGES = ['sql', 'json', 'tsx', 'python'] as const;

/** Anything a code surface in this package may be told to highlight. */
export type CatalogCodeLanguage = (typeof CATALOG_CODE_LANGUAGES)[number];

/**
 * The two themes, and there are only ever two.
 *
 * `@pierre/diffs` picks between a `dark` and a `light` theme from its own
 * `DEFAULT_THEMES`, which this package never overrides — `codeOptions` passes
 * `themeType` (which SIDE to paint) and no `theme` (which PALETTE), so the pair
 * is always Pierre's own. Both are loaded on every mount, because the editor
 * hands both to the highlighter and lets CSS choose; that is why this is a pair
 * rather than the one in force.
 *
 * The other eight `@pierre/theme` palettes — soft, vibrant, and the two colour
 * vision variants of each side — are real themes that nothing here selects.
 * They are named in `@pierre/theming`'s collection all the same, so they are
 * eight more chunks unless they are pruned.
 */
export const CATALOG_CODE_THEMES = ['pierre-light', 'pierre-dark'] as const;

/** One of the two palettes a code surface in this package is painted with. */
export type CatalogCodeTheme = (typeof CATALOG_CODE_THEMES)[number];

/**
 * What each language a transform can be WRITTEN in is HIGHLIGHTED as.
 *
 * The two vocabularies are not the same and should not be conflated. A
 * transform's language is what the runtime executes — `TRANSFORM_LANGUAGES`,
 * answered by the deployment's `/capabilities` — while a grammar is what the
 * editor tokenises with, and TSX is deliberately the answer for both JavaScript
 * and TypeScript: it is a superset of each, so it colours a plain `.js` body
 * correctly while also surviving the type annotations in the TypeScript starter.
 * Shipping `javascript` and `typescript` beside it would be another 366 KB of
 * `@shikijs/langs` (181 + 186) for output no reader could tell apart.
 *
 * The `satisfies` is the load-bearing part. It is what turns "somebody added a
 * fourth transform language" from a pane that silently loses its colours into
 * two compile errors: a missing key here, and — if the answer names a grammar
 * the bundle does not carry — a value that is not a {@link CatalogCodeLanguage}.
 */
export const TRANSFORM_HIGHLIGHTED_AS = {
  javascript: 'tsx',
  typescript: 'tsx',
  python: 'python',
} satisfies Record<TransformLanguage, CatalogCodeLanguage>;
