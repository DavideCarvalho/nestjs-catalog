import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { CATALOG_EVENTS, channelNameFor } from '@dudousxd/nestjs-catalog';
import { afterEach, describe, expect, it } from 'vitest';
import { StoredCatalogRegistry } from './stored-registry.service';

/**
 * That the stored registry still refuses a reset, and that refusing stays
 * silent.
 *
 * The library registry now emits `overlay.reset` when it discards curation,
 * because that event is the only record of what the curated values were. This
 * one has no overlay: the published values *are* the stored values, so it throws
 * rather than destroying them. Both halves are asserted here because both are
 * ways the pair can go wrong, and they go wrong in opposite directions —
 * implementing the reset to match its sibling would delete a curator's work with
 * no way back, and emitting the event beside the throw would write a row saying
 * a reset happened while the caller was told it had not.
 *
 * Not a test of a fix. Nothing here was broken; this pins the decision so the
 * next person to make the two registries "consistent" has to argue with an
 * assertion rather than with a comment.
 */

/** Only the two methods under test are reached, so nothing else is wired. */
function bareRegistry(): StoredCatalogRegistry {
  const registry = Object.create(StoredCatalogRegistry.prototype);
  return Object.assign(registry, {
    em: undefined,
    orm: undefined,
    options: {},
  });
}

class ChannelTap {
  readonly events: string[] = [];
  private readonly handlers = new Map<string, (message: unknown) => void>();

  constructor() {
    for (const event of CATALOG_EVENTS) {
      const channel = channelNameFor(event);
      const handler = (): void => {
        this.events.push(event);
      };
      subscribe(channel, handler);
      this.handlers.set(channel, handler);
    }
  }

  stop(): void {
    for (const [channel, handler] of this.handlers) unsubscribe(channel, handler);
    this.handlers.clear();
  }
}

describe('the stored registry has no overlay to reset', () => {
  let tap: ChannelTap | undefined;

  afterEach(() => {
    tap?.stop();
    tap = undefined;
  });

  it('refuses, and says where the values actually come from', async () => {
    tap = new ChannelTap();
    await expect(bareRegistry().resetOverlay()).rejects.toThrow(/re-publish/i);
  });

  it('leaves nothing on the diagnostics channel, because nothing happened', async () => {
    tap = new ChannelTap();
    await expect(bareRegistry().resetOverlay()).rejects.toThrow();
    expect(tap.events).toEqual([]);
  });
});
