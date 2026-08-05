# @dudousxd/nestjs-catalog-react

## 0.14.0

### Minor Changes

- 0995daa: The connection form asks for a connection string, and can test it before saving

  Three changes to one screen's worth of friction.

  **One field, not two.** The SQL address block offered an inline URL and the name
  of an environment variable holding one, side by side, with a paragraph
  explaining when each applied — and only one of them worked for a database with a
  password, which is every database anybody connects to. It asks for the
  connection string now.

  **`allowInlineCredentials` on the store, default false.** A connection URL is
  the credential, and `config` is served under `catalog:read`, so a password
  inside one is refused. That refusal is what makes the "never the credential"
  promise true rather than aspirational, and it stays the default. A deployment
  that would rather type a connection string than provision an environment
  variable can turn it off — and what does NOT change is the redaction: the
  password never travels in a response either way. The flag decides only whether
  it may rest in the catalog's own table.

  **`POST pipeline/connections/check`** reaches a connection that has not been
  saved. The field most likely to be wrong is the address, and finding out used to
  mean saving a row, testing it from its card, and deleting it.

  It asks `catalog:write`, not the `catalog:read` its by-id sibling asks for, and
  the difference is the whole point: checking a saved connection reaches an
  address somebody already chose and wrote down; checking a posted one reaches an
  address supplied in the request. Under `catalog:read` that is a port scanner for
  anybody who may look at the catalog. Under `catalog:write` it grants no reach
  that did not exist — the same caller could save, check and delete — but that
  route leaves records and this one leaves none, so it logs what it did. The
  address, never the credential.

- ef7d16b: The credential fields leave the console's screens

  The connector editor and the workflow source node each offered a "Credential env
  var" field beside the address. Two doors for one decision, and the question it
  produced was "what is this second field" — a form asking the reader to
  understand its implementation.

  The credential goes in the connection string. Where that string may **rest** is
  the store's decision — `allowInlineCredentials`, and the secret vault behind it
  — not a question for a form, and not one whose answer changes per connection.

  `secretEnvVar` is untouched on the model and `CredentialField` is still
  exported, so a deployment that wants the name-only path can mount it. It is no
  longer the console's default story.

### Patch Changes

- 117e471: The workflow canvas told people off for clicking "+", and gave them no way to draw a wire.

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
  to-do; a node the author _thinks_ is finished and is not is a problem, and only the second gets the
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
  building a throwaway node of each kind and _asking_. Nothing here restates the rule that a source may
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
    opening the editor empty, because the editor reports _that_ it saved and not _what_ — so the
    canvas would have had no id to put on the node and the person would have come back to the same
    empty picker. Its starter code is the identity, `return records`, in the deployment's own first
    language: the smallest thing that actually runs.
  - **"Open the code" was correctly disabled and did not look it.** `opacity-40` reads as faint, not
    as off, so it got clicked. It is no longer rendered until there is code behind it.
  - **The vocabulary made two things look like one.** A field called "Transform", inside a sheet
    describing a transform node, asking you to choose a Transform — "the transform node needs another
    transform, it reads a bit strange", and it does. The model is right: a `CatalogTransform` is named,
    reusable code, deliberately shared between connectors and graphs, and a node is a _position_ in a
    graph that runs some. The field is now labelled by what it asks for — **Code it runs** — and says
    in one line why the two are separate.

    The node is deliberately **not** renamed. Half its vocabulary — `defaultLabel` and the badge it
    draws itself with — lives in `workflow/`, so renaming here would produce a step called "Step"
    wearing a badge that says TRANSFORM: the same disease with an extra word in it.

  The three add buttons also gained accessible names (`Add a sink node`), because heard on its own
  "Sink" is a heading, not a control.

- 7e8d541: The canvas can see what a draft is, and stops promising a refusal that no longer happens

  `WORKFLOW_STATUSES`, `WorkflowStatus` and `isWorkflowStatus` are exported from
  the client entry point, alongside the node kinds and issue codes already there
  and for the same stated reason: an editor that cannot see the vocabulary
  restates it, and the copy is what drifts.

  The Save tooltip said "the server will refuse the graph". That was true before
  drafts and is now wrong in the case it fires most often: saving an unfinished
  graph **succeeds** — it is stored as a draft, which is the whole point. The
  refusal moved to publishing. A hint that still promised one would be
  confidently wrong, which is worse than saying nothing.

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

