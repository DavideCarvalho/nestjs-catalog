---
"@dudousxd/nestjs-catalog": minor
"@dudousxd/nestjs-catalog-store-mikro-orm": minor
"@dudousxd/nestjs-catalog-react": minor
---

Adopted graphs stop drawing their boxes on top of each other, a connection can be cut by clicking
it, and "Save first" now comes with a way to save.

## The nodes were four pixels too close, and the number was derived from nothing

Opening any of the thirteen adopted workflows in the dev deployment drew every box glued to the
next one. Nothing was stacked and nothing was missing, which is why it read as ugly rather than as
broken and survived until somebody opened all thirteen.

`adoptConnector` lays a pre-workflow connector out as a graph, and it placed its columns **220**
apart. A node is **224** wide. So each box overlapped the next by exactly four pixels — and a
connector that had a transform got the three-node shape, which collides twice and pinches the
middle box from both sides.

The interesting part is not that 220 was too small. It is that 220 had no relationship to anything.
The width lived in `packages/react/src/workflow/graph.ts`, where the server could not see it, so
the writer of the layout had nothing to derive from and picked a number that was correct only by
luck. Raising it to 240 would have been the same bug with more slack.

So the geometry moved to core, where both sides already depend on it:

- `WORKFLOW_NODE_WIDTH`, `WORKFLOW_NODE_HEIGHT`, `WORKFLOW_COLUMN_GAP`, `WORKFLOW_ROW_GAP`
- `workflowColumnX(column)` and `workflowRowY(row)`, which every generator of a layout now goes
  through instead of multiplying by a literal

Exported from both the package root and `/client`, because the two things that have to agree are a
store and a browser component.

`WORKFLOW_NODE_WIDTH` is not a description of the node — it is the **source of** the node's width.
`WorkflowNodeBody` sets its own width from the constant rather than from a `w-56` class, so there is
one number and no way to restyle the box without moving the columns with it. The react package's
`NODE_WIDTH` / `NODE_HEIGHT` keep their names on the `/workflow` entry point and are re-exports.

The test is the overlap itself rather than the coordinates: `x[n+1] - x[n] >= WORKFLOW_NODE_WIDTH`,
on both the two-node and the three-node shapes. Pinning `{x: 320}` would pass just as happily on a
node 400 wide.

### Graphs already saved with the old positions

**They do not fix themselves, and nothing repositions them behind anyone's back.** A stored graph
whose nodes are 220 apart has distinct positions, so `layoutIfUnarranged` correctly reads it as
"somebody arranged this" and leaves it alone — which is the right rule, because the alternative is a
canvas that silently rearranges a layout a person deliberately built. Re-adopting will not help
either: adoption is idempotent by design and skips anything that already has a `workflowId`.

Fixing the thirteen that exist means rewriting their positions through `POST workflows`, which takes
the whole graph back. New adoptions are correct from here.

## Clicking a connection offers to remove it

`onDisconnect(edge)` has been wired since the wiring menu landed; what was missing was the gesture.
Every route to it went through something else — a menu hanging off a node, a row in the wiring rail,
or knowing that a selected edge answers to Delete — and the thing people reach for first is the
connection itself, which did nothing.

Edges are now this package's own type (`workflow/edges.tsx`) rather than the built-in `smoothstep`.
Selecting one puts a round × above its midpoint, and pressing it removes that connection.

- **Selection, not hover.** Hover would be slightly quicker with a mouse, unreachable without one,
  and would put a delete button under the pointer of somebody merely tracing where a line goes.
- **The keyboard gets all of it, by two routes.** React Flow makes an edge focusable, and Enter or
  Space selects it — at which point the × is an ordinary `<button>` in the tab order, with an
  accessible name that says which connection it removes *in the words on the canvas*: "Remove the
  connection from Feed to Out", never the node ids. And the wiring rail's Disconnect row is
  untouched, so nobody has to go near the canvas at all. Both halves are held by tests, so neither
  can quietly become the only one.
- The × deselects the edge before removing it, so an id reused later by a rewired pair does not come
  back already carrying a delete button nobody summoned.

## Nodes and edges, generally

Per-kind colour is now three coordinated tokens rather than one accent bar — a tinted header strip,
the icon and the kind word — because four kinds distinguished by four pixels of colour are not
distinguished at the zoom people work at. `transform` moved to violet so it stops reading as a
second `source`. Every token has a `dark:` counterpart.

Nodes lift on hover and ring deeper when selected; handles grow under the pointer; edges thicken
when selected and take a rounder corner. Nodes spring in on mount, and the × springs in and out.
While a run is in progress the edges leaving the node that is *running* flow — the one thing a
picture can say about a run that a list of statuses cannot.

**Nothing is revealed by an animation.** Under `prefers-reduced-motion` the × is mounted by the same
selection and simply arrives without the transition, nodes are simply there, and no edge is marked
`animated` — React Flow's flow animation is a keyframe in its own stylesheet, so declining to set
the flag is the only honest accommodation. Nothing is lost by it: a running node still spins its own
badge and says "Running now.", and the run panel still lists every step. `flowingEdgeIds` is where
that decision lives, as a value rather than a branch in a render, and it is tested in both states.

`@dudousxd/nestjs-catalog-react/workflow` now needs `motion` as well as `@xyflow/react`. Both are
optional peers of the package and both are required by this subpath — a host mounting a node canvas
is already installing a graph library, and one that wants neither wants the root entry point.

## "Discover schema — Save first" now comes with the save

