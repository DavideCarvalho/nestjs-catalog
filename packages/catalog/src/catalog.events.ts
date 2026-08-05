import { channelName, emit } from '@dudousxd/nestjs-diagnostics';

/**
 * What this package publishes on `aviary:catalog:*`.
 *
 * Diagnostics rather than a logger, and certainly rather than a direct
 * Telescope dependency: the channel is the neutral seam the ecosystem is built
 * on, so a host that wants these in Telescope installs
 * `@dudousxd/nestjs-catalog-telescope`, one that wants them in its own tracing
 * subscribes directly, and one that wants neither pays nothing — `emit` builds
 * no envelope unless the channel has subscribers.
 *
 * These events are also the lineage feed. Since the catalog deliberately has no
 * dataset history to walk (see the Iceberg decision), the record of who loaded
 * what and when only exists because it was emitted as it happened.
 */
export const CATALOG_LIB = 'catalog';

/** Every event name this package emits. Exported so a watcher can claim them. */
export const CATALOG_EVENTS = [
  'schema.changed',
  'snapshot.written',
  'snapshot.committed',
  'snapshot.dropped',
  'type.curated',
  'overlay.reset',
  'connector.run.started',
  'connector.run.finished',
  'transform.changed',
  'workflow.changed',
  'query.shared',
  'dashboard.shared',
] as const;

export type CatalogEvent = (typeof CATALOG_EVENTS)[number];

/**
 * Where each event sits in the life of one load.
 *
 * This exists because a timestamp is not enough to order a trace. A fast load
 * emits its whole story inside a single tick of whatever clock the recorder
 * writes — the bundled MySQL store keeps milliseconds, and a commit of a few
 * hundred rows lands well inside one — so sorting by time alone leaves the
 * events in insertion order, and insertion order is arbitrary.
 * The observed result is a trace that reads `finished → written → committed →
 * started`: causally impossible, rendered with total confidence. Sorting by
 * time *and then* by this rank puts a same-tick story back in the only order it
 * could have happened in, and leaves genuinely separated events alone.
 *
 * It is a rank, not a schedule. Nothing here says an event must occur, or must
 * occur once — a load writes many batches, and a retried run emits a second
 * `connector.run.started` — it only says which came first when the clock cannot.
 */
export const CATALOG_EVENT_PHASE: Record<CatalogEvent, number> = {
  'connector.run.started': 0,
  'transform.changed': 1,
  // The same rank as the transform edit above, which is allowed and meant:
  // these ranks order a same-tick trace, and editing a graph and editing the
  // code inside it are the same kind of thing at the same point in the story —
  // an authoring event that precedes whatever run is being investigated. Giving
  // one an earlier rank than the other would assert a causal order between two
  // edits that have none.
  'workflow.changed': 1,
  // Curation carries no snapshot id, so it never lands inside a trace and this
  // rank is never consulted. It is written out rather than left to the fallback
  // because the type demands every event have one, and a `Record` that has to
  // be complete is exactly the mechanism that will fail the build the day a new
  // event is added and nobody thinks about where it belongs.
  'type.curated': 2,
  // The other curation event, ranked with the one it undoes. It carries no
  // snapshot id either — a reset is not part of any load — so like the rank
  // above this is never consulted, and it is written out because the `Record`
  // has to be complete.
  'overlay.reset': 2,
  // Sharing carries no snapshot id either, for the same reason curation does
  // not: it is a standalone act on a saved query or a board, not a step of any
  // load. So these ranks are never consulted, and they are written out for the
  // reason the note above gives — the `Record` has to be complete, and that is
  // what makes the build fail the day an event is added and nobody thinks about
  // where it belongs. Ranked beside curation because they are the same kind of
  // thing: a person deciding something about the catalog rather than data moving
  // through it.
  'query.shared': 2,
  'dashboard.shared': 2,
  'schema.changed': 3,
  'snapshot.written': 4,
  'snapshot.committed': 5,
  'snapshot.dropped': 6,
  'connector.run.finished': 7,
};

/**
 * Where an event nobody here declared is placed: in the middle, with the work.
 *
 * Not at either end deliberately. An unknown event sorted last would be read as
 * the thing that ended the trace, and one sorted first as the thing that caused
 * it — both are claims this library has no basis to make about a name it does
 * not recognise.
 */
export const CATALOG_EVENT_PHASE_FALLBACK = 4;

export function catalogEventPhase(event: string): number {
  const phase = Reflect.get(CATALOG_EVENT_PHASE, event);
  return typeof phase === 'number' ? phase : CATALOG_EVENT_PHASE_FALLBACK;
}

