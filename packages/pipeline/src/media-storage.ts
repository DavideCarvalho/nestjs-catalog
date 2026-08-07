import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { type StorageManagerLike, isStorageManager } from './sources';

/**
 * The `StorageManager` a host mounted, if it mounted one.
 *
 * **Resolved by a globally registered symbol, so this package does not depend on
 * `@dudousxd/nestjs-media` in any sense — not a dependency, not a peer, not a
 * type-only import.** `Symbol.for` reads the cross-realm registry, so the value
 * here is the same symbol `@dudousxd/nestjs-media` binds its manager under, and
 * recreating it costs one line instead of an install. Media minted this token
 * for exactly this purpose — its own telescope dashboard resolves the manager
 * the same way, to dodge the ESM/CJS dual-copy problem a real import would
 * bring.
 *
 * That is why this is DI rather than {@link importOptional}, and the difference
 * is not stylistic. `pg`, `mysql2` and `@aws-sdk/client-s3` are imported to get
 * a **constructor**, which this package then configures from a connector. A
 * `StorageManager` is not a constructor, it is **already-configured host
 * state** — which disks exist, which buckets they point at, which credentials
 * they hold. Importing the media package would hand back a class this package
 * has no way to configure and no business configuring; the configuration
 * belonging to the host is the entire feature. So it arrives the only way
 * configured state can: through the injector, exactly as the durable engine
 * does.
 */
export const MEDIA_STORAGE_SHARED: symbol = Symbol.for('nestjs-media:storage');

/**
 * What this deployment can honestly promise about naming a disk.
 *
 * The same shape as `WorkflowDurability`, for the same reason: a boolean nobody
 * can act on is not an answer. `detail` is a full sentence addressed to whoever
 * is about to author a connector, and it says what is **lost**, not merely what
 * is missing.
 */
export interface StorageAvailability {
  available: boolean;
  /** The disks a connector may name. Empty when nothing resolved. */
  disks: string[];
  /** Why, in a full sentence. */
  detail: string;
}

/** What to say when a manager resolved, listing what may actually be named. */
export function storageAvailableDetail(disks: readonly string[]): string {
  return disks.length === 0
    ? 'A media storage manager resolved here, but it has no disks configured, so there is nothing for a connector to name yet. Configure a disk on @dudousxd/nestjs-media and it becomes selectable here.'
    : `A media storage manager resolved here, so a connector can name a disk instead of carrying its own bucket and credentials: ${disks.join(', ')}.`;
}

/**
 * What to say when none resolved — and what that costs.
 *
 * Deliberately not "media is unavailable". A silent fallback is worse than a
 * missing feature, because the thing lost here is not a capability somebody
 * would notice missing: it is that the credentials have to be minted a second
 * time, under a name of the catalog's own, in an environment variable the
 * allow-list then has to admit. Somebody who is not told that just does it, and
 * the second copy is the one that outlives its rotation.
 */
export const NO_STORAGE_DETAIL =
  'No media storage manager resolved in this process, so a connector here cannot name a disk. S3 connectors still work — but each one has to carry its own bucket, endpoint and region, and its own environment variable holding "accessKeyId:secretAccessKey", which is a second copy of a credential this deployment would otherwise have configured once on a disk and rotated in one place.';

/**
 * Bound, but not a storage manager.
 *
 * The third state, and it exists for the same reason the run reconciler checks
 * what is actually behind the `WorkflowEngine` token: any package may bind a
 * global symbol, and "something is there" is not "it can open a disk". Reported
 * as unavailable rather than crashed, and warned about once at boot, because
 * this is a wiring mistake somebody has to be told about rather than a state a
 * connector author can do anything with.
 */
export function storageMisboundDetail(what: string): string {
  return `A ${what} is bound under the media storage token here, and it cannot open a disk — it has no disk()/diskNames(). Something other than a @dudousxd/nestjs-media StorageManager has claimed that token. Connectors that name a disk will be refused until it is unbound.`;
}

/**
 * The host's media storage, and whether there is any.
 *
 * A service rather than a bare token so the feature-detection and the wording
 * live in one place: the fetchers, the connection checker and the capabilities
 * route all need the same answer, and three copies of `typeof x.disk ===
 * 'function'` would drift the first time one of them was relaxed.
 */
@Injectable()
export class CatalogStorage {
  private readonly logger = new Logger(CatalogStorage.name);
  private warned = false;

  constructor(
    // Optional because the overwhelming majority of deployments mount no media
    // at all, and a catalog that reads a bucket through the SDK must boot
    // exactly as it always has. Typed `unknown` rather than `StorageManagerLike`
    // because the token is a global symbol anything may bind: declaring the
    // interface as the type would state a contract this token does not keep,
    // and the compiler would then agree that `disk()` exists on a deployment
    // where it does not.
    @Optional() @Inject(MEDIA_STORAGE_SHARED) private readonly bound?: unknown,
  ) {}

  /** The manager, or nothing — including when something unusable is bound. */
  manager(): StorageManagerLike | undefined {
    if (this.bound === undefined || this.bound === null) return undefined;
    if (isStorageManager(this.bound)) return this.bound;
    if (!this.warned) {
      this.warned = true;
      this.logger.warn(storageMisboundDetail(nameOf(this.bound)));
    }
    return undefined;
  }

  /** What to tell a console about naming a disk here. */
  availability(): StorageAvailability {
    const manager = this.manager();
    if (!manager) {
      const misbound = this.bound !== undefined && this.bound !== null;
      return {
        available: false,
        disks: [],
        detail: misbound ? storageMisboundDetail(nameOf(this.bound)) : NO_STORAGE_DETAIL,
      };
    }
    const disks = manager.diskNames();
    return { available: true, disks, detail: storageAvailableDetail(disks) };
  }
}

/** The class that was bound, which is the whole of what "what is that" can mean here. */
function nameOf(value: unknown): string {
  if (value && typeof value === 'object') {
    const ctor: unknown = Reflect.get(value, 'constructor');
    if (ctor && typeof ctor === 'function' && typeof ctor.name === 'string' && ctor.name) {
      return ctor.name;
    }
  }
  return typeof value;
}
