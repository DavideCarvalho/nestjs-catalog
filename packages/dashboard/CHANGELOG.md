# @dudousxd/nestjs-catalog-dashboard

## 0.29.0

## 0.28.0

## 0.27.0

## 0.26.0

## 0.25.1

## 0.25.0

## 0.24.0

## 0.23.0

## 0.22.0

## 0.21.0

## 0.20.0

## 0.19.0

## 0.18.0

### Minor Changes

- adf4cfe: One place to author a pipeline, and no client method that 404s

  The server half of this landed already: a connector stopped being an authored
  object and became what a published workflow runs as. It shipped with five client
  methods pointing at routes that no longer exist, and two screens for one concept.
  This is the other half.

  **`#connectors` and `#workflows` are one screen.** The canvas is where a workflow
  is authored, end to end — draw it, save it, publish it, schedule it, run it, and
  ask a source what its columns are. What is left of the old connectors screen is
  `<PipelineConsole />`, which keeps the two objects a workflow _borrows_ and does
  not author: connections, which are the credential and address boundary somebody
  manages independently of any graph, and transforms, which are code several graphs
  may name. Its title, its tabs and its docblock all say so. The dashboard's tabs
  are `Workflows` and `Connections`, and `#connectors` still resolves — to the
  canvas, because authoring is what that screen was for.

  **Every dead client method is gone rather than quietly broken.**

  - `saveConnector`, `deleteConnector` — removed with the connector form. Authoring
    is `saveWorkflow` plus the new `publishWorkflow`; the fields those took are
    fields of nodes now. `ConnectorInput` went with them.
  - `runConnector` — replaced by `runWorkflow(id, options)`.
  - `discoverConnectorSchema(id)` — replaced by
    `discoverSourceSchema(workflowId, nodeId)`.
  - `connectionConnectors(id)` — replaced by `connectionWorkflows(id)`, which is
    the question actually being asked before somebody deletes a connection.

  New on `CatalogClient`: `publishWorkflow`, `unpublishWorkflow`,
  `scheduleWorkflow`, `connectionWorkflows`, `discoverSourceSchema`, and a second
  argument on `runWorkflow`. `pipelineRoutes()` gains the matching builders and
  loses the four that addressed removed routes — a builder left behind is a path a
  screen can still ask for.

  **Discovery works before publication, which is the whole point of the route.** A
  sink cannot commit into an object type that does not exist, so requiring a
  published graph would require publishing a graph whose target type cannot be
  created until it is. The panel lives on the source node's inspector, it is
  enabled on a draft, and when it cannot run it says so — naming _saving_, never
  publishing, because a reader told to publish first would go and find they cannot.
  `SchemaDiscoveryPanel` moved out of `PipelineConsole` into its own module so both
  entry points can mount it, and is exported.

  **`expectShrink` is reachable, and says what it does where it is used.** It is
  the acknowledgement that lets a deliberately collapsing load past the row-count
  bound, it now exists on exactly one route, and without a way to reach it an
  operator's only recourse is raising `rowCount.maxShrink` in the type's policy —
  which stands the guard down for every future load of that type instead of for one
  snapshot. So it is a control beside Run, it opens a dialog that states that
  trade-off, it will not submit a blank reason, and a refused load grows a
  "Re-run, acknowledging the shrink" button in the refusal itself.

  **Adoption is said out loud.** A connector wrapped into a graph at boot is
  published as `ready` without a person declaring it finished. An `adopted` badge
  and a note on the canvas say where the graph came from and that "ready" here
  means "it validated", not "somebody looked at it" — matched on `createdBy`, so a
  connector that carried its own description is covered too.

  Also: a `Runs as` panel showing the connector id the run history and watermark
  are keyed on (and never its config — the server redacts, so the screen does not
  render it at all); a `Schedule` panel that prints the server's warning when a
  stored cron will never fire; `ConfirmDialog` gains `confirmDisabled`; the delete
  dialog now says the connector and its history go too.

  Nothing here changes what the canvas says about an unfinished node: a freshly
  added node still reports its checks as work rather than as failure, and a graph
  that would never run still cannot be saved quietly.

