---
"@dudousxd/nestjs-catalog-dashboard": patch
---

Rebuild the console, so a change to the screens actually reaches it

`@dudousxd/nestjs-catalog-react` is a **devDependency** of this package, which is
correct — the SPA is built with `vite build` and the component library is
inlined into `dist/spa`, so it is not a runtime dependency of anyone.

The consequence was not correct. changesets only bumps dependents, and a
devDependency is not one, so a release that changed only the screens published a
new `…-react` and left this package alone — and the console kept serving the SPA
it was last built with. Everything was green: versions went up, provenance
attested, and the screens did not change. The last two releases of the component
library never reached a browser.

`fixed` in `.changeset/config.json` now groups the two, so they version and
publish together. The alternative — remembering to add the dashboard to every
changeset that touches the screens — is the one that just failed.
