---
"@dudousxd/nestjs-catalog-store-mikro-orm": patch
---

The activity screen pages off an index instead of grading the whole trail

`GET catalog/events/traces` cost work proportional to the entire audit table on
every request, no matter that it returns 25 traces. On 21k rows the default page
took 151ms against 11ms for the unaggregated `GET catalog/events` beside it; on
622k rows it took 9.2s, with one sample at 216s.

It was not a missing index. The table's four indexes are the right four, and the
statement could not use any of them: every filter was written against a `scoped`
CTE — the whole linked half of the table, `detail` column included, spooled into
a temporary table — rather than against `catalog_audit_event`, so there was
nothing indexed left for the optimiser to reason about. `EXPLAIN ANALYZE` showed
the table read three times and sorted once to return 289 span rows.

Two changes. Every CTE now reads the base table, so the conditions reach the
indexes. And when the caller has not filtered by outcome — which is what the
explorer asks on load — the page is chosen *before* anything is graded, by
`GROUP BY snapshot_id ORDER BY MIN(occurred_at)`, which MySQL answers as a
covering skip scan over `(snapshot_id, occurred_at)` without reading a row.
Aggregation, JSON parsing and the span join then run over the ≤ 200 traces that
survived rather than over everything ever recorded.

Measured through the store against MySQL 8.0, median of seven:

| | 21k rows | 622k rows |
|---|---|---|
| default page | 151ms → **20ms** | 9,234ms → **453ms** |
| `?offset=500` | 150ms → **25ms** | 7,760ms → **550ms** |
| `?type=…` | 19ms → 18ms | 1,701ms → **666ms** |
| `?outcome=failed` | 140ms → 104ms | 5,322ms → 3,818ms |
| `?outcome=failed&since=…` | 27ms → 38ms | 2,181ms → 1,566ms |
| `traceTotals` | 141ms → 140ms | 6,711ms → 5,422ms |

Filtering by outcome still costs a pass over every matching trace, and that is
not a shortcoming of the statement: an outcome is `CASE` over
`JSON_EXTRACT(detail, '$.status')`, so no index can answer "which traces failed"
before the grading it is derived from has happened. Pass `since` — every caller
in this repo that filters by outcome already does.

**No DDL, and nothing to run against a deployed database** — except one thing
worth knowing: if `catalog_audit_event` was loaded in bulk rather than grown a
row at a time (a restored dump, a backfill), run
`ANALYZE TABLE catalog_audit_event` once. Choosing the page needs no statistics,
but the two span joins do: with statistics MySQL has never gathered it prices a
scan of the table at `0.102` and hash-joins instead of looking each trace up —
138ms against 415ms for the identical statement on a 173k-row table. A trail
that grew normally gets this from `innodb_stats_auto_recalc`.

Behaviour is unchanged with one improvement: a page past the end of the list now
reports how many traces there are, instead of answering an out-of-range offset
with "there are none". The lifecycle rank that orders a same-millisecond trace is
untouched, and `audit-trace.db.spec.ts` now holds it against a real MySQL with a
fixture written backwards on one timestamp, so that only the rank can put it
right.

Nothing prunes `catalog_audit_event`, `catalog_connector_run` or
`catalog_snapshot`, and this does not change that — the default page no longer
grows with the table, but the outcome path still does. The retention note in
`audit-recorder.service.ts` argues the shape it should take, and why capping the
window would be worse than a slow screen: a page that silently truncates reads
as "this is everything", on the one screen whose job is to say what happened.
