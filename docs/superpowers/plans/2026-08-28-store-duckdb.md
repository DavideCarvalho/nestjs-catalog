# `@dudousxd/nestjs-catalog-store-duckdb` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `CatalogWriteStore` adapter that keeps object rows as Parquet objects in blob storage and reads them through DuckDB, passing the repo's shared store contract.

**Architecture:** One Parquet object per `(snapshot, batch)` at a deterministic key, so a retried durable step overwrites itself rather than appending. DuckDB writes them with `COPY … TO … (FORMAT PARQUET)` and reads them back with `read_parquet` over a glob. Snapshot bookkeeping — which loads exist, which one is served, which are tombstoned — goes through a small `SnapshotCatalog` port so the package is deployable with nothing but a bucket, while a host that has a transactional database can bind a better one. Blob access goes through an `ObjectStore` port with a local-filesystem binding, which is what makes the contract suite runnable without Docker.

**Tech Stack:** TypeScript 5.9.3, `@duckdb/node-api`, NestJS 11, vitest + testcontainers, pnpm 11.5.0, biome.

**Spec:** `/home/dudousxd/goflipai/flip-nestjs/docs/superpowers/specs/2026-08-28-flip-catalog-extraction-design.md` — read it first; this plan implements the section "The new package: `@dudousxd/nestjs-catalog-store-duckdb`" and nothing else.

## Global Constraints

- **Repo:** `/home/dudousxd/personal/oss/nestjs/nestjs-catalog`. All paths below are relative to it.
- **Package manager:** `pnpm@11.5.0`. Never `npm`.
- **Dependency versions are exact.** No `^`, no `~`. Copy the style of `packages/store-clickhouse/package.json`.
- **Style:** biome — single quotes, 2-space indent, line width 100. `pnpm lint` must pass.
- **TypeScript:** `strict: true` with `strictPropertyInitialization: false`. Never `any`, never `as` to silence an error, never `unknown` cast through. Narrow with predicates.
- **Prefer function declarations** over arrow consts for module-level functions.
- **Docblocks carry the reasoning.** This repo's house style is dense explanatory comments that say *why*, and the contract suite quotes them. Match it. Never write changelog-style comments ("this used to be X") and never write a manual for a library — explain the decision this code encodes.
- **Compression is SNAPPY, always.** Anything else requires `hyparquet-compressors`, which has had no commit since 2025-03-20 and fails on DuckDB-written LZ4_RAW.
- **Never write a Parquet DECIMAL column.** `hyparquet-writer#38` (open) writes wrong statistics for DECIMAL, and a reader that prunes on statistics then silently returns no rows. The scalar mapping in Task 3 has no path to DECIMAL; keep it that way.
- **Scalar types** are exactly `'string' | 'number' | 'boolean' | 'date' | 'json' | 'uuid' | 'unknown'` (`packages/catalog/src/catalog.types.ts:21`).
- **Reserved columns** are `_snapshot_id`, `_principal_id`, `_loaded_at`, `_batch`, `_row`. Import the list from the core package; never re-declare it.
- **Commit after every task.** Conventional commits (`feat:`, `test:`, `fix:`, `chore:`).

---

## File Structure

All new files live under `packages/store-duckdb/`.

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `tsconfig.spec.json` | package scaffolding, mirroring `store-clickhouse` |
| `src/options.ts` | options interface + the options token. Separate from the module because Nest resolves a circular import to `undefined` at injection time and reports it against the argument position, not the cycle. |
| `src/object-store.ts` | the `ObjectStore` port + `localObjectStore()` |
| `src/identifiers.ts` | `ident()`, table/prefix naming, reserved-column re-export |
| `src/column-types.ts` | scalar ↔ DuckDB type, `coerce` (in), `normalise` (out) |
| `src/snapshots.ts` | the `SnapshotCatalog` port + `objectSnapshotCatalog()` |
| `src/duckdb.ts` | the DuckDB instance/connection seam and `configureS3()` |
| `src/duckdb-warehouse.store.ts` | the store itself |
| `src/store.module.ts` | Nest wiring, binds `CATALOG_STORE` |
| `src/index.ts` | public surface |
| `src/*.spec.ts` | unit specs (run by `pnpm test`) |
| `src/duckdb-warehouse.db.spec.ts` | the shared contract (run by `pnpm test:db`) |

Modified: `tsconfig.spec.base.json` (one `paths` line), `.github/workflows/ci.yml` (a `test:db` job).

## Storage layout

Locked here so every task agrees:

```
<root>/<type>/<snapshotId>/part-<batch>.parquet    rows, one object per batch
<root>/<type>/_snapshots/<snapshotId>.json         one snapshot record
<root>/<type>/_current.json                        the served pointer
```

`<root>` is `options.root` — a directory path or an `s3://bucket/prefix` URL. Batch numbers are
zero-padded to 6 digits so a lexicographic listing is also numeric order.

---

### Task 1: Package scaffolding, and a module that boots

**Files:**
- Create: `packages/store-duckdb/package.json`
- Create: `packages/store-duckdb/tsconfig.json`
- Create: `packages/store-duckdb/tsconfig.spec.json`
- Create: `packages/store-duckdb/src/options.ts`
- Create: `packages/store-duckdb/src/index.ts`
- Create: `packages/store-duckdb/src/store.module.ts`
- Modify: `tsconfig.spec.base.json` (the `paths` block, currently ending at the `react/workflow` line)
- Test: `packages/store-duckdb/src/store.module.spec.ts`

**Interfaces:**
- Consumes: `CATALOG_STORE` from `@dudousxd/nestjs-catalog`.
- Produces: `CatalogDuckDbStoreOptions { root: string; s3?: DuckDbS3Options; objectStore?: ObjectStore; snapshotCatalog?: SnapshotCatalog; memoryLimit?: string; threads?: number; tempDirectory?: string }`, `CATALOG_DUCKDB_OPTIONS`, `CatalogDuckDbStoreModule.forRoot(options)`.

- [ ] **Step 1: Create the package manifest**

`packages/store-duckdb/package.json`:

```json
{
  "name": "@dudousxd/nestjs-catalog-store-duckdb",
  "version": "0.0.0",
  "description": "DuckDB + Parquet warehouse store for @dudousxd/nestjs-catalog: one Parquet object per snapshot batch, read back through read_parquet.",
  "license": "MIT",
  "author": "Davide Carvalho",
  "repository": {
    "type": "git",
    "url": "https://github.com/DavideCarvalho/nestjs-catalog.git",
    "directory": "packages/store-duckdb"
  },
  "keywords": ["nestjs", "catalog", "duckdb", "parquet", "warehouse", "snapshots"],
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsc -p tsconfig.json --watch"
  },
  "peerDependencies": {
    "@duckdb/node-api": ">=1.4",
    "@dudousxd/nestjs-catalog": ">=0.1",
    "@nestjs/common": ">=10"
  },
  "devDependencies": {
    "@duckdb/node-api": "1.5.5-r.4",
    "@dudousxd/nestjs-catalog": "workspace:*",
    "@nestjs/common": "11.1.19",
    "@types/node": "25.6.0",
    "typescript": "5.9.3"
  }
}
```

`repository.directory` is not decoration — npm provenance fails without it.

- [ ] **Step 2: Copy the two tsconfigs verbatim from the ClickHouse package**

```bash
cd /home/dudousxd/personal/oss/nestjs/nestjs-catalog
cp packages/store-clickhouse/tsconfig.json packages/store-duckdb/tsconfig.json
cp packages/store-clickhouse/tsconfig.spec.json packages/store-duckdb/tsconfig.spec.json
```

`tsconfig.spec.json` is not optional: `scripts/typecheck-specs.mjs` hard-fails a package that has specs and no spec config.

- [ ] **Step 3: Register the package in the spec path map**

In `tsconfig.spec.base.json`, add to `paths`, after the `store-clickhouse` line:

```json
      "@dudousxd/nestjs-catalog-store-duckdb": ["./packages/store-duckdb/src/index.ts"],
```

Both `vitest.config.ts` and `vitest.db.config.ts` derive their aliases from this map via
`scripts/workspace-aliases.mjs`. Without the line, a spec importing the package by name resolves to a
`dist/` that does not exist yet.

- [ ] **Step 4: Write the failing test**

`packages/store-duckdb/src/store.module.spec.ts`:

```ts
import { CATALOG_STORE } from '@dudousxd/nestjs-catalog';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { CatalogDuckDbStoreModule } from './store.module';

describe('CatalogDuckDbStoreModule', () => {
  it('refuses to boot without a root, rather than inventing one', () => {
    // A store that silently writes somewhere plausible is a store that lands a
    // production snapshot in a developer's home directory. The ClickHouse
    // adapter refuses a default URL for the same reason.
    expect(() => CatalogDuckDbStoreModule.forRoot({ root: '' })).toThrow(/root/i);
  });

  it('binds CATALOG_STORE to the DuckDB store', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [CatalogDuckDbStoreModule.forRoot({ root: '/tmp/catalog-duckdb-boot' })],
    }).compile();
    expect(moduleRef.get(CATALOG_STORE)).toBeDefined();
  });
});
```

- [ ] **Step 5: Run it and watch it fail**

```bash
cd /home/dudousxd/personal/oss/nestjs/nestjs-catalog
pnpm vitest run packages/store-duckdb/src/store.module.spec.ts
```

Expected: FAIL — cannot resolve `./store.module`.

- [ ] **Step 6: Write the options**

`packages/store-duckdb/src/options.ts`:

```ts
import type { ObjectStore } from './object-store';
import type { SnapshotCatalog } from './snapshots';

export const CATALOG_DUCKDB_OPTIONS = Symbol('CATALOG_DUCKDB_OPTIONS');

/** Credentials for an `s3://` root. Omit to let DuckDB use the AWS credential chain. */
export interface DuckDbS3Options {
  region?: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  /** `vhost` (default) or `path`, for S3-compatible servers that need the latter. */
  urlStyle?: 'vhost' | 'path';
  useSsl?: boolean;
}

export interface CatalogDuckDbStoreOptions {
  /**
   * Where snapshots live: a directory path, or `s3://bucket/prefix`.
   *
   * Required, with no default. See the refusal in `store.module.ts`.
   */
  root: string;
  s3?: DuckDbS3Options;
  /** Overrides the binding derived from {@link root}. Supplied by tests and by hosts with their own transport. */
  objectStore?: ObjectStore;
  /** Overrides the object-backed default. A host with a transactional database should bind one. */
  snapshotCatalog?: SnapshotCatalog;
  /**
   * DuckDB's defaults are every core and 80% of RAM, which is measured against
   * the machine rather than the cgroup — so a pod with a memory limit is
   * OOMKilled by a query that DuckDB believed was within budget.
   */
  memoryLimit?: string;
  threads?: number;
  tempDirectory?: string;
}
```

- [ ] **Step 7: Write the module**

`packages/store-duckdb/src/store.module.ts`:

```ts
import { CATALOG_STORE } from '@dudousxd/nestjs-catalog';
import { type DynamicModule, Module } from '@nestjs/common';
import { DuckDbWarehouseStore } from './duckdb-warehouse.store';
import { CATALOG_DUCKDB_OPTIONS, type CatalogDuckDbStoreOptions } from './options';

@Module({})
// A class with only static members, because in Nest the CLASS IS THE TOKEN: a module is
// identified by its constructor reference, so an object or a bare factory has no identity
// the injector can register.
// biome-ignore lint/complexity/noStaticOnlyClass: see above
export class CatalogDuckDbStoreModule {
  static forRoot(options: CatalogDuckDbStoreOptions): DynamicModule {
    if (!options.root) {
      throw new Error(
        'CatalogDuckDbStoreModule.forRoot needs a `root` — a directory or an s3:// URL. Refusing to default, because a store that silently writes somewhere plausible is a store that lands a production snapshot in a developer\'s home directory.',
      );
    }
    return {
      module: CatalogDuckDbStoreModule,
      global: false,
      providers: [
        { provide: CATALOG_DUCKDB_OPTIONS, useValue: options },
        DuckDbWarehouseStore,
        { provide: CATALOG_STORE, useExisting: DuckDbWarehouseStore },
      ],
      exports: [DuckDbWarehouseStore, CATALOG_STORE],
    };
  }
}
```

- [ ] **Step 8: Write a store stub so the module can resolve**

`packages/store-duckdb/src/duckdb-warehouse.store.ts` — a class with only the pieces this task
needs; every later task fills it in.

```ts
import { Inject, Injectable } from '@nestjs/common';
import { CATALOG_DUCKDB_OPTIONS, type CatalogDuckDbStoreOptions } from './options';

@Injectable()
export class DuckDbWarehouseStore {
  constructor(
    @Inject(CATALOG_DUCKDB_OPTIONS)
    private readonly options: CatalogDuckDbStoreOptions,
  ) {}

  /** The configured root, exposed so a host's own tooling reaches the same place the store does. */
  get root(): string {
    return this.options.root;
  }
}
```

- [ ] **Step 9: Write the public surface**

`packages/store-duckdb/src/index.ts`:

```ts
export { CATALOG_DUCKDB_OPTIONS, type CatalogDuckDbStoreOptions, type DuckDbS3Options } from './options';
export { CatalogDuckDbStoreModule } from './store.module';
export { DuckDbWarehouseStore } from './duckdb-warehouse.store';
```

- [ ] **Step 10: Install and run**

```bash
cd /home/dudousxd/personal/oss/nestjs/nestjs-catalog
pnpm install
pnpm vitest run packages/store-duckdb/src/store.module.spec.ts
```

Expected: PASS, 2 tests.

- [ ] **Step 11: Commit**

```bash
git add packages/store-duckdb tsconfig.spec.base.json pnpm-lock.yaml
git commit -m "feat(store-duckdb): package scaffolding and a module that refuses a default root"
```

---

### Task 2: Identifiers

**Files:**
- Create: `packages/store-duckdb/src/identifiers.ts`
- Test: `packages/store-duckdb/src/identifiers.spec.ts`
- Modify: `packages/store-duckdb/src/index.ts`

**Interfaces:**
- Consumes: `assertSafeIdentifier`, `physicalColumn`, `outputAlias`, `UnsafeIdentifierError`, `CATALOG_RESERVED_COLUMNS` from `@dudousxd/nestjs-catalog`.
- Produces: `ident(value: string): string`, `RESERVED_COLUMNS`, `SNAPSHOT_COLUMN`, `PRINCIPAL_COLUMN`, `LOADED_AT_COLUMN`, `BATCH_COLUMN`, `ROW_COLUMN`, `typePrefix(type: CatalogObjectTypeDef): string`, `snapshotPrefix(type, snapshotId): string`, `batchKey(type, snapshotId, batch): string`, `snapshotRecordKey(type, snapshotId): string`, `currentKey(type): string`.

- [ ] **Step 1: Write the failing test**

`packages/store-duckdb/src/identifiers.spec.ts`:

```ts
import { CATALOG_RESERVED_COLUMNS, UnsafeIdentifierError } from '@dudousxd/nestjs-catalog';
import { describe, expect, it } from 'vitest';
import { batchKey, currentKey, ident, RESERVED_COLUMNS, snapshotRecordKey } from './identifiers';

