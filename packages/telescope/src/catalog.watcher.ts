import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import {
  CATALOG_EVENTS,
  CATALOG_LIB,
  type CatalogEvent,
  channelNameFor,
} from '@dudousxd/nestjs-catalog';
import { claimDiagnostics } from '@dudousxd/nestjs-diagnostics';
import type { RecordInput, Watcher, WatcherContext } from '@dudousxd/nestjs-telescope';
import { CATALOG_ENTRY_TYPE, capError, isRecord } from './catalog.shared.js';

/**
 * The per-batch event, named once so the two places that reason about it — the
 * default exclusion and the doc that explains it — cannot drift apart.
 */
const BATCH_EVENT: CatalogEvent = 'snapshot.written';

/** Construction options for {@link CatalogWatcher}. */
export interface CatalogWatcherOptions {
  /**
   * Record `snapshot.written`, the per-batch event. Default `false`.
   *
   * Off by default because its volume is a function of how much data the
   * catalog moves, not of how much is happening: one event per batch means a
   * ten-million-row load emits ten thousand entries, all of them saying the
   * same thing, and a Telescope timeline shared with requests, queries and logs
   * is drowned by a single overnight backfill. `nestjs-media` makes the same
   * call for `upload.progress`, for the same reason.
   *
   * It costs nothing to leave off because it answers nothing the other events
   * do not. The size of a load is on `snapshot.committed` as `rowCount`, and
   * every individual batch is durably in the catalog's own audit trail, which
   * is what the trace panels on this dashboard read.
   *
   * Turn it on to watch a load arrive in real time — the one question the
   * milestone events genuinely cannot answer is "is it still moving, or is it
   * wedged". That is a debugging session, not a steady state.
   */
  recordBatches?: boolean;
}

/**
 * Which events this watcher records, given its options.
 *
 * Exported so a host can pass exactly the same list to
 * `nestjsDiagnosticsTelescope({ exclude })` if it wants the generic bridge to
 * stay quiet for a reason of its own, without hand-copying the names.
 */
export function catalogRecordedEvents(options?: CatalogWatcherOptions): readonly CatalogEvent[] {
  if (options?.recordBatches) return CATALOG_EVENTS;
  return CATALOG_EVENTS.filter((event) => event !== BATCH_EVENT);
}

/**
 * A published `aviary:catalog:*` envelope, narrowed to the fields this watcher
 * reads.
 *
 * Structural rather than an import of `DiagnosticEvent`, and validated rather
 * than assumed, because the message arrives from another package over a
 * `node:diagnostics_channel` — an untyped boundary that any code in the process
 * can publish onto. A malformed message must produce no entry, not a throw
 * inside a producer's call stack.
 */
function isCatalogEnvelope(
  message: unknown,
): message is { lib: string; event: string; ts: number; traceId?: string; payload: unknown } {
  if (!isRecord(message)) return false;
  return (
    typeof Reflect.get(message, 'lib') === 'string' &&
    typeof Reflect.get(message, 'event') === 'string' &&
    typeof Reflect.get(message, 'ts') === 'number' &&
    'payload' in message
  );
}

/**
 * Build the entry for one published event.
 *
 * Exported for tests and for a host composing its own extension out of the
 * parts; the interesting decisions are all here.
 */
