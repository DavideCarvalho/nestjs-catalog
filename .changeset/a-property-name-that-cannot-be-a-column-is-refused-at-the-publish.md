---
"@dudousxd/nestjs-catalog-pipeline": minor
---

A property name that can never be a column is refused at the publish, not at the load

`PUT :type/schema` accepted `{"name": "Asset Id"}`, stored it, and answered 200.
The refusal — `Refusing to use "Asset Id" as a SQL identifier: letters, digits
and underscore only, …` — arrived at the first commit, which is after the
connector has read the whole source and written every row of it. An observed run
reported `fetched=6905, written=6905` and then discovered the schema could never
have worked. Real column headers look like this: `Asset Id`, `Work Order Id`,
`Asset LIN/TAMCN`.

Everything needed to answer the question is in the publish payload, so
`upsertType` now answers it there: before the row is created, before the flush,
before `ensureType`. The rule is not restated — `identifierRefusal` runs the
store's own `ident` and hands back the error it raises, so the publish-time
refusal and the DDL-time one cannot come to disagree about the character set,
the length or the wording.

The refusal names every offending property, not the first, and offers the
payload that would have worked: `{ "name": "Asset_Id", "columnName": "Asset Id"
}` — the shape the API already supports, where `columnName` is free-form by
design and is what the loader looks up in the source record. A `columnName` the
caller already sent is kept rather than overwritten. Nothing is sanitised on the
caller's behalf: `name` is how the catalog, every query and every row a
publisher sends refer to the field, and quietly rewriting it would leave the
next batch — still keyed by `Asset Id` — writing nothing into that column.

**A name a type already holds is warned about, not refused.** `upsertType` only
ever adds properties and nothing anywhere removes one, so refusing the republish
of a type that picked up `Asset Id` before this check existed would leave a type
nobody can now repair — including the publisher trying to add the correctly
named property beside it. Those types republish exactly as they did, their
commits keep failing exactly as they did, and the log now names the properties
and says that fixing them means the database or a new type. A *new* bad name on
that same republish is still refused.

New exports: `identifierRefusal`, `isUnpublishableName`,
`refuseUnpublishablePropertyNames`, `describeStoredUnpublishableNames`.
