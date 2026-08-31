import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';
import { workspaceAliases } from './scripts/workspace-aliases.mjs';

export default defineConfig({
  // Workspace packages resolve to their TS SOURCE, so a cross-package test never runs against a
  // stale `dist/`. Production builds still go through `tsc` per package.
  //
  // The list itself lives in `tsconfig.spec.base.json`, which the spec typechecks also read, so
  // `tsc` and `vitest` cannot end up looking at two different programs. That is not hypothetical:
  // this block was missing `@dudousxd/nestjs-catalog-react` entirely, and the packages/react/dist/
  // it silently fell back to was a release behind. See scripts/workspace-aliases.mjs.
  resolve: { alias: workspaceAliases() },
  plugins: [
    // Emits `emitDecoratorMetadata`, which NestJS DI needs and esbuild cannot produce. Without it
    // every module test fails resolving constructor parameters, which reads as a wiring bug.
    swc.vite({
      jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript', tsx: true, decorators: true },
        transform: {
          legacyDecorator: true,
          decoratorMetadata: true,
          react: { runtime: 'automatic' },
        },
      },
    }),
  ],
  test: {
    globals: true,
    environment: 'node',
    // Runs in every worker, and is a no-op outside jsdom. See the file itself for
    // what Node 24+ takes away from a jsdom spec and why nothing here can borrow
    // it back from jsdom.
    setupFiles: ['./test/jsdom-web-storage.ts'],
    include: ['packages/*/src/**/*.{test,spec}.{ts,tsx}'],
    // `*.db.spec.ts` boot real engines through testcontainers — run them via `pnpm test:db`
    // (vitest.db.config.ts) so the default suite stays fast and needs no Docker.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.db.spec.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['packages/*/src/**/*.{test,spec}.ts', 'packages/*/src/index.ts'],
    },
  },
});