/**
 * What a curation entry says when nothing told it who.
 *
 * A value rather than an empty string or a missing key, and that difference is
 * the whole reason it exists. The shipped recorder writes
 * `principalId: undefined` for anything falsy, which lands as NULL in the column
 * every governance query filters on — and a NULL there is indistinguishable from
 * the rows written before this library recorded actors at all. "Not captured"
 * and "nobody did this" are different statements, and only the first one is true.
 *
 * Deliberately not the same string as the controller's `console` fallback, which
 * is a narrower and more useful claim: `console` says a request came through
 * this library's own HTTP surface and no guard resolved a principal onto it —
 * the deployment has an unauthenticated mount. This one says the registry API
 * was called in-process and the caller named nobody: a host script, a scheduled
 * job, or a subclass compiled against the signature before it took an actor.
 * Collapsing them would throw away the only clue about where to go looking, in
 * exchange for one fewer constant.
 */
export const UNATTRIBUTED_PRINCIPAL_ID = 'unattributed';

/**
 * The actor a curation event will carry, given whatever the caller passed.
 *
 * Exported because both registries need it and they ship in different packages —
 * the in-app one here, the stored one in `store-mikro-orm` — so a copy each is a
 * rule that holds in two places right up until it holds in one.
 *
 * Total, and it re-checks a parameter the types already made required. That is
 * not belt-and-braces: `CatalogRegistry` binds TypeScript callers, and the
 * callers whose omission must never reach the trail are precisely the ones it
 * does not bind — a JavaScript host, and a subclass declaring the older
 * argument list, which stays a legal override because TypeScript lets an
 * implementation take fewer parameters than it promised.
 */
export function curationActor(principalId: string | undefined): string {
  const trimmed = typeof principalId === 'string' ? principalId.trim() : '';
  return trimmed.length > 0 ? trimmed : UNATTRIBUTED_PRINCIPAL_ID;
}

