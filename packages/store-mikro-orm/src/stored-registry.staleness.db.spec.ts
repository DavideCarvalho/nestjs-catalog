// First, and a side-effect import on purpose — see the note in `mysql-harness.ts`.
import 'reflect-metadata';
import type { CatalogObjectTypeDef } from '@dudousxd/nestjs-catalog';
import {
  StoredCatalogRegistry,
  ensureCatalogSchema,
} from '@dudousxd/nestjs-catalog-store-mikro-orm';
import type { StartedMySqlContainer } from '@testcontainers/mysql';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type CatalogDatabase, openCatalogDatabase, startMySql } from '../test/mysql-harness';

/**
 * Two replicas over one catalog, against the engine that has to make them agree.
 *
 * `stored-registry.staleness.spec.ts` covers the JS side over a fake store: that
 * the check is started off the read path, at most once per window, single-flight,
 * and that a failed one keeps serving. What a fake cannot cover is the statement,
 * and here the statement is most of the design — four aggregates whose job is to
 * move whenever anything in the model moves. A fake answers from its own
 * contents whatever it is asked, so a `WATERMARK_SQL` that had stopped watching
 * `catalog_property`, or an `updated_at` MySQL never actually sets, passes every
 * case over there.
 *
 * So this file makes two registries over one database — which is what two pods
 * are — writes through one and reads the other. Each case names the write path
 * it uses, because they touch different tables and that is exactly the point:
 * a publish writes the type row, a curation edit writes only a property row, and
 * a committed load writes neither directly.
 */

let container: StartedMySqlContainer;
let db: CatalogDatabase;

function typeDef(name: string): CatalogObjectTypeDef {
  return {
    name,
    displayName: name,
    pluralDisplayName: `${name}s`,
    description: undefined,
    tableName: name.toLowerCase(),
    icon: undefined,
    group: 'default',
    titleProperty: undefined,
    primaryKey: ['id'],
    enriched: false,
    properties: [
      {
        name: 'id',
        displayName: 'Id',
        description: undefined,
        type: 'string',
        columnName: 'id',
        nullable: false,
        primary: true,
        hidden: false,
        order: 0,
        classification: undefined,
        unit: undefined,
        enriched: false,
      },
    ],
    relations: [],
  };
}

/**
 * A second process's registry over the same database.
 *
 * A short window so the cases do not spend their time waiting; the default is a
 * second, and nothing here depends on which it is.
 */
function sibling(): StoredCatalogRegistry {
  return new StoredCatalogRegistry(db.em, db.orm, { autoSchema: false, staleAfterMs: 20 });
}

/**
 * Wait until the second of the last write has closed.
 *
 * Not padding. `updated_at` is a `DATETIME`, so a watermark read inside the
 * second of its own newest write is provisional and the registry declines to
 * record it — which means a sibling that opened during that second would reload
 * on its next check whether or not anything had moved, and the case would prove
 * nothing about the aggregates. Waiting first makes the sibling's watermark one
 * it actually trusts, so the only thing that can make it look again is the write
 * the case then makes.
 */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 1_100));
}

/** How long a sibling is given to notice. Generously more than its window. */
const NOTICE = { timeout: 20_000, interval: 100 };

