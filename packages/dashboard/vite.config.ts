import { resolve } from 'node:path';
import { shikiSubset } from '@dudousxd/nestjs-catalog-react/bundler';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  // `shikiSubset` is not an optimisation to revisit later — without it this SPA
  // emits a chunk for each of Shiki's ~240 grammars and ~75 themes, because
  // `@pierre/diffs` resolves both by runtime name out of a registry no bundler
  // can shake. Measured by building this config with and without it: 319 JS
  // chunks / 12.42 MB minified / 2.62 MB gzipped before, 8 / 3.67 MB / 1.10 MB
  // after, for a console that renders four grammars in two palettes. The ENTRY
  // barely moves (2836 → 2827 KB) and was never the problem; what goes is a
  // `dist/spa` that was nine tenths grammars nothing here can execute. The
  // plugin fails the build if the subset stops matching what those packages
  // offer, so it cannot quietly become a no-op.
  plugins: [react(), tailwindcss(), shikiSubset()],
  // One copy of each, and this is not tidiness: React context is per module
  // instance, so a second `@tanstack/react-query` makes the provider this SPA
  // mounts invisible to the hooks inside `@dudousxd/nestjs-catalog-react`. The
  // console then dies at first render with "No QueryClient set, use
  // QueryClientProvider to set one" — pointing at the provider, which is there.
  resolve: {
    dedupe: ['react', 'react-dom', '@tanstack/react-query'],
  },
  // The SPA is served under /catalog; the controller rewrites this base when mounted elsewhere.
  base: '/catalog/',
  build: {
    // The catalog packages compile to CommonJS (`module: nodenext`, no
    // `"type": "module"`), and workspace links resolve to real paths that
    // Rollup would otherwise treat as ESM — so a named import of
    // `catalogRoutes` fails with "not exported by ../catalog/dist/client.js".
    // Including them here runs them through the CJS interop that a published
    // dependency inside node_modules gets for free.
    commonjsOptions: {
      include: [/node_modules/, /packages\/(catalog|react|pipeline)\/dist/],
    },
    outDir: 'dist/spa',
    emptyOutDir: true,
    rollupOptions: {
      input: { index: resolve(__dirname, 'index.html') },
    },
  },
});