### Minor Changes

- 64a3b00: One search box across the whole catalog

  Finding anything in a catalog meant already knowing which screen it lived on:
  object types and their properties on Model, saved queries on Query, boards on
  Dashboards. At two hundred types that _is_ the experience, and the thing a
  person actually types is a word they half-remember.

  `GET /catalog/search?q=…` answers across four kinds in one call — object types
  (name, display name, plural, description, group), properties (name, display
  name, description, unit), saved queries (name, description, folder) and
  dashboards (name, description) — ranked as one list. `CatalogClient.search(term)`
  and `<CatalogSearch />` are the client half; the component takes the same
  `explorerHref` prop the model screen does, plus optional `savedQueryHref` and
  `dashboardHref`, and renders a row as a plain row rather than a dead link where
  the host mounted no screen for that kind.

  **The ranking is four named tiers, not a score.** `exact`, `prefix` and `name`
  for a match on what a thing is _called_; `text` for one in what somebody _wrote
  about_ it — a description, a group, a unit. Ties break by kind (type, property,
  saved query, dashboard) and then by label, so the same term always gives the
  same order. Every hit carries the tier and the field it matched, which is what a
  row shows instead of a number nobody can predict.

  **Results are filtered by the caller, which is a deliberate exception to this
  library's read path.** Every other read here applies no grants — the host wraps
  them, see the note above `mayWrite` in `catalog.principal.ts` — and that
  position does not survive a search box: a host can wrap a read whose subject it
  knows, and cannot wrap one whose result set is chosen by a stranger's typing.
  So `GET search` looks at `request.principal`, drops every type `mayRead`
  refuses **and its properties with it**, and drops every property whose
  classification the caller does not hold. The name is the disclosure in both
  cases — "there is a type called `PayrollAdjustment`" and "there is a column
  called `settlementAmount`" are answers, even with no row attached — and `total`
  is counted after the filter so the count cannot report what the rows do not.

  An absent principal filters nothing, and that is not a fail-open: in a
  deployment with no guard `GET /catalog` already hands over the whole snapshot,
  so search is exactly as open as the route beside it and strictly narrower the
  moment a principal appears.

  **What a hit does not carry:** no `sql`, no property list, no card layout —
  enough to draw a row and follow it. The matcher is not given a saved query's
  statement at all, so a search cannot become a code search and a fragment of SQL
  cannot end up in a dropdown.

  **Connectors and transforms are deliberately out.** They are served by
  `@dudousxd/nestjs-catalog-pipeline`, which this package does not depend on, and
  folding them into a route declared `catalog:read` would re-grant a surface
  carrying connection references and `secretEnvVar` under a scope their owner
  never agreed to. A console that wants them in the same box makes a second call
  against the pipeline's own routes, under the pipeline's own guard — which is
  honest about the fact that they are two permissions.

  Nothing is mounted for you: export `CatalogSearch` from
  `@dudousxd/nestjs-catalog-react` and place it wherever your shell wants a search.

## 0.10.0

### Minor Changes

