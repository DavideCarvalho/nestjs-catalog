import { DecryptCommand, GenerateDataKeyCommand } from '@aws-sdk/client-kms';
import { CHECK_CLOUDTRAIL, CatalogKmsVaultError, isPermanentKmsFailure } from './errors';

/**
 * The two KMS calls this package makes, and nothing else.
 *
 * A real `KMSClient` satisfies this structurally, so a host passes the client it
 * already built — with its region, its endpoint, its credential chain and its
 * retry policy — and this package never constructs one. That is the whole of the
 * partition story: nothing here resolves an endpoint, parses an ARN or assumes a
 * region, so `us-gov-west-1` and `aws-us-gov` ARNs are not a case this package
 * handles, they are a case it cannot see.
 *
 * Declaring the port instead of taking `KMSClient` also means the type is the
 * only thing imported from the SDK on the host's behalf — and the reason the
 * command classes below are the sole runtime import from a *peer* dependency:
 * two constructors, no client, no credential provider.
 *
 * The return type is `unknown` on purpose. Every field of both responses is
 * optional in the SDK's own types — `Plaintext?`, `CiphertextBlob?`, `KeyId?` —
 * so the response has to be checked at run time regardless of how it is typed,
 * and a declared type here would only be a claim this package cannot enforce
 * about bytes that arrived over a network. The checks are in
 * {@link readBytes} and {@link readText} and they are the same checks either way.
 */
export interface CatalogKmsClient {
  send(command: GenerateDataKeyCommand | DecryptCommand): Promise<unknown>;
}

export interface GeneratedDataKey {
  /**
   * What KMS says it used — an ARN, always, whatever was asked for. See
   * {@link generateDataKey}.
   */
  keyId: string;
  /** The data key in the clear. Owned by the caller, and short-lived. */
  plaintext: Buffer;
  /** The same key wrapped under the CMK. Safe to store; useless on its own. */
  wrapped: Buffer;
}

/**
 * Ask KMS for a fresh 256-bit data key, wrapped under `keyRef`.
 *
 * `KeySpec: 'AES_256'` rather than `NumberOfBytes: 32`. They produce the same
 * thing, and the named spec is the one KMS validates against its own notion of a
 * symmetric data key, so a key whose usage does not permit `GENERATE_DATA_KEY`
 * is refused with a message about key usage rather than about a byte count.
 *
 * ## What is recorded as `keyId`: the ARN KMS resolved, not what was configured
 *
 * `keyRef` may be an alias (`alias/catalog-secrets`), a bare key id, or an ARN.
 * The response's `KeyId` is always the full ARN of the key that actually did the
 * work, and that is what goes on the sealed record. The choice matters more than
 * it looks:
 *
 * - **An alias is a mutable pointer.** `alias/catalog-secrets` can be moved to a
 *   different CMK on any Tuesday, by anybody with `kms:UpdateAlias`. A row that
 *   recorded the alias records where to look *today*, which for a row written in
 *   2026 and read in 2031 is not a fact about that row at all. The question a
 *   sealed record has to answer is "which key material must still exist for this
 *   to be readable", and only the ARN answers it.
 * - **Automatic rotation does not cost anything.** KMS's built-in rotation keeps
 *   the key's ARN and rotates the backing material underneath it, retaining the
 *   old material for exactly this reason. The ARN is stable across every
 *   rotation an alias would have "survived".
 * - **Manual re-keying is where an alias actively lies.** Create a new CMK,
 *   repoint the alias, and the alias now names a key that cannot decrypt a
 *   single existing row. Rows carrying ARNs keep naming the old key, so they
 *   keep opening — for as long as you leave it enabled, which is a decision you
 *   now get to make with a list of which rows depend on it.
 * - **It makes the blast radius of a compromised key answerable** with a `SELECT
 *   ... GROUP BY key_id` instead of an archaeology exercise.
 *
 * The cost is that re-keying does not happen by itself: repointing the alias
 * changes what new seals use and nothing else. Old rows migrate when they are
 * next saved, and until then they are readable — which is the failure mode you
 * want out of the two available.
 */
export async function generateDataKey(
  client: CatalogKmsClient,
  keyRef: string,
  encryptionContext: Record<string, string>,
): Promise<GeneratedDataKey> {
  const response = await callKms(
    client,
    new GenerateDataKeyCommand({
      KeyId: keyRef,
      KeySpec: 'AES_256',
      EncryptionContext: encryptionContext,
    }),
    'GenerateDataKey',
  );

  return {
    keyId: readText(response, 'KeyId', 'GenerateDataKey'),
    plaintext: readBytes(response, 'Plaintext', 'GenerateDataKey'),
    wrapped: readBytes(response, 'CiphertextBlob', 'GenerateDataKey'),
  };
}

