import { channelName, emit } from '@dudousxd/nestjs-diagnostics';

/**
 * What this package publishes on `aviary:catalog-fanout:*`.
 *
 * A channel of its own rather than more names on `aviary:catalog:*`, for two
 * reasons. The first is mechanical: the event names of the core package are a
 * closed union there, and adding to it would mean editing a package this one is
 * only supposed to compose against. The second is that these events are about a
 * different subject. `aviary:catalog:*` describes what happened to the data;
 * these describe what happened to the *replication of* the data, and a watcher
 * that cares about one rarely cares about the other.
 *
 * These are for live observability only. They are explicitly NOT where a
 * follower failure is recorded — the channel reaches whoever is subscribed at
 * the moment it fires, and a follower that missed three days of loads is
 * discovered long after that. The durable record is the journal; see
 * {@link import('./journal').CatalogFanoutJournal}.
 */
export const CATALOG_FANOUT_LIB = 'catalog-fanout';

/** Every event this package emits. Exported so a watcher can claim them. */
export const CATALOG_FANOUT_EVENTS = [
  'follower.failed',
  'follower.held-back',
  'follower.recovered',
  'snapshot.fanned-out',
  'comparison.finished',
] as const;

export type CatalogFanoutEvent = (typeof CATALOG_FANOUT_EVENTS)[number];

export interface CatalogFanoutEventPayloads {
  /**
   * A follower could not be brought in line for one step of one snapshot.
   *
   * Fires per step, so a follower that is simply down during a large load emits
   * one of these per batch. That is deliberate: the alternative is one summary
   * event at the end, which never fires when the process dies mid-load — the
   * exact case where somebody needs to know.
   */
  'follower.failed': {
    follower: string;
    typeName: string;
    snapshotId: string;
    stage: string;
    batch?: number;
    strictness: string;
    error: string;
  };
  /**
   * A follower was not committed because earlier steps of the same snapshot had
   * failed on it. Distinct from `follower.failed`: nothing went wrong here, the
   * fan-out refused to publish a load it knows is short.
   */
  'follower.held-back': {
    follower: string;
    typeName: string;
    snapshotId: string;
    /** How many unresolved journal entries held it back. */
    outstanding: number;
  };
  /** A previously failed step of a snapshot succeeded on a retry or a replay. */
  'follower.recovered': {
    follower: string;
    typeName: string;
    snapshotId: string;
    stage: string;
    batch?: number;
  };
  /** A snapshot was committed on the primary, and here is how the rest went. */
  'snapshot.fanned-out': {
    typeName: string;
    snapshotId: string;
    primary: string;
    committed: string[];
    failed: string[];
    heldBack: string[];
  };
  /** A primary/follower comparison finished, whatever it found. */
  'comparison.finished': {
    typeName: string;
    snapshotId: string;
    follower: string;
    matches: boolean;
    primaryRows: number;
    followerRows: number;
  };
}

/**
 * The channel an event is published on.
 *
 * Exported so a recorder or a watcher can subscribe without rebuilding the
 * `aviary:<lib>:<event>` convention by hand — the one place that string is
 * assembled is the one place it can drift.
 */
export function fanoutChannelNameFor(event: CatalogFanoutEvent | string): string {
  return channelName(CATALOG_FANOUT_LIB, event);
}

/**
 * Typed wrapper over `emit`.
 *
 * Never throws — observability that can break a load is worse than no
 * observability — which `emit` already guarantees; this exists for the types.
 */
export function emitFanout<E extends CatalogFanoutEvent>(
  event: E,
  payload: CatalogFanoutEventPayloads[E],
): void {
  emit(CATALOG_FANOUT_LIB, event, payload);
}
