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
  'connector.run.started',
  'connector.run.finished',
  'transform.changed',
  'workflow.changed',
] as const;

export type CatalogEvent = (typeof CATALOG_EVENTS)[number];

/**
 * Where each event sits in the life of one load.
 *
 * This exists because a timestamp is not enough to order a trace. A fast load
 * emits its whole story inside a single tick of whatever clock the recorder
 * writes — the bundled MySQL store keeps whole seconds — so sorting by time
 * alone leaves the events in insertion order, and insertion order is arbitrary.
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
