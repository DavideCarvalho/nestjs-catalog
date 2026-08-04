# @dudousxd/nestjs-catalog

## 0.6.0

### Minor Changes

- f3cc527: Every catalog route says what it needs, and deleting a shared thing is recorded

  **Read this before upgrading if your guard enforces `REQUIRED_SCOPES`.** Routes
  that admitted any authenticated caller now refuse principals that do not hold the
  scope named below. That is the point of the change, and it will produce 403s on
  the day you deploy it.

  ## The declarations

  Only the three `embed` routes carried `@RequireScopes`. Everything else on the
  catalog controller declared nothing — which, per `catalog.route-auth.ts`'s own
  model, is not "undecided" but "authenticated is enough". So arbitrary SQL, both
  curation `PATCH`es, the overlay reset and every workspace write were open to any
  principal a host's guard let past the door, while `packages/pipeline` had
  declared its scopes on all 20 of its routes since it shipped.

  | Routes                                                                                                                                                                   | Scope                       |
  | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- |
  | `GET /`, `graph`, `types/:name`, `objects/:name`, `objects/:name/snapshots`, `query/relations`, `workspace/capabilities`, `events`, `events/traces`, `events/traces/:id` | `catalog:read`              |
  | `GET saved-queries`, `saved-queries/:id`, `saved-queries/:id/export.csv`, `POST saved-queries/:id/run`, `GET dashboards`, `dashboards/:id`                               | `catalog:read`              |
  | `PATCH types/:name`, `PATCH types/:name/properties/:property`, `POST reset`                                                                                              | `catalog:curate`            |
  | `DELETE saved-queries/:id`, `POST/PATCH/DELETE dashboards`                                                                                                               | `catalog:curate`            |
  | `POST query`, `POST saved-queries`, `PATCH saved-queries/:id`                                                                                                            | `catalog:admin`             |
  | `GET embed`, `embed/dashboards/:id`, `embed/charts/:id`                                                                                                                  | `catalog:embed` (unchanged) |

  **`POST query` is `catalog:admin`, not `catalog:read`, and that is the one worth
  arguing.** Read-only is not the same as bounded. `catalog:read` is documented as
  "read object metadata and rows" — rows of a catalogued type, through a route that
  names one — whereas an ad-hoc statement is whatever the store's read connection
  can reach. In the shipped MikroORM store that connection is the catalog's own
  schema, so `SELECT * FROM catalog_principal` returns every principal's scopes,
  grants and `keyHash`, the SHA-256 of its static key. Nothing else on this
  controller exposes that, and handing it to a reporting principal is an
  escalation, not a read. `queryRelations` lists only the catalogued types, but it
  is a schema panel for the editor, not a restriction on the statement.

  The two saved-query write routes follow it because they accept a `sql` field:
  `POST saved-queries` plus `POST saved-queries/:id/run` is `POST query` in two
  requests, and gating one without the others would make the strict declaration
  decoration. Running a saved query stayed at `catalog:read` — what is held back is
  _choosing what SQL runs_, not _seeing a result_, and gating execution instead
  would both stop an analyst opening a dashboard and let an unprivileged caller
  plant a statement for a privileged one to run.

  `POST reset` is `catalog:curate` rather than `catalog:admin`: it discards exactly
  what the two `PATCH`es write, and a curator can already blank every label one
  request at a time, so requiring admin would deny nothing while pushing a routine
  console action into the scope that manages principals.

  ### Who breaks, and what to do

  - **A principal with only `catalog:read` that curates.** Renaming a type or a
    property, and resetting the overlay, now need `catalog:curate`. Add it to the
    principals that do the curating — that is what the scope is for.
  - **A principal with only `catalog:read` that uses the SQL editor, or saves and
    edits saved queries.** Now needs `catalog:admin`. If you want analysts writing
    SQL without the rest of admin, the options are: give the catalog's read
    connection a database role that cannot see the `catalog_*` tables, in which
    case `catalog:read` is an honest declaration for your deployment and you can
    say so with `controller: false` and your own route; or grant `catalog:admin`
    deliberately, knowing what it reaches.
  - **A principal with only `catalog:read` that creates or edits dashboards.** Now
    needs `catalog:curate`.
  - **`catalog:admin` holders are unaffected** — it expands to every scope.
  - **Hosts that pass no guard, or a guard that ignores `REQUIRED_SCOPES`, are
    unaffected.** This library declares; it has never enforced.

  One consequence stated rather than left to be found: `shared` rides on the
  dashboard write routes, so `catalog:curate` carries the power to hand a board to
  an outside application. Splitting it would mean a route whose only job is to flip
  a boolean. What makes it accountable is that the act is audited — which is the
  other half of this release.

  ## Deleting a shared thing was silent

  `query.shared` and `dashboard.shared` fired on the toggle but not on the delete
  button, which is how access actually gets revoked. The trail could not answer
  "when did this stop being reachable from outside" except by noticing that
  something had stopped appearing — an inference from an absence, which is the
  exact failure the event was added to remove.

  Deleting a **shared** saved query or dashboard now emits the same event with
  `shared: false` and `deleted: true`. The same event name is the decision here:
  anybody asking that question filters on `query.shared` and reads the last entry,
  so a `query.deleted` beside it would leave that filter reporting `shared: true`
  forever for something nobody can fetch. `deleted` distinguishes "revoked, still
  there" from "gone", and the payload carries the name as it last read, because
  after a deletion there is nothing left to look up.

  Deleting an **unshared** one emits nothing. That is the existing transition rule
  rather than an exception to it: something that was not reachable from outside
  before is not reachable after, so no access changed, and recording it would put
  entries carrying neither a grant nor a revocation on the one channel whose
  entries all carry one. A host that wants every deletion in the trail wants a
  workspace-lifecycle event, which is a different event and is not this one.

  **API change:** `CatalogService.deleteSavedQuery(id)` and `deleteDashboard(id)`
  now take the actor as a second argument, matching `saveQuery` and
  `updateSavedQuery`. Required rather than defaulted — a default would quietly
  attribute revocations to nobody in every caller that was not updated. The
  built-in controller passes the host-resolved principal, falling back to
  `"console"`; a host with its own controller passes whatever it resolves. The
  `CatalogWorkspaceStore` interface is unchanged: the store takes no actor, because
  a store that emitted would emit on every path into it and could not tell a
  revocation from a cascade.

  ## Still true and not fixed here

  `POST reset` discards every curation edit in the catalog and emits nothing, while
  `patchType` and `patchProperty` each emit `type.curated`. The trail can therefore
  say who renamed a column but not who reverted every name at once. It needs an
  event `CATALOG_EVENTS` does not have — `type.curated` requires a `typeName` and a
  reset has no single one — so it is named rather than papered over.

  ## The Access screen's three routes, which were the same hole one file over

  `createAccessController` declared no scope on any of its routes. By the rule
  above — absence means "authenticated is enough" — `GET access/principals`
  handed any authenticated caller the list of every application that can reach the
  catalog, with its scopes, its `writeTypes` and its `classifications`: the map of
  what a stolen credential is worth and which one to take. `POST access/people`
  wrote into the host's directory and accepts `role: 'administrator'`, so it was a
  way to grant yourself the scope it should have been protecting.

  All three are `catalog:admin` now. The console had always hidden this screen
  behind `catalog:admin`, and that check was the only one there was — a hidden tab
  is not an access control, and the three paths answered a direct request.

  The reason it survived a test named _leaves no handler undeclared_ is worth more
  than the fix: the sweep read `createCatalogController` and knew nothing about the
  second factory. A completeness check that knows about some of the controllers is
  not a completeness check; it is a statement that the ones it forgot are fine. It
  reads both now, and a third factory has to be added to it by hand — there is no
  way to enumerate them without booting the module.

