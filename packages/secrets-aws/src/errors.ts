/**
 * Every refusal this package makes, under one name.
 *
 * One class rather than a hierarchy, because a host has exactly one useful
 * reaction to all of them: the secret could not be produced, so the thing that
 * wanted it does not run. Distinguishing "the envelope was truncated" from "the
 * key is disabled" in the *type* would invite a `catch` that carries on for some
 * of them, and there is no member of this set it is safe to carry on from.
 *
 * What varies is the message, and the messages are written to be read at three
 * in the morning by somebody who did not write this: they name the call, what
 * was wrong with it, and what to go and look at. They never contain the
 * plaintext, the data key, or any part of either — an exception message is the
 * single most likely thing in a process to end up in a log aggregator that
 * nobody scoped an IAM policy around.
 */
export class CatalogKmsVaultError extends Error {
  /**
   * Whether waiting could help.
   *
   * `@dudousxd/nestjs-catalog` runs a connector as a durable step, and
   * `SecretOpenFailedError` documents at length what that means: the dispatch
   * boundary serialises a throw into `{message, code, retryable}` and the engine
   * reads `retryable` and nothing else. A vault is the layer that *knows* the
   * answer and the only one that does — the store cannot tell an
   * `AccessDeniedException` from a throttle, so a store guessing `true` spends
   * three retries and fifteen minutes of exponential backoff on a key policy
   * that will refuse identically at the end of it, and a store guessing `false`
   * turns a two-second KMS blip into a failed load.
   *
   * `CatalogSecretVault` gives a vault nowhere to say this, so it is said here,
   * on the error, where a store that wants it can read it — see
   * {@link isPermanentKmsFailure} for what is classified which way. A store that
   * does not read it is no worse off than it is today.
   */
  readonly retryable: boolean;

  /**
   * The underlying failure, when there was one.
   *
   * Held so an operator gets the name of the AWS exception —
   * `AccessDeniedException`, `KMSInvalidStateException`, `IncorrectKeyException`
   * each say something different and useful — without this package having to
   * enumerate them in prose and fall behind KMS.
   */
  readonly cause?: unknown;

  constructor(message: string, options?: { cause?: unknown; retryable?: boolean }) {
    super(message);
    this.name = 'CatalogKmsVaultError';
    this.cause = options?.cause;
    // Defaults to false, because every failure raised by this package *without*
    // an AWS error under it is a structural one: a frame that is not a frame, a
    // context with an empty field, a response missing `Plaintext`. None of those
    // become true by being attempted again, and the default should be the answer
    // for the ones nobody remembered to classify.
    this.retryable = options?.retryable ?? false;
  }
}

/**
 * Which AWS-side refusals are final.
 *
 * Classified by exception *name* rather than by HTTP status or by the SDK's
 * `$retryable` metadata, and the distinction matters: the SDK's own retry policy
 * has already run by the time we see the error, so what reaches here is either
 * something it decided not to retry or something it retried and gave up on. What
 * remains to decide is whether the *step* should be scheduled again minutes
 * later, which is a different question with a different answer — a throttle
 * exhausted in two seconds of SDK retries is very often fine a minute later.
 *
 * The list is the permanent ones, and everything not on it is treated as worth
 * another go. That direction is deliberate: a name this package has not heard of
 * — a new KMS exception, a transport error, a DNS failure — is far more likely
 * to be transient than final, and the cost of being wrong is a delay rather than
 * a load that never runs.
 *
 * `KeyUnavailableException` is pointedly **not** here despite sounding final;
 * KMS documents it as retryable.
 */
const PERMANENT_KMS_EXCEPTIONS: readonly string[] = [
  // The key policy or the IAM policy says no. It will say no again.
  'AccessDeniedException',
  // No such key, alias or ARN.
  'NotFoundException',
  // The key is disabled, pending deletion, or pending import.
  'DisabledException',
  'KMSInvalidStateException',
  // The blob is not a KMS ciphertext, or the encryption context does not match.
  // This is the one the encryption-context binding produces on a moved
  // ciphertext, and retrying a moved ciphertext is pure delay.
  'InvalidCiphertextException',
  // The row names a key that did not seal it.
  'IncorrectKeyException',
  // The key exists but cannot be used this way — a signing key asked to wrap.
  'InvalidKeyUsageException',
  'InvalidGrantTokenException',
  'DryRunOperationException',
];

export function isPermanentKmsFailure(error: unknown): boolean {
  return error instanceof Error && PERMANENT_KMS_EXCEPTIONS.includes(error.name);
}

/**
 * The tail of an error message, appended to anything that might be an AWS-side
 * refusal rather than a bug here.
 *
 * Present because the two failures look identical from inside this process — a
 * `Decrypt` that refuses is the same call whether the key was disabled, the role
 * lost `kms:Decrypt`, or the row names a key in another account — and the one
 * who can tell them apart is reading CloudTrail, not this stack trace.
 */
export const CHECK_CLOUDTRAIL =
  'The call is in CloudTrail under the identity this process runs as; that entry says which of key state, key policy or IAM refused.';
