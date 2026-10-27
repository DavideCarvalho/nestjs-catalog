---
"@dudousxd/nestjs-catalog-pipeline": patch
---

Read CSV and NDJSON sources faster. The CSV scanner now jumps between quotes, delimiters and
newlines with `indexOf` and appends the text between them as one slice, instead of making a
function call and a string append per character; quoting, `""` escapes, `\r` stripping and every
other quirk read exactly as before. NDJSON no longer re-splits a long line from its start each time
another chunk of it arrives, which made a line spanning many chunks quadratic.
