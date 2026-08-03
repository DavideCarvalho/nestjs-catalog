import { randomUUID } from 'node:crypto';
import type {
  AuditQuery,
  CatalogAuditEvent,
  CatalogWorkspaceStore,
  Dashboard,
  DashboardCard,
  QueryVisualization,
  SaveQueryInput,
  SavedQuery,
} from '@dudousxd/nestjs-catalog';
import type { EntityManager } from '@mikro-orm/mysql';
import { Inject, Injectable } from '@nestjs/common';
import { CATALOG_STORE_ENTITY_MANAGER } from './context';
import { AuditEventRow, DashboardRow, SavedQueryRow } from './entities/workspace';

/**
 * Saved queries, dashboards and the audit trail.
 *
 * Separate from the warehouse store because the two answer to different
 * things: that one is shaped by whatever engine holds the rows, this one is
 * plain application state and would look identical on Postgres, on SQLite, or
 * in front of a column store that holds no application state at all.
 */
@Injectable()
export class MySqlWorkspaceStore implements CatalogWorkspaceStore {
  constructor(
    // By token, never positionally. The default connection is whichever one the
    // host registered first, and in a host with a database of its own that is
    // not this catalog's.
    @Inject(CATALOG_STORE_ENTITY_MANAGER)
    private readonly em: EntityManager,
  ) {}

  async listSavedQueries(): Promise<SavedQuery[]> {
    const em = this.em.fork();
    const rows = await em.find(SavedQueryRow, {}, { orderBy: { folder: 'asc', name: 'asc' } });
    return rows.map(toSavedQuery);
  }

  async getSavedQuery(id: string): Promise<SavedQuery | undefined> {
    const em = this.em.fork();
    const row = await em.findOne(SavedQueryRow, { id });
    return row ? toSavedQuery(row) : undefined;
  }

