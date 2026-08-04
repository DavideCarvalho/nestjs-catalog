---
'@dudousxd/nestjs-catalog-dashboard': patch
---

Resolve the auth options instead of passing them through

`resolveDashboardAuth` derives `modes` from which hooks a host supplied, and every endpoint reads it.
The module handed over the raw options, so `modes` was undefined and the session endpoint died with
`Cannot read properties of undefined (reading 'includes')` — a 500 where a 401 belongs, on the one
call a launcher makes.

Fixed on both paths, with the async one wrapping the host's factory so it cannot skip the resolution.
