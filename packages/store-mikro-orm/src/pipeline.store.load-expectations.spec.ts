import type { StoredLoadExpectation } from '@dudousxd/nestjs-catalog';
import type { EntityManager } from '@mikro-orm/sql';
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { LoadExpectationRow } from './entities/pipeline';
import { MySqlPipelineStore } from './pipeline.store';

/**
 * The stored layer of the load policy: what an operator set, who set it, when.
 *
 * Stubbed rather than run against MySQL, on the same reasoning as
 * `pipeline.store.spec.ts` next door: everything under test here is what this
 * store does to a value on the way in and on the way out of a JSON column, and
 * booting a container to prove it would make a check that runs on every save
 * depend on Docker. The one thing a stub cannot answer — that MySQL accepts the
 * column — is answered by `mysql-warehouse.db.spec.ts`'s sibling suite and by
 * the table being created from the same metadata this file's entity declares.
 *
 * What the cases below are actually about:
 *
 *  - **The numbers survive.** A `maxShrink` of `0.5` and a `withinMs` of thirty
 *    days are the two values this table would have silently ruined if the policy
 *    had been split into `int` columns — `0.5` truncates to `0`, which refuses a
 *    load for losing a single row, and thirty days is 2,592,000,000, past what a
 *    signed INT holds. They are asserted exactly, by value.
 *  - **Attribution is not optional and is not the caller's to claim.**
 *  - **A row that cannot be read back is never written.** The alternative is a
 *    save that returns 200 and a load that is refused for want of the
 *    declaration the console is displaying.
 */

/** Everything the four methods actually touch, and nothing they do not. */
function entityManager(rows: LoadExpectationRow[]): {
  em: EntityManager;
  stored: LoadExpectationRow[];
  finds: Array<Record<string, unknown>>;
  deletes: Array<Record<string, unknown>>;
} {
  const stored = [...rows];
  const finds: Array<Record<string, unknown>> = [];
  const deletes: Array<Record<string, unknown>> = [];
  let pending: LoadExpectationRow[] = [];

  const fake = {
    fork: () => fake,
    find: (entity: unknown, where: unknown, options: Record<string, unknown>) => {
      if (entity !== LoadExpectationRow) throw new Error('These tests exercise no other entity.');
      finds.push(options);
      return Promise.resolve([...stored]);
    },
    findOne: (entity: unknown, where: { typeName?: string }) => {
      if (entity !== LoadExpectationRow) throw new Error('These tests exercise no other entity.');
      return Promise.resolve(stored.find((row) => row.typeName === where.typeName) ?? null);
    },
    create: (_entity: unknown, data: Partial<LoadExpectationRow>) =>
      Object.assign(new LoadExpectationRow(), data),
    persist: (row: LoadExpectationRow) => {
      pending.push(row);
    },
    flush: () => {
      for (const row of pending) {
        if (!stored.includes(row)) stored.push(row);
      }
      pending = [];
      return Promise.resolve();
    },
    nativeDelete: (entity: unknown, where: { typeName?: string }) => {
      if (entity !== LoadExpectationRow) throw new Error('These tests exercise no other entity.');
      deletes.push(where);
      const before = stored.length;
      for (let index = stored.length - 1; index >= 0; index -= 1) {
        if (stored[index]?.typeName === where.typeName) stored.splice(index, 1);
      }
      return Promise.resolve(before - stored.length);
    },
  };

  // Not a type assertion: `Object.create(null)` is `any`, so the merged value is
  // too, and the declared return type is what narrows it back down.
  return { em: Object.assign(Object.create(null), fake), stored, finds, deletes };
}

