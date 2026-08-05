---
"@dudousxd/nestjs-catalog": minor
"@dudousxd/nestjs-catalog-pipeline": minor
"@dudousxd/nestjs-catalog-store-mikro-orm": minor
---

A delete strategy can be declared by an operator, not only by a deployment

`CATALOG_LOAD_EXPECTATIONS` was the only way to say how a type reconciles rows
deleted at its source, and it is a provider bound at boot. So the path was:
build a connector in the console, run it in `full`, and the moment you wanted
`incremental` you needed an engineer, a commit and a deploy. For a console whose
whole premise is that you assemble a pipeline on screen, that is the wrong shape.

The control was never about compilation. Read its own docblock: what it wants is
that **somebody chose a strategy and wrote down why**. That needs attribution and
visibility, which a row can carry as well as a provider can.

So the policy now resolves through three layers, field by field:

    host.byType[type]   >   stored row   >   host.default

A deployment that declared something about a type still wins — that is what lets
one pin a type down and keep it pinned. Where the host is silent, an operator's
stored decision applies. `host.default` stays weakest, so a house-wide bound
never beats a specific one. `expectationFor` is now literally the same merge with
no stored layer, so there is one precedence rule in the codebase rather than two.

The enforcement functions did not move and did not become async.
`refuseUndeclaredDeletes`, `refuseStaleReconciliation` and `refuseRowCountDrift`
are still pure and synchronous; only the *sourcing* of the policy reaches a
store, and it reaches it through `supportsLoadExpectations`, so a store that
implements none of the four new optional members behaves exactly as it does
today. The four members are optional for that reason: this package is not the
only implementation of `CatalogPipelineStore`, and widening a required interface
silently disqualifies every other one.

`PUT`/`DELETE pipeline/expectations/:type` ask for `catalog:curate` — the scope
that already governs what the catalog says about a type — and for a person.
`@RequireHuman()` is not decoration here: `because` is a sentence somebody is
accountable for, and an application key has no author. The writes merge over the
stored row, so an absent field means "leave it alone" rather than "clear it", and
a write to a field the host owns is a 409 naming that field rather than a silent
no-op. Both writes emit `type.curated`, the same event `patchType` emits, so the
recorder that already lifts `principalId` into the audit table needs no change.

The connector's cheap pre-flight gate resolves through the same three layers.
Without that the feature would work everywhere except where it is used: a
scheduled incremental run would still be refused by the early check after an
operator had stored a strategy.

`deletes` and `rowCount` are stored as JSON rather than as columns, and that is
load-bearing rather than lazy. MikroORM infers `int` for a `number`, which would
round `maxShrink: 0.5` to `0` — a bound that refuses a load for losing a single
row — and would overflow a thirty-day `withinMs` past a signed INT.
