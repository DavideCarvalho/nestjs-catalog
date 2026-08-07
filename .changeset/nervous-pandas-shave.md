---
'@dudousxd/nestjs-catalog-store-mikro-orm': patch
'@dudousxd/nestjs-catalog-pipeline': patch
---

Fix: a transform created without a mode broke the transform list route

Create a transform the ordinary way — `POST /pipeline/transforms` with a name,
a language and some code and no `mode` — and the very next
`GET /pipeline/transforms` answered **500**, for every transform in the catalog,
not just that one. Any workflow run reaching a transform node pointed at that
row failed with it.

The `mode` column is nullable, so a transform saved without one holds SQL NULL.
The read path tested the absent case as `row.mode === undefined`, missed the
`null`, and handed it to the loud enum guard, which refused it with

> Transform mode "null" on t-… is not one this build knows about. It was most
> likely written by a newer version of the catalog.

— blaming the data for being newer than the build when the value is simply not
there. This was not an upgrade-only hazard: the write path and the read path
disagreed on a database created the same morning. Absent is now `null` or
`undefined`, and an unrecognised *value* is still refused loudly with the same
message.

Also: `expectShrink` on `POST /pipeline/workflows/:id/run` is now checked at the
route. It is typed as a reason (text) and was checked nowhere, so
`{"expectShrink": true}` reached the sink and crashed with
`TypeError: expectShrink.trim is not a function` — a 500 for a bad request,
raised only after the whole source had been read, renamed and filtered. A
non-text reason is refused with a 400 before the run opens. Absent and a present
empty string are unchanged: the first means nobody said anything, the second is
still refused by the sink with its own 400 asking for a reason.
