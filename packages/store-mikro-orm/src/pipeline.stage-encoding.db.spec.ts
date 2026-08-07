import { encodeStageRows, renameStagePayload } from '@dudousxd/nestjs-catalog';
import type { StartedMySqlContainer } from '@testcontainers/mysql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CatalogDatabase, openCatalogDatabase, startMySql } from '../test/mysql-harness';
import { WorkflowStageRow } from './entities/pipeline';
import { MySqlPipelineStore } from './pipeline.store';

/**
 * The staged batch, through a real MySQL `JSON` column.
 *
 * Against an engine rather than a stub, because two of the three things this
 * change rests on are facts about the engine and not about the code:
 *
 * 1. A `JSON` column takes an object as readily as an array, so the ~16,233
 *    batches already staged in the deployment need no migration and the new
 *    ones need no new column.
 * 2. A `JSON` column **sorts an object's members** in its binary form — by key
 *    length, then bytes — so the old encoding never round-tripped key order,
 *    and the new one does only because its names live in an array. Asserted
 *    here rather than believed, since the whole "key order must not change what
 *    a sink produces" question was answered by measuring this.
 *
 * The third — that a batch written by the previous build still reads — is
 * tested by writing the old shape with raw SQL, which is the only way to
 * produce it now that `writeStage` cannot.
 */

let container: StartedMySqlContainer;
let db: CatalogDatabase;
let stages: MySqlPipelineStore;

beforeAll(async () => {
  container = await startMySql();
  db = await openCatalogDatabase(container, 'stage_encoding');
  stages = new MySqlPipelineStore(db.em);
}, 300_000);

afterAll(async () => {
  await db?.close();
  await container?.stop();
});

/** The exact statement the previous `writeStage` produced: rows as a JSON array. */
async function stageRowOriented(
  runId: string,
  nodeId: string,
  batch: number,
  rows: Array<Record<string, unknown>>,
): Promise<void> {
  const em = db.em.fork();
  await em
    .getConnection()
    .execute(
      'INSERT INTO `catalog_workflow_stage` (`id`,`run_id`,`node_id`,`batch`,`rows`,`row_count`,`created_at`) VALUES (?,?,?,?,?,?,NOW())',
      [`${runId}#${nodeId}#${batch}`, runId, nodeId, batch, JSON.stringify(rows), rows.length],
    );
}

async function storedText(id: string): Promise<string> {
  const em = db.em.fork();
  const back: unknown = await em
    .getConnection()
    .execute('SELECT CAST(`rows` AS CHAR) AS `raw` FROM `catalog_workflow_stage` WHERE `id` = ?', [
      id,
    ]);
  if (!Array.isArray(back)) throw new Error('Expected rows back.');
  const first: unknown = back[0];
  if (first === null || typeof first !== 'object') throw new Error('Expected a row back.');
  const raw: unknown = Reflect.get(first, 'raw');
  if (typeof raw !== 'string') throw new Error('Expected `rows` to cast to text.');
  return raw;
}

describe('a staged batch through a real JSON column', () => {
  it('round-trips through writeStage and readStage', async () => {
    const rows: Array<Record<string, unknown>> = [
      { id: 1, name: 'first', tags: ['a', 'b'], nested: { deep: true } },
      { id: 2, name: null, tags: [], nested: null },
    ];

    await stages.writeStage({ runId: 'r1', nodeId: 'source', batch: 1, rows });

    expect(await stages.readStage({ runId: 'r1', nodeId: 'source', batch: 1 })).toEqual(rows);
  });

  it('stores the names once, not once per row', async () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({
      Sub_Work_Order_Id: `SWO-${index}`,
      Customer_E_Mail_Address: `p${index}@example.mil`,
    }));

    await stages.writeStage({ runId: 'r2', nodeId: 'source', batch: 1, rows });

    const stored = await storedText('r2#source#1');
    expect(stored.split('Customer_E_Mail_Address').length - 1).toBe(1);
    // What the previous encoding would have cost, for the same rows.
    expect(stored.length).toBeLessThan(JSON.stringify(rows).length * 0.6);
  });

  it('keeps a row that lacks a key apart from one whose key is null', async () => {
    const rows: Array<Record<string, unknown>> = [{ id: 1, note: null }, { id: 2 }];

    await stages.writeStage({ runId: 'r3', nodeId: 'source', batch: 1, rows });
    const back = await stages.readStage({ runId: 'r3', nodeId: 'source', batch: 1 });

    expect('note' in (back[0] ?? {})).toBe(true);
    expect(back[0]?.note).toBeNull();
    expect('note' in (back[1] ?? {})).toBe(false);
  });

  it('brings key order back the way the node emitted it', async () => {
    // Chosen so MySQL's member sort (length, then bytes) is visibly not this.
    const rows: Array<Record<string, unknown>> = [{ zebra: 1, a: 2, Middle_Name: 3, b: 4 }];

    await stages.writeStage({ runId: 'r4', nodeId: 'source', batch: 1, rows });
    const back = await stages.readStage({ runId: 'r4', nodeId: 'source', batch: 1 });

    expect(Object.keys(back[0] ?? {})).toEqual(['zebra', 'a', 'Middle_Name', 'b']);
  });

  it('is the engine, not the code, that used to reorder those keys', async () => {
    // The measurement the claim above rests on. If MySQL ever stops sorting
    // object members, this fails and the comment beside it is wrong.
    await stageRowOriented('r5', 'source', 1, [{ zebra: 1, a: 2, Middle_Name: 3, b: 4 }]);

    const stored = await storedText('r5#source#1');

    expect(stored).toBe('[{"a": 2, "b": 4, "zebra": 1, "Middle_Name": 3}]');
  });
});

