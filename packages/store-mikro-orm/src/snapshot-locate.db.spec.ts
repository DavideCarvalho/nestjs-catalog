import type { CatalogObjectTypeDef, CatalogPropertyDef } from '@dudousxd/nestjs-catalog';
import { supportsSnapshotLookup } from '@dudousxd/nestjs-catalog';
import type { StartedMySqlContainer } from '@testcontainers/mysql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CatalogDatabase, openCatalogDatabase, startMySql } from '../test/mysql-harness';

/**
 * What a snapshot id refers to, asked without being told the type.
 *
 * ## Why this is a method and not a `read`
 *
 * Because every other way of asking gives the same answer for three different
 * states. `read` pinned to an id no row carries returns `{ rows: [], total: 0 }`
 * — and so does a read of a snapshot that legitimately committed nothing, and so
 * does a read of one whose rows were dropped before that refusal existed. A
 * caller holding a string somebody typed into a graph needs those told apart
 * before it reads anything, because the failure of getting it wrong is an empty
 * load committed over a published type and a run that reports success.
 *
 * ## And why it is not scoped to a type
 *
 * `listSnapshots` answers "is it one of this type's" and cannot answer the case
 * somebody actually hits: an id copied out of one type's history and pasted
 * under another. "There is no such snapshot" sends a person hunting for
 * something that is sitting one type along. The cases below are the three
 * answers, and the fourth thing this must do — report a tombstone as a tombstone
 * rather than as an absence.
 */

function property(name: string, index: number): CatalogPropertyDef {
  return {
    name,
    displayName: name,
    type: 'string',
    columnName: name,
    nullable: index > 0,
    primary: index === 0,
    hidden: false,
    order: index,
    enriched: false,
  };
}

function typeNamed(name: string): CatalogObjectTypeDef {
  return {
    name,
    displayName: name,
    pluralDisplayName: `${name}s`,
    group: 'Locate',
    tableName: name.toLowerCase(),
    primaryKey: ['workOrderNumber'],
    properties: ['workOrderNumber', 'baseCode'].map(property),
    relations: [],
    enriched: false,
  };
}

function rows(ids: string[]): Array<Record<string, unknown>> {
  return ids.map((id) => ({ workOrderNumber: id, baseCode: 'B-21' }));
}

let container: StartedMySqlContainer;
let db: CatalogDatabase;

beforeAll(async () => {
  container = await startMySql();
  db = await openCatalogDatabase(container, 'catalog');
}, 300_000);

afterAll(async () => {
  await db?.close();
  await container?.stop();
});

describe('locateSnapshot', () => {
  /** One committed load, under an id chosen by the caller. */
  async function loaded(name: string, snapshotId: string): Promise<CatalogObjectTypeDef> {
    const type = typeNamed(name);
    await db.publish(type);
    await db.store.write(type, rows(['a', 'b']), { snapshotId, principalId: 'loader' });
    await db.store.commit(type, snapshotId);
    return type;
  }

  it('is offered by this store, so a caller can ask for it by probing', () => {
    // The whole ecosystem discovers optional store abilities structurally. A
    // store that has the method and is not recognised by the guard is a store
    // whose caller silently takes the degraded path.
    expect(supportsSnapshotLookup(db.store)).toBe(true);
  });

  it('finds a snapshot and says which type it belongs to', async () => {
    await loaded('LocateFound', 'locate-found-1');
    const found = await db.store.locateSnapshot('locate-found-1');
    expect(found).toHaveLength(1);
    expect(found[0].typeName).toBe('LocateFound');
    expect(found[0].snapshot.id).toBe('locate-found-1');
    expect(found[0].snapshot.rowCount).toBe(2);
  });

  it('answers empty for an id nothing carries, which is how "not found" is told from "empty"', async () => {
    await loaded('LocateAbsent', 'locate-absent-1');
    expect(await db.store.locateSnapshot('locate-absent-nope')).toEqual([]);
  });

  it('reports a tombstone rather than reporting nothing', async () => {
    // The record survives a drop on purpose. A locator that could not see it
    // would report a dropped load as one that never existed — two states with
    // completely different repairs.
    const type = await loaded('LocateDropped', 'locate-dropped-1');
    await db.store.write(type, rows(['a']), { snapshotId: 'locate-dropped-2', principalId: 'l' });
    await db.store.commit(type, 'locate-dropped-2');
    await db.store.dropSnapshot(type, 'locate-dropped-1');

    const found = await db.store.locateSnapshot('locate-dropped-1');
    expect(found).toHaveLength(1);
    expect(found[0].snapshot.droppedAt).toBeDefined();
    // The count taken immediately before the rows went, which is the last moment
    // that number exists.
    expect(found[0].snapshot.rowCount).toBe(2);
  });

  it('reports every type carrying the id, because a run id is shared across types', async () => {
    // A durable run that loads two types passes its run id to both, so two rows
    // legitimately carry one id. Answering with one of them would be answering
    // with a coin toss.
    await loaded('LocateSharedA', 'one-run-two-types');
    await loaded('LocateSharedB', 'one-run-two-types');

    const found = await db.store.locateSnapshot('one-run-two-types');
    expect(found.map((each) => each.typeName).sort()).toEqual(['LocateSharedA', 'LocateSharedB']);
  });
});
