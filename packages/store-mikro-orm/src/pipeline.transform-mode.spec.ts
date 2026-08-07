import type { EntityManager } from '@mikro-orm/sql';
import { describe, expect, it } from 'vitest';
import { TransformRow } from './entities/pipeline';
import { MySqlPipelineStore } from './pipeline.store';

/**
 * A transform whose mode was never chosen, read back.
 *
 * **The column is nullable, so absent arrives as SQL NULL and not as
 * `undefined`.** `TransformRow.mode` is declared `mode?: string`, which is what
 * TypeScript sees, but nothing in the type system makes the driver agree: a row
 * whose column holds NULL hydrates with `null`. The read path used to spell the
 * absent case `row.mode === undefined`, so the `null` fell through to `narrow`
 * and was refused as
 *
 *   Transform mode "null" on t-1 is not one this build knows about.
 *   It was most likely written by a newer version of the catalog.
 *
 * — an error blaming the data for being newer than the build when the value is
 * simply not there. It is not an upgrade-only hazard either, which is what makes
 * it worth a file of its own: `saveTransform` writes NULL for every transform
 * created without a mode, which is what `POST /pipeline/transforms` does by
 * default, so a catalog created this morning reproduces it on the next read.
 * `listTransforms` maps every row, so one such row failed the whole list route,
 * and every workflow run whose transform node pointed at one failed with it.
 *
 * Kept out of `*.db.spec.ts` on purpose: the rule is a branch in the row-to-DTO
 * mapping, and what a database contributes is only the `null` the fixtures below
 * hand over directly. The engine's half — that an unset nullable column really
 * does come back as `null` — is asserted against a real Postgres in
 * `postgres-pipeline.db.spec.ts`, so neither half rests on the other's belief.
 */
function entityManager(rows: TransformRow[]): EntityManager {
  const fake = {
    fork: () => fake,
    find: () => Promise.resolve(rows),
    findOne: (_entity: unknown, where: { id: string }) =>
      Promise.resolve(rows.find((row) => row.id === where.id) ?? null),
  };
  // Not a type assertion: `Object.create(null)` is `any`, so the merged value
  // is too, and the declared return type is what narrows it back down.
  return Object.assign(Object.create(null), fake);
}

/**
 * One stored transform, with `mode` set to whatever the driver would hand back.
 *
 * `Object.assign` rather than `row.mode = …` because `null` is precisely the
 * value the declared type does not admit and this defect is precisely about
 * that gap. Writing it any other way would need a cast, and a cast here would be
 * the test agreeing with the bug.
 */
function storedTransform(mode: string | null | undefined): TransformRow {
  const row = new TransformRow();
  row.id = 't-1';
  row.name = 'rename';
  row.language = 'javascript';
  row.code = 'return records;';
  row.version = 1;
  row.createdBy = 'ana';
  row.createdAt = new Date('2020-01-01T00:00:00.000Z');
  row.updatedAt = new Date('2020-01-01T00:00:00.000Z');
  return Object.assign(row, { mode });
}

describe('reading a transform whose mode was never set', () => {
  it('reads a NULL mode as absent rather than refusing the row', async () => {
    const store = new MySqlPipelineStore(entityManager([storedTransform(null)]));

    const transform = await store.getTransform('t-1');

    // Absent stays absent: the `'batch'` default belongs to `transformMode` and
    // resolving it here would be a second copy of the rule.
    expect(transform?.mode).toBeUndefined();
  });

  it('does not fail the list route because one row has no mode', async () => {
    // The shipped symptom, and the reason this is release-blocking rather than
    // cosmetic: `listTransforms` maps every row, so one NULL 500s
    // `GET /pipeline/transforms` for every transform in the catalog.
    const store = new MySqlPipelineStore(
      entityManager([storedTransform(null), storedTransform('record')]),
    );

    const transforms = await store.listTransforms();

    expect(transforms.map((transform) => transform.mode)).toEqual([undefined, 'record']);
  });

  it('still reads an `undefined` mode as absent, for a row that predates the column', async () => {
    const store = new MySqlPipelineStore(entityManager([storedTransform(undefined)]));

    expect((await store.getTransform('t-1'))?.mode).toBeUndefined();
  });

  it('still refuses a mode that is a value this build does not know', async () => {
    // The loud refusal is correct and must survive the fix. An unrecognised
    // *value* means the data was written by a newer catalog, and answering with
    // a different mode would change what the load computes while looking fine.
    const store = new MySqlPipelineStore(entityManager([storedTransform('streaming')]));

    await expect(store.getTransform('t-1')).rejects.toThrow(
      /Transform mode "streaming" on t-1 is not one this build knows about/,
    );
  });
});
