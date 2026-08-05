---
'@dudousxd/nestjs-catalog-react': minor
'@dudousxd/nestjs-catalog-dashboard': minor
---

Only the four grammars this console renders

**The defect.** The changeset beside this one swapped a hand-rolled editor for
`@pierre/diffs`, which resolves a language by looking its name up in Shiki's
`bundledLanguages` — ~240 entries whose values are
`() => import('@shikijs/langs/<name>')` — and a theme the same way through
`@pierre/theming`. A bundler cannot tree-shake a dynamic import selected by a
runtime key, so it emits a chunk for every entry. `packages/dashboard`'s SPA came
out as **319 JS chunks, 12.42 MB minified**, of which 242 were grammars (7.47 MB)
and 75 were themes (1.58 MB), for a console that renders SQL, JSON, TSX and
Python in two palettes. This library's contract is that embedding it must not
degrade the host, so that is a defect and not a tradeoff.

**The measurement, and what it does not say.** Built twice from the same tree,
with and without the fix:

| `packages/dashboard/dist/spa` | before | after |
| --- | --- | --- |
| entry chunk | 2836.1 KB min / 867.1 KB gzip | 2826.5 KB / 861.8 KB |
| JS chunks | 319 | 8 |
| total | 12.42 MB min / 2.62 MB gzip | 3.67 MB / 1.10 MB |
| on disk | 12.50 MB | 3.75 MB |

**The entry barely moves, and that is the honest headline.** Every one of those
grammar chunks was already lazy — none of them was on the first-paint path — so
this buys nothing at all for time-to-interactive. What it buys is 8.75 MB and 311
files that a host no longer builds, uploads, caches or pays for at the CDN, and a
`dist/` whose contents can be accounted for. Installed size is unchanged: the
grammars are still in `node_modules`, they are simply no longer bundled.

**How.** A new build plugin, on its own subpath so it never reaches a browser
graph:

```ts
import { shikiSubset } from '@dudousxd/nestjs-catalog-react/bundler';

export default defineConfig({ plugins: [react(), shikiSubset()] });
```

It rewrites every `import('@shikijs/langs/…')`, `import('@shikijs/themes/…')` and
`import('@pierre/theme/…')` outside the subset into a loader that rejects naming
the grammar it wanted. There is then no `import()` for Rollup to split on, so
there is no chunk — where resolving those specifiers to a stub module would have
left ~320 chunks, only tiny ones.

**It cannot quietly stop working**, which is the part that matters more than the
megabytes. Four independent gates:

- `CodeEditor`'s `language` prop and `DiffBody`'s are now `CatalogCodeLanguage`,
  derived from the set. A grammar the bundle does not carry is a compile error at
  the call site. **This is breaking in the 0.x sense** — the prop was `string`.
- `TRANSFORM_HIGHLIGHTED_AS` says what each transform language is highlighted as
  and `satisfies Record<TransformLanguage, CatalogCodeLanguage>`, so a fourth
  entry in `TRANSFORM_LANGUAGES` is a compile error until somebody answers for
  it. It replaces `language === 'python' ? 'python' : 'tsx'` in
  `TransformEditor`, which answered a fourth language silently and wrongly.
- `shikiSubset()` fails the **build** if any kept name is missing from the
  registry it prunes, or if a registry never reaches it at all — so a Shiki
  rename, a typo, or a generated shape this no longer matches stops the build
  instead of silently pruning nothing.
- A spec scans this package's sources for `language="…"` and `lang: '…'` literals
  and fails on one the bundle does not carry, which is the only gate that sees a
  `lang` handed straight to `@pierre/diffs` past our own prop types.

**New exports.** `shikiSubset` and `ShikiSubsetPlugin` from
`@dudousxd/nestjs-catalog-react/bundler`; `CATALOG_CODE_LANGUAGES`,
`CATALOG_CODE_THEMES`, `CatalogCodeLanguage`, `CatalogCodeTheme` and
`TRANSFORM_HIGHLIGHTED_AS` from the main entry.

**The set, and why it is that set.** `sql` (the query console and a saved query's
diff), `json` (the transform editor's sample pane), `python` and `tsx` (its code
pane). TSX covers both JavaScript and TypeScript transforms because it is a
superset of each; shipping those two grammars beside it would be another 366 KB
of `@shikijs/langs` for output no reader could tell apart. The themes are `pierre-light` and
`pierre-dark`, which is what `@pierre/diffs`' `DEFAULT_THEMES` resolves to and
what this package never overrides — Shiki's own 65 and Pierre's other eight are
reachable only by naming one, which nothing here does.

**Still there:** the 622 KB `shiki/wasm` chunk. `@pierre/diffs` defaults to the
JavaScript regex engine and only fetches the WASM one if a caller asks for
`preferredHighlighter: 'shiki-wasm'`, so it is emitted and never loaded — but it
is a capability a caller can legitimately want, and pruning it would take that
away rather than take away waste.