- d07687d: Embed a chart or a board in somebody else's application

  The server already served `GET embed`, `embed/charts/:id` and
  `embed/dashboards/:id`, returning rendered rows rather than SQL so a consumer
  never becomes a second implementation of the console. What was missing was
  everything a consumer needs to use it: no client method, no component, no
  documentation, and — it turns out — no enforcement.

  **The `catalog:embed` scope was attached to no route.** It existed as a type, was
  expanded by `catalog:admin`, and was named in two docblocks as the thing that
  gates this API, while `packages/pipeline` had declared its scopes on all 20 of
  its routes since it shipped. Any principal a host's guard let past the door could
  fetch every shared dashboard. All three routes declare it now, discovery
  included: a caller the fetches refuse has no use for the list, and an open
  discovery endpoint is an inventory of what is worth asking for.

  **The embed dropped the card's overrides.** `DashboardCard.title` and
  `.library` exist to override the saved query _on that board_, and the payload
  used the query's own — so the console and the embed drew the same dashboard
  differently, silently. The server now restates the same precedence the React
  side uses (card, then query, then built-in) rather than inventing a second rule.

  **`shared` was undeclared on dashboard writes.** It worked only because the body
  reached the store untouched; under a host's whitelisting `ValidationPipe` it is
  stripped and a dashboard can never become shareable, with no error anywhere.

  `<EmbeddedChart>` and `<EmbeddedDashboard>` render the payload with a toolbar
  that holds only OUTPUT actions — no refresh, no delete, no chart-library picker.
  Those are authoring controls and belong to the console where the board is
  assembled; an embed that could refresh would also bypass whatever caching the
  host put in front of it. `actions` defaults to `'none'`, and a caller's list is
  filtered against the actions that exist rather than trusted, so a host asking for
  one that does not exist gets no control instead of a dead button.

  A chart can be exported as PNG with no dependency — a serialised SVG, a canvas
  and `toBlob` are already in every browser. Two limits are worth knowing: an SVG
  rasterised through a data URI cannot load `@font-face`, so exported text falls
  back to a system face; and the built-in CSS bar chart draws with divs rather than
  an `<svg>`, so it cannot be exported at all and offers no action rather than a
  failing one.

