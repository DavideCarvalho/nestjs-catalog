/**
 * Overwrite key material we are done with.
 *
 * Node cannot promise this is the last copy — a generational GC may have moved
 * the bytes, and `Buffer.from(response.Plaintext)` would have made a second one,
 * which is why this package never copies a data key and views the SDK's array in
 * place instead. What zeroing does buy is real and worth three lines: a heap
 * snapshot, a core dump, or a `/proc/pid/mem` read taken after the key stopped
 * being used no longer finds it sitting in a still-allocated buffer. It removes
 * the copy we *can* reach, and it makes "how long is a data key resident" a
 * question with an answer instead of "until the allocator feels like it".
 */
export function zeroKey(key: Buffer): void {
  key.fill(0);
}

interface CacheEntry {
  key: Buffer;
  expiresAt: number;
}

/**
 * Plaintext data keys, held for a bounded time so that opening the same secret
 * twice is not two KMS calls.
 *
 * ## Why a cache exists at all
 *
 * Envelope encryption puts a fresh data key on every secret, which is the right
 * shape for blast radius — one compromised data key is one compromised secret —
 * and it means `open` costs a `kms:Decrypt` round trip, every time. That is not
 * a theoretical cost. A connector that runs every five minutes opens the same
 * connection URL every five minutes; a page that lists twenty connections and
 * checks each one is twenty calls; and `kms:Decrypt` is quota'd per account and
 * per region, shared with everything else in the account. Without a cache, the
 * throughput of reading configuration is tied to a service limit somebody else
 * is also spending.
 *
 * ## What is cached, and what is deliberately not
 *
 * **Cached: the unwrapped data key.** Keyed by the wrapped blob *and* the
 * encryption context, so a hit can never stand in for the context check — moving
 * a ciphertext to another field finds no entry, and would still fail the GCM tag
 * if it did.
 *
 * **Not cached: the secret.** The plaintext URL or password is produced, handed
 * to the caller and dropped. Caching it would save an AES operation costing
 * microseconds while keeping the actual credential resident, which is the wrong
 * side of every trade here.
 *
 * **Not cached: anything on the `seal` path.** The AWS Encryption SDK's caching
 * material manager will reuse one data key across many encryptions, and this
 * does not: seals happen when a human saves a connection, so there is no rate to
 * relieve, and reuse would put several secrets under one key for nothing.
 *
 * ## What it costs
 *
 * A decrypted data key in memory is precisely what an attacker with a foothold
 * in this process wants, and the TTL is how long a key stays worth stealing
 * after its last use. It is also, and this is the part that surprises people,
 * **how long a revocation takes to bite**: disable the CMK, or strip
 * `kms:Decrypt` from the role, and any secret whose key is already cached keeps
 * opening until its entry expires. The default is five minutes for that reason
 * rather than for the memory.
 *
 * Set `ttlMs` to `0` and there is no cache at all — every `open` is a `Decrypt`,
 * revocation is immediate, and every single access to a secret appears in
 * CloudTrail as its own event. That last property is not a nicety in a regulated
 * deployment: if the control you are evidencing is "every access to a credential
 * is logged", a cache hit is an access with no log line, and the only correct
 * setting is `0`.
 */
export class DataKeyCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
  ) {}

  get enabled(): boolean {
    return this.ttlMs > 0 && this.maxEntries > 0;
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * The live key for this blob, or `undefined`.
   *
   * Expiry is checked here rather than on a timer. A timer would keep the
   * process awake and, worse, would hold a reference to every entry for the
   * length of its TTL whether or not anybody still wanted it — the opposite of
   * what the TTL is for. An expired entry found on the way past is zeroed at
   * that moment.
   *
   * **A hit does not extend the TTL**, and that is the difference between a
   * bound and a hope. `expiresAt` is set once, from the moment KMS handed the
   * key over, so "at most `ttlMs` after you revoke access" is true of every
   * entry. Re-arming on use — which is what a cache aiming purely at hit rate
   * would do — means the *most* frequently opened secret, the one an attacker
   * most wants and the one a revocation is most likely to be about, is the one
   * whose key never expires at all.
   *
   * Recency is still tracked, for eviction only: the entry moves to the back of
   * the Map's insertion order so the limit below sheds the least-recently-*used*
   * rather than the oldest-fetched. That is the right shape for this workload —
   * a handful of connections opened constantly and a long tail opened once — and
   * it costs nothing, because the expiry it does not touch is the thing keeping
   * the promise.
   */
  get(cacheKey: string): Buffer | undefined {
    const entry = this.entries.get(cacheKey);
    if (entry === undefined) return undefined;

    if (Date.now() >= entry.expiresAt) {
      this.entries.delete(cacheKey);
      zeroKey(entry.key);
      return undefined;
    }

    this.entries.delete(cacheKey);
    this.entries.set(cacheKey, entry);
    return entry.key;
  }

  /**
   * Hand a freshly unwrapped data key over. **This takes ownership of the
   * buffer** — after calling it, the caller must not zero the key, and must not
   * keep reading it beyond the call it is already inside.
   *
   * Ownership is stated because it is the only way "the key gets zeroed exactly
   * once, whether or not caching is on" has a single place to be true. A
   * disabled cache zeroes immediately and stores nothing, so the caller's code
   * path is identical either way; a caller that also zeroed would blank a key
   * this cache had just promised to keep.
   */
  set(cacheKey: string, key: Buffer): void {
    if (!this.enabled) {
      zeroKey(key);
      return;
    }

    const existing = this.entries.get(cacheKey);
    if (existing !== undefined) {
      this.entries.delete(cacheKey);
      // `!==` and not an unconditional zero. Two opens of the same secret that
      // both miss the cache — which is what a cold start under concurrency looks
      // like — each unwrap their own buffer and each hand it over, so replacing
      // is ordinary and the loser must be wiped. Handing back the buffer this
      // cache already holds is a different thing entirely, and zeroing it would
      // store an entry of 32 zero bytes: every subsequent open would find a
      // cache hit, decrypt under a null key, and fail the GCM tag — reported as
      // a tampered ciphertext, on a row nobody has touched.
      if (existing.key !== key) zeroKey(existing.key);
    }

    this.entries.set(cacheKey, { key, expiresAt: Date.now() + this.ttlMs });

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      const evicted = this.entries.get(oldest.value);
      this.entries.delete(oldest.value);
      if (evicted !== undefined) zeroKey(evicted.key);
    }
  }

  /**
   * Drop and zero everything.
   *
   * Exported rather than internal because it is the operational answer to "we
   * have rotated the key / revoked the role / think this pod is compromised, and
   * we are not waiting out the TTL". A host wires it to whatever it uses for
   * that; there is no bundled route, for the same reason the fan-out ships no
   * controller.
   */
  clear(): void {
    for (const entry of this.entries.values()) zeroKey(entry.key);
    this.entries.clear();
  }
}
