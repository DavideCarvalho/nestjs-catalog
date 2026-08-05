# @dudousxd/nestjs-catalog

## 0.13.0

### Minor Changes

- 800a61b: A delete strategy can be declared by an operator, not only by a deployment

  `CATALOG_LOAD_EXPECTATIONS` was the only way to say how a type reconciles rows
  deleted at its source, and it is a provider bound at boot. So the path was:
  build a connector in the console, run it in `full`, and the moment you wanted
  `incremental` you needed an engineer, a commit and a deploy. For a console whose
  whole premise is that you assemble a pipeline on screen, that is the wrong shape.

  The control was never about compilation. Read its own docblock: what it wants is
  that **somebody chose a strategy and wrote down why**. That needs attribution and
  visibility, which a row can carry as well as a provider can.

  So the policy now resolves through three layers, field by field:

      host.byType[type]   >   stored row   >   host.default

  A deployment that declared something about a type still wins — that is what lets
  one pin a type down and keep it pinned. Where the host is silent, an operator's
  stored decision applies. `host.default` stays weakest, so a house-wide bound
  never beats a specific one. `expectationFor` is now literally the same merge with
  no stored layer, so there is one precedence rule in the codebase rather than two.

  The enforcement functions did not move and did not become async.
  `refuseUndeclaredDeletes`, `refuseStaleReconciliation` and `refuseRowCountDrift`
  are still pure and synchronous; only the _sourcing_ of the policy reaches a
  store, and it reaches it through `supportsLoadExpectations`, so a store that
  implements none of the four new optional members behaves exactly as it does
  today. The four members are optional for that reason: this package is not the
  only implementation of `CatalogPipelineStore`, and widening a required interface
  silently disqualifies every other one.

  `PUT`/`DELETE pipeline/expectations/:type` ask for `catalog:curate` — the scope
  that already governs what the catalog says about a type — and for a person.
  `@RequireHuman()` is not decoration here: `because` is a sentence somebody is
  accountable for, and an application key has no author. The writes merge over the
  stored row, so an absent field means "leave it alone" rather than "clear it", and
  a write to a field the host owns is a 409 naming that field rather than a silent
  no-op. Both writes emit `type.curated`, the same event `patchType` emits, so the
  recorder that already lifts `principalId` into the audit table needs no change.

  The connector's cheap pre-flight gate resolves through the same three layers.
  Without that the feature would work everywhere except where it is used: a
  scheduled incremental run would still be refused by the early check after an
  operator had stored a strategy.

  `deletes` and `rowCount` are stored as JSON rather than as columns, and that is
  load-bearing rather than lazy. MikroORM infers `int` for a `number`, which would
  round `maxShrink: 0.5` to `0` — a bound that refuses a load for losing a single
  row — and would overflow a thirty-day `withinMs` past a signed INT.

- 800a61b: One rule about what may be a SQL identifier, rather than two that agreed

  `store-mikro-orm` and `store-clickhouse` each carried the pattern
  `/^[A-Za-z_][A-Za-z0-9_]{0,62}$/`, an `UnsafeIdentifierError`, and the sentence
  `Refusing to use "…" as a SQL identifier: letters, digits and underscore only,
starting with a letter or underscore, 63 characters max.` — byte for byte
  identical, in two files, with nothing anywhere comparing them.

  That mattered because the publish-time refusal added alongside this reuses a
  store's rule on purpose, so that a name refused at publish and the same name
  refused at DDL cannot be described differently. It reused the MySQL copy. Which
  bought the guarantee for a MySQL deployment and left a ClickHouse-only one
  trusting two files to have been edited in step.

  The rule now lives in `@dudousxd/nestjs-catalog` beside
  `CATALOG_RESERVED_COLUMNS`, which is already shared for exactly this reason:
  both are part of what the catalog promises a _publisher_, and a publisher should
  be able to read the answer out of the contract rather than out of whichever
  adapter happens to be mounted. New exports: `isSafeIdentifier`,
  `assertSafeIdentifier`, `UnsafeIdentifierError`.

  Each store keeps its own `ident`, because _quoting_ is engine syntax and not the
  catalog's business — what may be quoted at all is. Both now call
  `assertSafeIdentifier` and re-export the core's `UnsafeIdentifierError` rather
  than declaring one, which also makes `error instanceof UnsafeIdentifierError` a
  question worth asking across packages: it used to be false whenever the mounted
  store was not the one the catching code imported from.

  No behaviour changes. The character set, the 63-character limit, the wording and
  the quoting are all what they were; there is one copy of them instead of two.

## 0.12.0

### Minor Changes

