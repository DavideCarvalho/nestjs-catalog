import { prevCronFireMs } from '@dudousxd/nestjs-durable-core';
import { describe, expect, it } from 'vitest';

/**
 * That a cron expression can actually be parsed by the parser that ships.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every scheduled connector in a deployment was silently inert for an unknown
 * period. The worker said so at boot, once, and contradicted itself on the next
 * line:
 *
 *     ERROR [ConnectorScheduler] No connector will run on a schedule:
 *           parser.parseExpression is not a function.
 *     LOG   [ConnectorScheduler] Watching connector schedules every 30000ms.
 *
 * `cron-parser` v4 exported `parseExpression`; v5 replaced it with
 * `CronExpressionParser.parse`. The durable core read only the v4 shape, so
 * `prevCronFireMs` threw on the first expression it was handed — which is every
 * expression, for every connector, on every tick.
 *
 * **No test in this repository could have caught it.** `cron-parser` is an
 * optional peer that this package did not install, so `prevCronFireMs` throws
 * here for a second, unrelated reason, and any scheduler spec had to stub the
 * parser and assert against the stub. A stub of the thing that broke cannot
 * fail when the thing that broke changes — that is the whole lesson, and it is
 * why the dependency is now a devDependency rather than something CI can do
 * without.
 *
 * WHAT THIS ASSERTS, AND WHAT IT DELIBERATELY DOES NOT
 * ----------------------------------------------------
 * It does not test `cron-parser`; that library has its own tests. It asserts
 * the SEAM: that the version resolved by this repository's lockfile is one the
 * durable core can read through. That is the only thing an API change breaks,
 * and it is exactly what nobody was checking.
 *
 * It also does not assert a fixed timestamp. `prevCronFireMs` answers relative
 * to the clock it is handed, so pinning a literal would make this fail with the
 * calendar rather than with a regression. What is pinned is the arithmetic a
 * caller depends on: the answer is the most recent fire time at or before
 * `now`, aligned to the expression.
 */

/** 2026-08-06T02:37:41.123Z — a moment deliberately not on any boundary. */
const NOW = Date.UTC(2026, 7, 6, 2, 37, 41, 123);

describe('the cron parser this repository actually resolves', () => {
  it('parses a five-field expression rather than throwing', () => {
    // THE case. On the broken combination this is where
    // `parser.parseExpression is not a function` came from, and a scheduler
    // that cannot get past this line schedules nothing at all while reporting
    // that it is watching.
    expect(() => prevCronFireMs('* * * * *', NOW, 'UTC')).not.toThrow();
  });

  it('answers the previous minute boundary, not the current instant', () => {
    // The seconds and milliseconds must be dropped. A scheduler derives a run
    // id from the fire time, so an unaligned answer mints a new id every tick —
    // which turns `engine.start`'s idempotency into a fresh run per poll, and a
    // connector into a runaway rather than a schedule.
    const fired = prevCronFireMs('* * * * *', NOW, 'UTC');

    expect(new Date(fired).toISOString()).toBe('2026-08-06T02:37:00.000Z');
  });

  it('honours a coarser expression', () => {
    // Hourly, from 02:37 — proves the expression is being read rather than the
    // clock merely being truncated, which a naive implementation would pass.
    const fired = prevCronFireMs('0 * * * *', NOW, 'UTC');

    expect(new Date(fired).toISOString()).toBe('2026-08-06T02:00:00.000Z');
  });

  it('interprets the expression in the timezone it is given', () => {
    // The other half of the boot probe's error message: the scheduler passes
    // `CATALOG_SCHEDULE_TZ`, and a parser that ignored it would put every daily
    // schedule in the wrong place by hours without failing anything.
    //
    // Midnight in São Paulo (UTC-3) on this date is 03:00 UTC, which is AFTER
    // `NOW` — so the previous daily fire is the day before.
    const fired = prevCronFireMs('0 0 * * *', NOW, 'America/Sao_Paulo');

    expect(new Date(fired).toISOString()).toBe('2026-08-05T03:00:00.000Z');
  });

  it('refuses an expression it cannot read, rather than inventing a time', () => {
    // A connector with a typo in its cron must fail loudly. Answering some
    // plausible timestamp would schedule it at a moment nobody asked for, and
    // the scheduler's own refusal path depends on this throwing.
    expect(() => prevCronFireMs('not a cron', NOW, 'UTC')).toThrow();
  });

  it('refuses a timezone it does not know', () => {
    // Same shape, other input. `CATALOG_SCHEDULE_TZ` is read from the
    // environment, so a typo there is a deployment-wide fault and must surface
    // at the boot probe rather than as silently shifted schedules.
    expect(() => prevCronFireMs('* * * * *', NOW, 'Mars/Olympus_Mons')).toThrow();
  });
});
