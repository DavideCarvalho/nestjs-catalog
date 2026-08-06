# @dudousxd/nestjs-catalog-react

Ready-made React screens for [`@dudousxd/nestjs-catalog`](../nestjs-catalog): a
model manager, an object explorer, a query console, dashboards, an activity
timeline, and the screens for getting data in and saying who may touch it.

```bash
pnpm add @dudousxd/nestjs-catalog-react
```

## Use it

```tsx
import { CatalogManager, CatalogProvider } from "@dudousxd/nestjs-catalog-react";

const transport = {
  get: async (path, params) => (await api.get(path, { params })).data,
  patch: async (path, body) => (await api.patch(path, body)).data,
  post: async (path, body) => (await api.post(path, body)).data,
  delete: async (path) => (await api.delete(path)).data,
};

<CatalogProvider transport={transport}>
  <CatalogManager title="Data model" explorerHref={(t) => `/explore?type=${t}`} />
</CatalogProvider>;
```

It asks for a **transport**, not a base URL. Every app that would install this
already has an HTTP client with its own auth interceptors, retries and error
reporting — bringing a second one along would make the console the one screen
that authenticates differently.

Requires a `QueryClientProvider` from `@tanstack/react-query` above it.

## What you get

- **`<CatalogManager />`** — browse types by group, see every property beside the
  column it came from, and edit labels, descriptions and units inline. Edits are
  presentation-only; nothing here can reach a migration.
- **`<ObjectExplorer />`** — one table for every type in the catalog. Columns,
  labels, alignment and units all arrive with the data, so it knows nothing about
  your domain.
- **`<QueryConsole />`**, **`<DashboardBoard />`** — SQL over the published
  snapshots, saved queries, and cards built from them.
- **`<GovernanceTimeline />`**, **`<TraceExplorer />`** — what happened, flat and
  grouped into causal stories.
- **`<PipelineConsole />`** — the two things a workflow borrows: connections and
  transforms. Includes a **Test connection** button that reports what actually
  answered — a server version, a bucket and whether anything sits under the
  prefix, an HTTP status. It is deliberately **not** where a pipeline is
  authored; there is no connector screen, because nothing authors a connector.