- c0c2b8c: A PDF seam, the read rules said plainly, and an audit trail for sharing

  **PDF is a seam, not a dependency.** A host registers something backed by its own
  document pipeline; where nobody did, no PDF action appears — the rule the chart
  registry already follows. The two client-side candidates cost ~128KB gzipped on
  every consumer for a feature only some want, and the application embedding this
  catalog already generates PDFs server-side. The exporter receives BOTH the PNG
  and the serialised SVG: a host drawing with an image library takes the raster, a
  host with a vector pipeline takes the markup and keeps text selectable at print
  size.

  The registry is subscribable, unlike the chart one, and that difference is
  load-bearing: a PDF pipeline is heavy, so it is usually behind a dynamic import
  that resolves after the console has mounted. Without a subscription the cards
  already on screen would stay actionless forever. The card also watches for a
  late `<svg>`, because recharts inserts one from its own state with no React
  render to prompt a second look.

  **The read rules are a toolkit, and now say so.** `mayRead` and
  `maySeeClassification` have no call site anywhere, and that turns out to be the
  design rather than a hole: this library declares and the host enforces — no
  guard ships, `CatalogPrincipalGuard` does not exist in this repo, and
  `readObjects` takes no principal to enforce with. What was wrong was the prose.
  `CatalogPrincipal.classifications` claimed a column outside the list "is dropped
  from its reads" and `CatalogObjectPage.columns` claimed "non-redacted columns" —
  both describing a mechanism nothing performs. Corrected, with the decision
  written where the next reader will ask. `readableObjectPage(principal, page)` is
  the named helper that applies both, deleting hidden values rather than blanking
  them, since a key present with `null` is itself a disclosure.

  **Sharing leaves a trail.** `SavedQuery.shared`'s docblock claimed marking a
  query shared "shows up in the audit trail as one"; no such event existed, so the
  single act that grants an outside application access to data left no record.
  `query.shared` and `dashboard.shared` now fire — on the transition only, because
  a save that leaves the flag alone is not a sharing event and a trail that logs
  every save teaches people to ignore it. Un-sharing is recorded too and is
  distinguishable. The actor is the resolved principal rather than anything the
  body claimed.

  `PROMOTION_AUDIT_EVENT` was the third instance of the same pattern —
  referenced nowhere, while its docblock explained where the record is written. It
  is fixed in the same release; see the store adapter's entry.

### Patch Changes

- ad6b892: An audit event can finally say which environment it happened in, and a trace can say when its steps happened

  **The recorder injects `CATALOG_WORKSPACE_STORE` instead of `MySqlWorkspaceStore`.**
  This is the release-visible one. `environment.routing.ts` explained at length that
  handing `CatalogAuditRecorder` the routing store is what makes "every audit event
  records its environment" true by construction — but the recorder asked for
  `MySqlWorkspaceStore` _by class_, and `RoutingWorkspaceStore` implements the
  interface rather than extending the class, so no host could ever substitute it.
  In a multi-environment process every audit row landed in whichever single
  database the recorder happened to be constructed against, under no environment
  column: a dev event sitting in the production audit table, reading exactly like a
  production one. Every sibling in the package already injected by token; the
  recorder was the only one that did not.

  The single-environment default is unchanged — `CatalogMikroOrmStoreModule` already
  binds that token to `MySqlWorkspaceStore`. A host that constructs the recorder
  itself and provides only the concrete class must now bind the token too.

  **`stampEnvironment` has a call site.** It shipped with a paragraph about
  answering "everything this person did this week" across environments and was
  referenced by nothing. `RoutingWorkspaceStore.listEvents` now stamps what it read
  and widens its return type to say so. It happens there and cannot happen anywhere
  else: that reader is the only one that resolved an environment in order to choose
  the connection, which is the whole reason the value is stamped on read rather
  than stored in a column a row could lie in.

  **`CLOCK_RESOLUTION_MS` was stale by three orders of magnitude.** The audit
  column was widened to `datetime(3)` and this constant went on saying `1_000`, so
  `coarse` was set for every trace that finished inside a second — which is most of
  them. The explorer answered with a dashed track and "there is no internal timing
  to draw" over spans whose real spacing was sitting in the rows, on exactly the
  loads a waterfall exists for. Rows written before the widening are still whole
  seconds and still come back `coarse`, which is the truth about them.

  **And three docblocks corrected rather than built.** `TransformRow` claimed a row
  per version; there is one row, overwritten in place, and `saveTransform` bumps a
  counter on it — real versioning is a schema change with its own retention
  question, and the console rendering `code v3` was already inviting operators to
  believe a bad load's source was recoverable. `CatalogPromotionPlan.fingerprint`
  claimed an apply endpoint that recomputes and refuses; there is none in this
  repository, and the check belongs to the host, phrased the way `applyPromotion`
  already phrases it. `CatalogEnvironment.protected` claimed the API demands
  confirmation; nothing server-side reads it and the only reader paints a badge, so
  it is now documented as advisory until a host enforces it.

