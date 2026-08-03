---
'@dudousxd/nestjs-catalog-dashboard': minor
---

`guards` and `forRootAsync`, so a host can shut the console

`auth` alone was not enough to mount this the way the other Aviary consoles are mounted. It describes
how a session is *validated*, which means a host that has not configured it yet has an **open**
console — and this one can rewrite a catalog's model and run its connectors.

`guards` is the answer to that, and it is deliberately separate: a denying guard needs no secret, no
DI and no session, so a host with nothing configured can still be shut rather than open. It is bound
at module-definition time, which is also why it cannot come from the async form.

`forRootAsync` covers the other half: validating a session usually means asking something the host
owns — a user store, a session service — and `forRoot` cannot reach DI.