- **`<WorkflowCanvas />`** — the one place a workflow is authored: sources wired
  through transforms into sinks, published, scheduled and run. On its own subpath
  (see [Workflows](#workflows)) because it needs an optional peer.
- **`<AccessConsole />`** — which applications may touch what, and which people
  sign in through them.
- **`<CoverageLedger />`**, **`<EditableField />`**, and the vendored primitives
  under `ui/` — the pieces, if you want to assemble something else.

Rendering one of these charts inside *another* application is a server-side
surface today: `GET /catalog/embed/*` serves shared charts and dashboards as
rendered rows, documented in
[`@dudousxd/nestjs-catalog`](../nestjs-catalog#embed-a-chart-in-someone-elses-application).
React components for it are being built and are not part of this package yet.

## Endpoints it expects

The catalog screens call paths the library's own controller serves, described by
`catalogRoutes` in `@dudousxd/nestjs-catalog/client`. Install the module and they
exist.

The pipeline and access screens are different, and the difference is deliberate.
The library defines the connector, connection and principal **model**, but ships
no controller for them — how a deployment exposes the code that reshapes its data
and who may create an account are decisions that belong to the deployment. So
this package states the shapes it needs and lets you mount them:

```tsx
<CatalogProvider
  transport={transport}
  pipelineBasePath="/pipeline"   // default
  accessBasePath="/access"       // default
>
```

`pipelineRoutes()` and `accessRoutes()` are exported so you can see exactly what
is expected, and the response types are on the `CatalogClient` interface.

## Workflows

`<WorkflowCanvas />` is a canvas where nodes are transforms and edges mean "the
output of this feeds that". It ships on its own subpath and needs
[React Flow](https://reactflow.dev) — an **optional** peer, so a host that never
opens this screen pays nothing:

```bash
pnpm add @xyflow/react
```

```tsx
import { WorkflowCanvas } from "@dudousxd/nestjs-catalog-react/workflow";

<CatalogProvider transport={transport}>
  <WorkflowCanvas />
</CatalogProvider>;
```

The package is **`@xyflow/react`**, not `reactflow`. The two are the same
project: `reactflow` is the v11 name, last published in mid-2024, and
`@xyflow/react` is the v12 line that succeeded it and is where the work
continues. Anything you find under the old name is a version behind by design.
It brings its own stylesheet, which the component imports itself — there is
nothing for a host to add, and React Flow renders as an unstyled pile of divs if
that import is missing, which looks like a broken canvas rather than a missing
line of setup.

The canvas colours itself from React Flow's `--xy-*` variables under the host's
own `dark:` class rather than React Flow's `colorMode` prop, because
`colorMode="system"` follows the operating system — which is not the same thing
as the theme the app is actually in.

### What it asks of the server

These routes on top of the pipeline base path, listed by `pipelineRoutes()`:

| Route | Purpose |
| --- | --- |
| `GET/POST {base}/workflows` | list; create or update |
| `DELETE {base}/workflows/:id` | delete, taking the connector and its history with it |
| `POST {base}/workflows/:id/publish` | declare it finished, and mint the connector it runs as |
| `POST {base}/workflows/:id/unpublish` | back to draft; the connector is disabled and keeps its id |
| `POST {base}/workflows/:id/run` | execute, optionally carrying `expectShrink` |
| `PUT {base}/workflows/:id/schedule` | set the cron and whether it runs at all |
| `POST {base}/workflows/:id/nodes/:nodeId/discover` | ask one source what its columns are |

**A connector is not one of them.** It is what a published graph runs as: minted
by `publish`, disabled by `unpublish`, removed with the graph, and there is no
route that creates one. `GET {base}/connectors` stays as a read, because that id
is what the run history and the incremental watermark are keyed on, and the
canvas shows it under "Runs as".

**`discover` answers on a draft, deliberately.** A sink cannot commit into an
object type that does not exist, so requiring a published graph would require
publishing a graph whose target type cannot be created until it is published.
What it does need is a graph that has been *saved* — it reads the stored node.

**`expectShrink` on `run` is the escape hatch for a load the row-count bound
refused**, and this is the only route that accepts it. It is a reason rather than
a flag: the sentence is written into the snapshot's `_expectShrink` label, an
empty one is refused with a 400, and it stands the bound down for that snapshot
alone. The alternative an operator reaches for without it is raising
`rowCount.maxShrink` in the type's policy, which stands the guard down for every
future load of that type.

…plus one optional field on `GET {base}/capabilities`:

```jsonc
{ "languages": ["javascript"], "pythonPackages": [],
  "durable": { "available": true, "engine": "nestjs-durable" } }
```

**`durable` matters more than it looks.** Each node becomes its own durable step
when a durable engine is available, so a ten-node graph that fails at node seven
resumes at node seven; with no engine the whole graph runs inline and a failure
restarts it from the beginning. The screen states which of those the deployment
has, on the screen, not in a tooltip. Omitting the field is a **third** answer —
"this deployment did not say" — and the canvas renders it as such rather than
guessing, because a canvas implying resumability that does not exist is worse
than one that admits it does not know.

### The canvas warns; the server refuses

While a graph is being drawn the canvas checks it — a cycle, two sinks, a node
wired to nothing, a node pointing at a deleted transform — and shows the result
beside the node that caused it. A connection that would close a loop refuses
itself mid-drag rather than being accepted and reported afterwards.

None of that is authoritative and none of it gates a save. `POST /workflows` is
the only check that counts, and its refusal is shown verbatim. The rules are
exported (`validateWorkflow`, `canConnect`, `wouldCycle`) so a host can run the
same checks — never so it can skip the server's.

What the server checks that the canvas cannot:

- **Whether every transform the graph names still exists.** The canvas knows
  what it last listed; the server reads the table.
- **Whether the signed-in principal may write the types the graph's sinks
  commit.** Every sink, not just the first — a graph may carry several as long
  as they commit different types — and a refusal names each type it turned
  down. The same check runs again on `POST /workflows/:id/run`, because a graph
  saved by somebody who held the grant can be run by somebody who does not, and
  the run is what actually commits. `POST /workflows/:id/publish`,
  `PUT /workflows/:id/schedule` and `POST /workflows/:id/nodes/:nodeId/discover`
  are checked the same way — discovery included, because without it a principal
  with `catalog:write` and no grants could press it against somebody else's graph
  and read back the column names of a database they were never allowed near.

These routes now require a principal: they read grants, not just a name to
attribute the write to, so a deployment that mounts the pipeline without a
principal guard will fail them rather than fall back to an anonymous identity
with nothing to check against.

What it still does **not** check, so the screen should not imply otherwise: that
a sink's target type has been published yet, and that a transform's output fits
the sink it feeds. The first surfaces when the run tries to commit; the second
is not checked anywhere.

One thing the canvas is shown but must not send back verbatim without care:
`GET /connections` and `GET /connectors` **redact the password out of any
connection URL in `config`**, because those routes need only `catalog:read`. The
placeholder reads `REDACTED`. Posting an object straight back is safe — the
server puts the stored credential back when the value it receives is exactly the
redaction of what it holds — but an inspector that renders that field as an
editable text box should say it is masked, or somebody will retype a password
they cannot see.

### Keyboard and screen readers

React Flow makes nodes focusable, movable with the arrow keys and deletable, and
that is turned on. What it has no gesture for is *drawing an edge* — a
connection is a pointer drag and nothing else — so the node inspector carries a
**"send its output to…"** control listing only nodes that can legally take it,
filtered by the same rule the drag uses. Beside the canvas, a **Wiring** list
states every connection as operable text, since a picture is not a
representation for everybody. Each node's `aria-label` says what it is, what
feeds it, what it feeds and what is wrong with it; refusals and edits are
announced through a polite live region.

### Naming

The screen is called **Workflow** for now, in one constant (`WORKFLOW_NAME`).
Deliberately not "Flow": `<FlowView />` is *derived* lineage, reconstructed from
what publishers actually did, and this is an authored graph somebody wrote and
the server executes. Two screens sharing a name while making opposite claims
about where the truth lives is how people trust the wrong one.

## Styling

Plain Tailwind utilities from the default palette, with `dark:` variants. No
design tokens to define, no stylesheet to import, and no Tailwind plugins — the
open and close transitions use core utilities driven by data attributes rather
than `tailwindcss-animate`, so nothing renders half-styled because a plugin was
missing from a host's config.

Because the classes ship inside compiled JS, Tailwind needs to be told to look
at them:

```css
@source "../node_modules/@dudousxd/nestjs-catalog-react/dist/*.js";
@source "../node_modules/@dudousxd/nestjs-catalog-react/dist/**/*.js";
```

Without those lines the screens render unstyled.

## Primitives

The components under `src/ui/` are vendored in the shadcn style — components you
own, not a dependency you take — and built on
[Base UI](https://base-ui.com) (`@base-ui/react`), which is where shadcn's
primitives are moving. Note that the older `@base-ui-components/react` package
name is deprecated on npm; this package uses the current one.

Base UI is a peer dependency, so a host already using it does not get a second
copy.

## Charts

Chart libraries are registered rather than imported, so a host pays only for the
one it wants. Two renderers ship, on their own subpaths:

```tsx
import { registerChartRenderer } from "@dudousxd/nestjs-catalog-react";
import { ShadcnChartRenderer } from "@dudousxd/nestjs-catalog-react/recharts";
import { BklitRenderer } from "@dudousxd/nestjs-catalog-react/bklit";

registerChartRenderer("recharts", ShadcnChartRenderer);
registerChartRenderer("bklit", BklitRenderer);
```

A saved query naming a library nobody registered falls back to the built-in CSS
renderer rather than failing — a dashboard should degrade to a plainer chart,
not to an error. `library` is stored data, so a query saved when a renderer was
registered outlives it, and this is what keeps such a card drawing something.

### The `bklit` renderer

Registered name: **`bklit`**. Its components are vendored (see Attribution
below), so selecting it needs no `@bklit/*` package — but it does need the peers
it is built on, all of them optional:

```bash
pnpm add @visx/curve@4.0.1-alpha.0 @visx/event@4.0.1-alpha.0 \
  @visx/grid@4.0.1-alpha.0 @visx/pattern@4.0.1-alpha.0 \
  @visx/responsive@4.0.1-alpha.0 @visx/scale@4.0.1-alpha.0 \
  @visx/shape@4.0.1-alpha.0 d3-array d3-shape motion
```

**The visx pins are alpha (`4.0.1-alpha.0`)**, which is what bklit-ui is built
against — not a choice this package made, and worth knowing before you register
it in production.

One real constraint: bklit's **line and area charts are time-series charts**.
They build a `scaleTime` and coerce x with `new Date(...)`, so a saved query
whose label column holds categories rather than dates cannot be drawn by them —
and it fails silently, as an empty box, not as an error. The renderer therefore
checks the label column first and degrades categorical line/area cards to the
built-in bars. bklit's **bar** chart is banded and categorical, so it takes
whatever the label column holds.

### Loading states

`<ChartSkeleton />` draws the chart that is coming — bars for a bar chart, a
silhouette for a line or area, a number block for a single value — at exactly
the height the real chart will occupy, so nothing shifts when data lands. It
animates only under `motion-safe`. `<ChartEmpty />` and `<ChartFailed />` sit
beside it, because a query that matched nothing and a query that failed must
never be left under a placeholder that suggests something is still on its way.

The `bklit` renderer has its own loading vocabulary — a shimmer sweep and a
pulse, driven by its `status` prop — and both are vendored here. They are
deliberately **not** wired into the dashboard: on one board, a bklit card
sweeping beside a Recharts card pulsing reads as two different things loading
rather than one board. If you register `bklit` for every card, prefer its own;
mixed boards should use `<ChartSkeleton />` throughout, which is what
`DashboardBoard` does.

## Attribution

The chart components under `src/charts/bklit/` (and
`src/charts/components/shimmering-text.tsx`) are vendored from
[**bklit-ui**](https://github.com/bklit/bklit-ui), Copyright (c) 2026 uixmat,
released under the **MIT licence**. The full licence text ships with this
package as [`LICENSE-bklit`](./LICENSE-bklit), and every vendored file carries a
header naming its origin.

They are vendored rather than depended on because bklit-ui is a shadcn-style
registry — components you own, not a package you install. The only local change
is that their `@/lib/utils` import was repointed at this package's own `cn`,
which is the same function; nothing else is modified, so re-syncing with
upstream stays a diff rather than a merge.

## License

MIT (see `LICENSE-bklit` for the vendored bklit-ui components).
