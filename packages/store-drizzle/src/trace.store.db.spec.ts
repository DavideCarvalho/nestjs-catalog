import { channel } from 'node:diagnostics_channel';
import { channelNameFor } from '@dudousxd/nestjs-catalog';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeTraceStoreContract } from '../../../test/trace-store-contract';
import { catalogDrizzleSql } from './ddl';
import { catalogDrizzleTables } from './schema';
import { CatalogDrizzleStoreModule } from './store.module';
import { DrizzleCatalogTraceStore } from './trace.store';
import { DrizzleWorkspaceStore } from './workspace.store';

/**
 * The trace store on Postgres, through the contract the MikroORM store passes on
 * MySQL, plus the recorder writing real channel events through the module.
 */
let container: StartedPostgreSqlContainer;
let pool: Pool;

const CONTRACT_PREFIX = 'trace_';
const MODULE_PREFIX = 'module_';

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('catalog')
    .withUsername('postgres')
    .withPassword('postgres')
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query(catalogDrizzleSql({ prefix: CONTRACT_PREFIX }));
  await pool.query(catalogDrizzleSql({ prefix: MODULE_PREFIX }));
}, 300_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe('the Drizzle trace store on Postgres', () => {
  describeTraceStoreContract(async () => {
    const db = drizzle(pool);
    const table = catalogDrizzleTables({ prefix: CONTRACT_PREFIX }).auditEvent;
    return {
      name: 'drizzle (postgres)',
      store: new DrizzleCatalogTraceStore({ db, prefix: CONTRACT_PREFIX }),
      insertEvents: async (rows) => {
        for (let at = 0; at < rows.length; at += 1_000) {
          await db.insert(table).values(
            rows.slice(at, at + 1_000).map((row) => ({
              ...row,
              occurredAt: new Date(row.occurredAt),
            })),
          );
        }
      },
      analyze: async () => {
        await pool.query(`ANALYZE "${CONTRACT_PREFIX}audit_event"`);
      },
    };
  });
});

describe('CatalogDrizzleStoreModule', () => {
  it('records published catalog events and reads them back as a trace', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [CatalogDrizzleStoreModule.forRoot({ db: drizzle(pool), prefix: MODULE_PREFIX })],
    }).compile();
    await moduleRef.init();
    try {
      const snapshotId = `snap-module-${Date.now()}`;
      const publish = (event: string, payload: Record<string, unknown>) =>
        channel(channelNameFor(event)).publish({ ts: Date.now(), payload });
      publish('connector.run.started', { snapshotId, typeName: 'Order', connectorId: 'c9' });
      publish('snapshot.committed', { snapshotId, typeName: 'Order', rowCount: 7 });
      publish('connector.run.finished', { snapshotId, typeName: 'Order', status: 'succeeded' });

      const traces = moduleRef.get(DrizzleCatalogTraceStore);
      let trace = await traces.getTrace(snapshotId);
      for (let tries = 0; tries < 50 && (trace?.spans.length ?? 0) < 3; tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        trace = await traces.getTrace(snapshotId);
      }
      expect(trace).toMatchObject({ outcome: 'succeeded', rowsCommitted: 7, typeName: 'Order' });
      expect(trace?.spans.map((span) => span.event)).toEqual([
        'connector.run.started',
        'snapshot.committed',
        'connector.run.finished',
      ]);
      expect(moduleRef.get(DrizzleWorkspaceStore)).toBeInstanceOf(DrizzleWorkspaceStore);
    } finally {
      await moduleRef.close();
    }
  });

  it('registers no recorder when audit is off', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        CatalogDrizzleStoreModule.forRoot({
          db: drizzle(pool),
          prefix: MODULE_PREFIX,
          audit: false,
        }),
      ],
    }).compile();
    await moduleRef.init();
    try {
      const snapshotId = `snap-silent-${Date.now()}`;
      channel(channelNameFor('connector.run.started')).publish({
        ts: Date.now(),
        payload: { snapshotId },
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await moduleRef.get(DrizzleCatalogTraceStore).getTrace(snapshotId)).toBeUndefined();
    } finally {
      await moduleRef.close();
    }
  });
});
