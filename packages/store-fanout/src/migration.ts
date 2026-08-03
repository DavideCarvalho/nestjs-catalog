import type { CatalogObjectTypeDef, CatalogStoreCapabilities } from '@dudousxd/nestjs-catalog';
import { CatalogRegistry } from '@dudousxd/nestjs-catalog';
import { BadRequestException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  DEFAULT_COMPARE_PAGE_SIZE,
  type FanoutComparison,
  type FanoutSideDigest,
  digestSide,
  explainComparison,
  keyProperties,
} from './compare';
import { emitFanout } from './events';
import { CatalogFanoutError, FanoutCatalogStore } from './fanout.store';
import type { FanoutJournalEntry, FanoutStage } from './journal';
import type { FollowerStrictness } from './options';

/**
 * The operations that make a fan-out a migration rather than a dual write.
 *
 * Everything here is deliberately manual. Nothing drains the journal in the
 * background, nothing retries a follower on a timer, nothing flips a primary
 * because the numbers looked good. A migration between two engines is a decision
 * somebody makes and is answerable for, and an automation that quietly repaired
 * followers would also quietly hide how often they break — which is the single
 * fact the decision depends on.
 */

export interface FanoutFollowerStatus {
  name: string;
  strictness: FollowerStrictness;
  /** What this store says about itself, before composition. */
  capabilities: CatalogStoreCapabilities;
  outstanding: FanoutJournalEntry[];
  /** One line per snapshot this follower owes something for. */
  behind: Array<{ typeName: string; snapshotId: string; stages: string[] }>;
}

export interface FanoutStatus {
  primary: { name: string; capabilities: CatalogStoreCapabilities };
  /** What the fan-out as a whole reports. See `composeCapabilities`. */
  composed: CatalogStoreCapabilities;
  followers: FanoutFollowerStatus[];
  /** True when no follower owes anything. Not the same as verified. */
  clean: boolean;
}

export interface FanoutVerification {
  /**
   * True only when every comparison matched and no follower owes anything.
   *
   * This is the gate for flipping a primary, and it is deliberately strict:
   * "mostly caught up" is the state every failed migration was in the day before
   * it was discovered.
   */
  ready: boolean;
  comparisons: FanoutComparison[];
  outstanding: FanoutJournalEntry[];
  reasons: string[];
}

export interface FanoutReplayResult {
  typeName: string;
  snapshotId: string;
  follower: string;
  batches: number;
  rows: number;
  committed: boolean;
  /** Journal entries the replay discharged. */
  cleared: number;
  /** Anything the operator should know that is not a failure. */
  notes: string[];
  /** The replay is only finished if this matched. */
  comparison: FanoutComparison;
}

/** Steps a replay discharges, because it supplies the rows they were meant to. */
const REPLAYED_STAGES: FanoutStage[] = ['ensureType', 'write', 'carryForward'];

@Injectable()
export class CatalogFanoutMigration {
  private readonly logger = new Logger(CatalogFanoutMigration.name);

  constructor(
    private readonly fanout: FanoutCatalogStore,
    /**
     * Optional because a fan-out is useful in a process that has no registry —
     * a loader, a migration script — and requiring one would make this service
     * unresolvable there. Without it every method still works; they just have to
     * be handed a `CatalogObjectTypeDef` instead of a type name.
     */
    @Optional()
    @Inject(CatalogRegistry)
    private readonly registry?: CatalogRegistry,
  ) {}

