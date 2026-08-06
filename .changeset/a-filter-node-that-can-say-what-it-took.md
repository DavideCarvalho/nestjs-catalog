---
"@dudousxd/nestjs-catalog": minor
"@dudousxd/nestjs-catalog-pipeline": minor
"@dudousxd/nestjs-catalog-react": minor
"@dudousxd/nestjs-catalog-store-mikro-orm": minor
---

A filter node, whose predicate is a structure rather than code

A transform can already filter — it takes rows and returns rows, so returning a
subset filters — and this file's own node-kind list used to reject `filter` for
exactly that reason. That argument is sound about *code*, and it is why this
node does not take any. What changed is the predicate: a closed structure of
column, operator and value, combined with `all`/`any`, which is a thing
something other than a JavaScript engine can read.

Three reasons the kind earns itself, and the third decides the shape. It is
legible on the canvas without opening anything. Its effect is **reportable** —
the node records rows in beside rows out, so a run panel can say what was
dropped, where a transform records one number and a transform that quietly
started dropping 90% of its input looks identical to a source that got smaller.
And only a declarative predicate can be pushed into the source as a `WHERE`.
That last one is not a micro-optimisation: filtering `obj_pribuybuylistdetail`
in memory means every one of 7,637,391 rows is read off disk, crosses the
network, and becomes a JS object of ~80 properties before anything decides it
was unwanted.

**The pushdown is not built, and this ships saying so rather than implying it.**
The mechanism it would reuse already exists — `boundStatement` in `sources.ts`
wraps an author's query as `SELECT * FROM (…) WHERE …` with the identifier
quoted per dialect and the value bound — but `SourceFetcher` takes a connector,
a secret, a watermark and a mode and knows nothing about the graph, while the
runner that does know the graph dispatches by connector kind alone; threading a
predicate through also drags in schema discovery, which shares `sqlTarget`.
There is a second reason and it is the more interesting one: a pushed-down
filter cannot honestly report rows in, because the rows it removed were never
read — reason three deletes reason two, and recovering the number means a
`COUNT(*)` over the unfiltered query, which is the scan the pushdown was for.
Those are decisions, not typing, so they belong to the change that makes the
move. What is *not* deferred is the part that would have made it impossible
later: the predicate is closed, its columns already have to match the identifier
pattern `boundStatement` requires, and every comparison follows **SQL's
three-valued logic** — a null column fails every test including the negative
ones — so pushing it down cannot change which rows a type ends up holding.

Meanwhile it runs in memory **one staged batch at a time**, never over the whole
input. The obvious implementation is `readInputs()` then `.filter()`, and that
is the shape that spent a day of this project's life stalling everything sharing
a database: one synchronous pass over millions of objects holds the event loop
for its whole duration. Survivors are coalesced back into full batches, so a
filter keeping one percent does not write fifteen thousand stage rows of five.

**The trap it had to be designed against**, and the reason `WorkflowFilterNode`
carries `narrows`: dropping a filter onto a working `source → sink` wire
replaces the published snapshot of that type with a subset, silently, because
from the run's point of view everything succeeded. Filtering to *derive a new
type* and filtering before *recommitting the same type* are structurally
identical graphs — the only difference is what the name on the sink already
means to the people reading it — so no rule over the shape can tell them apart
without inventing a signal. The graph therefore makes the author **name the
types**, and `validateWorkflow` requires it exactly where it matters and refuses
it everywhere else: every full-mode sink this node is the only path to must be
listed, and nothing that it is not. A filter on one of several paths into a
sink, or in front of an incremental one, narrows nothing and may not claim to.
The consequence is the intended one — that dragged-on filter produces a graph
that will not save until somebody writes down the name of the type they are
about to shrink. The sink's `maxShrink` bound is unchanged and still the last
word at run time.

`WorkflowNodeOutcome.rowsIn` is new and optional, and absent is not zero: a node
that never reported an input count and a filter that was handed nothing are
different facts, and defaulting would make every outcome stored before this
exists read as having dropped everything it produced.

Existing graphs are untouched — a graph with no filter in it hashes to exactly
what it always did, which is pinned by a literal recorded from the previous
build. Every per-kind decision still fails to compile when a kind is missing
from it; adding this one found seven such places on the way in, and turned up a
narrowing bug worth knowing about: TypeScript will **not** remove a union member
whose discriminant is itself a union of literals, so an `all`/`any` group
written as one interface silently disabled the exhaustiveness check for both.
It is two interfaces over a shared base for that reason.
