/**
 * That this adapter's `ident` is the catalog's rule plus ClickHouse's quoting, and nothing else.
 *
 * The half of the guarantee that was missing. The publish-time refusal in the pipeline package
 * deliberately reuses one store's `ident` so that a name refused at publish and the same name
 * refused at DDL cannot be described differently — and the copy it reused was the MySQL one. That
 * made this file, which carried its own byte-identical pattern and sentence, the thing a
 * ClickHouse-only deployment was trusting to have been edited in step. It no longer has its own:
 * the rule comes from the core package, and these cases are what says so.
 */
import {
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
    // Driven off `isSafeIdentifier` rather than a hand-written verdict per name, so this cannot
    // become the third statement of a rule that already has one.
    for (const value of NAMES) {
      if (isSafeIdentifier(value)) {
        expect(ident(value)).toBe(`\`${value}\``);
      } else {
        expect(() => ident(value)).toThrow(CatalogUnsafeIdentifierError);
      }
    }
  });

  it('refuses in the words of the core rule, character for character', () => {
    // What a ClickHouse-only deployment could not previously be sure of: this sentence and the one
    // the publish API quotes are one string, not two that agreed when they were last read.
    expect(() => ident('Asset Id')).toThrow(new CatalogUnsafeIdentifierError('Asset Id').message);
  });
});

describe('UnsafeIdentifierError', () => {
  it('is the class the catalog declares, not a look-alike', () => {
    // Identity, not shape — and the same assertion the MySQL adapter's spec makes, which is what
    // makes the two adapters comparable at all without a spec that imports both.
    expect(UnsafeIdentifierError).toBe(CatalogUnsafeIdentifierError);
  });
});

describe('RESERVED_COLUMNS', () => {
  it("is the core package's list, not a copy of it that happens to agree", () => {
    // Identity again, and for the reason the identifier rule is: this list was assembled here from
    // this adapter's own constants while the docblock at the top of the file already said it came
    // from the core package. The two agreed, which is what made the claim survive being read.
    expect(RESERVED_COLUMNS).toBe(CATALOG_RESERVED_COLUMNS);
  });

  it('covers every bookkeeping column this adapter actually writes', () => {
    // The other half, and the one the move could have broken. The five constants below are what
    // goes into `CREATE TABLE` and into every SELECT list; the list above is what a publisher's
    // property name is checked against. Renaming one of them without moving the core's list would
    // give this store a column it writes and cannot see a collision with — which is `_row` all over
    // again, the constant that existed precisely because a literal buried in a SQL string was
    // missing from the reserved list.
    expect([...RESERVED_COLUMNS].sort()).toEqual(
      [SNAPSHOT_COLUMN, PRINCIPAL_COLUMN, LOADED_AT_COLUMN, BATCH_COLUMN, ROW_COLUMN].sort(),
    );
  });
});