describe('ident', () => {
  it('quotes a safe identifier with double quotes, which is what DuckDB spells', () => {
    expect(ident('Asset_Id')).toBe('"Asset_Id"');
  });

  it('rejects an unsafe identifier rather than escaping it', () => {
    // This store issues DDL and reads globs. A name that got through by being
    // cleverly escaped rather than by being plainly safe is not a risk worth
    // carrying, so the rule is refusal.
    expect(() => ident('a"; drop table x --')).toThrow(UnsafeIdentifierError);
  });
});

describe('reserved columns', () => {
  it('takes the core package list rather than keeping a second copy', () => {
    // The ClickHouse adapter built this list locally and it agreed with the
    // core's by coincidence. Taking it is what makes the agreement a fact.
    expect(RESERVED_COLUMNS).toEqual(CATALOG_RESERVED_COLUMNS);
  });
});

describe('keys', () => {
  it('zero-pads the batch so a lexicographic listing is numeric order', () => {
    expect(batchKey('mvr', 'run-1', 7)).toBe('mvr/run-1/part-000007.parquet');
    expect(batchKey('mvr', 'run-1', 1000)).toBe('mvr/run-1/part-001000.parquet');
  });

  it('keeps snapshot records and the pointer out of the row prefix', () => {
    // `read_parquet('<type>/<snapshot>/*.parquet')` must never glob a record.
    expect(snapshotRecordKey('mvr', 'run-1')).toBe('mvr/_snapshots/run-1.json');
    expect(currentKey('mvr')).toBe('mvr/_current.json');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run packages/store-duckdb/src/identifiers.spec.ts
```

Expected: FAIL — cannot resolve `./identifiers`.

- [ ] **Step 3: Implement**

`packages/store-duckdb/src/identifiers.ts`:

```ts
import { assertSafeIdentifier, CATALOG_RESERVED_COLUMNS } from '@dudousxd/nestjs-catalog';

/**
 * The reserved columns, taken from the core package rather than rebuilt here.
 *
 * The ClickHouse adapter built its own list out of its own constants and agreed with the
 * core's by coincidence; the coincidence was the bug. Re-exported so this package's own
 * code has one name for them and a reader can see where they came from.
 */
export const RESERVED_COLUMNS = CATALOG_RESERVED_COLUMNS;

export const SNAPSHOT_COLUMN = '_snapshot_id';
export const PRINCIPAL_COLUMN = '_principal_id';
export const LOADED_AT_COLUMN = '_loaded_at';
export const BATCH_COLUMN = '_batch';
export const ROW_COLUMN = '_row';

/**
 * Quote an identifier for DuckDB, having first refused every name that is not plainly safe.
 *
 * Rejecting rather than escaping, because this file's output ends up in `COPY`, `CREATE
 * TABLE` and `read_parquet` globs — statements whose blast radius is a whole object or a
 * whole prefix. The character rule itself lives in the core package so all adapters agree
 * on what a safe name is.
 */
export function ident(value: string): string {
  assertSafeIdentifier(value);
  return `"${value}"`;
}

/** The prefix holding everything about one object type. */
export function typePrefix(typeName: string): string {
  return typeName.toLowerCase();
}

/** The prefix holding one snapshot's row objects, and nothing else. */
export function snapshotPrefix(typeName: string, snapshotId: string): string {
  return `${typePrefix(typeName)}/${snapshotId}`;
}

/**
 * One batch's object key.
 *
 * Derived from `(type, snapshot, batch)` and nothing else, which is the whole idempotence
 * story: the interface requires that a re-sent batch replace itself rather than append, and
 * a deterministic key makes that a property of the address rather than of a statement the
 * adapter has to get right.
 *
 * Zero-padded because a listing sorts lexicographically, and `part-10` before `part-9` is a
 * total order nobody wants to debug.
 */
export function batchKey(typeName: string, snapshotId: string, batch: number): string {
  return `${snapshotPrefix(typeName, snapshotId)}/part-${String(batch).padStart(6, '0')}.parquet`;
}

/** One snapshot's record, under a prefix the row glob cannot reach. */
export function snapshotRecordKey(typeName: string, snapshotId: string): string {
  return `${typePrefix(typeName)}/_snapshots/${snapshotId}.json`;
}

/** The served pointer for one type. */
export function currentKey(typeName: string): string {
  return `${typePrefix(typeName)}/_current.json`;
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
pnpm vitest run packages/store-duckdb/src/identifiers.spec.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Export from the index**

Add to `packages/store-duckdb/src/index.ts`:

```ts
export {
  BATCH_COLUMN,
  batchKey,
  currentKey,
  ident,
  LOADED_AT_COLUMN,
  PRINCIPAL_COLUMN,
  RESERVED_COLUMNS,
  ROW_COLUMN,
  snapshotPrefix,
  snapshotRecordKey,
  SNAPSHOT_COLUMN,
  typePrefix,
} from './identifiers';
```

- [ ] **Step 6: Commit**

```bash
git add packages/store-duckdb/src
git commit -m "feat(store-duckdb): identifiers and the deterministic key layout"
```

---

### Task 3: Column types

**Files:**
- Create: `packages/store-duckdb/src/column-types.ts`
- Test: `packages/store-duckdb/src/column-types.spec.ts`
- Modify: `packages/store-duckdb/src/index.ts`

**Interfaces:**
- Consumes: `ScalarType` from `@dudousxd/nestjs-catalog`.
- Produces: `duckDbType(type: ScalarType): string`, `coerce(value: unknown, type: ScalarType): string | number | boolean | null`, `normalise(value: unknown, type: ScalarType): unknown`.

- [ ] **Step 1: Write the failing test**

`packages/store-duckdb/src/column-types.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { coerce, duckDbType, normalise } from './column-types';

describe('duckDbType', () => {
  it('maps every scalar to a wide, nullable-friendly type', () => {
    expect(duckDbType('string')).toBe('VARCHAR');
    expect(duckDbType('number')).toBe('DOUBLE');
    expect(duckDbType('boolean')).toBe('BOOLEAN');
    expect(duckDbType('date')).toBe('TIMESTAMP WITH TIME ZONE');
    expect(duckDbType('uuid')).toBe('VARCHAR');
    expect(duckDbType('json')).toBe('VARCHAR');
    expect(duckDbType('unknown')).toBe('VARCHAR');
  });

  it('never produces DECIMAL', () => {
    // hyparquet-writer 0.16.8 writes wrong min/max statistics for DECIMAL
    // (hyparquet-writer#38, open), and a reader that prunes row groups on
    // statistics then returns no rows for a value the file contains. Nothing
    // in this mapping may reach that type.
    const produced = (['string', 'number', 'boolean', 'date', 'json', 'uuid', 'unknown'] as const)
      .map(duckDbType)
      .join(' ');
    expect(produced).not.toMatch(/DECIMAL/i);
  });
});

describe('coerce', () => {
  it('serialises json to text, because a nullable JSON column loses data through the writer', () => {
    expect(coerce({ a: 1 }, 'json')).toBe('{"a":1}');
  });

  it('renders a date as an ISO instant so the engine parses one thing', () => {
    expect(coerce(new Date('2026-01-02T03:04:05.000Z'), 'date')).toBe('2026-01-02T03:04:05.000Z');
    expect(coerce('2026-01-02T03:04:05.000Z', 'date')).toBe('2026-01-02T03:04:05.000Z');
  });

  it('passes null and undefined through as null, which is what nobody-sent-it means', () => {
    expect(coerce(null, 'string')).toBeNull();
    expect(coerce(undefined, 'number')).toBeNull();
  });

  it('refuses a number it cannot represent rather than storing NaN', () => {
    expect(coerce('not a number', 'number')).toBeNull();
  });
});

describe('normalise', () => {
  it('hands a date back as an ISO string, so two adapters agree on one rendering', () => {
    expect(normalise(new Date('2026-01-02T03:04:05.000Z'), 'date')).toBe(
      '2026-01-02T03:04:05.000Z',
    );
  });

  it('converts a bigint to a number, because JSON.stringify throws on one', () => {
    expect(normalise(42n, 'number')).toBe(42);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run packages/store-duckdb/src/column-types.spec.ts
```

Expected: FAIL — cannot resolve `./column-types`.

- [ ] **Step 3: Implement**

`packages/store-duckdb/src/column-types.ts`:

```ts
import type { ScalarType } from '@dudousxd/nestjs-catalog';

/**
 * The DuckDB type each catalog scalar lands in.
 *
 * Deliberately wide, and deliberately without DECIMAL. Width first: this store is
 * downstream of whatever a CSV had, and a load that fails because a value is one character
 * too long is a worse outcome than a column roomier than it needs to be.
 *
 * DECIMAL is a harder rule than a preference. `hyparquet-writer` 0.16.8 writes wrong
 * `min`/`max` statistics for it — a column whose only value is `123.45` is recorded as
 * `11786577.92` — and a reader that skips row groups on statistics then answers a query
 * that should match with no rows and no error. The archive writer already in this repo
 * avoids the type by mapping `number` to DOUBLE and everything else to text; this mapping
 * keeps that property on purpose rather than by luck.
 *
 * `json` and `uuid` are text for the same reason they are text in the archive: DuckDB's
 * UUID rejects anything that is not a well-formed UUID, and a JSON logical type is the one
 * the writer gets wrong. Text round-trips exactly, and the type the catalog declares
 * travels beside the data so a reader can undo this without guessing.
 */
export function duckDbType(type: ScalarType): string {
  switch (type) {
    case 'number':
      return 'DOUBLE';
    case 'boolean':
      return 'BOOLEAN';
    case 'date':
      return 'TIMESTAMP WITH TIME ZONE';
    case 'string':
    case 'json':
    case 'uuid':
    case 'unknown':
      return 'VARCHAR';
    default: {
      // Exhaustive: a scalar added to the core package must be answered here rather than
      // falling through to a default that silently stores it as text.
      const unreachable: never = type;
      throw new Error(`unmapped scalar type: ${String(unreachable)}`);
    }
  }
}

/** What a row value becomes on the way in. `null` means "nobody sent one". */
export function coerce(
  value: unknown,
  type: ScalarType,
): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  switch (type) {
    case 'number': {
      const asNumber = typeof value === 'bigint' ? Number(value) : Number(value);
      return Number.isFinite(asNumber) ? asNumber : null;
    }
    case 'boolean':
      return typeof value === 'boolean' ? value : Boolean(value);
    case 'date': {
      const asDate = value instanceof Date ? value : new Date(String(value));
      return Number.isNaN(asDate.getTime()) ? null : asDate.toISOString();
    }
    case 'json':
      return typeof value === 'string' ? value : JSON.stringify(value);
    default:
      return typeof value === 'string' ? value : String(value);
  }
}

/**
 * What a stored value becomes on the way out.
 *
 * Two adapters behind one interface returning two renderings of the same instant is a bug
 * that surfaces weeks later in a consumer, as a date that sorts wrongly or parses to
 * `Invalid Date`. So dates leave here as ISO strings, whatever the driver handed over.
 *
 * `bigint` is the other half: DuckDB returns INT64 as one, and `JSON.stringify` throws on a
 * bigint rather than rendering it — so a row that reached a response body untouched would
 * fail the serialiser rather than the read.
 */
export function normalise(value: unknown, type: ScalarType): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return Number(value);
  if (type === 'date' && typeof value === 'string') return new Date(value).toISOString();
  return value;
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
pnpm vitest run packages/store-duckdb/src/column-types.spec.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Export and commit**

Add `export { coerce, duckDbType, normalise } from './column-types';` to `src/index.ts`, then:

```bash
git add packages/store-duckdb/src
git commit -m "feat(store-duckdb): scalar type mapping that cannot reach DECIMAL"
```

---

### Task 4: The object store seam, with a local binding

**Files:**
- Create: `packages/store-duckdb/src/object-store.ts`
- Test: `packages/store-duckdb/src/object-store.spec.ts`
- Modify: `packages/store-duckdb/src/index.ts`

**Interfaces:**
- Produces:
  ```ts
  interface ObjectStore {
    get(key: string): Promise<{ body: string; etag: string } | undefined>;
    put(key: string, body: string): Promise<{ etag: string }>;
    putIfAbsent(key: string, body: string): Promise<{ etag: string } | undefined>;
    putIfMatch(key: string, body: string, etag: string): Promise<{ etag: string } | undefined>;
    list(prefix: string): Promise<string[]>;
    deletePrefix(prefix: string): Promise<number>;
    /** How DuckDB spells a path under this store, for `COPY` and `read_parquet`. */
    locate(key: string): string;
  }
  function localObjectStore(root: string): ObjectStore
  ```
  `putIfAbsent` and `putIfMatch` return `undefined` on a losing race — the caller retries.

- [ ] **Step 1: Write the failing test**

`packages/store-duckdb/src/object-store.spec.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { localObjectStore, type ObjectStore } from './object-store';

let root: string;
let store: ObjectStore;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'catalog-duckdb-obj-'));
  store = localObjectStore(root);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('localObjectStore', () => {
  it('round-trips a body and reports an etag that changes with the content', async () => {
    const first = await store.put('a/b.json', '{"n":1}');
    const read = await store.get('a/b.json');
    expect(read?.body).toBe('{"n":1}');
    expect(read?.etag).toBe(first.etag);
    const second = await store.put('a/b.json', '{"n":2}');
    expect(second.etag).not.toBe(first.etag);
  });

  it('answers undefined for a key that was never written', async () => {
    expect(await store.get('nope.json')).toBeUndefined();
  });

  it('lets exactly one putIfAbsent win', async () => {
    // This is the create-if-absent half of the pointer swap. On S3 it is
    // `If-None-Match: *`; here it is an exclusive open. Both give the same
    // answer: the first write to finish succeeds and the rest are told no.
    const results = await Promise.all([
      store.putIfAbsent('race.json', 'one'),
      store.putIfAbsent('race.json', 'two'),
      store.putIfAbsent('race.json', 'three'),
    ]);
    expect(results.filter((result) => result !== undefined)).toHaveLength(1);
  });

  it('refuses a putIfMatch whose etag has moved', async () => {
    const written = await store.put('cas.json', 'v1');
    await store.put('cas.json', 'v2');
    expect(await store.putIfMatch('cas.json', 'v3', written.etag)).toBeUndefined();
  });

  it('accepts a putIfMatch on the current etag', async () => {
    const written = await store.put('cas2.json', 'v1');
    expect(await store.putIfMatch('cas2.json', 'v2', written.etag)).toBeDefined();
  });

  it('lists a prefix and deletes it whole', async () => {
    await store.put('p/one.parquet', 'x');
    await store.put('p/two.parquet', 'y');
    expect((await store.list('p')).sort()).toEqual(['p/one.parquet', 'p/two.parquet']);
    expect(await store.deletePrefix('p')).toBe(2);
    expect(await store.list('p')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run packages/store-duckdb/src/object-store.spec.ts
```

Expected: FAIL — cannot resolve `./object-store`.

- [ ] **Step 3: Implement**

`packages/store-duckdb/src/object-store.ts`:

```ts
import { createHash } from 'node:crypto';
import { mkdir, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';

/**
 * The blob transport, as three reads, three writes and a path.
 *
 * A port rather than an S3 client, for two reasons that pull the same way. The first is
 * testability: the contract suite is 21 cases against a real engine, and requiring MinIO to
 * run any of them would make the cheapest, most-run gate the slowest one. The second is
 * that the two writes this store actually depends on — create-if-absent and
 * compare-and-swap — exist on S3 as `If-None-Match: *` and `If-Match`, and exist on a
 * filesystem as an exclusive open and a stat-then-rename. Naming them here means the store
 * is written against the guarantee rather than against either implementation.
 *
 * `putIfAbsent` and `putIfMatch` answer `undefined` when they lose, never throw. Losing a
 * race is an ordinary outcome that the caller retries; an exception would make it look like
 * a fault.
 */
export interface ObjectStore {
  get(key: string): Promise<{ body: string; etag: string } | undefined>;
  put(key: string, body: string): Promise<{ etag: string }>;
  putIfAbsent(key: string, body: string): Promise<{ etag: string } | undefined>;
  putIfMatch(key: string, body: string, etag: string): Promise<{ etag: string } | undefined>;
  list(prefix: string): Promise<string[]>;
  deletePrefix(prefix: string): Promise<number>;
  /**
   * How DuckDB names this key.
   *
   * The store hands DuckDB a path for `COPY … TO` and `read_parquet`, and DuckDB reaches
   * the bytes itself rather than through this port — so the two must agree on one spelling.
   */
  locate(key: string): string;
}

function etagOf(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

/**
 * A directory on this machine, behaving like a bucket.
 *
 * What it is for: the contract suite, local development, and a single-node deployment. What
 * it is not for is a shared filesystem — the compare-and-swap below is a read followed by a
 * write, which is atomic against another process on the same host through the exclusive
 * open in `putIfAbsent` and is *not* atomic across NFS clients.
 */
export function localObjectStore(root: string): ObjectStore {
  const base = resolve(root);

  function pathFor(key: string): string {
    return join(base, key);
  }

  async function walk(directory: string, prefix: string, into: string[]): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const key = posix.join(prefix, entry.name);
      if (entry.isDirectory()) {
        await walk(join(directory, entry.name), key, into);
      } else {
        into.push(key);
      }
    }
  }

  return {
    async get(key) {
      const body = await readFile(pathFor(key), 'utf8').catch(() => undefined);
      return body === undefined ? undefined : { body, etag: etagOf(body) };
    },

    async put(key, body) {
      await mkdir(dirname(pathFor(key)), { recursive: true });
      await writeFile(pathFor(key), body, 'utf8');
      return { etag: etagOf(body) };
    },

    async putIfAbsent(key, body) {
      await mkdir(dirname(pathFor(key)), { recursive: true });
      // 'wx' fails when the file exists, and the check and the create are one syscall —
      // which is the whole point. A stat followed by a write has a window between them, and
      // the window is exactly what two workers committing at once find.
      const handle = await open(pathFor(key), 'wx').catch(() => undefined);
      if (!handle) return undefined;
      try {
        await handle.writeFile(body, 'utf8');
      } finally {
        await handle.close();
      }
      return { etag: etagOf(body) };
    },

    async putIfMatch(key, body, etag) {
      const current = await this.get(key);
      if (!current || current.etag !== etag) return undefined;
      await writeFile(pathFor(key), body, 'utf8');
      return { etag: etagOf(body) };
    },

    async list(prefix) {
      const found: string[] = [];
      await walk(pathFor(prefix), prefix, found);
      return found;
    },

    async deletePrefix(prefix) {
      const keys = await this.list(prefix);
      await rm(pathFor(prefix), { recursive: true, force: true });
      return keys.length;
    },

    locate(key) {
      return pathFor(key);
    },
  };
}

/** Whether a root names object storage rather than a directory. */
export function isS3Root(root: string): boolean {
  return root.startsWith('s3://');
}

/** Present so a caller can assert a local root exists before the store writes to it. */
export async function ensureLocalRoot(root: string): Promise<void> {
  await mkdir(resolve(root), { recursive: true });
  await stat(resolve(root));
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
pnpm vitest run packages/store-duckdb/src/object-store.spec.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Export and commit**

Add to `src/index.ts`:

```ts
export { ensureLocalRoot, isS3Root, localObjectStore, type ObjectStore } from './object-store';
```

```bash
git add packages/store-duckdb/src
git commit -m "feat(store-duckdb): object store port with a local binding and real compare-and-swap"
```

---

### Task 5: The snapshot catalog

**Files:**
- Create: `packages/store-duckdb/src/snapshots.ts`
- Test: `packages/store-duckdb/src/snapshots.spec.ts`
- Modify: `packages/store-duckdb/src/index.ts`

**Interfaces:**
- Consumes: `ObjectStore` (Task 4); `snapshotRecordKey`, `currentKey`, `typePrefix` (Task 2); `SnapshotRef`, `SnapshotArchiveRef` from `@dudousxd/nestjs-catalog`.
- Produces:
  ```ts
  interface SnapshotCatalog {
    put(typeName: string, ref: SnapshotRef): Promise<void>;
    find(typeName: string, snapshotId: string): Promise<SnapshotRef | undefined>;
    list(typeName: string, limit?: number): Promise<SnapshotRef[]>;
    current(typeName: string): Promise<string | undefined>;
    setCurrent(typeName: string, snapshotId: string): Promise<void>;
  }
  function objectSnapshotCatalog(objects: ObjectStore): SnapshotCatalog
  const SNAPSHOT_LIST_LIMIT = 500
  ```
  `list` returns newest first, tombstones included.

- [ ] **Step 1: Write the failing test**

`packages/store-duckdb/src/snapshots.spec.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SnapshotRef } from '@dudousxd/nestjs-catalog';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { localObjectStore } from './object-store';
import { objectSnapshotCatalog, type SnapshotCatalog } from './snapshots';

let root: string;
let catalog: SnapshotCatalog;

function ref(id: string, createdAt: string, overrides: Partial<SnapshotRef> = {}): SnapshotRef {
  return { id, createdAt, rowCount: 3, principalId: 'tester', ...overrides };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'catalog-duckdb-snap-'));
  catalog = objectSnapshotCatalog(localObjectStore(root));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('objectSnapshotCatalog', () => {
  it('round-trips a whole record rather than merging fields', async () => {
    await catalog.put('mvr', ref('run-1', '2026-01-01T00:00:00.000Z', { labels: { a: 'b' } }));
    const found = await catalog.find('mvr', 'run-1');
    expect(found).toEqual(ref('run-1', '2026-01-01T00:00:00.000Z', { labels: { a: 'b' } }));
  });

  it('finds a snapshot by id whatever its age, tombstone included', async () => {
    // A scan of the newest N turns "older than N loads" into "no such snapshot",
    // and those two sentences send a reader to different places.
    await catalog.put('age', ref('old', '2020-01-01T00:00:00.000Z', { droppedAt: '2026-01-01T00:00:00.000Z' }));
    for (let index = 0; index < 20; index += 1) {
      await catalog.put('age', ref(`new-${index}`, `2026-02-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`));
    }
    const found = await catalog.find('age', 'old');
    expect(found?.droppedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('lists newest first', async () => {
    await catalog.put('ord', ref('a', '2026-01-01T00:00:00.000Z'));
    await catalog.put('ord', ref('b', '2026-03-01T00:00:00.000Z'));
    await catalog.put('ord', ref('c', '2026-02-01T00:00:00.000Z'));
    expect((await catalog.list('ord')).map((each) => each.id)).toEqual(['b', 'c', 'a']);
  });

  it('has no current snapshot until one is set', async () => {
    expect(await catalog.current('fresh')).toBeUndefined();
    await catalog.setCurrent('fresh', 'run-9');
    expect(await catalog.current('fresh')).toBe('run-9');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run packages/store-duckdb/src/snapshots.spec.ts
```

Expected: FAIL — cannot resolve `./snapshots`.

- [ ] **Step 3: Implement**

`packages/store-duckdb/src/snapshots.ts`:

```ts
import type { SnapshotRef } from '@dudousxd/nestjs-catalog';
import { currentKey, snapshotRecordKey, typePrefix } from './identifiers';
import type { ObjectStore } from './object-store';

/**
 * How many snapshot records one list reads.
 *
 * Its own constant rather than a shared one. The two adapters already in this repo each set
 * 500 independently and each said the core package is where it belongs "if a third adapter
 * wants it" — but agreeing on an integer is not a dependency worth inventing between
 * packages that otherwise have none.
 */
export const SNAPSHOT_LIST_LIMIT = 500;

/**
 * Where this store remembers which loads exist and which one is served.
 *
 * A port, because the two shipped adapters answer it in opposite ways and both are right
 * about something. The MikroORM store keeps the pointer in a transactional table, which is
 * the strongest answer available when a transactional database is present. The ClickHouse
 * store keeps it in ClickHouse, arguing that requiring a second database "makes the adapter
 * undeployable without a second database, and it puts the pointer that decides what readers
 * see in a system that can be up while the one holding the data is down."
 *
 * With Parquet in object storage both arguments can be honoured: the default binding below
 * keeps the record beside the data, so a bucket is the only dependency, and a host that has
 * a transactional database binds one that uses it. The invariant every binding owes is that
 * **the snapshot a type is serving is never a tombstone** — `read` relies on it to avoid a
 * lookup on the hot path.
 */
export interface SnapshotCatalog {
  /** Write the whole record. Never a partial update: a merge would blank the fields it was not given. */
  put(typeName: string, ref: SnapshotRef): Promise<void>;
  /** Exact lookup, tombstone included, `undefined` only when it never existed. */
  find(typeName: string, snapshotId: string): Promise<SnapshotRef | undefined>;
  /** Newest first, tombstones included, bounded. */
  list(typeName: string, limit?: number): Promise<SnapshotRef[]>;
  current(typeName: string): Promise<string | undefined>;
  setCurrent(typeName: string, snapshotId: string): Promise<void>;
}

function isSnapshotRef(value: unknown): value is SnapshotRef {
  if (typeof value !== 'object' || value === null) return false;
  const candidate: Record<string, unknown> = { ...value };
  return typeof candidate.id === 'string' && typeof candidate.createdAt === 'string';
}

function parseRef(body: string): SnapshotRef | undefined {
  const parsed: unknown = JSON.parse(body);
  return isSnapshotRef(parsed) ? parsed : undefined;
}

/**
 * Records and pointer as objects beside the rows.
 *
 * `find` is a single GET at a derived key rather than a scan, which is what lets it answer
 * about a snapshot older than any bound. `list` reads the record prefix, which is the one
 * operation here whose cost grows with history — bounded by {@link SNAPSHOT_LIST_LIMIT},
 * and the reason `find` is not implemented on top of it.
 */
export function objectSnapshotCatalog(objects: ObjectStore): SnapshotCatalog {
  return {
    async put(typeName, ref) {
      await objects.put(snapshotRecordKey(typeName, ref.id), JSON.stringify(ref));
    },

    async find(typeName, snapshotId) {
      const found = await objects.get(snapshotRecordKey(typeName, snapshotId));
      return found ? parseRef(found.body) : undefined;
    },

    async list(typeName, limit = SNAPSHOT_LIST_LIMIT) {
      const keys = await objects.list(`${typePrefix(typeName)}/_snapshots`);
      const refs: SnapshotRef[] = [];
      for (const key of keys) {
        const found = await objects.get(key);
        const ref = found ? parseRef(found.body) : undefined;
        if (ref) refs.push(ref);
      }
      refs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      return refs.slice(0, limit);
    },

    async current(typeName) {
      const found = await objects.get(currentKey(typeName));
      if (!found) return undefined;
      const parsed: unknown = JSON.parse(found.body);
      if (typeof parsed !== 'object' || parsed === null) return undefined;
      const snapshotId: unknown = { ...parsed }.snapshotId;
      return typeof snapshotId === 'string' ? snapshotId : undefined;
    },

    async setCurrent(typeName, snapshotId) {
      await objects.put(currentKey(typeName), JSON.stringify({ snapshotId }));
    },
  };
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
pnpm vitest run packages/store-duckdb/src/snapshots.spec.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Export and commit**

Add to `src/index.ts`:

```ts
export {
  objectSnapshotCatalog,
  SNAPSHOT_LIST_LIMIT,
  type SnapshotCatalog,
} from './snapshots';
```

```bash
git add packages/store-duckdb/src
git commit -m "feat(store-duckdb): snapshot catalog port with an object-backed binding"
```

---

### Task 6: The DuckDB connection seam

**Files:**
- Create: `packages/store-duckdb/src/duckdb.ts`
- Test: `packages/store-duckdb/src/duckdb.spec.ts`
- Modify: `packages/store-duckdb/src/index.ts`

**Interfaces:**
- Consumes: `CatalogDuckDbStoreOptions` (Task 1).
- Produces: `class DuckDbConnection { run(sql: string): Promise<void>; rows(sql: string): Promise<Array<Record<string, unknown>>>; close(): Promise<void> }`, `openDuckDb(options: CatalogDuckDbStoreOptions): Promise<DuckDbConnection>`, `quoteLiteral(value: string): string`.

- [ ] **Step 1: Write the failing test**

`packages/store-duckdb/src/duckdb.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { quoteLiteral } from './duckdb';

describe('quoteLiteral', () => {
  it('doubles an embedded quote, so a path with one cannot end the string', () => {
    expect(quoteLiteral("o'brien")).toBe("'o''brien'");
  });

  it('leaves an ordinary path alone but wraps it', () => {
    expect(quoteLiteral('s3://bucket/prefix/mvr/run-1/*.parquet')).toBe(
      "'s3://bucket/prefix/mvr/run-1/*.parquet'",
    );
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run packages/store-duckdb/src/duckdb.spec.ts
```

Expected: FAIL — cannot resolve `./duckdb`.

- [ ] **Step 3: Implement**

`packages/store-duckdb/src/duckdb.ts`:

```ts
import { DuckDBInstance } from '@duckdb/node-api';
import type { CatalogDuckDbStoreOptions } from './options';

/**
 * A string literal for a statement this package builds.
 *
 * Only ever for paths and prefixes this package derived itself — never for a caller's
 * value, which goes through a bound parameter. Doubling the quote is the SQL rule; the
 * reason it is a function rather than a template is that a path containing an apostrophe is
 * rare enough that an inline version would be written correctly and then copied wrongly.
 */
export function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** As much of a DuckDB connection as this package uses. */
export class DuckDbConnection {
  constructor(private readonly connection: {
    run(sql: string): Promise<unknown>;
    runAndReadAll(sql: string): Promise<{ getRowObjects(): Array<Record<string, unknown>> }>;
    closeSync(): void;
  }) {}

  async run(sql: string): Promise<void> {
    await this.connection.run(sql);
  }

  async rows(sql: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.connection.runAndReadAll(sql);
    return result.getRowObjects();
  }

  async close(): Promise<void> {
    this.connection.closeSync();
  }
}

/**
 * Open the engine, configured for a container rather than for a laptop.
 *
 * DuckDB's defaults are every CPU core and 80% of RAM, and both are measured against the
 * machine rather than against a cgroup — so a pod with a memory limit is OOMKilled by a
 * query DuckDB believed was inside its budget. `temp_directory` matters for the same reason
 * in the other direction: spilling to a path that is not on a writable volume turns a large
 * sort into a failure rather than into a slow query.
 *
 * The database is in-memory. Nothing in this store is kept in a DuckDB file — every byte
 * that survives a restart is a Parquet object or a JSON record in the object store — so a
 * file would add DuckDB's single-writer file lock to a process that does not need it.
 */
export async function openDuckDb(
  options: CatalogDuckDbStoreOptions,
): Promise<DuckDbConnection> {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  const opened = new DuckDbConnection(connection);
  if (options.memoryLimit) {
    await opened.run(`SET memory_limit = ${quoteLiteral(options.memoryLimit)}`);
  }
  if (options.threads !== undefined) {
    await opened.run(`SET threads = ${options.threads}`);
  }
  if (options.tempDirectory) {
    await opened.run(`SET temp_directory = ${quoteLiteral(options.tempDirectory)}`);
  }
  if (options.root.startsWith('s3://')) {
    await configureS3(opened, options);
  }
  return opened;
}

/**
 * Point DuckDB at object storage.
 *
 * `CREATE SECRET` with `PROVIDER credential_chain` is the form that picks up an instance
 * profile, an assumed role or a pod identity, which is what a deployment has and a laptop
 * does not. `ENDPOINT` and `REGION` are set explicitly rather than left to be derived: the
 * derivation has a known defect in GovCloud, where the region slug is dropped from the
 * generated host, and the issue reporting it was closed without a fix.
 */
export async function configureS3(
  connection: DuckDbConnection,
  options: CatalogDuckDbStoreOptions,
): Promise<void> {
  await connection.run('INSTALL httpfs');
  await connection.run('LOAD httpfs');
  const s3 = options.s3 ?? {};
  const settings: string[] = ["TYPE s3"];
  if (s3.accessKeyId && s3.secretAccessKey) {
    settings.push('PROVIDER config');
    settings.push(`KEY_ID ${quoteLiteral(s3.accessKeyId)}`);
    settings.push(`SECRET ${quoteLiteral(s3.secretAccessKey)}`);
    if (s3.sessionToken) settings.push(`SESSION_TOKEN ${quoteLiteral(s3.sessionToken)}`);
  } else {
    settings.push('PROVIDER credential_chain');
  }
  if (s3.region) settings.push(`REGION ${quoteLiteral(s3.region)}`);
  if (s3.endpoint) settings.push(`ENDPOINT ${quoteLiteral(s3.endpoint)}`);
  if (s3.urlStyle) settings.push(`URL_STYLE ${quoteLiteral(s3.urlStyle)}`);
  if (s3.useSsl === false) settings.push('USE_SSL false');
  await connection.run(`CREATE OR REPLACE SECRET catalog_s3 (${settings.join(', ')})`);
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
pnpm vitest run packages/store-duckdb/src/duckdb.spec.ts
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Export and commit**

Add to `src/index.ts`:

```ts
export { configureS3, DuckDbConnection, openDuckDb, quoteLiteral } from './duckdb';
```

```bash
git add packages/store-duckdb/src
git commit -m "feat(store-duckdb): DuckDB connection seam with cgroup-aware limits and explicit S3 config"
```

---

### Task 7: `ensureType` and `write` — a batch becomes one Parquet object

**Files:**
- Modify: `packages/store-duckdb/src/duckdb-warehouse.store.ts`
- Test: `packages/store-duckdb/src/duckdb-warehouse.write.spec.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–6.
- Produces: on `DuckDbWarehouseStore` — `capabilities`, `ensureType(type)`, `write(type, rows, options)`, plus the private `ready()` that opens the connection once.

- [ ] **Step 1: Write the failing test**

`packages/store-duckdb/src/duckdb-warehouse.write.spec.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isCatalogStoreCapabilities, isWriteStore } from '@dudousxd/nestjs-catalog';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contractRow, contractType } from '../../../test/catalog-store-contract';
import { DuckDbWarehouseStore } from './duckdb-warehouse.store';
import { localObjectStore } from './object-store';

let root: string;
let store: DuckDbWarehouseStore;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'catalog-duckdb-write-'));
  store = new DuckDbWarehouseStore({ root });
});

afterAll(async () => {
  await store.close();
  rmSync(root, { recursive: true, force: true });
});

describe('DuckDbWarehouseStore capabilities', () => {
  it('satisfies the core package predicate and is writable', () => {
    expect(isCatalogStoreCapabilities(store.capabilities)).toBe(true);
    expect(isWriteStore(store)).toBe(true);
  });

  it('reports emulated snapshots, because DuckDB keeps no history of its own', () => {
    expect(store.capabilities.snapshots).toBe('emulated');
    expect(store.capabilities.timeTravel).toBe(true);
  });

  it('states nothing about atomicity it has not measured', () => {
    // `undefined` is a third answer with a meaning: not stated. Task 12 measures
    // these and replaces this assertion with the measured values.
    expect(store.capabilities.atomicCutover).toBeUndefined();
  });
});

describe('write', () => {
  it('writes one object per batch at a deterministic key', async () => {
    const type = contractType('WriteOne');
    await store.ensureType(type);
    const result = await store.write(type, [contractRow('a', 'A', 1)], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 1,
    });
    expect(result.written).toBe(1);
    expect(await localObjectStore(root).list('writeone/run-1')).toEqual([
      'writeone/run-1/part-000001.parquet',
    ]);
  });

  it('replaces a re-sent batch instead of appending it', async () => {
    // A durable step that retries restarts from the top and re-sends every
    // batch. An append-only write silently doubles the load, and the only
    // symptom is a row count that looks plausible.
    const type = contractType('WriteRetry');
    await store.ensureType(type);
    const options = { snapshotId: 'run-1', principalId: 'tester', batch: 1 };
    await store.write(type, [contractRow('a', 'A', 1), contractRow('b', 'B', 2)], options);
    await store.write(type, [contractRow('a', 'A', 1), contractRow('b', 'B', 2)], options);
    expect(await localObjectStore(root).list('writeretry/run-1')).toHaveLength(1);
    expect(await store.countStaged(type, 'run-1')).toBe(2);
  });

  it('reports rows accepted by this call, never rows in the snapshot', async () => {
    // A caller sums `written` across batches, and a fan-out compares the number
    // its primary reported against its follower's. Returning the running total
    // makes the sum grow quadratically and the comparison a false mismatch.
    const type = contractType('WriteCount');
    await store.ensureType(type);
    const first = await store.write(type, [contractRow('a', 'A', 1)], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 1,
    });
    const second = await store.write(type, [contractRow('b', 'B', 2)], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 2,
    });
    expect(first.written).toBe(1);
    expect(second.written).toBe(1);
  });

  it('refuses a negative batch rather than writing a key that cannot be replaced', async () => {
    const type = contractType('WriteBad');
    await store.ensureType(type);
    await expect(
      store.write(type, [contractRow('a', 'A', 1)], {
        snapshotId: 'run-1',
        principalId: 'tester',
        batch: -1,
      }),
    ).rejects.toThrow(/batch/i);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run packages/store-duckdb/src/duckdb-warehouse.write.spec.ts
```

Expected: FAIL — `store.capabilities` is undefined.

- [ ] **Step 3: Implement the store's write half**

Replace `packages/store-duckdb/src/duckdb-warehouse.store.ts` with:

```ts
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type {
  CatalogObjectTypeDef,
  CatalogPropertyDef,
  CatalogStoreCapabilities,
} from '@dudousxd/nestjs-catalog';
import { assertNoColumnCollisions, physicalColumn } from '@dudousxd/nestjs-catalog';
import { Inject, Injectable } from '@nestjs/common';
import { coerce, duckDbType } from './column-types';
import { type DuckDbConnection, openDuckDb, quoteLiteral } from './duckdb';
import {
  BATCH_COLUMN,
  batchKey,
  ident,
  LOADED_AT_COLUMN,
  PRINCIPAL_COLUMN,
  ROW_COLUMN,
  snapshotPrefix,
  SNAPSHOT_COLUMN,
} from './identifiers';
import { isS3Root, localObjectStore, type ObjectStore } from './object-store';
import { CATALOG_DUCKDB_OPTIONS, type CatalogDuckDbStoreOptions } from './options';
import { objectSnapshotCatalog, type SnapshotCatalog } from './snapshots';

@Injectable()
export class DuckDbWarehouseStore {
  /**
   * What this adapter can do, and what it has not measured.
   *
   * `snapshots: 'emulated'` is the honest label and the one the core package predicts:
   * DuckDB keeps no history of its own. History here is a prefix per load and a pointer at
   * one of them, which is emulation in exactly the sense MySQL's `_snapshot_id` column is.
   *
   * The three atomicity fields are absent, which is a third answer meaning *not stated*. A
   * guess about atomicity is indistinguishable from a measurement once it is a literal in
   * this object, and a caller reading the optimistic answer skips the repair it exists for.
   * They are filled in once measured, not before.
   */
  readonly capabilities: CatalogStoreCapabilities = {
    snapshots: 'emulated',
    writable: true,
    timeTravel: true,
  };

  private readonly objects: ObjectStore;
  private readonly snapshots: SnapshotCatalog;
  private connection?: DuckDbConnection;

  constructor(
    @Inject(CATALOG_DUCKDB_OPTIONS)
    private readonly options: CatalogDuckDbStoreOptions,
  ) {
    this.objects =
      options.objectStore ??
      (isS3Root(options.root)
        ? unsupportedRemoteStore(options.root)
        : localObjectStore(options.root));
    this.snapshots = options.snapshotCatalog ?? objectSnapshotCatalog(this.objects);
  }

  /** Opened once, lazily, because a constructor cannot await and a boot should not block on I/O. */
  private async ready(): Promise<DuckDbConnection> {
    if (!this.connection) {
      this.connection = await openDuckDb(this.options);
    }
    return this.connection;
  }

  async close(): Promise<void> {
    await this.connection?.close();
    this.connection = undefined;
  }

  /**
   * Nothing to create, and the check is the point.
   *
   * There is no DDL here — a Parquet object carries its own schema, so the shape of storage
   * is decided per write rather than declared once. What survives from a row store's
   * `ensureType` is the refusal: a property whose physical name collides with a reserved
   * column, or with another property once the engine has folded the case, is a load that
   * would write one column over another. The core package owns that rule so every adapter
   * refuses the same names.
   */
  async ensureType(type: CatalogObjectTypeDef): Promise<void> {
    assertNoColumnCollisions(type, physicalColumn, {
      foldsColumnCase: false,
      store: 'duckdb',
    });
  }

  async write(
    type: CatalogObjectTypeDef,
    rows: Array<Record<string, unknown>>,
    options: {
      snapshotId: string;
      principalId: string;
      batch?: number;
      labels?: Record<string, string>;
    },
  ): Promise<{ written: number }> {
    const batch = options.batch ?? 1;
    if (!Number.isInteger(batch) || batch < 0) {
      throw new Error(
        `batch must be a non-negative integer, got ${String(options.batch)}. The batch number is half of this store's object key, and a key it cannot derive is a batch a retry cannot replace.`,
      );
    }
    const connection = await this.ready();
    const key = batchKey(type.name, options.snapshotId, batch);
    const staging = join(tmpdir(), `catalog-duckdb-${randomUUID()}.ndjson`);
    const loadedAt = new Date().toISOString();
    try {
      await writeFile(
        staging,
        rows
          .map((row, index) =>
            JSON.stringify(stageRow(type, row, {
              snapshotId: options.snapshotId,
              principalId: options.principalId,
              batch,
              row: index,
              loadedAt,
            })),
          )
          .join('\n'),
        'utf8',
      );
      // SNAPPY, never anything else: any other codec needs `hyparquet-compressors` on the
      // reading side, which has had no release since March 2025 and fails on DuckDB-written
      // LZ4_RAW. The archive path in this repo already tells producers to write SNAPPY.
      await connection.run(
        `COPY (SELECT * FROM read_json(${quoteLiteral(staging)}, columns = ${stageColumns(type)}, format = 'newline_delimited')) TO ${quoteLiteral(this.objects.locate(key))} (FORMAT PARQUET, COMPRESSION SNAPPY)`,
      );
    } finally {
      await rm(staging, { force: true });
    }
    // Rows accepted by THIS call. Never the snapshot's running total: a caller sums these
    // across batches, and a fan-out compares its primary's answer with its follower's.
    return { written: rows.length };
  }

  /** How many rows are staged under a snapshot. Present for this package's own specs. */
  async countStaged(type: CatalogObjectTypeDef, snapshotId: string): Promise<number> {
    const connection = await this.ready();
    const glob = this.objects.locate(`${snapshotPrefix(type.name, snapshotId)}/*.parquet`);
    const rows = await connection.rows(
      `SELECT count(*) AS total FROM read_parquet(${quoteLiteral(glob)})`,
    );
    return Number(rows[0]?.total ?? 0);
  }
}

/** The `columns` argument for `read_json`, so nothing is inferred from the data. */
function stageColumns(type: CatalogObjectTypeDef): string {
  const declared = type.properties.map(
    (property: CatalogPropertyDef) =>
      `${ident(physicalColumn(property.name))}: ${quoteLiteral(duckDbType(property.type))}`,
  );
  const reserved = [
    `${ident(SNAPSHOT_COLUMN)}: 'VARCHAR'`,
    `${ident(PRINCIPAL_COLUMN)}: 'VARCHAR'`,
    `${ident(LOADED_AT_COLUMN)}: 'TIMESTAMP WITH TIME ZONE'`,
    `${ident(BATCH_COLUMN)}: 'INTEGER'`,
    `${ident(ROW_COLUMN)}: 'BIGINT'`,
  ];
  return `{${[...declared, ...reserved].join(', ')}}`;
}

/**
 * One row, keyed by physical column name and carrying its provenance.
 *
 * `_row` is a position within the batch, not a running count, so `(_batch, _row)` is a
 * total order over the snapshot. Parquet has no auto-increment, and paging a set with no
 * total order silently repeats and skips rows between pages.
 */
function stageRow(
  type: CatalogObjectTypeDef,
  row: Record<string, unknown>,
  provenance: {
    snapshotId: string;
    principalId: string;
    batch: number;
    row: number;
    loadedAt: string;
  },
): Record<string, unknown> {
  const staged: Record<string, unknown> = {};
  for (const property of type.properties) {
    staged[physicalColumn(property.name)] = coerce(row[property.name], property.type);
  }
  staged[SNAPSHOT_COLUMN] = provenance.snapshotId;
  staged[PRINCIPAL_COLUMN] = provenance.principalId;
  staged[LOADED_AT_COLUMN] = provenance.loadedAt;
  staged[BATCH_COLUMN] = provenance.batch;
  staged[ROW_COLUMN] = provenance.row;
  return staged;
}

/**
 * An `s3://` root with no object-store binding.
 *
 * DuckDB reaches S3 itself, so reads and writes would work — and everything this store does
 * *besides* moving rows (listing a snapshot's parts, swapping the pointer, tombstoning)
 * goes through the port, which has no S3 binding until Task 13. Refusing here is what keeps
 * that gap from presenting as a store that writes and then cannot remember what it wrote.
 */
function unsupportedRemoteStore(root: string): ObjectStore {
  throw new Error(
    `root ${root} is object storage, but no \`objectStore\` was supplied. Bind s3ObjectStore(root) — DuckDB can read and write the Parquet itself, but the snapshot records and the served pointer go through the object store port.`,
  );
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
pnpm vitest run packages/store-duckdb/src/duckdb-warehouse.write.spec.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/store-duckdb/src
git commit -m "feat(store-duckdb): ensureType and an idempotent batch write to one Parquet object"
```

---

### Task 8: `commit`, `currentSnapshot`, and `read`

**Files:**
- Modify: `packages/store-duckdb/src/duckdb-warehouse.store.ts`
- Test: `packages/store-duckdb/src/duckdb-warehouse.read.spec.ts`

**Interfaces:**
- Produces: `commit(type, snapshotId): Promise<SnapshotRef>`, `currentSnapshot(type): Promise<SnapshotRef | undefined>`, `read(type, fields, query): Promise<CatalogReadResult>`.

- [ ] **Step 1: Write the failing test**

`packages/store-duckdb/src/duckdb-warehouse.read.spec.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contractRow, contractType } from '../../../test/catalog-store-contract';
import { DuckDbWarehouseStore } from './duckdb-warehouse.store';

let root: string;
let store: DuckDbWarehouseStore;
const FIELDS = ['id', 'label', 'score', 'active', 'seenAt'];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'catalog-duckdb-read-'));
  store = new DuckDbWarehouseStore({ root });
});

afterAll(async () => {
  await store.close();
  rmSync(root, { recursive: true, force: true });
});

describe('commit and read', () => {
  it('keeps a load invisible until it commits', async () => {
    // The single most load-bearing promise of the interface: a crash mid-load
    // must be distinguishable from a completed load that lost rows.
    const type = contractType('ReadHidden');
    await store.ensureType(type);
    await store.write(type, [contractRow('a', 'A', 1)], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 1,
    });
    expect((await store.read(type, FIELDS, {})).rows).toEqual([]);
    await store.commit(type, 'run-1');
    expect((await store.read(type, FIELDS, {})).rows).toHaveLength(1);
  });

  it('names the snapshot it is actually serving', async () => {
    const type = contractType('ReadServed');
    await store.ensureType(type);
    await store.write(type, [contractRow('a', 'A', 1)], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 1,
    });
    await store.commit(type, 'run-1');
    const result = await store.read(type, FIELDS, {});
    expect(result.snapshot).toEqual({ id: 'run-1', current: true });
    expect((await store.currentSnapshot(type))?.id).toBe('run-1');
  });

  it('returns only the fields it was given, whatever the object holds', async () => {
    // `fields` is the whitelist the caller vouched for. The reserved columns are
    // in every object and must not leak into an ordinary read.
    const type = contractType('ReadFields');
    await store.ensureType(type);
    await store.write(type, [contractRow('a', 'A', 1)], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 1,
    });
    await store.commit(type, 'run-1');
    const result = await store.read(type, ['id', 'label'], {});
    expect(Object.keys(result.rows[0] ?? {}).sort()).toEqual(['id', 'label']);
  });

  it('counts the whole snapshot, not the page', async () => {
    const type = contractType('ReadTotal');
    await store.ensureType(type);
    await store.write(
      type,
      [contractRow('a', 'A', 1), contractRow('b', 'B', 2), contractRow('c', 'C', 3)],
      { snapshotId: 'run-1', principalId: 'tester', batch: 1 },
    );
    await store.commit(type, 'run-1');
    const result = await store.read(type, FIELDS, { page: 1, size: 2 });
    expect(result.rows).toHaveLength(2);
    expect(result.total).toBe(3);
  });

  it('serves an older snapshot when asked for one', async () => {
    const type = contractType('ReadTravel');
    await store.ensureType(type);
    await store.write(type, [contractRow('a', 'old', 1)], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 1,
    });
    await store.commit(type, 'run-1');
    await store.write(type, [contractRow('a', 'new', 1)], {
      snapshotId: 'run-2',
      principalId: 'tester',
      batch: 1,
    });
    await store.commit(type, 'run-2');
    const older = await store.read(type, FIELDS, { snapshot: 'run-1' });
    expect(older.rows[0]?.label).toBe('old');
    expect(older.snapshot).toEqual({ id: 'run-1', current: false });
  });

  it('reads nothing for a type that has never committed', async () => {
    const type = contractType('ReadEmpty');
    await store.ensureType(type);
    const result = await store.read(type, FIELDS, {});
    expect(result.rows).toEqual([]);
    expect(result.total).toBe(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run packages/store-duckdb/src/duckdb-warehouse.read.spec.ts
```

Expected: FAIL — `store.commit is not a function`.

- [ ] **Step 3: Add the read half to the store**

Add these imports to `duckdb-warehouse.store.ts`:

```ts
import type {
  CatalogReadQuery,
  CatalogReadResult,
  SnapshotRef,
} from '@dudousxd/nestjs-catalog';
import { outputAlias } from '@dudousxd/nestjs-catalog';
import { currentKey } from './identifiers';
import { normalise } from './column-types';
```

Add these methods to `DuckDbWarehouseStore`:

```ts
  /**
   * Make a staged snapshot the one readers get.
   *
   * Three steps, ordered so that re-running is the repair: count the rows, record the
   * snapshot, then move the pointer. A crash after the record leaves a snapshot nobody
   * serves, which the next attempt overwrites; the reverse order would leave the pointer at
   * a snapshot with no record, and nothing later could tell whether that load finished.
   */
  async commit(type: CatalogObjectTypeDef, snapshotId: string): Promise<SnapshotRef> {
    const existing = await this.snapshots.find(type.name, snapshotId);
    if (existing?.droppedAt) {
      throw new Error(
        `snapshot ${snapshotId} of ${type.name} was dropped on ${existing.droppedAt} and cannot be committed. Its rows are gone; the record survives so run history stays resolvable.`,
      );
    }
    const ref: SnapshotRef = {
      id: snapshotId,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      rowCount: await this.countStaged(type, snapshotId),
      principalId: existing?.principalId ?? (await this.principalOf(type, snapshotId)),
      ...(existing?.labels ? { labels: existing.labels } : {}),
      ...(existing?.archive ? { archive: existing.archive } : {}),
    };
    await this.snapshots.put(type.name, ref);
    await this.snapshots.setCurrent(type.name, snapshotId);
    return ref;
  }

  async currentSnapshot(type: CatalogObjectTypeDef): Promise<SnapshotRef | undefined> {
    const id = await this.snapshots.current(type.name);
    return id ? this.snapshots.find(type.name, id) : undefined;
  }

  async read(
    type: CatalogObjectTypeDef,
    fields: string[],
    query: CatalogReadQuery,
  ): Promise<CatalogReadResult> {
    const currentId = await this.snapshots.current(type.name);
    const wanted = query.snapshot ?? currentId;
    if (!wanted) return { rows: [], total: 0 };

    const ref = await this.snapshots.find(type.name, wanted);
    if (ref?.droppedAt) {
      throw new Error(
        `snapshot ${wanted} of ${type.name} was dropped on ${ref.droppedAt}. Its rows are gone; this read cannot be served and is refused rather than answered with none.`,
      );
    }

    const connection = await this.ready();
    const source = `read_parquet(${quoteLiteral(this.globFor(type, wanted))})`;
    const selected = fields
      .map((field) => {
        const property = type.properties.find((each) => each.name === field);
        if (!property) {
          throw new Error(
            `${type.name} has no property named ${field}; a store must never return a column outside the whitelist it was handed.`,
          );
        }
        return `${ident(physicalColumn(property.name))} AS ${ident(outputAlias(property.name))}`;
      })
      .join(', ');

    const size = Math.max(1, query.size ?? 50);
    const page = Math.max(1, query.page ?? 1);
    const totalRows = await connection.rows(`SELECT count(*) AS total FROM ${source}`);
    const rows = await connection.rows(
      `SELECT ${selected} FROM ${source} ORDER BY ${ident(BATCH_COLUMN)}, ${ident(ROW_COLUMN)} LIMIT ${size} OFFSET ${(page - 1) * size}`,
    );

    return {
      rows: rows.map((row) => this.normaliseRow(type, fields, row)),
      total: Number(totalRows[0]?.total ?? 0),
      snapshot: { id: wanted, current: wanted === currentId },
    };
  }

  /** The glob covering one snapshot's parts, and only that snapshot's. */
  private globFor(type: CatalogObjectTypeDef, snapshotId: string): string {
    return this.objects.locate(`${snapshotPrefix(type.name, snapshotId)}/*.parquet`);
  }

  private normaliseRow(
    type: CatalogObjectTypeDef,
    fields: string[],
    row: Record<string, unknown>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const field of fields) {
      const property = type.properties.find((each) => each.name === field);
      if (!property) continue;
      out[field] = normalise(row[outputAlias(property.name)], property.type);
    }
    return out;
  }

  /** Who loaded a snapshot, read off the rows when no record names them yet. */
  private async principalOf(
    type: CatalogObjectTypeDef,
    snapshotId: string,
  ): Promise<string> {
    const connection = await this.ready();
    const rows = await connection.rows(
      `SELECT ${ident(PRINCIPAL_COLUMN)} AS principal FROM read_parquet(${quoteLiteral(this.globFor(type, snapshotId))}) LIMIT 1`,
    );
    const principal = rows[0]?.principal;
    return typeof principal === 'string' ? principal : 'unknown';
  }
```

- [ ] **Step 4: Handle the empty-glob case**

`read_parquet` on a glob matching nothing raises rather than returning zero rows. Add this
guard at the top of `countStaged` and inside `read`, right after `const connection = await
this.ready();`:

```ts
    // A glob that matches nothing is an error in DuckDB, not an empty result — and "this
    // snapshot has no objects" is an ordinary state during a load. Asking the object store
    // first keeps the difference between "nothing written yet" and "the engine could not
    // read what was written".
    if ((await this.objects.list(snapshotPrefix(type.name, wanted))).length === 0) {
      return { rows: [], total: 0, snapshot: { id: wanted, current: wanted === currentId } };
    }
```

In `countStaged`, the equivalent guard returns `0`.

- [ ] **Step 5: Run it and watch it pass**

```bash
pnpm vitest run packages/store-duckdb/src/duckdb-warehouse.read.spec.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/store-duckdb/src
git commit -m "feat(store-duckdb): commit, currentSnapshot and read over a snapshot glob"
```

---

### Task 9: Filters

**Files:**
- Create: `packages/store-duckdb/src/filters.ts`
- Modify: `packages/store-duckdb/src/duckdb-warehouse.store.ts`, `packages/store-duckdb/src/index.ts`
- Test: `packages/store-duckdb/src/filters.spec.ts`

**Interfaces:**
- Consumes: `CatalogResolvedFilter`, `CATALOG_FILTER_OPERATORS` from `@dudousxd/nestjs-catalog`.
- Produces: `predicateFor(filter: CatalogResolvedFilter): string`, and on the store `readonly objectFilterOperators`.

- [ ] **Step 1: Write the failing test**

`packages/store-duckdb/src/filters.spec.ts`:

```ts
import { CATALOG_FILTER_OPERATORS } from '@dudousxd/nestjs-catalog';
import type { CatalogPropertyDef, CatalogResolvedFilter } from '@dudousxd/nestjs-catalog';
import { describe, expect, it } from 'vitest';
import { predicateFor } from './filters';

function property(name: string, type: CatalogPropertyDef['type']): CatalogPropertyDef {
  return {
    name,
    displayName: name,
    type,
    columnName: name,
    nullable: true,
    primary: false,
    hidden: false,
    order: 0,
    enriched: false,
  };
}

function filter(op: CatalogResolvedFilter['op'], value?: string | number): CatalogResolvedFilter {
  return { property: property('label', 'string'), op, ...(value === undefined ? {} : { value }) };
}

describe('predicateFor', () => {
  it('answers every operator the core package declares', () => {
    // An unanswered operator that falls through to a default is a filter the
    // store ignores, and a read that ignores a filter returns more rows than
    // were asked for with nothing to distinguish it from a filter that matched
    // everything.
    for (const op of CATALOG_FILTER_OPERATORS) {
      expect(() => predicateFor(filter(op, 'x'))).not.toThrow();
    }
  });

  it('uses ILIKE for contains, so case-insensitivity matches the row store', () => {
    expect(predicateFor(filter('contains', 'ab'))).toContain('ILIKE');
  });

  it('escapes a wildcard in a contains value rather than honouring it', () => {
    // A caller typing `100%` is asking for the literal, not for a prefix match.
    expect(predicateFor(filter('contains', '100%'))).toContain('100\\%');
  });

  it('treats ne as matching NULLs, because a null is not the value', () => {
    const rendered = predicateFor(filter('ne', 'x'));
    expect(rendered).toContain('IS NULL');
  });

  it('renders the valueless operators without a value', () => {
    expect(predicateFor(filter('empty'))).toMatch(/IS NULL/);
    expect(predicateFor(filter('notEmpty'))).toMatch(/IS NOT NULL/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run packages/store-duckdb/src/filters.spec.ts
```

Expected: FAIL — cannot resolve `./filters`.

- [ ] **Step 3: Implement**

`packages/store-duckdb/src/filters.ts`:

```ts
import type { CatalogResolvedFilter } from '@dudousxd/nestjs-catalog';
import { physicalColumn } from '@dudousxd/nestjs-catalog';
import { quoteLiteral } from './duckdb';
import { ident } from './identifiers';

function literal(value: string | number | boolean | Date | undefined): string {
  if (value === undefined) return 'NULL';
  if (value instanceof Date) return quoteLiteral(value.toISOString());
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return quoteLiteral(value);
}

/**
 * A `LIKE` pattern that matches the caller's text and nothing cleverer.
 *
 * `%` and `_` are wildcards, and a caller typing `100%` means the literal. Backslash is
 * escaped first, or escaping the wildcards would introduce the very character being used to
 * escape them.
 */
function containsPattern(value: string): string {
  const escaped = value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
  return `%${escaped}%`;
}

/**
 * One resolved filter as a SQL predicate.
 *
 * The column comes off `filter.property`, which is the *type's* definition rather than the
 * request — that is why the interface hands a `CatalogResolvedFilter` here and never the
 * caller's raw `property:operator:value` string.
 *
 * The switch is exhaustive against the core package's operator list, with a `never` default,
 * so an operator added upstream is a compile error here rather than a filter this store
 * quietly stops applying.
 */
export function predicateFor(filter: CatalogResolvedFilter): string {
  const column = ident(physicalColumn(filter.property.name));
  switch (filter.op) {
    case 'eq':
      return `${column} = ${literal(filter.value)}`;
    case 'ne':
      // A row whose value is NULL is not the value being excluded, and SQL's `<>` answers
      // NULL rather than TRUE for it — so it would be dropped from a result that asked for
      // everything except one thing.
      return `(${column} IS NULL OR ${column} <> ${literal(filter.value)})`;
    case 'contains':
      return `${column} ILIKE ${quoteLiteral(containsPattern(String(filter.value ?? '')))} ESCAPE '\\'`;
    case 'gt':
      return `${column} > ${literal(filter.value)}`;
    case 'gte':
      return `${column} >= ${literal(filter.value)}`;
    case 'lt':
      return `${column} < ${literal(filter.value)}`;
    case 'lte':
      return `${column} <= ${literal(filter.value)}`;
    case 'empty':
      return `(${column} IS NULL${filter.property.type === 'string' ? ` OR ${column} = ''` : ''})`;
    case 'notEmpty':
      return `(${column} IS NOT NULL${filter.property.type === 'string' ? ` AND ${column} <> ''` : ''})`;
    default: {
      const unreachable: never = filter.op;
      throw new Error(`unhandled filter operator: ${String(unreachable)}`);
    }
  }
}
```

- [ ] **Step 4: Apply filters in `read`**

In `duckdb-warehouse.store.ts`, add the import:

```ts
import { CATALOG_FILTER_OPERATORS, type CatalogFilterOperator } from '@dudousxd/nestjs-catalog';
import { predicateFor } from './filters';
```

Add the declaration to the class, beside `capabilities`:

```ts
  /**
   * Every operator the core package declares.
   *
   * All of them, because `predicateFor` answers all of them behind an exhaustive switch. A
   * store that declares an operator it does not apply returns more rows than were asked for,
   * and nothing in that answer distinguishes it from a filter that genuinely matched
   * everything.
   */
  readonly objectFilterOperators: readonly CatalogFilterOperator[] = CATALOG_FILTER_OPERATORS;
```

In `read`, build the clause and use it for both statements:

```ts
    const where = (query.filters ?? []).map(predicateFor);
    const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
```

Then change the two statements to `... FROM ${source}${clause}`.

- [ ] **Step 5: Run the whole package's specs**

```bash
pnpm vitest run packages/store-duckdb
```

Expected: PASS, all specs.

- [ ] **Step 6: Export and commit**

Add `export { predicateFor } from './filters';` to `src/index.ts`, then:

```bash
git add packages/store-duckdb/src
git commit -m "feat(store-duckdb): object filters with an exhaustive operator switch"
```

---

### Task 10: Snapshot lists, tombstones and `dropSnapshot`

**Files:**
- Modify: `packages/store-duckdb/src/duckdb-warehouse.store.ts`
- Test: `packages/store-duckdb/src/duckdb-warehouse.snapshots.spec.ts`

**Interfaces:**
- Produces: `listSnapshots(type)`, `listSnapshotsWithRows(type, limit?)`, `findSnapshot(type, snapshotId)`, `dropSnapshot(type, snapshotId)`.

- [ ] **Step 1: Write the failing test**

`packages/store-duckdb/src/duckdb-warehouse.snapshots.spec.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contractRow, contractType } from '../../../test/catalog-store-contract';
import { DuckDbWarehouseStore } from './duckdb-warehouse.store';

let root: string;
let store: DuckDbWarehouseStore;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'catalog-duckdb-snapshots-'));
  store = new DuckDbWarehouseStore({ root });
});

afterAll(async () => {
  await store.close();
  rmSync(root, { recursive: true, force: true });
});

async function load(typeName: string, snapshotId: string, label: string) {
  const type = contractType(typeName);
  await store.ensureType(type);
  await store.write(type, [contractRow('a', label, 1)], {
    snapshotId,
    principalId: 'tester',
    batch: 1,
  });
  await store.commit(type, snapshotId);
  return type;
}

describe('dropSnapshot', () => {
  it('refuses to drop the snapshot it is serving', async () => {
    // The invariant that keeps ordinary reads free of the tombstone question:
    // the snapshot a type serves can never be one.
    const type = await load('DropServed', 'run-1', 'A');
    await expect(store.dropSnapshot(type, 'run-1')).rejects.toThrow(/serving|current/i);
  });

  it('keeps the record with the size it held and the date it went', async () => {
    const type = await load('DropKeeps', 'run-1', 'A');
    await load('DropKeeps', 'run-2', 'B');
    await store.dropSnapshot(type, 'run-1');
    const found = await store.findSnapshot(type, 'run-1');
    expect(found?.rowCount).toBe(1);
    expect(found?.droppedAt).toBeDefined();
  });

  it('is idempotent and does not rewrite the date', async () => {
    const type = await load('DropTwice', 'run-1', 'A');
    await load('DropTwice', 'run-2', 'B');
    await store.dropSnapshot(type, 'run-1');
    const first = await store.findSnapshot(type, 'run-1');
    await store.dropSnapshot(type, 'run-1');
    expect((await store.findSnapshot(type, 'run-1'))?.droppedAt).toBe(first?.droppedAt);
  });

  it('refuses to read a dropped snapshot rather than answering with no rows', async () => {
    const type = await load('DropRead', 'run-1', 'A');
    await load('DropRead', 'run-2', 'B');
    await store.dropSnapshot(type, 'run-1');
    await expect(store.read(type, ['id'], { snapshot: 'run-1' })).rejects.toThrow(/dropped/i);
  });
});

describe('listSnapshotsWithRows', () => {
  it('bounds by the live snapshots, not by the records', async () => {
    // A bound applied before a predicate answers a different question from one
    // applied after it: filtering a bounded list gives the live snapshots OF
    // THAT WINDOW, and past N tombstones it gives none at all.
    const type = contractType('ListLive');
    await store.ensureType(type);
    for (const id of ['load-1', 'load-2', 'load-3', 'load-4', 'load-5']) {
      await store.write(type, [contractRow('a', id, 1)], {
        snapshotId: id,
        principalId: 'tester',
        batch: 1,
      });
      await store.commit(type, id);
    }
    await store.dropSnapshot(type, 'load-3');
    await store.dropSnapshot(type, 'load-4');
    const live = await store.listSnapshotsWithRows(type, 3);
    expect(live.map((each) => each.id)).toEqual(['load-5', 'load-2', 'load-1']);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run packages/store-duckdb/src/duckdb-warehouse.snapshots.spec.ts
```

Expected: FAIL — `store.dropSnapshot is not a function`.

- [ ] **Step 3: Implement**

Add to `DuckDbWarehouseStore`:

```ts
  /** Every record, newest first, tombstones included. */
  async listSnapshots(type: CatalogObjectTypeDef): Promise<SnapshotRef[]> {
    return this.snapshots.list(type.name);
  }

  /**
   * The newest N snapshots that still hold rows.
   *
   * The predicate is applied before the bound, not after it. A caller that takes the newest
   * N records and then drops the tombstones among them is holding the live snapshots *of
   * that window* — and past N tombstones the filtered list is empty, which is
   * indistinguishable from "nothing to do" to every caller that asks this question.
   */
  async listSnapshotsWithRows(
    type: CatalogObjectTypeDef,
    limit = SNAPSHOT_LIST_LIMIT,
  ): Promise<SnapshotRef[]> {
    const all = await this.snapshots.list(type.name, SNAPSHOT_LIST_LIMIT);
    return all.filter((ref) => !ref.droppedAt).slice(0, limit);
  }

  async findSnapshot(
    type: CatalogObjectTypeDef,
    snapshotId: string,
  ): Promise<SnapshotRef | undefined> {
    return this.snapshots.find(type.name, snapshotId);
  }

  /**
   * Take the rows and keep the record.
   *
   * The record survives because `catalog_connector_run` names the snapshot each run
   * produced, so deleting it turns run history into pointers to nothing. The disk is held by
   * the rows, and the two are separable.
   *
   * The count is read *before* the objects go, and `droppedAt` is written *after* — so a
   * crash between them leaves rows deleted and a record that still claims them, which the
   * next call repairs. Writing the tombstone first would leave a snapshot reported as
   * dropped whose rows are still there and still costing.
   */
  async dropSnapshot(type: CatalogObjectTypeDef, snapshotId: string): Promise<void> {
    const existing = await this.snapshots.find(type.name, snapshotId);
    if (existing?.droppedAt) return;
    if ((await this.snapshots.current(type.name)) === snapshotId) {
      throw new Error(
        `snapshot ${snapshotId} is the one ${type.name} is currently serving and cannot be dropped. Commit another snapshot first — a served tombstone would make every ordinary read pay for the question.`,
      );
    }
    const rowCount = existing?.rowCount ?? (await this.countStaged(type, snapshotId));
    await this.objects.deletePrefix(snapshotPrefix(type.name, snapshotId));
    await this.snapshots.put(type.name, {
      id: snapshotId,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      rowCount,
      principalId: existing?.principalId ?? 'unknown',
      ...(existing?.labels ? { labels: existing.labels } : {}),
      ...(existing?.archive ? { archive: existing.archive } : {}),
      droppedAt: new Date().toISOString(),
    });
  }
```

Add `SNAPSHOT_LIST_LIMIT` to the import from `./snapshots`.

- [ ] **Step 4: Run it and watch it pass**

```bash
pnpm vitest run packages/store-duckdb/src/duckdb-warehouse.snapshots.spec.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/store-duckdb/src
git commit -m "feat(store-duckdb): snapshot listing, tombstones and a drop that refuses the served load"
```

---

### Task 11: `streamSnapshot` and `carryForward`

**Files:**
- Modify: `packages/store-duckdb/src/duckdb-warehouse.store.ts`
- Test: `packages/store-duckdb/src/duckdb-warehouse.stream.spec.ts`

**Interfaces:**
- Produces: `streamSnapshot(type, fields, snapshotId, options?)`, `carryForward(type, snapshotId, options)`.

- [ ] **Step 1: Write the failing test**

`packages/store-duckdb/src/duckdb-warehouse.stream.spec.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { supportsCarryForward, supportsSnapshotStreams } from '@dudousxd/nestjs-catalog';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contractRow, contractType } from '../../../test/catalog-store-contract';
import { DuckDbWarehouseStore } from './duckdb-warehouse.store';

let root: string;
let store: DuckDbWarehouseStore;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'catalog-duckdb-stream-'));
  store = new DuckDbWarehouseStore({ root });
});

afterAll(async () => {
  await store.close();
  rmSync(root, { recursive: true, force: true });
});

describe('streamSnapshot', () => {
  it('is detected by the core package predicate', () => {
    // Without it a `catalog`-kind source is refused outright, not paged.
    expect(supportsSnapshotStreams(store)).toBe(true);
    expect(supportsCarryForward(store)).toBe(true);
  });

  it('streams one snapshot in order and nothing from the loads beside it', async () => {
    const type = contractType('StreamOrder');
    await store.ensureType(type);
    await store.write(type, [contractRow('a', 'A', 1), contractRow('b', 'B', 2)], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 1,
    });
    await store.commit(type, 'run-1');
    await store.write(type, [contractRow('z', 'Z', 9)], {
      snapshotId: 'run-2',
      principalId: 'tester',
      batch: 1,
    });
    await store.commit(type, 'run-2');
    const seen: unknown[] = [];
    for await (const row of store.streamSnapshot(type, ['id'], 'run-1')) {
      seen.push(row.id);
    }
    expect(seen).toEqual(['a', 'b']);
  });

  it('omits the provenance columns unless they are asked for', async () => {
    const type = contractType('StreamProv');
    await store.ensureType(type);
    await store.write(type, [contractRow('a', 'A', 1)], {
      snapshotId: 'run-1',
      principalId: 'loader',
      batch: 1,
    });
    await store.commit(type, 'run-1');
    const plain: Array<Record<string, unknown>> = [];
    for await (const row of store.streamSnapshot(type, ['id'], 'run-1')) plain.push(row);
    expect(plain[0]).not.toHaveProperty('_principal_id');

    const withProvenance: Array<Record<string, unknown>> = [];
    for await (const row of store.streamSnapshot(type, ['id'], 'run-1', { provenance: true })) {
      withProvenance.push(row);
    }
    expect(withProvenance[0]?._principal_id).toBe('loader');
  });

  it('refuses to stream a dropped snapshot', async () => {
    const type = contractType('StreamDropped');
    await store.ensureType(type);
    await store.write(type, [contractRow('a', 'A', 1)], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 1,
    });
    await store.commit(type, 'run-1');
    await store.write(type, [contractRow('b', 'B', 2)], {
      snapshotId: 'run-2',
      principalId: 'tester',
      batch: 1,
    });
    await store.commit(type, 'run-2');
    await store.dropSnapshot(type, 'run-1');
    // A workflow reading a tombstone would iterate zero rows, report success,
    // and commit an empty load downstream.
    await expect(async () => {
      for await (const _row of store.streamSnapshot(type, ['id'], 'run-1')) {
        // consumed for the side effect of iterating
      }
    }).rejects.toThrow(/dropped/i);
  });
});

describe('carryForward', () => {
  it('copies the previous snapshot forward and lets incoming rows win', async () => {
    const type = contractType('CarryBasic');
    await store.ensureType(type);
    await store.write(type, [contractRow('a', 'old-a', 1), contractRow('b', 'old-b', 2)], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 1,
    });
    await store.commit(type, 'run-1');

    await store.write(type, [contractRow('a', 'new-a', 5)], {
      snapshotId: 'run-2',
      principalId: 'tester',
      batch: 1,
    });
    const merged = await store.carryForward(type, 'run-2', { principalId: 'tester' });
    expect(merged.from).toBe('run-1');
    expect(merged.carried).toBe(1);
    expect(merged.total).toBe(2);
    await store.commit(type, 'run-2');

    const read = await store.read(type, ['id', 'label'], { size: 10 });
    const byId = Object.fromEntries(read.rows.map((row) => [row.id, row.label]));
    expect(byId).toEqual({ a: 'new-a', b: 'old-b' });
  });

  it('is safe to call twice', async () => {
    const type = contractType('CarryTwice');
    await store.ensureType(type);
    await store.write(type, [contractRow('a', 'old', 1)], {
      snapshotId: 'run-1',
      principalId: 'tester',
      batch: 1,
    });
    await store.commit(type, 'run-1');
    await store.write(type, [contractRow('b', 'new', 2)], {
      snapshotId: 'run-2',
      principalId: 'tester',
      batch: 1,
    });
    await store.carryForward(type, 'run-2', { principalId: 'tester' });
    const second = await store.carryForward(type, 'run-2', { principalId: 'tester' });
    expect(second.total).toBe(2);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run packages/store-duckdb/src/duckdb-warehouse.stream.spec.ts
```

Expected: FAIL — `store.streamSnapshot is not a function`.

- [ ] **Step 3: Implement**

Add to the imports:

```ts
import type { CarryForwardResult, SnapshotStreamOptions } from '@dudousxd/nestjs-catalog';
import { CATALOG_PROVENANCE_COLUMNS } from '@dudousxd/nestjs-catalog';
import { CARRY_FORWARD_BATCH } from './identifiers';
```

Add to `identifiers.ts`:

```ts
/**
 * The batch number a merge writes under.
 *
 * Its own, far above any batch a loader will reach, so the carried rows are one object that
 * a re-run replaces — the same idempotence every other batch gets, for the one write that is
 * not a loader's.
 */
export const CARRY_FORWARD_BATCH = 999_999;
```

Add to `DuckDbWarehouseStore`:

```ts
  /**
   * One snapshot, a row at a time, in `(_batch, _row)` order.
   *
   * Not a paged `read`: a page is `LIMIT`/`OFFSET`, so reading millions of rows in pages
   * makes the engine walk the offset each time and the cost is quadratic. It is also only
   * correct under a total order, which `read` does not promise and this does.
   *
   * `provenance` either supplies both columns or throws. A store that omitted them would
   * produce an archive that is complete, checksummed, and silently missing the only two
   * columns a restore cannot reconstruct.
   */
  async *streamSnapshot(
    type: CatalogObjectTypeDef,
    fields: string[],
    snapshotId: string,
    options?: SnapshotStreamOptions,
  ): AsyncIterable<Record<string, unknown>> {
    const ref = await this.snapshots.find(type.name, snapshotId);
    if (ref?.droppedAt) {
      throw new Error(
        `snapshot ${snapshotId} of ${type.name} was dropped on ${ref.droppedAt} and cannot be streamed. Iterating zero rows here would report success and commit an empty load downstream.`,
      );
    }
    if ((await this.objects.list(snapshotPrefix(type.name, snapshotId))).length === 0) return;

    const connection = await this.ready();
    const selected = fields.map((field) => {
      const property = type.properties.find((each) => each.name === field);
      if (!property) {
        throw new Error(`${type.name} has no property named ${field}`);
      }
      return `${ident(physicalColumn(property.name))} AS ${ident(outputAlias(property.name))}`;
    });
    if (options?.provenance) {
      for (const column of CATALOG_PROVENANCE_COLUMNS) {
        selected.push(ident(column));
      }
    }
    const rows = await connection.rows(
      `SELECT ${selected.join(', ')} FROM read_parquet(${quoteLiteral(this.globFor(type, snapshotId))}) ORDER BY ${ident(BATCH_COLUMN)}, ${ident(ROW_COLUMN)}`,
    );
    for (const row of rows) {
      const out = this.normaliseRow(type, fields, row);
      if (options?.provenance) {
        for (const column of CATALOG_PROVENANCE_COLUMNS) {
          out[column] = normalise(row[column], column === '_loaded_at' ? 'date' : 'string');
        }
      }
      yield out;
    }
  }

  /**
   * Copy the previous snapshot's surviving rows in beside the incoming ones.
   *
   * A snapshot stays the complete state rather than becoming a delta, so reads and time
   * travel stay trivial and the merge happens once per run instead of in every reader —
   * including the ad-hoc SQL people type into a query screen, which is exactly where a
   * subtle wrong answer never gets caught.
   *
   * Written as an anti-join in SQL rather than a read-modify-write in Node, and to its own
   * batch object, so calling it twice throws away what the first call copied instead of
   * doubling it.
   */
  async carryForward(
    type: CatalogObjectTypeDef,
    snapshotId: string,
    options: { principalId: string; labels?: Record<string, string> },
  ): Promise<CarryForwardResult> {
    if (type.primaryKey.length === 0) {
      throw new Error(
        `${type.name} declares no primary key, so an incremental load has no way to say which incoming row replaces which existing one.`,
      );
    }
    const previous = (await this.listSnapshotsWithRows(type)).find(
      (ref) => ref.id !== snapshotId,
    );
    const connection = await this.ready();
    const incoming = `read_parquet(${quoteLiteral(this.globFor(type, snapshotId))})`;
    if (!previous) {
      const total = await this.countStaged(type, snapshotId);
      return { carried: 0, total };
    }
    const source = `read_parquet(${quoteLiteral(this.globFor(type, previous.id))})`;
    const keys = type.primaryKey.map((name) => ident(physicalColumn(name)));
    const join = keys.map((key) => `previous.${key} IS NOT DISTINCT FROM incoming.${key}`);
    const columns = [
      ...type.properties.map((property) => ident(physicalColumn(property.name))),
      ident(PRINCIPAL_COLUMN),
      ident(LOADED_AT_COLUMN),
    ];
    const key = batchKey(type.name, snapshotId, CARRY_FORWARD_BATCH);
    await connection.run(
      `COPY (
         SELECT ${columns.map((column) => `previous.${column}`).join(', ')},
                ${quoteLiteral(snapshotId)} AS ${ident(SNAPSHOT_COLUMN)},
                ${CARRY_FORWARD_BATCH} AS ${ident(BATCH_COLUMN)},
                row_number() OVER () AS ${ident(ROW_COLUMN)}
         FROM ${source} AS previous
         WHERE NOT EXISTS (
           SELECT 1 FROM ${incoming} AS incoming WHERE ${join.join(' AND ')}
         )
       ) TO ${quoteLiteral(this.objects.locate(key))} (FORMAT PARQUET, COMPRESSION SNAPPY)`,
    );
    const carriedRows = await connection.rows(
      `SELECT count(*) AS total FROM read_parquet(${quoteLiteral(this.objects.locate(key))})`,
    );
    const carried = Number(carriedRows[0]?.total ?? 0);
    return { from: previous.id, carried, total: await this.countStaged(type, snapshotId) };
  }
```

Note the `SELECT` list order: the carried rows must have the same column set as a loaded
batch, and `_principal_id`/`_loaded_at` come from the *previous* snapshot untouched — losing
them compounds through every later incremental load.

- [ ] **Step 4: Run it and watch it pass**

```bash
pnpm vitest run packages/store-duckdb/src/duckdb-warehouse.stream.spec.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/store-duckdb/src
git commit -m "feat(store-duckdb): snapshot streaming with provenance, and carry-forward as an anti-join"
```

---

### Task 12: Run the shared contract, and measure the capabilities

**Files:**
- Create: `packages/store-duckdb/src/duckdb-warehouse.db.spec.ts`
- Modify: `packages/store-duckdb/src/duckdb-warehouse.store.ts` (capabilities, after measuring)

**Interfaces:**
- Consumes: `describeCatalogStoreContract`, `ContractStore` from `../../../test/catalog-store-contract`.

- [ ] **Step 1: Wire the contract**

`packages/store-duckdb/src/duckdb-warehouse.db.spec.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe } from 'vitest';
import {
  type ContractStore,
  describeCatalogStoreContract,
} from '../../../test/catalog-store-contract';
import { DuckDbWarehouseStore } from './duckdb-warehouse.store';

/**
 * The DuckDB warehouse store, against a real DuckDB and a real filesystem.
 *
 * No container, and that is a property of the adapter rather than a shortcut: the engine is
 * in-process and the transport is a directory, so the only thing a container would add here
 * is object storage — which Task 13 covers in its own spec. Everything the contract asserts
 * is a property of the Parquet this store writes and the SQL it issues, and both are real
 * in this configuration.
 */

let root: string;
let store: DuckDbWarehouseStore;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'catalog-duckdb-contract-'));
  store = new DuckDbWarehouseStore({ root });
}, 300_000);

