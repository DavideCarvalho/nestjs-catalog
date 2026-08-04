---
"@dudousxd/nestjs-catalog": minor
"@dudousxd/nestjs-catalog-store-mikro-orm": minor
"@dudousxd/nestjs-catalog-react": minor
---

The ontology has links.

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
