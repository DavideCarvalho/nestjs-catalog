---
'@dudousxd/nestjs-catalog': minor
'@dudousxd/nestjs-catalog-pipeline': minor
'@dudousxd/nestjs-catalog-store-mikro-orm': patch
---

Refuse a published link that cannot mean anything, at the moment it is published

A relation drives no DDL, is never joined on, and nothing downstream fails over
one. That sounds harmless until you see what each wrong shape *renders* as.
Measured against a live catalog: eight pathological payloads, all stored, all
answered 200 — a `targetType` of `"NoSuchType"`, a `localKey` naming nothing, a
`1:m` claiming `owner: true`, `"kind": "sometimes"`, a duplicate name, an empty
name, and `{ "name": "sparse" }` with no kind and no target at all.

The sharpest is the kind. An unrecognised one is narrowed to `m:1` on read, so
`"kind": "sometimes"` published cleanly and the graph then drew a many-to-one
arrowhead nobody chose. None of these is a failure anybody sees; they are a
diagram that is quietly wrong, which is the one thing a diagram must not be.

`PUT publish/:type/schema` now refuses, before a row is created or flushed and
before `ensureType`, a link that: has no `name`, reuses a `name` another link on
the same type already took, has no `targetType`, has a `kind` outside the four,
or is a `1:m` declaring `owner: true`. All of them at once rather than the first,
and each with a sentence saying what the field is read for. `relation-shape.ts`
holds the rules and the argument for each.

**Two obvious rules are deliberately absent, and the file says why.**

A `targetType` this catalog does not hold is *not* refused. It is a designed
state — `targetPublished` exists to carry it, the graph already omits the edge
rather than promising a node nobody can open, and `FlowView`'s cross-publisher
lane treats it as its sharpest signal. Refusing it would also make publishing
order load-bearing: of two types pointing at each other, whichever went first
would be refused for naming a type that does not exist *yet*.

A `localKey` that is not a property of this type is *not* refused either, and
this is the one that would have broken the most. The field is documented as a
property name, but `MikroOrmCatalogRegistry` fills it from `prop.fieldNames[0]` —
the physical **column** — so a `@ManyToOne` called `base` reports `base_id`,
which is not a property of that type and never will be. Publishing a derived
`CatalogRelationDef[]` verbatim is a documented case, and refusing that payload
would refuse it. The field is genuinely two-valued today; unifying it is a model
change rather than a validation.

Also: `RELATION_KINDS` and `isRelationKind` are now exported from
`@dudousxd/nestjs-catalog`, and the three private copies of that closed
four-element set — one in each registry, one needed for the new refusal — are one.
The copy in `catalog.registry.ts` needed a cast to check against itself; it is
gone with the copy.

No stored graph is renumbered and no `workflowGraphHash` moves.
