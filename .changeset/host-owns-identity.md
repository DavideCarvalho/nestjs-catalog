---
'@dudousxd/nestjs-catalog-dashboard': patch
---

Don't ask for a password the host already checked

Mounted inside an application, the console showed its own sign-in form and then failed with
`Cannot GET /api/auth/me`. Two faults behind one symptom.

The SPA hardcoded `/api` as the API base, ignoring the `apiPath` the mount configures — so every call
went to the host's own API root instead of the catalog's. And it always rendered its local-password
gate, which only exists for the standalone deployment; a console embedded in an app that just
authenticated you has no business asking again, and the credential it wants does not exist.

The server now tells the SPA both things: where the API is, and whether the host authenticates. When
it does, the gate is skipped and the host's session cookie carries the request. The injected globals
are also renamed off `__DURABLE_*`, which they had been carrying since this package was templated
from the durable console.
