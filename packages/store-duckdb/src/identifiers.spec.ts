import { CATALOG_RESERVED_COLUMNS, UnsafeIdentifierError } from '@dudousxd/nestjs-catalog';
import { describe, expect, it } from 'vitest';
import { RESERVED_COLUMNS, batchKey, currentKey, ident, snapshotRecordKey } from './identifiers';

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
