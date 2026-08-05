// The workspace package -> TS source map, read out of `tsconfig.spec.base.json` so there is exactly
// one list of it in the repo.
//
// There used to be three, and they disagreed. `vitest.config.ts` had no entry for
// `@dudousxd/nestjs-catalog-react`, so every spec importing that package by name resolved to
// `packages/react/dist/` — gitignored, built by hand, and a whole release behind source; a spec
// asserting the console mounts a screen passed or failed on whether somebody had recently run `tsc`
// in another package. `vitest.db.config.ts` had its own shorter list. And `tsc`, resolving the same
// names through node_modules, was checking the `.d.ts` in that same stale dist while vitest ran the
// source — so the typechecker and the test runner were looking at two different programs and
// neither of them was the one under review.
//
// Deriving all of it from the tsconfig means adding a package is one line, in one file, and the
// typechecker and both test runners pick it up together or not at all.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../', import.meta.url);

/**
 * Vite/Rollup alias entries for every workspace package named in `tsconfig.spec.base.json`.
 *
 * Sorted longest specifier first, which is load-bearing rather than tidy: Rollup's alias matcher
 * takes the FIRST entry where the specifier equals the alias or starts with `alias + '/'`, so a
 * bare `@dudousxd/nestjs-catalog` listed above `@dudousxd/nestjs-catalog/client` swallows the
 * subpath and rewrites it to `.../src/index.ts/client`, which resolves to nothing. Every React
 * screen imports that subpath for real, so getting this backwards makes a whole package untestable.
 * (Sibling names like `@dudousxd/nestjs-catalog-pipeline` are safe either way — the matcher wants a
 * `/` boundary, not a bare prefix.)
 *
 * @returns {{ find: string, replacement: string }[]}
 */
export function workspaceAliases() {
  const spec = JSON.parse(readFileSync(new URL('tsconfig.spec.base.json', ROOT), 'utf8'));
  const paths = spec.compilerOptions?.paths ?? {};

  return Object.entries(paths)
    .sort(([a], [b]) => b.length - a.length)
    .map(([find, targets]) => {
      const target = targets[0];
      if (!target) throw new Error(`tsconfig.spec.base.json: "${find}" maps to nothing`);
      return { find, replacement: fileURLToPath(new URL(target, ROOT)) };
    });
}
