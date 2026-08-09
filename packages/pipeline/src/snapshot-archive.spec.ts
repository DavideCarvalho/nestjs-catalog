import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CatalogObjectTypeDef, ScalarType } from '@dudousxd/nestjs-catalog';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ARCHIVE_MANIFEST_NAME,
  ARCHIVE_PART_NAME,
  type ArchiveSink,
  type ArchiveStore,
  archiveColumns,
  archivePathFor,
  archiveSnapshot,
  isTextEncodedScalar,
  localArchiveStore,
  parquetTypeFor,
} from './snapshot-archive';
import { parquetRecordsFrom } from './source-parquet';

/**
 * The archiver, against real parquet bytes on a real filesystem.
 *
 * Nothing here mocks the encoder or the reader: the point of every case is that
 * a snapshot written by this package is read back by the same package's reader
 * with the same values, and a mock of either end would be a test of the mock.
 */

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'catalog-archive-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function typeOf(properties: Array<{ name: string; type: ScalarType }>): CatalogObjectTypeDef {
  return {
    name: 'Subwo',
    displayName: 'Sub WO',
    pluralDisplayName: 'Sub WOs',
    tableName: 'obj_subwo',
    group: 'ops',
    primaryKey: [],
    enriched: true,
    relations: [],
    properties: properties.map((property) => ({
      name: property.name,
      displayName: property.name,
      type: property.type,
      columnName: property.name,
      nullable: true,
      primary: false,
      hidden: false,
      order: 0,
      enriched: false,
    })),
  };
}

/**
 * What a store stamps on every row it streams with `{ provenance: true }`.
 *
 * Stamped by {@link streamOf} rather than written into each fixture, because it
 * is on every row of every real stream and repeating it would bury the values
 * each case is actually about. The archiver refuses a row without it — see the
 * case that pins that — so a fixture that omitted it would fail for a reason
 * that has nothing to do with what it tests.
 */
const PROVENANCE = {
  _principal_id: 'a-loader',
  _loaded_at: '2026-08-08T00:00:00.000Z',
} as const;

async function* streamOf(
  rows: Array<Record<string, unknown>>,
): AsyncGenerator<Record<string, unknown>> {
  for (const row of rows) yield { ...PROVENANCE, ...row };
}

/** A stream with no provenance on it, for the cases that are about its absence. */
async function* streamWithoutProvenance(
  rows: Array<Record<string, unknown>>,
): AsyncGenerator<Record<string, unknown>> {
  for (const row of rows) yield row;
}

describe('parquetTypeFor', () => {
  /**
   * The catalog has seven scalar types and every one of them is mapped, which is
   * what makes an archive written here readable by the reader beside it. If a
   * scalar is ever added, this fails rather than the archive quietly becoming
   * unreadable for one column.
   */
  it('maps every catalog scalar to a type the reader accepts', () => {
    const scalars: ScalarType[] = [
      'string',
      'number',
      'boolean',
      'date',
      'json',
      'uuid',
      'unknown',
    ];
    const mapped = scalars.map(parquetTypeFor);
    expect(mapped).toEqual(['STRING', 'DOUBLE', 'BOOLEAN', 'STRING', 'STRING', 'STRING', 'STRING']);
    // None of the types the reader refuses by name, which is the property that
    // matters rather than the exact list above.
    expect(mapped).not.toContain('DECIMAL');
    expect(mapped).not.toContain('INT96');
    expect(mapped).not.toContain('UUID');
  });

  it('carries json and unknown as text', () => {
    expect(isTextEncodedScalar('json')).toBe(true);
    expect(isTextEncodedScalar('unknown')).toBe(true);
    expect(isTextEncodedScalar('string')).toBe(false);
    expect(isTextEncodedScalar('date')).toBe(false);
  });

  it('writes a date as the ISO string the store already handed over', () => {
    // Not a TIMESTAMP. The value reaching the archiver is already an ISO-8601
    // string — the store's `normalise` made it one — and the reader turns every
    // temporal parquet value back into an ISO-8601 string. Choosing TIMESTAMP
    // would parse a string into an integer to decode it back into a string, and
    // the round trip would carry a timezone assumption it does not need.
    expect(parquetTypeFor('date')).toBe('STRING');
  });
});

