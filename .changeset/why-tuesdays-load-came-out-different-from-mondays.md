---
"@dudousxd/nestjs-catalog-react": minor
---

Why Tuesday's load came out different from Monday's

A connector run records `transformVersion` and the runs list has been rendering
it as `code v3` — a number naming code that existed nowhere, because a
transform's `version` counts saves of a row overwritten in place. Revisions fix
the storage. This is the screen on top of them.

`code v3` on a run is now a control. Pressing it opens the version that **ran**
against the version that is **current**, which is the comparison somebody
standing in front of a surprising load actually wants, rather than a pair of
dropdowns and a version number to carry across screens. The two selects are
there as the fallback, defaulted so nobody has to touch them. The same panel is
reachable from the transform editor and from a row in the saved-query list.

**No dependency was added.** The line diff is `diffLines` — an LCS over the
changed region after trimming the common prefix and suffix, in a file with no
imports. A transform is executable code and a saved query is somebody's SQL
against real data; those are the two strings in this product least worth handing
to a package on every render, and this package already declines dependencies for
weaker reasons (`charts/css.tsx`, `ui/button.tsx`, `export/pdf.ts`). `diffLines`
and `foldUnchanged` are exported, so a host can render the comparison its own way
without writing one.

Long bodies: unchanged stretches fold to a control that opens them, three lines
of context either side; the row count is capped and says how many it is holding
back. Line **content** is never truncated — two lines cut into equality would be
reported as unchanged, which is the one thing a diff must not do. That is why
this does not follow `capLines`, whose bound is about what a checkpoint may hold
rather than what a reader may see.

An empty history is honest about being empty. "Nothing recorded", "one version
recorded", and "the run used a version the history does not contain" each say so
in their own words, and none of them borrows the sentence that belongs to two
versions that really are byte-identical.
