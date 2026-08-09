/**
 * That this adapter's `ident` is the catalog's rule plus MySQL's quoting, and nothing else.
 *
 * This file used to declare the rule itself — the pattern and the refusal sentence — and so did
 * the ClickHouse adapter, in identical words that nothing compared. The cases below are what
 * replaces that coincidence: the rule is asked for from the core package, `ident` is checked
 * against it rather than against a corpus restated here, and the error class is checked to BE the
 * core's rather than merely to look like it.
 */
import {
  CATALOG_PROVENANCE_COLUMNS,
  CATALOG_RESERVED_COLUMNS,
  UnsafeIdentifierError as CatalogUnsafeIdentifierError,
  isSafeIdentifier,
} from '@dudousxd/nestjs-catalog';
import { describe, expect, it } from 'vitest';
import {
  BATCH_COLUMN,
  LOADED_AT_COLUMN,
  PRINCIPAL_COLUMN,
  RESERVED_COLUMNS,
  ROW_COLUMN,
  SNAPSHOT_COLUMN,
  UnsafeIdentifierError,
  ident,
} from './identifiers';

/** Names a publisher has actually sent, plus the boundary the rule turns on. */
const NAMES = [
  'Mvr',
  'asset_id',
  '_batch',
  'Asset NSN',
  'Sub/Un Sub',
  '9lives',
  '',
  'a'.repeat(63),
  'a'.repeat(64),
];

describe('ident', () => {
  it('quotes with backticks, which is the part that belongs to this adapter', () => {
    expect(ident('asset_id')).toBe('`asset_id`');
  });

  it('accepts and refuses exactly what the catalog rule does', () => {
    // Driven off `isSafeIdentifier` rather than a hand-written verdict per name: a list of
    // expected answers here would be a third copy of the rule, which is the thing this change
    // removed.
    for (const value of NAMES) {
      if (isSafeIdentifier(value)) {
        expect(ident(value)).toBe(`\`${value}\``);
      } else {
        expect(() => ident(value)).toThrow(CatalogUnsafeIdentifierError);
      }
    }
  });

  it('refuses in the words of the core rule, character for character', () => {
    // The publish API refuses the same name before a load starts, quoting the same sentence,
    // because both come from here. Somebody who hits both sees one rule stated twice rather than
    // two rules that might be different.
    expect(() => ident('Asset Id')).toThrow(new CatalogUnsafeIdentifierError('Asset Id').message);
  });
});

describe('UnsafeIdentifierError', () => {
  it('is the class the catalog declares, not a look-alike', () => {
    // Identity, not shape. A per-adapter class with the same name and the same message would pass
    // every assertion above and still break `error instanceof UnsafeIdentifierError` in the
    // pipeline package, turning a 400 that names the property into a 500 that names nothing.
    expect(UnsafeIdentifierError).toBe(CatalogUnsafeIdentifierError);
  });
});

describe('RESERVED_COLUMNS', () => {
  it("is the core package's list, not a copy of it that happens to agree", () => {
    expect(RESERVED_COLUMNS).toBe(CATALOG_RESERVED_COLUMNS);
  });

  it('covers every bookkeeping column this adapter actually writes', () => {
    // The half a re-export cannot give you. Taking the list from the core package stops it drifting
    // from the *contract*; it does nothing about the five constants below drifting from the list,
    // and those are what reach the DDL and the SELECT lists. A column this store writes and its own
    // collision check cannot see is exactly what `_row` was before somebody named it — the same
    // assertion is in the ClickHouse adapter's spec, so the two cannot come apart either.
    expect([...RESERVED_COLUMNS].sort()).toEqual(
      [SNAPSHOT_COLUMN, PRINCIPAL_COLUMN, LOADED_AT_COLUMN, BATCH_COLUMN, ROW_COLUMN].sort(),
    );
  });

  /**
   * And the provenance subset, for the same reason one column deeper.
   *
   * `streamSnapshot` builds its SELECT from the core package's
   * `CATALOG_PROVENANCE_COLUMNS`, and the snapshot archiver checks every row it
   * is handed against the same list. That is what makes the two provably talk
   * about the same columns — but it is only worth anything while those names are
   * the ones this adapter's DDL actually creates. Drift here and the store emits
   * `SELECT "_principal_id"` against a table that has no such column, which is a
   * refusal at least; drift the other way and the archiver quietly accepts rows
   * keyed by a name nothing else uses.
   */
  it('names the two provenance columns this adapter writes', () => {
    expect([...CATALOG_PROVENANCE_COLUMNS].sort()).toEqual(
      [PRINCIPAL_COLUMN, LOADED_AT_COLUMN].sort(),
    );
    // A subset of the reserved list rather than a second vocabulary beside it.
    for (const column of CATALOG_PROVENANCE_COLUMNS) expect(RESERVED_COLUMNS).toContain(column);
  });
});
