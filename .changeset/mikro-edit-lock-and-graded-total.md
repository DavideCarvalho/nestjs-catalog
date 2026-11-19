---
"@dudousxd/nestjs-catalog-store-mikro-orm": patch
---

Two concurrent edits of one saved query no longer fail. `updateSavedQuery` read the row with no lock, so two edits could both read version N and both write revision N + 1, and the second failed with a raw unique-key violation on `catalog_revision`. The edit now runs in one transaction and reads the row with `PESSIMISTIC_WRITE`, so the second edit waits and becomes version N + 2.

An outcome-filtered trace page past the last one now reports the real total instead of 0, counted the way `traceTotals` counts.
