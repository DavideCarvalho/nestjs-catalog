---
'@dudousxd/nestjs-catalog-react': patch
---

Fix: the "Actions" pill on a workflow node opens its menu

**Clicking it did nothing at all** — no menu, no error, nothing rendered to inspect. Right-click on the same node was unaffected and offered the identical list, which is why this reads as one bug in one place rather than two.

`NodeToolbar` renders as a **direct child of `.react-flow__renderer`**, the element React Flow hands to d3-zoom, rather than inside the node it points at. So a `mousedown` anywhere on that toolbar bubbled straight into the canvas pan gesture, and d3-zoom's `mousedowned` opens by calling `stopImmediatePropagation`. React delegates its listeners to the root container, which is an ancestor of the renderer, so an event stopped there never reaches React at all — the trigger's `onMouseDown` simply never ran.

That was fatal for the pill and for nothing else on the toolbar, because Base UI's `Menu.Trigger` opens on **mousedown** while the trash button beside it opens on **click**, which d3-zoom leaves alone. Hence a toolbar that looked half-working: delete fine, Actions inert.

The toolbar now carries React Flow's own `nopan` guard, which makes the zoom filter refuse the gesture before it stops anything — the same guard the edge's × wrapper has carried since it shipped. Pressing and dragging from the toolbar no longer pans the canvas either, which it previously did.

Verified in Chrome over CDP with real pointer events, and covered by a test that goes red without the guard: d3-zoom is genuinely live under jsdom, so the press path is exercised rather than approximated. The suite had missed it because every existing test opened the menu with a synthetic `click`, and with no preceding `mousedown` floating-ui falls through to a click path no pointer takes.
