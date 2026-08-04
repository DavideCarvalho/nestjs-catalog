# @dudousxd/nestjs-catalog

A metadata registry for NestJS. It reads your ORM and gives you back your data
model as data: object types, their properties, their relations — queryable over
HTTP, and labelled by humans rather than by whoever named the class.

```bash
pnpm add @dudousxd/nestjs-catalog
```

## Why

Most applications describe their model three or four times: once in the entity,
once in a filter definition, once in a table component, once in whatever the
admin screen is. Each copy drifts.

This library takes the position that **structure should be derived and semantics
should be declared.** Column names, SQL types, nullability and foreign keys are
read off the ORM, because the database already knows them. What the database
cannot know — what a thing is called, what it means, what unit it is in, who may
see it — is declared once and served to everything downstream.

## Mount it

```ts
import { CatalogModule } from "@dudousxd/nestjs-catalog";

@Module({
  imports: [
    CatalogModule.forRoot({
      path: "catalog",
      // No guard ships by default. An endpoint that enumerates every table in
      // your database should never be open because a library decided so.
      imports: [AuthModule],
      guards: [RolesGuard],
    }),
  ],
})
export class AppModule {}
```

`imports` is not decoration: Nest builds a guard from the injector of the module
that *declares* the controller, and this library generates its own. Whatever
your guards inject has to be resolvable from there.

## Declare what the database cannot know

```ts
@CatalogType({
  displayName: "Vehicle",
  group: "Fleet",
  icon: "🚚",
  description: "One registered vehicle. Work orders and funding hang off it.",
})
@Entity()
export class Mvr {
  @CatalogProperty({ displayName: "Risk Score", unit: "0–100" })
  @Property({ fieldName: "Risk Score" })
  riskScore?: number;
}
```

Entities with no decorators still appear — with a name derived from the class,
which is exactly the point: the console shows you which types nobody has named
yet.

## The HTTP surface

| Method | Path | What it does |
|---|---|---|
| `GET` | `/catalog` | The whole model, as data |
| `GET` | `/catalog/graph` | Nodes and edges, for drawing it |
| `GET` | `/catalog/types/:name` | One type |
| `PATCH` | `/catalog/types/:name` | Rename, regroup, re-describe |
| `PATCH` | `/catalog/types/:name/properties/:property` | Label, unit, description, visibility |
| `POST` | `/catalog/reset` | Drop every runtime edit |
| `GET` | `/catalog/objects/:name` | Read rows of any catalogued type |

Everything a `PATCH` can change is presentation-only. **No route in this library
issues DDL, and the catalog never writes to your tables.** Runtime edits go to an
overlay store (a JSON file by default; bring your own via `overlayStore`).

`GET /catalog/objects/:name` validates the type name, the sort column and the
searched columns against the catalog before anything reaches SQL, selects only
the columns the catalog says are visible, and caps the page size.

## Who may reach it

The console's Access screen asks two questions with different owners, and the
library treats them differently on purpose.

**Applications** are the catalog's own. `catalog_principal` is a table this
library defines and the grants on it are catalog grants, so
`CatalogMikroOrmStoreModule` ships the implementation and you get
`GET /access/principals` by mounting it.

**People are almost certainly not the catalog's.** A catalog embedded in an
application is embedded in one that already knows who its users are, and a
second user store beside it is how you get two lists of employees that disagree
about who was offboarded. So implement `listPeople` over what you already have:

```ts
class MyDirectory extends MikroOrmCatalogDirectory {   // applications, inherited
  async listPeople() { return this.users.findAll().map(toPersonSummary); }
}

CatalogModule.forRoot({
  directory: { provide: CATALOG_DIRECTORY, useClass: MyDirectory },
});
```

Bind it through `directory` rather than only exporting it from an imported
module: a provider declared inside `CatalogModule` **shadows** the same token
exported by one of its imports, so a host that does both gets the shipped
applications-only one and no error.

Leave `listPeople` out and `GET /access/people` answers **501** naming the seam,
rather than an empty list. That distinction is load-bearing — "nobody can sign in
yet" and "we did not ask" send an operator to different places, and the first
invites them to create an account that already exists. Same for `upsertPerson`,
which most hosts should *not* implement: creating a user from a catalog console
is a way to create one your IdP has never heard of.

The routes mount at `accessPath`, a sibling of `path` by default — `api/catalog`
gives `api/access`, which is the shape the React screens build.

## Embed a chart in someone else's application

A saved query or a dashboard can be fetched by another application and drawn in
its own UI, without that application knowing anything about this catalog's SQL,
its schema or its console.

| Method | Path | What it does |
|---|---|---|
| `GET` | `/catalog/embed` | What this caller may embed |
| `GET` | `/catalog/embed/charts/:id` | One shared saved query, run and rendered |
| `GET` | `/catalog/embed/dashboards/:id` | A shared dashboard, every card resolved |

### What comes back is rows, not SQL

`GET /catalog/embed/charts/:id` runs the saved query and hands back the result
already shaped for drawing:

```jsonc
{
  "id": "9a1c0e2e-…",
  "title": "Vehicles by status",
  "description": "Current fleet, grouped by operational status.",
  "visualization": { "kind": "bar", "labelColumn": "status", "valueColumns": ["vehicles"] },
  "columns": ["status", "vehicles"],
  "rows": [
    { "status": "Operational",    "vehicles": 412 },
    { "status": "In maintenance", "vehicles": 57 },
    { "status": "Deadlined",      "vehicles": 9 }
  ],
  "rowCount": 3,
  "cached": true,
  "generatedAt": "2026-02-11T09:15:04.221Z"
}
```

