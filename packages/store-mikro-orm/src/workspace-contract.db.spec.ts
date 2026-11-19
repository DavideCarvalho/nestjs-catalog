import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe } from 'vitest';
import { describeWorkspaceStoreContract } from '../../../test/workspace-store-contract';
import {
  type PostgresCatalogDatabase,
  openPostgresCatalogDatabase,
  startPostgres,
} from '../test/postgres-harness';
import { MySqlWorkspaceStore } from './workspace.store';

/**
 * The shared workspace contract on the MikroORM store, on Postgres: the same
 * cases `@dudousxd/nestjs-catalog-store-drizzle` passes, so the two stores
 * cannot drift apart on what a saved query, a dashboard or a revision is.
 */
let container: StartedPostgreSqlContainer;
let db: PostgresCatalogDatabase;
/** Set while the forced-interleaving case holds writes at the flush. */
let hold: (() => Promise<void>) | undefined;

beforeAll(async () => {
  container = await startPostgres();
  db = await openPostgresCatalogDatabase(container, 'workspace_contract');
  // Forks share the ORM's event manager, so this sees every store fork's flush.
  db.em.getEventManager().registerSubscriber({
    beforeFlush: async () => {
      await hold?.();
    },
  });
}, 300_000);

afterAll(async () => {
  await db?.close();
  await container?.stop();
});

describe('the MikroORM workspace store', () => {
  describeWorkspaceStoreContract(() => ({
    name: 'mikro-orm (postgres)',
    store: new MySqlWorkspaceStore(db.em),
    holdWrites: (arrive) => {
      hold = arrive;
      return () => {
        hold = undefined;
      };
    },
  }));
});
