---
'@dudousxd/nestjs-catalog-dashboard': patch
---

`catalogDashboardMountPaths` returns the shape `exclude` actually matches

Plain strings with a `{*splat}` wildcard, like every other Aviary console helper. The object form it
returned before is accepted by `setGlobalPrefix`'s type but does not match, and the symptom is a
quiet one: the console mounts, logs itself as initialised, and answers on `/api/<path>` while 404ing
at `/<path>`.
