---
"@dudousxd/nestjs-catalog-store-mikro-orm": minor
---

Promoting into production leaves a record, and cannot land in the wrong world

`PROMOTION_AUDIT_EVENT` was exported with a paragraph explaining where the record
is written, and referenced nowhere. `applyPromotion` wrote no audit row, so the
act of releasing into production was unrecorded — while the code said otherwise,
and while `CatalogPromotionApproval.reason` claimed the operator's text was
"recorded in the audit trail".

It writes one `promotion.applied` row per promotion now, into the TARGET
environment's own table rather than through the routing store: a promotion is
the one act about two environments at once, and the record has to be provably in
the one that changed. One row rather than one per change, because a promotion is
a single act by one person against one approved fingerprint — but every promoted
id is in the detail, kept apart by kind, so the trail does not lose what moved.

**A promotion that throws part-way records too.** An apply is not atomic, so the
half-finished one is the record worth most; `status` and `error` carry it, the
way `connector.run.finished` already reports both outcomes under one name.

**And a refusal that was missing entirely.** `applyPromotion` never checked that
the plan's `to` matched the environment it was handed. A caller that resolved the
wrong bundle would release an approved-for-staging plan into production — and,
once auditing existed, file the record under the environment the plan named
rather than the one it hit. It refuses now. This is a behaviour change to a
public API and the one part a host could notice.

`reason` is a new optional argument, carried verbatim and never parsed. It is the
one part of "who, what, when and why" that cannot be reconstructed from the two
databases afterwards.
