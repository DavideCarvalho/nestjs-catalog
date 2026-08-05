export {
  type AppRoleAuthOptions,
  appRoleAuth,
  DEFAULT_SERVICE_ACCOUNT_TOKEN_PATH,
  type KubernetesAuthOptions,
  kubernetesAuth,
  staticToken,
  type VaultAuth,
  VaultSession,
  type VaultSessionOptions,
  type VaultTokenGrant,
} from './auth';
export {
  classifyStatus,
  VAULT_FAILURE_KINDS,
  type VaultFailureKind,
  VaultTransitError,
  type VaultTransitErrorInit,
} from './errors';
export {
  isRecord,
  VaultHttp,
  type VaultFetch,
  type VaultFetchInit,
  type VaultFetchResponse,
  type VaultHttpOptions,
} from './http';
export {
  CATALOG_VAULT_SECRETS_OPTIONS,
  DEFAULT_OPEN_ATTEMPTS,
  DEFAULT_RETRY_BASE_DELAY_MS,
  DEFAULT_SEAL_ATTEMPTS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TRANSIT_KEY,
  DEFAULT_TRANSIT_MOUNT,
  DEFAULT_VAULT_NAME,
  type ResolvedVaultOptions,
  resolveOptions,
  type VaultTransitSecretVaultOptions,
} from './options';
export {
  assertPath,
  bindingFor,
  ciphertextKeyVersion,
  decodeBase64,
  encodeBase64,
  formatKeyId,
  isTransitCiphertext,
  parseKeyId,
  TransitClient,
  type TransitKeyRef,
} from './transit';
export { CatalogVaultSecretsModule } from './vault.module';
export { createVaultTransitSecretVault, VaultTransitSecretVault } from './vault.secrets';
