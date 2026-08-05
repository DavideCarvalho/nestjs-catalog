---
"@dudousxd/nestjs-catalog-dashboard": minor
"@dudousxd/nestjs-catalog-react": minor
---

The console mounts the search box, and the barrel names what it was hiding

`CatalogSearch` shipped last release and nothing rendered it, so finding
anything in the console still meant knowing which of nine tabs it lived on —
which is the experience the box was written to replace.

**It is a route, not a tenth tab.** `#search` can be bookmarked, sent to
somebody and reloaded, and it is deliberately absent from the tab list: nine
tabs plus the brand and the pinned controls already need ~1150px, and below that
the strip scrolls. A tenth would spend ~90px of that budget, and an
always-visible input several times more, to buy a destination a keystroke
reaches faster than a click. The way in is a 28px icon pinned beside the
environment picker — outside the scrolling strip, so it cannot scroll away —
and **⌘K / Ctrl-K** from anywhere in the console, which opens the screen with
the cursor already in the box. **Escape** goes back to the screen you were on,
not to the console's default, so a search opened mid-task does not cost you your
place.

**All three hrefs are passed, and two of them promise less than they look like
they do.** A kind with no href renders as a plain row rather than a link, so a
box that crosses four kinds and dead-ends on two would be worse than the tabs it
replaces. `#objects?type=X` is honest end to end — the object explorer is handed
that parameter and opens on the type, and it is the same string the model screen
generates for the same destination. `#query?savedQuery=…` and
`#dashboards?dashboard=…` land on the right **screen** and no further:
`QueryConsole` takes no saved-query id and `DashboardBoard` takes no props at
all, so today both open on their own default and the id rides along unread. The
row still navigates, and the parameter is already in the address for the day
either screen learns to read it.

**Newly exported from `@dudousxd/nestjs-catalog-react`**, all of them reachable
from something the barrel already exported and from nowhere else:

- `SchemaDiscoveryBridge`, `ConnectorSchemaDiscovery`, `DiscoveredColumn`,
  `SchemaDrift`, `DiscoveredTypeDraft`, `ColumnChoice` — the whole schema
  discovery seam. `PipelineConsoleProps.schemaDiscovery` is a bridge the **host**
  implements, and the only way to write one with its signature spelled out was
  an indexed access on a component's props, or a deep import into `dist/`.
  `initialChoices` and `proposalFrom` come with them: they are the pure rules
  that decide whether a schema somebody ticked is one the publish route will
  accept, and they are worth nothing outside the panel if rendering the panel is
  the only way to run them.
- `CatalogPeoplePage` and `PeopleQuery` — the reply and the argument of
  `CatalogClient.listPeople` and `AccessRoutes.people`. Both interfaces were
  exported; neither of the two types their one method takes was. Typing the
  reply as `CatalogPersonSummary[]` instead is the exact mistake that method's
  own docblock warns about — it drops `total`, and a screen that ignores `total`
  under-reports who has access.
- `DEFAULT_PUBLISH_BASE_PATH` — the third of three defaults, with the other two
  already exported, so `CatalogProviderProps.publishBasePath` documented a
  default a host could not name.
- `WorkflowProblemLevel`, `WorkflowDraft`, `ValidateOptions` and
  `DurabilityCopy` — the level on an exported problem, the two arguments of
  `validateWorkflow`, and what `describeDurability` answers with.

A spec now sweeps the five modules the barrel re-exports from and fails when one
of their names is missing, rather than trusting a hand-maintained list — the
third time in this repo that a list fell behind the module under it.