describe('two replicas over one catalog', () => {
  beforeAll(async () => {
    container = await startMySql();
    db = await openCatalogDatabase(container, 'staleness');
  }, 600_000);

  afterAll(async () => {
    await db?.close();
    await container?.stop();
  });

  it('serves a type the other replica published, having been told nothing', async () => {
    // THE case, and the incident it comes from: `PUT publish/:type/schema`
    // answered 200 from one pod, and a connector run moments later was told by
    // the other that the type had not been published. Nothing below passes a
    // message between the two registries — the database is the only thing they
    // share.
    await db.publish(typeDef('Mvr'));
    await settle();

    const replica = sibling();
    await replica.reload();
    expect(replica.getType('SchedMx')).toBeUndefined();

    await db.publish(typeDef('SchedMx'));

    await vi.waitFor(() => expect(replica.getType('SchedMx')).toBeDefined(), NOTICE);
  });

  it('notices a curation edit that wrote one property row and nothing else', async () => {
    // `patchProperty` renames one field. It flushes a `catalog_property` row and
    // leaves `catalog_object_type` byte-identical, so a watermark over the type
    // table alone would call this write invisible and the other replica would
    // keep serving the old label for the life of the process.
    //
    // This is also the case that proves `PropertyRow.updatedAt` exists in the
    // schema and that MySQL is really setting it: without the column there is no
    // `MAX(updated_at)` on `catalog_property` to move, and the statement would
    // fail outright.
    await db.publish(typeDef('Subwo'));
    await settle();

    const replica = sibling();
    await replica.reload();
    expect(replica.getType('Subwo')?.properties[0].displayName).toBe('Id');

    await db.registry.patchProperty(
      'Subwo',
      'id',
      { displayName: 'Registration number' },
      'curator',
    );

    await vi.waitFor(
      () => expect(replica.getType('Subwo')?.properties[0].displayName).toBe('Registration number'),
      NOTICE,
    );
  });

  it('notices a committed load, which the watermark never reads the history for', async () => {
    // A commit writes `catalog_snapshot` — the one table here that grows without
    // bound, and the one `servingSnapshots` goes to some length not to scan. The
    // watermark does not scan it either, and does not have to: committing sets
    // `ObjectTypeRow.currentSnapshotId`, so the type row is dirtied and
    // `catalog_object_type.updated_at` moves. This case is what keeps that
    // reasoning honest — it is the only reason the cheap statement is allowed to
    // ignore the expensive table.
    const type = typeDef('Utilization');
    await db.publish(type);
    await settle();

    const replica = sibling();
    await replica.reload();
    expect(replica.getType('Utilization')?.lastCommittedAt).toBeUndefined();

    await db.store.write(type, [{ id: 'a' }], { snapshotId: 's-1', principalId: 'loader' });
    await db.store.commit(type, 's-1');

    await vi.waitFor(
      () => expect(replica.getType('Utilization')?.lastCommittedAt).toBeDefined(),
      NOTICE,
    );
    expect(replica.getType('Utilization')?.rowCount).toBe(1);
  });

  it('leaves a replica that nothing has written to alone', async () => {
    // The other half of the bargain. A quiet catalog must not have every replica
    // rebuilding its model on a timer: the check is a watermark read, and an
    // unchanged watermark ends there. `version` counts rebuilds, so it is the
    // observable that says whether one happened.
    await db.publish(typeDef('Mel'));
    await settle();

    const replica = sibling();
    await replica.reload();
    const version = replica.getSnapshot().version;

    for (let i = 0; i < 20; i++) {
      replica.getSnapshot();
      replica.getType('Mel');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(replica.getSnapshot().version).toBe(version);
  });

  /**
   * Last, because it takes a column off the shared database and puts it back.
   */
  it('grows its column on a database that predates it, without touching the rows', async () => {
    // The question any schema change owes an answer to: what happens to a
    // deployment that is already running. `PropertyRow.updatedAt` is new, and the
    // watermark's second aggregate reads it — so if `autoSchema` could not apply
    // it to a live database, this whole mechanism would work on fresh
    // deployments and throw on every existing one.
    //
    // Half the argument is readable in `schema.ts` and is not re-proved here:
    // `fingerprintOf` hashes each scalar property's column name, type and
    // nullability, so adding one necessarily moves the fingerprint. (An
    // `@Index` would not, which is why none is declared.) The half that needs an
    // engine is what `schema.update({ safe: true })` then *does* to a populated
    // table, and that is what this runs.
    await db.publish(typeDef('Legacy'));
    // A deployment from before this shipped: no column, and a marker holding the
    // fingerprint of the schema that did not have one.
    await db.execute('ALTER TABLE catalog_property DROP COLUMN updated_at');
    await db.execute("UPDATE catalog_schema_meta SET fingerprint = 'before' WHERE id = 'catalog'");

    await ensureCatalogSchema(db.orm);

    const [row] = rowsOf(
      await db.execute("SELECT updated_at FROM catalog_property WHERE id = 'Legacy.id'"),
    );
    // The row survived, and its new column is NULL. Initialisers and `onCreate`
    // run for rows this process constructs, never for rows already in the table
    // — so a non-null column here would have been a default nobody chose, and
    // `MAX()` ignoring nulls is what makes the absence harmless.
    expect(row).toBeDefined();
    expect(Reflect.get(Object(row), 'updated_at')).toBeNull();

    // And the watermark, which selects that column, still answers — which is the
    // only thing the upgraded deployment actually needs.
    const replica = sibling();
    await replica.reload();
    expect(replica.getType('Legacy')).toBeDefined();

    await settle();
    await db.registry.patchProperty('Legacy', 'id', { displayName: 'Filled in' }, 'curator');
    await vi.waitFor(
      () => expect(replica.getType('Legacy')?.properties[0].displayName).toBe('Filled in'),
      NOTICE,
    );
  });
});

/** Raw driver rows, guarded rather than asserted. */
function rowsOf(result: unknown): unknown[] {
  return Array.isArray(result) ? result : [];
}