  async saveQuery(input: SaveQueryInput, createdBy: string): Promise<SavedQuery> {
    const em = this.em.fork();
    const row = em.create(SavedQueryRow, {
      id: randomUUID(),
      name: input.name,
      description: input.description,
      sql: input.sql,
      folder: input.folder,
      createdBy,
      cacheTtlSeconds: input.cacheTtlSeconds ?? 0,
      visualization: { ...(input.visualization ?? { kind: 'table' }) },
      shared: input.shared ?? false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    em.persist(row);
    await em.flush();
    return toSavedQuery(row);
  }

  async updateSavedQuery(
    id: string,
    input: Partial<SaveQueryInput>,
  ): Promise<SavedQuery | undefined> {
    const em = this.em.fork();
    const row = await em.findOne(SavedQueryRow, { id });
    if (!row) return undefined;

    if (input.name !== undefined) row.name = input.name;
    if (input.description !== undefined) row.description = input.description;
    if (input.sql !== undefined) row.sql = input.sql;
    if (input.folder !== undefined) row.folder = input.folder;
    if (input.cacheTtlSeconds !== undefined) {
      row.cacheTtlSeconds = input.cacheTtlSeconds;
    }
    if (input.visualization !== undefined) {
      row.visualization = { ...input.visualization };
    }
    if (input.shared !== undefined) row.shared = input.shared;
    await em.flush();
    return toSavedQuery(row);
  }

  async deleteSavedQuery(id: string): Promise<boolean> {
    const em = this.em.fork();
    const deleted = await em.nativeDelete(SavedQueryRow, { id });
    return deleted > 0;
  }

  async listDashboards(): Promise<Dashboard[]> {
    const em = this.em.fork();
    const rows = await em.find(DashboardRow, {}, { orderBy: { name: 'asc' } });
    return rows.map(toDashboard);
  }

  async getDashboard(id: string): Promise<Dashboard | undefined> {
    const em = this.em.fork();
    const row = await em.findOne(DashboardRow, { id });
    return row ? toDashboard(row) : undefined;
  }

  async saveDashboard(
    input: {
      name: string;
      description?: string;
      cards?: DashboardCard[];
      shared?: boolean;
    },
    createdBy: string,
  ): Promise<Dashboard> {
    const em = this.em.fork();
    const row = em.create(DashboardRow, {
      id: randomUUID(),
      name: input.name,
      description: input.description,
      createdBy,
      cards: (input.cards ?? []).map((card) => ({ ...card })),
      shared: input.shared ?? false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    em.persist(row);
    await em.flush();
    return toDashboard(row);
  }

  async updateDashboard(
    id: string,
    input: Partial<{
      name: string;
      description: string;
      cards: DashboardCard[];
      shared: boolean;
    }>,
  ): Promise<Dashboard | undefined> {
    const em = this.em.fork();
    const row = await em.findOne(DashboardRow, { id });
    if (!row) return undefined;

    if (input.name !== undefined) row.name = input.name;
    if (input.description !== undefined) row.description = input.description;
    if (input.cards !== undefined) {
      row.cards = input.cards.map((card) => ({ ...card }));
    }
    if (input.shared !== undefined) row.shared = input.shared;
    await em.flush();
    return toDashboard(row);
  }

  async deleteDashboard(id: string): Promise<boolean> {
    const em = this.em.fork();
    const deleted = await em.nativeDelete(DashboardRow, { id });
    return deleted > 0;
  }

  /**
   * Never throws.
   *
   * This is called from a diagnostics subscriber on the path of a real load. An
   * audit write that can fail a commit would make the trail the least reliable
   * part of the system while looking like the most.
   */
  async recordEvent(event: Omit<CatalogAuditEvent, 'id'>): Promise<void> {
    try {
      const em = this.em.fork();
      em.persist(
        em.create(AuditEventRow, {
          id: randomUUID(),
          event: event.event,
          typeName: event.typeName,
          principalId: event.principalId,
          snapshotId: event.snapshotId,
          detail: event.detail,
          occurredAt: new Date(event.occurredAt),
        }),
      );
      await em.flush();
    } catch {
      // Swallowed deliberately — see the docblock.
    }
  }

  async listEvents(query: AuditQuery): Promise<CatalogAuditEvent[]> {
    const em = this.em.fork();
    const where: Record<string, unknown> = {};
    if (query.event) where.event = query.event;
    if (query.typeName) where.typeName = query.typeName;
    if (query.principalId) where.principalId = query.principalId;
    if (query.since) where.occurredAt = { $gte: new Date(query.since) };

    const rows = await em.find(AuditEventRow, where, {
      orderBy: { occurredAt: 'desc' },
      limit: Math.min(Math.max(query.limit ?? 100, 1), 500),
    });
    return rows.map((row) => ({
      id: row.id,
      event: row.event,
      typeName: row.typeName,
      principalId: row.principalId,
      snapshotId: row.snapshotId,
      detail: row.detail,
      occurredAt: row.occurredAt.toISOString(),
    }));
  }
}

function toSavedQuery(row: SavedQueryRow): SavedQuery {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    sql: row.sql,
    folder: row.folder,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    cacheTtlSeconds: row.cacheTtlSeconds,
    shared: row.shared,
    visualization: normaliseVisualization(row.visualization),
  };
}

/** Stored as JSON, so it has to be re-checked rather than trusted. */
function normaliseVisualization(raw: unknown): QueryVisualization {
  const value = (raw ?? {}) as Record<string, unknown>;
  const kind = value.kind;
  return {
    kind:
      kind === 'bar' || kind === 'line' || kind === 'area' || kind === 'number' ? kind : 'table',
    library: typeof value.library === 'string' ? value.library : undefined,
    labelColumn: typeof value.labelColumn === 'string' ? value.labelColumn : undefined,
    valueColumns: Array.isArray(value.valueColumns)
      ? value.valueColumns.filter((c): c is string => typeof c === 'string')
      : undefined,
  };
}

function toDashboard(row: DashboardRow): Dashboard {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    shared: row.shared,
    cards: (row.cards ?? []).map((card, index) => ({
      id: String(card.id ?? `card-${index}`),
      savedQueryId: String(card.savedQueryId ?? ''),
      title: typeof card.title === 'string' ? card.title : undefined,
      width: [1, 2, 3, 4].includes(Number(card.width)) ? (Number(card.width) as 1 | 2 | 3 | 4) : 2,
      position: Number(card.position ?? index),
    })),
  };
}