afterAll(async () => {
  await store.close();
  rmSync(root, { recursive: true, force: true });
});

describe('DuckDbWarehouseStore', () => {
  describeCatalogStoreContract(
    (): ContractStore => ({
      name: 'duckdb',
      store,
      // Nothing to register: this adapter derives every column from the def it is handed and
      // resolves the served snapshot from its own pointer, so shaping storage is the whole
      // of publishing here.
      publish: (type) => store.ensureType(type),
      // DuckDB spells a quoted identifier with double quotes; the contract defaults to
      // backticks, which this engine answers with a syntax error.
      quoteIdentifier: (value) => `"${value}"`,
      noModelReason:
        'This adapter stores rows, not the model. A deployment mounts it for the rows and a transactional store for the type model, saved queries and connector definitions — small, mutable, read-modify-write data that object storage is the wrong home for.',
    }),
  );
});
```

- [ ] **Step 2: Run the contract**

```bash
cd /home/dudousxd/personal/oss/nestjs/nestjs-catalog
pnpm test:db -- packages/store-duckdb
```

Expected: some cases FAIL. That is the point of this step. Read each failure, fix the
adapter — not the contract. The suite prints a `[contract] duckdb: …` line for every skip;
every skip must be one this adapter genuinely cannot satisfy, and `noModelReason` is the only
one expected here.

- [ ] **Step 3: Iterate until green**

Re-run after each fix. Do not modify `test/catalog-store-contract.ts`. If a case looks wrong
rather than the adapter, stop and raise it — the suite encodes incidents, and the two most
likely to bite are the source-spelled property case (`Asset Id`, `Asset LIN/TAMCN`,
`Renamed_Id` — `columnName` must NOT redirect a read) and the scalar round-trip case.

- [ ] **Step 4: Commit the green contract**

```bash
git add packages/store-duckdb/src
git commit -m "test(store-duckdb): run the shared store contract"
```

- [ ] **Step 5: Write the atomicity measurement**

Append to `duckdb-warehouse.db.spec.ts`:

```ts
  it('measures whether a cutover is atomic under concurrent reads', async () => {
    // `atomicCutover` is a property of the statement the adapter chose, not of the
    // engine — the ClickHouse adapter got 18 errors from one statement and none
    // from another on the same server. So it is measured here, and the capability
    // object states only what this proves.
    const type = contractType('CutoverRace');
    await store.ensureType(type);
    for (const id of ['run-1', 'run-2']) {
      await store.write(type, [contractRow('a', id, 1)], {
        snapshotId: id,
        principalId: 'tester',
        batch: 1,
      });
    }
    await store.commit(type, 'run-1');

    const failures: unknown[] = [];
    const reads = Array.from({ length: 200 }, async () => {
      try {
        await store.read(type, ['id', 'label'], {});
      } catch (error) {
        failures.push(error);
      }
    });
    const commits = Array.from({ length: 200 }, (_value, index) =>
      store.commit(type, index % 2 === 0 ? 'run-2' : 'run-1'),
    );
    await Promise.all([...reads, ...commits]);

    // Record the number here rather than asserting zero: this assertion is what
    // licenses the capability value, so it has to be the measurement.
    expect(failures).toEqual([]);
  }, 120_000);
