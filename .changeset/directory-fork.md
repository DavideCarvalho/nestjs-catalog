---
"@dudousxd/nestjs-catalog-store-mikro-orm": patch
---

Fork the EntityManager, so `/access/principals` is not a 500

`MikroOrmCatalogDirectory` read through the injected EntityManager, which is the
**global** one. MikroORM refuses context-specific calls on it — `Using global
EntityManager instance methods for context specific actions is disallowed` — and
a read from a request handler is exactly that, so every call to the endpoint
answered 500.

Nothing caught it: it compiles, the module boots, the route mounts, and the
guard in front of it answers 401 to an unauthenticated probe — which looks
identical to a working endpoint. A unit test with a stubbed EntityManager would
also have passed, because a stub has no request context to be outside of. It is
now covered by a `*.db.spec.ts` against a real MySQL, where reverting the fix
fails four cases with that exact message.
