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

/** For tests, and for deployments that want the catalog strictly read-only. */
export class InMemoryCatalogOverlayStore implements CatalogOverlayStore {
  private overlay: CatalogOverlay = { types: {} };

  async load(): Promise<CatalogOverlay> {
    return this.overlay;
  }

  async save(overlay: CatalogOverlay): Promise<void> {
    this.overlay = overlay;
  }
}