- c457080: A version number that names code you can still read

  A connector run records `transformVersion` and a workflow run records
  `graphHash`, so the catalog has always known _which_ version produced a load. It
  did not keep the text of that version: `catalog_transform` is one row per
  transform, overwritten in place, and a saved query's `sql` was overwritten with
  nothing recorded at all — while the runs list rendered `code v3`, which reads as
  a reference to something retrievable. Every version's body is kept now, and the
  number on a run and the number on a revision are the same number.

  **New table: `catalog_revision`.** Host-visible. It is created by
  `ensureCatalogSchema` and named by `catalogManagedTables()`, so a differ's skip
  list picks it up with no action from a host that already feeds it that list. A
  host registering entities by hand gets it from `catalogStoreEntities`.
  `SavedQueryRow` also gains a `version` column, defaulted to 1 — every saved query
  that exists has had exactly one statement as far as anything can tell, and
  calling that version 1 is the only claim about it that is true.

  **Two routes**, both `catalog:read` and both newest-first:
  `GET <pipeline>/transforms/:id/revisions` and
  `GET <catalog>/saved-queries/:id/revisions`. They are the same scope as the
  routes that already serve the current `code` and `sql`, because history is that
  field one version older; the authoring scope holds back _choosing what SQL runs_,
  which reading an old body is not. `CatalogRevision` is exported from both the
  package root and `/client`.

  **Bounded, and that is the decision worth reading.** The newest
  `CATALOG_REVISION_LIMIT` (50) revisions per subject are kept; older ones are
  dropped as newer ones arrive. This is the fourth append-only table in the store
  and the first that grows with how often somebody edits rather than with what
  happened, with a whole code body per row — so a run's `transformVersion` can name
  a revision that has been evicted. That loss is real, it is strictly smaller than
  the one it replaces, and the constant's docblock states the arithmetic. A
  revision is written only when the text actually changed, following the rule the
  version counter already used, which under a cap matters more than it did before:
  a revision per save would let twenty renames evict twenty bodies that loads ran.

  **Existing rows are not left empty.** A subject with nothing recorded answers
  with its live text at its live version, synthesised on read and not written down;
  the first save that changes the text backfills that same revision for real,
  byte-for-byte identical, so a screen does not shift underneath somebody.

  **Workflow graphs are deliberately excluded**, and `CatalogWorkflow` says so
  where a reader will look for the missing feature. A graph is a structure rather
  than text a person typed, and its `version` is bumped on draft edits by design —
  archiving one body per version would fill a bounded table with autosaves of a
  canvas somebody is still dragging boxes around on, evicting the versions that
  ran.

  Both store methods are optional on their interfaces, so a store written against
  the previous shape still compiles; `supportsTransformRevisions` and
  `supportsSavedQueryRevisions` are how a caller asks, and a store that keeps none
  gets a route that says so rather than one that answers `[]` — "nothing recorded"
  and "not kept here" draw identically and mean opposite things.

## 0.11.0

### Minor Changes

- 4d28056: A workflow can be saved unfinished, and publishing is what validates it

  Validation used to be the gate on _saving_. `MySqlPipelineStore.saveWorkflow` ran
  `validateWorkflow` and refused anything with an issue — `"<name>" cannot run as
drawn.` — so a graph you had not finished could not be written down at all, and
  closing the tab lost it. A saved workflow was, by definition, one that runs.

  That also made the canvas lie about ordinary work. Clicking **+ Sink** produced a
  node that "is not reachable from any source" and "does not say which object type
  it writes": both true, both useless one second after the click, because a
  just-added node is unwired by construction.

  So the gate moved rather than loosened. `CatalogWorkflow` gains
  `status: 'draft' | 'ready'`. A draft saves without validating; only a `ready`
  graph runs, is schedulable, or is promoted. The same `validateWorkflow` still
  decides — a draft is not a graph that skipped the rules, it is a graph nobody has
  claimed is finished yet.

  ## What a host does on upgrade

  **The schema gains one column, and its default is the decision.**
  `catalog_workflow.status` is `varchar(16) NOT NULL DEFAULT 'ready'`, applied by
  `ensureCatalogSchema` like every other change in this package — there is nothing
  to run by hand. It backfills every existing row to `ready`, deliberately: each
  one got there through a save that refused anything invalid, so each is a graph
  that was valid when it was written, which is exactly what `ready` asserts.
  Defaulting to `draft` would have been the conservative-looking choice and would
  have silently stopped every scheduled connector on the deployment the moment the
  migration ran, because a connector may only run a ready graph. A default that
  turns an upgrade into an outage is the wrong default.

  **New graphs now arrive as drafts.** Anything automating `POST workflows` and
  expecting the result to be immediately runnable must now call
  `POST workflows/:id/publish`. This is the one behavioural break: a script that
  created a workflow and attached a connector to it in the same breath will now be
  refused at the connector save until it publishes.

  **Two new routes**, both `catalog:write`: `POST workflows/:id/publish` and
  `POST workflows/:id/unpublish`. Publishing is a transition rather than a field on
  save because "ready" is a claim that has to be checked, and a check that fails
  owes an explanation naming the nodes — a boolean on a save request has nowhere to
  put that which is not an error on an operation the author thought was about
  something else.

  **Two new store methods.** `CatalogWorkflowStore` gains `publishWorkflow` and
  `unpublishWorkflow`, and `supportsWorkflows` now asks for `publishWorkflow` by
  name. A custom store implementing the interface must add both; one that has the
  save and not the transition would narrow cleanly and then fail one call into a
  promotion that had already written types and transforms into the target.

  ## The three refusals worth knowing about

  **A connector may only point at a `ready` workflow, refused at save.** The check
  could equally have lived in the runner, and that is the version worth arguing
  against: it would move the error from the person wiring the connector — who is
  looking at the screen and can fix it in one edit — to a scheduled window at 3am.

  **A published workflow edited into an invalid state is refused, not demoted.**
  Silently dropping it back to `draft` was the alternative, and it is the one that
  loses a running pipeline without saying so: connectors may only run ready graphs,
  so the demotion would disable a scheduled load with nothing reported. Unpublish
  it explicitly to park a broken idea on a live graph.

  **Unpublishing is refused while any connector still runs the graph**, naming
  them, exactly as `deleteWorkflow` already did. Cascading — disabling those
  connectors here — was rejected on principle: turning off somebody's loads as a
  side effect of an edit to something else is the silent action this status exists
  to prevent.

  ## Promotion

  Drafts are not in the promotable set at all, which is stronger than refusing a
  draft promotion and is the statement worth making: a draft may have no sink, so
  there is not even a well-formed thing to describe to a reviewer. Nothing can be
  hidden by the omission, because no connector can reference one. `promoteWorkflows`
  now saves _and publishes_, since a save drafts and the connector phase that
  follows cannot attach to a draft — and the publish re-validates the graph against
  the transforms that actually arrived in the target rather than trusting that it
  was ready in the source.

