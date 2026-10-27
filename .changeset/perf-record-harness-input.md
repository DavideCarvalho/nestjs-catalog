---
"@dudousxd/nestjs-catalog": patch
---

The per-record JavaScript harness no longer rescans a long input line from its start for every
chunk of it that arrives on stdin, which was quadratic in the line's length (a single large record,
or a line of many records).
