---
"@dudousxd/nestjs-catalog": minor
"@dudousxd/nestjs-catalog-react": minor
---

A PDF seam, the read rules said plainly, and an audit trail for sharing

**PDF is a seam, not a dependency.** A host registers something backed by its own
document pipeline; where nobody did, no PDF action appears — the rule the chart
registry already follows. The two client-side candidates cost ~128KB gzipped on
every consumer for a feature only some want, and the application embedding this
catalog already generates PDFs server-side. The exporter receives BOTH the PNG
and the serialised SVG: a host drawing with an image library takes the raster, a
host with a vector pipeline takes the markup and keeps text selectable at print
size.

The registry is subscribable, unlike the chart one, and that difference is
load-bearing: a PDF pipeline is heavy, so it is usually behind a dynamic import
that resolves after the console has mounted. Without a subscription the cards
already on screen would stay actionless forever. The card also watches for a
late `<svg>`, because recharts inserts one from its own state with no React
render to prompt a second look.

**The read rules are a toolkit, and now say so.** `mayRead` and
`maySeeClassification` have no call site anywhere, and that turns out to be the
design rather than a hole: this library declares and the host enforces — no
guard ships, `CatalogPrincipalGuard` does not exist in this repo, and
`readObjects` takes no principal to enforce with. What was wrong was the prose.
`CatalogPrincipal.classifications` claimed a column outside the list "is dropped
from its reads" and `CatalogObjectPage.columns` claimed "non-redacted columns" —
both describing a mechanism nothing performs. Corrected, with the decision
written where the next reader will ask. `readableObjectPage(principal, page)` is
the named helper that applies both, deleting hidden values rather than blanking
them, since a key present with `null` is itself a disclosure.

**Sharing leaves a trail.** `SavedQuery.shared`'s docblock claimed marking a
query shared "shows up in the audit trail as one"; no such event existed, so the
single act that grants an outside application access to data left no record.
`query.shared` and `dashboard.shared` now fire — on the transition only, because
a save that leaves the flag alone is not a sharing event and a trail that logs
every save teaches people to ignore it. Un-sharing is recorded too and is
distinguishable. The actor is the resolved principal rather than anything the
body claimed.

`PROMOTION_AUDIT_EVENT` was the third instance of the same pattern —
referenced nowhere, while its docblock explained where the record is written. It
is fixed in the same release; see the store adapter's entry.
