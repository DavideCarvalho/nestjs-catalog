---
"@dudousxd/nestjs-catalog": patch
"@dudousxd/nestjs-catalog-react": patch
"@dudousxd/nestjs-catalog-pipeline": patch
"@dudousxd/nestjs-catalog-store-mikro-orm": patch
"@dudousxd/nestjs-catalog-store-fanout": patch
"@dudousxd/nestjs-catalog-store-clickhouse": patch
"@dudousxd/nestjs-catalog-telescope": patch
---

Clear the lint backlog — 63 warnings to 0, mostly by extraction

Behaviour is unchanged throughout; what moved is where the code lives.

**Two `any`s in `sources.ts`** became interfaces declaring only the methods this
package calls, with rows staying `unknown[]` because that is the boundary where
the type genuinely is unknown. No assertions were added.

**Two functions were doing several separable jobs.** `planPromotion` (61) split
into a section per kind, and `validateWorkflow` (75) into the checks its own
comments already named. `workflowRunOrder` now reuses `buildAdjacency` rather
than rebuilding its own indegree map — its docstring already argued that "two
implementations of one rule is how a graph that validated comes out executing
differently", and it was doing exactly that.

**The vendored chart files are handled by config, not by comments.** 79 files
under `charts/bklit/` carry a header promising "nothing else is modified, so
re-syncing with upstream stays a diff rather than a merge". A scoped `overrides`
entry keeps that promise, and it made nine pre-existing suppressions redundant —
so those files now have FEWER local edits than before, not more.

**Three suppressions survive, each with the reason written beside it:**

- A telescope event renderer whose docblock asserts every branch emits only
  names, never data. That is a security property auditable in one screen
  precisely because the branches are adjacent; splitting them into four
  functions would spread it where it can no longer be read at once.
- `SelectField`'s `<label>`: `Select` renders a BUTTON, and a label does not
  implicitly name a button — which is why `Select` already required an
  accessible name of its own. `ariaLabel` now defaults to `label` so the common
  case cannot forget it, while still allowing the fuller name the call sites
  deliberately use ("Kind" on screen, "Connection kind" announced).
- `Switch`'s `<label>`, which DOES resolve — Base UI renders a hidden native
  input inside the root, so the implicit association works and the rule simply
  cannot see through the component boundary. A new spec asks for the control by
  its accessible name, so the suppression's claim is checked rather than
  asserted.

**`planPromotion` had no test at all**, which is a poor place for the largest
refactor in the batch: it decides what moves between environments, and a wrong
plan promotes something that should have been withheld or withholds something an
operator is waiting on, neither of which throws. It now has 37, mutation-checked
— including the cross-section exception where connectors are planned last and
handed what the earlier sections produced, so a connector whose transform is
arriving in the same promotion is accepted rather than blocked.

The two deliberate NUL bytes — a sentinel in `stable()` and a separator in the
query cache key — are now written as escapes rather than raw bytes. Same value;
git stops calling those files binary and `grep` stops silently finding nothing
in them.