## 0.5.0

### Minor Changes

- 38dd467: Choose the chart library while assembling the board, not only when saving

  Which library draws a chart — the built-in, shadcn/recharts, bklit — could only
  be decided on the saved query, which is to say at save time. But the question
  you are actually answering while arranging a dashboard is how this card should
  look _beside the other cards on this board_, and the saved query cannot answer
  that: it is used by other boards too, and editing it to fix one of them changes
  all of them.

  So `DashboardCard` gains a `library`, with the same semantics its `title`
  already had — an override for this card, on this board. The card toolbar gets a
  picker beside the width control, and the default option names what the query
  chose so it is clear what "follows query" means before you change it.

  The picker is built from `registeredChartLibraries()`, so it offers only what
  the host actually installed. An option for a library nobody registered would be
  an option that silently degrades to the built-in: the control would say one
  thing and the card draw another.

  The precedence — card, then query, then built-in — now lives in one named
  function, `visualizationFor`, rather than in two lines inside a component that
  needs a query client and a transport to render. A test that mirrors those lines
  drifts from them silently; this one calls the same function the board does.

  Going back to "follows query" REMOVES the key rather than setting it to
  undefined. The two behave identically at the lookup, but a card is stored as
  JSON, and "the key is there and empty" is a different statement from "nobody
  chose" the moment anything else reads it.

## 0.4.1

### Patch Changes

- 0fe6d6f: Clear the lint backlog — 63 warnings to 0, mostly by extraction

  Behaviour is unchanged throughout; what moved is where the code lives.

  **Two `any`s in `sources.ts`** became interfaces declaring only the methods this
  package calls, with rows staying `unknown[]` because that is the boundary where
  the type genuinely is unknown. No assertions were added.

  **Two functions were doing several separable jobs.** `planPromotion` (61) split
  into a section per kind, and `validateWorkflow` (75) into the checks its own
  comments already named. `workflowRunOrder` now reuses `buildAdjacency` rather
  than rebuilding its own indegree map — its docstring already argued that "two
  implementations of one rule is how a graph that validated comes out executing
  differently", and it was doing exactly that.

  **The vendored chart files are handled by config, not by comments.** 79 files
  under `charts/bklit/` carry a header promising "nothing else is modified, so
  re-syncing with upstream stays a diff rather than a merge". A scoped `overrides`
  entry keeps that promise, and it made nine pre-existing suppressions redundant —
  so those files now have FEWER local edits than before, not more.

  **Three suppressions survive, each with the reason written beside it:**

  - A telescope event renderer whose docblock asserts every branch emits only
    names, never data. That is a security property auditable in one screen
    precisely because the branches are adjacent; splitting them into four
    functions would spread it where it can no longer be read at once.
  - `SelectField`'s `<label>`: `Select` renders a BUTTON, and a label does not
    implicitly name a button — which is why `Select` already required an
    accessible name of its own. `ariaLabel` now defaults to `label` so the common
    case cannot forget it, while still allowing the fuller name the call sites
    deliberately use ("Kind" on screen, "Connection kind" announced).
  - `Switch`'s `<label>`, which DOES resolve — Base UI renders a hidden native
    input inside the root, so the implicit association works and the rule simply
    cannot see through the component boundary. A new spec asks for the control by
    its accessible name, so the suppression's claim is checked rather than
    asserted.

  **`planPromotion` had no test at all**, which is a poor place for the largest
  refactor in the batch: it decides what moves between environments, and a wrong
  plan promotes something that should have been withheld or withholds something an
  operator is waiting on, neither of which throws. It now has 37, mutation-checked
  — including the cross-section exception where connectors are planned last and
  handed what the earlier sections produced, so a connector whose transform is
  arriving in the same promotion is accepted rather than blocked.

  The two deliberate NUL bytes — a sentinel in `stable()` and a separator in the
  query cache key — are now written as escapes rather than raw bytes. Same value;
  git stops calling those files binary and `grep` stops silently finding nothing
  in them.

