---
"@dudousxd/nestjs-catalog-store-mikro-orm": minor
"@dudousxd/nestjs-catalog-pipeline": minor
"@dudousxd/nestjs-catalog-react": minor
---

The connection form asks for a connection string, and can test it before saving

Three changes to one screen's worth of friction.

**One field, not two.** The SQL address block offered an inline URL and the name
of an environment variable holding one, side by side, with a paragraph
explaining when each applied — and only one of them worked for a database with a
password, which is every database anybody connects to. It asks for the
connection string now.

**`allowInlineCredentials` on the store, default false.** A connection URL is
the credential, and `config` is served under `catalog:read`, so a password
inside one is refused. That refusal is what makes the "never the credential"
promise true rather than aspirational, and it stays the default. A deployment
that would rather type a connection string than provision an environment
variable can turn it off — and what does NOT change is the redaction: the
password never travels in a response either way. The flag decides only whether
it may rest in the catalog's own table.

**`POST pipeline/connections/check`** reaches a connection that has not been
saved. The field most likely to be wrong is the address, and finding out used to
mean saving a row, testing it from its card, and deleting it.

It asks `catalog:write`, not the `catalog:read` its by-id sibling asks for, and
the difference is the whole point: checking a saved connection reaches an
address somebody already chose and wrote down; checking a posted one reaches an
address supplied in the request. Under `catalog:read` that is a port scanner for
anybody who may look at the catalog. Under `catalog:write` it grants no reach
that did not exist — the same caller could save, check and delete — but that
route leaves records and this one leaves none, so it logs what it did. The
address, never the credential.
