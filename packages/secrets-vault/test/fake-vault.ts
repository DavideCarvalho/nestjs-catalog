import type { VaultFetch, VaultFetchInit } from '@dudousxd/nestjs-catalog-secrets-vault';

/**
 * The HTTP boundary this package's tests stub, and a fake Vault that really
 * encrypts.
 *
 * **No network, and the stub sits at `fetch`.** That is the lowest seam this
 * package owns: everything above it — the token cache, the retry policy, the
 * base64 on both sides, the path construction — is real code running for real.
 * Stubbing `TransitClient` instead would have left the interesting half
 * (`what did we actually send Vault`) unasserted, and the request shape is the
 * part a provider gets wrong in ways no round trip would reveal.
 *
 * **{@link fakeTransitVault} transforms the bytes.** A fake that echoed a
 * canned ciphertext would pass every encoding bug ever written: a provider that
 * base64s twice, or reads `plaintext` as UTF-8 when Vault sent base64, round
 * trips perfectly against an echo. This one derives a keystream, XORs the
 * plaintext under it, prefixes a nonce, and checks an embedded digest on the way
 * back — so a wrong encoding produces a wrong plaintext or a rejected
 * ciphertext, exactly as Vault would. It also tracks key versions, so rotation
 * and rewrap can be exercised rather than asserted about.
 */

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** The parsed request body. Every call this package makes sends JSON. */
  body: Record<string, unknown>;
}

export interface StubReply {
  status?: number;
  /** An object is JSON-encoded; a string is sent verbatim, for malformed-body tests. */
  body?: unknown;
}

export type StubHandler = (call: RecordedCall) => StubReply;

/** A `VaultFetch` that records what it was asked and answers from `handler`. */
export function stubFetch(handler: StubHandler): { fetch: VaultFetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetch: VaultFetch = (url, init: VaultFetchInit) => {
    const parsed: unknown = JSON.parse(init.body);
    const body = typeof parsed === 'object' && parsed !== null ? parsed : {};
    const call: RecordedCall = {
      url,
      method: init.method,
      headers: init.headers,
      body: Object.fromEntries(Object.entries(body)),
    };
    calls.push(call);
    const reply = handler(call);
    const status = reply.status ?? 200;
    const text =
      typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? { data: {} });
    return Promise.resolve({
      status,
      ok: status >= 200 && status < 300,
      text: () => Promise.resolve(text),
    });
  };
  return { fetch, calls };
}

/** A `VaultFetch` that answers every call the same way. */
export function stubReplying(reply: StubReply): { fetch: VaultFetch; calls: RecordedCall[] } {
  return stubFetch(() => reply);
}

/** A `VaultFetch` that answers the given replies in order, repeating the last. */
export function stubSequence(replies: StubReply[]): { fetch: VaultFetch; calls: RecordedCall[] } {
  let index = 0;
  return stubFetch(() => {
    const reply = replies[Math.min(index, replies.length - 1)] ?? {};
    index += 1;
    return reply;
  });
}

// ---------------------------------------------------------------------------
// A Transit engine that actually transforms bytes.
// ---------------------------------------------------------------------------

/** FNV-1a seeded xorshift. Deterministic, so a failing test fails the same way
 *  twice — which a real random nonce would not give us. */
function keystream(seed: string, length: number): Buffer {
  let state = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    state = Math.imul(state ^ seed.charCodeAt(index), 0x01000193) >>> 0;
  }
  const out = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) {
    state = (state ^ (state << 13)) >>> 0;
    state = (state ^ (state >>> 17)) >>> 0;
    state = (state ^ (state << 5)) >>> 0;
    out[index] = state & 0xff;
  }
  return out;
}

/** Four bytes standing in for Vault's AEAD tag: enough that decrypting under
 *  the wrong derived key is *rejected* rather than returning plausible rubbish. */
function digest(bytes: Buffer): Buffer {
  let state = 0x811c9dc5;
  for (const byte of bytes) state = Math.imul(state ^ byte, 0x01000193) >>> 0;
  const out = Buffer.alloc(4);
  out.writeUInt32BE(state);
  return out;
}

function xor(bytes: Buffer, stream: Buffer): Buffer {
  const out = Buffer.alloc(bytes.length);
  for (let index = 0; index < bytes.length; index += 1) {
    const streamByte = stream[index] ?? 0;
    out[index] = (bytes[index] ?? 0) ^ streamByte;
  }
  return out;
}

const NONCE_LENGTH = 4;

export interface FakeTransitOptions {
  /** Paths that should answer 403 once before succeeding, to drive re-login. */
  namespace?: string;
}

