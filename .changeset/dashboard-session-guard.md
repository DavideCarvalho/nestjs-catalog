---
"@dudousxd/nestjs-catalog-dashboard": minor
---

Actually apply the session guard to the console

`auth` is documented as the thing that closes an otherwise-open console, every
docblock describes it that way, and **nothing ever stamped the guard that
enforces it**. A host that configured `auth` correctly still served the console
shell and its assets to anyone who could reach the URL — and the absence was not
visible from anywhere, because the session endpoints worked, the module logged
itself as initialised, and the only way to notice was to open the URL signed out.

`CatalogUiSessionGuard` is now applied to `CatalogUiController`, and NOT to
`CatalogAuthController` — that is where a session is obtained, and gating it on
already having one locks the door from the inside. The guard is a no-op when
`auth` is absent, so an intentionally open mount is unaffected: "open" remains
something a host chose by omitting `auth`, rather than something this module did
by forgetting.

Stamped once per process rather than once per mount, because `UseGuards`
**appends** to a controller's metadata and these controller classes are
module-level — a second `forRoot` in the same process would otherwise run the
guard twice per request.
