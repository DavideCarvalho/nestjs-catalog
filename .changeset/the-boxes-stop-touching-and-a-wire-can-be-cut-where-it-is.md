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
