# @dudousxd/nestjs-catalog-secrets-aws

The credential in `catalog_connection.config` rests encrypted under a key AWS KMS
holds, and this process never holds. A database dump stops being a list of
passwords.

```bash
pnpm add @dudousxd/nestjs-catalog-secrets-aws @aws-sdk/client-kms
```

`@aws-sdk/client-kms` is a **peer** dependency, so a host that does not run on
AWS does not acquire an AWS SDK by depending on a catalog — and a host that does
run on AWS already pins a version, which this package shares rather than sits
beside. Two credential provider chains and two HTTP agents in one process is not
a thing to arrive at by accident.

## The problem it closes

`@dudousxd/nestjs-catalog` already stops a credential travelling in a response:
`config` is redacted on the way out under `catalog:read`, and a password-bearing
URL is refused on the way in unless `allowInlineCredentials` is on. None of that
does anything for a `SELECT`. A read replica, a nightly backup, an RDS snapshot
shared with a support engineer, a `mysqldump` in somebody's downloads folder —
for every one of those, `config` is the plaintext it always was.

`encryptCredentials` is what turns that column into ciphertext. It needs a vault
to do it with, and this is one.

## Wire it up

```ts
import { KMSClient } from "@aws-sdk/client-kms";
import { CatalogAwsSecretsModule } from "@dudousxd/nestjs-catalog-secrets-aws";

CatalogAwsSecretsModule.forRoot({
  client: new KMSClient({ region: "us-gov-west-1" }),
  key: "alias/catalog-secrets",
});
```

It binds `CATALOG_SECRET_VAULT`. Turn on `encryptCredentials` in the store, and
every `url` and `password` written from that point is sealed.

**The client is yours, and this package will never build one.** There is no
`region` option and there will not be one: endpoint resolution, the credential
chain, the FIPS endpoint, the retry policy and the partition are decisions a
deployment already made once for every other AWS client in the process. A second
place to make them is a second place to get them wrong.

For a key that comes out of config rather than out of the air:

```ts
CatalogAwsSecretsModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService, KMSClient],
  useFactory: (config: ConfigService, client: KMSClient) => ({
    client,
    key: config.getOrThrow("CATALOG_KMS_KEY_ALIAS"),
  }),
});
```

## What a host binds

| | |
|---|---|
| `client` | Any object with a `send` — a `KMSClient`. Required. |
| `key` | What to seal **new** secrets under: an alias, a key id or an ARN. Required. |
| `name` | The vault's name, written into every row. Defaults to `aws-kms`. |
| `dataKeyCacheTtlMs` | How long an unwrapped data key may live in memory. Defaults to five minutes. `0` disables the cache. |
| `dataKeyCacheMaxEntries` | Defaults to 256. |

## Envelope encryption, not `kms:Encrypt`

A connection URL is a few hundred bytes and fits inside KMS's 4 KB direct
encryption limit, so `kms:Encrypt` on the payload would work today. It is still
the wrong shape, and every reason arrives later rather than now:

- **Every open becomes a KMS call on the payload**, with nothing cacheable —
  caching a direct ciphertext's plaintext means caching the credential.
- **Throughput becomes a service quota.** `kms:Decrypt` is limited per region and
  shared with everything else in the account.
- **4 KB is a limit somebody will hit.** A client certificate, a service account
  JSON, a keytab. All plausible in `connection.config`, all larger, all turning a
  working feature into a size error on the day it matters.

So: one `GenerateDataKey` per seal, AES-256-GCM locally under that data key, and
the wrapped key travels beside the ciphertext.

`SealedSecret` has three fields and says `ciphertext` is opaque to the library,
so the wrapped key, the nonce and the tag have nowhere else to go. They are
framed into it:

```
  0   4        6                    6+W        18+W       34+W
  +---+--------+--------------------+----------+----------+---------- ... ----+
  |CKV1| u16 W  | wrapped data key   |  nonce   | GCM tag  |   ciphertext      |
  +---+--------+--------------------+----------+----------+---------- ... ----+
```

The version tag earns its four bytes twice: a future format is refused by name
instead of being sliced into nonsense, and a column that holds something else
entirely says so rather than reporting a tag mismatch that reads as tampering.

**One data key per secret.** Not reused, not cached on the seal path. The AWS
Encryption SDK's caching materials manager is the right trade for a workload
encrypting millions of records a minute; a seal here happens when somebody
presses save on a form. What reuse would cost is several secrets recoverable from
one compromised data key, which is the currency this package exists to protect.

**AES-256-GCM, and the authentication is the point.** A `json` column that a
`SELECT`-holder can also `UPDATE` is exactly where an unauthenticated mode is a
bug: an altered ciphertext must fail loudly rather than decrypt to plausible
rubbish that gets handed to a database driver as a connection URL.

## What a ciphertext is bound to

KMS takes an *encryption context* on `GenerateDataKey` and requires the same map,
byte for byte, on `Decrypt`. This vault binds:

