---
"@dudousxd/nestjs-catalog-react": minor
---

The Model screen says whether a load of this type would be refused

A type with no delete strategy declared has its **incremental** loads refused —
that is what `CATALOG_LOAD_EXPECTATIONS` is for, and until now the only way to
find out was to run one and read the failure, or to have an engineer put the
answer in code and deploy. The type panel now carries a section that says it
outright, and lets an operator set it.

What it shows: the resolved delete strategy, the `because` as **prose** rather
than as a config value — it is a sentence somebody is accountable for — who set
it and when, the row-count bounds, and a table saying, field by field, which
layer won. Field by field because the resolution is: a deployment can pin the
row-count bound in code and say nothing about deletes, and one badge for the
whole expectation would have to pick one of those and be wrong about the other.

What it refuses: a `because` that is empty, for every one of the three
strategies — the button is disabled and the form declines to submit, because
Enter in a text field is not a pointer. A `periodic-full-reload` with no
interval, or one that is not positive. And a write to a field this deployment
fixed in code: those controls are **shown, explained and disabled**, never
hidden, and the body omits them rather than echoing the host's value back into a
409.

Nothing here is a fourth strategy. The select is built from
`DELETE_RECONCILIATION_STRATEGIES`, the same list the server validates against,
so the dropdown cannot offer something the route would reject or miss something
it would take.

`CatalogClient` gains `loadExpectation`, `setLoadExpectation` and
`clearLoadExpectation`, and `PipelineRoutes` gains the two paths behind them.
The writes deliberately return `unknown` and the screen refetches: what belongs
on screen is the resolved expectation, and merging a stored row with what the
host declared is the server's job, not a cache write's.

A host that serves no pipeline endpoints gets a section that says it could not
read the expectation, which is not the same sentence as "nothing is declared" —
only one of those means a load is being refused.