- 67741ab: Two security fixes on the pipeline surface: who may execute a transform, and what a graph serves.

  **`POST pipeline/transforms/try` is code execution and is now authorised as such.** It was the only
  route on the controller that never called `requirePrincipal`, and it did not check that
  `body.language` was a language the way `saveTransform` does. It reached `SubprocessTransformRunner`
  on `catalog:write` alone — and that runner is honest in its own docblock about not being a security
  boundary, because the child reads the parent's whole environment back out of `/proc/<ppid>/environ`
  whatever the `env` allowlist withholds, and reads the filesystem as the service's own user. So the
  softest thing on that route was the only thing holding the door.

  It now requires a principal, at least one `writeTypes` grant, and a signed-in person
  (`@RequireHuman()` — this is the decorator's first use anywhere; declare `REQUIRES_HUMAN` in your
  guard). **Breaking for hosts** whose console calls this route with a machine principal, or with a
  principal holding `catalog:write` and no per-type write grant: both now get 403.

  The bar is deliberately the same one the graph path already charges rather than a higher one — a
  principal that may write some type can already run the same code by saving a transform, saving a
  graph and pressing Run. That residual is the trust model, and it is now written down in the pipeline
  README under "Running a transform is running code" instead of only in a JSDoc, along with the
  supported way to change it (bind your own `TransformRunner`).

  **`GET pipeline/workflows` served source-node credentials verbatim.** A `WorkflowSourceNode` carries
  the same `config` vocabulary a connector does, so a URL with a password in a graph was readable by
  anyone holding `catalog:read` — the audience `redactConnector`/`redactConnection` were written for,
  through the one route nobody had counted as a connector route. Source configs are now redacted on the
  way out, and restored per node id on the way back in, so a console that reads a graph and posts it
  back does not overwrite the credential with the placeholder. The save responses of `POST workflows`,
  `POST connectors` and `POST connections` are redacted too: each returns the row it just restored, so
  an unredacted response undid the read redaction in a single request.

  `SubprocessTransformRunner` also gets three fixes worth having regardless of the above: `stderr` is
  bounded at 64 KiB (it accumulated without any cap for the whole timeout window, growing the _parent's_
  heap until the pod died), the timeout kills the child's process group rather than one pid (so a
  transform that spawned anything no longer outlives it), and the child runs in a temporary directory
  rather than inheriting the service's, where `readFileSync(".env")` reached the host application's
  configuration.

