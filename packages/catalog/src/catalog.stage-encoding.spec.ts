import { describe, expect, it } from 'vitest';
import {
  STAGE_ENCODING,
  STAGE_ENCODING_VERSION,
  classifyStagePayload,
  decodeStageRows,
  encodeStageRows,
  isColumnarStageBatch,
} from './catalog.stage-encoding';

/**
 * The staged-batch codec.
 *
 * Every test here fails against the previous encoding — either because the
 * previous encoding had no tag to check, or because it wrote the property names
 * once per row, or because the two facts it collapsed are the two facts these
 * tests keep apart.
 */

/** The round trip a staged batch actually makes, without a database in the way. */
function throughJson(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const stored: unknown = JSON.parse(JSON.stringify(encodeStageRows(rows)));
  return decodeStageRows(stored);
}

describe('the columnar staged-batch encoding', () => {
  it('writes each property name once per batch instead of once per row', () => {
    const rows = Array.from({ length: 200 }, (_, index) => ({
      Sub_Work_Order_Id: `SWO-${index}`,
      Customer_E_Mail_Address: `person${index}@example.mil`,
      NMC_Total_Time_in_Days: index,
    }));

    const columnar = JSON.stringify(encodeStageRows(rows));
    const rowOriented = JSON.stringify(rows);

    // Once, in `shapes` — not 200 times.
    expect(columnar.split('Customer_E_Mail_Address').length - 1).toBe(1);
    expect(rowOriented.split('Customer_E_Mail_Address').length - 1).toBe(200);
    // The whole point: bytes.
    expect(columnar.length).toBeLessThan(rowOriented.length * 0.6);
  });

  it('round-trips values, key order included', () => {
    const rows = [
      { zebra: 1, a: 'two', Middle_Name: null, b: [1, 2, { deep: true }] },
      { zebra: 2, a: 'three', Middle_Name: 'x', b: [] },
    ];

    const back = throughJson(rows);

    expect(back).toEqual(rows);
    // The order the producing node emitted, not the order MySQL's binary JSON
    // would have sorted an object's members into.
    expect(Object.keys(back[0] ?? {})).toEqual(['zebra', 'a', 'Middle_Name', 'b']);
  });

  it('keeps absent and null apart across rows in one batch', () => {
    const rows: Array<Record<string, unknown>> = [
      { id: 1, note: null },
      { id: 2 },
      { id: 3, note: 'here' },
    ];

    const back = throughJson(rows);

    // The distinction the whole shape-dictionary exists for. A padded union
    // column list would have made all three of these `note: null`, and a sink
    // writing `NULL` over a column it was meant to leave alone is silent data
    // loss.
    expect('note' in (back[0] ?? {})).toBe(true);
    expect(back[0]?.note).toBeNull();
    expect('note' in (back[1] ?? {})).toBe(false);
    expect(back[2]?.note).toBe('here');
    expect(back).toEqual(rows);
  });

  it('drops a key whose value is undefined, exactly as JSON.stringify did', () => {
    const rows: Array<Record<string, unknown>> = [{ id: 1, note: undefined, ok: null }];

    const back = throughJson(rows);

    expect('note' in (back[0] ?? {})).toBe(false);
    expect('ok' in (back[0] ?? {})).toBe(true);
    expect(back[0]?.ok).toBeNull();
    // The behaviour it has to match, spelled out rather than asserted about.
    expect(back).toEqual(JSON.parse(JSON.stringify(rows)));
  });

  it('drops function- and symbol-valued keys, as JSON.stringify did', () => {
    const rows: Array<Record<string, unknown>> = [
      { id: 1, fn: () => 'no', sym: Symbol('no'), kept: 'yes' },
    ];

    const back = throughJson(rows);

    expect(back).toEqual([{ id: 1, kept: 'yes' }]);
  });

  it('carries a batch whose rows share no keys at all', () => {
    const rows: Array<Record<string, unknown>> = [{ a: 1 }, { b: 2 }, { c: 3, d: 4 }, { a: 5 }];

    const encoded = encodeStageRows(rows);

    // Four rows, three distinct key-sets — `{a:1}` and `{a:5}` share one.
    expect(encoded.shapes).toHaveLength(3);
    expect(encoded.shapeOf).toEqual([0, 1, 2, 0]);
    expect(throughJson(rows)).toEqual(rows);
  });

  it('holds an empty batch', () => {
    expect(throughJson([])).toEqual([]);
    expect(encodeStageRows([]).shapes).toEqual([]);
  });

  it('holds rows that are themselves empty objects', () => {
    const rows: Array<Record<string, unknown>> = [{}, { a: 1 }, {}];

    expect(throughJson(rows)).toEqual(rows);
  });

  it('does not let a key-set collide with another through its fingerprint', () => {
    // Two key-sets that a naive `join` on almost any separator would confuse.
    const rows: Array<Record<string, unknown>> = [
      { 'a,b': 1 },
      { a: 2, b: 3 },
      { 'a"b': 4 },
      { 'a\\"': 5 },
    ];

    expect(encodeStageRows(rows).shapes).toHaveLength(4);
    expect(throughJson(rows)).toEqual(rows);
  });
});

