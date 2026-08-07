---
"@dudousxd/nestjs-catalog-react": minor
---

The workflow canvas is the screen, and the tooling floats on it

The canvas was a box in a column. Above it sat a heading, a description
paragraph, a checkpointing notice, a picker, a name field and a row of buttons;
beside it, a 18rem column of panels. On a 1600×1000 window the surface somebody
actually draws on got a little over half the viewport, and the half it got was
the wrong shape — wide graphs ran out of room sideways while a third of the
screen held text that is read once.

So the layout is inverted. The React Flow surface is pinned to all four edges of
whatever the host gives it, and everything else floats over it: the graph's
identity and its two fields top-left, the save/publish/run cluster top-right, the
node dock bottom-centre, and the wiring/problems/schedule/run panel on the right
edge. Nothing is in normal flow and nothing scrolls.

**Occlusion is paid for rather than ignored.** A panel over a canvas covers
graph, and the honest version of this layout has to answer for that. `fitView` is
given per-side padding matching the chrome's own insets, so the graph is fitted
into the region nothing covers instead of into the raw viewport — no more nodes
centred underneath the action cluster. The panels are translucent with a blur, so
what is behind them stays legible. The gaps between them are still canvas: the
overlay is `pointer-events: none` except on the panels themselves, so panning and
marquee-selection work through it.

**What is permanent, and what is not.** The add-node dock and the problems are
what somebody mid-draw needs, so both are on screen by default. The description
paragraph is not: it explains the screen to somebody arriving at it and costs
three lines of canvas forever to be read once, so it moved to a tooltip on the
title — and is still rendered to screen readers in full, which is the audience a
tooltip alone would have failed. The details rail can be put away for the room,
and the toggle then carries the problem count and its colour, so the *fact* of a
problem never depends on the panel being open. Running a graph reopens it, since
the run's answer is written there.

The rail's own contents were reordered while it moved. Problems and outstanding
work now come first, the wiring after them, the schedule and connector panels
last. On a stored graph those last two are tall enough that Problems — the one
thing that should never need scrolling to — was below the fold.

**Small viewports.** The rail starts closed under 1024px and the minimap is
hidden there, so the canvas keeps the whole window instead of a floating layout
burying it; under 768px the dock drops its labels to icons, which keeps all six
kinds reachable without a sideways scroll. Verified in a browser at 1600×1000,
1180×820, 820×900 and 560×760: no horizontal overflow, every node clear of the
chrome, and the graph on screen at each.

**Keyboard order was the thing most at risk and is now better than it was.** The
chrome is ahead of the canvas in the DOM, so Tab reaches the workflow controls,
the actions and the dock before the graph's nodes — rather than after every box
and handle on a large canvas. The dock is deliberately ahead of the rail for the
same reason: the rail grows a stop for every wire, problem and sink, and the
add-node buttons are what somebody is tabbing towards. The rail is not modal and
traps nothing, and Escape is left alone, because on this screen it already means
"put the half-drawn wire away".

Nothing about the graph model, the wiring state machine, the edge delete control,
the inspectors or the live regions changed.

Also in here, because it lives in the row this rewrote: **a `filter` node can be
added from the canvas.** The kind shipped complete — model, validator, executor,
inspector, its own colour — and had no way in except the API, because the row
that offers the kinds was five hand-written buttons and there are six kinds. The
row now maps `WORKFLOW_NODE_KINDS` through a `Record<WorkflowNodeKind, …>`, so a
new kind fails to compile until somebody says how it is offered. The accessible
names are generated with it, which is how "Add a if node" appeared and was fixed.

One incidental fix: the two context values handed to every node and every edge
were fresh object literals on each render of the screen, so any state change here
re-rendered every box and every wire. They are memoised, which matters more now
that opening a panel is a state change on this component.
