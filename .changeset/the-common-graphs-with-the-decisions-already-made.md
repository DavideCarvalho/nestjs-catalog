---
"@dudousxd/nestjs-catalog-react": minor
"@dudousxd/nestjs-catalog": minor
---

Workflow templates: the graphs people actually draw, with the decisions already made.

Thirteen types were loaded into a dev catalog in one evening by hand-building one pipeline per
type. Six came out with **every renamed column 100% null** — `Subwo` has 313,833 rows and 73 of its
84 columns empty. Nothing caught it: the loads committed, the row counts were right, the runs were
green. The same wrong decision about property naming was simply made six times, because it was
being re-derived per type by somebody trying to get data in.

So a template here is not sugar. It is the place a decision that is easy to get wrong is made once,
by somebody who thought about it, and written down where it gets reviewed. Every template states
what it **assumes** and what it **declares** on the operator's behalf, and both travel with the plan
so a screen shows them rather than burying them.

## The five that shipped

- **Replicate a table** — SQL straight into a type. Two nodes and one edge, and the entire value is
  the refusal described below.
- **Load a file drop** — a CSV/NDJSON/JSON drop from a path or a bucket. Structurally the same and
  separate on purpose: a DPAS-style header is the likeliest place to meet `Asset LIN/TAMCN`.
- **Fan one source into several types** — one expensive read, a transform *per branch*, a sink per
  type. Per branch because both successors of a source read the same rows, so one shared transform
  would commit identical wide rows into every type.
- **Join two sources into one type** — two reads joined inside one transform.
- **Enrich against a lookup table** — the same graph and the same code with one flag flipped, and
  it is a separate template because that flag *is* the decision: an unmatched row is kept when
  enriching and dropped when joining. Dropping it from an enrichment means a load silently loses
  every record the dictionary has not caught up with — a run that succeeds, reports a plausible
  count, and is missing data.
- **Periodic full reload** — a full read on a schedule, with the matching `periodic-full-reload`
  declaration derived from the **same** cadence, so the two cannot disagree.

## The naming problem, and why two templates refuse rather than guess

The warehouse matches records to properties **by property name** — `row[property.name]`. The name
is also written verbatim as the view's output column and as the alias of every read, and both go
through `ident`, which refuses rather than escapes. So a property name must be a SQL identifier, and
publishing refuses one that is not.

Put those together and a column spelled `Asset Id` cannot be replicated by a graph with no transform
on the path, in either direction. Keep the source's spelling and publishing refuses it. Sanitise it
to `Asset_Id` and leave `columnName` as `Asset Id`, and the store asks each record for `Asset_Id`,
the record has `Asset Id`, the answer is `undefined`, and `undefined` is written as null in every row
of every run forever while the load reports success. The second is the naive fix and is exactly what
produced the six null types; `columnName` is display metadata and is never a lookup key.

`fix/view-alias-sanitised` proposes making the alias sanitise so a property could keep the source's
spelling end to end. **It has not landed** — the branch carries no commits and the publish-time
refusal is still in force. So "Replicate a table" and "Load a file drop" **refuse**, name every
offending column, and say what the remedy is, rather than encoding the guess. A column list nobody
has discovered is *also* a refusal: proceeding on silence is asserting the names are fine because
nobody looked, which is how the six were built.

## What every template obeys

- **It does not hide the decision.** A plan is plain nodes, edges, transform bodies and expectation
  payloads — no template object survives into the saved workflow, and every declaration carries a
  `changeAt` saying where to undo it.
- **It does not claim a mode it cannot justify.** Nothing offers `incremental`: it is refused
  outright without a delete declaration and needs a watermark column no template can know.
- **It does not restate a list.** Source kinds are a `Record` over `ConnectorKind`, starter code a
  `Record` over `TransformLanguage`, node construction a mapped type over `WorkflowNodeKind`. A kind
  or language added to the library without a line here is a compile error, not a template that
  quietly stops covering it.

The templates are shipped by the library rather than stored per deployment, deliberately: they are
decisions, and decisions belong in code where they are reviewed and carry their reasoning.
Per-deployment templates are a store concern and a separate change.

## Also here

`isSafeIdentifier` and `UnsafeIdentifierError` moved into a dependency-free `catalog.identifiers.ts`
and are now exported from `@dudousxd/nestjs-catalog/client` as well as the package root. They used to
sit in `catalog.store.ts`, which imports `@nestjs/common` at module scope, so a browser could not
reach them without dragging NestJS along — and a canvas that answered "can this be a property name?"
from its own copy of the pattern would be the fourth definition of a rule whose own docblock says one
definition is the guarantee and two identical ones are a habit. Every existing import path still
works; `catalog.store.ts` re-exports all three.

## Not shipped

Reading an already-published catalog type as a source — to build a derived or aggregate type — is
**not reachable**. `CONNECTOR_KINDS` is `http`, `sql`, `file`, `s3`, `inline`, and none of them reads
the catalog's own warehouse. It is the natural next template and it needs a connector kind first.
