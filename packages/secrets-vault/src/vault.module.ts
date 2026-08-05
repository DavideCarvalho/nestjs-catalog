import { CATALOG_SECRET_VAULT } from '@dudousxd/nestjs-catalog';
import { type DynamicModule, type InjectionToken, Module, type Provider } from '@nestjs/common';
import {
  CATALOG_VAULT_SECRETS_OPTIONS,
  type ResolvedVaultOptions,
  type VaultTransitSecretVaultOptions,
  resolveOptions,
} from './options';
import { VaultTransitSecretVault } from './vault.secrets';

/**
 * Binds `CATALOG_SECRET_VAULT` to Vault's Transit engine.
 *
 * ```ts
 * CatalogVaultSecretsModule.forRoot({
 *   address: process.env.VAULT_ADDR ?? '',
 *   auth: kubernetesAuth({ role: 'catalog' }),
 * })
 * ```
 *
 * **`@dudousxd/nestjs-catalog` must be a peer, never a nested copy.**
 * `CATALOG_SECRET_VAULT` is a `unique symbol` — a plain `Symbol()`, equal only
 * to itself within one loaded copy of the package. Two copies in a dependency
 * tree means this module binds one symbol while the catalog injects a different
 * one, the container reports nothing, and every secret path behaves as though no
 * vault were configured at all. Whether that is silent or loud depends on what
 * the catalog does with an unbound token, which is not this package's decision
 * to rely on.
 *
 * **This binds one vault.** `CATALOG_SECRET_VAULT` accepts an array, and a host
 * mid-rotation wants two — see `createVaultTransitSecretVault`, which builds an
 * instance to put in a list this module cannot assemble, because the other
 * element may come from another package entirely.
 *
 * Nothing here connects at boot. The first Vault call happens on the first
 * `seal` or `open`, which means a Vault that is down does not stop the
 * application from starting — deliberate, because the alternative is a catalog
 * that cannot serve the ninety-nine percent of its surface that needs no
 * secrets, because of the one percent that does. What *is* validated at boot is
 * the configuration: see {@link resolveOptions}.
 */
@Module({})
export class CatalogVaultSecretsModule {
  static forRoot(options: VaultTransitSecretVaultOptions): DynamicModule {
    return build({ provide: CATALOG_VAULT_SECRETS_OPTIONS, useValue: resolveOptions(options) });
  }

  /**
   * The same thing, with the options assembled from other providers — a
   * `ConfigService`, or a secret loaded by something earlier in the graph.
   *
   * Worth having rather than telling hosts to read `process.env` inline: an
   * AppRole `secret_id` typically arrives through the same config layer as
   * everything else, and `forRoot` would force it to be read at module-
   * definition time, which is before a `ConfigModule` has necessarily loaded
   * anything.
   */
  static forRootAsync(options: {
    imports?: DynamicModule['imports'];
    inject?: InjectionToken[];
    useFactory: (
      ...args: never[]
    ) => VaultTransitSecretVaultOptions | Promise<VaultTransitSecretVaultOptions>;
  }): DynamicModule {
    return build(
      {
        provide: CATALOG_VAULT_SECRETS_OPTIONS,
        inject: options.inject ?? [],
        useFactory: async (...args: never[]): Promise<ResolvedVaultOptions> =>
          resolveOptions(await options.useFactory(...args)),
      },
      options.imports,
    );
  }
}

function build(optionsProvider: Provider, imports?: DynamicModule['imports']): DynamicModule {
  return {
    module: CatalogVaultSecretsModule,
    imports: imports ?? [],
    providers: [
      optionsProvider,
      {
        provide: VaultTransitSecretVault,
        inject: [CATALOG_VAULT_SECRETS_OPTIONS],
        useFactory: (resolved: ResolvedVaultOptions) => new VaultTransitSecretVault(resolved),
      },
      // `useExisting`, so the concrete class and the token are the same instance.
      // Two instances would mean two token caches and two logins, and the second
      // one would be invisible — the symptom is twice the auth traffic, which
      // nobody reads as a DI mistake.
      { provide: CATALOG_SECRET_VAULT, useExisting: VaultTransitSecretVault },
    ],
    // The class is exported alongside the token because `rewrap` is not on the
    // interface. A rotation job has to inject the concrete type to reach it.
    exports: [CATALOG_SECRET_VAULT, VaultTransitSecretVault],
  };
}
