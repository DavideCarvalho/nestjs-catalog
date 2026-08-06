---
"@dudousxd/nestjs-catalog-store-mikro-orm": patch
---

The second a write lands in is not the second it was written in

`stored-registry.staleness.db.spec.ts` — the only place two real
`StoredCatalogRegistry` instances meet one real MySQL, and so the only evidence
that a replica heals itself — failed ten runs in twenty, every one of them the
case that asserts a replica which nothing has written to does **not** rebuild.

The cause is a difference between how MySQL stores a timestamp and how it reports
the time. `updated_at` is a `DATETIME(0)`, and MySQL **rounds** a fractional
second into it rather than truncating; mysql2 sends the millisecond the row was
written, so a write at `…:32.600` is stored as `…:33` — up to half a second ahead
of the instant it happened. `NOW()` truncates. `settledAt` compares the two, so a
write stays "inside the second the database is still in" for up to 1.5s, not 1s.
The spec waited a flat 1,100ms before opening its second registry, which is
enough only when the write's millisecond happens to be below .500; above it, the
sibling's watermark was recorded as untrustworthy and the replica correctly
rebuilt on every check for the rest of that second, which is exactly what that
case exists to say must not happen. Caught in the act: `type_at` came back
`03:45:57` from the same statement whose `db_now` was `03:45:56`.

The engine was right and the test was guessing. Nothing in the file waits a
chosen duration for the database any more — it asks the database the same
question `settledAt` asks, and proceeds when the answer is yes, which is exact
under rounding, under a cold container's slow first statements and under clock
skew between the process and the server. No timeout was widened and no assertion
was weakened: mutating the registry so it never re-reads its watermark still
turns four of the five cases red.

`settledAt`'s docblock is corrected along with it. It claimed the provisional
window cost "at most one extra rebuild per write, because the following check
happens at least `staleAfterMs` later and the second has closed by then". Under
rounding it has not necessarily closed, and at the default `staleAfterMs` of 1000
the real bound is two. Still bounded, still per write rather than per request —
but the reasoning as written was wrong, and it is the reasoning this flake was
hiding behind.
