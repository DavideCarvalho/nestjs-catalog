import { createHash } from 'node:crypto';
import type {
  CatalogObjectTypeDef,
  CatalogPropertyDef,
  CatalogReadStore,
} from '@dudousxd/nestjs-catalog';

/**
 * What "the two stores agree" is allowed to mean.
 *
 * A row count is not evidence. Two stores holding the same number of rows and
 * different rows is the single most likely way a dual write goes wrong — a batch
 * that was replaced rather than appended, a transform that ran twice with
 * different input, a retry that landed on one side and not the other — and it is
 * the one shape of failure that counting cannot see. So the comparison also
 * digests the primary-key columns, and it does so with an order-independent
 * aggregate because two engines have no obligation to return rows in the same
 * order and sorting whole datasets on both sides to force the issue would cost
 * more than the migration.
 *
 * The aggregate is a 64-bit sum *and* a 64-bit XOR of per-row hashes. Sum alone
 * misses nothing common but is weak against contrived collisions; XOR alone is
 * blind to duplicates, because a row present twice cancels itself out — and a
 * duplicated row is exactly what an append-instead-of-replace bug produces.
 * Together they catch both, and neither costs more than an addition per row.
 *
 * **What this deliberately does not do.** It does not digest the non-key
 * columns. Doing so would mean reading every column of every row out of both
 * stores through the generic read path, and the two engines disagree about the
 * representation of floats, of dates below second precision, and of JSON key
 * order — so the digest would differ on data that is in fact identical, and an
 * operator who has seen one false mismatch stops believing the next real one.
 * Keys are strings and integers in every schema worth migrating, which is why
 * they are the honest thing to hash.
 */

const MASK64 = (1n << 64n) - 1n;

/** How many rows are pulled per page while digesting. */
export const DEFAULT_COMPARE_PAGE_SIZE = 5000;

export interface FanoutSideDigest {
  /** The configured name of the store this side came from. */
  store: string;
  /** What the store reports as the size of this snapshot. */
  rows: number;
  /**
   * Rows actually walked. A gap between this and `rows` means the snapshot moved
   * under the pagination, which makes the digest meaningless rather than wrong —
   * reported rather than hidden, so nobody reads a mismatch as a data problem.
   */
  digested: number;
  /** Order-independent digest of the primary-key columns. Empty when unkeyed. */
  keyDigest: string;
  /** Rows whose key is wholly or partly NULL, which no digest can identify. */
  unkeyed: number;
  /** False when this store could not be asked about this snapshot at all. */
  readable: boolean;
}

export interface FanoutComparison {
  typeName: string;
  snapshotId: string;
  /** The follower's configured name. */
  follower: string;
  /** Whether the type had a primary key to digest. */
  keyed: boolean;
  primary: FanoutSideDigest;
  followerSide: FanoutSideDigest;
  /**
   * True only when everything that could be checked was checked and agreed. An
   * unkeyed type never reaches `true` on the strength of counts alone — see
   * `reasons`.
   */
  matches: boolean;
  /** Sentences for a human. Empty exactly when `matches` is true. */
  reasons: string[];
}

/**
 * The properties a comparison hashes.
 *
 * Both spellings of a key declaration are accepted, matching what the MikroORM
 * store's merge does — a type that can be merged incrementally must be a type
 * that can be verified, or the deployment where verification matters most is the
 * one that cannot have it.
 */
export function keyProperties(type: CatalogObjectTypeDef): CatalogPropertyDef[] {
  const flagged = type.properties.filter((property) => property.primary);
  if (flagged.length > 0) return flagged;
  const named: CatalogPropertyDef[] = [];
  for (const name of type.primaryKey ?? []) {
    const property = type.properties.find((p) => p.name === name);
    if (property) named.push(property);
  }
  return named;
}

/**
 * Fold one page of rows into the four numbers a digest is made of.
 *
 * Split out from the paging loop precisely because it can be: the sum is taken
 * mod 2^64 and the XOR is bitwise, so both are associative, and folding
 * per-page then combining gives bit-for-bit what folding row-by-row across the
 * whole snapshot would. That is the same property the digest relies on to let
 * two stores page a snapshot in different orders and still agree.
 */