describe('archiveColumns', () => {
  it("takes every property in the type's order, then the provenance columns", () => {
    const columns = archiveColumns(
      typeOf([
        { name: 'Work Order', type: 'string' },
        { name: 'hours', type: 'number' },
      ]),
    );
    expect(columns.map((column) => column.name)).toEqual([
      'Work Order',
      'hours',
      '_principal_id',
      '_loaded_at',
    ]);
    expect(columns.every((column) => column.nullable)).toBe(true);
  });

  /**
   * The reserved columns a merge reads off the snapshot it merges against.
   *
   * `carryForward` copies both onto every row it carries, untouched, so a
   * snapshot that came out of an incremental run holds two answers to "who
   * loaded this row and when" — and a restore that could not supply them would
   * make every carried row claim it was loaded whenever the restore ran, then
   * hand that answer to the next incremental load, and the one after it.
   */
  it('preserves the two columns an incremental merge copies forward', () => {
    const columns = archiveColumns(typeOf([{ name: 'hours', type: 'number' }]));
    expect(columns.map((column) => column.name)).toContain('_principal_id');
    expect(columns.map((column) => column.name)).toContain('_loaded_at');
  });

  /**
   * **`_batch` is not archived, and that is a decision rather than a gap.**
   *
   * This file used to assert the opposite reading — that `_batch` was "a real
   * loss" and "a prerequisite for anything that deletes". The second half is
   * wrong: **no merge reads it.** The batch-replace predicate and the merge's
   * self-feed guard both scope to the snapshot being built, and `carryForward`
   * joins the previous snapshot on its primary key without ever looking at its
   * `_batch`. The `-1` marker records that a merge happened; it is never an input
   * to the next one.
   *
   * It could not be restored in any case. `write` refuses a negative batch by
   * name — negative batches are reserved for rows the store writes on your
   * behalf — so the only value in the column that carries any information is the
   * one value the only write seam will not accept back.
   *
   * The first half is overstated rather than wrong. A committed snapshot's
   * `_batch` is read twice in the ClickHouse adapter — as a page's default
   * `(_batch, _row)` order, which the store interface does not promise, and as
   * the partition list `dropSnapshot` unlinks, which assumes nothing about the
   * values. Neither is a reason to carry it into every archived file.
   *
   * `_snapshot_id` and `_row` are absent for their own reasons: one value for
   * the whole archive, and the order rather than a value.
   */
  it('does not archive _batch, _snapshot_id or _row', () => {
    const names = archiveColumns(typeOf([{ name: 'hours', type: 'number' }])).map(
      (column) => column.name,
    );
    expect(names).not.toContain('_batch');
    expect(names).not.toContain('_snapshot_id');
    expect(names).not.toContain('_row');
  });
});

describe('archivePathFor', () => {
  it('puts the type above the snapshot, so a lifecycle rule can be scoped per type', () => {
    expect(archivePathFor('catalog/archive', 'Subwo', 'wf-1a2b3c4d')).toBe(
      'catalog/archive/Subwo/wf-1a2b3c4d',
    );
  });

  it('tolerates a prefix written with slashes on either end', () => {
    expect(archivePathFor('/catalog/archive/', 'Subwo', 'wf-1')).toBe('catalog/archive/Subwo/wf-1');
  });

  /**
   * Refused rather than escaped. A snapshot id is caller-supplied — a durable run
   * id — and nothing upstream has ever had to validate it as a path. Escaping
   * would put the archive somewhere that cannot be predicted from the id, which
   * is the one property the layout exists to have.
   */
  it.each([
    ['a slash', 'wf/1'],
    ['a parent traversal', '..'],
    ['a backslash', 'wf\\1'],
    ['nothing at all', '   '],
  ])('refuses a snapshot id containing %s', (_what, snapshotId) => {
    expect(() => archivePathFor('archive', 'Subwo', snapshotId)).toThrow(
      /cannot be a path segment|needs a snapshot id/,
    );
  });
});

