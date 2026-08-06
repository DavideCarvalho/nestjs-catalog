---
'@dudousxd/nestjs-catalog': minor
'@dudousxd/nestjs-catalog-store-mikro-orm': minor
'@dudousxd/nestjs-catalog-store-clickhouse': minor
'@dudousxd/nestjs-catalog-pipeline': minor
---

A property may be named the way its source spells it, and the publish check refuses only what
genuinely cannot become a column.

A store matches a source's record to a property by property NAME — it reads `row[property.name]` —
and nothing on the write path consults `columnName`. But the name was also written *verbatim* as the
output alias of the committed view and of every read, through an `ident` that refuses rather than
escapes, so a property could not be called `Asset Id` at all. Publishers therefore did what the
refusal told them to do: renamed the property to `Asset_Id` and put the source's spelling in
`columnName`. Thirteen types were loaded that way and six came out with most of their columns NULL —
73 of 84 on the largest, across 313,833 rows — with every run green, every row count right, and
nothing visible short of opening a cell.

- **The view's output alias and the read's alias now go through `outputAlias`**, in both shipped
  adapters (`query.ts` and the store in each of `store-mikro-orm` and `store-clickhouse`). A name
  SQL cannot take is cleaned to its physical column; **a name SQL can take is kept byte for byte**,
  so no view that resolves today changes shape. The two names that would otherwise have moved — one
  whose doubled underscores would collapse, one over 60 characters — are pinned by tests.
- **The publish-time refusal asks the question it actually needs to**: does this name *clean* to an
  identifier? `Asset Id` does and is accepted; `2024 Total` does not, because `2024_Total` starts
  with a digit, and is still refused before a single row exists. The refused value named in the
  message is the cleaned one, which is exactly the string `ident` would refuse, so publish-time and
  DDL-time still say one sentence about one string. Length alone can no longer refuse a name, since
  the cleaning cuts at 60 and the rule allows 63.
- **The refusal message now says what a rename costs.** Taking the suggested name means the load
  looks up `row[<new name>]` in records the source still keys by the old one, so the message names
  `row[name]` and says a transform has to go with it. That sentence is the one whose absence turned
  a correct refusal into six empty tables.
- **`physicalColumn` moved to `@dudousxd/nestjs-catalog`** and is re-exported by both adapters
  unchanged. It was three byte-identical private copies — two of them inside `store-mikro-orm`, one
  deciding the view's columns and one deciding the table's — and it is now what decides whether a
  published name can work at all, so the publish check and the DDL run the same function rather than
  copies of it. `outputAlias` lives beside it. Both are new named exports; nothing was removed.

**What an existing deployment sees: nothing.** Every property name stored today is a SQL identifier,
because the old publish check demanded one, and `outputAlias` returns such a name unchanged — so
every view keeps every column it has, `read()` still returns rows keyed by the property's own name,
and no migration or republish is needed. What changes is what a *new* publish may say, and one
repair: a type that picked up a name like `Asset Id` before the publish check existed used to fail
at every commit and be warned about on every publish. It now cleans to a column like any other, so
it works and the warning correctly stops.