/**
 * Unwrap a data key, under the same encryption context that wrapped it.
 *
 * `KeyId` is passed even though KMS can find a symmetric key from the blob
 * alone, and it is passed as **the key the row names** rather than the key this
 * vault is configured with. Both halves of that are deliberate.
 *
 * Supplying it at all turns "decrypt this under whatever key it was made with"
 * into "decrypt this under *this* key, and fail if it was made with another",
 * which is the difference between a call that can be steered by whoever wrote
 * the row and one that cannot.
 *
 * Using the row's key rather than the configured one is what lets a deployment
 * that has re-keyed still read everything written before the re-key — the
 * requirement this whole package exists under. The bound on it is not this code:
 * it is the IAM policy. `kms:Decrypt` scoped to `Resource: *` means a row naming
 * an attacker-chosen key in an account that trusts you is a key this process
 * will happily use; scoped to the ARNs this catalog actually seals under, the
 * worst a rewritten `keyId` achieves is an `AccessDeniedException`. The README
 * says this again where the policy is written, because it is the one place a
 * host can get this wrong from outside the code.
 */
export async function decryptDataKey(
  client: CatalogKmsClient,
  wrapped: Buffer,
  keyId: string,
  encryptionContext: Record<string, string>,
): Promise<Buffer> {
  const response = await callKms(
    client,
    new DecryptCommand({
      CiphertextBlob: wrapped,
      KeyId: keyId,
      EncryptionContext: encryptionContext,
    }),
    'Decrypt',
  );

  return readBytes(response, 'Plaintext', 'Decrypt');
}

/**
 * One place for the SDK's exceptions to be re-thrown with the call named.
 *
 * The AWS exceptions are good — `AccessDeniedException`,
 * `KMSInvalidStateException`, `IncorrectKeyException`, `InvalidCiphertextException`
 * each say something different and useful — so the original is kept as `cause`
 * rather than flattened into a string. What they do not say is *which* of this
 * package's two calls raised them, and the two failing means different things:
 * `GenerateDataKey` failing is a save that did not happen and no data lost,
 * `Decrypt` failing is a credential that is now unreachable.
 */
async function callKms(
  client: CatalogKmsClient,
  command: GenerateDataKeyCommand | DecryptCommand,
  call: 'GenerateDataKey' | 'Decrypt',
): Promise<unknown> {
  try {
    return await client.send(command);
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw new CatalogKmsVaultError(`KMS ${call} failed — ${detail}. ${CHECK_CLOUDTRAIL}`, {
      cause: error,
      retryable: !isPermanentKmsFailure(error),
    });
  }
}

/**
 * Read a byte field off a KMS response without copying it.
 *
 * `Buffer.from(view.buffer, view.byteOffset, view.byteLength)` is a *view* over
 * the SDK's own array, not a copy, and that is the point for `Plaintext`
 * specifically: zeroing the buffer later then zeroes the SDK's array too,
 * because they are the same bytes. A `Buffer.from(view)` copy would leave the
 * original key material sitting in a live object with no reference to it from
 * here — the exact thing {@link zeroKey} exists to prevent.
 */
function readBytes(response: unknown, field: string, call: string): Buffer {
  const value = readField(response, field, call);
  if (!(value instanceof Uint8Array)) {
    throw new CatalogKmsVaultError(
      `KMS ${call} returned no usable \`${field}\`. A response missing it is not something this package can recover from, and it is not a failure the SDK reports as an exception.`,
    );
  }
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function readText(response: unknown, field: string, call: string): string {
  const value = readField(response, field, call);
  if (typeof value !== 'string' || value.length === 0) {
    throw new CatalogKmsVaultError(
      `KMS ${call} returned no \`${field}\`. Without it the sealed record cannot say which key sealed it, and a record that cannot name its key is one nobody can prove is still readable.`,
    );
  }
  return value;
}

function readField(response: unknown, field: string, call: string): unknown {
  if (typeof response !== 'object' || response === null) {
    throw new CatalogKmsVaultError(
      `KMS ${call} returned ${response === null ? 'null' : typeof response} rather than a response object. The client passed to this vault is not an AWS KMS client.`,
    );
  }
  return Reflect.get(response, field);
}