```

- [ ] **Step 6: Run the measurement**

```bash
pnpm test:db -- packages/store-duckdb
```

If it passes with zero failures, set `atomicCutover: true` in `capabilities`. If it fails,
leave the field absent and record the number in a comment above `capabilities` — absent is a
legal answer meaning *not stated*, and it is the honest one.

- [ ] **Step 7: Set `atomicBatchReplace` and `transactional`**

`atomicBatchReplace` asks what a concurrent reader sees while a batch is being replaced. A
`COPY … TO` over an existing key on a local filesystem is not atomic; over S3 a `PutObject`
is. Since the two bindings differ, leave the field **absent** and say so in the docblock.

`transactional: false` — there is no cross-statement transaction here, and every operation is
ordered so that re-running is the repair. State it.

- [ ] **Step 8: Update the capabilities assertion in the write spec**

In `duckdb-warehouse.write.spec.ts`, replace the "states nothing about atomicity" case with
the measured values.

- [ ] **Step 9: Commit**

```bash
git add packages/store-duckdb/src
git commit -m "feat(store-duckdb): declare only the atomicity this adapter has measured"
```

---

### Task 13: The S3 binding

**Files:**
- Create: `packages/store-duckdb/src/s3-object-store.ts`
- Create: `packages/store-duckdb/src/s3-object-store.db.spec.ts`
- Modify: `packages/store-duckdb/src/duckdb-warehouse.store.ts`, `src/index.ts`, `package.json`

**Interfaces:**
- Produces: `s3ObjectStore(root: string, options?: DuckDbS3Options): ObjectStore`.

- [ ] **Step 1: Add the SDK as an optional peer**

In `packages/store-duckdb/package.json`, add to `peerDependencies` and
`peerDependenciesMeta`:

```json
  "peerDependencies": {
    "@aws-sdk/client-s3": ">=3",
    "@duckdb/node-api": ">=1.4",
    "@dudousxd/nestjs-catalog": ">=0.1",
    "@nestjs/common": ">=10"
  },
  "peerDependenciesMeta": {
    "@aws-sdk/client-s3": { "optional": true }
  }
