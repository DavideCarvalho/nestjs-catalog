---
"@dudousxd/nestjs-catalog-react": minor
"@dudousxd/nestjs-catalog-dashboard": minor
---

Sharing can be switched on from the console, and the export link follows the host

**A dashboard can be shared, which means the embed API is reachable at all.**
`CatalogClient.saveDashboard`/`updateDashboard` did not name `shared`, so
`updateDashboard(id, { shared: true })` was a compile error and no screen ever
sent it. `shared` is the entire access boundary of the embed API, so every
dashboard a shipped console produced answered `403` from `embedDashboard`, and
`<EmbeddedDashboard>`'s "Nothing on this dashboard has been shared" was not an
empty state but the only state the component had. The server anticipated exactly
this one layer down — `patchDashboard` declares the field so a whitelisting
`ValidationPipe` cannot strip it — and the client type dropped it again.

Both writes name it now, and the board carries a control: the state, a sentence
saying who can reach the board while it holds, and a button naming the
transition. Not a switch — the server records this crossing as an event, in both
directions, and a control for an audited act should say where you are before it
offers to move you.

**A saved query can be un-shared.** `shared` was settable only when the query was
first saved, and `updateSavedQuery` — which accepts it — had no call site
anywhere, so a query shared by mistake could only be un-shared by deleting it.
The list now marks a shared query without waiting to be hovered, and offers both
directions.

**`exportUrl` no longer hardcodes `/api`.** It was the one method on
`CatalogClient` that bypassed the injected transport, in the component most
likely to run inside somebody else's page. `CatalogTransport` gained an optional
`url(path)`, and the export link is built from it like every other request.

> **Hosts should implement `url` on their transport.** It is optional, so
> nothing stops compiling — but a transport that does not answer gets the path
> exactly as written, which is right only where the catalog API is served from
> the root. If yours prepends a base (an axios `baseURL`, a gateway prefix), add
> `url: (path) => \`${base}${path}\`` or the CSV export will 404. Hosts that were
> mounted under `/api` were previously right by accident.

**`CatalogApiSessionGuard` is a host-appliable primitive, and says so.** It
documented itself as gating `CatalogApiController`, a class that exists nowhere,
and was bound to nothing. It cannot be bound here: the catalog's JSON API is
mounted in the host's own tree and deliberately not proxied through the console.
The module now provides and exports it, so `app.get(CatalogApiSessionGuard)` —
how a host puts it in front of a whole API surface — resolves.

**`dashboardAuth` no longer claims to gate the JSON API.** It gates the SPA
shell, and only that; the option's own docblock said "BOTH the SPA and the JSON
API", which left a host that configured `auth` and stopped reading with its rows,
ad-hoc SQL and connector runs on whatever guarded the API before. The docblock
now points at the two seams that close it, `readCatalogConsoleSession` and the
guard above.

**The CSRF rationale names the flag the code actually sets.** The console's
transport justified `credentials: 'same-origin'` with a `SameSite=Strict` cookie;
`serializeSetCookie` has only ever emitted `Lax`. Lax is kept — `Strict` costs
nothing on the flows this package ships but withholds the cookie from a top-level
navigation arriving from another site, which is how a console gets linked to —
and the guarantee is restated accurately: Lax covers cross-site `fetch`, `XHR`
and form POSTs, and permits a cross-site top-level GET. The one state-changing
GET that leaves exposed, `GET logout`, is argued once, where the route is.