- f2f5d7c: Credentials can be encrypted before they rest in the catalog's own tables

  The redaction stopped a connection password travelling in an HTTP response. The
  refusal stopped a new one being written. Neither does anything for the reader
  this is about: a database dump, a read replica, a nightly backup, or anybody
  holding `SELECT` on the instance. For them `catalog_connection.config` was a
  list of every password the catalog knew — and `allowInlineCredentials` enlarges
  that population on purpose, which is why this is worth building now.

  **`CatalogSecretVault`, a seam and not a cipher.** There is no encryption in
  this library and there must not be: shipping AES with a key from an environment
  variable moves the problem from one column to one variable, and leaves this
  package answering for key rotation and per-environment separation that the
  host's KMS or Vault already answers for. Bind `CATALOG_SECRET_VAULT` — to one
  vault, or to an array of them, which is what lets a key rotation happen without
  an outage: the first seals, and any of them may open, matched on the `vault`
  name every row carries.

  **The default refuses.** Unbound, `RefusingSecretVault` throws on `seal` naming
  the token. A default that quietly stored plaintext would make
  `encryptCredentials: true` a no-op with a reassuring name — saves would succeed
  and the column would be exactly as it was.

  **`encryptCredentials`, and how it composes with `allowInlineCredentials`.**
  Four combinations, three meanings, and no fourth: sealing runs _before_ the
  refusal is asked, so a sealed credential is an object by the time anything looks
  for a password-bearing string. `false/false` refuses (unchanged, and the
  default). `false/true` and `true/true` seal. `true/false` is the deliberate
  dev-environment plaintext trade the flag already documented. The combination
  worth naming is `allowInlineCredentials: false, encryptCredentials: true` — it
  reads like a contradiction and is the one a production deployment wants.

  **The store opens on every read**, whatever the flag currently says, so turning
  encryption off keeps existing rows readable rather than being a data-loss
  button. It also means nothing downstream learns that a vault exists: `fetchSql`
  still gets a URL, and — the sharper reason — `restoreRedactedSecrets` still
  gets a string to compare against. Had reads handed out ciphertext, the console
  round trip would have written the literal `REDACTED` over the credential, which
  is the classic way a fix of this shape corrupts what it protects. **The
  redaction is unchanged and stays**: it defends against `catalog:read` over HTTP,
  sealing defends against `SELECT` on the database, and dropping either because
  the other exists gives that attacker the password back.

  **What is sealed** is what the refusal already recognises — a top-level string
  that parses as a URL carrying a password — and not the whole `config` object.
  One predicate, two consumers: seal something the redaction does not hide and a
  console renders a ciphertext blob; hide something this does not seal and the
  column still holds the password. Sealing everything would also blind the
  refusal, which needs a string to inspect.

  **Rows already holding plaintext** are sealed on their next save and not before.
  No read-through-reseal — a read that writes can fail a connector run for a
  bookkeeping reason, and these rows are read on the runner's hot path — and no
  one-shot migration in this release. The column takes both forms indefinitely,
  `isSealedSecret` tells them apart, and a migration written later needs no schema
  change.

  **A vault that is down fails a save, and fails a read _retryably_.** A save that
  cannot seal writes nothing; there is deliberately no catch that logs and stores
  the plaintext, because a deployment that did that during an outage would have no
  way afterwards to find out which credentials went in clear. A read that cannot
  open throws `SecretOpenFailedError`, which is pointedly **not** a
  `BadRequestException` — `ConnectorRunSteps` catches that class and converts it
  to a non-retryable `connector_unavailable`, so a five-second vault blip would
  have become a load that never ran and an operator hunting for a connector nobody
  deleted. It is fatal only when waiting provably cannot help: nothing bound,
  nothing bound under the row's vault name, or the vault's own error saying so.

  **`saveWorkflow` refuses and seals a source node's credential too.**
  `WorkflowSourceNode` promised "credentials stay out of the catalog here exactly
  as they do everywhere else" and nothing enforced it: the graph was written
  verbatim, and the workflow runner spreads `node.config` into a synthesised
  connector, so `fetchSql` read `config.url` from there exactly as it does from a
  connector's. Same predicate, applied per node; grandfathering compares per node
  id, so renaming a graph does not refuse over a credential nobody touched. The
  graph fingerprint is taken before sealing, so a non-deterministic ciphertext
  never registers as a new version.

### Patch Changes

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

## 0.10.0

### Minor Changes

- 42f3441: The curation trail can finally name who.

  `type.curated` fires whenever somebody renames a column, changes a unit, hides a property or sets a
  classification, and its own docblock justifies its existence: _"who renamed this column and when is a
  governance question, and the answer is otherwise nowhere."_ Its payload carried `typeName`, `property`
  and `changed` — so it answered _when_ and _what_, and never _who_. `overlay.reset`, added last
  release for the catalog-wide revert, shipped with the same hole and a docblock explaining it as a
  limit rather than a decision.

  Two things made that worth fixing rather than documenting. `query.shared` and `dashboard.shared`
  have named their actor since the day they were added, so the trail was inconsistent in a way that
  reads as a bug in whichever half you look at second. And curation is the one act this library
  describes as surviving the publisher's next deploy — a decision that outlives deployments and could
  not name its author.

  **Both events now carry `principalId`**, threaded from the route that resolves a principal down to
  the registry that emits. It holds the whole `CatalogPrincipal.id`, composite half included, matching
  `query.shared`: `parsePrincipalId` recovers the application from an `<app>#<person>` id, so nothing
  is lost by carrying the person, while dropping to `applicationId` would file a curator's decision
  under the console they signed into. It is spelled `principalId` and not `curatedBy` because that is
  the key `CatalogAuditRecorder` lifts into the audit table's indexed column.

  ## 💥 Breaking: `CatalogRegistry` takes the actor

  `patchType`, `patchProperty` and `resetOverlay` each take the acting principal's id as a new, final,
  **required** argument.

  - **Your call sites need it.** `registry.patchType(name, patch)` becomes
    `registry.patchType(name, patch, principal.id)`; `patchProperty` gains a fourth argument and
    `resetOverlay` a first. The compiler names every one. `CatalogService`'s three forwarders take it
    too, so a host that wrote its own controller against the service is updated the same way.
  - **Your subclasses keep compiling, and that is the part to check by hand.** TypeScript lets an
    override take fewer parameters than it promised, so a registry of your own that still declares
    `patchType(typeName, patch)` is a legal implementation and will not be flagged. What _will_ fail
    to compile is its emit: `CatalogEventPayloads['type.curated']` now requires `principalId`, so any
    implementation that emits its own curation event has to have one to put there. Add the parameter
    and pass it through.
  - **Required rather than optional, deliberately**, on the argument `CatalogService.deleteSavedQuery`
    already makes about its own `deletedBy`: a default quietly attributes the act to nobody in every
    caller that was not updated, and naming somebody is the entire value of the record.
  - **No value is ever empty.** A producer with no principal in hand emits the exported
    `UNATTRIBUTED_PRINCIPAL_ID` (`"unattributed"`) via the exported `curationActor()`. The recorder
    writes a falsy actor as NULL, and NULL in that column reads as "nobody did this" rather than "this
    was not captured" — and an unauthenticated mount gets `"console"` from the controller, the same
    fallback the sharing routes use, which is the narrower and more useful claim.

  The emit stays inside each registry rather than moving up to the service or the controller. A host
  calling `patchProperty` from a migration script or an admin job would otherwise emit nothing, which
  would quietly redefine the trail as "curation that happened to go through the bundled controller" —
  the same class of gap the actor was missing from. The registries also know things the layer above
  does not: the stored one decides whether a patch landed on a column or a link, and only the in-app
  one can summarise the overlay it is about to destroy.

  ## The environment hop

  `RoutingCatalogRegistry` forwards these calls by hand, and it forwards the actor with them. This is
  the hop the field would have been lost at, and it fails differently from a dropped method: the patch
  lands, the response is a 200, the audit row is written — and its actor says `unattributed`, in
  exactly the multi-environment deployments that have a governance team reading the trail.
  `environment.routing.curation.spec.ts` asserts what the registry _behind_ the proxy received, because
  every other observable is identical whether the actor was forwarded or not.

  `StoredCatalogRegistry.resetOverlay` still refuses and still emits nothing, and it declares no actor
  parameter — accepting one would advertise a record it never writes.