export function buildCatalogEntry(
  event: string,
  payload: unknown,
): RecordInput<Record<string, unknown>> {
  const source = isRecord(payload) ? payload : {};

  // The payload is copied verbatim, with exactly one field rewritten. Nothing
  // on this channel carries row contents or credentials — the catalog is
  // deliberately built so its telemetry gives away the shape of an integration
  // (type names, column names, connector names, counts) and never its data —
  // so a field-by-field allowlist here would be a second, hand-maintained copy
  // of that decision, and the copy is what goes stale when an event grows a
  // field. `error` is the exception because its contents come from outside the
  // catalog entirely. See `capError`.
  const copied: Record<string, unknown> = { event, ...source };
  const error = capError(stringOrUndefined(Reflect.get(copied, 'error')));

  // An `error` that does not survive `capError` is *removed*, not set to
  // `undefined`. This object is handed to a host and to Telescope's storage
  // verbatim, so `'error' in content` and `Object.keys(content)` are part of
  // what it means — a key present with an `undefined` value would report a
  // rejected error as an error that happened and was empty. Rest-destructuring
  // drops the key without the `delete` that deoptimises the object's shape.
  let content: Record<string, unknown>;
  if (error === undefined) {
    const { error: _rejected, ...rest } = copied;
    content = rest;
  } else {
    copied.error = error;
    content = copied;
  }

  const status = stringOrUndefined(Reflect.get(source, 'status'));
  const failed = status === 'failed';

  const tags: string[] = [`event:${event}`];

  // `failed` is Telescope core's own cross-type convention (the same tag its
  // exception and client-exception entries carry), so tagging it here makes a
  // failed load filterable and alertable next to every other failure in the
  // system rather than only findable by knowing to look at this tab. This is
  // the difference between a failure being visible and a failure being
  // discoverable — the project treats a failure that looks like a success as
  // its worst class of bug, and an entry nobody can find is a close relative.
  if (failed) tags.push('failed');
  else if (status !== undefined) tags.push(status);
  if (event === 'connector.run.started') tags.push('running');

  // Bounded-cardinality tags only. A type name and a connector name are drawn
  // from a small configured set; a snapshot id is unique per load, and tags are
  // an indexed column, so tagging it would grow the index at the rate the
  // catalog runs loads. The snapshot id is not lost — it goes on `traceId`,
  // which is the field built to carry a correlation key.
  const typeName = stringOrUndefined(Reflect.get(source, 'typeName'));
  if (typeName !== undefined) tags.push(`type:${typeName}`);
  const connectorName = stringOrUndefined(Reflect.get(source, 'connectorName'));
  if (connectorName !== undefined) tags.push(`connector:${connectorName}`);

  const snapshotId = stringOrUndefined(Reflect.get(source, 'snapshotId'));

  return {
    type: CATALOG_ENTRY_TYPE,
    content,
    // `familyHash` is what Telescope rolls entries up by, so grouping on the
    // event name makes "how many commits tonight" and "how many failed runs"
    // answerable without a scan. Deliberately NOT including the type name: a
    // catalog with two hundred object types would produce two hundred families
    // per event and roll nothing up at all.
    familyHash: `${CATALOG_LIB}:${event}`,
    tags,
    // This is the whole grouping story, and it costs one line because the
    // correlation already existed. Every event of one load — the run that
    // started it, each batch, the commit, the finish — carries the same
    // `snapshotId`, and when the durable engine schedules the run that id IS
    // the durable run id. Stamping it as the entry's `traceId` hands the load
    // to Telescope's own trace waterfall, which groups by exactly that field,
    // so `#/traces/<snapshotId>` renders the load's story with no new concept
    // invented on this side and no second definition of what a trace is.
    //
    // It deliberately overrides the ambient OTel trace id. A connector run
    // scheduled by the durable engine has no request behind it, so the ambient
    // id is null or belongs to the worker's own poll — grouping by it would
    // scatter one load across unrelated traces, or gather unrelated loads into
    // one. `RecordInput.traceId` is explicit-wins over ambient by design
    // (telescope core 1.17+), which is what makes this safe to set.
    //
    // Left absent for the events that carry no snapshot id — curation edits,
    // transform changes, schema changes. Those are standalone acts, and
    // attaching them to whatever trace happened to be ambient would fabricate a
    // causal link that then reads as evidence during an investigation.
    ...(snapshotId !== undefined ? { traceId: snapshotId } : {}),
  };
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Records every milestone `aviary:catalog:*` event as a Telescope entry of type
 * `catalog`.
 *
 * It depends on the diagnostics channel and on `@dudousxd/nestjs-catalog`'s
 * event *names*, never on the catalog runtime — nothing here imports a service,
 * a store or a module, and nothing in the catalog imports this. That inversion
 * is the point of the Aviary diagnostics seam: a deployment without Telescope
 * carries no Telescope code and loses nothing, and a deployment with it gets
 * this tab by installing one package.
 *
 * ## Coexisting with the generic diagnostics bridge
 * `@dudousxd/nestjs-diagnostics-telescope` subscribes to every registered
 * channel, including this one, so without coordination each catalog event would
 * be recorded twice: once as a typed `catalog` entry here, once as a generic
 * `diagnostic` entry there. `register()` claims each key it records via
 * `claimDiagnostics(CATALOG_LIB, …)`, which the generic watcher checks at
 * record time and skips. It claims only what it actually records — so with
 * `recordBatches: false` (the default) `snapshot.written` stays unclaimed and
 * the generic bridge still captures it for a host that wants the raw feed.
 * `dispose()` releases the claim.
 *
 * ## Ordering
 * Claiming is reference-counted and checked at record time, not subscribe time,
 * so it does not matter whether this watcher or the generic one registers
 * first.
 */
export class CatalogWatcher implements Watcher {
  readonly type = CATALOG_ENTRY_TYPE;

  private readonly disposers: Array<() => void> = [];
  private readonly events: readonly CatalogEvent[];

  constructor(options?: CatalogWatcherOptions) {
    this.events = catalogRecordedEvents(options);
  }

  register(ctx: WatcherContext): void {
    this.disposers.push(claimDiagnostics(CATALOG_LIB, this.events));

    for (const event of this.events) {
      // `channelNameFor` rather than rebuilding `aviary:<lib>:<event>` by hand.
      // The producer and this subscriber must agree on the string exactly or
      // the tab is silently, permanently empty — a failure with no error and no
      // symptom other than absence, which is the hardest kind to notice. One
      // exported function is the one place it can drift.
      const channel = channelNameFor(event);
      const onMessage = (message: unknown): void => {
        // Swallowing here is deliberate and non-negotiable: this listener runs
        // synchronously inside the producer's call stack, so a throw would
        // propagate into the middle of a load. Observability that can break the
        // thing it observes is worse than no observability. `ctx.record` is
        // itself fire-and-forget and documented never to throw; this guards the
        // narrowing and entry construction around it.
        try {
          if (!isCatalogEnvelope(message)) return;
          ctx.record(buildCatalogEntry(message.event, message.payload));
        } catch {
          // Intentionally empty — see above.
        }
      };
      subscribe(channel, onMessage);
      this.disposers.push(() => unsubscribe(channel, onMessage));
    }
  }

  /** Detach every channel subscription and release the diagnostics claim. */
  dispose(): void {
    while (this.disposers.length) this.disposers.pop()?.();
  }
}
