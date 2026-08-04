import type { CatalogObjectTypeDef } from '@dudousxd/nestjs-catalog/client';

/**
 * How old the data a type serves is, said in words.
 *
 * Its own module because two screens ask and the answer must not drift between
 * them: a type reading "4 months" on the model screen and "recent" on a card is
 * worse than neither saying anything.
 *
 * Deliberately NOT a health verdict. The catalog cannot tell a deleted
 * publisher from a monthly load, and a type labelled "orphaned" is a type
 * somebody eventually deletes on the strength of a guess. What is reported is
 * the fact — when it last committed — and the reader, who knows the cadence,
 * draws the conclusion.
 */

/** Never loaded is a different thing from loaded long ago, so it has its own shape. */
export type Freshness = { kind: 'never' } | { kind: 'loaded'; label: string; ageMs: number };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function freshnessOf(type: CatalogObjectTypeDef, now = Date.now()): Freshness {
  if (!type.lastCommittedAt) return { kind: 'never' };

  const at = Date.parse(type.lastCommittedAt);
  if (Number.isNaN(at)) return { kind: 'never' };

  // Clamped at zero rather than reported as negative. Clock skew between the
  // database and the browser is ordinary, and "in 3 minutes" reads as a bug in
  // the catalog rather than as the two-second difference it is.
  const ageMs = Math.max(0, now - at);
  return { kind: 'loaded', label: relative(ageMs), ageMs };
}

function relative(ageMs: number): string {
  if (ageMs < MINUTE) return 'just now';
  if (ageMs < HOUR) return `${Math.floor(ageMs / MINUTE)}m ago`;
  if (ageMs < DAY) return `${Math.floor(ageMs / HOUR)}h ago`;
  const days = Math.floor(ageMs / DAY);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months}mo ago` : `${Math.floor(months / 12)}y ago`;
}

/**
 * Whether to draw attention to it, and the honest answer is "rarely".
 *
 * There is no universal threshold. A type fed by an hourly connector is dead at
 * two days; one fed by a monthly load is healthy at twenty. Without knowing the
 * cadence the only defensible marks are the two that need no cadence to read:
 * nothing was ever committed, and nothing has been committed in a long time by
 * any schedule anyone runs.
 *
 * A week is that line. It is not a claim that a week is bad — it is the point
 * past which the age is worth a second glance rather than a number in the
 * corner.
 */
export function isWorthFlagging(freshness: Freshness): boolean {
  return freshness.kind === 'never' || freshness.ageMs >= 7 * DAY;
}
