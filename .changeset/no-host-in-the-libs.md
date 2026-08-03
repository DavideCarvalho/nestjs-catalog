---
'@dudousxd/nestjs-catalog': patch
'@dudousxd/nestjs-catalog-pipeline': patch
---

Stop naming one consumer in a public library

The pipeline package was extracted from an application's copy of the engine, and the extraction
carried that application's name into comments, a docblock, a seams table — and into a **runtime error
message**, which shipped advice about one host's durable module to every consumer that hit it.

Nothing was wrong with the *reasoning* in those places; only with whose name it was told through. It
now describes the situation rather than the application: "a host with separate API and worker
processes", "a multi-environment host", "either this host mounts no durable engine, or its durable
module failed to bind".

`catalog.principal.ts` had the same slip in an older comment, so that goes too.
