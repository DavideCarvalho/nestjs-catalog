---
'@dudousxd/nestjs-catalog': minor
'@dudousxd/nestjs-catalog-pipeline': minor
'@dudousxd/nestjs-catalog-store-mikro-orm': minor
'@dudousxd/nestjs-catalog-react': minor
---

A workflow can read a catalog object type, and gets the current snapshot rather than every snapshot ever committed

**A graph reading the catalog's own warehouse was silently doubling its
numbers.** The only way to do it was a `sql` connector naming the physical table
— `SELECT … FROM obj_subworeplica` — and the store **retains every committed
snapshot in that table**. So the read was not the dataset; it was every load
that had ever run, stacked.

Measured against a real deployment with two snapshots present:

| | | |
|---|---|---|
| rows read by the source | 89,440 | against a type holding **44,720** |
| run status | `succeeded` | nothing reported a problem |
| rows written | 16,119 | **unchanged**, because the downstream `GROUP BY` collapsed the duplicates |
| `SUM(actualLaborCost)` | 212,192,113 → **424,384,226** | every sum doubled |
| child stdout | 87.7% of the 32 MiB cap | every `GROUP_CONCAT` doubled |

The row count — the one number anybody checks — did not move. That graph had
been correct exactly once, by the accident of a single snapshot existing when it
was first run. It is the failure class this codebase refuses everywhere else:
silent, total, and green.

**The new source kind names a type, not a table.** `sourceKind: 'catalog'` with
`config: { objectType: 'SubwoReplica' }`. `obj_<type>` and `_snapshot_id` are
internal schema and a graph that spells them is coupled to a storage layout it
does not own.

**It needs no connection URL and no secret.** The previous workaround required
an operator to put `CATALOG_WAREHOUSE_URL` on the pod and on
`CATALOG_SECRET_ENV_ALLOW` — the catalog handed a credential to its own
database, which is both awkward and a credential that did not need to exist.
This kind reads through the `CATALOG_STORE` and registry the process already
has, so it is not connectable at all: `CONNECTION_KINDS` says so and the
console offers no address fields.

**"Current" is resolved when the run reaches the node**, by asking the store
which snapshot its pointer names, and the read is then **pinned to that id** —
so a commit landing mid-read cannot splice two loads into one. A type with
nothing committed is **refused**, loudly, naming the type: reading zero rows
with a green run is the same defect as reading twice too many.

**A new optional store method, `streamSnapshot`**, sits beside `streamQuery` and
is optional for the same reason — a store that cannot honestly stream declines,
and the caller refuses rather than paging. A paged fallback is not offered on
purpose: an offset walk is quadratic in the size of the type (the largest here
is 7,637,391 rows), and paging is only correct under an ordering `read` does not
promise. `MikroOrmWarehouseStore` implements it as one statement inside a
read-only transaction; nothing holds the dataset.

**Two exhaustiveness repairs, because two kinds have shipped invisible here
before.** `SOURCES` was `Record<string, SourceFetcher>` and is now
`Record<ConnectorKind, SourceFetcher>`; the console's kind picker was a
hand-written array of five and is now derived from `CONNECTOR_KINDS` through a
`satisfies Record<ConnectorKind, string>` label map. `unreachableConnectorKind`
is the new `unreachableNodeKind` for source kinds, and `producedColumns` now
answers per source kind through it instead of one blanket `undefined`.

**Static validation now reaches the root of a graph.** A `catalog` source is the
one source whose output columns are *published* — they are the named type's
property names, which is exactly what the store is asked for and exactly what it
returns. So `workflowKnownColumns` and `validateWorkflow` take an optional
`WorkflowColumnKnowledge` lookup, and with it a filter or a rename below a
catalog source can be refused for naming a column the type does not have —
which nothing else in the model can offer, since every other source's shape
lives in the live system. Without the lookup the answer stays `undefined`: "this
console cannot see that type" is not "that type has no columns", and an empty set
would refuse graphs that are correct.

**No stored graph is renumbered.** A source's canonical form already carried its
kind and its sorted config, so nothing was appended to `workflowGraphHash` and
two fingerprints recorded off a build predating this release are pinned in a
test.
