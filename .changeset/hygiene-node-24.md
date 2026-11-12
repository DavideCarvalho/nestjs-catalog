---
"@dudousxd/nestjs-catalog": minor
"@dudousxd/nestjs-catalog-dashboard": minor
"@dudousxd/nestjs-catalog-pipeline": minor
"@dudousxd/nestjs-catalog-react": minor
"@dudousxd/nestjs-catalog-secrets-aws": minor
"@dudousxd/nestjs-catalog-secrets-vault": minor
"@dudousxd/nestjs-catalog-store-clickhouse": minor
"@dudousxd/nestjs-catalog-store-duckdb": minor
"@dudousxd/nestjs-catalog-store-fanout": minor
"@dudousxd/nestjs-catalog-store-mikro-orm": minor
"@dudousxd/nestjs-catalog-telescope": minor
---

**Breaking:** require Node.js 24 or newer. Every package declares `engines.node >= 24` (most declared none before; `-secrets-vault` said `>=18`, `-telescope` `>=22`). CI tests on Node 24 and 26.

- `@dudousxd/nestjs-catalog-telescope`: removed the default export, a duplicate of `catalogTelescopeExtension` that broke default imports from ESM in some bundlers. Import it by name.
- `@dudousxd/nestjs-catalog-react`: relative imports in the published files now carry their `.js` extension, so the package and its types resolve under TypeScript's `node16`/`nodenext` resolution, not only under a bundler.
- Every CommonJS package now declares `"type": "commonjs"`.
