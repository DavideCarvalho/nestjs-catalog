---
'@dudousxd/nestjs-catalog-store-clickhouse': minor
'@dudousxd/nestjs-catalog-store-fanout': minor
---

Two stores that can filter now say so, and ClickHouse stops keeping its own copy of the reserved
column list.

**`store-clickhouse` and `store-fanout` declare `objectFilterOperators`.** The design is that a
store *declares* which operators it can push into a predicate: the service offers a screen exactly
those and refuses a filter naming anything else, so a store that ignores a filter can never answer
with more rows than were asked for. That part worked. What was missing was the declaration on two
stores that can, in fact, filter — so a ClickHouse deployment and a fan-out deployment each got no
filter controls at all, and a hand-built filter came back as a refusal, for stores with a perfectly
good WHERE clause available the entire time.

- **ClickHouse applies all nine operators**, in the same `where` its `count()` and its page both
  read from — a filter on the page and not the count is a screen showing three rows above the words
  "of 4,812". Two predicates are not MySQL's, and deliberately: `empty`/`notEmpty` compare against
  `''` only on the text types, because ClickHouse refuses `Nullable(Float64) = String` outright
  where MySQL coerces it, and `contains` is `ILIKE` rather than `LIKE`, the same choice the search
  box already makes so that a control does not behave differently depending on which adapter is
  mounted. `eq` is left case-sensitive, which is a real difference from MySQL's default collation
  and is stated rather than papered over: matching it would mean lowering both sides of every
  comparison, forfeiting the sparse index, and still not matching, since that collation is
  accent-insensitive too. A filter on a column the same read did not select is refused, as on MySQL:
  a predicate over a hidden or classified column leaks it through row membership.
- **The fan-out reports its primary's operators**, and reports nothing when the primary declares
  nothing — `read` is the primary's `read`, so that is the only answer it can keep. Not intersected
  with the followers, unlike the capability object: nothing routes an ordinary read to a follower,
  so intersecting would remove the filter controls from a catalog that filters fine for the sake of
  a store nobody reads. The one read path that does leave the primary, `readFrom(name, ...)`, now
  **refuses** a filter the named store cannot apply — otherwise a follower that filters nothing
  returns its whole table and the operator comparing it against the primary before a flip reads that
  as the follower holding extra rows.

**`RESERVED_COLUMNS` in `store-clickhouse` is `CATALOG_RESERVED_COLUMNS`,** re-exported rather than
rebuilt. The file's own docblock already said the identifier rule came from the core package "next
to `CATALOG_RESERVED_COLUMNS`, and taken from there for the same reason that list is" — and the list
was not taken from there. It was assembled locally and agreed with the core's by coincidence, which
is what let the claim survive being read. The two lists were byte-identical, so nothing changes for
a deployment; what changes is that they can no longer come apart. The five per-column constants stay
(the DDL and the SELECT lists need each name on its own) and both adapters now assert that those
constants and the shared list still describe the same set — the half a re-export cannot give you,
and the failure `_row` already caused once.