```

and to `devDependencies`: `"@aws-sdk/client-s3": "3.945.0"`, `"testcontainers": "11.7.1"`.
Optional because a deployment on a local root should not be made to install an AWS SDK.

- [ ] **Step 2: Write the failing test**

`packages/store-duckdb/src/s3-object-store.db.spec.ts`:

```ts
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { s3ObjectStore } from './s3-object-store';
import type { ObjectStore } from './object-store';

/**
 * The S3 binding, against MinIO.
 *
 * A container here and not for the contract, because this is the one part of the adapter
 * whose behaviour is the object store's rather than DuckDB's: conditional writes are the
 * mechanism the pointer swap rests on, and a fake that returned `undefined` on a losing race
 * would pass while proving nothing about `If-Match`.
 */
const MINIO_IMAGE = 'minio/minio:RELEASE.2025-04-22T22-12-26Z';

let container: StartedTestContainer;
let store: ObjectStore;

beforeAll(async () => {
  container = await new GenericContainer(MINIO_IMAGE)
    .withCommand(['server', '/data'])
    .withEnvironment({ MINIO_ROOT_USER: 'catalog', MINIO_ROOT_PASSWORD: 'catalogsecret' })
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp('/minio/health/live', 9000).forStatusCode(200))
    .withStartupTimeout(240_000)
    .start();

  store = s3ObjectStore('s3://catalog-test/prefix', {
    endpoint: `${container.getHost()}:${container.getMappedPort(9000)}`,
    region: 'us-east-1',
    accessKeyId: 'catalog',
    secretAccessKey: 'catalogsecret',
    urlStyle: 'path',
    useSsl: false,
  });
  await createBucket(store);
}, 300_000);