describe('archiveSnapshot', () => {
  /**
   * The round trip, on every scalar the catalog has, with the values in exactly
   * the shape the store's `streamSnapshot` hands them over: dates already ISO
   * strings, bigints already strings, absent values already null.
   */
  it('round-trips every scalar type through parquet without changing a value', async () => {
    const store = localArchiveStore(root);
    const type = typeOf([
      { name: 'name', type: 'string' },
      { name: 'hours', type: 'number' },
      { name: 'closed', type: 'boolean' },
      { name: 'openedAt', type: 'date' },
      { name: 'detail', type: 'json' },
      { name: 'id', type: 'uuid' },
      { name: 'extra', type: 'unknown' },
    ]);
    const rows = [
      {
        name: 'a job',
        hours: 1.5,
        closed: true,
        openedAt: '2026-08-08T12:34:56.789Z',
        detail: { part: 'x', qty: 2 },
        id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
        extra: [1, 2, 3],
      },
      {
        name: null,
        hours: null,
        closed: null,
        openedAt: null,
        detail: null,
        id: null,
        extra: null,
      },
      {
        name: 'unicode ✓ é 中文',
        hours: -0.125,
        closed: false,
        openedAt: '1970-01-01T00:00:00.000Z',
        detail: [],
        id: '00000000-0000-0000-0000-000000000000',
        extra: { nested: { deep: true } },
      },
    ];

    const path = archivePathFor('roundtrip', type.name, 'snap-1');
    const ref = await archiveSnapshot({
      type,
      snapshotId: 'snap-1',
      rows: streamOf(rows),
      expectedRowCount: rows.length,
      store,
      path,
    });

    expect(ref.format).toBe('parquet');
    expect(ref.rowCount).toBe(3);
    expect(ref.bytes).toBeGreaterThan(0);
    // Written AND read back. Nothing may delete rows on a ref without this.
    expect(ref.verifiedAt).toBeTruthy();

    // The values, read back through the package's own reader — which is what
    // `archiveSnapshot` verified with, so this asserts the values rather than
    // merely that verification passed.
    const file = await store.read(`${path}/${ARCHIVE_PART_NAME}`);
    const back: unknown[] = [];
    for await (const record of parquetRecordsFrom(file, 'archive')) back.push(record);

    // Every column comes back as it went in, except the two the manifest calls
    // `json` and `unknown` — those come back as the JSON text they were stored
    // as. That divergence is the price of routing around the writer's JSON bug
    // and it is what the manifest exists to make undoable.
    expect(back).toEqual(
      rows.map((row) => ({
        ...row,
        detail: row.detail === null ? null : JSON.stringify(row.detail),
        extra: row.extra === null ? null : JSON.stringify(row.extra),
        // Beside the properties and read back as themselves, which is the whole
        // of what archiving them costs at the encoder: both are STRING, the same
        // as a `date` property, and neither goes through the text encoding the
        // JSON columns need.
        ...PROVENANCE,
      })),
    );
  });

  /**
   * The upstream bug this file routes around, pinned so a fixed release is
   * noticed rather than assumed.
   *
   * `hyparquet-writer` 0.16.5 — the current release — drops or shifts JSON
   * values that follow a null inside a row group. It is the writer and not this
   * package's reader: hyparquet's own reader, with no custom parsers, produces
   * the same wrong answer from the same bytes. If this test ever fails, the bug
   * is fixed and `parquetTypeFor` can stop encoding JSON as text.
   */
  it('pins the hyparquet-writer JSON-after-null bug that forces the text encoding', async () => {
    const parquet = await import('hyparquet-writer');
    const writer = new parquet.ByteWriter();
    await parquet.parquetWriteRows({
      writer,
      rows: [{ v: { a: 1 } }, { v: null }, { v: { c: 3 } }],
      columns: [{ name: 'v', type: 'JSON', nullable: true }],
      rowGroupSize: 1000,
    });
    const bytes = writer.getBuffer();
    const file = {
      byteLength: bytes.byteLength,
      slice: async (start: number, end?: number) => bytes.slice(start, end),
    };

    const back: unknown[] = [];
    for await (const record of parquetRecordsFrom(file, 'json-bug')) {
      if (record !== null && typeof record === 'object' && 'v' in record) back.push(record.v);
    }
    // The third value is `{ c: 3 }` on the way in and null on the way out.
    expect(back).toEqual([{ a: 1 }, null, null]);
  });

  it('writes a manifest that maps the archive back to the object type', async () => {
    const store = localArchiveStore(root);
    const type = typeOf([
      { name: 'name', type: 'string' },
      { name: 'openedAt', type: 'date' },
    ]);
    const path = archivePathFor('manifest', type.name, 'snap-2');
    const ref = await archiveSnapshot({
      type,
      snapshotId: 'snap-2',
      rows: streamOf([{ name: 'x', openedAt: '2026-01-01T00:00:00.000Z' }]),
      expectedRowCount: 1,
      store,
      path,
    });

    const manifest = JSON.parse(await readFile(join(root, path, ARCHIVE_MANIFEST_NAME), 'utf8'));
    expect(manifest.objectType).toBe('Subwo');
    expect(manifest.snapshotId).toBe('snap-2');
    expect(manifest.rowCount).toBe(1);
    expect(manifest.checksum).toBe(ref.checksum);
    // The catalog's own vocabulary beside the parquet one, so a reader holding
    // only the archive can map it back without the registry that produced it.
    expect(manifest.columns).toEqual([
      { name: 'name', type: 'string', parquetType: 'STRING' },
      { name: 'openedAt', type: 'date', parquetType: 'STRING' },
      // Last, always, and named in the manifest rather than left for a reader to
      // recognise — they are exactly the columns a restore has to route
      // somewhere other than the property values.
      { name: '_principal_id', type: 'string', parquetType: 'STRING' },
      { name: '_loaded_at', type: 'date', parquetType: 'STRING' },
    ]);
  });

  /**
   * The refusal the other three checks cannot make.
   *
   * Row count, checksum and read-back all ask whether the file matches what was
   * streamed. A caller that streamed without asking for provenance streams rows
   * with no such key, the absence encodes as a null, the null hashes and reads
   * back as a null, and **every check passes** — leaving a complete, verified
   * archive silently missing the two columns a restore cannot reconstruct. So it
   * is caught on the way in instead.
   */
  it('refuses a stream that carries no provenance, which verification could not catch', async () => {
    const store = localArchiveStore(root);
    const type = typeOf([{ name: 'name', type: 'string' }]);
    const path = archivePathFor('bare', type.name, 'snap-9');

    await expect(
      archiveSnapshot({
        type,
        snapshotId: 'snap-9',
        rows: streamWithoutProvenance([{ name: 'no provenance on me' }]),
        expectedRowCount: 1,
        store,
        path,
      }),
    ).rejects.toThrow(/streamed a row with no _principal_id/);

    // And nothing left behind, like every other refusal here.
    await expect(stat(join(root, path, ARCHIVE_PART_NAME))).rejects.toThrow();
    await expect(stat(join(root, `${path}/${ARCHIVE_PART_NAME}.partial`))).rejects.toThrow();
  });

  /**
   * And once it is in the file, it is under the same verification as everything
   * else — which is the standard anything added to the archived shape has to
   * meet, rather than merely being written.
   *
   * The bytes served back hold the same row count and the same property values
   * and differ in one provenance value. `canonicalRow` hashes every archive
   * column, so the checksum sees it; a shape that was written but left out of the
   * hash would pass this.
   */
  it('puts the provenance columns under the same checksum as the values', async () => {
    const type = typeOf([{ name: 'name', type: 'string' }]);
    const path = archivePathFor('prov-tamper', type.name, 'snap-10');
    const backing = localArchiveStore(root);
    const tampering: ArchiveStore = {
      open: (at) => backing.open(at),
      put: (at, bytes) => backing.put(at, bytes),
      async read(at) {
        const other = archivePathFor('prov-tamper', type.name, 'snap-10-other');
        await archiveSnapshot({
          type,
          snapshotId: 'snap-10-other',
          // Same value, same count. Only who loaded it differs.
          rows: streamWithoutProvenance([
            { ...PROVENANCE, _principal_id: 'somebody-else', name: 'what was written' },
          ]),
          expectedRowCount: 1,
          store: backing,
          path: other,
        });
        return backing.read(`${other}/${ARCHIVE_PART_NAME}`);
      },
    };

    await expect(
      archiveSnapshot({
        type,
        snapshotId: 'snap-10',
        rows: streamOf([{ name: 'what was written' }]),
        expectedRowCount: 1,
        store: tampering,
        path,
      }),
    ).rejects.toThrow(/right number, and they do not hash to what was written/);
  });

  /**
   * The ordering property, from the failing side: a stream that ends short must
   * leave **nothing** at the destination. A complete-looking archive that is
   * missing rows is the input to a later deletion, and this is where that is
   * prevented.
   */
  it('leaves no object behind when the stream is shorter than the snapshot claims', async () => {
    const store = localArchiveStore(root);
    const type = typeOf([{ name: 'name', type: 'string' }]);
    const path = archivePathFor('short', type.name, 'snap-3');

    await expect(
      archiveSnapshot({
        type,
        snapshotId: 'snap-3',
        rows: streamOf([{ name: 'only one' }]),
        expectedRowCount: 9,
        store,
        path,
      }),
    ).rejects.toThrow(/reports 9 rows and 1 were read/);

    await expect(stat(join(root, path, ARCHIVE_PART_NAME))).rejects.toThrow();
    await expect(stat(join(root, `${path}/${ARCHIVE_PART_NAME}.partial`))).rejects.toThrow();
    await expect(stat(join(root, path, ARCHIVE_MANIFEST_NAME))).rejects.toThrow();
  });

  it('leaves no object behind when the source throws mid-stream', async () => {
    const store = localArchiveStore(root);
    const type = typeOf([{ name: 'name', type: 'string' }]);
    const path = archivePathFor('boom', type.name, 'snap-4');

    async function* explodes(): AsyncGenerator<Record<string, unknown>> {
      yield { ...PROVENANCE, name: 'first' };
      throw new Error('the connection went away');
    }

    await expect(
      archiveSnapshot({
        type,
        snapshotId: 'snap-4',
        rows: explodes(),
        expectedRowCount: 2,
        store,
        path,
      }),
    ).rejects.toThrow(/the connection went away/);

    await expect(stat(join(root, path, ARCHIVE_PART_NAME))).rejects.toThrow();
    await expect(stat(join(root, `${path}/${ARCHIVE_PART_NAME}.partial`))).rejects.toThrow();
  });

  /**
   * The checksum earning its place. A store that hands back different bytes than
   * it took has the right row count and the wrong data, which is the one failure
   * a count cannot see.
   */
  it('refuses an archive that reads back with the right count and a changed value', async () => {
    const type = typeOf([{ name: 'name', type: 'string' }]);
    const path = archivePathFor('tamper', type.name, 'snap-5');
    const backing = localArchiveStore(root);
    const tampering: ArchiveStore = {
      open: (at) => backing.open(at),
      put: (at, bytes) => backing.put(at, bytes),
      async read(at) {
        // Serve the bytes of a *different* archive of the same shape and size:
        // one row, one string column, one value. Same count, different value.
        const other = archivePathFor('tamper', type.name, 'snap-5-other');
        await archiveSnapshot({
          type,
          snapshotId: 'snap-5-other',
          rows: streamOf([{ name: 'not what was written' }]),
          expectedRowCount: 1,
          store: backing,
          path: other,
        });
        return backing.read(`${other}/${ARCHIVE_PART_NAME}`);
      },
    };

    await expect(
      archiveSnapshot({
        type,
        snapshotId: 'snap-5',
        rows: streamOf([{ name: 'what was written' }]),
        expectedRowCount: 1,
        store: tampering,
        path,
      }),
    ).rejects.toThrow(/right number, and they do not hash to what was written/);
  });

  it('refuses a type with no properties rather than writing a file with no columns', async () => {
    const store = localArchiveStore(root);
    await expect(
      archiveSnapshot({
        type: typeOf([]),
        snapshotId: 'snap-6',
        rows: streamOf([]),
        expectedRowCount: 0,
        store,
        path: archivePathFor('empty', 'Subwo', 'snap-6'),
      }),
    ).rejects.toThrow(/has no properties/);
  });

  it('archives an empty snapshot as an empty archive rather than as nothing', async () => {
    // A snapshot with no rows is a real snapshot — a source that legitimately
    // emptied — and it has to be archivable, or the one load somebody wants to
    // explain later is the one with no record.
    const store = localArchiveStore(root);
    const type = typeOf([{ name: 'name', type: 'string' }]);
    const path = archivePathFor('none', type.name, 'snap-7');
    const ref = await archiveSnapshot({
      type,
      snapshotId: 'snap-7',
      rows: streamOf([]),
      expectedRowCount: 0,
      store,
      path,
    });
    expect(ref.rowCount).toBe(0);
    expect(ref.verifiedAt).toBeTruthy();
  });

  /**
   * The memory bound, observed rather than asserted about. With a row group
   * smaller than the dataset the sink is appended to more than once, which is
   * the only externally visible evidence that the encoder is flushing as it goes
   * instead of building the file and handing it over at the end.
   */
  it('streams to the sink in chunks rather than building the file first', async () => {
    const backing = localArchiveStore(root);
    const appends: number[] = [];
    const observing: ArchiveStore = {
      put: (at, bytes) => backing.put(at, bytes),
      read: (at) => backing.read(at),
      async open(at): Promise<ArchiveSink> {
        const sink = await backing.open(at);
        return {
          async append(chunk) {
            appends.push(chunk.byteLength);
            await sink.append(chunk);
          },
          finish: () => sink.finish(),
          abort: () => sink.abort(),
        };
      },
    };

    const type = typeOf([{ name: 'name', type: 'string' }]);
    const rows = Array.from({ length: 5_000 }, (_unused, index) => ({ name: `row ${index}` }));
    const path = archivePathFor('chunked', type.name, 'snap-8');
    await archiveSnapshot({
      type,
      snapshotId: 'snap-8',
      rows: streamOf(rows),
      expectedRowCount: rows.length,
      store: observing,
      path,
      rowGroupRows: 500,
    });

    // Ten row groups, so the bytes left in more than one piece.
    expect(appends.length).toBeGreaterThan(1);
  });
});