## 0.4.0

### Minor Changes

- aa14420: Curated descriptions are rich text, stored as markdown

  The two fields an operator writes prose into — a type's description and a
  property's — are TipTap editors now, with bold, italic, inline code and lists.
  `RichTextField` and `RichTextView` are exported for hosts that render the same
  text elsewhere.

  **They store markdown, and that choice is about everyone who is not this
  editor.** `description` is served raw in the `/catalog` snapshot to whatever a
  host built on top of it, and those consumers were written against plain text.
  Markdown degrades into something a person can still read — `**bold**` — while
  HTML degrades into `<strong>bold</strong>`, which is noise, and creates an XSS
  surface in every consumer that decides to render it after all. One of those
  failures is cosmetic and the other is a vulnerability.

  So this is a contract change with no migration and nothing to update: plain text
  is valid markdown, so every description written before, and every one declared
  by a decorator, is unchanged and renders as itself. The type's docblock says so.

  Three decisions worth keeping:

  - **The read view is the same editor with `editable: false`**, not a second
    markdown renderer. Two parsers for one format is two answers to "what does
    this text mean", and they diverge on exactly the inputs nobody tests.
  - **Nothing is saved when nothing changed.** Opening a field and closing it is
    not an edit; saving anyway writes an overlay row that shadows the declared
    description with an identical string and puts a change in the audit trail that
    nobody made.
  - **Plain Enter belongs to the editor**, and Cmd/Ctrl+Enter commits. Stealing
    Enter is right for a one-line field and would make a multi-paragraph
    description impossible to write.

  Headings, images and horizontal rules are configured off: these render in a
  table cell, and an `<h1>` in a 20%-wide column is a line of enormous text that
  would be there purely because the library offers it.

  `@tiptap/react`, `@tiptap/core`, `@tiptap/starter-kit`, `@tiptap/pm` and
  `tiptap-markdown` join the peer dependencies. A host that mounts only the NestJS
  module never pulls them in.

## 0.3.1

### Patch Changes

- 6da500a: Export the types `CatalogDirectory` is written in

  `CATALOG_DIRECTORY` and `CatalogDirectory` shipped without
  `CatalogDirectoryQuery` or `CatalogPeoplePage` — the argument and the return of
  the one method a host is expected to implement. Implementing the seam meant
  restating both by hand.

  The barrel now re-exports the module wholesale rather than naming members, since
  the failure was a list that fell behind the file it was listing.

## 0.3.0

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

## 0.2.1

### Patch Changes

- 64ad4f0: Stop naming one consumer in a public library

  The pipeline package was extracted from an application's copy of the engine, and the extraction
  carried that application's name into comments, a docblock, a seams table — and into a **runtime error
  message**, which shipped advice about one host's durable module to every consumer that hit it.

  Nothing was wrong with the _reasoning_ in those places; only with whose name it was told through. It
  now describes the situation rather than the application: "a host with separate API and worker
  processes", "a multi-environment host", "either this host mounts no durable engine, or its durable
  module failed to bind".

  `catalog.principal.ts` had the same slip in an older comment, so that goes too.

## 0.2.0

### Minor Changes

- 6f739d9: Ship the pipeline and publish controllers

  The engine moved into this package but its HTTP surface did not, so the 19 routes under
  `<path>/pipeline` and `<path>/publish` stayed hand-written in every host — the same duplication the
  engine had, one level up.

  They are factories, matching `createCatalogController`: the route prefix and the guards come from
  `forRoot`, because a library that hardcodes the auth for routes which can rewrite a catalog's schema
  is deciding something only the host can. Omit `path` and no controllers are mounted at all, which is
  what a worker-only host wants.

  `@dudousxd/nestjs-catalog` now owns the vocabulary those routes declare with — `RequireScopes`,
  `RequireHuman`, and the two metadata keys behind them. It already owned `CatalogScope`,
  `CatalogPrincipal` and `hasScope`, and the alternative is every package that ships routes inventing
  its own key, which would force a host to write one guard per package instead of one guard for the
  catalog. Declaring stays separate from enforcing: the library says what a route needs, the host's
  guard decides who the caller is.
