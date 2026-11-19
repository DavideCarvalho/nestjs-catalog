import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { CATALOG_EVENTS, channelNameFor } from './catalog.events';
import { CATALOG_WORKSPACE_STORE, type CatalogWorkspaceStore } from './catalog.workspace';

type Handler = (message: unknown) => void;

/**
 * Writes the diagnostics stream into the audit table.
 *
 * The library emits on `aviary:catalog:*` and depends on nothing to do it,
 * which is right — but a channel only reaches observers that were listening at
 * the time. Governance asks "who changed this, and when" months later, so
 * something has to keep the answer. This is that something, and it is a
 * separate class so a deployment that wants the events in its own tracing and
 * nowhere else can simply not provide it.
 */
@Injectable()
export class CatalogAuditRecorder implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CatalogAuditRecorder.name);
  private readonly handlers = new Map<string, Handler>();

  constructor(
    // By token, never positionally — and here for a second reason on top of the
    // one its siblings give. Asking for `MySqlWorkspaceStore` by class pins this
    // recorder to one connection for the life of the process, and
    // `RoutingWorkspaceStore` *implements* the interface rather than extending
    // the class, so it could never be substituted however a host wired its
    // module. Every event in a multi-environment deployment would have landed in
    // whichever single database the recorder happened to be constructed
    // against, filed under no environment at all — a dev event sitting in the
    // production audit table, reading exactly like a production one.
    @Inject(CATALOG_WORKSPACE_STORE)
    private readonly workspace: CatalogWorkspaceStore,
  ) {}

  onModuleInit(): void {
    for (const event of CATALOG_EVENTS) {
      const channel = channelNameFor(event);
      const handler: Handler = (message) => {
        void this.record(event, message);
      };
      subscribe(channel, handler);
      this.handlers.set(channel, handler);
    }
    this.logger.log(`Recording ${CATALOG_EVENTS.length} catalog event types to the audit trail`);
  }

  onModuleDestroy(): void {
    for (const [channel, handler] of this.handlers) {
      unsubscribe(channel, handler);
    }
    this.handlers.clear();
  }

  private async record(event: string, message: unknown): Promise<void> {
    const envelope = (message ?? {}) as Record<string, unknown>;
    const payload = (envelope.payload ?? envelope) as Record<string, unknown>;

    await this.workspace.recordEvent({
      event,
      typeName: asString(payload.typeName),
      principalId: asString(payload.principalId),
      snapshotId: asString(payload.snapshotId),
      detail: payload,
      // The envelope's own timestamp when there is one: the write happens on a
      // background tick, and "when it was persisted" is a different fact from
      // "when it happened".
      occurredAt: new Date(
        typeof envelope.ts === 'number' ? envelope.ts : Date.now(),
      ).toISOString(),
    });
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