```
catalog:kind   →  "connection" | "connector"
catalog:field  →  "url" | "password" | …
```

and binds the same map a second time as the GCM additional authenticated data,
so it still holds once a data key is out of KMS's hands — cached in this process,
or lifted from a heap dump.

**`id` is deliberately not bound**, and it is the field everyone reaches for
first. `SecretContext.id` is *absent on a first save* — the row has no identity
until it has been written — and present on every read after. Bind it and the
context at `seal` can never equal the context at `open`, so every secret would be
sealed unopenable, from the first one, forever, surfacing as an opaque
`InvalidCiphertextException`. Binding it "only when present" is the same bug
wearing a hat.

Recording in the envelope *whether* the id was bound, so `open` can reconstruct
the exact context, does work — and was rejected. It buys row binding for every
save after the first, and costs any operation that moves a secret to a new row: a
"duplicate this connection" button, a restore that reassigns ids, a renumbering
migration. Each becomes rows that decrypt to nothing, and the blast radius is
credentials nobody can recover. A vault's first duty is that the secret is still
there in three years.

So, precisely:

- A ciphertext from a connection's `password` **cannot** be opened as its `url`,
  or as a connector's anything.
- A ciphertext **can** still be moved between two rows of the same kind and
  field — connection A's `url` pasted over connection B's.

Closing that needs an identifier that is stable from the first seal, which the
contract cannot supply. A host that wants it should allocate the connection's id
*before* the first save rather than by it; then `id` joins the context and the
second bullet stops being true. See `encryption-context.ts`.

## What `keyId` records: the ARN, not the alias

`key` may be an alias, a key id or an ARN. What lands on the row is always the
**full ARN KMS resolved**, and the difference matters more than it looks.

- **An alias is a mutable pointer.** Anybody with `kms:UpdateAlias` can move it
  on any Tuesday. A row recording an alias records where to look *today*, which
  for a row written in 2026 and read in 2031 is not a fact about that row.
- **Automatic rotation costs nothing.** KMS rotates the backing material under a
  stable ARN and keeps the old material. The ARN survives every rotation an alias
  would have.
- **Manual re-keying is where an alias actively lies.** New CMK, alias repointed,
  and the alias now names a key that cannot decrypt a single existing row. Rows
  carrying ARNs keep naming the old key, so they keep opening — for as long as
  you leave it enabled, which is now a decision you get to make with a list in
  front of you.
- **The blast radius of a compromised key becomes a `GROUP BY key_id`** instead
  of an archaeology exercise.

Configure the pointer; store the fact. Re-keying does not happen by itself:
repointing the alias changes what new seals use, old rows migrate when next
saved, and until then they are readable — the better of the two available failure
modes.

## Caching, and what it costs

Envelope encryption puts a fresh data key on every secret, so `open` is a
`kms:Decrypt` round trip every time. A connector running every five minutes opens
the same URL every five minutes; a page listing twenty connections is twenty
calls.

So the **unwrapped data key** is held, keyed by the wrapped blob *and* the
encryption context — the context is in the key so that a hit can never stand in
for the check. The secret itself is never cached. Nothing on the seal path is
cached.

Two things to be clear-eyed about:

- **A decrypted data key in memory is what an attacker with a foothold wants.**
  The TTL is how long one stays worth stealing after its last use. Entries are
  zeroed on eviction, on expiry and on `clear()` — Node cannot promise it is the
  last copy, but it removes the one still sitting in a live buffer, and the KMS
  response is *viewed* rather than copied so that zeroing reaches it too.
- **The TTL is how long a revocation takes to bite.** Disable the CMK or strip
  `kms:Decrypt` from the role and any already-cached secret keeps opening until
  its entry expires. The default is five minutes for that reason, not for the
  memory. A hit does not extend it, so the bound holds for the busiest secret as
  much as the quietest.

```ts
// Not waiting out the TTL.
vault.forgetCachedDataKeys();
```

**Set `dataKeyCacheTtlMs: 0` if your control is "every access to a credential is
logged".** A cache hit is an access with no CloudTrail event, so no TTL above
zero satisfies that; the price is one `kms:Decrypt` per open. That is a correct
configuration, not a degraded one.

No route ships for the flush. Who may clear a key cache, under which prefix and
behind which guard, is a decision only the host can make — the same position
`@dudousxd/nestjs-catalog-store-fanout` takes about shipping no controller for a
replay.

## IAM

The catalog process needs two actions, and nothing else:

```json
{
  "Effect": "Allow",
  "Action": ["kms:GenerateDataKey", "kms:Decrypt"],
  "Resource": [
    "arn:aws-us-gov:kms:us-gov-west-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab"
  ]
}
```

**Name the keys. Do not write `"Resource": "*"`.** `open` asks KMS to decrypt
under the key *the row names*, which is what lets a deployment that has re-keyed
still read everything written before the re-key. With `Resource: *`, a row whose
`keyId` has been rewritten is a key this process will use — including one in
another account that trusts your role. Scoped to the ARNs this catalog actually
seals under, the worst a rewritten `keyId` achieves is an `AccessDeniedException`.

