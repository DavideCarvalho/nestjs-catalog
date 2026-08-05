/**
 * How the staleness check picks the full snapshot it dates the interval from.
 *
 * `refuseStaleReconciliation` is the half that makes `periodic-full-reload` a
 * mechanism rather than a note, and all of it rests on one choice: which of the
 * full snapshots the store reported is the newest. That was decided by
 * comparing the two `createdAt` STRINGS, which is only chronological while
 * every store writes the same UTC ISO-8601 shape — something this cannot check
 * and something that did not hold.
 *
 * The expensive case is a timestamp that cannot be read at all. `"unknown"`
 * sorts above every real timestamp, because `'u'` is past every digit; it won
 * the comparison for newest; `Date.parse` of it is `NaN`; and `NaN > withinMs`
 * is false, so the load was admitted. One unreadable row in a list whose other
 * rows could have dated the type perfectly well switched the bound off, and
 * nothing anywhere said so — a guard that cannot measure deciding to say
 * nothing, which is the failure this whole file exists to prevent in the data.
 *
 * The cheap case is an offset other than `Z`, which mis-ordered by up to a day
 * and therefore refused slightly more than it should. Wrong in the safe
 * direction, and fixed by the same change: compare instants, not text.
 *
 * The list ordering these are about is not hypothetical. The function's own
 * docblock says "newest first is not assumed", because `listSnapshots` is
 * whatever a store chose to return.
 */
import type { SnapshotRef } from '@dudousxd/nestjs-catalog';
import { describe, expect, it } from 'vitest';
import { CARRIED_FROM_LABEL, refuseStaleReconciliation } from './load-expectations';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-01-10T00:00:00.000Z');

const nightly = {
  deletes: { strategy: 'periodic-full-reload', because: 'nightly', withinMs: DAY },
} as const;

function snapshot(over: Partial<SnapshotRef> & { id: string }): SnapshotRef {
  return {
    createdAt: new Date(NOW).toISOString(),
    rowCount: 0,
    principalId: 'ingest',
    ...over,
  };
}

describe('refuseStaleReconciliation: dating the last full reload', () => {
  it('refuses on the real timestamps beside one it cannot read', () => {
    // The whole bug in five lines. `full-old` is nine days past a one-day
    // interval and is perfectly readable; `full-broken` is the kind of thing a
    // store writes when it has no timestamp to give. Sorted as text the broken
    // one is "newest", its age is NaN, and NaN is not greater than anything —
    // so the type went on carrying forward rows deleted upstream nine days ago.
    const refusal = refuseStaleReconciliation(
      'Mvr',
      nightly,
      [
        snapshot({ id: 'full-old', createdAt: new Date(NOW - 9 * DAY).toISOString() }),
        snapshot({ id: 'full-broken', createdAt: 'unknown' }),
      ],
      NOW,
    );

    expect(refusal).toContain('full-old');
    expect(refusal).toContain('refused');
  });

  it('does not let an unreadable timestamp hold the clock open from either end of the list', () => {
    // Same two snapshots, other order. Nothing about the answer may depend on
    // what order a store happened to return them in.
    const refusal = refuseStaleReconciliation(
      'Mvr',
      nightly,
      [
        snapshot({ id: 'full-broken', createdAt: '' }),
        snapshot({ id: 'full-old', createdAt: new Date(NOW - 9 * DAY).toISOString() }),
      ],
      NOW,
    );

    expect(refusal).toContain('full-old');
  });

  it('still names the newest readable one when several are readable', () => {
    const refusal = refuseStaleReconciliation(
      'Mvr',
      nightly,
      [
        snapshot({ id: 'full-ancient', createdAt: new Date(NOW - 90 * DAY).toISOString() }),
        snapshot({ id: 'full-broken', createdAt: 'whenever' }),
        snapshot({ id: 'full-recent', createdAt: new Date(NOW - 3 * DAY).toISOString() }),
      ],
      NOW,
    );

    // Three days, not ninety: an unreadable row must not push the answer to the
    // oldest one either. Being refused with the wrong snapshot named sends an
    // operator to look at a load that was fine.
    expect(refusal).toContain('full-recent');
    expect(refusal).toContain('3 days ago');
  });

  it('admits a readable full reload inside the interval, unreadable rows notwithstanding', () => {
    // The other direction, and the one that would make this change dangerous if
    // it were wrong: dropping unreadable rows must not turn a healthy type into
    // a refused one.
    expect(
      refuseStaleReconciliation(
        'Mvr',
        nightly,
        [
          snapshot({ id: 'full-broken', createdAt: 'unknown' }),
          snapshot({ id: 'full-today', createdAt: new Date(NOW - 2 * HOUR).toISOString() }),
        ],
        NOW,
      ),
    ).toBeUndefined();
  });

  it('orders by the instant rather than by the text of the timestamp', () => {
    // `2026-01-10T00:00:00.000+05:00` is 19:00 the previous day in UTC — five
    // hours old — and `2026-01-09T23:00:00.000Z` is one hour old. As text the
    // first sorts above the second, because `'2026-01-10'` beats `'2026-01-09'`
    // before the offset is ever reached, so the older one was called the newest
    // and a type reconciled an hour ago was refused against a three-hour
    // interval.
    expect(
      refuseStaleReconciliation(
        'Mvr',
        { deletes: { strategy: 'periodic-full-reload', because: 'every 3h', withinMs: 3 * HOUR } },
        [
          snapshot({ id: 'full-offset', createdAt: '2026-01-10T00:00:00.000+05:00' }),
          snapshot({ id: 'full-utc', createdAt: '2026-01-09T23:00:00.000Z' }),
        ],
        NOW,
      ),
    ).toBeUndefined();
  });

  it('admits when not one full snapshot carries a timestamp it can read', () => {
    // Deliberate, and the same stance CARRIED_FROM_LABEL takes: a store that
    // records less than the bundled one is not the failure this file exists
    // for, and there is nothing here to refuse ON — every comparison available
    // is against NaN. What changed is only how narrow this branch is. It used
    // to be reached by ONE unreadable timestamp anywhere in the list.
    expect(
      refuseStaleReconciliation(
        'Mvr',
        nightly,
        [
          snapshot({ id: 'full-a', createdAt: 'unknown' }),
          snapshot({ id: 'full-b', createdAt: 'also unknown' }),
        ],
        NOW,
      ),
    ).toBeUndefined();
  });

  it('counts a carried-forward snapshot out before any of this', () => {
    // An unreadable timestamp on an INCREMENTAL snapshot has never been able to
    // reach the dating at all, and must not start now: the filter on
    // CARRIED_FROM_LABEL runs first, and what is left is what gets dated.
    const refusal = refuseStaleReconciliation(
      'Mvr',
      nightly,
      [
        snapshot({ id: 'full-old', createdAt: new Date(NOW - 9 * DAY).toISOString() }),
        snapshot({ id: 'inc-9', createdAt: 'unknown', labels: { [CARRIED_FROM_LABEL]: 'inc-8' } }),
      ],
      NOW,
    );

    expect(refusal).toContain('full-old');
  });
});
