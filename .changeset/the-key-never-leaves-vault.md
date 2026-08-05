---
"@dudousxd/nestjs-catalog-secrets-vault": minor
---

A HashiCorp Vault Transit provider for `CATALOG_SECRET_VAULT`, and what it found out about the seam

`@dudousxd/nestjs-catalog-secrets-vault` binds `CATALOG_SECRET_VAULT` to Vault's Transit engine, so
the credentials in `catalog_connection.config` rest as ciphertext and the key that opens them never
reaches the application. A dump, a replica or a nightly backup gets `vault:v1:…`.

Zero runtime dependencies — three JSON `POST`s over the global `fetch`. For the one package every
credential in the catalog passes through, its transitive dependency set is its supply-chain blast
radius, so `node-vault` was not worth a package; a host needing mTLS, a private CA or a proxy passes
its own `fetch`. Auth by Kubernetes, AppRole or a static token, with renewal by lazy re-login rather
than a background timer, one login for concurrent callers, and one silent retry when Vault rejects a
cached token.

## The second provider is where an abstraction stops being one implementation with extra steps

Three places `CatalogSecretVault` reflects a model Transit does not share. All are reported rather
than worked around, and two of them are not about Vault at all.

**`ciphertext` is documented as base64, and Transit's is not.** It returns `vault:v1:<base64>` —
version-tagged, two colons, not decodable as base64. Stored verbatim, because the version tag is the
row's only self-description and because `vault write transit/rewrap/… ciphertext=@row` is how a
rotation gets finished. Nothing breaks today: `isSealedSecret` checks for a non-empty string and
nothing more. It breaks the day anything takes the comment literally — and it would break quietly,
because `Buffer.from(x, 'base64')` does not throw on input it cannot read, it returns different
bytes.

**The encryption context cannot bind the row, for any provider.** Transit can bind `context`, but
only on a key created `derived=true`, so it is opt-in here. The unfixable half is `id`: absent on a
first save, so binding it seals under one context and opens under another, and every secret sealed at
create time would be undecryptable forever. The binding is `["kind","field"]` — and the AWS KMS
provider excluded `id` from its `EncryptionContext` independently, for the same reason. So **two rows
of the same kind and field hold interchangeable ciphertexts under every provider**, which is worth
knowing, because the docblock offers `connection/abc/url` not being replayable as `connector/xyz/url`
as the motivation for passing the context to both halves. It holds for the kind and the field. It
cannot hold for the row.

**There is no verb for rotating without plaintext.** `transit/rewrap` re-encrypts under the current
key version without the secret leaving Vault; KMS has `ReEncrypt`. It is the headline capability of
both providers the seam spans, and through the contract a rotation can only be `open` then `seal` —
dragging every credential back through application memory to do something neither vault needed the
application for. `rewrap()` is provider-specific, so a rotation job is too.

A fourth is nearly closed already. `SecretOpenFailedError` carries `retryable` and the durable
dispatch boundary reads exactly that field, but `isPermanent` recognises only
`SecretVaultNotConfiguredError` — so a `403`, or a ciphertext below `min_decryption_version`, burns
three attempts across fifteen minutes first. Wrong in the safe direction, and deliberately so, but
the vault is the only layer that can tell a throttle from a key policy. `VaultTransitError` carries
`retryable`, as does the KMS provider's error; `isPermanent` reading it off the cause would close it
for both.

## What fitted

Routing works: `CATALOG_SECRET_VAULT` takes an array, the store seals with the first and opens by
name, so a KMS → Transit migration has a middle rather than a cutover. `keyId` holds mount and key
and deliberately not the version — the version lives in the ciphertext, which is why **a rewrapped
or rotated key needs no change in the catalog at all**, and why a `keyId` carrying one would be the
field that went stale. `open` reads its key from the row while `seal` uses the configuration, so
moving the mount strands nothing.