export interface CatalogEventPayloads {
  /** DDL was applied to an object type's physical table. Always additive. */
  'schema.changed': {
    typeName: string;
    table: string;
    addedColumns: string[];
    created: boolean;
  };
  /** A batch landed. Fires per batch, so a large load emits many. */
  'snapshot.written': {
    typeName: string;
    snapshotId: string;
    principalId: string;
    rows: number;
  };
  /** A load became the one readers get. */
  'snapshot.committed': {
    typeName: string;
    snapshotId: string;
    principalId: string;
    rowCount: number;
  };
  'snapshot.dropped': {
    typeName: string;
    snapshotId: string;
  };
  /**
   * Someone changed a label, description, unit or visibility.
   *
   * Presentation-only, and emitted anyway: "who renamed this column and when"
   * is a governance question, and the answer is otherwise nowhere.
   */
  'type.curated': {
    typeName: string;
    property?: string;
    changed: string[];
    /**
     * Who renamed it — the half of that sentence this payload used to leave out.
     *
     * It carried `typeName`, `property` and `changed`, which answers "what" and
     * (with the row's timestamp) "when", and never "who" — while `query.shared`
     * two screens away named its actor from the day it was added. An audit trail
     * that is inconsistent about attribution reads as broken in whichever half
     * you look at second, and curation is the side where it matters more:
     * a curated label is the one decision this library describes as surviving
     * the publisher's next deploy.
     *
     * **`principalId`, not `curatedBy`,** because the spelling is a contract with
     * a recorder this package cannot import. `CatalogAuditRecorder` lifts exactly
     * this key into the audit table's indexed column; a payload that names it
     * anything else still carries the actor, in a JSON blob no query anybody runs
     * will look inside, and the entry lands attributed to nobody while looking
     * complete.
     *
     * **The whole `CatalogPrincipal.id`, composite half included.** The same
     * choice `query.shared` made, for the reason `catalog.principal.ts` argues at
     * length: `parsePrincipalId` recovers the application from an
     * `<app>#<person>` id, so carrying the person costs the machine-level
     * question nothing — while dropping to `applicationId` would file a curator's
     * decision under the console they happened to sign into, and "the console
     * renamed this column" is the answer that file says nobody accepts.
     *
     * **Required, and never the empty string.** The recorder treats a falsy value
     * as absent and writes NULL, which reads as "nobody did this" rather than
     * "this was not captured". A producer holding no principal emits
     * {@link UNATTRIBUTED_PRINCIPAL_ID} instead, which is a statement.
     */
    principalId: string;
  };
  /**
   * The whole overlay was discarded — every curated label, description, unit,
   * order, hidden flag and classification in the catalog, in one request.
   *
   * An event of its own rather than a `type.curated` with the name left off.
   * That payload leads with `typeName`, and a recorder lifts it into an indexed
   * column; a reset has no single type, so it would land as a curation edit
   * belonging to no type, indistinguishable from a malformed one. It is also a
   * different act: `type.curated` records a decision about one column, this
   * records the destruction of every such decision. Without it the trail could
   * say who renamed one column and not who reverted every name at once — and
   * both are `catalog:curate`, so the same curator can do either.
   *
   * **The classifications are why this is not merely tidy.** A classification is
   * what `visibleToPrincipal` filters search results on, so a reset silently
   * re-admits every classified property's *name* to searches by principals who
   * could not see it an instant earlier. That is a change in who can see what,
   * made by a route the controller documents as presentation-only.
   *
   * WHAT IT CARRIES, AND WHAT IT DELIBERATELY DOES NOT
   * --------------------------------------------------
   * The overlay is discarded rather than versioned, so nothing can be looked up
   * afterwards: what is not in this payload is nowhere. That argues for carrying
   * all of it, and all of it is the wrong answer — an audit row holding a
   * verbatim copy of the overlay is a backup, and a backup nobody designed: no
   * restore path, no retention policy of its own, and a JSON column that grows
   * with the catalog. It would be read as one, too. The first person who needed
   * it would find it, and the second would rely on it.
   *
   * So: a summary, drawn where the reader's question stops being "what did I
   * lose" and starts being "give it back".
   *
   * - {@link typeNames}, because "somebody reset the catalog" is nearly useless
   *   six months later and "was the work on `Dispute` in it" is what is actually
   *   asked. Bounded by how many types anyone had curated.
   * - {@link properties}, the scale of it as one number. The property *names* are
   *   where a summary would turn into the dump.
   * - {@link classifications} in full, values included, despite that line. They
   *   are the one part of the overlay whose loss changes what the catalog shows
   *   to whom, they are a small subset of it, and re-typing them is the only
   *   recovery anybody can perform.
   *
   * **It carries `principalId`, which it did not at first**, and the reason the
   * gap existed is worth keeping: `resetOverlay()` took no principal, the route
   * resolved none for it, and `RoutingCatalogRegistry` forwards the call by hand,
   * so a field here would have been empty on every row — and an audit table
   * lifts `principalId` into a column where empty reads as "nobody did this"
   * rather than "this was not captured". The answer was to thread the actor
   * through all three rather than to keep documenting its absence, because this
   * is the one act on the catalog that destroys decisions in bulk and needs only
   * `catalog:curate` to do it. See `type.curated` above for what the field holds
   * and why it is spelled that way.
   *
   * Emitted even when the overlay was empty, with zeroes. A trail that recorded
   * only destructive resets cannot tell "nobody pressed it" from "somebody
   * pressed it and nothing was there", and the second is worth seeing.
   */
  'overlay.reset': {
    /** Who reverted the catalog. See `type.curated`'s `principalId`. */
    principalId: string;
    /** Every type that carried curation, so the trail names what was lost. */
    typeNames: string[];
    /** How many per-property entries went with them, across every type. */
    properties: number;
    /**
     * Every classification that stopped applying, with its value — because that
     * is what somebody restoring one needs, and after the reset there is nowhere
     * left to read it.
     */
    classifications: Array<{
      typeName: string;
      property: string;
      classification: string;
    }>;
  };
  /** A connector began pulling. */
  'connector.run.started': {
    connectorId: string;
    connectorName: string;
    typeName: string;
    snapshotId: string;
    principalId: string;
  };
  /**
   * It finished, either way.
   *
   * One event for both outcomes rather than two: a watcher that cares about
   * failures has to subscribe to successes anyway to notice the ones that never
   * finished.
   */
  'connector.run.finished': {
    connectorId: string;
    connectorName: string;
    typeName: string;
    snapshotId: string;
    principalId: string;
    status: 'succeeded' | 'failed';
    fetched: number;
    written: number;
    error?: string;
    transformVersion?: number;
  };
  /**
   * Someone changed code that shapes stored data.
   *
   * The one event on this channel that is not about data movement, and the most
   * important for governance: a load that produced surprising numbers is
   * investigated afterwards, and "who changed the transform, and when" is the
   * first question.
   */
  'transform.changed': {
    transformId: string;
    name: string;
    language: string;
    version: number;
    changedBy: string;
  };
  /**
   * Someone changed the wiring rather than the code.
   *
   * Emitted for the same governance reason as `transform.changed`, and it is
   * genuinely a second question: a load can change behaviour because a
   * transform was edited *or* because a node was rewired between two transforms
   * that both stayed exactly as they were. The graph hash rides along because a
   * version number only identifies a graph within one catalog database, and
   * these events are read across environments.
   */
  'workflow.changed': {
    workflowId: string;
    name: string;
    version: number;
    graphHash: string;
    /** The type its sink writes, so a lineage view can place the edit. */
    targetType: string;
    nodeCount: number;
    changedBy: string;
  };
  /**
   * A saved query started or stopped being fetchable through the embed API.
   *
   * The single act that hands an outside application data from this catalog, and
   * for a long time the only one that left no trace: `SavedQuery.shared` is the
   * whole embed boundary, it is set by a person, and nothing recorded that they
   * had set it.
   *
   * One event for both directions rather than a `query.unshared` beside it,
   * following `connector.run.finished`: anybody watching for shares has to watch
   * for revocations too — a trail that records only the grants cannot answer
   * "was this still shared last Tuesday", which is the question an incident
   * actually asks. The direction is in {@link shared}.
   *
   * Emitted on the transition only. A save that leaves the flag where it was is
   * not a sharing decision, and a trail that logged every keystroke on a query
   * would be a trail nobody reads.
   *
   * **Deleting a shared query is one of those transitions**, and it emits here
   * rather than under a name of its own. The question this event answers is
   * "when did this stop being reachable from outside", and anybody asking it
   * filters on `query.shared` and reads the last entry. A separate
   * `query.deleted` would leave that filter reporting `shared: true` forever
   * for something nobody can fetch — the revocation would be in a channel the
   * asker did not subscribe to, which is the same absence this event exists to
   * remove. {@link deleted} says which kind of ending it was.
   */
  'query.shared': {
    savedQueryId: string;
    /** As it read at the moment of the change, so the trail is legible alone. */
    name: string;
    /** True when access was granted, false when it was taken back. */
    shared: boolean;
    /**
     * Who decided. The host-resolved principal where there is one, and named
     * `principalId` because that is the field a recorder lifts into the audit
     * table's indexed column — spell it anything else and the entry lands
     * attributed to nobody.
     */
    principalId: string;
    /**
     * Set only when the revocation was a deletion. Absent means the thing still
     * exists and was merely un-shared.
     *
     * Typed as `true` rather than `boolean` so the flag cannot be written the
     * other way round: "not a deletion" is the absence of this key, matching
     * how the rest of these payloads treat a fact that did not happen.
     *
     * Worth carrying rather than leaving to be looked up, because after a
     * deletion there is nothing left to look up. An entry that said only
     * `shared: false` would send its reader to a row that is gone, and the
     * empty result reads as a broken trail rather than as the answer.
     */
    deleted?: true;
  };
  /** The same decision, about a whole board. See {@link CatalogEventPayloads['query.shared']}. */
  'dashboard.shared': {
    dashboardId: string;
    name: string;
    shared: boolean;
    principalId: string;
    deleted?: true;
  };
}

