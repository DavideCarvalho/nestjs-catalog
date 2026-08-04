/**
 * How old the data a type serves is.
 *
 * The failure this exists for: a type whose publisher was deleted in January
 * and a type loaded ten minutes ago arrived at the screen byte-identical, so
 * somebody read a number off the first one in June and had no way to know.
 *
 * The distinction that carries the most weight here is NEVER LOADED versus
 * LOADED LONG AGO. They are different facts with different fixes — one is a
 * schema nobody has run yet, the other is a pipeline that stopped — and
 * collapsing them into "old" is how the second gets mistaken for the first and
 * ignored.
 */
import type { CatalogObjectTypeDef } from '@dudousxd/nestjs-catalog/client';
import { describe, expect, it } from 'vitest';
import { freshnessOf, isWorthFlagging } from './freshness';

const NOW = Date.parse('2026-08-04T12:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function typeCommittedAt(iso: string | undefined): CatalogObjectTypeDef {
  const base = {
    name: 'Mvr',
    displayName: 'MVR',
    pluralDisplayName: 'MVRs',
    tableName: 'mvr',
    group: 'fleet',
    primaryKey: ['id'],
    enriched: true,
    properties: [],
    relations: [],
  };
  // The key is ABSENT for a never-loaded type, not present-and-undefined —
  // matching what the server sends, so the test cannot pass on a shape the
  // screen will never actually receive.
  return iso ? { ...base, lastCommittedAt: iso } : base;
}

describe('how old the data is', () => {
  it('says a type was never loaded rather than calling it infinitely old', () => {
    // A schema published and never run is not a broken pipeline. Reporting it
    // as "56y ago" — which is what an epoch-zero fallback would do — sends
    // somebody looking for a failure that never happened.
    expect(freshnessOf(typeCommittedAt(undefined), NOW)).toEqual({ kind: 'never' });
  });

  it('treats an unparseable timestamp as never, not as now', () => {
    // Failing towards "fresh" would be the one wrong direction: a signal that
    // reports healthy when it cannot tell is worse than no signal.
    expect(freshnessOf(typeCommittedAt('not a date'), NOW).kind).toBe('never');
  });

  it('reads recent loads in the units somebody actually asks in', () => {
    const at = (ms: number) => freshnessOf(typeCommittedAt(new Date(NOW - ms).toISOString()), NOW);

    expect(at(30_000)).toMatchObject({ label: 'just now' });
    expect(at(5 * MINUTE)).toMatchObject({ label: '5m ago' });
    expect(at(3 * HOUR)).toMatchObject({ label: '3h ago' });
    expect(at(2 * DAY)).toMatchObject({ label: '2d ago' });
    expect(at(90 * DAY)).toMatchObject({ label: '3mo ago' });
    expect(at(400 * DAY)).toMatchObject({ label: '1y ago' });
  });

  it('never reports data from the future', () => {
    // Clock skew between the database and the browser is ordinary. "in 3
    // minutes" reads as a bug in the catalog rather than as the two seconds it
    // is, and a reader who distrusts the signal ignores it when it matters.
    const ahead = new Date(NOW + 5 * MINUTE).toISOString();

    expect(freshnessOf(typeCommittedAt(ahead), NOW)).toMatchObject({
      label: 'just now',
      ageMs: 0,
    });
  });
});

describe('what is worth drawing attention to', () => {
  it('flags a type nothing was ever committed to', () => {
    expect(isWorthFlagging(freshnessOf(typeCommittedAt(undefined), NOW))).toBe(true);
  });

  it('leaves a recently loaded type alone', () => {
    // The restraint is the feature. A screen that marks everything marks
    // nothing, and this list is every type in the catalog.
    const fresh = freshnessOf(typeCommittedAt(new Date(NOW - HOUR).toISOString()), NOW);

    expect(isWorthFlagging(fresh)).toBe(false);
  });

  it('leaves a load from six days ago alone, and flags one from eight', () => {
    // Both sides pinned, because a threshold asserted from one direction only
    // passes just as well when it is never reached.
    const six = freshnessOf(typeCommittedAt(new Date(NOW - 6 * DAY).toISOString()), NOW);
    const eight = freshnessOf(typeCommittedAt(new Date(NOW - 8 * DAY).toISOString()), NOW);

    expect(isWorthFlagging(six)).toBe(false);
    expect(isWorthFlagging(eight)).toBe(true);
  });
});
