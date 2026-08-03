import {
  type DataProvider,
  type Entry,
  type ExtensionContext,
  TELESCOPE_STORAGE,
} from '@dudousxd/nestjs-telescope';
import {
  CATALOG_ENTRY_TYPE,
  LIVE_FAILURES_LIMIT,
  LIVE_SCAN_LIMIT,
  NO_VALUE,
  capError,
  isRecord,
  numberField,
  stringField,
} from './catalog.shared.js';

/**
 * The `get`-capable slice of Telescope's storage provider.
 *
 * Structurally narrowed rather than imported as `StorageProvider`, so this file
 * depends on the one method it calls instead of on the whole interface — an
 * interface that grows optional members every release.
 */
interface EntryReader {
  get(query: {
    type?: string;
    tag?: string;
    limit?: number;
  }): Promise<{ data: Entry[] }>;
}

function isEntryReader(value: unknown): value is EntryReader {
  return (
    typeof value === 'object' && value !== null && typeof Reflect.get(value, 'get') === 'function'
  );
}

/**
 * Resolve Telescope's own entry storage, or `undefined`.
 *
 * Same request-time resolve, same `ModuleRef.get`-throws caveat as
 * `resolveTraceStore`. `TELESCOPE_STORAGE` is always bound when Telescope is
 * running, so `undefined` here means something is structurally wrong and the
 * right answer is an empty panel, not an exception surfacing inside a dashboard
 * that exists to report on other people's exceptions.
 */
function resolveStorage(ctx: ExtensionContext): EntryReader | undefined {
  try {
    const resolved: unknown = ctx.moduleRef.get(TELESCOPE_STORAGE, {
      strict: false,
    });
    return isEntryReader(resolved) ? resolved : undefined;
  } catch {
    return undefined;
  }
}

/** The `content` of a recorded catalog entry, narrowed. */
function contentOf(entry: Entry): Record<string, unknown> {
  return isRecord(entry.content) ? entry.content : {};
}

/**
 * breakdown → which catalog events are actually arriving on the channel.
 *
 * The one panel on this page that is fed by the watcher rather than by the
 * durable trace store, and it earns its place by answering a question the
 * durable panels structurally cannot: is the wiring alive at all. An empty
 * loads table means either "a quiet night" or "the emitter and this subscriber
 * disagree about a channel name and nothing has been recorded since the
 * upgrade". Those are opposite situations that look identical, and this panel
 * is what separates them.
 *
 * Scanned rather than aggregated because Telescope's `tags(prefix)` is not
 * scoped by entry type, so counting `event:*` tags would silently fold in any
 * other watcher that ever adopts the same prefix. Scoping the scan to this
 * package's own entry type is exact, and {@link LIVE_SCAN_LIMIT} bounds it.
 */
export function catalogLiveEventMixProvider(): DataProvider {
  return {
    name: 'catalog.live.events',
    async resolve(_query, ctx) {
      const storage = resolveStorage(ctx);
      if (!storage) return { segments: [] };
      const page = await storage.get({
        type: CATALOG_ENTRY_TYPE,
        limit: LIVE_SCAN_LIMIT,
      });
      const counts = new Map<string, number>();
      for (const entry of page.data) {
        const event = stringField(contentOf(entry), 'event');
        if (event === undefined) continue;
        counts.set(event, (counts.get(event) ?? 0) + 1);
      }
      return {
        segments: [...counts].map(([label, value]) => ({ label, value })),
      };
    },
  };
}

/** One row of the live failures table. */
export interface CatalogLiveFailureRow {
  /** The snapshot id, carried for the deep link. Empty when the event had none. */
  id: string;
  at: string;
  connectorName: string;
  typeName: string;
  fetched: number | string;
  written: number | string;
  error: string;
}

/**
 * table → failures seen on the channel, right now.
 *
 * Deliberately duplicating what the durable "needs attention" table shows, and
 * deliberately kept anyway. The durable panels go blank when a host runs the
 * catalog without a trace-capable store — a supported configuration — and a
 * failure must be unmistakable in EVERY supported configuration, not only the
 * fully-wired one. A dashboard whose failure reporting silently depends on an
 * optional binding is itself a failure that looks like a success.
 *
 * Queried by the `failed` tag rather than by scanning and filtering, so it
 * stays exact over the storage provider's whole retained window instead of over
 * however many failures happen to fall inside the newest N entries.
 *
 * `fetched` and `written` sit beside the error on purpose: "fetched 40,000,
 * wrote 0" and "fetched 40,000, wrote 39,998" are different incidents, and the
 * message alone rarely distinguishes them.
 */
export function catalogLiveFailuresProvider(): DataProvider {
  return {
    name: 'catalog.live.failures',
    async resolve(_query, ctx) {
      const storage = resolveStorage(ctx);
      if (!storage) return { rows: [] };
      const page = await storage.get({
        type: CATALOG_ENTRY_TYPE,
        tag: 'failed',
        limit: LIVE_FAILURES_LIMIT,
      });
      const rows: CatalogLiveFailureRow[] = page.data.map((entry) => {
        const content = contentOf(entry);
        return {
          // The watcher stamped the snapshot id as the entry's traceId; reading
          // it back from there rather than from the payload keeps one source of
          // truth for what correlates a load.
          id: entry.traceId ?? '',
          at: entry.createdAt.toISOString(),
          connectorName: stringField(content, 'connectorName') ?? NO_VALUE,
          typeName: stringField(content, 'typeName') ?? NO_VALUE,
          fetched: numberField(content, 'fetched') ?? NO_VALUE,
          written: numberField(content, 'written') ?? NO_VALUE,
          // Capped again here even though the watcher already capped it: this
          // value goes straight to a table cell, and provider output never
          // passes through Telescope's redaction pipeline. The entry could also
          // predate a change to the cap.
          error: capError(stringField(content, 'error')) ?? NO_VALUE,
        };
      });
      return { rows };
    },
  };
}

/** Every watcher-fed provider this package contributes. */
export function catalogLiveProviders(): DataProvider[] {
  return [catalogLiveEventMixProvider(), catalogLiveFailuresProvider()];
}
