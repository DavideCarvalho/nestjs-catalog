---
"@dudousxd/nestjs-catalog-react": minor
---

Focus mode shrinks the overview, and hovering it brings it back

Focus mode left the minimap alone, deliberately: it is a navigation aid for
exactly the big graph that made somebody want the room, so hiding it takes away
the thing the mode is for. But it is also the largest single piece of chrome
still standing once the card has folded, and at 200×150 it was most of what was
left. So it shrinks rather than goes, and comes back at full size under a
pointer or a caret.

### What the shrunk map still shows

96×72, which is React Flow's 200×150 scaled by 0.48 — whole pixels on both
axes, because a fractional height puts the mask's bottom edge on a half-pixel
and the viewport box picks up a grey seam that reads as a border it does not
have.

It keeps the one thing it is for: **where the viewport is in the graph**. That
is drawn as a hole in a tinted mask, so it is an area rather than a detail, and
area survives scaling — the box keeps its position and its proportion of the
whole, which is the entire "am I looking at the middle of this graph or the far
edge" question. The node dots keep their kind colours, so a cluster and a lone
box on the other side of the graph are still two different pictures.

**What is sacrificed**: reading an individual node's position precisely, and
telling two adjacent nodes apart. Both come back on hover, and neither was ever
a gesture here — no `onNodeClick` is passed to the minimap, so a dot has never
been a target.

### The numbers

Measured in a headless browser on the same seven-node graph and the same two
viewports as the previous round, with chrome coverage taken as the true **union**
of the floating panels clipped to the canvas — not a sum, which would
double-count the day two panels overlap and flatter every later number.

| | 1600×913 | 1280×800 |
|---|---|---|
| chrome, no focus mode | 23.7% | 30.5% |
| chrome, focus mode, overview full size | 5.6% | 8.0% |
| **chrome, focus mode, overview shrunk** | **4.0%** | **5.7%** |
| free canvas, shrunk | 96.0% | 94.3% |

So the shrink is worth **1.6 points** of canvas at 1600×913 and **2.3 points** at
1280×800, on top of what focus mode already bought. That is a modest number and
it is the honest one: the card was the big win, and this is the remainder. The
minimap itself goes from 2.1% of the canvas to 0.5%.

(These absolute percentages are not directly comparable with the 20.3% / 25.3%
quoted for the previous round — that measurement did not count React Flow's own
panels, and this one does. The focus-mode delta is measured the same way
throughout the table above.)

### Hover is not the only way in

**Pointer.** `:hover`, which is the gesture that was asked for.

**Keyboard.** The panel becomes a focus stop *while it is shrunk*, and expands on
`:focus`/`:focus-within`. React Flow's minimap is an `svg` with `role="img"` and
cannot hold a caret, so `focus-within` needed something that could. It is
conditional on purpose: outside focus mode the tab order is exactly the one the
previous round measured and settled — app nav, card, actions, rail toggle, dock,
rail, canvas — and inside focus mode there is one extra stop, at the end, on the
element that needs it. That is a net gain for a keyboard, since the minimap was
never reachable in either mode before.

**Touch.** It does not shrink at all. There is no state between "not touching"
and "touching" on a touch screen, so the first contact with a pannable minimap
*is* a pan — a map that expanded on touch would turn a navigation gesture into a
resize gesture and move the viewport while doing it. There is no version of
hover-to-expand that works there, so a finger gets the map exactly as it is
today. Gated on `(hover: hover) and (pointer: fine)`, read once at mount, and
answering "do not shrink" to every failure.

### Panning, and why the size had to be a scale

React Flow sizes the minimap from `style.width`/`style.height` and derives
`viewScale` from them. Its pan handler moves the viewport by `rawClientDelta *
viewScale`, reading `viewScale` **live** from a ref on every `mousemove`.

Shrinking the obvious way — passing a smaller width and height — would therefore
change the pan gain, and change it *on every frame of an animation between the
two sizes*. A drag that started while the map was small and expanded mid-gesture
would have the viewport accelerate under the finger for the length of the
animation.

Scaling has none of it: `style.width` stays 200 in both states, so `viewScale` is
a constant and the pan gain is identical small, large, and every frame in
between. The interactive area is smaller while shrunk, but on a fine pointer that
state is unreachable — a drag needs a press, a press needs the pointer over the
element, and the pointer being over the element is what expands it. Every drag
begins on a settled, full-size map. Expand-then-pan, arrived at by geometry
rather than by disabling anything. Verified in a browser: hover expands 97→202px,
the drag pans, and the map stays expanded throughout.

### It cannot flicker

Both states are anchored at the same bottom-left corner and the transform origin
is that corner, so the small box is a strict sub-rectangle of the large one. A
pointer that enters the small box is still inside the large box once it expands,
so expansion can never move the element out from under the pointer that caused
it. The oscillating geometry — expand, pointer now outside, collapse, repeat —
needs the two boxes to disagree about a region, and containment rules that out.
Measured twice, 500ms apart, after the pointer leaves: the same size both times.

It also cannot collide with the zoom controls above it, because the expanded size
is the size the minimap already is today — it grows back into space that was
always reserved for it.

### The animation

A 200ms tween on the same curve the card body folds on, so the two halves of one
gesture move as one gesture. Not a spring, and not on a resolved height: that is
the shape of animation which never settled under jsdom, so `AnimatePresence`
never unmounted and the card body stayed in the document forever in a test while
working fine in a browser. There is nothing here for that to happen to — the
minimap is never unmounted and never changes layout size; the only thing moving
is one compositor property. `prefers-reduced-motion` gets the same end state with
no transition, verified with the media feature emulated.

### The zoom controls are untouched

The maintainer asked for the minimap, and the controls are left exactly as they
are — but not only because they were not asked for. They are already the
smallest thing on the canvas (28×80, four icon buttons with no labels), so there
is no compact form to go to short of hiding them, and hiding zoom and fit in a
mode about looking at a big graph removes the way out of being lost. Leaving them
in place is also what gives the expanded map somewhere to grow: the gap between
the shrunk map and the controls is exactly the space the full-size map needs, so
reserving it is what keeps a hover-expand from covering a button.
