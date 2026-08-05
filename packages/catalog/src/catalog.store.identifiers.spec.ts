/**
 * The one rule about what may be written into SQL as an identifier.
 *
 * It used to be two rules that happened to agree: `store-mikro-orm` and
 * `store-clickhouse` each carried the pattern and the sentence, byte for byte,
 * and nothing anywhere compared them. The publish-time refusal in the pipeline
 * package borrowed the MySQL copy so that a payload refused at publish and the
 * same payload refused at DDL could not be described differently — which is a
 * guarantee for a MySQL deployment and an assumption for a ClickHouse-only one.
 *
 * So the rule moved here, and the cases below are what "the rule" means: which
 * characters, how long, and the exact sentence a publisher is handed. Each
 * store's own spec then checks that its `ident` is this and nothing else.
 */
import { describe, expect, it } from 'vitest';
import { UnsafeIdentifierError, assertSafeIdentifier, isSafeIdentifier } from './catalog.store';

describe('isSafeIdentifier', () => {
  it('accepts what a store can write unquoted-safe', () => {
    expect(['Mvr', 'asset_id', '_batch', 'A1', '_', 'x_9_Y'].filter(isSafeIdentifier)).toEqual([
      'Mvr',
      'asset_id',
      '_batch',
      'A1',
      '_',
      'x_9_Y',
    ]);
  });

  it('refuses a name that does not start with a letter or underscore', () => {
    // A leading digit is the one that looks harmless and is not: `9lives` is a number followed by
    // a word to most parsers, and the failure surfaces as a syntax error in a statement nobody
    // wrote by hand.
    expect(isSafeIdentifier('9lives')).toBe(false);
    expect(isSafeIdentifier('1')).toBe(false);
  });

  it('refuses anything outside letters, digits and underscore', () => {
    // The names publishers actually send. A space and a slash are what `Asset NSN` and
    // `Sub/Un Sub` are made of, and both reached a view alias before this was checked at publish.
    for (const value of ['Asset NSN', 'Sub/Un Sub', 'total-rows', 'a.b', 'a`b', 'año', 'a;b']) {
      expect(isSafeIdentifier(value)).toBe(false);
    }
  });

  it('refuses an empty name', () => {
    // Not a hypothetical: a property whose name is stripped to nothing by a caller's own cleaning
    // arrives here as `''`, and an empty identifier quotes to `` which the engine reads as the
    // next token.
    expect(isSafeIdentifier('')).toBe(false);
  });

  it('stops at 63 characters, the number the refusal quotes', () => {
    // The boundary is asserted rather than the middle, because the only way this drifts is
    // somebody changing the bound and not the sentence — which is what one definition exists to
    // make impossible, and this is the case that notices.
    expect(isSafeIdentifier('a'.repeat(63))).toBe(true);
    expect(isSafeIdentifier('a'.repeat(64))).toBe(false);
  });

  it('is asked the same question twice and answers the same', () => {
    // The pattern is module state. A `/g` flag on it would make `test` resume from `lastIndex` and
    // give a different answer on the second call for the same string — a bug that would show up as
    // one property in a payload of forty being refused at random.
    expect(isSafeIdentifier('Mvr')).toBe(true);
    expect(isSafeIdentifier('Mvr')).toBe(true);
  });
});

describe('assertSafeIdentifier', () => {
  it('says nothing about a name a store can use', () => {
    expect(() => assertSafeIdentifier('asset_id')).not.toThrow();
  });

  it('refuses in the words the publisher is given, naming the value', () => {
    // Spelled out rather than snapshotted. This sentence is the whole of the rule's documentation
    // for most people who meet it — it arrives in a 400 from the publish API and in a failed load
    // — so changing it is a decision, and a decision should fail a test.
    expect(() => assertSafeIdentifier('Asset Id')).toThrow(
      'Refusing to use "Asset Id" as a SQL identifier: letters, digits and underscore only, ' +
        'starting with a letter or underscore, 63 characters max.',
    );
  });

  it('throws the shared class, which is what makes catching it worth doing', () => {
    // `identifierRefusal` in the pipeline package catches exactly this to tell "your name cannot
    // be an identifier" from "the store broke". With a class per adapter that check re-throws the
    // moment the mounted store is not the one it imported.
    expect(() => assertSafeIdentifier('Asset Id')).toThrow(UnsafeIdentifierError);
  });
});