## 0.17.0

### Minor Changes

- 220918f: Only the four grammars this console renders

  **The defect.** The changeset beside this one swapped a hand-rolled editor for
  `@pierre/diffs`, which resolves a language by looking its name up in Shiki's
  `bundledLanguages` — ~240 entries whose values are
  `() => import('@shikijs/langs/<name>')` — and a theme the same way through
  `@pierre/theming`. A bundler cannot tree-shake a dynamic import selected by a
  runtime key, so it emits a chunk for every entry. `packages/dashboard`'s SPA came
  out as **319 JS chunks, 12.42 MB minified**, of which 242 were grammars (7.47 MB)
  and 75 were themes (1.58 MB), for a console that renders SQL, JSON, TSX and
  Python in two palettes. This library's contract is that embedding it must not
  degrade the host, so that is a defect and not a tradeoff.

  **The measurement, and what it does not say.** Built twice from the same tree,
  with and without the fix:

  | `packages/dashboard/dist/spa` | before                        | after                |
  | ----------------------------- | ----------------------------- | -------------------- |
  | entry chunk                   | 2836.1 KB min / 867.1 KB gzip | 2826.5 KB / 861.8 KB |
  | JS chunks                     | 319                           | 8                    |
  | total                         | 12.42 MB min / 2.62 MB gzip   | 3.67 MB / 1.10 MB    |
  | on disk                       | 12.50 MB                      | 3.75 MB              |

  **The entry barely moves, and that is the honest headline.** Every one of those
  grammar chunks was already lazy — none of them was on the first-paint path — so
  this buys nothing at all for time-to-interactive. What it buys is 8.75 MB and 311
  files that a host no longer builds, uploads, caches or pays for at the CDN, and a
  `dist/` whose contents can be accounted for. Installed size is unchanged: the
  grammars are still in `node_modules`, they are simply no longer bundled.

  **How.** A new build plugin, on its own subpath so it never reaches a browser
  graph:

  ```ts
  import { shikiSubset } from "@dudousxd/nestjs-catalog-react/bundler";

  export default defineConfig({ plugins: [react(), shikiSubset()] });
  ```

  It rewrites every `import('@shikijs/langs/…')`, `import('@shikijs/themes/…')` and
  `import('@pierre/theme/…')` outside the subset into a loader that rejects naming
  the grammar it wanted. There is then no `import()` for Rollup to split on, so
  there is no chunk — where resolving those specifiers to a stub module would have
  left ~320 chunks, only tiny ones.

  **It cannot quietly stop working**, which is the part that matters more than the
  megabytes. Four independent gates:

  - `CodeEditor`'s `language` prop and `DiffBody`'s are now `CatalogCodeLanguage`,
    derived from the set. A grammar the bundle does not carry is a compile error at
    the call site. **This is breaking in the 0.x sense** — the prop was `string`.
  - `TRANSFORM_HIGHLIGHTED_AS` says what each transform language is highlighted as
    and `satisfies Record<TransformLanguage, CatalogCodeLanguage>`, so a fourth
    entry in `TRANSFORM_LANGUAGES` is a compile error until somebody answers for
    it. It replaces `language === 'python' ? 'python' : 'tsx'` in
    `TransformEditor`, which answered a fourth language silently and wrongly.
  - `shikiSubset()` fails the **build** if any kept name is missing from the
    registry it prunes, or if a registry never reaches it at all — so a Shiki
    rename, a typo, or a generated shape this no longer matches stops the build
    instead of silently pruning nothing.
  - A spec scans this package's sources for `language="…"` and `lang: '…'` literals
    and fails on one the bundle does not carry, which is the only gate that sees a
    `lang` handed straight to `@pierre/diffs` past our own prop types.

  **New exports.** `shikiSubset` and `ShikiSubsetPlugin` from
  `@dudousxd/nestjs-catalog-react/bundler`; `CATALOG_CODE_LANGUAGES`,
  `CATALOG_CODE_THEMES`, `CatalogCodeLanguage`, `CatalogCodeTheme` and
  `TRANSFORM_HIGHLIGHTED_AS` from the main entry.

  **The set, and why it is that set.** `sql` (the query console and a saved query's
  diff), `json` (the transform editor's sample pane), `python` and `tsx` (its code
  pane). TSX covers both JavaScript and TypeScript transforms because it is a
  superset of each; shipping those two grammars beside it would be another 366 KB
  of `@shikijs/langs` for output no reader could tell apart. The themes are `pierre-light` and
  `pierre-dark`, which is what `@pierre/diffs`' `DEFAULT_THEMES` resolves to and
  what this package never overrides — Shiki's own 65 and Pierre's other eight are
  reachable only by naming one, which nothing here does.

  **Still there:** the 622 KB `shiki/wasm` chunk. `@pierre/diffs` defaults to the
  JavaScript regex engine and only fetches the WASM one if a caller asks for
  `preferredHighlighter: 'shiki-wasm'`, so it is emitted and never loaded — but it
  is a capability a caller can legitimately want, and pruning it would take that
  away rather than take away waste.