describe('reading a batch staged before this encoding existed', () => {
  it('decodes a row-oriented array, which is what the ~16,233 live rows are', () => {
    // Byte-for-byte what the previous `writeStage` put in the column.
    const legacy: unknown = JSON.parse('[{"id":1,"note":null},{"id":2},{"id":3,"note":"here"}]');

    const back = decodeStageRows(legacy);

    expect(back).toEqual([{ id: 1, note: null }, { id: 2 }, { id: 3, note: 'here' }]);
    // Absent stays absent through the old shape too — a resume onto a
    // half-written run must not start writing NULLs the first attempt did not.
    expect('note' in (back[1] ?? {})).toBe(false);
  });

  it('names the old shape rather than inferring it from the rows', () => {
    expect(classifyStagePayload([]).encoding).toBe('row-oriented/v0');
    // An empty batch is where a contents-sniffing discriminator would have
    // nothing to look at. This one looks at the JSON type, which is decided.
    expect(classifyStagePayload(encodeStageRows([])).encoding).toBe('columnar/v1');
  });

  it('still drops non-objects out of a legacy array, as the old reader did', () => {
    expect(decodeStageRows([{ id: 1 }, 'not a row', null, [1, 2], { id: 2 }])).toEqual([
      { id: 1 },
      { id: 2 },
    ]);
  });

  it('cannot confuse the two: an array is never a tagged object', () => {
    // A legacy batch whose rows happen to be named like the tag. The old
    // encoding is an array at the top level, so no contents can make it match.
    const adversarial: unknown = [{ enc: STAGE_ENCODING, v: STAGE_ENCODING_VERSION }];

    expect(classifyStagePayload(adversarial).encoding).toBe('row-oriented/v0');
    expect(isColumnarStageBatch(adversarial)).toBe(false);
  });
});

describe('a batch this build cannot read', () => {
  it('refuses a newer encoding version by name instead of decoding to nothing', () => {
    expect(() =>
      decodeStageRows({ enc: STAGE_ENCODING, v: 99, shapes: [], shapeOf: [], values: [] }),
    ).toThrow(/version 99/);
  });

  it('refuses an untagged object', () => {
    expect(() => decodeStageRows({ rows: [{ id: 1 }] })).toThrow(/no "enc" tag/);
  });

  it('refuses a batch whose row names a shape it does not carry', () => {
    expect(() =>
      decodeStageRows({
        enc: STAGE_ENCODING,
        v: STAGE_ENCODING_VERSION,
        shapes: [['id']],
        shapeOf: [0, 7],
        values: [[1], [2]],
      }),
    ).toThrow();
  });

  it('refuses a batch whose value row is the wrong width', () => {
    expect(
      isColumnarStageBatch({
        enc: STAGE_ENCODING,
        v: STAGE_ENCODING_VERSION,
        shapes: [['id', 'note']],
        shapeOf: [0],
        values: [[1]],
      }),
    ).toBe(false);
  });

  it('never answers "no rows" for a batch it could not read', () => {
    // The failure mode this refusal exists to prevent: an incremental load
    // treats an empty batch as "nothing changed" and carry-forward commits a
    // snapshot without whatever the batch held.
    for (const unreadable of [{}, { enc: 'someone-elses' }, 'a string', 42, null]) {
      expect(() => decodeStageRows(unreadable)).toThrow();
    }
  });
});
