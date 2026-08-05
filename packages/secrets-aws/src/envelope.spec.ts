import { describe, expect, it } from 'vitest';
import {
  type CatalogSecretEnvelope,
  ENVELOPE_MAGIC,
  NONCE_BYTES,
  TAG_BYTES,
  packEnvelope,
  unpackEnvelope,
} from './envelope';
import { CatalogKmsVaultError } from './errors';

/**
 * The frame, on its own.
 *
 * Every one of these failures reaches the vault as a value somebody stored:
 * truncated by a column that was too narrow, re-encoded by an export, replaced
 * by a hand-run `UPDATE`, or written by a version of this package that does not
 * exist yet. What matters is that each is refused with a sentence naming which
 * of those it looks like — a frame error reported as an authentication failure
 * sends an operator hunting an intruder who is not there.
 */

function envelope(overrides: Partial<CatalogSecretEnvelope> = {}): CatalogSecretEnvelope {
  return {
    wrappedKey: Buffer.alloc(184, 7),
    nonce: Buffer.alloc(NONCE_BYTES, 1),
    tag: Buffer.alloc(TAG_BYTES, 2),
    body: Buffer.from('body-bytes', 'utf8'),
    ...overrides,
  };
}

describe('packing and unpacking', () => {
  it('gives back exactly what went in', () => {
    const original = envelope();
    const unpacked = unpackEnvelope(packEnvelope(original));

    expect(unpacked.wrappedKey.equals(original.wrappedKey)).toBe(true);
    expect(unpacked.nonce.equals(original.nonce)).toBe(true);
    expect(unpacked.tag.equals(original.tag)).toBe(true);
    expect(unpacked.body.equals(original.body)).toBe(true);
  });

  it('handles a zero-length body, which is a sealed empty string', () => {
    const unpacked = unpackEnvelope(packEnvelope(envelope({ body: Buffer.alloc(0) })));

    expect(unpacked.body.byteLength).toBe(0);
    expect(unpacked.tag.byteLength).toBe(TAG_BYTES);
  });

  it('separates the parts by the declared length, not by a fixed guess', () => {
    // A wrapped key of a different size — KMS blobs are not a fixed width, and
    // reading the length field is what makes that a non-event.
    const original = envelope({ wrappedKey: Buffer.alloc(600, 9) });
    const unpacked = unpackEnvelope(packEnvelope(original));

    expect(unpacked.wrappedKey.byteLength).toBe(600);
    expect(unpacked.body.equals(original.body)).toBe(true);
  });

  it('starts with the version tag', () => {
    const raw = Buffer.from(packEnvelope(envelope()), 'base64');

    expect(raw.subarray(0, ENVELOPE_MAGIC.byteLength).equals(ENVELOPE_MAGIC)).toBe(true);
  });
});

describe('what it refuses', () => {
  it('refuses to write a frame with no wrapped key', () => {
    expect(() => packEnvelope(envelope({ wrappedKey: Buffer.alloc(0) }))).toThrow(
      /no wrapped data key/,
    );
  });

  it('refuses a wrapped key too large for the length field', () => {
    expect(() => packEnvelope(envelope({ wrappedKey: Buffer.alloc(70_000) }))).toThrow(
      /16-bit length field/,
    );
  });

  it('refuses a value that is not one of these frames', () => {
    expect(() => unpackEnvelope(Buffer.from('some other thing').toString('base64'))).toThrow(
      /does not begin with "CKV1"/,
    );
  });

  it('refuses a frame from a format this version does not know', () => {
    const raw = Buffer.from(packEnvelope(envelope()), 'base64');
    raw.write('CKV9', 0, 'ascii');

    expect(() => unpackEnvelope(raw.toString('base64'))).toThrow(/does not begin with "CKV1"/);
  });

  it('refuses a truncated frame, naming what it needed', () => {
    const raw = Buffer.from(packEnvelope(envelope()), 'base64');

    expect(() => unpackEnvelope(raw.subarray(0, raw.byteLength - 40).toString('base64'))).toThrow(
      /truncated/,
    );
  });

  it('refuses a frame whose declared key length runs past the end', () => {
    const raw = Buffer.from(packEnvelope(envelope()), 'base64');
    raw.writeUInt16BE(60_000, ENVELOPE_MAGIC.byteLength);

    expect(() => unpackEnvelope(raw.toString('base64'))).toThrow(/truncated/);
  });

  it('refuses a frame declaring a zero-length key', () => {
    const raw = Buffer.from(packEnvelope(envelope()), 'base64');
    raw.writeUInt16BE(0, ENVELOPE_MAGIC.byteLength);

    expect(() => unpackEnvelope(raw.toString('base64'))).toThrow(/truncated/);
  });

  it('refuses non-canonical base64 rather than decoding whatever it can', () => {
    // `Buffer.from(x, 'base64')` stops at the first unreadable character and
    // returns what it got, so without the re-encode check this arrives as a
    // frame error about a value that is really an encoding problem.
    expect(() => unpackEnvelope(`${packEnvelope(envelope())} not base64!`)).toThrow(
      /not valid base64/,
    );
  });

  it('refuses an empty ciphertext', () => {
    expect(() => unpackEnvelope('')).toThrow(CatalogKmsVaultError);
    expect(() => unpackEnvelope('')).toThrow(/no ciphertext/);
  });
});
