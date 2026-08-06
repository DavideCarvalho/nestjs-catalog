---
'@dudousxd/nestjs-catalog-react': patch
---

A tall query can be scrolled to the bottom

**The bug.** "tentei scrollar e não foi" — the SQL box on `#query` would not
scroll. Reproduced in Chrome with a 61-line body in the `h-56` box: a real wheel
event dispatched over the editor moved `window.scrollY` from 0 to 270 and left
the editor on line 1. The PAGE scrolled; the code did not.

**The cause, which is the previous fix's blind spot.** `overflow: 'scroll'` is an
option about WRAPPING, and it buys one axis. Inside the shadow root
`@pierre/diffs` puts `overflow-x: scroll` on its `[data-code]` element, pairs it
with `overflow-y: clip`, and lets that element size to the whole document — 1230px
of it inside a 224px box. Nothing in the library scrolls vertically: `File` is
the non-virtualised renderer and owns no viewport, and the one escape hatch it
exposes, `--diffs-overflow-override`, substitutes into the X component alone. So
the overflow landed on the first ancestor with an opinion, which was
`CodeEditor`'s own wrapper wearing `overflow-hidden` — clipping, by definition,
without offering any way to scroll. Walking every element from the last line up
to `<html>` found not one with a user-scrollable Y axis. Only the browser's own
caret-into-view scrolling could reach line 61, which is why typing to the bottom
appeared to work and dragging never did.

**The change.** The wrapper is now `overflow-x-hidden overflow-y-auto`: it
becomes the vertical viewport the dependency declines to be. `overflow-x-hidden`
is load-bearing rather than tidy — an `overflow-x` left `visible` beside a
scrolling Y axis computes to `auto`, stacking a second, permanently empty
scrollbar on the real one inside the shadow root.

Nothing about the horizontal axis moves, and the selection bug that
`overflow: 'scroll'` exists to prevent does not come back. Verified in Chrome
after the change, on the same 61-line body: a wheel down takes the wrapper's
`scrollTop` from 0 to 1013 with `window.scrollY` still 0, a drag on the 15px
scrollbar takes it to 636, `PageDown` and the arrows keep the caret in view,
typing past the bottom edge scrolls one line to follow it, and a horizontal wheel
still moves the 1463px first line inside its 657px box. Every line box is exactly
one line-height tall, and `Shift+End` from offset 7 of that first line still
selects to the end of the LOGICAL line.

The query console (`h-56`), both transform panes (`h-72`, `h-32`) and the
workflow canvas's code sheet were all affected and are all fixed by the one
change. The history sheet's diff never was: `MultiFileDiff` is given no fixed
height there, so it grows to its content and the page scrolls it.

**Known, and not fixable from outside the shadow root.** The horizontal scrollbar
belongs to `[data-code]`, which is document-height, so it is drawn at the bottom
of the DOCUMENT rather than at the bottom of the visible box. A horizontal wheel
or trackpad swipe works from anywhere in the box; the scrollbar itself only comes
into view once you have scrolled to the end.
