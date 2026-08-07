import 'reflect-metadata';
import type { EntityManager } from '@mikro-orm/sql';
import { describe, expect, it, vi } from 'vitest';
import { runReadOnlyQuery } from './query';

/**
 * What the query console leaves behind on the connection it borrowed.
 *
 * This package is mounted inside a host application, and with no `contextName`
 * configured `catalogConnectionProviders` binds it to the HOST's
 * `EntityManager` — the same pool the host runs its own work on. So anything
 * this sets at SESSION scope is not scoped to the catalog at all: it rides on a
 * pooled connection and applies to whoever borrows it next.
 *
 * That is what `SET SESSION MAX_EXECUTION_TIME` did. Measured against MySQL
 * 8.0: after one query, a *different* `em.fork()` read the value back, because
 * the pool handed it the same physical connection. The host's next statement on
 * that connection inherits a fifteen-second timeout it never asked for, cannot
 * see, and will experience as an intermittent query failure somewhere else
 * entirely.
 *
 * The replacement is a per-statement optimizer hint, which has the same teeth —
 * both interrupt a runaway cross join at 1.00 s — and leaves the session
 * untouched. `stored-registry.freshness.db.spec.ts`'s sibling
 * `zz` benches confirmed both halves against the real engine; these cases hold
 * the line in the default suite, where a fake connection is enough because the
 * claim is about which statements are ISSUED.
 */

/** An EntityManager that records every statement the function runs. */
function emRecording(rows: Array<Record<string, unknown>> = []) {
  const execute = vi.fn(async (sql: string) => {
    if (/^\s*SELECT/i.test(sql)) return rows;
    return [];
  });
  const em: EntityManager = Object.create(null);
  return {
    em: Object.assign(em, { getConnection: () => ({ execute }) }),
    statements: () => execute.mock.calls.map((call) => call[0]),
  };
}

describe('a read-only query leaves no state on the connection it borrowed', () => {
  it('bounds the statement with a hint, not with a session variable', async () => {
    const recorder = emRecording([{ n: 1 }]);

    await runReadOnlyQuery(recorder.em, { sql: 'SELECT 1', timeoutMs: 5_000 });

    const statements = recorder.statements();
    // THE case. A `SET SESSION` here is the bug: it outlives the request on a
    // pooled connection the host also uses.
    expect(statements.filter((sql) => /SET\s+SESSION/i.test(sql))).toHaveLength(0);
    expect(statements.some((sql) => /MAX_EXECUTION_TIME\(5000\)/.test(sql))).toBe(true);
  });

  it('attaches the hint to its own wrapper, never to the supplied statement', async () => {
    const recorder = emRecording([]);

    await runReadOnlyQuery(recorder.em, {
      sql: 'WITH t AS (SELECT 1 AS n) SELECT * FROM t',
      timeoutMs: 9_000,
    });

    const query = recorder.statements().find((sql) => /MAX_EXECUTION_TIME/.test(sql)) ?? '';
    // The hint sits on the outer SELECT this function writes. Rewriting the
    // caller's text would break a statement starting with `WITH`, where a hint
    // is not legal in that position.
    expect(query.startsWith('SELECT /*+ MAX_EXECUTION_TIME(9000) */ * FROM (')).toBe(true);
    expect(query).toContain('WITH t AS (SELECT 1 AS n) SELECT * FROM t');
  });

  it('floors the budget at a second, as the session form did', async () => {
    const recorder = emRecording([]);

    await runReadOnlyQuery(recorder.em, { sql: 'SELECT 1', timeoutMs: 5 });

    expect(recorder.statements().some((sql) => /MAX_EXECUTION_TIME\(1000\)/.test(sql))).toBe(true);
  });

  it('still opens and rolls back the read-only transaction', async () => {
    // The safety guarantee is unchanged and must stay that way — the timeout
    // fix must not have quietly dropped the transaction that makes the screen
    // safe to expose. Verified against MySQL 8.0 separately: an INSERT between
    // these two is refused, sequentially and under concurrency.
    const recorder = emRecording([]);

    await runReadOnlyQuery(recorder.em, { sql: 'SELECT 1' });

    const statements = recorder.statements();
    expect(statements[0]).toBe('START TRANSACTION READ ONLY');
    expect(statements.at(-1)).toBe('ROLLBACK');
  });

  it('rolls back even when the statement fails', async () => {
    const execute = vi.fn(async (sql: string) => {
      if (/MAX_EXECUTION_TIME/.test(sql)) throw new Error('Unknown column');
      return [];
    });
    const em: EntityManager = Object.create(null);
    Object.assign(em, { getConnection: () => ({ execute }) });

    await expect(runReadOnlyQuery(em, { sql: 'SELECT nope' })).rejects.toThrow('Unknown column');
    // A transaction left open holds InnoDB row locks and a read view on a
    // connection the host will borrow back.
    expect(execute.mock.calls.map((call) => call[0]).at(-1)).toBe('ROLLBACK');
  });
});
