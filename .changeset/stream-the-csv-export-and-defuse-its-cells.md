---
'@dudousxd/nestjs-catalog': minor
'@dudousxd/nestjs-catalog-store-mikro-orm': minor
'@dudousxd/nestjs-catalog-store-fanout': minor
---

Stream the CSV export, and stop a cell in it executing when somebody opens the file.

`GET saved-queries/:id/export.csv` ran the query, held the result, built the whole CSV string and
then answered. That is the same shape that stopped a 981,469-row connector load ever finishing, and
it is worse on an export, because an export has no row cap by design: the point of it is to take
everything.

- **Rows are written to the response as they arrive.** `CatalogQueryStore` gains an optional
  `streamQuery`, `csvLines` turns an async row source into CSV a line at a time, and the handler
  returns a `StreamableFile` over it. `@Res({ passthrough: true })` is unchanged and still correct —
  what changed is the returned value, because the express adapter answers a *string* body with
  `res.send()`, which sets a `content-length` on a body nobody has counted. The response is now
  chunked and carries none. Back-pressure runs the whole way: the pipe stops when the socket is full,
  the readable stops pulling, and the generator stops asking the store — so a slow client slows the
  database read rather than filling this process. A client that abandons the download tears the
  readable down, which runs the generator's `finally`.
- **The export is no longer capped or cached** on a store that streams. `maxQueryRows` bounds a
  screen's page; a capped export is a prefix handed over as a complete file. The cache is skipped in
  both directions — it holds a capped page, and filling it from an export would put the whole result
  in the object the cache exists to avoid. No statement timeout is applied either: an export of a
  large table legitimately runs for minutes, and the bound that matters for it is that no stage holds
  more than a row.
- **`MySqlWarehouseStore` implements `streamQuery`**, on MikroORM v7's Kysely-backed
  `connection.stream()` inside a real `READ ONLY` transaction handle — passing the handle matters,
  since a stream executed on some other pooled connection would be protected by nothing. The rollback
  is in the generator's `finally`, so it runs when a consumer stops early. `FanoutCatalogStore`
  forwards it when its primary has it; `RoutingCatalogStore` forwards it per environment.
- **A store that cannot stream keeps the capped buffered read**, and the truncation is logged.
  Lifting the cap there would not make the export complete, it would move the failure into a driver
  that has no cap to report. `ClickHouseWarehouseStore` is in this group today.
- **A cell whose value would be read as a formula is neutralised.** `=`, `+`, `-` and `@` all start
  an expression in Excel and Sheets, including through leading blank the importer strips first and
  including a leading tab or carriage return, and the values here come from whatever the queried
  source contained. Such a cell is prefixed with `'`. **A value that is plainly a number is exempt**,
  so `-42` still reads back as `-42` for a machine: a spreadsheet evaluates `-42` to the number it
  already was, so there is nothing there to defend against, and the apostrophe is a real cost —
  outside a spreadsheet the cell now carries a character the database did not have. The guard runs
  before the CSV quoting, so a value that needed both comes out as `"'=1+1,x"`, escaped once.

`toCsv` keeps its name, its signature and its bytes, and moves from `catalog.query-cache` to
`catalog.csv` alongside `csvLines`, `csvCell` and `guardFormula`; the package entry point exports all
four. Its output changes only where the formula guard applies.
