import { describe, expect, it } from 'vitest';
import {
  type StageRenamePlan,
  decodeStageRows,
  encodeStageRows,
  isColumnarStageBatch,
  renameStagePayload,
} from './catalog.stage-encoding';

/**
 * The claim the rename node is built on, proved rather than asserted.
 *
 * > Renaming a column in a staged batch is a rewrite of `shapes` and nothing
 * > else, because `values` is positional and a positional array does not care
 * > what the key is called.
 *
 * A test that only compared the decoded rows could not tell that apart from a
 * rebuild — both produce the same rows. So the load-bearing assertions here are
 * about **object identity**: the `values` arrays that come out are the same
 * arrays that went in, by reference. That is a property no output comparison
 * can catch and the only thing that makes "no data moved" a fact rather than a
 * hope.
 *
 * The other half is where it stops being true. `dropUnnamed` removes a position
 * from every row, so `values` must be rebuilt, and the result says so.
 */

function plan(columns: Record<string, string>, dropUnnamed = false): StageRenamePlan {
  return { columns: new Map(Object.entries(columns)), dropUnnamed };
}

/** Four rows keyed the way a real fleet export keys them. */
const DROP = [
  { 'Mgmt Cd': 'AF', 'Reg Number': '01-1234', 'VEH Type Name': 'Sedan' },
  { 'Mgmt Cd': 'AF', 'Reg Number': '02-9876', 'VEH Type Name': 'Truck' },
  { 'Mgmt Cd': null, 'Reg Number': '03-5555', 'VEH Type Name': 'Van' },
  { 'Mgmt Cd': 'AF', 'Reg Number': '04-0001', 'VEH Type Name': 'Sedan' },
];

describe('a pure rename over a columnar batch', () => {
  it('rewrites the column list and moves no data at all', () => {
    const batch = encodeStageRows(DROP);
    const result = renameStagePayload(batch, plan({ 'Mgmt Cd': 'mgmtCd' }));

    expect(result.metadataOnly).toBe(true);
    expect(result.shapesRewritten).toBe(1);
    // The assertion the whole feature rests on. Not `toEqual` — `toBe`, on each
    // row's value array: these are the *same objects*, so nothing was copied,
    // allocated or walked. One shape was rewritten for four rows, and it would
    // be one shape rewritten for a hundred thousand.
    for (const [index, row] of result.payload.values.entries()) {
      expect(row).toBe(batch.values[index]);
    }
    expect(result.payload.shapeOf).toBe(batch.shapeOf);
  });

  it('produces exactly the rows the rename means', () => {
    const result = renameStagePayload(
      encodeStageRows(DROP),
      plan({ 'Mgmt Cd': 'mgmtCd', 'Reg Number': 'regNumber' }),
    );
    expect(decodeStageRows(result.payload)[0]).toEqual({
      mgmtCd: 'AF',
      regNumber: '01-1234',
      'VEH Type Name': 'Sedan',
    });
  });

  it('keeps a null distinct from an absent column', () => {
    // The distinction the encoding exists to preserve: a row that lacks a key
    // and a row whose key is `null` are different facts, and which one it is
    // decides whether a sink writes a column or leaves it alone.
    const mixed = encodeStageRows([{ 'Mgmt Cd': null }, {}]);
    const rows = decodeStageRows(renameStagePayload(mixed, plan({ 'Mgmt Cd': 'mgmtCd' })).payload);
    expect(rows[0]).toEqual({ mgmtCd: null });
    expect(Object.hasOwn(rows[1] ?? {}, 'mgmtCd')).toBe(false);
  });

  it('rewrites every distinct key-set a batch holds, not only the first', () => {
    // A batch is a shape *dictionary* precisely because rows differ. A rename
    // that only fixed the first shape would leave the rest under their old
    // names, and the sink would write a column for some rows and not others.
    const uneven = encodeStageRows([
      { 'Mgmt Cd': 'AF' },
      { 'Mgmt Cd': 'AF', 'Reg Number': '1' },
      { 'Mgmt Cd': 'AF' },
    ]);
    const result = renameStagePayload(uneven, plan({ 'Mgmt Cd': 'mgmtCd' }));
    expect(result.shapesRewritten).toBe(2);
    expect(decodeStageRows(result.payload).every((row) => Object.hasOwn(row, 'mgmtCd'))).toBe(true);
  });

  it('applies the map simultaneously rather than in sequence', () => {
    // `{a: 'b', b: 'c'}` maps a to b and b to c. It does not chain a -> b -> c,
    // because chaining would make the result depend on the iteration order of a
    // JSON object.
    const rows = decodeStageRows(
      renameStagePayload(encodeStageRows([{ a: 1, b: 2 }]), plan({ a: 'b', b: 'c' })).payload,
    );
    expect(rows[0]).toEqual({ b: 1, c: 2 });
  });

  it('says which source columns it actually found', () => {
    // The one that was in no row is how a typo in a header shows up, and its
    // symptom otherwise is a target column absent everywhere and a green run.
    const result = renameStagePayload(
      encodeStageRows(DROP),
      plan({ 'Mgmt Cd': 'mgmtCd', 'Mgmt Code': 'mgmtCode' }),
    );
    expect([...result.matched]).toEqual(['Mgmt Cd']);
  });
});

