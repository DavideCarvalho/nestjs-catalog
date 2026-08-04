import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

const pkg = (name: string, entry = 'src/index.ts') =>
  fileURLToPath(new URL(`./packages/${name}/${entry}`, import.meta.url));

export default defineConfig({
  // Workspace packages resolve to their TS SOURCE, so a cross-package test never runs against a
  // stale `dist/`. Production builds still go through `tsc` per package.
  resolve: {
    alias: {
      '@dudousxd/nestjs-catalog': pkg('catalog'),
      '@dudousxd/nestjs-catalog-pipeline': pkg('pipeline'),
      '@dudousxd/nestjs-catalog-store-mikro-orm': pkg('store-mikro-orm'),
      '@dudousxd/nestjs-catalog-store-clickhouse': pkg('store-clickhouse'),
      '@dudousxd/nestjs-catalog-store-fanout': pkg('store-fanout'),
      '@dudousxd/nestjs-catalog-telescope': pkg('telescope'),
      '@dudousxd/nestjs-catalog-dashboard': pkg('dashboard', 'src/server/index.ts'),
    },
  },
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
