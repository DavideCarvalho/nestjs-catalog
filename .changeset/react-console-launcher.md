---
'@dudousxd/nestjs-catalog-dashboard': minor
---

A `./react` tier, so a host can put this console in its launcher

Mounting the console was not enough to make it reachable: an application that gathers its consoles on
one page opens each through a hook the console's own library ships, because minting the session is
that library's business and a hook cannot be picked by name at render time without breaking the rules
of hooks. This package had no such hook, so the console could only be reached by typing its URL.

Three levels, pick one:

- `openCatalogConsole(...)` — no React, from `./client`
- `useOpenCatalogConsole(...)` — state for a launcher, you own the markup
- `<OpenCatalogConsoleButton />` — drop-in, unstyled

`openCatalogConsoleMutationOptions` wires the same call into TanStack Query without this package
depending on TanStack. React is an optional peer, so a host that only mounts the NestJS module never
pulls it in.