- 5cb78c8: A connector can report the schema of the source it reads

  Pointing this catalog at a table nobody has written an entity for meant writing
  the schema out by hand, column by column, from a database somebody had to open a
  client against. `appendRowsAsSystem` refuses a type the registry does not carry,
  and the only things that create one are a `@CatalogType` entity or a
  `PUT /publish/:type/schema` body — so every table without an entity cost a
  person a session with `information_schema` and a JSON document typed from it.

  `POST pipeline/connectors/:id/discover` closes that from the other end. It runs
  the connector's own configured read, reports the columns, and **creates
  nothing**. For a SQL source the columns come from the driver describing the
  result set of the author's query wrapped in `LIMIT 0`, so a billion-row table
  costs what an empty one costs and no row is read at all; Postgres type oids and
  MySQL column type ids are mapped to catalog scalars, including the two the ids
  alone get wrong (`TINYINT(1)` is how MySQL spells a boolean, and a `TEXT` column
  arrives under a blob type id with a non-binary character set). For `http`,
  `file` and `s3` there is no schema to ask for, so the shape is inferred from a
  bounded sample and the payload says so in as many words.

  **A column it cannot type confidently is reported with no type at all.** Not
  `string`, not `unknown` — `null`, which the console renders as "not typed" and
  refuses to include until a person chooses. An unmapped oid, a sample that
  disagrees with itself, a column that was null in every record sampled: each one
  comes back with the reason. Guessing quietly is the failure that matters here,
  because a wrong type becomes a wrong column in a lake nobody re-checks and the
  load that fills it succeeds every night.

  **Re-running discovery against a type that already exists reports drift** —
  columns the source gained, columns it lost, columns whose type moved. That is
  the part worth having. A first discovery happens once per source; drift happens
  for as long as the connector exists, and all three are silent today: an added
  column is dropped by the store, a removed one loads as null, and a retyped one
  is coerced into whatever the catalog still believes.

  The route is authorised exactly as running the connector is, against a grant on
  its target type. Saving and running both require one, so without that check
  discovery would have been the first route on this surface that let a principal
  with no grants make the server read a source — and the answer is the column
  names of a database it was never allowed near.

  Property names take the source's spelling verbatim. The warehouse store matches
  records to properties as `row[property.name]`, so a `first_name` column tidied
  into a `firstName` property is a column that writes null on every run and
  reports success; the tidying belongs in `displayName`, which is editable at
  runtime and needs no migration.

  In the console, the connector editor grows a "Discover schema" panel behind a
  new optional `schemaDiscovery` prop on `<PipelineConsole />`. `CatalogClient`
  carries neither a discovery call nor any publish call, so the two functions are
  handed in rather than invented; a host that supplies discovery but no way to
  create a type gets the confirmed `PUT` request printed instead of a button that
  cannot work.

- ad0219b: The console can reach schema discovery, and a host can bind load expectations

  Two features shipped in this release were built and unreachable, for the same
  reason in two places: the thing that would call them had no name to call.

  **Schema discovery** returned a report the console could not ask for.
  `CatalogClient` gained `discoverConnectorSchema`, and `pipelineRoutes` the path
  behind it. The panel took a bridge as a prop and nothing supplied one.

  **Creating the type from that report** had nowhere to go at all: this client had
  no publish call, because publishing is the one write that does not go through
  the catalog's own routes — there is deliberately no `POST /catalog/types`, since
  structure follows a publisher and curation follows a person. `publishType` is
  that call, and `CatalogTransport.put` is optional so a transport written before
  this keeps compiling. A client handed one that cannot `PUT` refuses **by name**
  rather than resolving having done nothing: a "Create type" button that returns
  without creating a type is the exact failure the panel exists to prevent.

  `publishBasePath` is its own option, defaulting to `/publish` — a sibling of the
  pipeline's base, not a child, because that is how the library mounts the two.

  **Load expectations** were exported from nothing. `CATALOG_LOAD_EXPECTATIONS` is
  the token a host binds to declare how a type handles deleted rows and how far a
  snapshot may shrink; a token nobody can name is a feature nobody can switch on,
  and the refusals ship on by default. The whole module is exported with
  `export *`, deliberately — a hand-maintained list is how the catalog package's
  barrel came to export an interface without the two types its one method takes.

