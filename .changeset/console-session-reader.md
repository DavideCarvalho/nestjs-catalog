---
"@dudousxd/nestjs-catalog-dashboard": minor
---

Let the host's API guard read the console's session

This package serves the console and mints its session, and deliberately does not
proxy the catalog's API — that surface is `CatalogModule`'s, behind whatever the
host put in front of it. Which left a gap no host could close on its own.

The console SPA fetches that API **from a browser**. It carries this package's
session cookie and no bearer token, so a host whose API guard understands only
its own tokens answers 401 to every screen while the console shell loads
perfectly. It reads as a broken API rather than as two auth systems that were
never introduced to each other, and it is what happens the first time this
console is embedded in an application rather than run standalone.

`readCatalogConsoleSession(auth, request)` is the introduction: given the
`DASHBOARD_AUTH` value and a request, it returns the verified session or null.
Signature and expiry are checked; `revalidate` is not run, because renewal
belongs to the guard that owns the cookie's lifetime.

`ResolvedDashboardAuth` and `DashboardSession` are exported alongside it — a
host injecting the token needs a name for what comes out.