## 0.16.0

## 0.15.0

## 0.14.0

## 0.13.0

### Minor Changes

- cb486cf: The query and dashboard screens open what the URL names

  Last release mounted the search box and said plainly that two of its four kinds
  of link were half-honest: `#query?savedQuery=…` and `#dashboards?dashboard=…`
  landed on the right **screen** and stopped, because `QueryConsole` took only
  `onGenerate` and `maxRows` and `DashboardBoard` took no props at all. The id
  rode in the address bar unread, and somebody who clicked a result for a specific
  dashboard got whichever board the component had picked for itself. That is worse
  than not navigating: nothing on screen says the link failed. It also broke the
  ordinary thing people do with a console, which is send somebody a link.

  **Both screens now read the id, from the same two places `ObjectExplorer` does.**
  `QueryConsole` takes `savedQueryId`, `DashboardBoard` takes `dashboardId`, and
  each falls back to reading its parameter out of the hash — the precedent, and
  the reasoning, `ObjectExplorer` already argued: the host is the one that knows
  where its router keeps parameters, so it passes what it parsed, and the self-read
  is the convenience for a host that does not route. Both props follow the prop
  whenever it changes, not only on the first render, because navigating from one
  saved query to another is how you arrive here a second time.

  **An id naming something that is gone is refused out loud.** A deleted board, a
  saved query somebody else removed. Falling back to the first row is what makes a
  stale link look like a working link showing the wrong thing, so neither screen
  does it any more: the dashboard board says _"That dashboard is not here"_ and
  quotes the id, the query console says the same above an editor it leaves
  untouched, and the address is left naming the dead id — rewriting it would erase
  the only evidence of which link broke. The old fallback survives for the case it
  was right for, which is nobody having named anything: arriving at `#dashboards`
  with no parameter still opens the first board.

  **The address follows what you select, so a link can be copied out of it.** Both
  screens report the selection through `onSavedQueryChange` / `onDashboardChange`
  rather than writing the URL themselves — reading a URL is an observation, but
  writing one is an act with effects outside a component's box, and a console
  mounted inside somebody else's page should not find a library appending
  parameters to its address. Omit the callback and nothing writes, which is exactly
  what an existing host gets.

  The shipped console wires both up, and writes with `history.replaceState`. That
  is the whole of the history question: assigning `location.hash` would push an
  entry per selection, so clicking through eleven dashboards would leave eleven
  presses of Back between you and the screen you were on before. Replacing keeps
  the address naming what is on screen — which is all a copyable link needs — and
  costs nothing to leave.

  `SavedQueryPanel` also marks which of its rows is the one currently in the
  editor, so a console that filled the editor from a link says where the SQL came
  from.

  A spec holds **both ends**: it reads the href off the rendered search row and
  follows it, then asserts the named saved query and the named board are what
  appear. The parameter is spelled twice — once where the link is generated and
  once where the screen is handed it — and nothing but that test makes the two
  agree.

