---
"@dudousxd/nestjs-catalog": minor
"@dudousxd/nestjs-catalog-react": minor
---

Choose the chart library while assembling the board, not only when saving

Which library draws a chart — the built-in, shadcn/recharts, bklit — could only
be decided on the saved query, which is to say at save time. But the question
you are actually answering while arranging a dashboard is how this card should
look *beside the other cards on this board*, and the saved query cannot answer
that: it is used by other boards too, and editing it to fix one of them changes
all of them.

So `DashboardCard` gains a `library`, with the same semantics its `title`
already had — an override for this card, on this board. The card toolbar gets a
picker beside the width control, and the default option names what the query
chose so it is clear what "follows query" means before you change it.

The picker is built from `registeredChartLibraries()`, so it offers only what
the host actually installed. An option for a library nobody registered would be
an option that silently degrades to the built-in: the control would say one
thing and the card draw another.

The precedence — card, then query, then built-in — now lives in one named
function, `visualizationFor`, rather than in two lines inside a component that
needs a query client and a transport to render. A test that mirrors those lines
drifts from them silently; this one calls the same function the board does.

Going back to "follows query" REMOVES the key rather than setting it to
undefined. The two behave identically at the lookup, but a card is stored as
JSON, and "the key is there and empty" is a different statement from "nobody
chose" the moment anything else reads it.
