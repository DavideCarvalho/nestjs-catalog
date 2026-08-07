---
"@dudousxd/nestjs-catalog-react": minor
---

Focus mode: one gesture that gives the canvas the screen

Making the canvas full-bleed fixed the shape of the drawing surface and left its
size. Measured in a browser on the shipped build: at 1600×913 the floating chrome
still covered **20.3%** of the canvas, and at 1280×800 it covered **25.3%**. Most
of that is one panel — the top-left card is ~384×281, and about 240 of those 281
pixels are a picker, a name field and a paragraph about checkpointing that is
read once and then occupies the corner of the canvas forever.

There is now a **Focus** control in the action cluster, and `F` from anywhere on
the screen. One gesture, because the ask was for room and room is a property of
the whole screen; three independent collapses would be three decisions and six
states to be in. It does three things:

- the workflow card folds to its head — title, name, status badges, commits
  badge — and the picker, the name field and the checkpointing banner go;
- the node dock drops its labels to the icons-only form it **already** takes
  below `md`, rather than a second compact layout that could drift from the
  first;
- the details rail goes away, and comes back to whatever it was before focus
  took it rather than to a default.

Measured on the same build, same graph: chrome coverage **20.3% → 3.3%** at
1600×913 (+21.2% free canvas), and **25.3% → 4.7%** at 1280×800 (+27.7%). The
card itself goes from 281px tall to 41px. `fitView`'s per-side padding moves with
the mode, so the room it buys is room the next fit actually uses.

## What it may not hide, and does not

A mode that hides things is only worth having if it cannot hide the things that
stop a mistake. The action cluster is therefore **untouched**, and that is the
whole safety argument rather than an omission — every such signal on this screen
lives in it or hangs off it:

- **Save** doubles as the unsaved indicator ("Save" vs "Saved"), and it stays.
- **Refusal notes** appear under the button that caused them, and that button
  stays. So does the shrink refusal and its acknowledge control.
- **Problems** are in the rail, which focus takes — so the count and its colour
  ride on the rail's toggle while it is away, as they already did for anyone who
  had closed the rail by hand. Focus is simply the gesture most likely to close
  it now.
- **Publish state** is in the status badges, and the badges are in the half of
  the card that stays.

It is also the smallest of the three groups, so hiding it would have bought the
least canvas for the most risk.

## The refusal

Focus **will not** collapse the card while the graph has no name. Save is
disabled on an empty name and the field that fills it in is inside the card, so
collapsing unconditionally would leave a dead Save button, a tooltip about a
field that is not on screen, and no way to connect the two. The toggle says which
of the two things it is doing — in its accessible name, not only its tooltip —
rather than looking like a button that did nothing.

The refusal lifts on its own once there is a name, and specifically **not** while
the caret is still in the field: the condition holding the card open stops being
true on the first character typed, so without a guard the field would vanish
mid-word.

## Remembered per tab

`sessionStorage`, deliberately not `localStorage`. A mode you have to re-enter
after every reload is a mode nobody uses — the person this is for is drawing a
forty-node graph, and that person reloads. But a preference that hides controls
and is restored silently a week later is somebody opening the console, finding
fewer controls than they remember, and having no way to connect that to a
keypress from last Tuesday. Per-tab is the honest middle: a reload keeps it, a
new tab does not, and nobody inherits a hidden control from a decision they
cannot remember making. A restored mode starts with the rail already away, so it
does not arrive half-applied.

## Keyboard and motion

`F` is a bare letter rather than a chord, because this is a drawing surface and
the hand that would reach for a modifier is on the pointer. It is refused while
anything is being typed into — this screen is covered in text fields — and every
modifier is refused, so `Ctrl+F` and `Cmd+F` still find. The letter is rendered
on the toggle and named in its tooltip, so the shortcut is learnable from the
control it duplicates.

The card body collapses on a tween rather than a spring, which is not only taste:
a spring overshoots, and a height overshooting past zero clips against its own
border. A spring on a height resolved from `auto` also has no analytic end — it
settles on frames, and under jsdom it never settled at all, so `AnimatePresence`
never unmounted the body and focus mode "worked" in a browser while leaving the
picker and the name field in the document forever in a test.
`prefers-reduced-motion` gets the same result with no transition, verified in a
headless browser with the media feature emulated.

The tab order the previous round settled — app nav, card, actions, rail toggle,
dock, rail, canvas — is unchanged; the one new control goes on the end of the
cluster it belongs to. The card body is unmounted rather than hidden, because a
hidden control is still a tab stop.
