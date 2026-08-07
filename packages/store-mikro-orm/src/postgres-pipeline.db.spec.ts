import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type PostgresCatalogDatabase,
  openPostgresCatalogDatabase,
  startPostgres,
} from '../test/postgres-harness';
import { MySqlPipelineStore } from './pipeline.store';

/**
 * The pipeline store on PostgreSQL, and specifically the one statement in it
 * that is not an ordinary entity write.
 *
 * **Why this file is short.** The pipeline store reaches its tables through
 * MikroORM's entity API rather than by writing SQL, so almost all of it is
 * portable by construction and re-testing it per engine would be testing
 * MikroORM. The exception is `writeStage`, which goes through the query
 * builder's `.onConflict('id').merge([...])` — a construct that compiles to
 * genuinely different SQL on the two engines (`ON DUPLICATE KEY UPDATE` against
 * `ON CONFLICT … DO UPDATE SET … EXCLUDED`), and one whose correctness the
 * durable engine depends on: a retried step re-sends every batch, and "replace,
 * not append" is what stops a retry doubling the data.
 *
 * That was worth checking rather than assuming, because the failure would not be
 * an error. A merge that silently inserted a second row, or that wrote the
 * `rows` column as `[object Object]` — which is the bug the field-name form of
 * `.merge()` already exists to avoid on MySQL — produces a run that finishes
 * green and a dataset that is wrong.
 *
 * `MySqlPipelineStore` is the class under test and the name is now a misnomer;
 * it is kept because it is what every host, module and existing test constructs
 * by name, and renaming a published class to fix a comment is not a trade worth
 * making in a 0.x minor.
 */

let container: StartedPostgreSqlContainer;
let db: PostgresCatalogDatabase;
let stages: MySqlPipelineStore;

beforeAll(async () => {
  container = await startPostgres();
  db = await openPostgresCatalogDatabase(container, 'stage_pg');
  stages = new MySqlPipelineStore(db.em);
}, 300_000);

afterAll(async () => {
  await db?.close();
  await container?.stop();
});

describe('the pipeline store on Postgres', () => {
  it('creates its tables with jsonb, which is what keeps the two engines agreeing', async () => {
    // Not a preference — a consequence. MikroORM's Postgres platform maps
    // `@Property({ type: 'json' })` to `jsonb` on its own, and `jsonb`
    // normalises an object's key order exactly as MySQL's `JSON` binary form
    // does. Postgres's `json` would have preserved input order instead, which
    // sounds better and would have made the *Postgres* store the odd one out:
    // a caller would gain a fidelity guarantee on one engine and lose it on
    // migrating. See `dialect.ts` for the measured cost of the choice.
    const columns = await db.execute(
      `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_name = 'catalog_workflow_stage' AND column_name = 'rows'`,
    );
    expect(JSON.stringify(columns)).toContain('jsonb');
  });

  it('replaces a re-sent batch rather than appending it', async () => {
    // The guarantee the durable engine leans on, asserted against the engine
    // rather than against the query builder's intent.
    const first = await stages.writeStage({
      runId: 'run-1',
      nodeId: 'node-1',
      batch: 0,
      rows: [{ id: 'a', label: 'first' }],
    });
    expect(first.written).toBe(1);

    const retried = await stages.writeStage({
      runId: 'run-1',
      nodeId: 'node-1',
      batch: 0,
      rows: [
        { id: 'a', label: 'second' },
        { id: 'b', label: 'new' },
      ],
    });
    expect(retried.written).toBe(2);

    // One row in the table, holding the second attempt. Two rows would mean the
    // conflict clause did not fire; the first attempt's payload would mean it
    // fired and merged nothing.
    const stored = await db.execute(
      `SELECT COUNT(*) AS n FROM "catalog_workflow_stage" WHERE "run_id" = 'run-1'`,
    );
    expect(JSON.stringify(stored)).toContain('"1"');

    const read = await stages.readStage({ runId: 'run-1', nodeId: 'node-1', batch: 0 });
    expect(read).toEqual([
      { id: 'a', label: 'second' },
      { id: 'b', label: 'new' },
    ]);
  });

  it('stores the columnar payload as JSON rather than as [object Object]', async () => {
    // The specific corruption `.merge(['rows'])` — the field-name form — exists
    // to avoid: given values rather than names, the builder binds the object a
    // second time and a JSON column receives the string `[object Object]`. It
    // was found on MySQL; nothing said it could not happen differently here, so
    // it is pinned on both.
    await stages.writeStage({
      runId: 'run-2',
      nodeId: 'node-1',
      batch: 0,
      rows: [{ zebra: 1, a: 2, Middle_Name: 3 }],
    });
    const raw = await db.execute(
      `SELECT "rows"::text AS payload FROM "catalog_workflow_stage" WHERE "run_id" = 'run-2'`,
    );
    const payload = JSON.stringify(raw);
    expect(payload).not.toContain('object Object');
    expect(payload).toContain('columnar');

    // And the key order the columnar encoding promises survives, because the
    // names ride in a JSON *array* and arrays keep their order under `jsonb`.
    // The same batch written as a bare object would have come back sorted.
    const [row] = await stages.readStage({ runId: 'run-2', nodeId: 'node-1', batch: 0 });
    expect(Object.keys(row ?? {})).toEqual(['zebra', 'a', 'Middle_Name']);
  });

  it('keeps batches of one run separate from another, so a retry replaces only its own', async () => {
    await stages.writeStage({
      runId: 'run-3',
      nodeId: 'node-1',
      batch: 0,
      rows: [{ id: 'x' }],
    });
    await stages.writeStage({
      runId: 'run-3',
      nodeId: 'node-1',
      batch: 1,
      rows: [{ id: 'y' }],
    });
    await stages.writeStage({
      runId: 'run-3',
      nodeId: 'node-1',
      batch: 0,
      rows: [{ id: 'x2' }],
    });

    expect(await stages.readStage({ runId: 'run-3', nodeId: 'node-1', batch: 0 })).toEqual([
      { id: 'x2' },
    ]);
    // Untouched, which is the half a too-broad conflict target would break.
    expect(await stages.readStage({ runId: 'run-3', nodeId: 'node-1', batch: 1 })).toEqual([
      { id: 'y' },
    ]);
  });
});
