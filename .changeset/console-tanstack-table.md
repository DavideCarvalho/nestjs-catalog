---
"@dudousxd/nestjs-catalog-react": minor
---

Every table on TanStack Table v9

Four screens hand-rolled `<table>` markup with the same header row, the same
hairlines and the same "numbers go right" rule, each slightly differently. They
now share `ui/DataTable`, and there is no raw `<table>` left outside `ui/`.

**Sorting is a prop, not a row model, and that is the load-bearing decision.**
The object explorer sorts, pages and searches on the SERVER, because it reads a
warehouse table that does not fit in a browser. Handing those columns to
`createSortedRowModel` would sort the rows currently on screen and present the
result as though it were the whole answer — a worse bug than no sorting at all,
because it looks right. So the header renders the affordance and reports the
click, and the caller decides whether that means a refetch or a reorder. A test
asserts the rows come out in the order they went in.

What each screen gained:

- **Query results** and the **dashboard card preview** shared a value-rendering
  ladder that they each had a copy of. `renderUnknown` is now one function, and
  it keeps `0`, `false` and `''` visible — the `value || '—'` shorthand erases
  all three and nothing reports it.
- **The object explorer** keeps its server-side sort, and `aria-sort` moved onto
  the column header where a screen reader announces it as part of the column;
  on the button it read as "this control is sorted".
- **The property editor** declares its six columns once, with their widths beside
  their contents rather than in a separate header row kept in the same order by
  hand. The widths stay fixed on purpose: those cells hold inputs, and a
  content-sized column reflows the table on every keystroke.

`@tanstack/react-table` joins the peer dependencies at `>=9`. v9 is opt-in per
feature rather than v8's batteries-included table, so a table that never groups
does not ship the grouping code — this one registers the core features and
nothing else. Two things about its API worth knowing: the row model factories
live inside `features` rather than in a sibling option, and `useTable` needs
explicit type arguments, because `columns` and `data` are two inference sites
for the same pair and TS falls back to the constraints with a third parameter
in play.
