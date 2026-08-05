import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataKeyCache, zeroKey } from './data-key-cache';

/**
 * The cache, and specifically the two things about it that are security
 * properties rather than performance ones: that an entry expires a fixed time
 * after KMS handed it over no matter how often it is used, and that a key this
 * cache is finished with is overwritten rather than dropped.
 */

function key(fill: number): Buffer {
  return Buffer.alloc(32, fill);
}

const TTL = 60_000;

describe('holding and expiring', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives back the key it was handed', () => {
    const cache = new DataKeyCache(TTL, 8);
    const stored = key(1);
    cache.set('a', stored);

    expect(cache.get('a')).toBe(stored);
  });

  it('answers nothing for a key it never held', () => {
    expect(new DataKeyCache(TTL, 8).get('missing')).toBeUndefined();
  });

  it('drops and zeroes an entry once its TTL has passed', () => {
    const cache = new DataKeyCache(TTL, 8);
    const stored = key(1);
    cache.set('a', stored);

    vi.advanceTimersByTime(TTL);

    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
    expect(stored.equals(Buffer.alloc(32))).toBe(true);
  });

  it('does not extend the TTL when the entry is used', () => {
    // The bound this cache offers is "at most `ttlMs` after a revocation", and a
    // cache that re-armed on every hit would keep exactly the busiest key alive
    // indefinitely — the one a revocation is most likely to be about.
    const cache = new DataKeyCache(TTL, 8);
    cache.set('a', key(1));

    for (let elapsed = 0; elapsed < TTL; elapsed += TTL / 4) {
      expect(cache.get('a')).toBeDefined();
      vi.advanceTimersByTime(TTL / 4);
    }

    expect(cache.get('a')).toBeUndefined();
  });
});

describe('when caching is switched off', () => {
  it('holds nothing and zeroes what it is given', () => {
    const cache = new DataKeyCache(0, 8);
    const stored = key(1);
    cache.set('a', stored);

    expect(cache.enabled).toBe(false);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
    // The caller does not zero — this class owns the buffer from `set` onwards —
    // so if this did not happen, turning caching off would be the configuration
    // that leaves the most key material lying around.
    expect(stored.equals(Buffer.alloc(32))).toBe(true);
  });

  it('is also off when no entries are allowed', () => {
    const cache = new DataKeyCache(TTL, 0);
    const stored = key(1);
    cache.set('a', stored);

    expect(cache.enabled).toBe(false);
    expect(stored.equals(Buffer.alloc(32))).toBe(true);
  });
});

describe('eviction', () => {
  it('never holds more than it was allowed', () => {
    const cache = new DataKeyCache(TTL, 2);
    cache.set('a', key(1));
    cache.set('b', key(2));
    cache.set('c', key(3));

    expect(cache.size).toBe(2);
  });

  it('sheds the least recently used, not the least recently added', () => {
    const cache = new DataKeyCache(TTL, 2);
    cache.set('a', key(1));
    cache.set('b', key(2));
    cache.get('a');
    cache.set('c', key(3));

    expect(cache.get('a')).toBeDefined();
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBeDefined();
  });

  it('zeroes what it evicts', () => {
    const cache = new DataKeyCache(TTL, 1);
    const evicted = key(1);
    cache.set('a', evicted);
    cache.set('b', key(2));

    expect(evicted.equals(Buffer.alloc(32))).toBe(true);
  });

  it('zeroes the loser when two unwraps of one secret race', () => {
    const cache = new DataKeyCache(TTL, 8);
    const first = key(1);
    const second = key(2);
    cache.set('a', first);
    cache.set('a', second);

    expect(cache.get('a')).toBe(second);
    expect(first.equals(Buffer.alloc(32))).toBe(true);
  });

  it('does not blank the key it already holds when handed that same key back', () => {
    // The buffer identity check in `set`. Without it, re-storing a cached key
    // zeroes it and then stores the zeroed buffer — so the *third* open of a
    // secret decrypts under 32 null bytes, fails the GCM tag, and is reported as
    // a tampered ciphertext on a row nobody has touched.
    const cache = new DataKeyCache(TTL, 8);
    const stored = key(1);
    cache.set('a', stored);
    cache.set('a', stored);

    expect(cache.get('a')).toBe(stored);
    expect(stored.equals(Buffer.alloc(32, 1))).toBe(true);
  });
});

describe('clearing', () => {
  it('drops and zeroes everything', () => {
    const cache = new DataKeyCache(TTL, 8);
    const first = key(1);
    const second = key(2);
    cache.set('a', first);
    cache.set('b', second);

    cache.clear();

    expect(cache.size).toBe(0);
    expect(first.equals(Buffer.alloc(32))).toBe(true);
    expect(second.equals(Buffer.alloc(32))).toBe(true);
  });
});

describe('zeroKey', () => {
  it('overwrites in place, so a view of the same memory is overwritten too', () => {
    // This is why the KMS response is viewed rather than copied: `Plaintext`
    // and the buffer this package holds are the same bytes, and zeroing one
    // must zero the other.
    const backing = Buffer.alloc(32, 5);
    const view = Buffer.from(backing.buffer, backing.byteOffset, backing.byteLength);

    zeroKey(view);

    expect(backing.equals(Buffer.alloc(32))).toBe(true);
  });
});