afterAll(async () => {
  await container?.stop();
});

/** Declared separately so the bucket-creation detail does not sit inside the fixture. */
async function createBucket(target: ObjectStore): Promise<void> {
  await target.put('.keep', 'x');
}

describe('s3ObjectStore', () => {
  it('lets exactly one putIfAbsent win, which is what the pointer swap rests on', async () => {
    const results = await Promise.all([
      store.putIfAbsent('race.json', 'one'),
      store.putIfAbsent('race.json', 'two'),
      store.putIfAbsent('race.json', 'three'),
    ]);
    expect(results.filter((result) => result !== undefined)).toHaveLength(1);
  });

  it('refuses a putIfMatch whose etag has moved', async () => {
    const written = await store.put('cas.json', 'v1');
    await store.put('cas.json', 'v2');
    expect(await store.putIfMatch('cas.json', 'v3', written.etag)).toBeUndefined();
  });

  it('spells a key as an s3 URL DuckDB can read', () => {
    expect(store.locate('mvr/run-1/part-000001.parquet')).toBe(
      's3://catalog-test/prefix/mvr/run-1/part-000001.parquet',
    );
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
pnpm test:db -- packages/store-duckdb/src/s3-object-store.db.spec.ts
```

Expected: FAIL — cannot resolve `./s3-object-store`.

- [ ] **Step 4: Implement**

`packages/store-duckdb/src/s3-object-store.ts`:

```ts
import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { ObjectStore } from './object-store';
import type { DuckDbS3Options } from './options';

/**
 * Object storage, with the two conditional writes the pointer swap needs.
 *
 * `If-None-Match: *` is create-if-absent and `If-Match` is compare-and-swap; S3 answers a
 * loser with `412 Precondition Failed`, and the guarantee AWS states is that "the first
 * write operation to finish succeeds". Both are available in GovCloud.
 *
 * `409 Conflict` is a second losing answer, raised when a delete lands mid-flight, and it is
 * treated the same way: the caller retries. A 409 on a *multipart* completion would need the
 * whole upload re-initiated, which is why every write here is a single `PutObject` — these
 * objects are a pointer and a snapshot record, never rows.
 *
 * The row objects are not written through this. DuckDB writes and reads them itself, at the
 * URL {@link locate} builds, which is why that method exists on the port at all.
 */
export function s3ObjectStore(root: string, options: DuckDbS3Options = {}): ObjectStore {
  const withoutScheme = root.slice('s3://'.length);
  const slash = withoutScheme.indexOf('/');
  const bucket = slash === -1 ? withoutScheme : withoutScheme.slice(0, slash);
  const prefix = slash === -1 ? '' : withoutScheme.slice(slash + 1).replace(/\/$/, '');

  const client = new S3Client({
    region: options.region,
    ...(options.endpoint
      ? { endpoint: `${options.useSsl === false ? 'http' : 'https'}://${options.endpoint}` }
      : {}),
    forcePathStyle: options.urlStyle === 'path',
    ...(options.accessKeyId && options.secretAccessKey
      ? {
          credentials: {
            accessKeyId: options.accessKeyId,
            secretAccessKey: options.secretAccessKey,
            ...(options.sessionToken ? { sessionToken: options.sessionToken } : {}),
          },
        }
      : {}),
  });

  function keyFor(key: string): string {
    return prefix ? `${prefix}/${key}` : key;
  }

  function isPreconditionFailure(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) return false;
    const status: unknown = { ...error }.$metadata;
    if (typeof status !== 'object' || status === null) return false;
    const code: unknown = { ...status }.httpStatusCode;
    return code === 412 || code === 409;
  }

  return {
    async get(key) {
      const response = await client
        .send(new GetObjectCommand({ Bucket: bucket, Key: keyFor(key) }))
        .catch(() => undefined);
      if (!response?.Body || !response.ETag) return undefined;
      return { body: await response.Body.transformToString(), etag: response.ETag };
    },

    async put(key, body) {
      const response = await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: keyFor(key), Body: body }),
      );
      return { etag: response.ETag ?? '' };
    },

    async putIfAbsent(key, body) {
      try {
        const response = await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: keyFor(key),
            Body: body,
            IfNoneMatch: '*',
          }),
        );
        return { etag: response.ETag ?? '' };
      } catch (error) {
        if (isPreconditionFailure(error)) return undefined;
        throw error;
      }
    },

    async putIfMatch(key, body, etag) {
      try {
        const response = await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: keyFor(key),
            Body: body,
            IfMatch: etag,
          }),
        );
        return { etag: response.ETag ?? '' };
      } catch (error) {
        if (isPreconditionFailure(error)) return undefined;
        throw error;
      }
    },

    async list(listPrefix) {
      const found: string[] = [];
      let token: string | undefined;
      do {
        const response = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: `${keyFor(listPrefix)}/`,
            ContinuationToken: token,
          }),
        );
        for (const object of response.Contents ?? []) {
          if (object.Key) {
            found.push(prefix ? object.Key.slice(prefix.length + 1) : object.Key);
          }
        }
        token = response.NextContinuationToken;
      } while (token);
      return found;
    },

    async deletePrefix(deletePrefix) {
      const keys = await this.list(deletePrefix);
      if (keys.length === 0) return 0;
      await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: keys.map((key) => ({ Key: keyFor(key) })) },
        }),
      );
      return keys.length;
    },

    locate(key) {
      return `s3://${bucket}/${keyFor(key)}`;
    },
  };
}