describe('renaming onto a name the rows already hold', () => {
  it('refuses, naming both columns', () => {
    // Two columns and one name. Every rule for picking a winner is arbitrary,
    // and the one JavaScript would pick silently discards the other.
    expect(() =>
      renameStagePayload(
        encodeStageRows([{ 'Mgmt Cd': 'AF', mgmtCd: 'XX' }]),
        plan({ 'Mgmt Cd': 'mgmtCd' }),
      ),
    ).toThrow(/collide/);
  });

  it('has nothing to collide with when the unnamed columns are dropped', () => {
    // The pre-existing occupant is not in the map, so it is not in the output,
    // so it cannot be occupying anything. The two dispositions genuinely differ
    // in when they refuse.
    const result = renameStagePayload(
      encodeStageRows([{ 'Mgmt Cd': 'AF', mgmtCd: 'XX' }]),
      plan({ 'Mgmt Cd': 'mgmtCd' }, true),
    );
    expect(decodeStageRows(result.payload)).toEqual([{ mgmtCd: 'AF' }]);
  });

  it('does not call a swap a collision', () => {
    // `{a: 'b', b: 'a'}` is well defined under simultaneous application, and a
    // collision check done one key at a time would refuse it.
    const rows = decodeStageRows(
      renameStagePayload(encodeStageRows([{ a: 1, b: 2 }]), plan({ a: 'b', b: 'a' })).payload,
    );
    expect(rows[0]).toEqual({ b: 1, a: 2 });
  });
});

describe('dropping the columns the map does not name', () => {
  it('produces exactly the targets, and says the rows had to be rebuilt', () => {
    const result = renameStagePayload(
      encodeStageRows(DROP),
      plan({ 'Mgmt Cd': 'mgmtCd', 'Reg Number': 'regNumber' }, true),
    );
    // The honest half of the metadata-only claim: removing a column removes a
    // position, so this one costs a pass over the rows and reports as much.
    expect(result.metadataOnly).toBe(false);
    expect(decodeStageRows(result.payload)).toEqual([
      { mgmtCd: 'AF', regNumber: '01-1234' },
      { mgmtCd: 'AF', regNumber: '02-9876' },
      { mgmtCd: null, regNumber: '03-5555' },
      { mgmtCd: 'AF', regNumber: '04-0001' },
    ]);
  });

  it('reproduces exactly what the transform it replaces returns', () => {
    // The transform this node exists to delete, verbatim:
    //   records.map((r) => ({ mgmtCd: r["Mgmt Cd"], regNumber: r["Reg Number"] }))
    const byHand = DROP.map((row) => ({
      mgmtCd: row['Mgmt Cd'],
      regNumber: row['Reg Number'],
    }));
    const byNode = decodeStageRows(
      renameStagePayload(
        encodeStageRows(DROP),
        plan({ 'Mgmt Cd': 'mgmtCd', 'Reg Number': 'regNumber' }, true),
      ).payload,
    );
    expect(byNode).toEqual(byHand);
  });
});

describe('a batch staged before this encoding existed', () => {
  it('renames it through the same code path and says the bytes moved', () => {
    // Row-oriented batches are re-encoded first rather than given a second
    // implementation, so the fallback cannot disagree with the fast path about
    // what a rename means — including about a collision.
    const stored = [{ 'Mgmt Cd': 'AF' }, { 'Mgmt Cd': null }];
    const result = renameStagePayload(stored, plan({ 'Mgmt Cd': 'mgmtCd' }));
    expect(result.metadataOnly).toBe(false);
    expect(result.rows).toBe(2);
    expect(isColumnarStageBatch(result.payload)).toBe(true);
    expect(decodeStageRows(result.payload)).toEqual([{ mgmtCd: 'AF' }, { mgmtCd: null }]);
  });
});
