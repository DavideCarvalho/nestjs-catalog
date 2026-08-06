---
"@dudousxd/nestjs-catalog-pipeline": patch
---

Test cron against the parser that ships, not a stub of it

Every scheduled connector in a deployment was silently inert. The worker said so
at boot, once, and contradicted itself on the next line:

    ERROR [ConnectorScheduler] No connector will run on a schedule:
          parser.parseExpression is not a function.
    LOG   [ConnectorScheduler] Watching connector schedules every 30000ms.

`cron-parser` v4 exported `parseExpression`; v5 replaced it with
`CronExpressionParser.parse`. The durable core read only the v4 shape, so
`prevCronFireMs` threw on the first expression it was handed — which is every
expression, for every connector, on every tick.

**No test here could have caught it.** `cron-parser` is an optional peer this
package did not install, so `prevCronFireMs` throws in this repository for a
second, unrelated reason, and any scheduler spec had to stub the parser and
assert against the stub. A stub of the thing that broke cannot fail when the
thing that broke changes.

So `cron-parser` is now a devDependency, and one spec exercises the real seam:
that the version this lockfile resolves is one the durable core can read
through. It does not test `cron-parser` — that library has its own tests — it
tests the join, which is the only thing an API change breaks and exactly what
nobody was checking. It pins the arithmetic a scheduler depends on (the answer
is aligned to the expression, not to the instant, because an unaligned fire time
mints a new run id every tick and turns idempotent scheduling into a runaway),
the timezone being honoured, and both refusals.

Verified by reproducing the incident: with `@dudousxd/nestjs-durable-core`
pinned back to 0.62.0, four of the six cases fail with `parser.parseExpression
is not a function` — the log line from the outage, in CI.
