---
"@dudousxd/nestjs-catalog-secrets-aws": minor
---

A KMS vault, so the credential in `config` rests encrypted

`@dudousxd/nestjs-catalog` grew `CatalogSecretVault` as a seam with no
implementation, on the argument that a library shipping AES with a key from an
environment variable would have moved the problem from one column to one variable.
This is the first provider for it: `@dudousxd/nestjs-catalog-secrets-aws`, backed
by AWS KMS.

`@aws-sdk/client-kms` is a **peer** dependency, matching how the ClickHouse store
declares `@clickhouse/client`. A host with no AWS in it does not acquire an AWS
SDK by depending on a catalog.

## Envelope encryption, not `kms:Encrypt`

A connection URL fits inside KMS's 4 KB direct-encryption limit, so encrypting the
payload directly would work today and would be the wrong shape. It puts a KMS call
on the payload for every open with nothing cacheable — caching a direct
ciphertext's plaintext means caching the credential — it ties the throughput of
reading configuration to a per-region service quota shared with the rest of the
account, and 4 KB is a limit that a client certificate or a service-account JSON
in `connection.config` walks straight into.

So: one `GenerateDataKey` per seal, AES-256-GCM locally under that data key, and
the wrapped key framed into `SealedSecret.ciphertext` alongside the nonce and the
tag — which is where they have to go, because the contract has three fields and
declares the ciphertext opaque. The frame carries a four-byte version tag so a
value that is *not* one of these is refused by name rather than sliced into
nonsense and reported as tampering.

One data key per secret, never reused and never cached on the seal path. A seal
happens when somebody presses save on a form, so there is no rate to relieve, and
reuse would make several secrets recoverable from one compromised key.

## The encryption context binds `kind` and `field`, and not `id`

`id` is the field everyone reaches for first and it is the one that cannot go in.
`SecretContext.id` is absent on a first save and present on every read after, so
binding it means the context at `seal` can never equal the context at `open` —
**every secret sealed unopenable, from the first one**, surfacing as an opaque
`InvalidCiphertextException` at the first connector run rather than at the save.
Binding it only-when-present is the same bug with the failure moved to whichever
call site happened not to have one.

Recording in the envelope *whether* the id was bound does work, and was rejected:
it buys row binding for every save after the first and costs any operation that
moves a secret to a new row — a duplicate button, a restore that reassigns ids, a
renumbering migration — each becoming rows that decrypt to nothing.

What that leaves is stated rather than glossed. A ciphertext cannot be opened as
another field or another kind; it can still be moved between two rows of the same
kind and field. Closing that needs an identifier stable from the first seal, which
this contract cannot supply — a host that wants it should allocate the id before
the first save rather than by it.

The same map is bound a second time as GCM additional authenticated data, so the
binding survives a data key that is already out of KMS's hands. A spec proves that
half in isolation, against a fake KMS that does *not* enforce the context, because
with KMS enforcing it the payload check is never reached.

## `keyId` records the ARN KMS resolved, not the alias configured

An alias is a mutable pointer: anybody with `kms:UpdateAlias` can move it, so a row
recording one records where to look today. Automatic rotation keeps the ARN stable
and retains the old material, so nothing is lost by recording it — and manual
re-keying is exactly where an alias lies, naming a key that cannot decrypt a single
existing row. Rows carrying ARNs keep opening, and "which key material must stay
alive" becomes a `GROUP BY`.

`open` therefore asks KMS to decrypt under the key **the row names**. The bound on
that is the IAM policy, and the README says so where the policy is written: scope
`kms:Decrypt` to the key ARNs this catalog seals under, never `Resource: *`, or a
rewritten `keyId` is a key this process will use.

## The data key cache, and what it costs

Unwrapped data keys are held for five minutes by default, keyed by the wrapped blob
*and* the encryption context so a hit can never stand in for the check. The secret
itself is never cached.

The TTL is chosen against revocation rather than against memory: it is how long a
disabled key or a stripped `kms:Decrypt` keeps working for secrets already opened.
A hit does not extend it — a cache that re-armed on use would keep exactly the
busiest key, the one a revocation is most likely to be about, alive indefinitely.
Entries are zeroed on expiry, eviction and `clear()`, and the KMS response is
viewed rather than copied so that zeroing reaches the SDK's own buffer.

`dataKeyCacheTtlMs: 0` disables it, and that is the correct setting — not a
degraded one — for a deployment whose control is "every access to a credential is
logged": a cache hit is an access with no CloudTrail event.

## Failures say whether waiting helps

Everything raised is a `CatalogKmsVaultError` carrying `retryable`, classified by
AWS exception name. A connector run is a durable step and the engine reads that
field and nothing else, and the vault is the only layer that can tell an
`AccessDeniedException` from a throttle — a store guessing `true` spends fifteen
minutes of backoff on a key policy that refuses identically at the end of it.
Unrecognised names are treated as transient, because being wrong that way costs a
delay rather than a load that never runs.

## GovCloud

Nothing here parses an ARN, resolves an endpoint or assumes a region — the host
passes a `KMSClient` it built, so partition, FIPS endpoint and credential chain are
decided once, where the rest of its AWS clients are. `GenerateDataKey` and `Decrypt`
are core actions in every partition; no commercial-only KMS feature is used. A spec
pins an `arn:aws-us-gov:` key id being stored verbatim, so a future helpful parse
cannot be added quietly.
