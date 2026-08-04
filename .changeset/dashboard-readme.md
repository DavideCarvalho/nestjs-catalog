---
'@dudousxd/nestjs-catalog-dashboard': patch
---

Ship a README

It published without one, so its npm page was blank. Leads with the two things a host has to get
right and which fail confusingly when they are not: excluding the console from a global API prefix
(otherwise it loads as a blank page with 404s, reading as a broken build rather than a routing
mistake), and deciding whether it is open — `auth` describes how a session is validated, so a host
that has not configured it yet has an OPEN console, and `guards` is what makes "unconfigured" mean
shut.
