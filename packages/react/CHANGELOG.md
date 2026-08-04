# @dudousxd/nestjs-catalog-react

## 0.5.0

### Minor Changes

- 3214fc7: One code editor, themed by the console instead of against it

  The query console and the transform editor each carried their own copy of the
  same overlay editor — a transparent `<textarea>` over a highlighted `<pre>` —
  with the same two boxes, the same three comments, and only one of them taught
  about anything but its own language. They now share `ui/CodeEditor`.

  **It was unreadable.** Both copies passed `themes.github`, a light Prism theme
  that paints keywords a dark red and strings a dark blue. That was invisible for
  as long as the console was light and became dark-on-dark the moment the console
  went dark: the editor still worked perfectly, you just could not read what you
  were typing. The theme is now defined against the same `--text` / `--muted` /
  `--accent` variables the shell sets, so the two cannot drift apart again.

  **The sample-records pane gets highlighting too.** It was the one that stayed a
  bare textarea, so the JSON you debug a transform against rendered flat grey
  beside a coloured transform — and a missing brace in a sample is exactly what
  highlighting finds for you.

  Two smaller things found while extracting it: the theme's `plain` was never
  applied, because `Highlight`'s `style` was not spread onto the `<pre>`; and
  `leading-[1.5]` was being dropped by tailwind-merge, which treats a
  `text-{size}` utility as able to carry a line-height and discards a `leading-*`
  written before it. Both layers agreed, so the caret never drifted — the intended
  line-height simply was not there.

  Still a textarea rather than CodeMirror, and deliberately: the platform's
  textarea already has the caret, selection, undo, IME and every accessibility
  affordance, and a controlled document-model editor has to reimplement all of it
  — the classic symptom being a caret that jumps to the end when the value updates
  from outside. What is missing is autocomplete and bracket matching, which
  nothing here asks for.

- 93ed05b: Every table on TanStack Table v9

  Four screens hand-rolled `<table>` markup with the same header row, the same
  hairlines and the same "numbers go right" rule, each slightly differently. They
  now share `ui/DataTable`, and there is no raw `<table>` left outside `ui/`.

  **Sorting is a prop, not a row model, and that is the load-bearing decision.**
  The object explorer sorts, pages and searches on the SERVER, because it reads a
  warehouse table that does not fit in a browser. Handing those columns to
  `createSortedRowModel` would sort the rows currently on screen and present the
  result as though it were the whole answer — a worse bug than no sorting at all,
  because it looks right. So the header renders the affordance and reports the
  click, and the caller decides whether that means a refetch or a reorder. A test
  asserts the rows come out in the order they went in.

  What each screen gained:

  - **Query results** and the **dashboard card preview** shared a value-rendering
    ladder that they each had a copy of. `renderUnknown` is now one function, and
    it keeps `0`, `false` and `''` visible — the `value || '—'` shorthand erases
    all three and nothing reports it.
  - **The object explorer** keeps its server-side sort, and `aria-sort` moved onto
    the column header where a screen reader announces it as part of the column;
    on the button it read as "this control is sorted".
  - **The property editor** declares its six columns once, with their widths beside
    their contents rather than in a separate header row kept in the same order by
    hand. The widths stay fixed on purpose: those cells hold inputs, and a
    content-sized column reflows the table on every keystroke.

  `@tanstack/react-table` joins the peer dependencies at `>=9`. v9 is opt-in per
  feature rather than v8's batteries-included table, so a table that never groups
  does not ship the grouping code — this one registers the core features and
  nothing else. Two things about its API worth knowing: the row model factories
  live inside `features` rather than in a sibling option, and `useTable` needs
  explicit type arguments, because `columns` and `data` are two inference sites
  for the same pair and TS falls back to the constraints with a third parameter
  in play.

## 0.4.0

### Minor Changes

- 939b747: A real Tabs in the console nav, a Button component, and arrows when tabs are hidden

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

## 0.3.0

### Minor Changes

- 09f0a4b: Wear the Aviary console surface, and stop overflowing on a small screen

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
  horizontal scrollbar, taking every screen with it. At 809px it overflowed by 345.

  The tabs now scroll in their own container while the brand, the environment
  picker and the store badge stay pinned: scrolling a tab strip is ordinary,
  having the environment you are editing scroll off screen is not. `min-w-0` is
  what makes it work — a flex item defaults to `min-width: auto` and would
  otherwise refuse to shrink. The scrollbar itself is hidden because a native
  horizontal bar here is as tall as the tabs and sits between them and their
  underline; the half-cut tab at the edge is the affordance. Selecting a tab that
  is scrolled out of sight now brings it into view, so arriving on `#access`
  directly no longer opens the last screen with the strip parked at the first.

## 0.2.0

### Minor Changes

- 5d10b69: Serve the Access screen, through a directory the host can own — and page it.

  `GET /access/principals`, `GET /access/people` and `POST /access/people` had no
  server implementation at all. The React screens called endpoints nothing
  answered, so the whole screen read as a broken build.

  They are now served from `CATALOG_DIRECTORY`, split along who actually owns the
  answer. Applications come from `catalog_principal` and are shipped:
  `CatalogMikroOrmStoreModule` binds `MikroOrmCatalogDirectory` and hosts get that
  half for free. People are the host's — `listPeople` and `upsertPerson` are
  optional, and a directory implementing neither is a complete implementation
  rather than a half-finished one, because a catalog embedded in an application is
  embedded in one that already has a user store. Standing up a second one beside
  it is how you get two lists of employees that disagree about who was offboarded.

  An unimplemented half answers **501 naming the seam** instead of returning an
  empty list, so an operator can tell "not wired" from "nobody is there".

  **`listPeople` is paged, and the bound is not advisory.** The host's user table
  is its whole directory, so `GET /access/people` takes `search`/`limit`/`offset`,
  caps the limit at 500 whatever is asked for, and hands the query DOWN to the
  directory so it reaches the database rather than slicing a list that was already
  materialised. The response is a page carrying `total`, and the screen renders
  "Showing 1–50 of 1,340" plus a search box — a bounded list that cannot report
  what it is bounding is indistinguishable from a complete one, and an operator
  reading it as complete concludes somebody has no access when they were merely on
  the next page.

  Bind your own directory with the new `directory` option on
  `CatalogModule.forRoot` — via the option rather than only exporting the token
  from an imported module, since a provider declared inside the module shadows one
  exported by its imports. Routes mount at the new `accessPath`, a sibling of
  `path` by default.

### Patch Changes

- 5d10b69: Say `duplicate-sink-type` once

  The workflow canvas raised its own copy of the complaint alongside the one core
  validation already produced, so the same problem appeared twice in two different
  wordings — which reads as two problems, and sends someone looking for a second
  one that is not there.