## 0.12.0

### Minor Changes

- a742ed7: The console mounts the search box, and the barrel names what it was hiding

  `CatalogSearch` shipped last release and nothing rendered it, so finding
  anything in the console still meant knowing which of nine tabs it lived on —
  which is the experience the box was written to replace.

  **It is a route, not a tenth tab.** `#search` can be bookmarked, sent to
  somebody and reloaded, and it is deliberately absent from the tab list: nine
  tabs plus the brand and the pinned controls already need ~1150px, and below that
  the strip scrolls. A tenth would spend ~90px of that budget, and an
  always-visible input several times more, to buy a destination a keystroke
  reaches faster than a click. The way in is a 28px icon pinned beside the
  environment picker — outside the scrolling strip, so it cannot scroll away —
  and **⌘K / Ctrl-K** from anywhere in the console, which opens the screen with
  the cursor already in the box. **Escape** goes back to the screen you were on,
  not to the console's default, so a search opened mid-task does not cost you your
  place.

  **All three hrefs are passed, and two of them promise less than they look like
  they do.** A kind with no href renders as a plain row rather than a link, so a
  box that crosses four kinds and dead-ends on two would be worse than the tabs it
  replaces. `#objects?type=X` is honest end to end — the object explorer is handed
  that parameter and opens on the type, and it is the same string the model screen
  generates for the same destination. `#query?savedQuery=…` and
  `#dashboards?dashboard=…` land on the right **screen** and no further:
  `QueryConsole` takes no saved-query id and `DashboardBoard` takes no props at
  all, so today both open on their own default and the id rides along unread. The
  row still navigates, and the parameter is already in the address for the day
  either screen learns to read it.

  **Newly exported from `@dudousxd/nestjs-catalog-react`**, all of them reachable
  from something the barrel already exported and from nowhere else:

  - `SchemaDiscoveryBridge`, `ConnectorSchemaDiscovery`, `DiscoveredColumn`,
    `SchemaDrift`, `DiscoveredTypeDraft`, `ColumnChoice` — the whole schema
    discovery seam. `PipelineConsoleProps.schemaDiscovery` is a bridge the **host**
    implements, and the only way to write one with its signature spelled out was
    an indexed access on a component's props, or a deep import into `dist/`.
    `initialChoices` and `proposalFrom` come with them: they are the pure rules
    that decide whether a schema somebody ticked is one the publish route will
    accept, and they are worth nothing outside the panel if rendering the panel is
    the only way to run them.
  - `CatalogPeoplePage` and `PeopleQuery` — the reply and the argument of
    `CatalogClient.listPeople` and `AccessRoutes.people`. Both interfaces were
    exported; neither of the two types their one method takes was. Typing the
    reply as `CatalogPersonSummary[]` instead is the exact mistake that method's
    own docblock warns about — it drops `total`, and a screen that ignores `total`
    under-reports who has access.
  - `DEFAULT_PUBLISH_BASE_PATH` — the third of three defaults, with the other two
    already exported, so `CatalogProviderProps.publishBasePath` documented a
    default a host could not name.
  - `WorkflowProblemLevel`, `WorkflowDraft`, `ValidateOptions` and
    `DurabilityCopy` — the level on an exported problem, the two arguments of
    `validateWorkflow`, and what `describeDurability` answers with.

  A spec now sweeps the five modules the barrel re-exports from and fails when one
  of their names is missing, rather than trusting a hand-maintained list — the
  third time in this repo that a list fell behind the module under it.

## 0.11.0

## 0.10.0

