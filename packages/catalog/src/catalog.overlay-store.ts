import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CatalogOverlay } from './catalog.types';

/**
 * Where tier-0 edits live.
 *
 * Deliberately not the application database. The overlay is control-plane
 * state, and mixing it into the operational schema is the first step toward a
 * service that owns a database connection it should not have.
 */
export interface CatalogOverlayStore {
  load(): Promise<CatalogOverlay>;
  save(overlay: CatalogOverlay): Promise<void>;
}

/** The default: a JSON file. Good enough until there is a control plane. */
export class FileCatalogOverlayStore implements CatalogOverlayStore {
  constructor(private readonly path: string) {}

  async load(): Promise<CatalogOverlay> {
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed === 'object' &&
        'types' in parsed &&
        typeof (parsed as { types: unknown }).types === 'object'
      ) {
        return parsed as CatalogOverlay;
      }
      return { types: {} };
    } catch {
      return { types: {} };
    }
  }

  async save(overlay: CatalogOverlay): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(overlay, null, 2)}\n`, 'utf8');
  }
}

/**
 * For tests, and for a single-process deployment content to lose every curated
 * value when it restarts.
 *
 * **Not a read-only mode**, which is what this used to offer itself as. Nothing
 * here refuses anything: `save` takes the overlay and keeps it, `PATCH
 * /catalog/types/:name` answers 200 and emits `type.curated`, and the rename is
 * real right up until the process ends. What it is not is *shared* — the overlay
 * lives in one process's heap, so two replicas behind the same load balancer
 * disagree about what a column is called, and which name a curator sees back
 * depends on which pod took their request. A deployment that chose this store
 * because the docblock promised read-only got precisely the writes it was trying
 * to prevent, and got them inconsistently.
 *
 * There is no mode here to turn on instead, because read-only is not a store's
 * decision. The writes arrive on routes that declare `catalog:curate`, and
 * whether a deployment grants that scope is its guard's business — see the
 * declare-and-enforce split in `catalog.route-auth.ts`. A store that threw would
 * turn a policy answer ("you may not curate here") into a 500 from a route the
 * library documents as working, and would put a second mechanism beside the one
 * that already decides.
 */
export class InMemoryCatalogOverlayStore implements CatalogOverlayStore {
  private overlay: CatalogOverlay = { types: {} };

  async load(): Promise<CatalogOverlay> {
    return this.overlay;
  }

  async save(overlay: CatalogOverlay): Promise<void> {
    this.overlay = overlay;
  }
}
