---
"@dudousxd/nestjs-catalog-react": minor
---

The canvas can tell you a source does not supply the columns its sink writes, before the load does.

Every check on the workflow canvas was topological — a sink with no type, two sinks on one type, a
node nothing reaches. All of them pass a graph whose source supplies not one of the columns its
sink writes, because nothing in a graph says what the columns *are*. The load then succeeds,
commits, reports its row count, and the rows are null.

That is not hypothetical. `subwo` has 84 columns, 73 of them spelled in ways SQL cannot use as an
identifier, and the mismatch was found after a run reported `fetched=6905, written=6905`. Thirteen
types were published the same way and six came out with most of their columns null, 313,833 rows of
the largest. `property-names.ts` moved *its* half of that problem to publish time for exactly this
reason; this moves the other half to design time, where everything needed to answer it is already on
screen.

## What is compared, and against which of the two names

A published property has two names and they are not interchangeable:

- **`name`** is what the load looks the field up by — `row[property.name]` — and nothing on the
  write path consults anything else.
- **`columnName`** is lineage: how the source spells the field, recorded when the property ended up
  called something else.

A source with no transform between it and the sink hands its records over exactly as they arrive,
keyed by the source's own spelling. So the record has `Asset Id`, the store asks for `Asset_Id`,
and the answer is `undefined` — written as null in every row of every run, forever, while the load
reports success.

So the comparison is `column.name` against `property.name`. Matching on `columnName` instead —
which *is* the field that agrees with the source — reports "fits" on precisely the graph that wrote
the 6,905 rows. `columnName` is still read, but only to explain a miss: a source column matching a
property's `columnName` and not its `name` is the split-name case, and saying so is the difference
between "this column is missing" and "these two are the same field under two names".

The repair the message offers changed with the release that relaxed the publish check. Publishing
used to refuse any property name that was not a SQL identifier, so publishers renamed the property
to `Asset_Id` and put the source's spelling in `columnName` — which is the type that loads nulls.
Both aliases now go through `outputAlias`, so `Asset Id` is a perfectly good property name and the
type can simply be renamed to what the source calls the field. The message says that first, and
names a transform second, for the narrower set of names that cannot become a column even cleaned.

## Three outcomes, not two

Discovery says how it knows what it knows, and against a real deployment it answered
`basis: "driver"` with `sampled: 0` — the driver described the result set and not one row was read.
There are questions this genuinely cannot settle, and pretending otherwise in either direction is
the failure:

- **fits** — nothing is reported.
- **does not fit** — `level: "error"`, so Save is coloured as refused and the wire is drawn red.
  Reserved for what the two schemas decide between them and nothing else can change: a column the
  source does not produce under the name the store will ask for (`shape-source-spelling` when the
  source has it under its own spelling, `shape-missing-column` when it does not have it at all).
- **not known well enough to say** — `level: "warning"` (`shape-unproven`, `shape-not-checked`). It
  blocks nothing, colours nothing and paints no wire, and it names the basis it is unsure from.

The third one uses the `level` distinction `WorkflowProblem` already had rather than a new one, and
that is the load-bearing part rather than a detail. `coerce` in the warehouse store is total: it
stringifies for a `string`, parses a `date` and gives up as null, returns null for a number that is
not finite. A `string` column arriving at a `number` property therefore loads perfectly when every
value happens to be numeric and writes nulls when one is not — a fact about the rows, and there
were no rows. Calling that "does not fit" would refuse graphs that load correctly every night, and
a panel that shouts about what it could not prove is a panel people stop reading, which is the
failure `workflow/validate.ts` opens by describing.

Also warnings, for the same reason: a column discovery reached no conclusion about (`type: null` is
the absence of a decision, not the `unknown` scalar), and the two sides disagreeing about
nullability — the type saying a field is never null while the source says its column may be. Both
are declarations. Neither is a row.

## Anything that computes its rows is said out loud

What a transform emits is whatever its TypeScript returns, and knowing that means compiling and
running it. A `call` node is further out of reach still: what it emits is decided by a durable
workflow this graph does not own, possibly written in another language, and the graph holds nothing
but its name and a pinned version. So a sink fed through either gets `shape-not-checked` naming the
node, and no error and no silence — silence would read as "these columns fit", which is a claim
nothing here is in a position to make.

The branch is on "not a source" rather than on the kind, so a kind added to the vocabulary tomorrow
lands in the honest answer by default instead of falling through the comparison as though a source
had produced its rows.

## Where nobody asked, nothing is said

If no source feeding a sink has a discovered shape, this reports nothing at all — not even "could
not check". A deployment that has never run discovery would otherwise carry a permanent amber line
on every graph, which is the same noise by another route.

That is also the default. `ValidateOptions.shapes` is optional and **absent, not empty**: a caller
with nothing to offer has not learned that every graph is fine, it has not asked. Every existing
caller of `validateWorkflow` is unaffected.

## Wiring: no new prop

`WorkflowCanvas` answers this for itself. Both halves are already on the screen: the types come from
the catalog snapshot it reads, and the columns come from `POST workflows/:id/nodes/:nodeId/discover`
— the route the source node's inspector already calls. `SchemaDiscoveryPanel` gained an
`onDiscovered` callback and the canvas keeps what came back, keyed by node id.

Kept by the canvas rather than by the panel because the panel is unmounted with the inspector sheet,
and the rail that has something to say about the columns is on the other side of it. Not fetched by
the canvas on load, either: discovery is a read of a live source behind a `POST`, and a graph with
four source nodes would open four database connections nobody asked for. So the check speaks about
the nodes somebody asked about, which is exactly the silence the section above is built on.

A shape is dropped when the node is pointed somewhere else — its kind, its connection, its read mode
or its config — because columns read from one address say nothing about another. Renaming the node
keeps them: a name is not an address.

`checkShapes` and its input types (`ShapeKnowledge`, `SourceShape`, `SourceColumn`, `TargetShape`,
`TargetProperty`) are exported, because the comparison is pure and a host may want it somewhere
other than the canvas — a pre-flight before a scheduled run. `ConnectorSchemaDiscovery` already
satisfies `SourceShape`, so such a caller has one for free.