describe('batches staged by the previous build', () => {
  it('still read, absent keys and all', async () => {
    // What the ~16,233 rows in the deployment look like. A run in flight when
    // this ships resumes onto exactly these.
    await stageRowOriented('legacy', 'source', 1, [
      { id: 1, note: null },
      { id: 2 },
      { id: 3, note: 'here' },
    ]);

    const back = await stages.readStage({ runId: 'legacy', nodeId: 'source', batch: 1 });

    expect(back).toEqual([{ id: 1, note: null }, { id: 2 }, { id: 3, note: 'here' }]);
    expect('note' in (back[1] ?? {})).toBe(false);
  });

  it('are replaced in place when the same batch is re-staged', async () => {
    // The resume case that matters: a durable step retried after this build
    // ships re-sends batch 1 over a row the previous build wrote. The key is
    // derived, so it must overwrite — and the encoding must flip with it rather
    // than leaving half a batch behind.
    await stageRowOriented('mixed', 'source', 1, [{ id: 'old' }]);

    await stages.writeStage({
      runId: 'mixed',
      nodeId: 'source',
      batch: 1,
      rows: [{ id: 'new' }],
    });

    const em = db.em.fork();
    const count = await em.count(WorkflowStageRow, { runId: 'mixed' });
    expect(count).toBe(1);
    expect(await stages.readStage({ runId: 'mixed', nodeId: 'source', batch: 1 })).toEqual([
      { id: 'new' },
    ]);
  });

  it('read alongside new ones in the same run', async () => {
    // A run half-staged by the old build and half by the new: `readInputs`
    // walks `1..batches` and must not care which encoding each one is.
    await stageRowOriented('split', 'source', 1, [{ id: 1 }]);
    await stages.writeStage({ runId: 'split', nodeId: 'source', batch: 2, rows: [{ id: 2 }] });

    const first = await stages.readStage({ runId: 'split', nodeId: 'source', batch: 1 });
    const second = await stages.readStage({ runId: 'split', nodeId: 'source', batch: 2 });

    expect([...first, ...second]).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('hands the batch back undecoded, and takes one back the same way', async () => {
    // The pair the `rename` node reads through. Against a real column because
    // the point of it is what MySQL does with the value: `writeStagePayload`
    // binds an object that never became a row record here, and
    // `readStagePayload` hands back whatever the driver decoded — so a rename
    // that rewrote only `shapes` has to survive the round trip through the
    // engine, not merely through the codec.
    const rows: Array<Record<string, unknown>> = [
      { 'Mgmt Cd': 'AF', 'Reg Number': '01-1234' },
      { 'Mgmt Cd': null, 'Reg Number': '02-9876' },
    ];
    await stages.writeStage({ runId: 'payload', nodeId: 'source', batch: 1, rows });

    const stored = await stages.readStagePayload({
      runId: 'payload',
      nodeId: 'source',
      batch: 1,
    });
    const renamed = renameStagePayload(stored, {
      columns: new Map([['Mgmt Cd', 'mgmtCd']]),
      dropUnnamed: false,
    });
    expect(renamed.metadataOnly).toBe(true);

    await stages.writeStagePayload({
      runId: 'payload',
      nodeId: 'head',
      batch: 1,
      payload: renamed.payload,
      rows: renamed.rows,
    });

    // Read back through the ordinary reader, because that is what a sink uses:
    // the fast path must not produce a batch only the fast path can read.
    expect(await stages.readStage({ runId: 'payload', nodeId: 'head', batch: 1 })).toEqual([
      { mgmtCd: 'AF', 'Reg Number': '01-1234' },
      { mgmtCd: null, 'Reg Number': '02-9876' },
    ]);
  });

  it('answers undefined for a payload that was never staged', async () => {
    // `readStage` can honestly say "no rows"; a payload reader cannot invent an
    // encoding for a batch that does not exist, and the rename node branches on
    // the difference to write an empty batch rather than a renamed nothing.
    expect(
      await stages.readStagePayload({ runId: 'payload', nodeId: 'source', batch: 99 }),
    ).toBeUndefined();
  });

  it('replaces a payload in place when the same batch is re-staged', async () => {
    // The idempotence `writeStage` promises, through the other door: a retried
    // rename writes the same batch numbers over the same stage and each one has
    // to replace itself rather than double the node's output.
    const first = encodeStageRows([{ a: 1 }]);
    const second = encodeStageRows([{ a: 2 }, { a: 3 }]);
    for (const payload of [first, second]) {
      await stages.writeStagePayload({
        runId: 'retry',
        nodeId: 'head',
        batch: 1,
        payload,
        rows: payload.shapeOf.length,
      });
    }

    expect(await stages.readStage({ runId: 'retry', nodeId: 'head', batch: 1 })).toEqual([
      { a: 2 },
      { a: 3 },
    ]);
  });

  it('an emptied stale batch still reads as no rows', async () => {
    // `WorkflowRunnerService.stage` clears a longer previous attempt's tail by
    // writing `[]`. Under the old encoding that is a JSON array; under the new
    // one it is a batch with no rows. Both have to mean "stop here".
    await stageRowOriented('tail', 'source', 9, []);
    await stages.writeStage({ runId: 'tail', nodeId: 'source', batch: 10, rows: [] });

    expect(await stages.readStage({ runId: 'tail', nodeId: 'source', batch: 9 })).toEqual([]);
    expect(await stages.readStage({ runId: 'tail', nodeId: 'source', batch: 10 })).toEqual([]);
  });
});
