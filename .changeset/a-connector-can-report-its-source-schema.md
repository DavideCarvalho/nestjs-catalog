---
"@dudousxd/nestjs-catalog-pipeline": minor
"@dudousxd/nestjs-catalog-react": minor
---

A connector can report the schema of the source it reads

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
