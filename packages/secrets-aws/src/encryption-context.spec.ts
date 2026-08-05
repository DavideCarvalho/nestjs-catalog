import { describe, expect, it } from 'vitest';
import {
  CONTEXT_KEY_FIELD,
  CONTEXT_KEY_KIND,
  additionalAuthenticatedData,
  encryptionContextFor,
} from './encryption-context';

/**
 * The binding, asserted directly.
 *
 * These are the assertions a round trip cannot make. A vault whose encryption
 * context is `{}` and whose AAD is a zero-length buffer seals and opens exactly
 * as well as this one does — it has simply stopped defending anything, and every
 * test that goes in one end and out the other agrees with it.
 */

describe('the encryption context', () => {
  it('binds the kind and the field, and those only', () => {
    expect(encryptionContextFor({ kind: 'connection', field: 'url' })).toEqual({
      [CONTEXT_KEY_KIND]: 'connection',
      [CONTEXT_KEY_FIELD]: 'url',
    });
  });

  it('is namespaced, because one CMK may serve more than this catalog', () => {
    expect(CONTEXT_KEY_KIND).toBe('catalog:kind');
    expect(CONTEXT_KEY_FIELD).toBe('catalog:field');
  });

  it('is identical whether or not the row has an id yet', () => {
    // The one property the whole design turns on. A first save has no id; every
    // read afterwards does. If these two ever differ, every secret this vault
    // has ever sealed is unopenable.
    const before = encryptionContextFor({ kind: 'connection', field: 'url' });
    const after = encryptionContextFor({ kind: 'connection', id: 'conn-1', field: 'url' });

    expect(before).toEqual(after);
    expect(Object.values(after)).not.toContain('conn-1');
  });

  it('distinguishes the two fields of one row', () => {
    const url = encryptionContextFor({ kind: 'connection', id: 'c', field: 'url' });
    const password = encryptionContextFor({ kind: 'connection', id: 'c', field: 'password' });

    expect(url).not.toEqual(password);
  });

  it('distinguishes a connection from a connector', () => {
    expect(encryptionContextFor({ kind: 'connection', field: 'url' })).not.toEqual(
      encryptionContextFor({ kind: 'connector', field: 'url' }),
    );
  });

  it('refuses a blank kind or field rather than binding nothing', () => {
    expect(() => encryptionContextFor({ kind: '', field: 'url' })).toThrow(/empty `kind`/);
    expect(() => encryptionContextFor({ kind: 'connection', field: '   ' })).toThrow(
      /empty `field`/,
    );
  });
});

describe('the additional authenticated data', () => {
  it('is not empty', () => {
    const aad = additionalAuthenticatedData(
      encryptionContextFor({ kind: 'connection', field: 'url' }),
    );

    expect(aad.byteLength).toBeGreaterThan(0);
    expect(aad.toString('utf8')).toContain('connection');
    expect(aad.toString('utf8')).toContain('url');
  });

  it('differs for every context that differs', () => {
    const bytes = (kind: string, field: string) =>
      additionalAuthenticatedData(encryptionContextFor({ kind, field })).toString('base64');

    expect(bytes('connection', 'url')).not.toBe(bytes('connection', 'password'));
    expect(bytes('connection', 'url')).not.toBe(bytes('connector', 'url'));
  });

  it('does not depend on the order the map was built in', () => {
    const straight = additionalAuthenticatedData({ a: '1', b: '2' });
    const reversed = additionalAuthenticatedData({ b: '2', a: '1' });

    expect(straight.equals(reversed)).toBe(true);
  });

  it('cannot be confused by a value that contains the separator', () => {
    // `k=v` concatenation collapses these two to the same bytes. JSON over
    // sorted pairs does not, and `field` is a host-supplied config key.
    const nested = additionalAuthenticatedData({ a: 'b:c' });
    const split = additionalAuthenticatedData({ 'a:b': 'c' });

    expect(nested.equals(split)).toBe(false);
  });
});