function storedRow(
  typeName: string,
  fields: Partial<Pick<LoadExpectationRow, 'deletes' | 'rowCount' | 'setBy' | 'setByActor'>> = {},
): LoadExpectationRow {
  const row = new LoadExpectationRow();
  row.typeName = typeName;
  row.setBy = fields.setBy ?? 'catalog-console';
  row.setByActor = fields.setByActor;
  row.deletes = fields.deletes;
  row.rowCount = fields.rowCount;
  row.setAt = new Date('2026-03-04T10:00:00.000Z');
  return row;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Shapes that a typed caller cannot produce and an HTTP body can.
 *
 * The narrowing is what is under test, so these have to arrive the way an
 * untyped caller's would rather than as something the compiler already
 * approved.
 */
const UNREADABLE: Array<[string, Record<string, unknown>]> = [
  ['a strategy outside the three', { strategy: 'tombstones', because: 'from a change feed' }],
  ['a periodic reload with no interval', { strategy: 'periodic-full-reload', because: 'nightly' }],
  [
    'a periodic reload whose interval is not a number',
    { strategy: 'periodic-full-reload', because: 'nightly', withinMs: 'one day' },
  ],
  ['no reason at all', { strategy: 'accepted' }],
];

/**
 * `Object.create(null)` is `any`, so the merged value is too, and the declared
 * return type is what narrows it back down — the same idiom the stub above uses,
 * and deliberately not a type assertion.
 */
function untypedExpectation(
  deletes: Record<string, unknown>,
): Pick<StoredLoadExpectation, 'deletes' | 'rowCount'> {
  return Object.assign(Object.create(null), { deletes });
}

describe('saveLoadExpectation', () => {
  it('keeps a fractional shrink bound and a month-long interval exactly', async () => {
    // The whole reason this table holds JSON. `0.5` in an int column is `0` — a
    // bound that refuses a load for losing one row — and 2,592,000,000 is past
    // the 2,147,483,647 a signed INT holds, so the interval would either be
    // rejected or silently become 24.8 days and start refusing loads early.
    const { em, stored } = entityManager([]);
    const store = new MySqlPipelineStore(em);

    const saved = await store.saveLoadExpectation(
      'Employee',
      {
        deletes: {
          strategy: 'periodic-full-reload',
          because: 'HR truncates and reloads the extract every month.',
          withinMs: THIRTY_DAYS_MS,
        },
        rowCount: { maxShrink: 0.5, maxGrowth: 10, minRows: 100 },
      },
      'catalog-console',
    );

    expect(saved.deletes).toEqual({
      strategy: 'periodic-full-reload',
      because: 'HR truncates and reloads the extract every month.',
      withinMs: 2_592_000_000,
    });
    expect(saved.rowCount).toEqual({ maxShrink: 0.5, maxGrowth: 10, minRows: 100 });
    // And in the column, not merely in the answer: a store that returned its
    // input and persisted something else would pass on the two lines above.
    expect(stored[0]?.deletes?.withinMs).toBe(2_592_000_000);
    expect(stored[0]?.rowCount?.maxShrink).toBe(0.5);
  });

  it('records the principal, the actor behind it, and its own clock', async () => {
    const { em, stored } = entityManager([]);
    const store = new MySqlPipelineStore(em);
    const before = Date.now();

    const saved = await store.saveLoadExpectation(
      'Mvr',
      { deletes: { strategy: 'accepted', because: 'Append-only ledger; rows are never removed.' } },
      'catalog-console',
      'ana@example.com',
    );

    expect(saved.setBy).toBe('catalog-console');
    // The audit's real subject. A principal is a key that a whole console shares;
    // this is the person who decided that Mvr may accumulate deleted rows, and
    // dropping it is a save that still succeeds and still looks right.
    expect(saved.setByActor).toBe('ana@example.com');
    expect(stored[0]?.setByActor).toBe('ana@example.com');
    // ISO 8601 on the way out, and taken from this process rather than from the
    // caller — there is no argument for it, and there must not be one.
    expect(Date.parse(saved.setAt)).toBeGreaterThanOrEqual(before);
    expect(saved.setAt).toBe(new Date(saved.setAt).toISOString());
  });

  it('overwrites the row for a type rather than adding a second answer', async () => {
    const { em, stored } = entityManager([
      storedRow('Mvr', {
        deletes: { strategy: 'accepted', because: 'first' },
        setBy: 'catalog-console',
        setByActor: 'ana@example.com',
      }),
    ]);
    const store = new MySqlPipelineStore(em);

    const saved = await store.saveLoadExpectation(
      'Mvr',
      { deletes: { strategy: 'soft-deleted-at-source', because: 'second', column: 'deleted_at' } },
      'catalog-console',
      'bruno@example.com',
    );

    expect(stored).toHaveLength(1);
    expect(saved.deletes).toEqual({
      strategy: 'soft-deleted-at-source',
      because: 'second',
      column: 'deleted_at',
    });
    // Re-affirming a policy re-attributes it: the person accountable for the
    // decision that is standing now is the one who last stood behind it.
    expect(saved.setByActor).toBe('bruno@example.com');
  });

  it('clears the half the caller did not send, rather than merging into the old row', async () => {
    // A PUT of the whole expectation, not a patch of one field. The alternative
    // — leaving the previous `deletes` in place because this save said nothing
    // about it — is an operator removing a strategy and being told it worked.
    const { em, stored } = entityManager([
      storedRow('Mvr', {
        deletes: { strategy: 'accepted', because: 'was here' },
        rowCount: { maxShrink: 0.9 },
      }),
    ]);
    const store = new MySqlPipelineStore(em);

    const saved = await store.saveLoadExpectation('Mvr', { rowCount: { maxShrink: 0.8 } }, 'app-b');

    expect(saved.deletes).toBeUndefined();
    expect(stored[0]?.deletes).toBeUndefined();
    expect(saved.rowCount).toEqual({ maxShrink: 0.8 });
  });

  it.each(UNREADABLE)(
    'refuses %s rather than storing a row it cannot read back',
    async (_why, deletes) => {
      // Structural, not the operator-facing validation — the 400s that name a
      // field live on the controller. What this refuses is the one shape whose
      // failure is invisible from every side: stored happily, read back as
      // "nothing was declared", and the load refused while the console shows a
      // policy.
      const { em, stored } = entityManager([]);
      const store = new MySqlPipelineStore(em);

      await expect(
        store.saveLoadExpectation('Employee', untypedExpectation(deletes), 'catalog-console'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(stored).toHaveLength(0);
    },
  );

  it('accepts a soft-delete declaration that names no column', async () => {
    // Genuinely optional: a source that flips a status the transform reads does
    // not name a column, and refusing that would push a fiction into the field.
    const { em } = entityManager([]);
    const store = new MySqlPipelineStore(em);

    const saved = await store.saveLoadExpectation(
      'Subwo',
      { deletes: { strategy: 'soft-deleted-at-source', because: 'status flips to VOID.' } },
      'app-b',
    );

    expect(saved.deletes).toEqual({
      strategy: 'soft-deleted-at-source',
      because: 'status flips to VOID.',
    });
  });
});

describe('reading expectations back', () => {
  it('answers nothing for a type nobody has set', async () => {
    const { em } = entityManager([storedRow('Mvr')]);
    const store = new MySqlPipelineStore(em);

    expect(await store.getLoadExpectation('Employee')).toBeUndefined();
  });

  it('reads an unrecognisable stored strategy as no declaration at all', async () => {
    // The strict direction, and the opposite choice from `isWorkflowNode`, which
    // throws. A dropped workflow node leaves a graph that still validates and
    // silently runs nine steps of ten; a dropped delete strategy makes
    // `refuseUndeclaredDeletes` stop the incremental load with a message naming
    // what to declare. Loud, safe, and fixed by saving it again.
    const { em } = entityManager([
      storedRow('Mvr', {
        deletes: { strategy: 'tombstones', because: 'written by a later build' },
      }),
    ]);
    const store = new MySqlPipelineStore(em);

    const read = await store.getLoadExpectation('Mvr');

    expect(read?.typeName).toBe('Mvr');
    expect(read?.deletes).toBeUndefined();
  });

  it('keeps a partial bound partial', async () => {
    // Field by field all the way down: a stored `maxShrink` must not arrive
    // carrying an opinion about `maxGrowth`, because the merge that consumes it
    // resolves per field and a zero would read as a real bound.
    const { em } = entityManager([storedRow('Mvr', { rowCount: { maxShrink: 0.8, junk: 'x' } })]);
    const store = new MySqlPipelineStore(em);

    expect((await store.getLoadExpectation('Mvr'))?.rowCount).toEqual({ maxShrink: 0.8 });
  });

  it('reads a bound with nothing usable in it as no bound', async () => {
    const { em } = entityManager([storedRow('Mvr', { rowCount: { maxShrink: 'half' } })]);
    const store = new MySqlPipelineStore(em);

    expect((await store.getLoadExpectation('Mvr'))?.rowCount).toBeUndefined();
  });

  it('lists every stored row in a stable order', async () => {
    const { em, finds } = entityManager([storedRow('Subwo'), storedRow('Mvr')]);
    const store = new MySqlPipelineStore(em);

    const all = await store.listLoadExpectations();

    expect(all.map((row) => row.typeName)).toEqual(['Subwo', 'Mvr']);
    // The order is the database's to produce, and asking for it is the only way
    // a screen listing these does not reshuffle between page loads.
    expect(finds[0]).toMatchObject({ orderBy: { typeName: 'asc' } });
  });
});

describe('clearLoadExpectation', () => {
  it('drops the row and says it did', async () => {
    const { em, stored, deletes } = entityManager([storedRow('Mvr'), storedRow('Subwo')]);
    const store = new MySqlPipelineStore(em);

    expect(await store.clearLoadExpectation('Mvr')).toBe(true);
    expect(stored.map((row) => row.typeName)).toEqual(['Subwo']);
    // By type name, and only that type name.
    expect(deletes[0]).toEqual({ typeName: 'Mvr' });
  });

  it('answers false when there was nothing stored, which is a fact and not a failure', async () => {
    const { em } = entityManager([storedRow('Subwo')]);
    const store = new MySqlPipelineStore(em);

    expect(await store.clearLoadExpectation('Mvr')).toBe(false);
  });
});
