---
'@dudousxd/nestjs-catalog-dashboard': patch
---

`useDashboardAuth` may return `undefined`

A host whose signing secret is unset has no way to mint a session, and the honest answer is "no auth
mechanism" — paired with a denying `guards` entry, which is what turns that into a CLOSED console
rather than an open one. The type forced a return, which would have pushed hosts to invent an auth
object around an absent secret: a cookie signed with nothing.

Found while mounting it, which is the only place a signature like this gets tested.