/** Create the bucket if it is absent. For tests and for a first boot against MinIO. */
export async function ensureBucket(client: S3Client, bucket: string): Promise<void> {
  await client.send(new CreateBucketCommand({ Bucket: bucket })).catch(() => undefined);
}
```

- [ ] **Step 5: Bind it in the store**

In `duckdb-warehouse.store.ts`, replace `unsupportedRemoteStore(options.root)` with
`s3ObjectStore(options.root, options.s3)` and delete the `unsupportedRemoteStore` function and
its import.

- [ ] **Step 6: Run it and watch it pass**

```bash
pnpm test:db -- packages/store-duckdb/src/s3-object-store.db.spec.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 7: Export and commit**

Add `export { ensureBucket, s3ObjectStore } from './s3-object-store';` to `src/index.ts`.

```bash
git add packages/store-duckdb pnpm-lock.yaml
git commit -m "feat(store-duckdb): S3 object store using conditional writes for the pointer swap"
```

---

### Task 14: Make the contract a CI gate

**Files:**
- Modify: `.github/workflows/ci.yml`
- Create: `.changeset/store-duckdb.md`

- [ ] **Step 1: Read the current workflow**

```bash
cat /home/dudousxd/personal/oss/nestjs/nestjs-catalog/.github/workflows/ci.yml
```

