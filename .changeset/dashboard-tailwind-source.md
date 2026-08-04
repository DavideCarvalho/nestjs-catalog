---
"@dudousxd/nestjs-catalog-dashboard": patch
---

Style the console again

The stylesheet scanned `../node_modules/@dudousxd/nestjs-catalog-react/**` for
class names, which resolves relative to the stylesheet — a `src/node_modules/`
that does not exist. Tailwind's `@source` does not error on a path that matches
nothing, so the build succeeded and every class used only inside the React
component package was dropped: the console rendered with its markup intact and
almost none of its CSS, which reads as a broken component library rather than a
missing directory. Fixed to `../../node_modules/…`; the emitted stylesheet goes
from 31KB to 78KB.
