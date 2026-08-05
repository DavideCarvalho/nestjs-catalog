# `@dudousxd/nestjs-catalog-secrets-vault`

> Part of the [Aviary](https://davidecarvalho.github.io/aviary) · a HashiCorp Vault **Transit**
> provider for [`@dudousxd/nestjs-catalog`](https://davidecarvalho.github.io/aviary/docs/catalog).

Binds `CATALOG_SECRET_VAULT` to Vault's Transit engine, so the credentials in
`catalog_connection.config` rest as ciphertext and the key that would open them never reaches this
process. A database dump, a read replica, a nightly backup or anybody holding `SELECT` on the RDS
instance gets `vault:v1:…` instead of a password.

Encryption as a service: the plaintext goes to Vault, the ciphertext comes back, the key stays put.
That is what makes it worth adding a network hop to a save — the catalog gains encryption without
gaining a master key, its rotation, or its blast radius.

## Install

```bash
pnpm add @dudousxd/nestjs-catalog-secrets-vault
```

Peers: `@dudousxd/nestjs-catalog` (>= 0.1), `@nestjs/common`. **No runtime dependencies**, which for
this package is a decision rather than an accident: every credential in the catalog passes through
this code, so its transitive dependency set is its supply-chain blast radius. The whole Vault
surface used here is three JSON `POST`s over the global `fetch` — see [`src/http.ts`](./src/http.ts)
for why `node-vault` was not worth a package.

`@dudousxd/nestjs-catalog` **must** be a peer, never a nested copy. `CATALOG_SECRET_VAULT` is a
plain `Symbol()`, equal only to itself within one loaded copy of the package. Two copies means this
module binds one symbol while the catalog injects another, and nothing anywhere reports it.

## What a host binds

```ts
import { CatalogVaultSecretsModule, kubernetesAuth } from '@dudousxd/nestjs-catalog-secrets-vault';

@Module({
  imports: [
    CatalogVaultSecretsModule.forRoot({
      address: process.env.VAULT_ADDR ?? '',
      auth: kubernetesAuth({ role: 'catalog' }),
    }),
  ],
})
export class SecretsModule {}
```

That binds `CATALOG_SECRET_VAULT`. Encryption is still off until the store is told to use it:

```ts
CatalogMikroOrmStoreModule.forRoot({ contextName: 'catalog', encryptCredentials: true })
```

Nothing connects at boot. The first Vault call happens on the first `seal` or `open`, so a Vault
that is down does not stop the application starting — the ninety-nine percent of the catalog that
needs no secrets keeps working. What *is* checked at boot is the configuration: a missing `address`
or a runtime without `fetch` refuses while somebody is still looking at the wiring, rather than
presenting later as a fetch against `undefined/v1/…`.

### Options

| Option | Default | What it decides |
|---|---|---|
| `address` | *required* | `VAULT_ADDR`. |
| `auth` | *required* | See [Authentication](#authentication). |
| `mount` | `transit` | Where the Transit engine is mounted. Nested mounts (`platform/transit`) are fine. |
| `key` | `catalog-secrets` | The key **new** secrets are sealed under. Existing rows name their own. |
| `name` | `vault-transit` | Goes into `SealedSecret.vault`. Read [below](#the-name-is-data) before changing it. |
| `namespace` | — | Vault Enterprise. Not recorded in the row; see [what a row tells you](#what-a-stored-row-tells-you). |
| `keyFor` | — | Picks the key for a new seal from the `SecretContext`. |
| `bindContext` | `false` | Send the context to a `derived=true` key. See [the encryption context](#the-encryption-context). |
| `fetch` | global `fetch` | For mTLS, a private CA, a proxy, or a host's own instrumented client. |
| `timeoutMs` | `5000` | Long enough to ride out a leader election, short enough that a save does not appear to hang. |
| `openAttempts` / `sealAttempts` | `3` / `1` | See [retrying](#when-vault-is-unreachable). |

## Setting Vault up

### The Transit key

```bash
vault secrets enable transit
vault write -f transit/keys/catalog-secrets
```

That is the whole thing. The default key type (`aes256-gcm96`) is right, and the defaults for
`deletion_allowed` (false) and `exportable` (false) are the ones you want — an exportable key is a
key that can leave Vault, which is the property this package exists to avoid.

**Only add `derived=true` if you intend to set `bindContext`**, and decide it now: derivation cannot
be turned on or off on an existing key, so changing your mind later means re-sealing every secret.

```bash
# Only if you want bindContext: true.
vault write -f transit/keys/catalog-secrets derived=true
```

### The policy the token needs

Three paths, `update` on each. Transit's encrypt and decrypt are writes, not reads — a policy
granting `read` looks correct and denies every call.

```hcl
path "transit/encrypt/catalog-secrets" {
  capabilities = ["update"]
}

path "transit/decrypt/catalog-secrets" {
  capabilities = ["update"]
}

# Only needed to rotate without plaintext. Omit it if you never will.
path "transit/rewrap/catalog-secrets" {
  capabilities = ["update"]
}
```

Deliberately **not** granted: `transit/keys/*`. The catalog does not need to create, rotate, export
or delete keys, and a token that can `delete` a key is a token that can destroy every credential in
the database irreversibly. Key lifecycle belongs to an operator or to a pipeline, not to the
application.

### Authentication

| Strategy | Use it for | Renewal |
|---|---|---|
| `kubernetesAuth({ role })` | Pods. The projected service-account JWT is the proof. | Handled here. The JWT is **re-read from disk on every login** — the kubelet rewrites it in place, and a token read once at construction is refused hours later with nothing having changed. |
| `appRoleAuth({ roleId, secretId })` | Anything outside Kubernetes. | Handled here. Note the `secret_id` is itself a credential with a TTL and often a use count; when it runs out, logins fail with a message naming the mount. |
| `staticToken(token)` | `vault server -dev`, and a sidecar that re-injects and restarts. | **Not handled, by anybody.** When the token expires every seal and open fails until the process is restarted with a new one. |

**Renewal is this package's problem, and it does it by re-login rather than by a timer.** The token
is cached with its expiry, replaced when a call needs one and the cached one is close to expiring,
and minted again if Vault rejects it outright — one silent retry, exactly once. There is no
background interval: a timer in a library outlives the module that made it, renews on wall-clock
time rather than on need, and still needs the re-login path for when `max_ttl` is reached. The
argument is written out in [`src/auth.ts`](./src/auth.ts).

Concurrent callers cause **one** login, not one each. A cold start opening forty connectors at once
is how an AppRole with `secret_id_num_uses` burns out in a second.

## What a stored row tells you

`SealedSecret.keyId` is `<mount>/<keyName>` — `transit/catalog-secrets`.

**It tells you** which Transit mount and key were used: enough to decrypt the row, to find it in an
audit log, and to know which key an operator must not delete.

**It does not tell you the key version.** That is inside the ciphertext (`vault:v3:…`), because that
is where Vault puts it and where Vault reads it from. A copy in `keyId` would go stale the moment a
row is rewrapped, and the column is the one a human would believe.

**It does not tell you the cluster or the namespace.** Both are configuration. A row naming its
cluster would have to be rewritten to move between a primary and a DR replica — and replication is
the mechanism that makes those the *same* key. The namespace has a sharper edge: two Vault
Enterprise namespaces can each hold `transit/catalog-secrets` and they are different keys, so
repointing `namespace` at another tenant makes every existing row address the wrong key. It fails
closed — Transit refuses a ciphertext it did not produce — which is the only reason this is an
acceptable trade.

### The name is data

`name` is written into every row, and the store dispatches on it: it opens a row with the bound
vault whose `name` matches, and refuses by name when none does. Renaming it in configuration
strands every secret already sealed under the old name. Recoverably — bind a second instance under
the old name alongside the new one — but completely.

## Rotation

**Rotating the key needs nothing from the catalog.** Transit keeps old versions decryptable and
reads the version out of the ciphertext, so after

```bash
vault write -f transit/keys/rotate/catalog-secrets
```

new saves seal under v2 and every existing row keeps opening. No migration, no downtime, no code.

**Rewrapping is optional and needs no plaintext.** `rewrap()` moves a row to the current key version
through `transit/rewrap`, and the secret never exists outside Vault:

```ts
const vault = app.get(VaultTransitSecretVault);
for (const row of rowsHoldingSealedSecrets) {
  row.config.url = await vault.rewrap(row.config.url, { kind: 'connection', id: row.id, field: 'url' });
}
```

`rewrap` is **not** on `CatalogSecretVault`, so this job has to inject the concrete class — see
[what did not fit](#what-did-not-fit).

**The one thing rotation does not make free is trimming.** Raising `min_decryption_version` deletes
the ability to read anything older, permanently, and Vault cannot warn you that rows exist at those
versions because it does not know the rows exist. **Rewrap before you trim.**

## When Vault is unreachable

The two directions are not symmetric, and this package treats them differently.

**`seal` does not retry.** A person is waiting on a form and nothing has been written — a failed
seal means the row was never saved, so there is no partial state to clean up. The cheapest correct
recovery is to report it and let them press the button again. What the store will *not* do is fall
back to writing plaintext: a deployment that turned `encryptCredentials` on and then quietly wrote
three passwords in the clear during an outage would have no way to find out which three.

**`open` retries** — three attempts by default, exponential with full jitter. Nobody is waiting, the
failure aborts a scheduled load, and the likely cause is a leader election or a sealed standby that
clears in seconds. It also has nowhere else to be retried: `open` is called from inside the
catalog's run path, so a host cannot wrap it.

Neither ever repeats a failure that cannot change. A `403`, an unparseable ciphertext or a key
version below `min_decryption_version` fails once and immediately, however large the budget.

## What did not fit

The point of a provider seam is that it survives a second provider. Three places where
`CatalogSecretVault` reflects a model Transit does not share — reported rather than worked around.

### 1. `ciphertext` is documented as base64. Transit's is not.

`SealedSecret.ciphertext` says *"Base64. The library never inspects it."* Transit returns
`vault:v1:<base64>` — a version-tagged string with two colons, which is not base64 and does not
decode as base64.

This package **stores Transit's string verbatim**, because the version tag is the only
self-description the row has, and because Vault's own tooling consumes exactly this string
(`vault write transit/rewrap/catalog-secrets ciphertext=@row` is how a rotation gets finished).
Re-encoding it would make the column unusable by the tool that exists to operate on it.

Nothing breaks today — `isSealedSecret` checks that the field is a non-empty string and nothing
more. The risk is if anything downstream ever takes the comment literally: a base64 `CHECK`
constraint, a JSON schema with `contentEncoding`, a `Buffer.from(value, 'base64')` round trip.
`Buffer.from` would not throw; it silently drops the characters it does not recognise and returns
different bytes. **The fix is one word in a comment, and it has to be the right word.**

### 2. The encryption context cannot bind the row, for any provider

`SecretContext` is passed to `seal` and to `open`, and the contract names the motivation: a
ciphertext sealed for `connection/abc/url` should not be replayable as `connector/xyz/url`.

Transit can do this, with a caveat: its `context` parameter is not AAD, it is a key-derivation
input, available only on keys created `derived=true`, and sending it to an ordinary key is a `400`.
Hence `bindContext`, off by default.

The larger problem is `id`. It is *absent on a first save*, so binding it means sealing under one
context and opening under another — every secret sealed at create time would be undecryptable
forever, discovered at the first connector run rather than at the save that caused it. So the
binding here is `["kind", "field"]` and nothing else.

**This is not a Vault limitation.** The AWS KMS provider excluded `id` from its `EncryptionContext`
for the same reason, independently. The consequence is worth stating plainly: **two rows of the same
kind and field hold interchangeable ciphertexts** under every provider written against this
contract, so the `connection/abc/url` property the docblock offers holds for the kind and the field
and not for the row. A pinned test records it as a limitation rather than asserting it as a feature.

### 3. There is no verb for rotating without plaintext

`transit/rewrap` re-encrypts under the current key version without the plaintext leaving Vault. KMS
has `ReEncrypt`. It is the headline operational capability of both providers this abstraction spans,
and `CatalogSecretVault` has no method for it — expressed only through the contract, a rotation
becomes `open` then `seal`, dragging every credential in the catalog back through application memory
to accomplish something neither vault needed the application for. The workaround is strictly worse
than the primitive, and worse on exactly the security property the vault was adopted for.

`rewrap()` is therefore provider-specific and reached by injecting the concrete class, which makes a
rotation job provider-specific too.

### A note on retryability, which is *nearly* there

The catalog has the concept — `SecretOpenFailedError` carries `retryable`, and the durable dispatch
boundary acts on that field and nothing else. What it has no channel for is the vault's own opinion:
`openSealed` sets `retryable: !isPermanent(error)`, and `isPermanent` recognises exactly
`SecretVaultNotConfiguredError`. So a `403`, or a ciphertext below `min_decryption_version`, is
retried three times across fifteen minutes before reporting itself.

Wrong in the safe direction, and the store argues for that deliberately. But the vault is the only
layer that can tell a throttle from a key policy, so `VaultTransitError` carries `retryable` anyway
— as does the KMS provider's error, arrived at independently. `isPermanent` reading
`retryable === false` off the cause would close it for both at once.

## What did fit, and is worth saying

- **Routing between providers works.** `CATALOG_SECRET_VAULT` takes an array; the store seals with
  the first and opens with whichever one's `name` matches the row. A KMS → Transit migration has a
  middle: bind both, let saves reseal under Transit, drop KMS when nothing carries its name. Use
  `createVaultTransitSecretVault()` to build an instance for a list `forRoot` cannot assemble.
- **`keyId` is enough and not too much.** `open` reads the key from the row while `seal` uses the
  configuration, so moving the mount or changing the key strands nothing.
- **Rotation is genuinely invisible** to the catalog, which is more than the interface asks for.

## Tests

`pnpm vitest run packages/secrets-vault`. No network: the stub sits at `fetch`, so the token cache,
the retry policy, the base64 on both sides and the path construction are all real code. Assertions
are on the **request** — path, payload, headers — because a provider that posts to the wrong mount
or sends `context` to a key that cannot take one round trips perfectly against a cooperative stub
and fails against every real Vault. `test/fake-vault.ts` adds a Transit engine that really
transforms the bytes, tracks key versions and rejects a ciphertext that does not authenticate, so
rotation and rewrap are exercised rather than asserted about.
