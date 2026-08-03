import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