## 0.9.0

### Minor Changes

- d62e481: Sharing can be switched on from the console, and the export link follows the host

  **A dashboard can be shared, which means the embed API is reachable at all.**
  `CatalogClient.saveDashboard`/`updateDashboard` did not name `shared`, so
  `updateDashboard(id, { shared: true })` was a compile error and no screen ever
  sent it. `shared` is the entire access boundary of the embed API, so every
  dashboard a shipped console produced answered `403` from `embedDashboard`, and
  `<EmbeddedDashboard>`'s "Nothing on this dashboard has been shared" was not an
  empty state but the only state the component had. The server anticipated exactly
  this one layer down — `patchDashboard` declares the field so a whitelisting
  `ValidationPipe` cannot strip it — and the client type dropped it again.

  Both writes name it now, and the board carries a control: the state, a sentence
  saying who can reach the board while it holds, and a button naming the
  transition. Not a switch — the server records this crossing as an event, in both
  directions, and a control for an audited act should say where you are before it
  offers to move you.

  **A saved query can be un-shared.** `shared` was settable only when the query was
  first saved, and `updateSavedQuery` — which accepts it — had no call site
  anywhere, so a query shared by mistake could only be un-shared by deleting it.
  The list now marks a shared query without waiting to be hovered, and offers both
  directions.

  **`exportUrl` no longer hardcodes `/api`.** It was the one method on
  `CatalogClient` that bypassed the injected transport, in the component most
  likely to run inside somebody else's page. `CatalogTransport` gained an optional
  `url(path)`, and the export link is built from it like every other request.

  > **Hosts should implement `url` on their transport.** It is optional, so
  > nothing stops compiling — but a transport that does not answer gets the path
  > exactly as written, which is right only where the catalog API is served from
  > the root. If yours prepends a base (an axios `baseURL`, a gateway prefix), add
  > `url: (path) => \`${base}${path}\``or the CSV export will 404. Hosts that were
mounted under`/api` were previously right by accident.

  **`CatalogApiSessionGuard` is a host-appliable primitive, and says so.** It
  documented itself as gating `CatalogApiController`, a class that exists nowhere,
  and was bound to nothing. It cannot be bound here: the catalog's JSON API is
  mounted in the host's own tree and deliberately not proxied through the console.
  The module now provides and exports it, so `app.get(CatalogApiSessionGuard)` —
  how a host puts it in front of a whole API surface — resolves.

  **`dashboardAuth` no longer claims to gate the JSON API.** It gates the SPA
  shell, and only that; the option's own docblock said "BOTH the SPA and the JSON
  API", which left a host that configured `auth` and stopped reading with its rows,
  ad-hoc SQL and connector runs on whatever guarded the API before. The docblock
  now points at the two seams that close it, `readCatalogConsoleSession` and the
  guard above.

  **The CSRF rationale names the flag the code actually sets.** The console's
  transport justified `credentials: 'same-origin'` with a `SameSite=Strict` cookie;
  `serializeSetCookie` has only ever emitted `Lax`. Lax is kept — `Strict` costs
  nothing on the flows this package ships but withholds the cookie from a top-level
  navigation arriving from another site, which is how a console gets linked to —
  and the guarantee is restated accurately: Lax covers cross-site `fetch`, `XHR`
  and form POSTs, and permits a cross-site top-level GET. The one state-changing
  GET that leaves exposed, `GET logout`, is argued once, where the route is.

### Patch Changes

