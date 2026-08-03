---
'@dudousxd/nestjs-catalog-dashboard': patch
---

Actually mount the console at its configured path

The controllers carry no path of their own — that is what makes `path` configurable, since a
decorator argument is fixed at class-definition time — but nothing was supplying the prefix, so they
inherited the host's global one and answered on `/api`. The console 404'd at its configured path
while the module reported itself initialised, which is a confusing pair of symptoms to hold at once.

`RouterModule.register` binds the module to `path`, the way the other Aviary consoles do it.
