import type {
  DynamicModule,
  ForwardReference,
  InjectionToken,
  Provider,
  Type,
} from '@nestjs/common';
import type { CatalogFanoutJournal } from './journal';

/**
 * Kept in its own file, not beside the module that consumes it.
 *
 * The store needs these tokens and the module needs the store, so declaring the
 * tokens in the module makes the two files import each other. Nest resolves a
 * circular import to `undefined` at injection time, and the error it reports
 * points at the argument position rather than at the cycle.
 */
export const CATALOG_FANOUT_OPTIONS = Symbol('CATALOG_FANOUT_OPTIONS');
export const CATALOG_FANOUT_JOURNAL = Symbol('CATALOG_FANOUT_JOURNAL');
/** The resolved primary, as `{ name, store }`. Bound by the module's factory. */
export const CATALOG_FANOUT_PRIMARY = Symbol('CATALOG_FANOUT_PRIMARY');
/** The resolved followers, in registration order. Bound by the module's factory. */
export const CATALOG_FANOUT_FOLLOWERS = Symbol('CATALOG_FANOUT_FOLLOWERS');

/**
 * What a follower failure costs.
 *
 * - `recorded` — the failure is written to the journal, the load carries on, and
 *   the primary's commit still decides that the load happened. The follower
 *   falls behind by exactly the snapshots it failed, and a replay closes the
 *   gap. Nothing reads from the follower, so nothing serves a wrong answer.
 * - `required` — the load fails. Where the failure is discovered before the
 *   primary has committed, which is every failure of `ensureType`, `write` and
 *   `carryForward`, the primary is not committed either: the load is published
 *   nowhere and the caller's retry replays it from the top. A failure of the
 *   follower's own `commit` call cannot be prevented that way, because the
 *   primary's commit necessarily came first; that one is recorded, the call
 *   throws, and the retry converges.
 *
 * Neither setting rolls anything back. There is no distributed transaction here
 * and this package does not pretend to have one — `required` means "report the
 * load as failed", not "undo it".
 */
export const FOLLOWER_STRICTNESS = ['recorded', 'required'] as const;

export type FollowerStrictness = (typeof FOLLOWER_STRICTNESS)[number];

export function isFollowerStrictness(value: unknown): value is FollowerStrictness {
  return (
    typeof value === 'string' && FOLLOWER_STRICTNESS.some((strictness) => strictness === value)
  );
}

/**
 * The default, and the reason it is this one.
 *
 * A follower is not read from. The primary answers every ordinary read, so a
 * follower that is behind cannot produce a wrong answer to anybody — it can only
 * be incomplete, visibly, in the journal and in the comparison. Defaulting to
 * `required` would mean that attaching a brand-new, unproven store to a working
 * pipeline gives that store a veto over loads into the one that actually serves
 * traffic: a ClickHouse cluster nobody depends on yet could stop the data
 * reaching MySQL. Trading a working authoritative store for an unproven mirror
 * is the wrong trade, and it is the trade that makes teams turn the mirror off
 * entirely.
 *
 * `required` is the correct setting later, in the last stretch before the flip,
 * when the follower is about to become authoritative and divergence should stop
 * the line. The README's migration story escalates to it deliberately.
 */
export const DEFAULT_FOLLOWER_STRICTNESS: FollowerStrictness = 'recorded';

/** One store in the fan-out, named and resolved from the module's injector. */
export interface FanoutParticipantOptions {
  /**
   * How this store is referred to everywhere else: in the journal, in the
   * comparison output, in `readFrom`. Stable and human-chosen, because it
   * outlives the class — the whole point of the migration is that the store
   * behind the name changes.
   */
  name: string;
  /**
   * Any Nest injection token that resolves to a `CatalogWriteStore`: the
   * adapter's concrete class, a symbol the adapter exports, a string.
   *
   * A token rather than an instance, because the adapters have dependencies of
   * their own — an EntityManager, a client pool — and constructing them by hand
   * outside the injector is how a second connection quietly appears.
   */
  store: InjectionToken;
}

export interface FanoutFollowerOptions extends FanoutParticipantOptions {
  /** Defaults to {@link DEFAULT_FOLLOWER_STRICTNESS}. */
  strictness?: FollowerStrictness;
}

export interface CatalogFanoutStoreModuleOptions {
  /**
   * Modules that provide the stores named below.
   *
   * Import the adapter modules **here**, not into your `AppModule`. Each adapter
   * module exports `CATALOG_STORE` for itself, so importing two of them side by
   * side into the same injector leaves that token bound to whichever was
   * registered last — and the fan-out is then bypassed by everything that
   * injects it, with no error anywhere. Imported through this option the
   * adapters' exports stay inside this module, where the fan-out's own
   * `CATALOG_STORE` provider shadows them, and only the fan-out's is re-exported.
   */
  imports?: Array<Type<unknown> | DynamicModule | Promise<DynamicModule> | ForwardReference>;
  /**
   * The store whose commit decides whether a load happened, and the store every
   * read comes from.
   *
   * There is exactly one, and it is not negotiable. Two stores that both accept
   * writes and are both read from will disagree eventually, and nothing in the
   * system is entitled to say which of them is right; reading from whichever
   * answers first turns that disagreement into results that change between
   * requests and a bug report nobody can reproduce.
   */
  primary: FanoutParticipantOptions;
  /**
   * The stores kept in step behind the primary. May be empty, which makes this
   * module a transparent pass-through — useful as the shape you deploy before
   * the second engine exists.
   */
  followers?: FanoutFollowerOptions[];
  /**
   * Where follower failures are written down. Defaults to a JSONL file at
   * {@link DEFAULT_JOURNAL_PATH}.
   *
   * Supply your own for anything running more than one loader process: the file
   * journal is single-process, and two pods compacting the same file will lose
   * entries. See {@link CatalogFanoutJournal}.
   */
  journal?: CatalogFanoutJournal;
  /** Path for the default file journal. Ignored when `journal` is given. */
  journalPath?: string;
  /** Extra providers to make available inside this module, e.g. for a journal. */
  providers?: Provider[];
}

/**
 * Beside the working directory rather than in a temp dir, and visible rather
 * than dotted-away under a cache path: this file is the answer to "what has the
 * follower missed", and a deployment has to decide to persist it. Somewhere it
 * can be forgotten about is somewhere it will be.
 */
export const DEFAULT_JOURNAL_PATH = '.catalog-fanout/journal.jsonl';