function digestPage(
  rows: readonly Record<string, unknown>[],
  keys: CatalogPropertyDef[],
): { sum: bigint; xor: bigint; digested: number; unkeyed: number } {
  let sum = 0n;
  let xor = 0n;
  let digested = 0;
  let unkeyed = 0;

  for (const row of rows) {
    digested += 1;
    if (keys.length === 0) continue;
    const values = keys.map((property) => row[property.name]);
    if (values.some((value) => value === null || value === undefined)) {
      unkeyed += 1;
      continue;
    }
    const hash = rowHash(keys, values);
    sum = (sum + hash) & MASK64;
    xor ^= hash;
  }

  return { sum, xor, digested, unkeyed };
}

/**
 * Walk one store's copy of a snapshot and reduce it to numbers.
 *
 * Paged rather than pulled whole, because these are datasets — the point of a
 * warehouse is that they do not fit in the heap of whichever process happens to
 * be running the check.
 */
export async function digestSide(
  name: string,
  store: CatalogReadStore,
  type: CatalogObjectTypeDef,
  snapshotId: string,
  options: { pageSize?: number; readable?: boolean } = {},
): Promise<FanoutSideDigest> {
  const empty: FanoutSideDigest = {
    store: name,
    rows: 0,
    digested: 0,
    keyDigest: '',
    unkeyed: 0,
    readable: options.readable !== false,
  };
  if (options.readable === false) return empty;

  const keys = keyProperties(type);
  // With no key there is nothing safe to hash, but the count is still worth
  // having — so the read asks for every property, because a store handed an
  // empty field whitelist is entitled to return nothing at all and would report
  // a snapshot of zero rows.
  const fields =
    keys.length > 0
      ? keys.map((property) => property.name)
      : type.properties.map((property) => property.name);
  if (fields.length === 0) return empty;

  const pageSize = Math.max(1, options.pageSize ?? DEFAULT_COMPARE_PAGE_SIZE);
  // Sorted by the first key column so the pages tile the snapshot instead of
  // overlapping. Without an explicit sort the two engines are free to answer
  // each page in a different order, and paging an unordered result set skips and
  // repeats rows — which would produce a mismatch that is entirely an artefact
  // of how the comparison asked the question.
  const sort = keys.length > 0 ? keys[0]?.name : undefined;

  let sum = 0n;
  let xor = 0n;
  let digested = 0;
  let unkeyed = 0;
  let total = 0;

  for (let page = 1; ; page += 1) {
    const result = await store.read(type, fields, {
      page,
      size: pageSize,
      sort,
      dir: 'asc',
      snapshot: snapshotId,
    });
    total = result.total;
    if (result.rows.length === 0) break;

    const folded = digestPage(result.rows, keys);
    sum = (sum + folded.sum) & MASK64;
    xor ^= folded.xor;
    digested += folded.digested;
    unkeyed += folded.unkeyed;

    if (digested >= total) break;
    // A snapshot is append-only and invisible until committed, so this loop is
    // walking something that is not supposed to change under it. The guard is
    // here anyway: a store whose `total` disagrees with what it will actually
    // hand over would otherwise spin forever, and an infinite loop inside a
    // verification tool is a very bad way to learn that.
    if (page > Math.ceil(total / pageSize) + 1) break;
  }

  return {
    store: name,
    rows: total,
    digested,
    keyDigest:
      keys.length === 0
        ? ''
        : `${sum.toString(16).padStart(16, '0')}:${xor.toString(16).padStart(16, '0')}`,
    unkeyed,
    readable: true,
  };
}

/**
 * The reasons that exist only once both sides could actually be read.
 *
 * The readability check guards the whole group rather than each sentence: an
 * unreadable side carries the zero values of a digest that was never taken, so
 * every comparison below would "fail" and bury the one reason that matters —
 * that there was nothing to compare against — under three that are artefacts of
 * asking anyway.
 */
