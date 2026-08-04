import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

/**
 * The REAL-engine matrix: only `*.db.spec.ts`, which boot MySQL and ClickHouse through
 * testcontainers and run the store contract against them. Invoked by `pnpm test:db`.
 *
 * Standalone rather than a merge of `vitest.config.ts`, because vitest's `mergeConfig`
 * CONCATENATES `include`/`exclude` — merging would re-add the base globs (running everything) and
 * re-apply the base's `*.db.spec.ts` exclusion, skipping the very files this exists to run.
 *
 * Long timeouts because a cold image pull dominates the first run; the cases are fast once up.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@dudousxd/nestjs-catalog': pkg('catalog'),
      '@dudousxd/nestjs-catalog-pipeline': pkg('pipeline'),
      '@dudousxd/nestjs-catalog-store-mikro-orm': pkg('store-mikro-orm'),
      '@dudousxd/nestjs-catalog-store-clickhouse': pkg('store-clickhouse'),
      '@dudousxd/nestjs-catalog-store-fanout': pkg('store-fanout'),
    },
  },
  plugins: [
    swc.vite({
      jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/*/src/**/*.db.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 120_000,
    hookTimeout: 300_000,
    // One engine at a time: parallel containers contend for ports and memory, and a flaky
    // container is indistinguishable from a flaky adapter in the report.
    fileParallelism: false,
  },
});
