/**
 * The grammar set, and the two holes a type cannot cover.
 *
 * Most of what keeps this list honest is the compiler: `CodeEditor`'s `language`
 * prop is `CatalogCodeLanguage`, and `TRANSFORM_HIGHLIGHTED_AS` `satisfies
 * Record<TransformLanguage, CatalogCodeLanguage>`, so a fourth transform
 * language or a grammar the bundle does not carry is a compile error before it
 * is anything else. Two things get past that and are asserted here instead.
 *
 * 1. `satisfies` can be deleted. The clause is one line and removing it turns
 *    the map back into a plain object that agrees with nothing; the first test
 *    re-asks the question at runtime.
 * 2. `@pierre/diffs` takes a `lang` on its own `File` and `MultiFileDiff`, and a
 *    component in this package could hand one straight to it — past
 *    `CodeEditor`, past the prop type, and into a pane that renders as plain
 *    text. The source scan is the only thing that sees that.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { TRANSFORM_LANGUAGES } from '@dudousxd/nestjs-catalog/client';
import { describe, expect, it } from 'vitest';
import { CATALOG_CODE_LANGUAGES, TRANSFORM_HIGHLIGHTED_AS } from './code-languages';

describe('the code-surface language set', () => {
  it('says what every language a transform can be written in is highlighted as', () => {
    // The `satisfies` in the source says this at compile time. Said again here
    // because a `satisfies` is one clause somebody can drop while "fixing a type
    // error", and the symptom of dropping it is a pane that quietly loses its
    // colours three releases later.
    expect(Object.keys(TRANSFORM_HIGHLIGHTED_AS).sort()).toEqual([...TRANSFORM_LANGUAGES].sort());
  });

  it('only highlights them as grammars the bundle carries', () => {
    for (const grammar of Object.values(TRANSFORM_HIGHLIGHTED_AS)) {
      expect(CATALOG_CODE_LANGUAGES).toContain(grammar);
    }
  });

  it('carries no grammar nothing asks for', () => {
    // The other direction, and the one that keeps this from becoming a junk
    // drawer: every name in the set has to be reachable from a `language=` in
    // this package or from the transform table. A grammar nobody renders is
    // 175 KB of chunk with no screen behind it.
    const asked = new Set([...literals(), ...Object.values(TRANSFORM_HIGHLIGHTED_AS)]);

    expect([...CATALOG_CODE_LANGUAGES].filter((language) => !asked.has(language))).toEqual([]);
  });

  it('covers every language literal handed to a code surface', () => {
    for (const [language, where] of literalsWithSource()) {
      expect(
        CATALOG_CODE_LANGUAGES,
        `${where} renders \`${language}\`, which is not in CATALOG_CODE_LANGUAGES. The bundle does not carry that grammar, so the pane would render as plain text.`,
      ).toContain(language);
    }
  });
});

/**
 * Every literal language this package hands to a code surface, with its file.
 *
 * Both spellings, because there are two doors. `language="sql"` is this
 * package's own prop, which the compiler already checks; `lang: 'sql'` is
 * `@pierre/diffs`' own field on `File` and `MultiFileDiff`, which anything here
 * can construct directly and which no type of ours sees.
 *
 * Only LITERALS. `lang: language` forwards a value the prop type has already
 * vouched for, and reading it here would mean asserting on the identifier
 * `language`, which is not a grammar and never was.
 */
function literalsWithSource(): [string, string][] {
  const found: [string, string][] = [];
  // `..` from this file is `packages/react/src`, with the trailing slash a
  // directory URL carries; dropped so the paths reported below read as paths.
  for (const file of sources(new URL('..', import.meta.url).pathname.replace(/\/$/, ''))) {
    if (file.endsWith('.spec.ts') || file.endsWith('.spec.tsx')) continue;
    const code = readFileSync(file, 'utf8');
    for (const match of code.matchAll(/\b(?:language=|lang:\s*)(['"])([\w-]+)\1/g)) {
      found.push([match[2] ?? '', file.slice(file.indexOf('/src/') + 1)]);
    }
  }
  return found;
}

function literals(): string[] {
  return literalsWithSource().map(([language]) => language);
}

/** Every `.ts`/`.tsx` under a directory. */
function sources(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) files.push(...sources(path));
    else if (path.endsWith('.ts') || path.endsWith('.tsx')) files.push(path);
  }
  return files;
}
