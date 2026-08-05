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
  UnsafeIdentifierError as CatalogUnsafeIdentifierError,
  isSafeIdentifier,
} from '@dudousxd/nestjs-catalog';
import { describe, expect, it } from 'vitest';
import { UnsafeIdentifierError, ident } from './identifiers';

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
