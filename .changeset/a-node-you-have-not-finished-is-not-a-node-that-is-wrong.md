---
"@dudousxd/nestjs-catalog-react": patch
---

The workflow canvas told people off for clicking "+", and gave them no way to draw a wire.

## A node reported problems the instant it was created

Clicking **+ Sink** produced, in the same breath:

> Node "Sink" (sink_3b5a…) is not reachable from any source, so it would never run. Wire a source
> into it or delete it — a node on the canvas that silently does nothing is the thing this check
> exists to prevent.
>
> "Sink" does not say which object type it writes, so there would be nothing for the run to commit
> into.

Every word true, every word useless: a node that was just added is unwired and unconfigured **by
construction**. Nobody had had a chance to do either.

Worse, it is expensive. That prose was written for somebody about to save a graph that would
silently do nothing, and firing it at somebody mid-click is exactly how a validator becomes
something people scroll past — which is the failure `workflow/validate.ts` opens by describing.

The canvas now separates **incomplete** from **wrong**. A node the author has not finished is a
to-do; a node the author *thinks* is finished and is not is a problem, and only the second gets the
checks' own language.

- A node added in this editing session goes into a set of unstarted nodes. Checks naming only
  unstarted nodes are presented as outstanding work — a "Still to do" panel in the rail and in the
  inspector, one line per node, each check rewritten as an imperative ("choose the object type it
  commits") rather than repeated as an accusation. The node is not ringed red and does not carry an
  error icon.
- It leaves that set the moment anybody **acts** on it: any field edited, any wire added or removed
  at either end. That is the answer to "a node touched once and abandoned" — acting on a node and
  stopping is precisely the statement "I think this is done", which is the case the long wording
  was written for. Dragging a box is deliberately not an act: it arranges the picture and says
  nothing about whether its author is finished, and no check reads a position.
- The set is component state. It is never saved, never sent, and empty after a reload — a node that
  came back from the server is one somebody saved and walked away from.

**Nothing is suppressed, and that is load-bearing.** `hasBlockingProblem` is still asked about every
check, held back or not, so Save is coloured as refused from the moment the graph would not run —
with a tooltip that names the unfinished nodes instead of pointing at an error list that is empty.
And pressing Save clears the held-back set outright, before the request: a save attempt is the
declaration that the graph is finished, so every check gets its full wording next to whatever the
server answers. A graph that would silently do nothing still cannot be saved unnoticed.

New nodes are also named uniquely — `Sink`, `Sink 2`, `Sink 3` — because `Sink (sink_3b5a…)` above
is what a message falls back to when the name it was given identifies nothing.

## There was no way to connect from a node

The only gesture that made an edge was a drag between two React Flow handles. Perfectly
discoverable to somebody who has used a node editor before, invisible to everybody else — the
canvas read as needing prior knowledge of the library behind it. The keyboard paths (the wiring rail,
the inspector's picker) were the answers for keyboard users and still are, but reaching either means
knowing to open a panel first.

There is now a **Wire** control on the node under the pointer, or on the single selected node, on
React Flow's own `NodeToolbar` so the placement comes from the same measurements the canvas draws
with. Its menu offers:

- **an existing node** to send this one's output to;
- **a new node**, created and wired in one action;
- **disconnect**, for each wire this node already has — removing one otherwise means finding a
  two-pixel line on a canvas.

What it offers is what the graph allows, and it does not know what that is: every option is filtered
by `canConnect`, the same function that refuses the drag, and the "new node" kinds are found by
building a throwaway node of each kind and *asking*. Nothing here restates the rule that a source may
feed a transform or a sink and that nothing follows a sink. Offering an edge that is then rejected
teaches somebody the menu is a guess.

A created node lands one column right of the node that spawned it — which is not a guess either:
`layout` puts a node one column past the deepest thing feeding it, and this node is fed by that node
and nothing else — then drops a row at a time until the spot is free. Under the cursor, on top of
something, and off-screen are each wrong in their own way. The same "New transform" / "New sink"
action is in the inspector too, because the menu is a pointer affordance and cannot be anything else.

## A transform node on a fresh catalog was three dead ends at once

Opening one on a deployment with no transforms gave an error, a promise the screen could not keep,
and a button that answered clicks with silence:

- **"Choose a transform…" over an empty list.** The way out was on another tab and nothing said so.
  It now says the catalog is empty and offers **Write the first transform**, which creates one
  through `saveTransform`, points the node at it and opens its code. Created here rather than by
  opening the editor empty, because the editor reports *that* it saved and not *what* — so the
  canvas would have had no id to put on the node and the person would have come back to the same
  empty picker. Its starter code is the identity, `return records`, in the deployment's own first
  language: the smallest thing that actually runs.
- **"Open the code" was correctly disabled and did not look it.** `opacity-40` reads as faint, not
  as off, so it got clicked. It is no longer rendered until there is code behind it.
- **The vocabulary made two things look like one.** A field called "Transform", inside a sheet
  describing a transform node, asking you to choose a Transform — "the transform node needs another
  transform, it reads a bit strange", and it does. The model is right: a `CatalogTransform` is named,
  reusable code, deliberately shared between connectors and graphs, and a node is a *position* in a
  graph that runs some. The field is now labelled by what it asks for — **Code it runs** — and says
  in one line why the two are separate.

  The node is deliberately **not** renamed. Half its vocabulary — `defaultLabel` and the badge it
  draws itself with — lives in `workflow/`, so renaming here would produce a step called "Step"
  wearing a badge that says TRANSFORM: the same disease with an extra word in it.

The three add buttons also gained accessible names (`Add a sink node`), because heard on its own
"Sink" is a heading, not a control.
