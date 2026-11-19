import type { CatalogOverlay, CatalogOverlayStore } from '@dudousxd/nestjs-catalog';
import { eq } from 'drizzle-orm';
import { type CatalogDrizzleRun, catalogDrizzleRunner } from './connection';
import { type CatalogDrizzleTables, DEFAULT_OVERLAY_KEY, catalogDrizzleTables } from './schema';
import type { CatalogDrizzleStoreOptions } from './workspace.store';

export type CatalogDrizzleOverlayOptions = CatalogDrizzleStoreOptions & {
  /** Which overlay row this catalog keeps. Defaults to `default`. */
  readonly key?: string;
};

/**
 * The curation overlay (display names, descriptions, hidden properties) in one
 * JSONB row, for a host whose replicas must agree on it. Pass an instance to
 * `CatalogModule.forRoot({ overlayStore })`.
 *
 * Both ends hand out copies: what `load` returns and what `save` was given are
 * never this store's own objects, the property the in-memory store had to add
 * so a registry editing its overlay in place does not write before it saves.
 * A JSON round trip through the database gives that here.
 */
export class DrizzleCatalogOverlayStore implements CatalogOverlayStore {
  private readonly run: CatalogDrizzleRun;
  private readonly t: CatalogDrizzleTables;
  private readonly key: string;

  constructor(options: CatalogDrizzleOverlayOptions) {
    this.run = catalogDrizzleRunner(options);
    this.t = catalogDrizzleTables(options);
    this.key = options.key ?? DEFAULT_OVERLAY_KEY;
  }

  load(): Promise<CatalogOverlay> {
    const o = this.t.overlay;
    return this.run(async (db) => {
      const [row] = await db.select().from(o).where(eq(o.id, this.key)).limit(1);
      const document = row?.document;
      if (document && isOverlay(document)) return document;
      return { types: {} };
    });
  }

  save(overlay: CatalogOverlay): Promise<void> {
    const o = this.t.overlay;
    // A deep copy before it leaves, so the caller keeps editing its own object.
    const document = structuredClone(overlay) as unknown as Record<string, unknown>;
    return this.run(async (db) => {
      const now = new Date();
      await db
        .insert(o)
        .values({ id: this.key, document, updatedAt: now })
        .onConflictDoUpdate({ target: o.id, set: { document, updatedAt: now } });
    });
  }
}

/** Checked to the depth the readers rely on, as `FileCatalogOverlayStore` does. */
function isOverlay(value: unknown): value is CatalogOverlay {
  if (!value || typeof value !== 'object') return false;
  const types = Reflect.get(value, 'types');
  return Boolean(types) && typeof types === 'object' && !Array.isArray(types);
}
