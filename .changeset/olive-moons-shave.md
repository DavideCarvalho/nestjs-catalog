---
'@dudousxd/nestjs-catalog-store-mikro-orm': minor
'@dudousxd/nestjs-catalog-react': minor
'@dudousxd/nestjs-catalog': minor
---

The activity list stops shipping every event payload it never draws

`GET catalog/events/traces` answered the console's default page with **10.46 MB**
of JSON, and the screen re-asks every ten seconds. 4.31 MB of that was
`catalog_audit_event.detail` — the event payloads — read from the database,
parsed into 28,105 objects, serialised again, and then not drawn: the list
renders a waterfall, which needs when each event happened and whether it failed,
and the payload is read only when somebody expands a trace.

The shape of the data is why it is so lopsided. A page carries every span of
every trace on it, which is deliberate — a trace shown with only the spans a
filter hit is a story with the middle torn out. But on the dev trail a trace
averages 452 events and the widest carry 1,992, so a 50-trace page is 28,105
spans, or 22% of the entire audit table, to draw 50 cards.

So the list now selects the two fields grading actually reads —
`$.error` and `$.status`, extracted in the database — instead of the payload
they come from, and `getTrace` keeps carrying the payload for the one trace a
reader opened. `CatalogTraceSpan.detail` is therefore optional: present from
`getTrace`, absent from `listTraces`.

Nothing on the screen is poorer for it. Every step is still listed, in order,
with its timing, its error and the card's error banner; `failed` and `error` are
derived by the identical rule on both paths, which a db spec holds by grading
the same trace through each and comparing span for span. Expanding a card
fetches the trace that has the payloads, so the one line per step that
summarises one is unchanged — it just arrives when it is looked at. A host whose
client predates `getTrace` keeps a working steps pane, one line per step poorer.

Measured through the store against a real trail of 127,835 events, minimum of
three runs: the default 50-trace page 10.46 MB → 6.07 MB and 3,807 ms →
3,149 ms; the 25-trace page 3.19 MB → 1.86 MB and 1,283 ms → 915 ms;
`outcome=failed` 1,774 ms → 1,557 ms; `getTrace` unchanged at 229 ms. Those
absolute timings are a `db.t4g.medium` reached over a WAN and do not transfer,
but the bytes do.

`minor`, not `patch`: `CatalogTraceSpan.detail` becomes optional and
`CatalogClient` gains `getTrace`. Published shapes changed, so a consumer
dereferencing a list span's payload has to guard it.