function agreementReasons(
  type: CatalogObjectTypeDef,
  snapshotId: string,
  follower: string,
  primary: FanoutSideDigest,
  followerSide: FanoutSideDigest,
  keyed: boolean,
): string[] {
  if (!primary.readable || !followerSide.readable) return [];
  const reasons: string[] = [];

  if (primary.rows !== followerSide.rows) {
    const missing = primary.rows - followerSide.rows;
    reasons.push(
      missing > 0
        ? `${follower} holds ${followerSide.rows} rows of ${type.name} snapshot ${snapshotId}; ${primary.store} holds ${primary.rows}. ${missing} row(s) never landed. Replay the snapshot to ${follower}.`
        : `${follower} holds ${followerSide.rows} rows of ${type.name} snapshot ${snapshotId}; ${primary.store} holds only ${primary.rows}. The follower has ${-missing} row(s) too many, which means a batch was appended rather than replaced — a replay rewrites the snapshot from the primary and will clear it.`,
    );
  } else if (keyed && primary.keyDigest !== followerSide.keyDigest) {
    reasons.push(
      `Row counts agree at ${primary.rows}, but the primary-key digest differs (${primary.store}: ${primary.keyDigest}; ${follower}: ${followerSide.keyDigest}). The same number of rows carry different keys, so rows were replaced rather than lost — a count-only check would have called this identical. Replay the snapshot to ${follower}.`,
    );
  }

  if (primary.digested !== primary.rows) {
    reasons.push(
      `${primary.store} reported ${primary.rows} rows for this snapshot and handed over ${primary.digested} while paging, so the snapshot moved during the comparison and the digest above describes nothing in particular. Run this again against a snapshot that is no longer being loaded.`,
    );
  }
  if (followerSide.digested !== followerSide.rows) {
    reasons.push(
      `${follower} reported ${followerSide.rows} rows for this snapshot and handed over ${followerSide.digested} while paging, so the digest above describes nothing in particular.`,
    );
  }

  return reasons;
}

/** Turn two digested sides into a verdict and the sentences that explain it. */
export function explainComparison(
  type: CatalogObjectTypeDef,
  snapshotId: string,
  follower: string,
  primary: FanoutSideDigest,
  followerSide: FanoutSideDigest,
): FanoutComparison {
  const keyed = keyProperties(type).length > 0;
  const reasons: string[] = [];

  if (!primary.readable) {
    reasons.push(
      `${primary.store} cannot be asked about snapshot ${snapshotId}: it keeps no history, so a read of anything but the snapshot it is currently serving would silently answer with current data. There is nothing to compare against.`,
    );
  }
  if (!followerSide.readable) {
    reasons.push(
      `${follower} cannot be asked about snapshot ${snapshotId}: it keeps no history, so it can only be compared while that snapshot is the one it serves. Compare immediately after a load, or accept that this follower is verifiable only at its head.`,
    );
  }

  reasons.push(...agreementReasons(type, snapshotId, follower, primary, followerSide, keyed));

  if (!keyed) {
    reasons.push(
      `${type.name} declares no primary key, so only row counts could be compared. Equal counts here do not mean equal data: a load that replaced every row with a different one produces exactly this result. Publish the type with a primary key before treating this follower as verified.`,
    );
  } else if (primary.unkeyed > 0 || followerSide.unkeyed > 0) {
    reasons.push(
      `${primary.unkeyed} row(s) on ${primary.store} and ${followerSide.unkeyed} on ${follower} have a NULL primary key and were left out of the digest. Those rows are unverifiable — nothing identifies them — and they are also the rows an incremental load duplicates on every run.`,
    );
  }

  return {
    typeName: type.name,
    snapshotId,
    follower,
    keyed,
    primary,
    followerSide,
    matches: reasons.length === 0,
    reasons,
  };
}

/**
 * A stable 64-bit hash of one row's key.
 *
 * The property name goes into the hash alongside the value so that a two-column
 * key of `("a", "bc")` and `("ab", "c")` cannot collide, which a plain
 * concatenation would allow. Values are canonicalised rather than passed to
 * `String()` because the two stores are different engines: one hands back a
 * `Date` where the other hands back an ISO string, and one returns a bigint
 * where the other returns a number. Those are the same key and must hash the
 * same.
 */
function rowHash(keys: CatalogPropertyDef[], values: unknown[]): bigint {
  const hash = createHash('sha256');
  for (let index = 0; index < keys.length; index += 1) {
    hash.update(keys[index]?.name ?? '');
    hash.update('=');
    hash.update(canonical(values[index]));
    hash.update(';');
  }
  return hash.digest().readBigUInt64BE(0);
}

function canonical(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    // Integers are written plainly so that a MySQL BIGINT arriving as a number
    // and a ClickHouse UInt64 arriving as a bigint agree. Non-integers are
    // rounded to fifteen significant digits, which is the most a double can
    // actually carry — without it, two engines' last-bit disagreement on a
    // float would read as a data mismatch. A float has no business being a
    // primary key, and this is the closest a checksum can come to saying so
    // without producing a false alarm.
    return Number.isInteger(value) ? value.toFixed(0) : value.toPrecision(15);
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
