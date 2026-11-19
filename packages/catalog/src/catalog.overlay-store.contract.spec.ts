import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe } from 'vitest';
import { describeOverlayStoreContract } from '../../../test/workspace-store-contract';
import { FileCatalogOverlayStore, InMemoryCatalogOverlayStore } from './catalog.overlay-store';

/**
 * The bundled overlay stores through the same contract the database-backed
 * stores run, so "hands out copies at both ends" means one thing everywhere.
 */
const dir = mkdtempSync(join(tmpdir(), 'catalog-overlay-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('InMemoryCatalogOverlayStore', () => {
  describeOverlayStoreContract(() => new InMemoryCatalogOverlayStore());
});

describe('FileCatalogOverlayStore', () => {
  describeOverlayStoreContract(() => new FileCatalogOverlayStore(join(dir, 'overlay.json')));
});
