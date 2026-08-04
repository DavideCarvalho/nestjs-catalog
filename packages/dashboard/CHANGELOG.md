# @dudousxd/nestjs-catalog-dashboard

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