- baacf22: The ontology has links.

  `CatalogRelationDef` existed and the in-app registry read relations off the ORM, but the persisted
  catalog — the one a real deployment runs — answered `relations: []`, `stats.relations: 0` and
  `edges: []`, hardcoded. So two types could both be published and nothing recorded that one belonged
  to the other. The graph drew nodes and no lines.

  **Persisted.** `ObjectTypeRow` gains a `relations` column and a `mergeRelations()` that takes the
  structure a publisher sends and keeps the labels a curator wrote, the same rule properties already
  follow. A link the publisher stops sending is dropped, unlike a column: a column may still hold data
  in the warehouse, a link holds nothing, and keeping one the schema no longer has means the ontology
  asserts a join that will fail. Nullable, so rows written before this exist and read as no links.

  **Served.** The stored registry reports relations on the type, counts them in `stats` and in the boot
  line, and builds the graph. Nothing is guessed: there are no foreign keys in the warehouse, and a
  `base_id` column beside a type called `Base` is a strong hint and a bad edge.

  **One edge per link.** The graph de-duplicated relations by property name, which only catches the
  accident of both ends being spelled alike — `Mvr.base` with `Base.mvrs` is the ordinary shape of a
  foreign key and it drew two lines between the same pair of nodes. Links are now paired through the
  new `owner` and `inverseName` fields on `CatalogRelationDef`, and the surviving edge is the one that
  holds the key, so the arrow points the way a join is written.

  **A link whose target is not published** is kept on the type and marked with the new
  `targetPublished` — dropping it leaves a type looking less connected than it is — but draws no edge,
  because an edge promises a node the reader can open. `CatalogManager` no longer renders it as a
  button that silently selected an unrelated type.

  **Both directions on screen.** A type carries one row per link it declares, so a `@ManyToOne` left
  the target with an empty list and the catalog screen said nothing linked to or from it. The inbound
  half is now derived from the snapshot the screen already holds — nothing stored, nothing counted
  twice — and a link can be renamed in place through the existing property route. `FlowView` flags the
  links that cross a publisher boundary, or land on a type nobody has loaded.

  No new endpoints and no new decorator. A relation is a property to whoever is looking, so
  `@CatalogProperty` labels one and `PATCH .../properties/:name` curates one, in both registries.

  `CatalogRelationDef` gains four required fields (`owner`, `targetPublished`, `enriched`, and the
  optional `inverseName`). Code that constructs one by hand — chiefly test fixtures — has to fill them
  in; code that only reads relations is unaffected.

- 04f09a3: A type now says when its data was last committed

  A type whose publisher was deleted six months ago and a type loaded ten minutes
  ago produced byte-identical payloads. `CatalogObjectTypeDef` carried a name, a
  table and its properties, and nothing at all about the data — the only
  timestamps in the snapshot were `generatedAt`, which is when the MODEL was
  assembled, and `stats`, which counts types and properties. Every screen
  downstream inherited that blindness, and the failure is somebody reading a
  number off a type in June that stopped being updated in January.

  Nothing deletes a type when its publisher goes away, and that is deliberate: a
  failed deploy, a service that is down and a renamed entity all look like an
  absent publisher, and a lake that dropped data on that evidence is not a lake
  anybody trusts. But keeping the data and keeping quiet about its age are
  different decisions, and only the first was made.

  `lastCommittedAt`, `rowCount` and `lastPrincipalId` are filled from the newest
  COMMITTED snapshot per type — `committedAt`, not `createdAt`, because a load
  that was written and never committed is not what readers are served, and dating
  a type by one reports freshness that does not exist. One query for all types,
  not one per type: this runs on every reload.

  **Absent means never committed**, and that is a third state the old shape could
  not express. A schema published and never loaded is not a pipeline that stopped;
  the fixes differ, and collapsing them is how the second gets ignored.

  `rowCount` is there for a failure the timestamp cannot show: a connector that
  starts returning 12 rows where it returned 40,000 produces data that is wrong
  and _fresh_, so every staleness signal reports it healthy.

  The Model screen shows the age beside the table name, marks what has not
  committed in a week, and puts the count and the publisher in the tooltip. It is
  not a health verdict — the catalog cannot tell a deleted publisher from a
  monthly load, and a type labelled "orphaned" is a type somebody deletes on the
  strength of a guess. `freshnessOf` and `isWorthFlagging` are exported for hosts
  that want the same words elsewhere.

## 0.9.0

### Minor Changes

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

- 3becb3a: Say which library is actually drawing, not which one was asked for

  Found on a real board the moment the card picker shipped: a saved query named
  `visx`, nobody had registered it, and the card drew the built-in bars — correctly
  — while the control read "follows query (visx)".

  The fallback is right and it is silent, so the label has to be the thing that
  says so. It now reads "follows query (visx — not installed, drawing built-in)".

  A control that reports an intention the card is not honouring is worse than one
  that reports nothing: it is the exact failure the picker was built from a
  registry to avoid, arriving through the default option instead.

