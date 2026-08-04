---
"@dudousxd/nestjs-catalog": minor
"@dudousxd/nestjs-catalog-store-mikro-orm": minor
"@dudousxd/nestjs-catalog-react": minor
---

A type now says when its data was last committed

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
and *fresh*, so every staleness signal reports it healthy.

The Model screen shows the age beside the table name, marks what has not
committed in a week, and puts the count and the publisher in the tooltip. It is
not a health verdict — the catalog cannot tell a deleted publisher from a
monthly load, and a type labelled "orphaned" is a type somebody deletes on the
strength of a guess. `freshnessOf` and `isWorthFlagging` are exported for hosts
that want the same words elsewhere.
