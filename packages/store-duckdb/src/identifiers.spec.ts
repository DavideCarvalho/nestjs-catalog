import { CATALOG_RESERVED_COLUMNS, UnsafeIdentifierError } from '@dudousxd/nestjs-catalog';
import { describe, expect, it } from 'vitest';
import {
  RESERVED_COLUMNS,
  batchKey,
  currentKey,
  ident,
  snapshotPrefix,
  snapshotRecordKey,
  typePrefix,
} from './identifiers';

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

describe('key segments', () => {
  it('accepts the ids the pipeline actually generates', () => {
    // `newSnapshotId` builds `<prefix>-<8 hex>` and a durable run id is a UUID; the store's
    // own specs also drive `nightly.staging` through `write`. A rule that refused any of
    // these would be refusing ordinary traffic, which is the whole reason this is not
    // `assertSafeIdentifier` — that one rejects a dash and so rejects every id above.
    expect(snapshotPrefix('mvr', 'run-1')).toBe('mvr/run-1');
    expect(snapshotPrefix('mvr', '0b7c1e5a-3f2d-4c81-9a6e-7d4f2b1c8e90')).toBe(
      'mvr/0b7c1e5a-3f2d-4c81-9a6e-7d4f2b1c8e90',
    );
    expect(snapshotPrefix('mvr', 'nightly.staging')).toBe('mvr/nightly.staging');
    expect(snapshotPrefix('mvr', 'wf-1a2b3c4d')).toBe('mvr/wf-1a2b3c4d');
  });

  it('refuses a snapshot id that would climb out of the configured root', () => {
    // `snapshotPrefix` becomes a directory and `pathFor` joins it to the root, so this is a
    // `COPY … TO` outside the bucket on the way in and a recursive delete on the way out.
    expect(() => snapshotPrefix('mvr', '..')).toThrow(/Refusing ".."/);
    expect(() => snapshotPrefix('mvr', '../../etc')).toThrow(/snapshot id/);
  });

  it('refuses a snapshot id carrying the separator this store builds keys with', () => {
    expect(() => snapshotPrefix('mvr', 'a/b')).toThrow(/snapshot id/);
  });

  it('refuses a leading underscore, which is this store own namespace', () => {
    expect(() => snapshotPrefix('mvr', '_hidden')).toThrow(/leading underscore/);
  });

  it('refuses `_snapshots` specifically, because dropping it would erase the whole history', () => {
    // With no traversal character at all, this id makes `snapshotPrefix` name the directory
    // holding every snapshot record the type has — and `dropSnapshot` deletes that prefix.
    expect(() => snapshotPrefix('mvr', '_snapshots')).toThrow(/_snapshots/);
    expect(snapshotRecordKey('mvr', 'run-1')).toBe('mvr/_snapshots/run-1.json');
  });

  it('refuses an empty snapshot id, which addresses the type prefix itself', () => {
    expect(() => snapshotPrefix('mvr', '')).toThrow(/snapshot id/);
  });

  it('applies the same rule to the type name, where the join happens', () => {
    expect(typePrefix('MVR')).toBe('mvr');
    expect(() => typePrefix('..')).toThrow(/type name/);
    expect(() => currentKey('../..')).toThrow(/type name/);
  });
});
