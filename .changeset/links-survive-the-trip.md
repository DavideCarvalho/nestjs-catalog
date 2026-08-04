---
"@dudousxd/nestjs-catalog": minor
"@dudousxd/nestjs-catalog-store-mikro-orm": minor
"@dudousxd/nestjs-catalog-pipeline": minor
---

Links survive publishing, and survive a promotion

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
