---
"@dudousxd/nestjs-catalog-dashboard": minor
---

The console can be served as part of a host's own application. Three new `CatalogDashboardModule` options, each defaulting to today's behaviour: `screens` lists the screens to show (`model`, `objects`, `query`, `dashboards`, `workflows`, `connections`, `lineage`, `activity`, `access`, `search`), and a hidden one gets no tab, no panel and no requests; `pipeline: false` leaves the Model screen's **Loaded by** and **Load expectation** out and never requests their endpoints; `hostAuthenticates: true` shows no sign-in and never calls `/auth/me`. A 404 from `/environments` now reads as a single environment, and the picker is left out instead of failing. The page config moves from an inline script to `<path>/config.js`, loaded first in the head, with every value JSON-encoded, so the console works under `script-src 'self'`. `index.html` no longer links Google Fonts; the stylesheet falls back to system fonts.
