---
"@dudousxd/nestjs-catalog-pipeline": minor
"@dudousxd/nestjs-catalog": patch
---

A load now has to be plausible before it becomes the data everybody reads

Two failures, and they are the same failure from two ends: a load that is
**fresh and wrong**. Every signal this catalog publishes about a type —
`lastCommittedAt`, the age badge on the Model screen, a green run in the runs
list — reports whether a load HAPPENED. None of them reports whether what it
loaded resembles the dataset it replaced, and a snapshot commit is atomic, so
from the moment a wrong load commits it is indistinguishable from a right one
until somebody counts rows by hand.

**Deleted rows lived in the lake forever.** An incremental connector asks its
source for what changed since a watermark. A row physically removed from the
source never changes again, so it is never returned again, so `carryForward`
copies it into every subsequent snapshot indefinitely. Nothing goes wrong at
any step; the catalog simply never finds out. There was no reconciliation, no
tombstone, and no mention of the limitation anywhere.

`PublishService.carryForwardAsSystem` — the one method every incremental load
passes through, whether it came from a connector, a workflow sink or an
application — now **refuses a type for which no reconciliation strategy has
been declared**. `ConnectorRunSteps` asks the same question before a scheduled
connector reads its source, so a misconfigured connector is refused without
pulling forty thousand rows first and without burning three durable retries on
something that will be exactly as wrong in fifteen minutes.

**A collapsed load committed as though it were healthy.** A connector that
starts returning 12 rows where it returned 40,000 — a source-side filter
change, a broken `WHERE`, a partial outage — committed successfully. Both
commit paths now compare the pending snapshot against the one being served and
refuse a load that lost more of it than the type allows. A refusal leaves the
snapshot written and uncommitted, so readers keep the previous one and the rows
are still there to be looked at; a connector run reports it through
`connector.run.finished` with `status: "failed"`, the same event both outcomes
have always come out of.

**Both are refusals a host will meet.** What to do about it:

Bind `CATALOG_LOAD_EXPECTATIONS` from a module you already pass in
`CatalogPipelineModule.forRoot({ imports })`, exporting the token:

```ts
{
  provide: CATALOG_LOAD_EXPECTATIONS,
  useValue: {
    default: { rowCount: { maxShrink: 0.5, minRows: 100 } },
    byType: {
      AuditEvent: { deletes: { strategy: 'accepted', because: 'append-only ledger' } },
      Employee: {
        deletes: {
          strategy: 'soft-deleted-at-source',
          because: 'HR sets deleted_at, so the watermark sees the removal',
          column: 'deleted_at',
        },
      },
      Mvr: {
        deletes: { strategy: 'periodic-full-reload', because: 'nightly full read', withinMs: 86_400_000 },
        rowCount: { maxShrink: 0.3 },
      },
    },
  },
}
```

- **Every type loaded by an `incremental` connector needs a `deletes` entry**,
  or its next load is refused. The reason is a required field: it is the only
  part of the decision still legible in six months. `periodic-full-reload` is
  the one that is policed — once the last full snapshot is older than
  `withinMs`, incremental loads of that type stop committing.
- **The row-count bound applies with no configuration at all**, defaulting to
  `maxShrink: 0.5` above `minRows: 100`, plus an absolute rule at any size: a
  snapshot of zero rows never replaces a non-empty one. Growth is unbounded
  unless a type sets `maxGrowth` — a type that doubles has usually had a good
  day, a type that loses 90% has not. A load that is legitimately smaller is
  admitted by setting `_expectShrink` in its labels (the publish API passes
  labels through) or by raising `rowCount.maxShrink` for that type.

Two limitations stated rather than glossed. A connector run cannot set
`_expectShrink` today — the runner labels its snapshots `{ source, connector }`
and takes no input for the rest — so a connector whose truncation is deliberate
is unblocked by raising the bound for that type. And a store that implements
neither `currentSnapshot` nor `listSnapshots` has no baseline to compare
against; the row-count check logs a warning naming the type and stands aside
rather than refusing an adapter for recording less than the bundled one does.