### Patch Changes

- c2259bc: Two guards that answered "fine" when what they meant was "I could not tell".

  ## The staleness clock could be stopped by one unreadable timestamp

  `refuseStaleReconciliation` is the half that makes `periodic-full-reload` a mechanism rather than a
  note: once the newest full snapshot of a type is older than the declared interval, incremental loads
  of it stop committing. All of it rests on picking which of the store's full snapshots is the newest,
  and that was decided by comparing the two `createdAt` **strings**.

  Two of them sort chronologically only while every store writes the same UTC ISO-8601 shape — which
  this cannot check, and which did not hold.

  - **A timestamp that cannot be read at all was the expensive case.** `"unknown"` sorts above every
    real timestamp, because `'u'` is past every digit. It won the comparison for newest,
    `Date.parse` of it is `NaN`, and `NaN > withinMs` is false — so the load was admitted. One
    unreadable row, in a list whose other rows could have dated the type perfectly well, switched the
    bound off, and nothing anywhere said so. A type nine days past a one-day interval went on carrying
    forward rows deleted upstream, reporting healthy the whole time.
  - **An offset other than `Z` was the cheap case**, wrong in the safe direction: it mis-ordered by up
    to a day and therefore refused slightly more than it should.

  Both are the same fix. The unreadable ones are now dropped **before** the newest is chosen, and the
  newest is chosen by parsed instant. A refusal also names the snapshot it actually dated the interval
  from, which it could not be relied on to do before — being refused with the wrong snapshot named
  sends an operator to look at a load that was fine.

  **This can refuse a load it previously admitted**, which is the point of it: the loads it now refuses
  are the ones whose last full reload really is past the interval. A store that gives every full
  snapshot an unreadable `createdAt` is still admitted, unchanged and deliberately — that is the same
  permissive-rather-than-punishing stance `CARRIED_FROM_LABEL` takes, and there is nothing to refuse ON
  when every comparison available is against `NaN`. What changed is how narrow that branch is: it used
  to be reached by one bad row, and now needs all of them.

  ## `InMemoryCatalogOverlayStore` handed out the object it holds

  `load()` returned the store's own overlay and `save()` kept the caller's. The registry edits the
  overlay in place — `this.overlay.types[name] = { ...current, ...patch }` — before it persists, so the
  store's state moved on a patch, before any `save`, in both directions.

  The net behaviour was identical, because every edit is followed by a persist. Two things were not:

  - **The two bundled stores disagreed about the one sentence a store is for.**
    `FileCatalogOverlayStore` round-trips through JSON and so has never aliased anything. Every spec in
    this repository runs on the in-memory one, so a test asserting that an edit had not been written
    yet passed vacuously here and would have failed on the store a deployment actually uses.
  - **Two registries over one store shared mutable state**, each able to see the other's half-applied
    edit with no write between them.

  Both ends now copy, and one end would not have been enough: copy only on `load` and the object handed
  to `save` becomes the store's own again on the very next patch; copy only on `save` and the object
  handed out by `load` already is. The copy is a `structuredClone` rather than a JSON round-trip, so a
  key whose value is `undefined` survives it instead of being silently dropped.

  The cost is one deep copy per load and per save. The overlay holds the names, descriptions and
  per-property patches a human has typed — not the catalog, which is derived from entity metadata and
  does not live there — so the two paths that pay it are a boot and a curator pressing save. Neither is
  a read.

## 0.9.0

### Minor Changes

