---
"@dudousxd/nestjs-catalog-react": minor
---

`ObjectExplorer` takes two new props, both optional with today's behaviour as the default. `search={false}` leaves out the search box for a host whose object endpoint does not support `search`, and the parameter is then never sent. `rowCountCap` names the most rows the host's server will count: a page whose `total` is at least that is shown as "10,000+ rows" instead of an exact-looking "10,000 rows".

The package now ships its own `LICENSE` (MIT, Davide Carvalho). The licence of the chart code vendored from bklit-ui moves from `LICENSE-bklit` to `THIRD_PARTY_NOTICES.md`, so a host's licence collector no longer lists this package under bklit's copyright.
