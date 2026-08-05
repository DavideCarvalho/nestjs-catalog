export { DataKeyCache, zeroKey } from './data-key-cache';
export {
  additionalAuthenticatedData,
  CONTEXT_KEY_FIELD,
  CONTEXT_KEY_KIND,
  encryptionContextFor,
} from './encryption-context';
export {
  type CatalogSecretEnvelope,
  ENVELOPE_MAGIC,
  NONCE_BYTES,
  packEnvelope,
  TAG_BYTES,
  unpackEnvelope,
} from './envelope';
export { CatalogKmsVaultError, CHECK_CLOUDTRAIL, isPermanentKmsFailure } from './errors';
export {
  type CatalogKmsClient,
  decryptDataKey,
  generateDataKey,
  type GeneratedDataKey,
} from './kms.client';
export { KmsCatalogSecretVault } from './kms.vault';
export {
  CATALOG_AWS_KMS_OPTIONS,
  type CatalogAwsKmsVaultOptions,
  DEFAULT_DATA_KEY_CACHE_MAX_ENTRIES,
  DEFAULT_DATA_KEY_CACHE_TTL_MS,
  DEFAULT_VAULT_NAME,
} from './options';
export { CatalogAwsSecretsModule, type CatalogAwsSecretsAsyncOptions } from './secrets.module';
