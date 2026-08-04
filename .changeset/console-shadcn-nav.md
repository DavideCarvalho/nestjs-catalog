---
"@dudousxd/nestjs-catalog-dashboard": minor
"@dudousxd/nestjs-catalog-react": minor
---

A real Tabs in the console nav, a Button component, and arrows when tabs are hidden

**Tabs.** The nav was a row of `<button>`s, which looks like tabs and is not:
no roving tabindex, no arrow-key movement between them, and no `aria-controls`
relationship to the screen each reveals. It now uses the vendored `Tabs` — one
root around BOTH the strip and the panels, because splitting them would leave
that last part broken while looking correct. The panels replace
`{tab === x && ...}` and behave identically: Base UI unmounts the unselected
ones, so each screen still owns its query and no tab polls while hidden.

**Button.** `ui/button.tsx`, vendored in the shadcn style with hand-rolled
variants — matching how `select`, `tabs` and `dialog` are already done here, and
what `class-variance-authority` would compile to for a component with no
compound variants. What it buys over a `<button>` with classes is the part
nobody writes by hand every time: a real focus ring, `disabled` that also stops
pointer events (a dead button otherwise looks alive right up until it is
clicked), `type="button"` by default so a button inside a form does not submit
it, and one place where "what a secondary button looks like" lives.

**Arrows.** Scrolling the strip fixed the overflow but created a second
problem: tabs that exist and cannot be seen, with nothing saying so. Each arrow
appears only when there is something in its direction — a pair where one is
always dead teaches people to ignore both, and on a wide screen two greyed
chevrons beside a strip that does not scroll are pure noise. They stay mounted
and `invisible` rather than unmounting, so the strip does not change width as
they come and go. Out of the tab order too: keyboard users move between tabs
with the arrow KEYS, which Base UI already wires.

`TabsList` now forwards a ref and `TabsTab` takes a `className`, which is what a
caller needs to measure a strip and give it its own metrics.

**The dashboard grid.** Its cards were a fixed `grid-cols-4` at every width, so
on a narrow board a chart's axis labels rendered outside its own card. The grid
is now driven by CONTAINER queries rather than viewport ones — the board sits
beside a sidebar, so how much room a card has is a fact about that box and not
about the window — and a chosen span is only honoured once there are columns to
spend it on.