- f1100ba: Enforce per-type write grants across the pipeline surface, stop serving connection passwords, and make a deleted connector actually stop retrying.

  **Behaviour change: the pipeline routes now authorise, not just attribute.** `mayWrite` had call sites in one file — `publish.service.ts` — and none on this surface. Every route here read `request.principal` for `?.id ?? 'console'` and used it as a name to write in a log, so a principal holding `catalog:write` with `writeTypes: ["Mvr"]` could author a workflow whose sink commits `Subwo`, attach a connector, and run it. Nothing lied on the way through: the graph validated, the run succeeded, and the snapshot recorded the write as authorised.

  Four routes now refuse. `POST /pipeline/workflows` and `POST /pipeline/connectors` check at save time, which is the gate the scheduled path depends on — a cron-fired run carries a synthetic scheduler id with no grants to consult, so the question has to have been answered when the graph was written down. `POST /pipeline/workflows/:id/run` and `POST /pipeline/connectors/:id/run` check again at run time, which catches what save time cannot see: a graph saved by a principal that held the grant, run by one that does not. Types are read off **every** sink, not off `WorkflowRow.targetType`, which records only the first sink a multi-sink graph declares.

  A host may now be refused for: saving or running a workflow whose sink commits a type outside the principal's `writeTypes`; saving a connector whose `targetType` is outside it, or one attached to a workflow whose sinks are; running either. Refusals are `403` and name every type they turned down.

  **Behaviour change: these routes now require a principal.** `saveConnection`, `saveConnector`, `saveTransform`, `saveWorkflow`, and both run routes previously fell back to attributing the write to `'console'` when no guard had put a principal on the request. They now fail the way `createPublishController` already did, because a caller with no identity has no grants to check and "allow everything when nobody is identified" is the bug being fixed. **A deployment that mounts `CatalogPipelineModule` without a principal guard will start failing these routes.**

  **Behaviour change: a connection URL carrying a password is no longer accepted or served.** `ConnectorRow.config`, `ConnectionRow.config` and `sources.ts` all promise that a credential is never stored — only the _name_ of an environment variable. That held for token-based sources and not for SQL, where `fetchSql` reads `config.url` and `postgres://user:pass@host/db` is a password with an address attached. `config` was persisted verbatim, returned verbatim, and served by `GET /pipeline/connections` and `GET /pipeline/connectors`, both of which ask only for `catalog:read`.

  Two halves, because neither alone is enough:

  - `MySqlPipelineStore.saveConnector` and `saveConnection` refuse a password-bearing URL in `config` that is not already the stored value for that row. Refused in the store rather than the controller, because a connector saved by curl, by a host's own code, or by `applyPromotion` reaches it and nothing else. **A host may now be refused for** creating a connector or connection whose config carries such a URL, changing an existing one's to a different password-bearing URL, or **promoting such a connector into an environment that does not have it yet** — `promoteConnectors` already refuses to carry `secretEnvVar` across so a promoted connector "arrives with no credential", and this applies that rule to the credential that was hiding inside `config`. Move the URL into an environment variable and name it in `secretEnvVar`. Rows already in the table are grandfathered and keep running.
  - The four read routes that serve connectors and connections redact the password on the way out. This is what covers the rows that are already stored. It is at the route and not in the store on purpose: `ConnectorRunnerService` resolves the connector it is about to run through the store, and `applyPromotion` copies connectors between environments by reading them from it — a store that redacted would hand the runner a URL that cannot connect and promote the placeholder into the next environment as though it were the password.

  A console that reads a connector, edits it and posts the whole object back is safe: the save routes put the stored credential back when the value they receive is exactly the redaction of what is held.

  **Fix: `FatalError` in the connector step now actually stops the retries.** `connector-run.steps.ts` documented that a deleted or disabled connector must not be retried and did not achieve it. `FatalError` carries `message` and `code` and no `retryable`; durable core honours the class itself only in `runStepHandler`'s local retry loop, while a dispatched step is judged by `existing.error?.retryable !== false` on a serialised envelope. All three attempts were burning over roughly fifteen minutes for a connector somebody deleted on purpose. Fixed the way `workflow-run.steps.ts` already had been, by extending `FatalError` with `readonly retryable = false` so both paths are correct.

## 0.8.0

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

## 0.6.0

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
