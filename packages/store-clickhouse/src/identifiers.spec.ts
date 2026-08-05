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
