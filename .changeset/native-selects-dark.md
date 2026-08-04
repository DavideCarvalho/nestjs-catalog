---
"@dudousxd/nestjs-catalog-react": patch
"@dudousxd/nestjs-catalog-dashboard": patch
---

Every dropdown follows the theme, because none of them is a native select any more

Six controls were raw `<select>` elements against sixteen using the vendored
one. A native select draws its option list with the platform's own widget: the
list stays light on a dark console and no class can reach it. On the dark
surface the console now wears, they were unreadable.

They are all `Select` now — the Base UI one this package already vendored — so
the list is markup that inherits the theme like everything else. Converted: the
environment picker in the nav, the card's chart-library picker, both governance
filters, and both visualization pickers in the save panel.

Two things fell out of the conversion:

- The options that needed a **second line** can have one. `SelectOption.hint`
  already existed, described as "the reason a native option was not enough", and
  it is exactly what the card picker's default needed to say the query names a
  library nobody installed. A native `<option>` is one line of unstyleable text.
- The chart-kind picker had a `as 'table'` cast on the raw event value. It is a
  lookup against one exported list now, which the picker also renders from — so
  a kind added to the union appears in the dropdown instead of being silently
  absent from it.