That it is rendered rows rather than the statement behind them is the point of
the endpoint. **Handing back SQL would make every consumer a second
implementation of the console** — each one parsing this catalog's query
language, each one deciding what a `bar` means, each one drifting. A consumer
here needs a chart library and a `fetch`.

`title` and `visualization` come from the saved query itself. `layout` appears
only when the chart was reached through a dashboard, carrying that card's
`width` (1–4) and `position`; it is a hint the consumer may ignore, and it is
absent from `GET /catalog/embed/charts/:id`, which knows nothing about any
board.

`GET /catalog/embed/dashboards/:id` is the same shape one level up — `id`,
`name`, `description`, `generatedAt`, and `charts`, each entry exactly the
object above, ordered by card position. Cards are resolved **sequentially**, not
in parallel: every one is a database query, and a shared dashboard is precisely
the thing a consumer will poll on a timer. A card whose query is unshared,
missing or failing is left out rather than failing the whole board — one bad
card should not blank a page, and a consumer should therefore not assume
`charts.length` matches the card count it saw at discovery.

`GET /catalog/embed` is that discovery endpoint, so a consuming frontend can
list what it is allowed to render instead of being told the ids out of band:

```jsonc
{
  "dashboards": [{ "id": "…", "name": "Fleet readiness", "description": "…", "charts": 4 }],
  "charts":     [{ "id": "…", "name": "Vehicles by status", "description": "…", "kind": "bar" }]
}
```

Two things about freshness. `cached` says the rows came from the query cache
rather than the database — the TTL is the one the query was saved with, per
query, and zero means never cached. `generatedAt` is when *this response* was
assembled, so on a cached hit it is not the age of the rows; `cached` is the
field that tells you which you are looking at. The cache key includes the
catalog's version, so a curation edit that renames a column cannot serve a
result computed under the old name.

One limit worth knowing before you build against it: rows are capped by
`maxQueryRows` (default 1000) like any other query here, and the embed payload
carries no "truncated" flag, so a chart that hit the cap looks like a complete
result.

### Only what has been shared, and only ever explicitly

The two fetches serve a saved query or dashboard whose `shared` flag is set and
answer **403** otherwise; discovery lists only what carries the flag. An unshared
chart says so by name and tells you to mark it shared in the console, because the
fix is a decision somebody makes there rather than a configuration change.

`shared` is never inferred from the SQL. A saved query can join five relations,
so working out "which types does this touch" means parsing the statement, and a
permission that depends on a parser widens silently the first time the parser
meets a query it did not expect. Marking something shared is an act a person
performed, and it shows up in the audit trail as one.

The shipped console exposes the toggle on a saved query; the flag on a dashboard
is `shared` on the workspace store's `saveDashboard` / `updateDashboard` input.

### `catalog:embed` is its own scope

An application that draws one chart in its own UI needs nothing else. Giving it
`catalog:read` to do that hands it every type in the catalog, and that is the
kind of over-grant nobody revisits. So the embed API has its own scope, and a
principal can hold it alone:

```ts
new StaticKeyPrincipalResolver([
  {
    key: process.env.SALES_PORTAL_KEY!,
    id: "sales-portal",
    displayName: "Sales portal",
    scopes: ["catalog:embed"], // and nothing else — no reads, no curation
  },
]);
```

That resolver keys on the `x-catalog-key` header by default and is explicitly the
lesser option — prefer resolving a token against your IdP where there is one.
`hasScope(principal, "catalog:embed")` is how a guard asks, whichever resolver
answered; `catalog:admin` implies it, as it implies every scope.

**Declaring a scope is separate from enforcing it.** This library ships no guard,
for the same reason it ships none for anything else, so `catalog:embed` means
what the guard you pass to `guards` makes it mean: read `REQUIRED_SCOPES` off the
handler — `RequireScopes` is what sets it — and check it with `hasScope`. Nothing
under the `embed` prefix checks a scope by itself.

Note also what the embed path does *not* consult: nothing in it applies a
principal's `readTypes` or `classifications`. Those are helpers (`mayRead`,
`maySeeClassification`) for a host's guard to apply at the door, and the saved
query's SQL runs as written. The `shared` flag is the boundary — so what a query
selects is what an embedding application sees.

## Build your own endpoints, or use ours

The built-in controller is a convenience, not the interface. Pass
`controller: false` and inject `CatalogService` — by class, there is no token to
import — to publish whatever HTTP surface your app already uses:

```ts
@Controller("data-model")
export class MyController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()        model()               { return this.catalog.getSnapshot(); }
  @Get("graph") graph()               { return this.catalog.getGraph(); }
  @Get(":type") rows(@Param("type") t: string, @Query() q) {
    return this.catalog.readObjects(t, q);
  }
}
```

Everything the built-in controller does is on that one service — the model, the
graph, presentation edits, reads, and the snapshot list. The registry and the
store stay injectable for anything more unusual, but an ordinary endpoint should
not need them.

## Build your own UI, or use ours

The endpoints are the product. Import `@dudousxd/nestjs-catalog/client` for the
response types and route builders — no NestJS, no ORM, browser-safe — and write
whatever screens you want.

If you would rather not, [`@dudousxd/nestjs-catalog-react`](../nestjs-catalog-react)
ships a model manager and a generic object explorer that you drop into your own
app shell.

## License

MIT