Note the existing job names, the Node version, and how `pnpm install` is invoked — the new job
must match them.

- [ ] **Step 2: Add a `test:db` job**

Append a job mirroring the existing `test` job's setup, changing only the run step:

```yaml
  test-db:
    name: Store contract (real engines)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v6
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      # The shared store contract is the definition of done for an adapter, and it was a
      # local-only gate until now — a promise nobody enforced. Docker is present on the
      # GitHub-hosted runner, so testcontainers needs no extra setup.
      - run: pnpm test:db
```

- [ ] **Step 3: Add the changeset**

`.changeset/store-duckdb.md`:

```markdown
---
'@dudousxd/nestjs-catalog-store-duckdb': minor
---

New adapter: object rows as Parquet in blob storage, read through DuckDB. One object per
snapshot batch at a deterministic key, so a retried durable step replaces rather than
appends. Snapshot bookkeeping and the served pointer go through a `SnapshotCatalog` port,
with an object-backed binding that needs nothing but a bucket.
```

- [ ] **Step 4: Verify the whole repo is green**

```bash
cd /home/dudousxd/personal/oss/nestjs/nestjs-catalog
pnpm lint
pnpm build
pnpm typecheck
pnpm test
pnpm test:db
```

All five must pass. `typecheck` runs `scripts/typecheck-specs.mjs`, which fails a package that
has specs and no `tsconfig.spec.json` — Task 1 created it, so this is the check that it was
created correctly.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml .changeset/store-duckdb.md
git commit -m "ci: run the store contract on every push"
```

---

## Deferred, deliberately

These are named so nobody has to guess whether they were forgotten.

- **`CatalogQueryStore`** — the SQL console. It needs a read-only boundary enforced at the
  engine rather than by inspecting the string, and DuckDB's answer is not
  `START TRANSACTION READ ONLY`. Settle that before implementing it; until then the console
  simply has no SQL tab against this store, which the core package handles by asking
  `isQueryStore` first.
- **`recordSnapshotArchive` and `locateSnapshot`** — both needed before snapshot eviction can
  run at all, and `recordSnapshotArchive` first needs an answer to what "archive" means when
  the warehouse is already Parquet in object storage. That question is in the spec's open
  items.
- **`streamQuery`** — only worth adding if the driver genuinely back-pressures all the way to
  the socket. Shipping it untested would satisfy the type while doing the thing the type
  exists to avoid.

---

## Self-Review

**Spec coverage.** The spec's adapter section asks for: the contract as definition of done
(Task 12), `snapshots: 'emulated'` and measured atomicity (Tasks 7 and 12), the mandatory
optional methods — `streamSnapshot` (11), `carryForward` (11), `currentSnapshot` (8),
`listSnapshotsWithRows` (10), `findSnapshot` (10), `objectFilterOperators` (9) — `_row` as
mandatory (7), DuckDB writing rather than `hyparquet-writer` (7), SNAPPY only (7), the
snapshot-pointer port with two bindings (5, 13), `quoteIdentifier` for DuckDB (12), the
`tsconfig.spec.base.json` line (1), and CI running `test:db` (14). `recordSnapshotArchive` and
`locateSnapshot` are named in the spec as required for eviction and are **deferred above with
their reason** rather than silently dropped.

**Type consistency.** `ObjectStore` is defined in Task 4 and consumed unchanged in 5, 7 and
13. `SnapshotCatalog` is defined in 5 and consumed in 7, 8, 10, 11. `DuckDbConnection.rows`
returns `Array<Record<string, unknown>>` in Task 6 and is read that way everywhere.
`CARRY_FORWARD_BATCH` is added to `identifiers.ts` in Task 11 and imported there only.
`countStaged` is introduced in Task 7 and used in 8, 10, 11.

**Known gap the executor will hit.** Task 8 introduces the empty-glob guard using `wanted`,
which exists in `read` but not in `countStaged`; Step 4 says so and gives the different return
value for each. If `@duckdb/node-api`'s connection object does not expose `runAndReadAll` or
`closeSync` under those exact names, fix `DuckDbConnection` in Task 6 — it is the one place
the driver's shape is named, which is why it is wrapped rather than used directly.
