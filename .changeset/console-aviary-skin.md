---
"@dudousxd/nestjs-catalog-dashboard": minor
"@dudousxd/nestjs-catalog-react": minor
---

Wear the Aviary console surface, and stop overflowing on a small screen

**The surface.** `/durable`, `/media` and `/ai-gateway` are one dark product
distinguished by a single accent, and the catalog was a light console sitting
beside them. It now uses the same tokens down to the hex — `--bg: #09090b`,
`--panel`, `--line`, `--text`, `--muted` — and the same Space Grotesk /
JetBrains Mono pair, which `index.html` was already linking and nothing was
applying.

Dark is forced with `class="dark"` rather than left to `prefers-color-scheme`,
because the set would otherwise be inconsistent on any machine set to light.
The screens already carried `dark:` variants throughout, so this is a switch
being thrown rather than a repaint.

**The accent is sky.** Emerald belongs to durable and media, violet to the agent
gateway; a fourth console reusing one makes the chrome stop telling you where
you are. Sky is also not a semantic colour anywhere in the set — the others
spend amber and red on warn and bad — so it can carry "selected" without also
implying a state. The component library's accent classes were renamed
`violet-*` → `sky-*` rather than remapped in the theme, so a reader who greps
for the colour finds the colour.

**The overflow.** Nine tabs plus the brand and two controls need ~1150px. Below
that the strip pushed the whole DOCUMENT sideways — `nav` is `shrink-0` inside a
flex column, so nothing absorbed the excess and the page itself grew a
horizontal scrollbar, taking every screen with it. At 809px it overflowed by
345.

The tabs now scroll in their own container while the brand, the environment
picker and the store badge stay pinned: scrolling a tab strip is ordinary,
having the environment you are editing scroll off screen is not. `min-w-0` is
what makes it work — a flex item defaults to `min-width: auto` and would
otherwise refuse to shrink. The scrollbar itself is hidden because a native
horizontal bar here is as tall as the tabs and sits between them and their
underline; the half-cut tab at the edge is the affordance. Selecting a tab that
is scrolled out of sight now brings it into view, so arriving on `#access`
directly no longer opens the last screen with the strip parked at the first.
