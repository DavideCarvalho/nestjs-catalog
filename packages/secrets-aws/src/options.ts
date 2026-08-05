import type { CatalogKmsClient } from './kms.client';

/**
 * Kept in its own file, not beside the module that consumes it.
 *
 * The vault needs these and the module needs the vault, so declaring them in the
 * module makes the two files import each other. Nest resolves a circular import
 * to `undefined` at injection time, and the error it reports points at the
 * argument position rather than at the cycle — the same reasoning
 * `@dudousxd/nestjs-catalog-store-fanout` records for its own options file.
 */
export const CATALOG_AWS_KMS_OPTIONS = Symbol('CATALOG_AWS_KMS_OPTIONS');

/**
 * The name this vault answers to, and it is written into every row.
 *
 * `CatalogSecretVault.name` is documented as stable across deployments and
 * releases, and the store refuses to open a row whose name does not match a
 * bound vault. So this default is effectively a wire constant: a deployment that
 * takes it and later overrides it has stranded every row sealed in between.
 *
 * Overriding it is nevertheless the right thing in one shape, which is why it is
 * an option at all. `CATALOG_SECRET_VAULT` accepts an array, and rotation is
 * "bind `[next, current]` and let saves reseal" — which needs two vaults that
 * are both this class, over two keys, two regions or two accounts, with two
 * distinct names. `aws-kms` and `aws-kms-next` is the whole of that ceremony.
 */
export const DEFAULT_VAULT_NAME = 'aws-kms';

/**
 * Five minutes.
 *
 * Chosen against revocation, not against memory. It is how long a disabled key
 * or a stripped `kms:Decrypt` keeps working for secrets already opened, and five
 * minutes is short enough that "we have cut that off" is true by the time
 * somebody has finished saying it, while still collapsing the load of a
 * connector that runs on a one-minute schedule to one KMS call in five.
 */
export const DEFAULT_DATA_KEY_CACHE_TTL_MS = 5 * 60_000;

/**
 * 256 entries — a bound on how many data keys are resident, which is the number
 * that matters, rather than on bytes. Each entry is 32 bytes of key plus its map
 * overhead, so this is kilobytes; the reason for a limit is not the memory but
 * that an unbounded cache in a process reading a long tail of connections is a
 * growing pile of live key material.
 */
export const DEFAULT_DATA_KEY_CACHE_MAX_ENTRIES = 256;

export interface CatalogAwsKmsVaultOptions {
  /**
   * A KMS client the host built.
   *
   * This package never constructs one, and that is the entire GovCloud story:
   * region, endpoint, credential chain, retry policy and FIPS selection are the
   * host's, made once, in the place where the rest of its AWS clients are made.
   * A `region` option here would be a second, worse place for the same decision
   * — and the first thing to be wrong in a partition this package had not been
   * tested in.
   */
  client: CatalogKmsClient;
  /**
   * Which key to seal *new* secrets under. An alias
   * (`alias/catalog-secrets`), a key id, or a key ARN — KMS resolves all three.
   *
   * An alias is the good answer here, and it is worth being clear that this is
   * not in tension with recording the ARN on the row. This value says "the key
   * we are sealing with today", which should be a name a deployment can repoint;
   * the row records "the key this was actually sealed with", which must never
   * move. Configure the pointer, store the fact.
   */
  key: string;
  /** Defaults to {@link DEFAULT_VAULT_NAME}. Read its note before changing it. */
  name?: string;
  /**
   * How long an unwrapped data key may stay in memory. Defaults to
   * {@link DEFAULT_DATA_KEY_CACHE_TTL_MS}.
   *
   * **`0` disables caching entirely**, and that is the correct setting — not a
   * degraded one — for a deployment whose control is "every access to a
   * credential is logged". A cache hit is an access with no CloudTrail event, so
   * no TTL above zero can satisfy that; the price is one `kms:Decrypt` per open.
   */
  dataKeyCacheTtlMs?: number;
  /** Defaults to {@link DEFAULT_DATA_KEY_CACHE_MAX_ENTRIES}. */
  dataKeyCacheMaxEntries?: number;
}
