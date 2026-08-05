import { describe, expect, it } from 'vitest';
import * as governance from './entities/governance';
import * as model from './entities/model';
import * as pipeline from './entities/pipeline';
import * as workspace from './entities/workspace';
import { MARKER_TABLE, catalogManagedTables } from './schema';

/**
 * That every table this package owns is on the list of tables it owns.
 *
 * `catalogManagedTables()` is what a host feeds its migration differ's skip
 * list, and `ensureCatalogSchema` creates exactly what the same private list
 * names. Both consequences of leaving an entity off are silent and neither is
 * small: the table is never created, so the first read dies on missing metadata;
 * and the host's differ, told nothing about it, sees a table no entity of its own
 * accounts for and drops it. `tableNameOf` already refuses to *guess* a name for
 * that reason — this is the other half, which is remembering to ask.
 *
 * Written while adding `catalog_revision`, and written as a sweep rather than as
 * an assertion about that one table, because the failure is a hand-maintained
 * list falling behind the files it lists — a list that drops one name drops its
 * neighbours too. The barrel spec next door guards `catalogStoreEntities` the
 * same way and would have caught nothing here: the two lists are separate, and
 * an entity can be in one and not the other.
 *
 * By the `*Row` suffix every entity in this package is named with, matching the
 * barrel sweep, and deliberately not by asking MikroORM: its metadata is
 * assembled at discovery, which is the step being skipped when a class is
 * missing from a list.
 */

const ENTITIES = [governance, model, pipeline, workspace].flatMap((module_) =>
  Object.values(module_).filter(
    (value): value is { name: string } => typeof value === 'function' && value.name.endsWith('Row'),
  ),
);

describe('catalogManagedTables', () => {
  it('names a table for every entity this package defines', () => {
    expect(ENTITIES.length).toBeGreaterThan(0);
    // The count, not just the membership: a name arriving for an entity that no
    // longer exists is the same list going stale in the other direction.
    expect(catalogManagedTables()).toHaveLength(ENTITIES.length);
  });

  it('names the revision table, which is the newest thing a differ could drop', () => {
    // Spelled out as well as swept. This table holds the only surviving copy of
    // code that a recorded run executed, so a differ dropping it is the one
    // deletion in this schema that cannot be recovered by re-running a load.
    expect(catalogManagedTables()).toContain('catalog_revision');
  });

  it('leaves out the marker table, which manages the rest', () => {
    // Unchanged, and asserted here because the sweep above would happily pass
    // with it added — the marker has no entity, so it would only ever show up as
    // a name too many.
    expect(catalogManagedTables()).not.toContain(MARKER_TABLE);
  });
});
