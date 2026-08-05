---
"@dudousxd/nestjs-catalog-pipeline": minor
---

Somewhere to bind the load expectations, and a way for a run to say a shrink was
meant

Two loose ends left by the load-expectation refusals, both of them about the
same thing: the feature ships on, so the two moments a host actually meets it —
binding it, and being refused by it — are the two moments that had no shape.

**A host had no natural place to bind the token.**
`CATALOG_LOAD_EXPECTATIONS` is how a deployment declares, per object type, how
rows deleted at the source reach the catalog and how far one load may move a row
count. The only way to bind it was to write a module that provides it and pass
that module in `forRoot({ imports })` — a module whose entire body is one
`useValue`. `forRoot` already takes `em` and `registry` as `Provider`s for
exactly this kind of seam, and now takes `expectations` the same way:

```ts
CatalogPipelineModule.forRoot({
  // …em, registry, imports…
  expectations: {
    provide: CATALOG_PIPELINE_TOKENS.expectations,
    useValue: {
      default: { rowCount: { maxShrink: 0.5, minRows: 100 } },
      byType: {
        AuditEvent: {
          deletes: { strategy: 'accepted', because: 'append-only ledger' },
        },
        Mvr: {
          deletes: {
            strategy: 'periodic-full-reload',
            because: 'the nightly connector reads the whole fleet',
            withinMs: 86_400_000,
          },
          rowCount: { maxShrink: 0.3 },
        },
      },
    },
  },
});
```

The docblock on that option is now where somebody learns what to declare and
why, rather than a changeset nobody reads twice. Exporting the token from a
module in `imports` keeps working exactly as before; a host that does both gets
the one passed to `forRoot`, which is Nest's ordinary precedence.

**An absent binding and an empty one are now different statements.** They
produce the same refusals — an incremental load of an undeclared type does not
commit either way — but "nobody here has thought about deletes" and "we looked
and nothing applies" are not the same fact, and only the first is a surprise. A
host that binds nothing now hears one line at boot naming the token, what will
be refused, and the bound that applies meanwhile. A host that binds `{}` has
answered, and is not warned at.

**A connector run can now acknowledge a deliberate truncation.**
`_expectShrink` stands the row-count bound down for one snapshot — a source
deliberately emptied, a type cut back to one base for a migration — and the HTTP
publish path could set it. A connector run could not: the runner hard-coded
`{ source, connector }` as its labels. The only way through was to raise
`rowCount.maxShrink` for the type, run the connector, and lower it again, with
the type unbounded in between and the third step the one that gets forgotten.

`ConnectorRunnerService.run` now takes a fourth argument:

```ts
await runner.run(connectorId, principal.id, snapshotId, {
  expectShrink: 'The 509th was cut back to one base for the migration.',
});
```

A reason rather than a flag, and an empty one is refused with a 400 before a run
row is opened — the same requirement `DeleteReconciliation.because` makes, for
the same reason: the sentence is stored in the snapshot's labels, so "why was
this load allowed to lose most of the data?" is answerable off the snapshot by
somebody who was not there. It is also written to the run's own log, so a
collapse that was permitted does not read like an ordinary load in the runs
list.

**It cannot become permanent, because there is nowhere to keep it.** It is an
argument to one call: not a column on the connector, not a key in
`connector.state` — the runner's watermark, which the catalog documents as never
written by a person — and not a field on `ConnectorRunStepInput`. That last
exclusion is the deliberate one. A scheduled run has no way to acknowledge
anything, because it comes from a cron window attributed to a synthetic
`scheduler` principal with nobody watching, and an acknowledgement given once
and honoured nightly is the bound switched off wearing a reason. A refused
scheduled load is meant to fail loudly and be re-run by hand by somebody willing
to say why.

One thing stated rather than glossed, because it is the last inch: the bundled
`POST /pipeline/connectors/:id/run` route does not yet read `expectShrink` off
its body, so today the acknowledgement is reachable from a host's own controller
or any caller holding the exported `ConnectorRunnerService`, and not from the
bundled route.