  /** What each follower owes right now, straight off the journal. */
  async status(): Promise<FanoutStatus> {
    const followers: FanoutFollowerStatus[] = [];
    for (const follower of this.fanout.followers) {
      const outstanding = await this.fanout.journal.outstanding({
        follower: follower.name,
      });
      const grouped = new Map<string, { typeName: string; snapshotId: string; stages: string[] }>();
      for (const entry of outstanding) {
        const key = `${entry.typeName}/${entry.snapshotId}`;
        const existing = grouped.get(key);
        const stage =
          entry.batch === undefined ? entry.stage : `${entry.stage} batch ${entry.batch}`;
        if (existing) existing.stages.push(stage);
        else {
          grouped.set(key, {
            typeName: entry.typeName,
            snapshotId: entry.snapshotId,
            stages: [stage],
          });
        }
      }
      followers.push({
        name: follower.name,
        strictness: follower.strictness,
        capabilities: follower.store.capabilities,
        outstanding,
        behind: Array.from(grouped.values()),
      });
    }

    return {
      primary: {
        name: this.fanout.primary.name,
        capabilities: this.fanout.primary.store.capabilities,
      },
      composed: this.fanout.capabilities,
      followers,
      clean: followers.every((follower) => follower.outstanding.length === 0),
    };
  }

  /**
   * Compare one snapshot on the primary against one or every follower.
   *
   * Defaults to the snapshot the fan-out last committed, because that is the one
   * whose disagreement matters — an old snapshot that never matched is history,
   * and the question at a cutover is always "is the follower right *now*".
   */
  async compare(
    type: string | CatalogObjectTypeDef,
    options: {
      snapshotId?: string;
      follower?: string;
      pageSize?: number;
    } = {},
  ): Promise<FanoutComparison[]> {
    const resolved = this.resolveType(type);
    const snapshotId = options.snapshotId ?? (await this.currentSnapshotOf(resolved));
    const followers =
      options.follower === undefined
        ? this.fanout.followers
        : [this.fanout.followerNamed(options.follower)];
    if (followers.length === 0) return [];

    const pageSize = options.pageSize ?? DEFAULT_COMPARE_PAGE_SIZE;
    const current = await this.fanout.journal.lastCommitted(resolved.name);
    const readable = (capabilities: CatalogStoreCapabilities): boolean =>
      capabilities.timeTravel || snapshotId === current?.snapshotId;

    const primarySide: FanoutSideDigest = await digestSide(
      this.fanout.primary.name,
      this.fanout.primary.store,
      resolved,
      snapshotId,
      { pageSize, readable: readable(this.fanout.primary.store.capabilities) },
    );

    const comparisons: FanoutComparison[] = [];
    for (const follower of followers) {
      const followerSide = await digestSide(follower.name, follower.store, resolved, snapshotId, {
        pageSize,
        readable: readable(follower.store.capabilities),
      });
      const comparison = explainComparison(
        resolved,
        snapshotId,
        follower.name,
        primarySide,
        followerSide,
      );
      emitFanout('comparison.finished', {
        typeName: resolved.name,
        snapshotId,
        follower: follower.name,
        matches: comparison.matches,
        primaryRows: primarySide.rows,
        followerRows: followerSide.rows,
      });
      comparisons.push(comparison);
    }
    return comparisons;
  }

