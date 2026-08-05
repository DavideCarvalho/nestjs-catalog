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
      // Narrowed by a guard rather than asserted. The file on disk is edited by
      // hand — that is the whole point of a JSON overlay — so its contents are
      // exactly as trustworthy as whoever last opened it, and an assertion here
      // would hand the registry a shape it promised to have rather than one it
      // was checked for. The failure that buys is quiet: `types` arriving as
      // `null` (an object, by `typeof`) or as an array reads as an overlay with
      // no curation, and every label somebody wrote silently stops applying.
      if (isOverlay(parsed)) return parsed;
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
 *
 * **Both ends copy, and one end would not have been enough.** The registry holds
 * the overlay it loaded and edits it in place — `this.overlay.types[name] = {
 * ...current, ...patch }` — before calling `save`. Copy only on `load` and the
 * object handed to `save` becomes the store's own, so the next patch is writing
 * into the store again; copy only on `save` and the object handed out by `load`
 * already is the store's own. Either way this store's state moves before
 * anybody asked it to, and "nothing is stored until save" — the one sentence a
 * store is for — is not true of it.
 *
 * That mattered in two directions, neither of them the net behaviour, which was
 * and is identical because every edit is followed by a persist.
 *
 * - **The two bundled stores disagreed.** {@link FileCatalogOverlayStore}
 *   round-trips through JSON and so has never aliased anything. Every spec in
 *   this repository runs on this one, so a test asserting that an edit had not
 *   been written yet passed here and would have failed on the store a
 *   deployment actually uses. A vacuous pass is worse than no test: it is a
 *   claim with evidence attached to it.
 * - **Two registries over one store shared mutable state.** One would see the
 *   other's half-applied edit with no write between them, which is the shape
 *   that produces a report nobody can reproduce.
 *
 * **What it costs.** One deep copy per load and per save. The overlay is the
 * names, descriptions and per-property patches a human has typed — not the
 * catalog, which is derived from entity metadata and does not live here — so a
 * heavily curated thousand-type catalog is a few hundred kilobytes and a copy
 * in the low milliseconds. The two paths that pay it are a boot and a curator
 * pressing save. Neither is a read, and nothing on a request path calls either.
 */
export class InMemoryCatalogOverlayStore implements CatalogOverlayStore {
  private overlay: CatalogOverlay = { types: {} };

  async load(): Promise<CatalogOverlay> {
    return copyOverlay(this.overlay);
  }

  async save(overlay: CatalogOverlay): Promise<void> {
    this.overlay = copyOverlay(overlay);
  }
}

/**
 * A deep copy, so a caller and the store never hold one object between them.
 *
 * `structuredClone` rather than a `JSON.parse(JSON.stringify(...))` round-trip,
 * which differs on a key whose value is `undefined`: JSON drops it, so
 * `{ displayName: undefined }` comes back as `{}` and `'displayName' in entry`
 * flips from true to false. Nothing reads the overlay that way today. A copy
 * that quietly edits what it copies is still not a copy, and the day something
 * does read it that way the difference is a curated field that vanished with no
 * write behind it.
 */
function copyOverlay(overlay: CatalogOverlay): CatalogOverlay {
  return structuredClone(overlay);
}

/**
 * Whether a parsed file is an overlay, checked to the depth that matters.
 *
 * The nesting below `types` is deliberately NOT walked. Every consumer reads it
 * defensively — an entry that is missing, or missing the key it wanted, is the
 * ordinary case for a type nobody has curated — so validating each entry would
 * be re-implementing a tolerance the readers already have, and refusing the
 * whole file over one malformed entry would discard every good one beside it.
 */
function isOverlay(value: unknown): value is CatalogOverlay {
  if (!value || typeof value !== 'object') return false;
  const types = Reflect.get(value, 'types');
  // Not `typeof types === 'object'`, which admits `null` and arrays. Both parse
  // from a hand-edited file, and both read downstream as "nothing is curated".
  return Boolean(types) && typeof types === 'object' && !Array.isArray(types);
}