export interface FakeTransitVault {
  fetch: VaultFetch;
  calls: RecordedCall[];
  /** Bump a key's current version, as `vault write -f transit/keys/rotate/k`. */
  rotate(keyPath: string): void;
  /** Refuse to decrypt below this version, as `min_decryption_version`. */
  setMinDecryptionVersion(keyPath: string, version: number): void;
}

/**
 * A Transit mount that encrypts, decrypts, rewraps and rotates.
 *
 * `keyPath` is `<mount>/<key>` — the same string this package puts in `keyId`,
 * which means a test that gets the key id wrong reaches a key that does not
 * exist here and fails, rather than quietly hitting the only key in the fake.
 */
export function fakeTransitVault(options: FakeTransitOptions = {}): FakeTransitVault {
  const versions = new Map<string, number>();
  const minVersions = new Map<string, number>();
  let nonceCounter = 0;

  const currentVersion = (keyPath: string): number => versions.get(keyPath) ?? 1;

  const encryptAt = (
    keyPath: string,
    version: number,
    plaintext: Buffer,
    context: string,
  ): string => {
    const nonce = Buffer.alloc(NONCE_LENGTH);
    nonce.writeUInt32BE(nonceCounter);
    nonceCounter += 1;
    const payload = Buffer.concat([digest(plaintext), plaintext]);
    const stream = keystream(`${keyPath}|${version}|${context}`, payload.length);
    return `vault:v${version}:${Buffer.concat([nonce, xor(payload, stream)]).toString('base64')}`;
  };

  /** `undefined` when the ciphertext does not authenticate — the fake's 400. */
  const decryptTo = (keyPath: string, ciphertext: string, context: string): Buffer | undefined => {
    const match = /^vault:v([1-9][0-9]*):(.*)$/.exec(ciphertext);
    if (match === null) return undefined;
    const version = Number(match[1]);
    if (version < (minVersions.get(keyPath) ?? 1)) return undefined;
    const raw = Buffer.from(match[2] ?? '', 'base64');
    const payload = raw.subarray(NONCE_LENGTH);
    const stream = keystream(`${keyPath}|${version}|${context}`, payload.length);
    const opened = xor(payload, stream);
    const plaintext = opened.subarray(4);
    return digest(plaintext).equals(opened.subarray(0, 4)) ? plaintext : undefined;
  };

  const NOT_FOUND: StubReply = { status: 404, body: { errors: ['no handler for route'] } };

  /** `<mount>/<op>/<key>` — the shape every Transit data-path route has. */
  const routeOf = (url: string): { operation: string; keyPath: string } => {
    const parts = new URL(url).pathname.replace(/^\/v1\//, '').split('/');
    const keyName = parts[parts.length - 1] ?? '';
    return {
      operation: parts[parts.length - 2] ?? '',
      keyPath: `${parts.slice(0, -2).join('/')}/${keyName}`,
    };
  };

  const sealedReply = (keyPath: string, plaintext: Buffer, context: string): StubReply => {
    const version = currentVersion(keyPath);
    return {
      body: {
        data: { ciphertext: encryptAt(keyPath, version, plaintext, context), key_version: version },
      },
    };
  };

  const openingReply = (
    keyPath: string,
    operation: string,
    ciphertext: string,
    context: string,
  ): StubReply => {
    const opened = decryptTo(keyPath, ciphertext, context);
    if (opened === undefined) {
      return { status: 400, body: { errors: ['invalid ciphertext: unable to decrypt'] } };
    }
    return operation === 'decrypt'
      ? { body: { data: { plaintext: opened.toString('base64') } } }
      : sealedReply(keyPath, opened, context);
  };

  const { fetch, calls } = stubFetch((call) => {
    if (
      options.namespace !== undefined &&
      call.headers['X-Vault-Namespace'] !== options.namespace
    ) {
      return NOT_FOUND;
    }
    const { operation, keyPath } = routeOf(call.url);
    const context = typeof call.body.context === 'string' ? call.body.context : '';

    if (operation === 'encrypt') {
      return sealedReply(keyPath, Buffer.from(String(call.body.plaintext), 'base64'), context);
    }
    if (operation === 'decrypt' || operation === 'rewrap') {
      return openingReply(keyPath, operation, String(call.body.ciphertext), context);
    }
    return NOT_FOUND;
  });

  return {
    fetch,
    calls,
    rotate: (keyPath) => versions.set(keyPath, currentVersion(keyPath) + 1),
    setMinDecryptionVersion: (keyPath, version) => minVersions.set(keyPath, version),
  };
}