- c02c36f: Every dropdown follows the theme, because none of them is a native select any more

  Six controls were raw `<select>` elements against sixteen using the vendored
  one. A native select draws its option list with the platform's own widget: the
  list stays light on a dark console and no class can reach it. On the dark
  surface the console now wears, they were unreadable.

  They are all `Select` now — the Base UI one this package already vendored — so
  the list is markup that inherits the theme like everything else. Converted: the
  environment picker in the nav, the card's chart-library picker, both governance
  filters, and both visualization pickers in the save panel.

  Two things fell out of the conversion:

  - The options that needed a **second line** can have one. `SelectOption.hint`
    already existed, described as "the reason a native option was not enough", and
    it is exactly what the card picker's default needed to say the query names a
    library nobody installed. A native `<option>` is one line of unstyleable text.
  - The chart-kind picker had a `as 'table'` cast on the raw event value. It is a
    lookup against one exported list now, which the picker also renders from — so
    a kind added to the union appears in the dropdown instead of being silently
    absent from it.

## 0.8.0

## 0.7.2

### Patch Changes

- dbe7928: Stop the tab strip leaking its scroll extent onto the page

  The console still scrolled sideways on a narrow screen — by 189px at 809px wide
  — and the cause was the fix for that same bug.

  Bringing the selected tab into view needs a ref on the tab, and `TabsTab` did
  not forward one, so the strip rendered a zero-size `sr-only` marker inside each
  tab and used that. Tailwind's `sr-only` is `position: absolute`, which escapes
  the strip's `overflow-x` clipping: each marker reported its static position —
  out where its tab sits in the strip's full scroll extent — and the document grew
  to contain them. The page then scrolled by exactly the amount the strip was
  hiding.

  `TabsTab` forwards a ref now and the marker is gone.

  Proven on the running console rather than argued: removing the nine markers took
  `documentElement.scrollWidth` from 998 to 809, and putting them back restored 998. An isolated harness did NOT reproduce it, which is worth saying — the
  evidence for this is the experiment on the real page, not a reduction.

## 0.7.1

### Patch Changes

- 0fe6d6f: Rebuild the console, so a change to the screens actually reaches it

  `@dudousxd/nestjs-catalog-react` is a **devDependency** of this package, which is
  correct — the SPA is built with `vite build` and the component library is
  inlined into `dist/spa`, so it is not a runtime dependency of anyone.

  The consequence was not correct. changesets only bumps dependents, and a
  devDependency is not one, so a release that changed only the screens published a
  new `…-react` and left this package alone — and the console kept serving the SPA
  it was last built with. Everything was green: versions went up, provenance
  attested, and the screens did not change. The last two releases of the component
  library never reached a browser.

  `fixed` in `.changeset/config.json` now groups the two, so they version and
  publish together. The alternative — remembering to add the dashboard to every
  changeset that touches the screens — is the one that just failed.

## 0.7.0

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

## 0.6.0

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

## 0.5.0

### Minor Changes

- e1f99cb: Let the host's API guard read the console's session

  This package serves the console and mints its session, and deliberately does not
  proxy the catalog's API — that surface is `CatalogModule`'s, behind whatever the
  host put in front of it. Which left a gap no host could close on its own.

  The console SPA fetches that API **from a browser**. It carries this package's
  session cookie and no bearer token, so a host whose API guard understands only
  its own tokens answers 401 to every screen while the console shell loads
  perfectly. It reads as a broken API rather than as two auth systems that were
  never introduced to each other, and it is what happens the first time this
  console is embedded in an application rather than run standalone.

  `readCatalogConsoleSession(auth, request)` is the introduction: given the
  `DASHBOARD_AUTH` value and a request, it returns the verified session or null.
  Signature and expiry are checked; `revalidate` is not run, because renewal
  belongs to the guard that owns the cookie's lifetime.

  `ResolvedDashboardAuth` and `DashboardSession` are exported alongside it — a
  host injecting the token needs a name for what comes out.

## 0.4.0

### Minor Changes

