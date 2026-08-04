import type { EntityManager } from '@mikro-orm/mysql';
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ConnectionRow, ConnectorRow } from './entities/pipeline';
import { MySqlPipelineStore } from './pipeline.store';

/**
 * That a plaintext credential cannot be *introduced* into `config`.
 *
 * Kept out of `*.db.spec.ts` deliberately, unlike the rest of this package's
 * store tests: the rule under test is a refusal that happens before a single
 * statement is issued, so booting MySQL to prove it would make a check that
 * runs on every save depend on Docker. Everything the store does reach is
 * stubbed, and only the calls `saveConnector` and `saveConnection` actually
 * make are answered — a stub that invented a plausible row for a query these
 * methods do not run would be asserting against fiction.
 */
function entityManager(rows: {
  connector?: ConnectorRow;
  connection?: ConnectionRow;
}): { em: EntityManager; flushed: Array<Record<string, unknown>> } {
  const flushed: Array<Record<string, unknown>> = [];
  let pending: Array<Record<string, unknown>> = [];

  const fake = {
    fork: () => fake,
    findOne: (entity: unknown) => {
      if (entity === ConnectorRow) return Promise.resolve(rows.connector ?? null);
      if (entity === ConnectionRow) return Promise.resolve(rows.connection ?? null);
      throw new Error('These tests exercise no other entity.');
    },
    create: (_entity: unknown, data: Record<string, unknown>) => ({ ...data }),
    persist: (row: Record<string, unknown>) => {
      pending.push(row);
    },
    flush: () => {
      flushed.push(...pending);
      pending = [];
      return Promise.resolve();
    },
  };

  // Not a type assertion: `Object.create(null)` is `any`, so the merged value
  // is too, and the declared return type is what narrows it back down.
  return { em: Object.assign(Object.create(null), fake), flushed };
}

const PASSWORD_URL = 'postgres://ana:s3cr3t@db.internal:5432/app';

function storedConnector(config: Record<string, unknown>): ConnectorRow {
  const row = new ConnectorRow();
  row.id = 'c1';
  row.name = 'Nightly';
  row.kind = 'sql';
  row.targetType = 'Subwo';
  row.config = config;
  row.enabled = true;
  row.createdBy = 'app-b';
  row.createdAt = new Date('2020-01-01T00:00:00.000Z');
  row.updatedAt = new Date('2020-01-01T00:00:00.000Z');
  return row;
}

function storedConnection(config: Record<string, unknown>): ConnectionRow {
  const row = new ConnectionRow();
  row.id = 'conn-1';
  row.name = 'Warehouse';
  row.kind = 'sql';
  row.config = config;
  row.createdBy = 'app-b';
  row.createdAt = new Date('2020-01-01T00:00:00.000Z');
  row.updatedAt = new Date('2020-01-01T00:00:00.000Z');
  return row;
}

const connectorInput = (config: Record<string, unknown>, id?: string) => ({
  ...(id ? { id } : {}),
  name: 'Nightly',
  kind: 'sql' as const,
  targetType: 'Subwo',
  config,
  mode: 'full' as const,
  state: {},
  enabled: true,
});

const connectionInput = (config: Record<string, unknown>, id?: string) => ({
  ...(id ? { id } : {}),
  name: 'Warehouse',
  kind: 'sql' as const,
  config,
});

