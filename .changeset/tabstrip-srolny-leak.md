---
"@dudousxd/nestjs-catalog-react": patch
"@dudousxd/nestjs-catalog-dashboard": patch
---

Stop the tab strip leaking its scroll extent onto the page

The console still scrolled sideways on a narrow screen — by 189px at 809px wide
— and the cause was the fix for that same bug.

Bringing the selected tab into view needs a ref on the tab, and `TabsTab` did
not forward one, so the strip rendered a zero-size `sr-only` marker inside each
tab and used that. Tailwind's `sr-only` is `position: absolute`, which escapes
the strip's `overflow-x` clipping: each marker reported its static position —
out where its tab sits in the strip's full scroll extent — and the document grew
to contain them. The page then scrolled by exactly the amount the strip was
hiding.

`TabsTab` forwards a ref now and the marker is gone.

Proven on the running console rather than argued: removing the nine markers took
`documentElement.scrollWidth` from 998 to 809, and putting them back restored
998. An isolated harness did NOT reproduce it, which is worth saying — the
evidence for this is the experiment on the real page, not a reduction.
