---
"@dudousxd/nestjs-catalog-react": minor
---

Undo by action, Reset to the last save, and a canvas that will not lose your work silently

**Closing the tab on an unsaved graph lost it, with no warning.** There was no
`beforeunload` handler anywhere in this package: a stray ⌘W, a middle-click on a
link, a refresh out of habit, and an afternoon of wiring was gone. That is data
loss rather than a missing nicety, and it is the part of this change that would
have shipped on its own.

There was also no undo of any kind, and the only trace of unsaved work anywhere
on screen was the word on the Save button changing from "Saved" to "Save" — thin
for something that means "this is only in your browser".

Four things, and they are one subject.

**Undo steps back by ACTION, not by change.** The unit is the gesture, not the
state update. Dragging a node across the canvas is one action however many
hundred position changes React Flow emitted on the way — the drag's own
`dragging` flag is what holds the run open, so a slow drag with a pause in the
middle is still one step back. Adding a node and auto-wiring it is one action,
because it is one gesture that happens to produce two graph changes; undoing them
separately would leave a node nobody asked for standing on its own. Typing into a
field folds into one action per field: consecutive edits to the same node share
an entry only while they touch the same fields, so typing a name and then
flipping a switch on the same node a second later stays two steps — otherwise
undoing the switch would silently retype the name. Everything else — connect,
disconnect, delete, branch, tidy, add — is one entry each, and a delete is never
folded into anything, because it is the change people most want back.

**The stack holds 50 actions and drops the oldest at the limit,** rather than
refusing at the top. What that costs is the ability to walk all the way back to
the beginning of a long session, which is what Reset is for; the tooltip says
"up to the last 50" rather than implying an infinite one.

**There is no redo, deliberately.** Undo only steps backwards. A redo stack has
to be invalidated correctly on every new edit, every save and every graph swap,
and a stale one is a control that puts back something that no longer fits the
graph. The two things people actually reach for — take back the last mistake, or
give up on everything since the last save — are both covered without one.
Shift+⌘Z is caught rather than ignored, and says which control does the job
instead, because silence reads as a broken shortcut.

**Reset means the last SAVED version, and says so.** Not "undo until the stack is
empty": the baseline moves to each save, so after saving halfway through a
session Reset returns to that save, while undoing forty times would walk straight
past it to the version the tab was opened on. It is destructive of unsaved work,
so it is confirmed exactly as deleting the workflow is, and the confirmation
counts what is about to go ("3 actions will be thrown away") and states what it
does not touch: no run is stopped, nothing is unpublished, the stored workflow
stays as it is.

**Unsaved work is now visible as a state rather than a word on a button.** An
amber dot and "Unsaved" sit directly to the left of Save, as an `<output>`, so it
is announced once when work becomes unsaved rather than only found by somebody
who goes looking. The dot pulses, and does not under `prefers-reduced-motion`.

**Leaving with unsaved work is warned about — and only then.** The `beforeunload`
listener is registered while the draft is dirty and removed the moment it is not,
because a page that always warns is a page whose warning people learn to dismiss
without reading. Undoing back to the loaded graph makes the draft genuinely
clean, not merely "edited back", so the warning goes away with it.

**Where undo stops, stated on screen.** Undo touches the drawing and nothing the
server has already done — saving, publishing, running and deleting the workflow
are not undone here. That sentence is in the tooltip and in the accessible tree
next to the controls, not only in a comment, because a boundary somebody has to
read the source to learn is not one they will learn.

**Keyboard and screen reader.** Ctrl/⌘Z undoes, bound on the window so it works
without the canvas happening to be focused — and it does not fire while somebody
is typing. The canvas has a name field, several config fields and a real
contenteditable code editor on it, and in all of them ⌘Z means "undo my typing";
the binding declines any input, textarea, select, contenteditable, `role=textbox`
or anything inside a dialog or sheet. Every undo and every reset is announced
through the canvas's existing live region, naming what it took back — undo
routinely reverts something scrolled off screen, and a silent revert of an
invisible thing is indistinguishable from a dead button. The Undo button's
accessible name carries the same thing ("Undo: adding a sink node").

Verified in a real headless Chrome as well as in jsdom: a 20-step pointer drag
moved a node and one ⌘Z put it back in a single step; ⌘Z inside the inspector's
name field did nothing to the graph; the browser's own leave dialog appeared on a
navigation away with unsaved work, and cancelling it kept the page and the edits.

The history lives in a new `workflow/history.tsx` beside the canvas rather than
inside it — the canvas's `edit()` now takes a labelled action alongside the
change, and that label is what an undo announces.