  /**
   * The cutover gate: compare every type's current snapshot on every follower,
   * and refuse to call it ready while anything is outstanding.
   *
   * Needs a registry to enumerate the types. Hand it a list when there is none.
   */
  async verify(
    options: { types?: Array<string | CatalogObjectTypeDef>; pageSize?: number } = {},
  ): Promise<FanoutVerification> {
    const types = options.types
      ? options.types.map((type) => this.resolveType(type))
      : this.allTypes();

    const comparisons: FanoutComparison[] = [];
    const reasons: string[] = [];
    for (const type of types) {
      try {
        comparisons.push(...(await this.compare(type, { pageSize: options.pageSize })));
      } catch (cause) {
        // A type nobody has ever loaded has no snapshot to compare, which is not
        // a verification failure — it is a type with no data. Anything else is
        // reported as a reason rather than thrown, because a single unreadable
        // type must not hide the state of the other forty.
        reasons.push(
          `${type.name} could not be compared: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    }

    const outstanding = await this.fanout.journal.outstanding();
    if (outstanding.length > 0) {
      const byFollower = new Map<string, number>();
      for (const entry of outstanding) {
        byFollower.set(entry.follower, (byFollower.get(entry.follower) ?? 0) + 1);
      }
      for (const [follower, count] of byFollower) {
        reasons.push(
          `${follower} still owes ${count} step(s) according to the journal. Replay them before flipping: an entry here means a load that the primary published and this store did not.`,
        );
      }
    }
    for (const comparison of comparisons) {
      reasons.push(...comparison.reasons);
    }

    return {
      ready: reasons.length === 0 && comparisons.length > 0,
      comparisons,
      outstanding,
      reasons,
    };
  }

  /**
   * Re-send one snapshot to one follower, from the primary, without touching the
   * source.
   *
   * **Why this is possible at all.** A snapshot on the primary is complete,
   * immutable and addressable by id — that is what the core store model buys.
   * Even for an incremental load, the primary's snapshot already holds the
   * carried-forward rows as real rows, so the copy needs no merge of its own and
   * no knowledge of what the previous snapshot contained. That is the property
   * that makes a follower failure recoverable rather than merely visible, and it
   * is the reason this package is a defensible thing to build where a row-level
   * dual write would not be.
   *
   * **The sequence.**
   *
   * 1. Refuse if the primary cannot read the snapshot. A store without time
   *    travel can only be asked for the one it is currently serving, and reading
   *    it for any other id would silently hand over current data under an old
   *    name — the worst outcome available here.
   * 2. `ensureType` on the follower, because the reason the rows never arrived is
   *    quite often that the table never did.
   * 3. Drop the follower's copy of the snapshot. Necessary, not tidy: `write`
   *    replaces per batch, so a shorter replay over a longer failed attempt
   *    would leave the failed attempt's high-numbered batches in place, and the
   *    follower would end up holding more rows than the primary with every batch
   *    individually correct.
   * 4. Page the primary's snapshot into the follower in fresh batches.
   * 5. Discharge the journal entries the copy supplied.
   * 6. Commit on the follower, but only when this snapshot is the one the
   *    primary is currently serving. Backfilling an older snapshot must not
   *    repoint the follower at last week.
   * 7. Compare, and return the comparison. A replay that did not end in a match
   *    is not a finished replay.
   *
   * **If it fails partway** the follower holds less than it did when it started,
   * and the journal still records the original debt. That is deliberate: the
   * follower was already known-incomplete, and a half-copied snapshot that is
   * still marked as owed will be repaired by running this again.
   */
  async replay(
    type: string | CatalogObjectTypeDef,
    snapshotId: string,
    followerName: string,
    options: { batchSize?: number; commit?: boolean } = {},
  ): Promise<FanoutReplayResult> {
    const resolved = this.resolveType(type);
    const follower = this.fanout.followerNamed(followerName);
    const primary = this.fanout.primary;
    const notes: string[] = [];

    const current = await this.fanout.journal.lastCommitted(resolved.name);
    if (!primary.store.capabilities.timeTravel && snapshotId !== current?.snapshotId) {
      throw new BadRequestException(
        `${primary.name} keeps no history, so it can only be replayed from the snapshot it is currently serving${
          current ? ` (${current.snapshotId})` : ''
        }. Asking it for ${snapshotId} would hand over current data labelled as that snapshot.`,
      );
    }

    await follower.store.ensureType(resolved);
    await this.clearFollowerCopy(resolved, snapshotId, followerName);

    const fields = resolved.properties.map((property) => property.name);
    if (fields.length === 0) {
      throw new BadRequestException(
        `${resolved.name} has no properties, so there is nothing to replay.`,
      );
    }
    // Sorted by the first key column so successive pages tile the snapshot.
    // Without it the store is free to answer each page in a different order and
    // the copy would skip and repeat rows — a replay that produces a plausible
    // row count and the wrong data.
    const keys = keyProperties(resolved);
    const sort = keys.length > 0 ? keys[0]?.name : undefined;
    if (sort === undefined) {
      notes.push(
        `${resolved.name} has no primary key, so the pages of this replay are ordered only by whatever the primary considers natural. Re-run it if the snapshot is still being written to.`,
      );
    }

    const size = Math.max(1, options.batchSize ?? DEFAULT_REPLAY_BATCH_SIZE);
    const principalId = await this.principalFor(resolved, snapshotId);

    let batches = 0;
    let rows = 0;
    for (let page = 1; ; page += 1) {
      const result = await primary.store.read(resolved, fields, {
        page,
        size,
        sort,
        dir: 'asc',
        snapshot: snapshotId,
      });
      if (result.rows.length === 0) break;
      await follower.store.write(resolved, result.rows, {
        snapshotId,
        principalId,
        batch: batches,
        labels: { _replayedFrom: primary.name, _replayedAt: new Date().toISOString() },
      });
      batches += 1;
      rows += result.rows.length;
      if (rows >= result.total) break;
      if (page > Math.ceil(result.total / size) + 1) break;
    }

    const cleared = await this.fanout.clearDebt(
      resolved.name,
      snapshotId,
      followerName,
      REPLAYED_STAGES,
    );

    const shouldCommit =
      options.commit ?? (current === undefined ? false : current.snapshotId === snapshotId);
    if (options.commit === undefined && current === undefined) {
      notes.push(
        `This journal has no record of which snapshot ${primary.name} is serving — it was empty when the fan-out started, or the commit happened before this package was installed — so the rows were staged on ${followerName} and not committed. Pass \`commit: true\` once you have checked that ${snapshotId} is the current snapshot.`,
      );
    }
    if (shouldCommit) {
      await this.fanout.commitFollower(resolved, snapshotId, followerName);
    } else if (options.commit !== true && current !== undefined) {
      notes.push(
        `${snapshotId} is not the snapshot ${primary.name} is serving (${current.snapshotId}), so the rows were staged on ${followerName} without being committed. Committing an older snapshot there would point the follower at data the catalog has moved on from.`,
      );
    }

    const [comparison] = await this.compare(resolved, {
      snapshotId,
      follower: followerName,
    });
    if (!comparison) {
      throw new CatalogFanoutError(
        `Replayed ${rows} rows of ${resolved.name} snapshot ${snapshotId} to ${followerName}, but the comparison could not be run, so the replay is unverified.`,
        [],
      );
    }

    this.logger.log(
      comparison.matches
        ? `Replayed ${rows} row(s) of ${resolved.name} snapshot ${snapshotId} to ${followerName} in ${batches} batch(es); the two sides now agree.`
        : `Replayed ${rows} row(s) of ${resolved.name} snapshot ${snapshotId} to ${followerName}, and the two sides still disagree: ${comparison.reasons.join(' ')}`,
    );

    return {
      typeName: resolved.name,
      snapshotId,
      follower: followerName,
      batches,
      rows,
      committed: shouldCommit,
      cleared,
      notes,
      comparison,
    };
  }

  /**
   * Remove the follower's existing copy of a snapshot before rewriting it.
   *
   * A failed drop is not automatically fatal. Most adapters treat dropping a
   * snapshot they have never seen as a no-op, but nothing in the interface says
   * they must, and refusing to replay to a follower because it has never heard
   * of the snapshot would break the one case this method exists for. So a
   * failure is checked against what the follower actually holds: nothing means
   * there was nothing to drop, and anything else means a rewrite would leave the
   * old attempt's tail behind.
   */
  private async clearFollowerCopy(
    type: CatalogObjectTypeDef,
    snapshotId: string,
    followerName: string,
  ): Promise<void> {
    const follower = this.fanout.followerNamed(followerName);
    try {
      await follower.store.dropSnapshot(type, snapshotId);
      return;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (!follower.store.capabilities.timeTravel) {
        throw new BadRequestException(
          `${followerName} would not drop its copy of ${type.name} snapshot ${snapshotId} (${message}), and it keeps no history, so there is no way to ask how much of that snapshot it is holding. Rewriting on top of it could leave batches of the failed attempt behind. Resolve this on ${followerName} by hand.`,
        );
      }
      const fields = keyProperties(type).map((property) => property.name);
      const existing = await follower.store.read(
        type,
        fields.length > 0 ? fields : type.properties.map((p) => p.name),
        { page: 1, size: 1, snapshot: snapshotId },
      );
      if (existing.total === 0) return;
      throw new BadRequestException(
        `${followerName} holds ${existing.total} row(s) of ${type.name} snapshot ${snapshotId} and would not drop them (${message}). This usually means that snapshot is the one it is currently serving. Commit a newer snapshot there first, or drop it by hand — replaying on top of it would leave the failed attempt's later batches in place.`,
      );
    }
  }

  /**
   * Who the replayed snapshot is attributed to.
   *
   * The original loader wherever the primary still remembers, because a snapshot
   * that changes owner when it is repaired loses the one thing its provenance is
   * for. Only when the primary cannot say does this fall back to naming the
   * replay itself, which is at least honest about who wrote those rows.
   */
  private async principalFor(type: CatalogObjectTypeDef, snapshotId: string): Promise<string> {
    const list = this.fanout.primary.store.listSnapshots;
    if (list) {
      const refs = await list.call(this.fanout.primary.store, type);
      const ref = refs.find((each) => each.id === snapshotId);
      if (ref) return ref.principalId;
    }
    const mark = await this.fanout.journal.lastCommitted(type.name);
    if (mark?.snapshotId === snapshotId && mark.principalId) {
      return mark.principalId;
    }
    return `catalog-fanout/replay@${this.fanout.primary.name}`;
  }

  /** The snapshot a comparison defaults to. */
  private async currentSnapshotOf(type: CatalogObjectTypeDef): Promise<string> {
    const mark = await this.fanout.journal.lastCommitted(type.name);
    if (mark) return mark.snapshotId;

    // Falling back to the store's own list, newest first, because a fan-out
    // installed on top of an existing catalog has a journal that knows nothing
    // about the loads that came before it. The list is what the store is willing
    // to say; it does not distinguish committed from half-written, which is why
    // it is the fallback and not the first answer.
    const list = this.fanout.primary.store.listSnapshots;
    if (list) {
      const refs = await list.call(this.fanout.primary.store, type);
      const newest = refs[0];
      if (newest) return newest.id;
    }
    throw new BadRequestException(
      `Nothing has been committed for ${type.name}, so there is no snapshot to compare. Load it once first.`,
    );
  }

  private resolveType(type: string | CatalogObjectTypeDef): CatalogObjectTypeDef {
    if (typeof type !== 'string') return type;
    if (!this.registry) {
      throw new BadRequestException(
        `This process has no CatalogRegistry, so "${type}" cannot be resolved to a type definition. Pass the CatalogObjectTypeDef instead, or import a module that provides a registry.`,
      );
    }
    const resolved = this.registry.getType(type);
    if (!resolved) {
      throw new BadRequestException(`Unknown object type: ${type}`);
    }
    return resolved;
  }

  private allTypes(): CatalogObjectTypeDef[] {
    if (!this.registry) {
      throw new BadRequestException(
        'This process has no CatalogRegistry, so the types to verify cannot be enumerated. Pass them explicitly.',
      );
    }
    return this.registry.getSnapshot().types;
  }
}

/**
 * Rows per batch when replaying.
 *
 * Larger than a typical connector's batch because a replay is reading from a
 * warehouse rather than from an API with a page limit, and every batch is a
 * round trip to two stores. Small enough that one batch is bounded memory.
 */
export const DEFAULT_REPLAY_BATCH_SIZE = 5000;
