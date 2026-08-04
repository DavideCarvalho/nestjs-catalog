import { describe, expect, it } from 'vitest';
import {
  REDACTED_SECRET,
  carriesUrlPassword,
  redactConfigSecrets,
  restoreRedactedSecrets,
} from './config-secrets';

describe('redactConfigSecrets', () => {
  // The defect, stated as a test: `fetchSql` reads `config.url`, so this string
  // IS the credential, and it was served by `GET pipeline/connections` under
  // `catalog:read`.
  it('hides the password in a SQL connection URL', () => {
    const redacted = redactConfigSecrets({ url: 'postgres://ana:s3cr3t@db.internal:5432/app' });
    expect(redacted.url).toBe(`postgres://ana:${REDACTED_SECRET}@db.internal:5432/app`);
    expect(String(redacted.url)).not.toContain('s3cr3t');
  });

  it('hides it for a non-special scheme the URL parser could have made opaque', () => {
    // `mysql:` and `postgres:` are not special schemes. A regular expression
    // over `://` would work by accident; this is here so that swapping the
    // parse for one cannot pass.
    expect(redactConfigSecrets({ url: 'mysql://root:hunter2@10.0.0.1:3306/app' }).url).toBe(
      `mysql://root:${REDACTED_SECRET}@10.0.0.1:3306/app`,
    );
  });

  it('leaves the username, the host and the query alone', () => {
    // The point is a connector that is still recognisable on the screen. A
    // redaction that blanked the whole URL would send people to the database to
    // find out which server a connector reads.
    const redacted = redactConfigSecrets({
      url: 'postgres://ana:s3cr3t@db.internal:5432/app?sslmode=require',
    });
    expect(redacted.url).toContain('ana');
    expect(redacted.url).toContain('db.internal:5432');
    expect(redacted.url).toContain('sslmode=require');
  });

  it('leaves a URL nobody put a password in exactly as it was', () => {
    const config = { url: 'https://api.example.com/v1/orders?since=2020' };
    expect(redactConfigSecrets(config)).toEqual(config);
  });

  it('leaves values that are not URLs alone, including SQL that looks like one', () => {
    const config = {
      query: 'SELECT * FROM orders WHERE updated_at > ?',
      watermarkColumn: 'updated_at',
      path: '/var/data/orders.csv',
      limit: 500,
      records: [{ a: 1 }],
    };
    expect(redactConfigSecrets(config)).toEqual(config);
  });

  it('redacts every key that carries one, not only `url`', () => {
    // A second connection string under any name is the same disclosure.
    const redacted = redactConfigSecrets({
      url: 'postgres://a:one@primary/db',
      replicaUrl: 'postgres://a:two@replica/db',
    });
    expect(String(redacted.url)).not.toContain('one');
    expect(String(redacted.replicaUrl)).not.toContain('two');
  });

  it('does not mutate what it was given', () => {
    // It redacts a row the store just read; on a store that caches, mutating it
    // would take the password away from the runner that is about to connect.
    const config = { url: 'postgres://ana:s3cr3t@db/app' };
    redactConfigSecrets(config);
    expect(config.url).toBe('postgres://ana:s3cr3t@db/app');
  });

  it('is idempotent, so a value can survive any number of round trips', () => {
    const once = redactConfigSecrets({ url: 'postgres://ana:s3cr3t@db/app' });
    expect(redactConfigSecrets(once)).toEqual(once);
  });
});

describe('restoreRedactedSecrets', () => {
  const stored = { url: 'postgres://ana:s3cr3t@db.internal:5432/app', query: 'SELECT 1' };

  // The classic way this fix corrupts data: read a connector, rename it, post
  // the whole object back, and the placeholder lands in the database as the
  // real password. The connector then fails to connect and nothing says why.
  it('puts the real password back when the caller returned the placeholder', () => {
    const shown = redactConfigSecrets(stored);
    const restored = restoreRedactedSecrets({ ...shown, query: 'SELECT 2' }, stored);
    expect(restored.url).toBe(stored.url);
    expect(restored.query).toBe('SELECT 2');
  });

  it('lets a genuinely new URL through, so the store can refuse it', () => {
    const restored = restoreRedactedSecrets(
      { url: 'postgres://ana:different@db.internal:5432/app' },
      stored,
    );
    expect(restored.url).toBe('postgres://ana:different@db.internal:5432/app');
  });

  // Not "contains REDACTED": somebody re-pointing a connector at another host
  // is making a real edit even if the password they typed happens to be the
  // sentinel, and it must reach the store's refusal rather than silently
  // keeping the old server's credential.
  it('does not treat the sentinel under a different host as unchanged', () => {
    const restored = restoreRedactedSecrets(
      { url: `postgres://ana:${REDACTED_SECRET}@elsewhere:5432/app` },
      stored,
    );
    expect(restored.url).toBe(`postgres://ana:${REDACTED_SECRET}@elsewhere:5432/app`);
  });

  it('has nothing to restore for a connector that does not exist yet', () => {
    const incoming = { url: `postgres://ana:${REDACTED_SECRET}@db.internal:5432/app` };
    expect(restoreRedactedSecrets(incoming, undefined)).toEqual(incoming);
  });

  it('leaves keys the stored config never had', () => {
    expect(restoreRedactedSecrets({ extra: 'kept' }, stored).extra).toBe('kept');
  });

  it('does not mutate the incoming body', () => {
    const incoming = redactConfigSecrets(stored);
    restoreRedactedSecrets(incoming, stored);
    expect(incoming.url).toBe(`postgres://ana:${REDACTED_SECRET}@db.internal:5432/app`);
  });
});

describe('carriesUrlPassword', () => {
  it('is true only when there is a password to carry', () => {
    expect(carriesUrlPassword('postgres://ana:s3cr3t@db/app')).toBe(true);
    // A username alone is an address, not a credential.
    expect(carriesUrlPassword('postgres://ana@db/app')).toBe(false);
    expect(carriesUrlPassword('https://api.example.com/v1')).toBe(false);
    expect(carriesUrlPassword('SELECT * FROM orders')).toBe(false);
  });
});
