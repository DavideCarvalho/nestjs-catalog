---
'@dudousxd/nestjs-catalog': minor
'@dudousxd/nestjs-catalog-pipeline': minor
'@dudousxd/nestjs-catalog-store-mikro-orm': minor
'@dudousxd/nestjs-catalog-react': minor
---

A graph exists because somebody made it, not because a boot hook inferred it

Boot-time connector adoption is removed entirely. A workflow now comes into
existence only because something explicitly created it through the API. `minor`
and not `major` on purpose — this is 0.x, and the project versions on that basis
rather than on whether behaviour was withdrawn.

**Why it goes.** Adoption wrapped every pre-workflow connector into a
single-source, single-sink graph at boot and published it as `ready`. The wrap
was validated, so `ready` was true in the narrow sense — it meant "this
validated". It was false in the sense the word is actually read on that screen,
which is "somebody looked at this and said it was finished". The console had
grown a badge and a paragraph to explain that a pipeline marked ready had no
author, which is the tell: a status that needs a note beside it saying it does
not mean what it says is the wrong status, and the honest fix is to stop minting
it rather than to keep apologising for it. Publishing is a decision, and a
process starting up is not somebody deciding.

**Gone.** `ConnectorAdoption` and the `CATALOG_ADOPT_CONNECTORS` token, the
`adoptConnectors` module option and its entry in `CATALOG_PIPELINE_TOKENS`,
`CatalogWorkflowStore.adoptConnector` with its MikroORM implementation and the
environment-routing delegation, and — on the console — the `adopted` badge, the
"adopted at boot" note, `wasAdopted` and `WORKFLOW_ADOPTION_ACTOR`.

**No migration, because there was never a column.** "Adopted" was never stored.
It was derived at render time from `createdBy === 'connector-adoption'`, so
there is nothing to drop and nothing to rewrite. Graphs adopted by an earlier
release keep working exactly as they did; the string in `createdBy` stops being
read as a marker and reads as what it is, the name of whatever authored the row.

**Nothing was keyed on the adoption.** The connector id is what a run history,
the singleton mutex and the incremental watermark hang off, and it is
`publishWorkflow` -> `mintConnectorFor` that ties a connector to its graph — the
ordinary publish path, untouched here. Adoption borrowed that machinery for
already-existing rows; it never owned it. Watermarks already re-keyed under a
source node stay re-keyed, and no incremental source falls back to a full read.

**What an upgraded deployment sees.** A connector that predates workflows is no
longer wrapped into anything. It keeps loading on the path it was already on,
`GET connectors` still reports it, and no route can edit it — the same standing
consequence `adoptConnectors: false` always had, now the only behaviour. A
deployment with connectors and no workflows therefore shows an empty
`#workflows`, so the canvas gains an empty state that says so: that nothing is
missing, that this deployment has simply never had one drawn, and that
connectors already loading data are not shown there and nothing will turn them
into workflows on their own. Three states rendered identically before — a first
run, a graph whose nodes were all deleted, and a list that failed to load — and
only one of them was speaking.