/**
 * Teach the diagnostics channel what this library puts on it.
 *
 * Without this, `CatalogEventPayloads` only helps callers who go through
 * `emitCatalog`. Anyone subscribing the way the ecosystem actually subscribes —
 * generic `emit`/`trace`/watcher code that names the lib as a string — gets
 * `unknown` and narrows by hand, which is where a payload field gets misspelled
 * and nothing says so until the panel is blank in production.
 *
 * Pointed at the interface rather than restating its members. The sibling
 * libraries hand-list every event here, which is a second copy of a map that
 * already exists, and a second copy is the thing that stops matching. There is
 * nothing to keep in step: this *is* the map.
 */
declare module '@dudousxd/nestjs-diagnostics' {
  interface ChannelRegistry {
    catalog: CatalogEventPayloads;
  }
}

/**
 * The channel an event is published on.
 *
 * Exported so a recorder or a watcher can subscribe without rebuilding the
 * `aviary:<lib>:<event>` convention by hand — the one place that string is
 * assembled is the one place it can drift.
 */
export function channelNameFor(event: CatalogEvent | string): string {
  return channelName(CATALOG_LIB, event);
}

/**
 * Typed wrapper over `emit`.
 *
 * Never throws — observability that can break a load is worse than no
 * observability — which `emit` already guarantees; this exists for the types.
 */
export function emitCatalog<E extends CatalogEvent>(
  event: E,
  payload: CatalogEventPayloads[E],
): void {
  // The type arguments are named rather than inferred. `emit` types its payload
  // as `PayloadOf<TLib, TEvent>`, a conditional that stays unresolved while
  // `TEvent` is still an open generic — so inference leaves the compiler unable
  // to see that the registry entry and `CatalogEventPayloads` are now the same
  // type. Passing the whole event union makes the conditional distribute into a
  // union of every payload, which the one being emitted is a member of.
  emit<'catalog', CatalogEvent>(CATALOG_LIB, event, payload);
}