describe('MySqlPipelineStore.saveConnector: no new plaintext credential', () => {
  // The defect: `fetchSql` reads `config.url`, so this string is the
  // credential, and both `ConnectorRow.config` and `ConnectionRow.config`
  // promise in their own docblocks that a credential is never stored here.
  it('refuses a new connector carrying a password in its URL', async () => {
    const { em, flushed } = entityManager({});
    const store = new MySqlPipelineStore(em);

    await expect(
      store.saveConnector(connectorInput({ url: PASSWORD_URL }), 'app-b'),
    ).rejects.toThrow(BadRequestException);
    // Refused before anything was written, which is the only version of this
    // check worth having.
    expect(flushed).toEqual([]);
  });

  it('names the config key and points at where the credential belongs', async () => {
    const { em } = entityManager({});
    const store = new MySqlPipelineStore(em);

    await expect(
      store.saveConnector(connectorInput({ url: PASSWORD_URL }), 'app-b'),
    ).rejects.toThrow(/config\.url/);
    await expect(
      store.saveConnector(connectorInput({ url: PASSWORD_URL }), 'app-b'),
    ).rejects.toThrow(/Credential env var/);
  });

  it('refuses it under any key, not only `url`', async () => {
    const { em } = entityManager({});
    const store = new MySqlPipelineStore(em);

    await expect(
      store.saveConnector(connectorInput({ replicaUrl: PASSWORD_URL }), 'app-b'),
    ).rejects.toThrow(/config\.replicaUrl/);
  });

  it('accepts a URL nobody put a password in', async () => {
    const { em, flushed } = entityManager({});
    const store = new MySqlPipelineStore(em);

    await store.saveConnector(
      connectorInput({ url: 'https://api.example.com/v1/orders' }),
      'app-b',
    );
    expect(flushed).toHaveLength(1);
  });

  it('accepts a query that is not a URL at all', async () => {
    const { em, flushed } = entityManager({});
    const store = new MySqlPipelineStore(em);

    await store.saveConnector(connectorInput({ query: 'SELECT * FROM orders' }), 'app-b');
    expect(flushed).toHaveLength(1);
  });

  // Grandfathered: the password is already in the table either way, and
  // refusing would break a working load and stop anyone renaming or disabling
  // it. This is also what makes the console's read-edit-save round trip work,
  // since the controller puts the stored value back before it gets here.
  it('lets an existing connector keep the URL it already has', async () => {
    const { em, flushed } = entityManager({ connector: storedConnector({ url: PASSWORD_URL }) });
    const store = new MySqlPipelineStore(em);

    await store.saveConnector(
      { ...connectorInput({ url: PASSWORD_URL }, 'c1'), name: 'Nightly (EU)' },
      'app-b',
    );
    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.name).toBe('Nightly (EU)');
  });

  it('refuses a *different* password on an existing connector', async () => {
    const { em, flushed } = entityManager({ connector: storedConnector({ url: PASSWORD_URL }) });
    const store = new MySqlPipelineStore(em);

    await expect(
      store.saveConnector(
        connectorInput({ url: 'postgres://ana:rotated@db.internal:5432/app' }, 'c1'),
        'app-b',
      ),
    ).rejects.toThrow(BadRequestException);
    expect(flushed).toEqual([]);
  });

  // The placeholder is a password-bearing URL that was never stored, so it can
  // never be grandfathered. A client that skipped the controller's restore step
  // gets a 400 rather than a connector whose credential is the word REDACTED.
  it('refuses a redacted placeholder posted back as though it were real', async () => {
    const { em, flushed } = entityManager({ connector: storedConnector({ url: PASSWORD_URL }) });
    const store = new MySqlPipelineStore(em);

    await expect(
      store.saveConnector(
        connectorInput({ url: 'postgres://ana:REDACTED@db.internal:5432/app' }, 'c1'),
        'app-b',
      ),
    ).rejects.toThrow(BadRequestException);
    expect(flushed).toEqual([]);
  });

  it('grandfathers one key without excusing another', async () => {
    const { em } = entityManager({ connector: storedConnector({ url: PASSWORD_URL }) });
    const store = new MySqlPipelineStore(em);

    await expect(
      store.saveConnector(
        connectorInput({ url: PASSWORD_URL, replicaUrl: 'postgres://a:b@replica/db' }, 'c1'),
        'app-b',
      ),
    ).rejects.toThrow(/config\.replicaUrl/);
  });
});

describe('MySqlPipelineStore.saveConnection: the same rule', () => {
  // A connection is where a SQL URL usually lives, so this is the path that
  // matters most — and `GET pipeline/connections` is the route that was serving
  // it under `catalog:read`.
  it('refuses a new connection carrying a password in its URL', async () => {
    const { em, flushed } = entityManager({});
    const store = new MySqlPipelineStore(em);

    await expect(
      store.saveConnection(connectionInput({ url: PASSWORD_URL }), 'app-b'),
    ).rejects.toThrow(BadRequestException);
    expect(flushed).toEqual([]);
  });

  it('accepts one that names an environment variable instead', async () => {
    const { em, flushed } = entityManager({});
    const store = new MySqlPipelineStore(em);

    await store.saveConnection(
      {
        ...connectionInput({ url: 'postgres://db.internal:5432/app' }),
        secretEnvVar: 'WAREHOUSE_URL',
      },
      'app-b',
    );
    expect(flushed).toHaveLength(1);
  });

  it('lets an existing connection keep the URL it already has', async () => {
    const { em, flushed } = entityManager({ connection: storedConnection({ url: PASSWORD_URL }) });
    const store = new MySqlPipelineStore(em);

    await store.saveConnection(
      { ...connectionInput({ url: PASSWORD_URL }, 'conn-1'), name: 'Warehouse (EU)' },
      'app-b',
    );
    expect(flushed).toHaveLength(1);
  });
});