- 5d10b69: Actually apply the session guard to the console

  `auth` is documented as the thing that closes an otherwise-open console, every
  docblock describes it that way, and **nothing ever stamped the guard that
  enforces it**. A host that configured `auth` correctly still served the console
  shell and its assets to anyone who could reach the URL — and the absence was not
  visible from anywhere, because the session endpoints worked, the module logged
  itself as initialised, and the only way to notice was to open the URL signed out.

  `CatalogUiSessionGuard` is now applied to `CatalogUiController`, and NOT to
  `CatalogAuthController` — that is where a session is obtained, and gating it on
  already having one locks the door from the inside. The guard is a no-op when
  `auth` is absent, so an intentionally open mount is unaffected: "open" remains
  something a host chose by omitting `auth`, rather than something this module did
  by forgetting.

  Stamped once per process rather than once per mount, because `UseGuards`
  **appends** to a controller's metadata and these controller classes are
  module-level — a second `forRoot` in the same process would otherwise run the
  guard twice per request.

### Patch Changes

- 5d10b69: Style the console again

  The stylesheet scanned `../node_modules/@dudousxd/nestjs-catalog-react/**` for
  class names, which resolves relative to the stylesheet — a `src/node_modules/`
  that does not exist. Tailwind's `@source` does not error on a path that matches
  nothing, so the build succeeded and every class used only inside the React
  component package was dropped: the console rendered with its markup intact and
  almost none of its CSS, which reads as a broken component library rather than a
  missing directory. Fixed to `../../node_modules/…`; the emitted stylesheet goes
  from 31KB to 78KB.

## 0.3.3

### Patch Changes

- ac2005e: One copy of React and react-query, so the console renders

  The console died at first render with `No QueryClient set, use QueryClientProvider to set one` —
  pointing at a provider that is right there in the entry.

  React context is per module instance. The SPA bundled its own `@tanstack/react-query` while
  `@dudousxd/nestjs-catalog-react` resolved a different one, so the provider mounted by the first was
  invisible to the hooks inside the second. Two copies, two contexts, and an error that names neither.

  `resolve.dedupe` for `react`, `react-dom` and `@tanstack/react-query`, plus the dev versions pinned
  to what the component library develops against. The built bundle now carries one copy.

## 0.3.2

### Patch Changes

- eee42df: Ship a README

  It published without one, so its npm page was blank. Leads with the two things a host has to get
  right and which fail confusingly when they are not: excluding the console from a global API prefix
  (otherwise it loads as a blank page with 404s, reading as a broken build rather than a routing
  mistake), and deciding whether it is open — `auth` describes how a session is validated, so a host
  that has not configured it yet has an OPEN console, and `guards` is what makes "unconfigured" mean
  shut.

## 0.3.1

### Patch Changes

- 52714d3: Resolve the auth options instead of passing them through

  `resolveDashboardAuth` derives `modes` from which hooks a host supplied, and every endpoint reads it.
  The module handed over the raw options, so `modes` was undefined and the session endpoint died with
  `Cannot read properties of undefined (reading 'includes')` — a 500 where a 401 belongs, on the one
  call a launcher makes.

  Fixed on both paths, with the async one wrapping the host's factory so it cannot skip the resolution.

## 0.3.0

### Minor Changes

- 62ec716: A `./react` tier, so a host can put this console in its launcher

  Mounting the console was not enough to make it reachable: an application that gathers its consoles on
  one page opens each through a hook the console's own library ships, because minting the session is
  that library's business and a hook cannot be picked by name at render time without breaking the rules
  of hooks. This package had no such hook, so the console could only be reached by typing its URL.

  Three levels, pick one:

  - `openCatalogConsole(...)` — no React, from `./client`
  - `useOpenCatalogConsole(...)` — state for a launcher, you own the markup
  - `<OpenCatalogConsoleButton />` — drop-in, unstyled

  `openCatalogConsoleMutationOptions` wires the same call into TanStack Query without this package
  depending on TanStack. React is an optional peer, so a host that only mounts the NestJS module never
  pulls it in.

## 0.2.4

### Patch Changes

