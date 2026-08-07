---
'@dudousxd/nestjs-catalog-react': minor
'@dudousxd/nestjs-catalog': minor
'@dudousxd/nestjs-catalog-pipeline': patch
---

A source node can make its connection without leaving the canvas.

The sink node could already create the thing it needs — its schema-discovery panel turns confirmed
columns into an object type, on a draft. The source node could only *choose* an address, so a graph
whose connection did not exist yet meant leaving the canvas, opening the Connections tab, making
one, coming back and finding the node again.

`SourceConnectionCreator` sits under the "Read through" picker in the source inspector and carries
everything the Connections screen carries, because a connection is the credential and the address
boundary:

- the same per-kind fields, now shared from `connection-form.tsx` rather than copied — a record
  keyed by `CONNECTOR_KINDS`, so a sixth kind fails the build instead of arriving with no fields;
- **test before save**, through `POST pipeline/connections/check`, which reaches an address that has
  not been stored and records nothing — sent without an `id`, so nothing is restored and the address
  reached is the one that was typed;
- the deployment's refusal of a credential at rest (`allowInlineCredentials`) printed verbatim, with
  nothing attached to the node when it happens;
- a client-side refusal of a URL whose password is the redaction placeholder, which is the one case
  the server cannot catch: a create has no stored row to restore the real credential from, so
  `REDACTED` would simply become the password.

The new connection is selected onto the node immediately, which marks the draft dirty exactly as
typing a URL into the same node does — and the confirmation says so, rather than leaving somebody to
discover it from schema discovery going quiet.

`@dudousxd/nestjs-catalog` gains `REDACTED_SECRET` on both entry points: the placeholder is part of
what `GET pipeline/connections` answers, and a browser form has to be able to recognise the string it
was shown. `@dudousxd/nestjs-catalog-pipeline` re-exports it from there instead of declaring its own.