`kms:Encrypt` is not needed: this vault never encrypts a payload directly.
Neither is `kms:CreateKey`, `kms:ScheduleKeyDeletion` or anything else — the key
is provisioned outside this process, by whatever provisions the rest of your
infrastructure.

On the **key policy**, tighten the same two actions with a condition on the
context, so a role holding `kms:Decrypt` on this key still cannot use it to
unwrap anything that is not a catalog secret:

```json
{
  "Effect": "Allow",
  "Principal": { "AWS": "arn:aws-us-gov:iam::111122223333:role/catalog-api" },
  "Action": ["kms:GenerateDataKey", "kms:Decrypt"],
  "Resource": "*",
  "Condition": {
    "StringEquals": { "kms:EncryptionContext:catalog:kind": ["connection", "connector"] },
    "StringLike": { "kms:EncryptionContextKeys": "catalog:field" }
  }
}
```

Those two context keys are **part of the wire format**. Changing `catalog:kind`
or `catalog:field` makes every existing row undecryptable, because KMS compares
the context exactly — which is the entire point of it. Treat them as you would a
column name in a shipped migration.

Grant `kms:Decrypt` to your break-glass role too. A key nobody but a running pod
can use is a key that takes an incident to discover you cannot audit.

## GovCloud

This runs in `us-gov-west-1`, and the design of the wiring is what makes that a
non-event rather than a checklist:

- **KMS is a core GovCloud service**, and `GenerateDataKey` and `Decrypt` are
  core KMS actions available in every partition. Nothing here uses a KMS feature
  that is commercial-only: no `GenerateDataKeyPair`, no external key stores, no
  custom key stores, no multi-Region keys, no `DeriveSharedSecret`.
- **Nothing in this package parses an ARN**, and GovCloud ARNs are in the
  `aws-us-gov` partition rather than `aws`. `keyId` is stored and echoed back
  verbatim; a test pins that with a real `arn:aws-us-gov:` ARN precisely so a
  future "helpful" parse cannot be added quietly.
- **Nothing here resolves an endpoint or assumes a region.** The client is the
  host's, so the GovCloud endpoint — including the FIPS one, which is what the
  default GovCloud endpoints already are — is selected once, where the rest of
  your AWS clients are configured.
- **The local crypto is FIPS-approved.** AES-256-GCM and `crypto.randomBytes`,
  both available under a FIPS-mode OpenSSL provider. A random 96-bit nonce is
  what NIST SP 800-38D permits; the bound that makes random nonces uncomfortable
  is around 2^32 messages under one key, and this vault encrypts exactly one
  message per data key.
- **`@aws-sdk/client-kms` v3** is the SDK AWS ships for GovCloud; there is no
  separate distribution.

## Failures

Everything raised is a `CatalogKmsVaultError`, and each carries `retryable`.
That field is not decoration: a connector run is a durable step, the dispatch
boundary serialises a throw into `{ message, code, retryable }`, and the engine
reads `retryable` and nothing else. A vault is the only layer that knows the
answer — a store cannot tell an `AccessDeniedException` from a throttle, so a
store guessing `true` spends three retries and fifteen minutes of backoff on a
key policy that will refuse identically at the end of it.

Permanent: `AccessDeniedException`, `NotFoundException`, `DisabledException`,
`KMSInvalidStateException`, `InvalidCiphertextException`, `IncorrectKeyException`,
`InvalidKeyUsageException` — plus every structural refusal this package makes
itself (a frame that is not a frame, a blank `field`, a response with no
`Plaintext`). Everything else, including anything KMS grows that this package has
not heard of, is treated as worth another go: a name we do not recognise is far
more likely to be transient than final, and being wrong costs a delay rather than
a load that never runs.

No message ever contains the plaintext or the data key. An exception message is
the single most likely thing in a process to reach a log aggregator nobody scoped
an IAM policy around.

## Rotating to a new key

`CATALOG_SECRET_VAULT` accepts an array: seals go to the first, opens go to
whichever `name` matches the row. So two instances of this class, two keys, two
names:

```ts
{
  provide: CATALOG_SECRET_VAULT,
  useFactory: (client: KMSClient) => [
    new KmsCatalogSecretVault({ client, key: "alias/catalog-next", name: "aws-kms-next" }),
    new KmsCatalogSecretVault({ client, key: "alias/catalog",      name: "aws-kms" }),
  ],
  inject: [KMSClient],
}
```

Saves reseal under `aws-kms-next`; drop the second entry when nothing is sealed
under `aws-kms` any more. Bind the array yourself rather than importing
`CatalogAwsSecretsModule` twice — two imports leave the token bound to whichever
was registered last, with no error, and the first vault's rows quietly
unopenable.

`name` is written into rows, so renaming a vault strands everything already
sealed under the old name. Treat the default as a wire constant.

## License

MIT