Reported as *"ué mas ta desabilitado não vejo nada"* — it is disabled and I cannot see anything.

The refusal is correct and unchanged: discovery reads the **stored** node, so with unsaved edits it
would describe the source as it was before them. What was wrong is that the sentence lived inside a
side sheet and the Save button lived in the header behind it, so a reader was told to do something
with no way to do it where they were standing.

`SchemaDiscoveryPanel` takes an optional `onSave` and `saving`, and renders a "Save now" button
beside the refusal when there is one — plus a line saying that saving stores a draft and does not
publish, carrying the same care the `!draft.id` reason already takes, because publishing is a
different and much louder thing on this screen.

The other half of that report was worth checking rather than assuming: is `dirty` honest? It is —
`draftFrom` sets `dirty: false` even though it runs `layoutIfUnarranged` on the way in, because a
derived layout re-derives identically next time and there is nothing to save. There are now tests
that opening a workflow and touching nothing leaves discovery offered, including for a graph the
server sent with no positions at all, which is the case a future layout change is most likely to
break.

## The × was painted under a node, and the test that "covered" it could never have said so

Reported as *"Cliquei na linha e não aparece um x em cima pra deletar"* — I clicked the line and no
× appears above it to delete. It was there. It was 38×38, fully opaque, correctly labelled, and
414px to the left and 42px above its own line, directly underneath the first node — so
`elementFromPoint` at its centre returned that node's header, not the button.

The cause is a rule about Motion that is easy to walk into: **an element Motion animates a transform
component of no longer owns its own `transform` property.** The control set
`transform: translate(-50%, -140%) translate(Xpx, Ypx)` in `style` *and* animated `scale`. Motion
composes the whole property from the values it is animating and writes the result every frame, so
the hand-written translate was overwritten — and at rest, with `scale: 1` and nothing else to
compose, what it wrote was `transform: none`. The button landed at the untranslated origin of
`.react-flow__edgelabel-renderer`, which is the top-left corner of the graph.

The placement and the animation are now on two elements: a plain `<div>` carries the translate and
Motion never touches it, and the `motion.div` inside animates opacity and scale about an origin that
is already correct. The outer element stays mounted whether or not the × is offered, because that is
what `AnimatePresence` needs in order to still play the exit.

The more useful part is the test. `workflow-edge-delete.spec.tsx` had five tests over this control
and **all of them passed the whole time it was unreachable** — they asserted that it existed, what it
was called, and what pressing it did. So there is now one that reads the inline transform of the
positioning element after the animated child has mounted, and a comment saying why that property and
not a rect: jsdom lays nothing out, every element in it is 0×0, and a `getBoundingClientRect`
assertion would have agreed with the broken placement just as readily as with the fixed one.

## Wiring is click, click — no drag required

Asked for as *"invés de clicar e arrastar, queremos clicar na pontinha, aí já aparece a linha ta
ligado e aí é só clicar no outro"*. Click a handle, see the line, click the other end.

React Flow's `connectOnClick` was already on, and it already connected — but it draws **nothing**
while the connection is open, because the connection line renders from `connection.inProgress` and
that flag is only ever set by the pointer-drag path, past a 1px threshold a click never crosses. So
the gesture worked and looked exactly like a dead click. It also cannot explain itself: the state it
hands `onClickConnectEnd` after a click carries no target, so an illegal pair and a missed click
were indistinguishable.

So the click path is owned by the new `workflow/wiring.tsx` and `connectOnClick` is off, which keeps
one state rather than two disagreeing about whether a wire is in flight:

- a dashed, travelling line follows the pointer from the handle that was clicked, drawn into
  `ViewportPortal` so it stays registered with the graph while somebody pans or zooms mid-gesture
- either end starts it. Clicking a sink's input first draws the wire backwards until it lands, which
  is the right affordance for somebody thinking "this needs feeding"
- while a wire is open every handle says whether it can take it — green where it can, faded almost
  out where it cannot — which is the same judgement the drag has always shown on the one handle
  under the cursor, shown on all of them at once because a click has no "under the cursor" moment
- **a refusal is a sentence on the canvas**, not silence. A loop, a duplicate, or anything else
  `canConnect` refuses now says so in a panel over the graph, and the wire stays in hand so
  correcting it is one more click rather than a restart
- Escape, the pane, and clicking the same handle twice all put it away

**Dragging is untouched.** It is React Flow's pointer-down path, it still validates through the same
`isValidConnection`, and it still colours the handle under the cursor. This adds a way in; it removes
none. Every rule still comes from `canConnect` — the one the drag, the wiring menu and the
inspector's picker are all refused by — so there is no second copy of "nothing runs after a sink" to
drift.

A handle is now a control, so it says so: `role="button"`, in the tab order, and operable with Enter
or Space. React Flow renders a handle as a plain `<div>`, so none of that is inherited.

## Prettier, where it changes what you can see

The selected connection gets a soft halo behind the line, in the same variable the stroke uses, so
selection reads at the zoom people actually work at instead of being a 1px thickening. The kind rail
down the left of a node is a gradient rather than a flat fill — at 4px wide and full height, flat
reads as a printing error. Nodes lift a little further on hover; the controls and the minimap are
rounded and lifted so they read as panels on the canvas rather than as chrome bolted to it.

`prefers-reduced-motion` remains the fallback and not the ceiling: the travelling dashes hold still,
the pulse on an open handle is `motion-safe:`, and the wiring hint arrives without its spring. In
every case what is left is the colour and the position, which is where the information was.
