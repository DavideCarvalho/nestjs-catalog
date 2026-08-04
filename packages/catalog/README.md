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
