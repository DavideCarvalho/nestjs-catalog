import type { SecretContext } from '@dudousxd/nestjs-catalog';
import { CatalogKmsVaultError } from './errors';

/**
 * The keys this vault binds a data key to. Namespaced, because a KMS key is a
 * shared resource: the same CMK may wrap data keys for this catalog, for an S3
 * bucket, and for whatever the team next door built, and an unprefixed `kind`
 * is a name two of those will pick.
 *
 * These strings are **part of the wire format**. Changing one makes every
 * existing row undecryptable, because KMS compares the context byte for byte and
 * a `Decrypt` whose context differs from the `GenerateDataKey` that made the blob
 * fails — which is the entire point of it. Treat them as you would a column name
 * in a shipped migration.
 */
export const CONTEXT_KEY_KIND = 'catalog:kind';
export const CONTEXT_KEY_FIELD = 'catalog:field';

/**
 * Bind a data key to the *place* the secret lives, so a ciphertext lifted out of
 * one cell cannot be decrypted in another.
 *
 * KMS takes an encryption context on `GenerateDataKey` and requires the same map
 * on `Decrypt`. It is additional authenticated data: not secret, not stored by
 * KMS, and enforced exactly — a single differing byte and the unwrap fails.
 * This vault binds the same map a second time, as AES-GCM AAD around the payload
 * itself (see {@link additionalAuthenticatedData}), so the binding survives even
 * a stolen data key.
 *
 * ## What is bound: `kind` and `field`. Not `id`.
 *
 * `id` is the field everyone reaches for first, and it is the one that cannot go
 * in here. {@link SecretContext.id} is *absent on a first save* — the row does
 * not have an identity until it has been written — while every subsequent read
 * of that row supplies one. Bind it and the context at `seal` (`id` missing) can
 * never equal the context at `open` (`id` present), so **every secret would be
 * sealed unopenable**, from the first one, forever, with the failure surfacing
 * as an opaque `InvalidCiphertextException` rather than as anything naming the
 * cause. Binding it "only when present" is the same bug wearing a hat: it makes
 * openability depend on whether the caller happened to have an id in hand, which
 * varies by call site.
 *
 * The tempting middle path — record in the envelope whether the id *was* bound,
 * so `open` can reconstruct the exact context — was considered and rejected. It
 * works, and it buys row-level binding for every save after the first; what it
 * costs is that any operation which moves a secret to a new row breaks it. A
 * "duplicate this connection" button, a restore that reassigns ids, a migration
 * that renumbers: each turns into a set of rows that decrypt to nothing, and the
 * blast radius of getting it wrong is credentials nobody can recover. A vault's
 * first duty is that the secret is still there in three years.
 *
 * So what this buys, precisely, and what it does not:
 *
 * - A ciphertext from a connection's `password` **cannot** be opened as its
 *   `url`, or as a connector's anything. The confusions it stops are the ones
 *   where an attacker with write access to `config` shuffles values between
 *   fields to make a system reveal a credential in a place that renders it.
 * - A ciphertext **can** still be moved between two rows of the same `kind` with
 *   the same `field` — connection A's `url` pasted over connection B's. Stopping
 *   that needs an identifier stable from the first seal, which this contract
 *   cannot supply. A host that wants it should give `SecretContext` an id that
 *   is allocated *before* the first save rather than by it; then `id` joins this
 *   map and the note above stops being true.
 *
 * `vault` is deliberately not bound. It is already carried in the clear on the
 * sealed record and checked before any KMS call, and putting a value in the
 * context that a host may rename — two vaults over two regions get two names —
 * is the "binds a field that legitimately changes" mistake in another costume.
 */
export function encryptionContextFor(context: SecretContext): Record<string, string> {
  return {
    [CONTEXT_KEY_KIND]: requireContextValue(context.kind, 'kind'),
    [CONTEXT_KEY_FIELD]: requireContextValue(context.field, 'field'),
  };
}

/**
 * Refuse a context that would bind nothing.
 *
 * `kind: ''` is accepted by KMS perfectly happily and produces a context that
 * distinguishes a connection from a connector not at all. The whole defence is
 * one map comparison, so a caller that forgot to fill it in has silently opted
 * out of it — and would find out never. Failing at `seal` is the only moment
 * anybody is looking.
 */
function requireContextValue(value: string, field: 'kind' | 'field'): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CatalogKmsVaultError(
      `A secret cannot be sealed with an empty \`${field}\`. It is one of the two values bound into the KMS encryption context, and a blank one binds the ciphertext to nothing — a secret sealed this way could be opened as any other secret whose ${field} is also blank.`,
    );
  }
  return value;
}

/**
 * The same context, as bytes, for AES-GCM's additional authenticated data.
 *
 * Belt *and* braces, and the braces are the cheap half: KMS already refuses to
 * unwrap the data key under a different context, so this second binding only
 * matters once the data key is out — a cached key reused across a process, or
 * one lifted from a heap dump. In both of those the KMS check has already
 * happened and cannot happen again, and this is what still says no.
 *
 * Serialised as JSON over **sorted entry pairs** rather than by concatenating
 * `k=v`. Concatenation is ambiguous the moment a value may contain the
 * separator: `{a: 'b:c'}` and `{'a:b': 'c'}` flatten to the same bytes, and
 * `field` is a host-supplied config key. An array of pairs has no such collision
 * — JSON escapes the quotes — and sorting makes it independent of the order the
 * object was built in, which is not something to rely on across a refactor.
 */
export function additionalAuthenticatedData(encryptionContext: Record<string, string>): Buffer {
  const pairs = Object.entries(encryptionContext).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return Buffer.from(JSON.stringify(pairs), 'utf8');
}
