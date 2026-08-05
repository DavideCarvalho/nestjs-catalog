import {
  CONNECTOR_KINDS,
  type CatalogConnection,
  type CatalogConnector,
} from '@dudousxd/nestjs-catalog';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installSecretEnvAllowlist } from './secret-env-allowlist';
import {
  type FetchContext,
  SOURCES,
  applyConnection,
  fetchInline,
  importOptional,
  resolveSecret,
  resolveSecretEnv,
  toFetchResult,
} from './sources';

function connector(overrides: Partial<CatalogConnector> = {}): CatalogConnector {
  return {
    id: 'c1',
    name: 'Nightly pull',
    kind: 'sql',
    targetType: 'Mvr',
    config: {},
    enabled: true,
    createdBy: 'ana',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function connection(overrides: Partial<CatalogConnection> = {}): CatalogConnection {
  return {
    id: 'conn-1',
    name: 'Warehouse',
    kind: 'sql',
    config: {},
    createdBy: 'ana',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('toFetchResult', () => {
  it('reads the bare-array shape as records with nothing to remember', () => {
    expect(toFetchResult([{ a: 1 }])).toEqual({ records: [{ a: 1 }] });
  });

  // A fetcher that DOES have something to remember returns it beside the
  // records, and the runner persists it only after the load commits. Flattening
  // it here would silently lose the watermark and make every incremental run a
  // full one.
  it('passes a result carrying state through untouched', () => {
    const result = { records: [{ a: 1 }], state: { watermark: '2026-01-01' } };
    expect(toFetchResult(result)).toBe(result);
  });

  it('reads an empty fetch as no records rather than as nothing at all', () => {
    expect(toFetchResult([])).toEqual({ records: [] });
  });
});

describe('resolveSecretEnv', () => {
  const touched: string[] = [];

  // Every case here names a variable this deployment admits. The allow-list
  // itself — which names get through, and what a caller is told about the ones
  // that do not — is `secret-env-allowlist.spec.ts` and
  // `sources.secret-env.spec.ts`; these are the resolution mechanics on top of
  // it, and installing the list is what stops them testing the refusal by
  // accident.
  beforeEach(() => {
    installSecretEnvAllowlist(['CATALOG_TEST_*']);
  });

  afterEach(() => {
    installSecretEnvAllowlist(undefined);
    for (const name of touched.splice(0)) delete process.env[name];
  });

  function setEnv(name: string, value: string): void {
    touched.push(name);
    process.env[name] = value;
  }

  it('reads the credential out of the variable the catalog named', () => {
    setEnv('CATALOG_TEST_SECRET', 'hunter2');
    expect(resolveSecretEnv('CATALOG_TEST_SECRET')).toBe('hunter2');
  });

  it('asks for nothing when the source needs no credential', () => {
    expect(resolveSecretEnv()).toBeUndefined();
    expect(resolveSecretEnv('')).toBeUndefined();
  });

  // The secret is named and never stored, so an unset variable is the one thing
  // this cannot paper over. Returning undefined would send the fetcher on to
  // authenticate as nobody, and the failure would arrive later as a 403 against
  // the source rather than a misconfiguration here.
  //
  // What it may no longer do is say WHICH — an admitted-but-unset variable and a
  // name that was never admitted are one sentence now, because the two being
  // different made this an oracle for the pod's environment. The name is still
  // repeated back; the caller supplied it.
  it('fails, naming the variable, when it is not set', () => {
    expect(() => resolveSecretEnv('CATALOG_TEST_MISSING')).toThrow(/CATALOG_TEST_MISSING/);
    expect(() => resolveSecretEnv('CATALOG_TEST_MISSING')).toThrow(/No credential is available/);
  });

  it('treats a variable set to the empty string as not set', () => {
    setEnv('CATALOG_TEST_EMPTY', '');
    expect(() => resolveSecretEnv('CATALOG_TEST_EMPTY')).toThrow(/CATALOG_TEST_EMPTY/);
  });

  it('resolves the variable a connector names', () => {
    setEnv('CATALOG_TEST_CONNECTOR', 'from-the-connector');
    expect(resolveSecret(connector({ secretEnvVar: 'CATALOG_TEST_CONNECTOR' }))).toBe(
      'from-the-connector',
    );
    expect(resolveSecret(connector())).toBeUndefined();
  });
});

describe('applyConnection', () => {
  it('leaves a connector that reads through no connection exactly as it was', () => {
    const inline = connector({ config: { url: 'postgres://inline' } });
    expect(applyConnection(inline)).toBe(inline);
  });

  it('supplies the address the connector does not carry', () => {
    const resolved = applyConnection(
      connector({ config: { query: 'select 1' } }),
      connection({ config: { url: 'postgres://warehouse' } }),
    );
    expect(resolved.config).toEqual({ url: 'postgres://warehouse', query: 'select 1' });
  });

  // A connection is a default: a load that needs a different prefix under the
  // same bucket must not need a second connection.
  it('lets the connector win where both name the same key', () => {
    const resolved = applyConnection(
      connector({ config: { url: 'postgres://override' } }),
      connection({ config: { url: 'postgres://warehouse' } }),
    );
    expect(resolved.config.url).toBe('postgres://override');
  });

  it('takes the connection credential when the connector names none', () => {
    const resolved = applyConnection(connector(), connection({ secretEnvVar: 'WAREHOUSE_URL' }));
    expect(resolved.secretEnvVar).toBe('WAREHOUSE_URL');
  });

  it('keeps the connector credential when it names one', () => {
    const resolved = applyConnection(
      connector({ secretEnvVar: 'CONNECTOR_URL' }),
      connection({ secretEnvVar: 'WAREHOUSE_URL' }),
    );
    expect(resolved.secretEnvVar).toBe('CONNECTOR_URL');
  });

  // Reaching a SQL database through an S3 connection would put a bucket where a
  // connection URL belongs, and the fetcher would then fail describing the
  // symptom rather than the mistake.
  it('refuses a connector and a connection of different kinds, naming both', () => {
    expect(() =>
      applyConnection(connector({ kind: 'sql' }), connection({ kind: 's3', name: 'Drops' })),
    ).toThrow(/Nightly pull.*sql.*Drops.*s3/s);
  });

  // Resolution happens at RUN time, not at save time: an edited connection has
  // to take effect on the next run. Folding into the stored connector — or
  // memoising the result — is what would break that.
  it('never edits the connector it was given', () => {
    const original = connector({ config: { query: 'select 1' } });
    applyConnection(original, connection({ config: { url: 'postgres://warehouse' } }));
    expect(original.config).toEqual({ query: 'select 1' });
    expect(original.secretEnvVar).toBeUndefined();
  });

  it('reflects the connection as it stands on each call', () => {
    const stored = connector({ config: { query: 'select 1' } });
    const before = applyConnection(stored, connection({ config: { url: 'postgres://old' } }));
    const after = applyConnection(stored, connection({ config: { url: 'postgres://new' } }));
    expect(before.config.url).toBe('postgres://old');
    expect(after.config.url).toBe('postgres://new');
  });
});

describe('the fetcher registry', () => {
  // "A kind that exists in the type and throws at run time is worse than one
  // that is absent, because the first looks supported in a dropdown." This is
  // the test that keeps the two lists honest.
  it.each(CONNECTOR_KINDS)('can actually execute the %s kind it offers', (kind) => {
    expect(typeof SOURCES[kind]).toBe('function');
  });

  it('offers nothing the connector-kind vocabulary does not name', () => {
    expect(Object.keys(SOURCES).sort()).toEqual([...CONNECTOR_KINDS].sort());
  });
});

describe('fetchInline', () => {
  const context: Pick<FetchContext, 'state' | 'mode'> = { state: {}, mode: 'full' };

  it('returns the records pasted into the config', async () => {
    const records = [{ a: 1 }, { a: 2 }];
    await expect(
      fetchInline({ connector: connector({ config: { records } }), ...context }),
    ).resolves.toEqual(records);
  });

  // The config is authored by hand, so `records` can be anything at all. Reading
  // a non-array as empty keeps a typo out of the transform, which would
  // otherwise receive a string and produce rows named after its characters.
  it.each([undefined, null, 'rows', 42, { a: 1 }])('reads %o as no records', async (records) => {
    await expect(
      fetchInline({ connector: connector({ config: { records } }), ...context }),
    ).resolves.toEqual([]);
  });
});

describe('importOptional', () => {
  // "Cannot find module 'pg'" in a catalog log tells an operator nothing about
  // which connector caused it, so the error names the package to install.
  it('names the package and the driver when it is not installed', async () => {
    await expect(importOptional('definitely-not-installed', 'postgres')).rejects.toThrow(
      /no postgres driver installed.*"definitely-not-installed"/s,
    );
  });

  it('names the package rather than the entry point inside it', async () => {
    // "mysql2/promise" is not installable, so the suggestion has to be trimmed
    // back to what a person can actually add.
    await expect(importOptional('not-installed-either/promise', 'mysql')).rejects.toThrow(
      /"not-installed-either"/,
    );
  });

  it('keeps both segments of a scoped package', async () => {
    await expect(importOptional('@no-such-scope/client-s3', 'S3')).rejects.toThrow(
      /"@no-such-scope\/client-s3"/,
    );
  });

  it('returns the module when it is there', async () => {
    await expect(importOptional('node:path', 'path')).resolves.toBeDefined();
  });
});
