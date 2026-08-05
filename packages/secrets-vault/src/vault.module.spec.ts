import 'reflect-metadata';
import { CATALOG_SECRET_VAULT, type CatalogSecretVault } from '@dudousxd/nestjs-catalog';
import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { stubReplying } from '../test/fake-vault';
import { staticToken } from './auth';
import { CatalogVaultSecretsModule } from './vault.module';
import { VaultTransitSecretVault } from './vault.secrets';

/**
 * The wiring, booted rather than asserted about.
 *
 * A `DynamicModule` literal can be inspected, and inspecting it would only
 * restate the code that built it. What can actually be wrong is whether the
 * token a host injects resolves, and whether it resolves to the *same* object
 * the concrete class does — a `useClass` where a `useExisting` belongs gives two
 * instances, two token caches and two logins, and the only symptom is twice the
 * auth traffic, which nobody reads as a DI mistake.
 */

const ADDRESS = Symbol('ADDRESS');

@Module({
  providers: [{ provide: ADDRESS, useValue: 'https://late.test' }],
  exports: [ADDRESS],
})
class ConfigStub {}

describe('CatalogVaultSecretsModule', () => {
  it('binds CATALOG_SECRET_VAULT and the concrete class to one instance', async () => {
    const { fetch } = stubReplying({ body: { data: {} } });

    const moduleRef = await Test.createTestingModule({
      imports: [
        CatalogVaultSecretsModule.forRoot({
          address: 'https://vault.test',
          auth: staticToken('s.token'),
          fetch,
        }),
      ],
    }).compile();

    const byToken = moduleRef.get<CatalogSecretVault>(CATALOG_SECRET_VAULT);
    expect(byToken).toBeInstanceOf(VaultTransitSecretVault);
    // The class is exported alongside the token because `rewrap` is not on the
    // interface, so a rotation job has to reach the concrete type.
    expect(byToken).toBe(moduleRef.get(VaultTransitSecretVault));
    expect(byToken.name).toBe('vault-transit');
  });

  it('boots without reaching Vault', async () => {
    // A Vault that is down must not stop an application starting: the other
    // ninety-nine percent of the catalog needs no secrets.
    const { fetch, calls } = stubReplying({ status: 503, body: { errors: ['Vault is sealed'] } });

    await Test.createTestingModule({
      imports: [
        CatalogVaultSecretsModule.forRoot({
          address: 'https://vault.test',
          auth: staticToken('s.token'),
          fetch,
        }),
      ],
    }).compile();

    expect(calls).toHaveLength(0);
  });

  it('refuses an unusable configuration while somebody is still looking at the wiring', () => {
    expect(() =>
      CatalogVaultSecretsModule.forRoot({ address: '', auth: staticToken('s.token') }),
    ).toThrowError(TypeError);
  });

  it('assembles its options from another module with forRootAsync', async () => {
    // The shape a ConfigModule host needs: an AppRole secret_id arrives through
    // the same config layer as everything else, and `forRoot` would force it to
    // be read at module-definition time.
    const { fetch } = stubReplying({ body: { data: {} } });

    const moduleRef = await Test.createTestingModule({
      imports: [
        CatalogVaultSecretsModule.forRootAsync({
          imports: [ConfigStub],
          inject: [ADDRESS],
          useFactory: (address: string) => ({
            address,
            auth: staticToken('s.token'),
            name: 'from-config',
            fetch,
          }),
        }),
      ],
    }).compile();

    expect(moduleRef.get<CatalogSecretVault>(CATALOG_SECRET_VAULT).name).toBe('from-config');
  });
});
