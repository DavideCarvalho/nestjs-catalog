---
"@dudousxd/nestjs-catalog-react": minor
"@dudousxd/nestjs-catalog-pipeline": minor
---

The console can reach schema discovery, and a host can bind load expectations

Two features shipped in this release were built and unreachable, for the same
reason in two places: the thing that would call them had no name to call.

**Schema discovery** returned a report the console could not ask for.
`CatalogClient` gained `discoverConnectorSchema`, and `pipelineRoutes` the path
behind it. The panel took a bridge as a prop and nothing supplied one.

**Creating the type from that report** had nowhere to go at all: this client had
no publish call, because publishing is the one write that does not go through
the catalog's own routes — there is deliberately no `POST /catalog/types`, since
structure follows a publisher and curation follows a person. `publishType` is
that call, and `CatalogTransport.put` is optional so a transport written before
this keeps compiling. A client handed one that cannot `PUT` refuses **by name**
rather than resolving having done nothing: a "Create type" button that returns
without creating a type is the exact failure the panel exists to prevent.

`publishBasePath` is its own option, defaulting to `/publish` — a sibling of the
pipeline's base, not a child, because that is how the library mounts the two.

**Load expectations** were exported from nothing. `CATALOG_LOAD_EXPECTATIONS` is
the token a host binds to declare how a type handles deleted rows and how far a
snapshot may shrink; a token nobody can name is a feature nobody can switch on,
and the refusals ship on by default. The whole module is exported with
`export *`, deliberately — a hand-maintained list is how the catalog package's
barrel came to export an interface without the two types its one method takes.