- ca6d08b: A Python transform's `print` goes somewhere, and `durability()` stops describing checks it never made.

  ## `print`

  `TransformResult.logs` is documented as "Anything the code logged", and the JavaScript harness
  overrides `console.*` so that it is. The Python harness captured nothing unless the author called an
  undocumented `log()`: `print` went straight through to the child's real stdout, where the last-line
  result parse discarded it. So the first thing anybody writes while working out what their transform
  is doing produced an empty log panel and no explanation — and the conclusion that invites ("my code
  never ran") is the wrong one. It costs the author their trust in the tool before they have written
  anything real.

  `print` is now redirected, along with `sys.stderr`, into the same list the result carries.

  - **`log()` stays, and is now literally `print`.** Transforms in the wild call it and a `NameError`
    is a worse answer than a redundant helper — but it is no longer a second capture path with its own
    ordering. One buffer, one sequence.
  - **stdout and stderr interleave in call order, unmarked**, which is what the JavaScript harness
    already does with `console.error`. A reader is reconstructing a sequence and two lists cannot be
    zipped back together.
  - **Output written before a traceback survives it.** The redirect is a `contextlib` context manager
    around the call rather than a swap held for the whole script, so it unwinds out of an exception
    with the buffer intact. That is the case logs matter most for and the case a naive swap loses.
  - **A write that never ended its line is kept** rather than being lost. It used to be worse than
    lost: it landed immediately before the result JSON on the same line, so `sys.stdout.write("x")`
    without a newline failed the whole run as unreadable.

  ## Bounds, in both harnesses

  `logs` is user code writing whatever it likes, and it is the one thing that crosses a durable step
  boundary into the run record — so an unbounded capture makes the size of a `finishRun` write a
  property of somebody's source data. Both harnesses now cap at **500 lines of 2,000 characters**, the
  same two numbers, applied in the child before anything is serialised. The JavaScript harness had no
  bound of its own; its only ceiling was the 32MB stdout kill, which loses the whole run rather than
  truncating a log.

  What is dropped is said out loud, in a final line naming the count. A truncation nobody is told about
  is the same failure as a log nobody is told about, moved to line 501.

  The Python sink is bounded, not only its result: an unterminated write past a line's ceiling is
  emitted rather than accumulated, so a transform writing megabytes with no newlines in them cannot
  grow the child's memory either.

  Two smaller things of the same family: **`console.debug` and `console.trace` are now captured**
  (`debug` writes to stdout exactly as `log` does, so it was corrupting the very result line the
  override exists to protect; `trace` writes to stderr and simply vanished), and **a failing transform's
  last logged lines are folded into the error**. A failure throws, and a throw carries a message and
  nothing else, so `logs` never reached the caller at all on the one path they were most wanted — the
  last ten lines at 200 characters, counted so nobody reads a tail as the whole of it.

  ## `WorkflowLauncher.durability()`

  Its docblock described three refusal checks — an engine, whether this pod serves handlers for it, and
  whether that engine belongs to the environment the caller asked for — and the body performed one. An
  unused `requireEnvironmentBundle` import and an uncalled `safely()` helper were left behind from the
  other two.

  **The prose was corrected rather than the checks rebuilt, because neither can be made correctly from
  this package**, and the docblock now says that instead of implying they are covered:

  - **Handlers.** `engine.workflowBody(name, version)` answers only half of it. A body means definitely
    registered; _no_ body is equally a `registerRemote` worker in another SDK or a group resolved by
    convention against a live worker, both of which run the graph perfectly well. Treating that half
    answer as "no" would route a durable run inline — and an inline run carries none of the singleton
    mutex, so two workers would load one connector's type at once. That is worse than the failure it
    would guard against, and the genuinely unregistered case already fails loudly: `engine.start` throws
    and `startDurable` refuses rather than falling back.
  - **Environment.** The one with real damage behind it, and the one least available from here. A
    `WorkflowEngine` carries no environment identity this package can read, so the most it could compute
    is which environment the _caller_ is in — half a comparison, which is exactly why the two fossils
    were left unused rather than finished.

  Both are therefore reported rather than detected, through
  `CATALOG_PIPELINE_DURABILITY_DETAIL` — **which was broken in the way that matters most for that job.**
  The seam is documented as something that "only ever ADDS to what the package observed" and it was
  _substituting_: a host binding a true and specific sentence ("this pod registers no workflow
  handlers") erased the sentence saying whether an engine had resolved at all. It now composes, with
  the observation first, because that is the part that was actually checked.

  `WorkflowDurability.engine` is populated for the first time. It is declared as something a console can
  print and absent whenever nothing can checkpoint, and the body never set it — so the console's
  `checkpointing: <engine>` label could not have rendered a name in any deployment. It is the class that
  resolved, which is a weak signal named as one: it distinguishes a real engine from a host's stand-in
  and says nothing about which broker or which environment is behind it.

  **Still unreachable, and not fixed here:** `GET <path>/pipeline/capabilities` returns only
  `{ languages, pythonPackages }`, so nothing serves `durability()` over HTTP at all. The React console
  already has the banner — `describeDurability(capabilities?.durable)` in `WorkflowCanvas` — and reads
  `undefined` in every deployment. Whatever a host says through the detail seam is dropped on arrival
  until that route carries `durable`.

- 01df149: Reverting every curation edit at once is audited too.

  `patchType` and `patchProperty` emit `type.curated`, on the argument that "who renamed this column
  and when" is a governance question with no other answer. `resetOverlay` discards every curated label,
  description, unit, order, hidden flag and **classification** in the catalog, needs the same
  `catalog:curate` scope, and emitted nothing — so the trail could name the person who renamed one
  column and not the person who reverted every name at once.

  Un-classifying a property this way is not cosmetic either: `visibleToPrincipal` filters search
  results on `classification`, so a reset silently re-admits every classified property's _name_ to
  searches by principals who could not see it a moment before.

  **New event: `overlay.reset`.** It could not be a `type.curated` — that payload leads with a
  `typeName` a recorder lifts into an indexed column, and a reset has no single one — so `CATALOG_EVENTS`
  gains a name, and every recorder and watcher that iterates that list picks it up with no change.

  What it carries is a **summary, not a copy**. The overlay is discarded rather than versioned, so what
  is not in the payload is nowhere, which argues for carrying all of it — and all of it would be a
  backup nobody designed, with no restore path and no retention policy of its own. So:

  - `typeNames` — every type that carried curation, because "was the work on `Dispute` in it" is the
    question actually asked six months later.
  - `properties` — how many per-property entries went with them, as one number. The property names are
    where the summary would become the dump.
  - `classifications` — every classification that stopped applying, with its value, in full. They are
    the one part of the overlay whose loss changes what the catalog shows to whom, they are a small
    subset of it, and re-typing them is the only recovery available.

  There is no `principalId`, and the absence is a limit rather than a claim that the actor does not
  matter: `resetOverlay()` takes no principal and the route that calls it resolves none, so the field
  would be empty on every row — which an audit table reads as "nobody did this" rather than "not
  captured". `type.curated` has the same gap; closing it is a change to the controller, the service and
  every registry.

  **`StoredCatalogRegistry` deliberately emits nothing.** It has no overlay — the published values _are_
  the stored values — so it still throws, and a refusal that wrote an audit row would claim a reset
  happened while the caller got an exception and every stored label stayed put.

  `InMemoryCatalogOverlayStore` no longer describes itself as being for "deployments that want the
  catalog strictly read-only". It never was: `save` accepts writes, `PATCH /catalog/types/:name`
  answers 200 and emits `type.curated`, and the edit is real until the process ends — but it lives in
  one process's heap, so replicas disagree about what a column is called. Read-only is the host guard's
  decision about the `catalog:curate` scope, not a store's, so the docblock now says what the store
  actually is: non-persistent, and single-process.

## 0.8.0

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

- c90d9ea: One graph builder, not two.

  Relations shipped with the edge rule written twice: `MikroOrmCatalogRegistry` derives the ontology
  from ORM metadata, `StoredCatalogRegistry` reads it out of the database, and each had its own
  `linkKey` and its own edge loop, in different packages, under a comment asking whoever changed one to
  change both.

  A comment is not a mechanism, and this divergence would have been invisible. The rule is that a link
  declared at both ends produces ONE edge, paired by a key that survives the two ends having different
  property names, drawn from the end that holds the foreign key so the arrow points the way a join is
  written. A copy that regressed to keying on property name alone draws two edges for every ordinary
  foreign key — which is the bug this rule was written to fix, and the only place it shows up is a
  picture nobody diffs.

  `CatalogRegistry.getGraph()` is now **concrete** on the abstract class, built from the snapshot every
  registry already has to produce. Nothing about it ever varied, so there was never anything for a
  subclass to decide. Both registries drop their copy; the graph they serve is byte-for-byte what it
  was.

  For anyone implementing `CatalogRegistry` in a host: `getGraph` is no longer abstract, so a third
  registry gets the edge rule right without writing it. Overriding is still correct where a registry
  _delegates_ rather than derives — `RoutingCatalogRegistry` hands the whole call to whichever
  environment the request named — but deriving it a second time is not.

## 0.7.0

### Minor Changes

- 8d58f9f: Links survive publishing, and survive a promotion

  Relations shipped end to end — discovered from ORM metadata, stored as a column
  on the object type row, merged by a rule that knows what a publisher owns and
  what a curator owns, served on the type and drawn in the graph — with nothing
  writing the column. `PublishedType` had no `relations`, so the one route an
  application publishes its shape through dropped every link at the door, and the
  whole feature was inert in any deployment that had not hand-edited the database.
  `PUT /publish/:type/schema` now carries them, through the row's own
  `mergeRelations` rather than a second copy of that judgement.

  **Absent and empty are different statements on that wire.** A publisher that
  sends no `relations` key has said nothing about links and its stored ones are
  left alone — an application on a client that predates this field re-publishes its
  whole shape on every deploy, and reading silence as "no links" would delete the
  ontology, and every label curated onto it, the next time somebody shipped an
  unrelated change. A publisher that sends an empty array has said there are none,
  and the merge drops them.

  **A promotion between environments carried none of it.** The promoted type
  arrived complete in every visible way — right properties, right table, right
  owner — and sat in the target's graph as an island, with nothing erroring at any
  point, because the plan could not see the difference either: a promotion whose
  only content was a link reported "nothing to promote". The promotable shape now
  carries relations, the diff reports `relations.added` / `.changed` / `.removed`,
  and the apply writes them.

  **`relations.removed`, not `relations.absentFromSource`.** A property that
  disappears from the source keeps its column and its rows in the target, because
  `ensureType` never drops anything; a link that disappears is deleted there. The
  apply ASSIGNS the source's links rather than merging them — a promotion is
  somebody approving a fingerprinted plan of what the source holds, and a link the
  source deliberately dropped surviving in the target would mean the plan says
  `relations.removed` while the apply does not remove it. It is safe in a way
  dropping a column is not: a column may still hold rows, a link holds nothing.
  The removed names are carried in the diff's `to` value, because the fingerprint
  an approval is compared against hashes exactly that — empty, dropping the link to
  `Base` and dropping the link to `Depot` would hash identically.

  `StoredRelation`, `PublishedRelation` and `relationsOf` are exported from the
  store package's entry point, along with `catalogConnectionProviders`, which had
  fallen behind the same hand-maintained list: both connection tokens were exported
  and the only supported way to satisfy them was not.

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

### Patch Changes

- b4410bb: A load now has to be plausible before it becomes the data everybody reads

  Two failures, and they are the same failure from two ends: a load that is
  **fresh and wrong**. Every signal this catalog publishes about a type —
  `lastCommittedAt`, the age badge on the Model screen, a green run in the runs
  list — reports whether a load HAPPENED. None of them reports whether what it
  loaded resembles the dataset it replaced, and a snapshot commit is atomic, so
  from the moment a wrong load commits it is indistinguishable from a right one
  until somebody counts rows by hand.

  **Deleted rows lived in the lake forever.** An incremental connector asks its
  source for what changed since a watermark. A row physically removed from the
  source never changes again, so it is never returned again, so `carryForward`
  copies it into every subsequent snapshot indefinitely. Nothing goes wrong at
  any step; the catalog simply never finds out. There was no reconciliation, no
  tombstone, and no mention of the limitation anywhere.

  `PublishService.carryForwardAsSystem` — the one method every incremental load
  passes through, whether it came from a connector, a workflow sink or an
  application — now **refuses a type for which no reconciliation strategy has
  been declared**. `ConnectorRunSteps` asks the same question before a scheduled
  connector reads its source, so a misconfigured connector is refused without
  pulling forty thousand rows first and without burning three durable retries on
  something that will be exactly as wrong in fifteen minutes.

  **A collapsed load committed as though it were healthy.** A connector that
  starts returning 12 rows where it returned 40,000 — a source-side filter
  change, a broken `WHERE`, a partial outage — committed successfully. Both
  commit paths now compare the pending snapshot against the one being served and
  refuse a load that lost more of it than the type allows. A refusal leaves the
  snapshot written and uncommitted, so readers keep the previous one and the rows
  are still there to be looked at; a connector run reports it through
  `connector.run.finished` with `status: "failed"`, the same event both outcomes
  have always come out of.

  **Both are refusals a host will meet.** What to do about it:

  Bind `CATALOG_LOAD_EXPECTATIONS` from a module you already pass in
  `CatalogPipelineModule.forRoot({ imports })`, exporting the token:

  ```ts
  {
    provide: CATALOG_LOAD_EXPECTATIONS,
    useValue: {
      default: { rowCount: { maxShrink: 0.5, minRows: 100 } },
      byType: {
        AuditEvent: { deletes: { strategy: 'accepted', because: 'append-only ledger' } },
        Employee: {
          deletes: {
            strategy: 'soft-deleted-at-source',
            because: 'HR sets deleted_at, so the watermark sees the removal',
            column: 'deleted_at',
          },
        },
        Mvr: {
          deletes: { strategy: 'periodic-full-reload', because: 'nightly full read', withinMs: 86_400_000 },
          rowCount: { maxShrink: 0.3 },
        },
      },
    },
  }
  ```

  - **Every type loaded by an `incremental` connector needs a `deletes` entry**,
    or its next load is refused. The reason is a required field: it is the only
    part of the decision still legible in six months. `periodic-full-reload` is
    the one that is policed — once the last full snapshot is older than
    `withinMs`, incremental loads of that type stop committing.
  - **The row-count bound applies with no configuration at all**, defaulting to
    `maxShrink: 0.5` above `minRows: 100`, plus an absolute rule at any size: a
    snapshot of zero rows never replaces a non-empty one. Growth is unbounded
    unless a type sets `maxGrowth` — a type that doubles has usually had a good
    day, a type that loses 90% has not. A load that is legitimately smaller is
    admitted by setting `_expectShrink` in its labels (the publish API passes
    labels through) or by raising `rowCount.maxShrink` for that type.

  Two limitations stated rather than glossed. A connector run cannot set
  `_expectShrink` today — the runner labels its snapshots `{ source, connector }`
  and takes no input for the rest — so a connector whose truncation is deliberate
  is unblocked by raising the bound for that type. And a store that implements
  neither `currentSnapshot` nor `listSnapshots` has no baseline to compare
  against; the row-count check logs a warning naming the type and stands aside
  rather than refusing an adapter for recording less than the bundled one does.

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
