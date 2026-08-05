---
"@dudousxd/nestjs-catalog": minor
"@dudousxd/nestjs-catalog-store-mikro-orm": minor
---

Credentials can be encrypted before they rest in the catalog's own tables

The redaction stopped a connection password travelling in an HTTP response. The
refusal stopped a new one being written. Neither does anything for the reader
this is about: a database dump, a read replica, a nightly backup, or anybody
holding `SELECT` on the instance. For them `catalog_connection.config` was a
list of every password the catalog knew — and `allowInlineCredentials` enlarges
that population on purpose, which is why this is worth building now.

**`CatalogSecretVault`, a seam and not a cipher.** There is no encryption in
this library and there must not be: shipping AES with a key from an environment
variable moves the problem from one column to one variable, and leaves this
package answering for key rotation and per-environment separation that the
host's KMS or Vault already answers for. Bind `CATALOG_SECRET_VAULT` — to one
vault, or to an array of them, which is what lets a key rotation happen without
an outage: the first seals, and any of them may open, matched on the `vault`
name every row carries.

**The default refuses.** Unbound, `RefusingSecretVault` throws on `seal` naming
the token. A default that quietly stored plaintext would make
`encryptCredentials: true` a no-op with a reassuring name — saves would succeed
and the column would be exactly as it was.

**`encryptCredentials`, and how it composes with `allowInlineCredentials`.**
Four combinations, three meanings, and no fourth: sealing runs *before* the
refusal is asked, so a sealed credential is an object by the time anything looks
for a password-bearing string. `false/false` refuses (unchanged, and the
default). `false/true` and `true/true` seal. `true/false` is the deliberate
dev-environment plaintext trade the flag already documented. The combination
worth naming is `allowInlineCredentials: false, encryptCredentials: true` — it
reads like a contradiction and is the one a production deployment wants.

**The store opens on every read**, whatever the flag currently says, so turning
encryption off keeps existing rows readable rather than being a data-loss
button. It also means nothing downstream learns that a vault exists: `fetchSql`
still gets a URL, and — the sharper reason — `restoreRedactedSecrets` still
gets a string to compare against. Had reads handed out ciphertext, the console
round trip would have written the literal `REDACTED` over the credential, which
is the classic way a fix of this shape corrupts what it protects. **The
redaction is unchanged and stays**: it defends against `catalog:read` over HTTP,
sealing defends against `SELECT` on the database, and dropping either because
the other exists gives that attacker the password back.

**What is sealed** is what the refusal already recognises — a top-level string
that parses as a URL carrying a password — and not the whole `config` object.
One predicate, two consumers: seal something the redaction does not hide and a
console renders a ciphertext blob; hide something this does not seal and the
column still holds the password. Sealing everything would also blind the
refusal, which needs a string to inspect.

**Rows already holding plaintext** are sealed on their next save and not before.
No read-through-reseal — a read that writes can fail a connector run for a
bookkeeping reason, and these rows are read on the runner's hot path — and no
one-shot migration in this release. The column takes both forms indefinitely,
`isSealedSecret` tells them apart, and a migration written later needs no schema
change.

**A vault that is down fails a save, and fails a read *retryably*.** A save that
cannot seal writes nothing; there is deliberately no catch that logs and stores
the plaintext, because a deployment that did that during an outage would have no
way afterwards to find out which credentials went in clear. A read that cannot
open throws `SecretOpenFailedError`, which is pointedly **not** a
`BadRequestException` — `ConnectorRunSteps` catches that class and converts it
to a non-retryable `connector_unavailable`, so a five-second vault blip would
have become a load that never ran and an operator hunting for a connector nobody
deleted. It is fatal only when waiting provably cannot help: nothing bound,
nothing bound under the row's vault name, or the vault's own error saying so.

**`saveWorkflow` refuses and seals a source node's credential too.**
`WorkflowSourceNode` promised "credentials stay out of the catalog here exactly
as they do everywhere else" and nothing enforced it: the graph was written
verbatim, and the workflow runner spreads `node.config` into a synthesised
connector, so `fetchSql` read `config.url` from there exactly as it does from a
connector's. Same predicate, applied per node; grandfathering compares per node
id, so renaming a graph does not refuse over a credential nobody touched. The
graph fingerprint is taken before sealing, so a non-deterministic ciphertext
never registers as a new version.
