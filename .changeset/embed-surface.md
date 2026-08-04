---
"@dudousxd/nestjs-catalog": minor
"@dudousxd/nestjs-catalog-react": minor
---

Embed a chart or a board in somebody else's application

The server already served `GET embed`, `embed/charts/:id` and
`embed/dashboards/:id`, returning rendered rows rather than SQL so a consumer
never becomes a second implementation of the console. What was missing was
everything a consumer needs to use it: no client method, no component, no
documentation, and — it turns out — no enforcement.

**The `catalog:embed` scope was attached to no route.** It existed as a type, was
expanded by `catalog:admin`, and was named in two docblocks as the thing that
gates this API, while `packages/pipeline` had declared its scopes on all 20 of
its routes since it shipped. Any principal a host's guard let past the door could
fetch every shared dashboard. All three routes declare it now, discovery
included: a caller the fetches refuse has no use for the list, and an open
discovery endpoint is an inventory of what is worth asking for.

**The embed dropped the card's overrides.** `DashboardCard.title` and
`.library` exist to override the saved query *on that board*, and the payload
used the query's own — so the console and the embed drew the same dashboard
differently, silently. The server now restates the same precedence the React
side uses (card, then query, then built-in) rather than inventing a second rule.

**`shared` was undeclared on dashboard writes.** It worked only because the body
reached the store untouched; under a host's whitelisting `ValidationPipe` it is
stripped and a dashboard can never become shareable, with no error anywhere.

`<EmbeddedChart>` and `<EmbeddedDashboard>` render the payload with a toolbar
that holds only OUTPUT actions — no refresh, no delete, no chart-library picker.
Those are authoring controls and belong to the console where the board is
assembled; an embed that could refresh would also bypass whatever caching the
host put in front of it. `actions` defaults to `'none'`, and a caller's list is
filtered against the actions that exist rather than trusted, so a host asking for
one that does not exist gets no control instead of a dead button.

A chart can be exported as PNG with no dependency — a serialised SVG, a canvas
and `toBlob` are already in every browser. Two limits are worth knowing: an SVG
rasterised through a data URI cannot load `@font-face`, so exported text falls
back to a system face; and the built-in CSS bar chart draws with divs rather than
an `<svg>`, so it cannot be exported at all and offers no action rather than a
failing one.
