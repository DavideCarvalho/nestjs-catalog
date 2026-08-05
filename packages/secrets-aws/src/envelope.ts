import { CatalogKmsVaultError } from './errors';

/**
 * Everything `open` needs, packed into the one field the contract gives us.
 *
 * `SealedSecret` has three fields — `vault`, `keyId`, `ciphertext` — and says
 * the ciphertext is *opaque to the library*. That is a constraint, not a
 * decoration: the wrapped data key, the nonce and the GCM tag have nowhere else
 * to go, so `ciphertext` is a framed binary payload rather than a raw
 * ciphertext, base64 at the boundary. A host that adds a column for the wrapped
 * key later still reads every row written before it, because the row carries its
 * own frame.
 *
 * ```
 *   0   4        6                    6+W        18+W       34+W
 *   +---+--------+--------------------+----------+----------+---------- ... ----+
 *   |CKV1| u16 W  | wrapped data key   |  nonce   | GCM tag  |   ciphertext      |
 *   +---+--------+--------------------+----------+----------+---------- ... ----+
 * ```
 *
 * The tag sits **before** the body rather than appended to it, which is the
 * opposite of the usual convention, so that everything of a fixed size is a
 * fixed offset and the body is simply "the rest". Appending it means every
 * offset in the frame depends on the total length, and a truncated payload then
 * parses as a valid frame with a shorter body — decodable, wrong, and caught
 * only by the tag check. This layout makes truncation a length error with a
 * sentence attached.
 */

/**
 * `CKV1` — Catalog Kms Vault, format 1.
 *
 * A version tag rather than a bare concatenation, and it earns its four bytes
 * twice. It gives a future format somewhere to be told apart from this one, at
 * the only moment that is possible: a v2 frame handed to a v1 reader is refused
 * by name instead of being sliced into nonsense and reported as an
 * authentication failure. And it makes "this column does not hold what you think"
 * — a value from another system, a double-base64, a truncated copy-paste — a
 * refusal that names the problem rather than a tag mismatch that reads as
 * tampering and sends somebody hunting an intruder.
 */
export const ENVELOPE_MAGIC = Buffer.from('CKV1', 'ascii');

/**
 * 96 bits, per NIST SP 800-38D, which is what every AES-GCM implementation is
 * fastest at and the only length that needs no derivation step.
 *
 * Random rather than a counter, and that is safe *here* specifically because
 * this vault never reuses a data key: one `GenerateDataKey` per `seal`, one
 * message per key. The birthday bound that makes random 96-bit nonces
 * uncomfortable — around 2^32 messages under one key — is not approached by a
 * key that encrypts exactly one thing.
 */
export const NONCE_BYTES = 12;

/** 128 bits. The full tag; GCM permits truncation and there is no reason to. */
export const TAG_BYTES = 16;

/** `u16` for the wrapped key length. A KMS `CiphertextBlob` for a 256-bit data
 * key is a couple of hundred bytes; 65535 is room for several rotations of
 * whatever KMS decides to put in there and still costs two bytes. */
const LENGTH_BYTES = 2;
const MAX_WRAPPED_KEY_BYTES = 0xffff;

const OFFSET_LENGTH = ENVELOPE_MAGIC.byteLength;
const OFFSET_WRAPPED = OFFSET_LENGTH + LENGTH_BYTES;

export interface CatalogSecretEnvelope {
  /** The KMS `CiphertextBlob` — the data key, wrapped under the CMK. */
  wrappedKey: Buffer;
  nonce: Buffer;
  tag: Buffer;
  /** The secret itself, under AES-256-GCM with the data key. */
  body: Buffer;
}

/** Frame an envelope into the base64 that goes in `SealedSecret.ciphertext`. */
export function packEnvelope(envelope: CatalogSecretEnvelope): string {
  if (envelope.wrappedKey.byteLength === 0) {
    throw new CatalogKmsVaultError(
      'Refusing to seal an envelope with no wrapped data key. Without it the payload can never be opened, and the row would look identical to a good one until somebody needed it.',
    );
  }
  if (envelope.wrappedKey.byteLength > MAX_WRAPPED_KEY_BYTES) {
    throw new CatalogKmsVaultError(
      `KMS returned a wrapped data key of ${envelope.wrappedKey.byteLength} bytes, which does not fit the envelope's 16-bit length field. This is a format limit of this package, not of KMS.`,
    );
  }

  const length = Buffer.allocUnsafe(LENGTH_BYTES);
  length.writeUInt16BE(envelope.wrappedKey.byteLength, 0);

  return Buffer.concat([
    ENVELOPE_MAGIC,
    length,
    envelope.wrappedKey,
    envelope.nonce,
    envelope.tag,
    envelope.body,
  ]).toString('base64');
}

/**
 * Read a frame back, refusing anything that is not one.
 *
 * Every refusal below happens **before** a KMS call. That ordering is the point:
 * a malformed row should cost nothing, and a caller who can write the column
 * should not be able to turn junk into an unbounded stream of billable,
 * CloudTrail-noise `Decrypt` calls.
 */
export function unpackEnvelope(ciphertext: string): CatalogSecretEnvelope {
  const raw = decodeBase64(ciphertext);

  if (raw.byteLength < OFFSET_WRAPPED || !raw.subarray(0, OFFSET_LENGTH).equals(ENVELOPE_MAGIC)) {
    throw new CatalogKmsVaultError(
      `This sealed secret is not in a format this vault writes: it does not begin with "${ENVELOPE_MAGIC.toString('ascii')}". Either it was sealed by a different vault whose name it is now recorded under, or the stored value has been replaced by something that is not a sealed secret.`,
    );
  }

  const wrappedKeyLength = raw.readUInt16BE(OFFSET_LENGTH);
  const nonceAt = OFFSET_WRAPPED + wrappedKeyLength;
  const tagAt = nonceAt + NONCE_BYTES;
  const bodyAt = tagAt + TAG_BYTES;

  // `>` and not `>=`: a zero-length body is a legitimately sealed empty string,
  // which is a thing a host may store and must get back.
  if (wrappedKeyLength === 0 || raw.byteLength < bodyAt) {
    throw new CatalogKmsVaultError(
      `This sealed secret is truncated: the frame declares a ${wrappedKeyLength}-byte wrapped key and therefore needs at least ${bodyAt} bytes, but only ${raw.byteLength} are present. A value cut short in storage or in transport looks exactly like this.`,
    );
  }

  return {
    wrappedKey: raw.subarray(OFFSET_WRAPPED, nonceAt),
    nonce: raw.subarray(nonceAt, tagAt),
    tag: raw.subarray(tagAt, bodyAt),
    body: raw.subarray(bodyAt),
  };
}

/**
 * `Buffer.from(x, 'base64')` never throws — it stops at the first character it
 * cannot read and returns whatever it decoded, so a truncated or corrupted value
 * silently becomes a short buffer. Re-encoding and comparing is the check Node
 * does not give us, and without it every base64 problem arrives disguised as one
 * of the frame errors above.
 */
function decodeBase64(ciphertext: string): Buffer {
  if (typeof ciphertext !== 'string' || ciphertext.length === 0) {
    throw new CatalogKmsVaultError(
      'This sealed secret has no ciphertext. There is nothing to open, and nothing that can be recovered from the record — the secret has to be entered again.',
    );
  }
  const raw = Buffer.from(ciphertext, 'base64');
  if (raw.toString('base64') !== ciphertext) {
    throw new CatalogKmsVaultError(
      'This sealed secret is not valid base64. The stored value has been altered — re-encoded, wrapped in quotes, or copied through something that trimmed it.',
    );
  }
  return raw;
}