- d19b182: Don't ask for a password the host already checked

  Mounted inside an application, the console showed its own sign-in form and then failed with
  `Cannot GET /api/auth/me`. Two faults behind one symptom.

  The SPA hardcoded `/api` as the API base, ignoring the `apiPath` the mount configures — so every call
  went to the host's own API root instead of the catalog's. And it always rendered its local-password
  gate, which only exists for the standalone deployment; a console embedded in an app that just
  authenticated you has no business asking again, and the credential it wants does not exist.

  The server now tells the SPA both things: where the API is, and whether the host authenticates. When
  it does, the gate is skipped and the host's session cookie carries the request. The injected globals
  are also renamed off `__DURABLE_*`, which they had been carrying since this package was templated
  from the durable console.

## 0.2.3

### Patch Changes

- 4cb250a: `catalogDashboardMountPaths` returns the shape `exclude` actually matches

  Plain strings with a `{*splat}` wildcard, like every other Aviary console helper. The object form it
  returned before is accepted by `setGlobalPrefix`'s type but does not match, and the symptom is a
  quiet one: the console mounts, logs itself as initialised, and answers on `/api/<path>` while 404ing
  at `/<path>`.

## 0.2.2

### Patch Changes

- d05d7f0: Actually mount the console at its configured path

  The controllers carry no path of their own — that is what makes `path` configurable, since a
  decorator argument is fixed at class-definition time — but nothing was supplying the prefix, so they
  inherited the host's global one and answered on `/api`. The console 404'd at its configured path
  while the module reported itself initialised, which is a confusing pair of symptoms to hold at once.

  `RouterModule.register` binds the module to `path`, the way the other Aviary consoles do it.

## 0.2.1

### Patch Changes

- 481b594: `useDashboardAuth` may return `undefined`

  A host whose signing secret is unset has no way to mint a session, and the honest answer is "no auth
  mechanism" — paired with a denying `guards` entry, which is what turns that into a CLOSED console
  rather than an open one. The type forced a return, which would have pushed hosts to invent an auth
  object around an absent secret: a cookie signed with nothing.

  Found while mounting it, which is the only place a signature like this gets tested.

## 0.2.0

### Minor Changes

- 70ec7f0: `guards` and `forRootAsync`, so a host can shut the console

  `auth` alone was not enough to mount this the way the other Aviary consoles are mounted. It describes
  how a session is _validated_, which means a host that has not configured it yet has an **open**
  console — and this one can rewrite a catalog's model and run its connectors.

  `guards` is the answer to that, and it is deliberately separate: a denying guard needs no secret, no
  DI and no session, so a host with nothing configured can still be shut rather than open. It is bound
  at module-definition time, which is also why it cannot come from the async form.

  `forRootAsync` covers the other half: validating a session usually means asking something the host
  owns — a user store, a session service — and `forRoot` cannot reach DI.

## 0.1.0

### Minor Changes

- 3098014: The catalog console

  Every other Aviary library ships one — `nestjs-durable-dashboard`, `nestjs-agent-dashboard`,
  `nestjs-media-dashboard`, `nestjs-telescope-ui` — and the catalog did not, which is why its API had
  no user interface anywhere. The screens already existed in `@dudousxd/nestjs-catalog-react`; what was
  missing was the package that mounts them, serves their assets and guards the way in.

  Nine tabs: Model, Objects, Query, Dashboards, Connectors, Workflows, Lineage, Activity, Access.

  It does **not** proxy the API. The catalog's HTTP surface is already mounted by `CatalogModule` and
  `CatalogPipelineModule`; a second copy behind this console would be a second set of routes to keep
  authorised. `apiPath` only tells the SPA where to call.

  Auth is opt-in, and the console is open without it. That is stated in the option rather than left as
  a default to drift into, because this console can rewrite a catalog's model and run its connectors.

  `catalogDashboardMountPaths()` is the piece a host cannot infer: without it, a host calling
  `setGlobalPrefix('api')` moves the console to `/api/catalog` while the SPA still asks for
  `/catalog/assets/…`, and it loads as a blank page with 404s — which reads as a broken build rather
  than a routing mistake.
