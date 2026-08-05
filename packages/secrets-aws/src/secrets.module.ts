import { CATALOG_SECRET_VAULT } from '@dudousxd/nestjs-catalog';
import {
  type DynamicModule,
  type ForwardReference,
  type InjectionToken,
  Module,
  type OptionalFactoryDependency,
  type Provider,
  type Type,
} from '@nestjs/common';
import { KmsCatalogSecretVault } from './kms.vault';
import { CATALOG_AWS_KMS_OPTIONS, type CatalogAwsKmsVaultOptions } from './options';

export interface CatalogAwsSecretsAsyncOptions {
  imports?: Array<Type<unknown> | DynamicModule | Promise<DynamicModule> | ForwardReference>;
  inject?: Array<InjectionToken | OptionalFactoryDependency>;
  useFactory: (...args: never[]) => CatalogAwsKmsVaultOptions | Promise<CatalogAwsKmsVaultOptions>;
}

/**
 * Binds `CATALOG_SECRET_VAULT` to a KMS-backed vault.
 *
 * ```ts
 * import { KMSClient } from "@aws-sdk/client-kms";
 *
 * CatalogAwsSecretsModule.forRoot({
 *   client: new KMSClient({ region: "us-gov-west-1" }),
 *   key: "alias/catalog-secrets",
 * });
 * ```
 *
 * The client is the host's, always. This module has no `region` option and will
 * not grow one: endpoint resolution, the credential chain, FIPS endpoint
 * selection and the retry policy are decisions a deployment has already made
 * once for every other AWS client in the process, and a second place to make
 * them is a second place to get them wrong in a partition this package was not
 * tested in.
 *
 * ## Binding this alongside another vault
 *
 * `CATALOG_SECRET_VAULT` accepts an array, and that is the supported shape for
 * rotation: seals go to the first, opens go to whichever `name` matches the row.
 * This module binds a single vault, which is the ordinary case; a host mid-
 * rotation should bind the array itself rather than importing this module twice,
 * because two imports of it leave the token bound to whichever was registered
 * last — with no error, and with the first vault's rows quietly unopenable.
 *
 * ```ts
 * providers: [
 *   {
 *     provide: CATALOG_SECRET_VAULT,
 *     useFactory: () => [
 *       new KmsCatalogSecretVault({ client, key: "alias/catalog-next", name: "aws-kms-next" }),
 *       new KmsCatalogSecretVault({ client, key: "alias/catalog", name: "aws-kms" }),
 *     ],
 *   },
 * ]
 * ```
 */
@Module({})
export class CatalogAwsSecretsModule {
  static forRoot(options: CatalogAwsKmsVaultOptions): DynamicModule {
    return build([{ provide: CATALOG_AWS_KMS_OPTIONS, useValue: options }]);
  }

  /**
   * The same thing, for a host whose client or key comes out of its own config.
   *
   * Worth having as well as `forRoot` because the key reference is nearly always
   * per-environment — a dev account's alias is not a GovCloud account's — and
   * `forRoot` forces that lookup to happen at module-definition time, which in
   * practice means at import time, which is before a `ConfigModule` has read
   * anything.
   */
  static forRootAsync(options: CatalogAwsSecretsAsyncOptions): DynamicModule {
    return {
      ...build([
        {
          provide: CATALOG_AWS_KMS_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
      ]),
      imports: options.imports ?? [],
    };
  }
}

/**
 * One shape for both entry points, so the two cannot drift in what they export.
 *
 * The vault is constructed in a factory rather than by `@Injectable()` on the
 * class, because its constructor takes an options object Nest has no way to
 * resolve — and a class that declares itself injectable while being
 * unconstructable by the injector is a trap for the host that tries.
 */
function build(optionProviders: Provider[]): DynamicModule {
  return {
    module: CatalogAwsSecretsModule,
    providers: [
      ...optionProviders,
      {
        provide: KmsCatalogSecretVault,
        useFactory: (options: CatalogAwsKmsVaultOptions) => new KmsCatalogSecretVault(options),
        inject: [CATALOG_AWS_KMS_OPTIONS],
      },
      { provide: CATALOG_SECRET_VAULT, useExisting: KmsCatalogSecretVault },
    ],
    exports: [
      CATALOG_SECRET_VAULT,
      // Exported under its own class too, so a host can inject it to call
      // `forgetCachedDataKeys()` — which it must be able to reach without going
      // through a token typed as the interface, since the interface has no such
      // method and should not grow one for a single provider's benefit.
      KmsCatalogSecretVault,
    ],
  };
}
