import { randomUUID } from 'node:crypto';
import {
  type AuditQuery,
  CATALOG_REVISION_LIMIT,
  type CatalogAuditEvent,
  type CatalogRevision,
  type CatalogWorkspaceStore,
  type Dashboard,
  type DashboardCard,
  type DashboardSummary,
  type QueryVisualization,
  type SaveQueryInput,
  type SavedQuery,
  type SavedQuerySummary,
} from '@dudousxd/nestjs-catalog';
import { type SQL, and, asc, desc, eq, gte, inArray, lt } from 'drizzle-orm';
import {
  type CatalogDrizzleConnection,
  type CatalogDrizzleDatabase,
  type CatalogDrizzleRun,
  catalogDrizzleRunner,
} from './connection';
import {
  type CatalogDrizzleTableOptions,
  type CatalogDrizzleTables,
  type CatalogRevisionSubject,
  catalogDrizzleTables,
  catalogRevisionKey,
} from './schema';

export type CatalogDrizzleStoreOptions = CatalogDrizzleConnection & CatalogDrizzleTableOptions;

type SavedQueryRow = CatalogDrizzleTables['savedQuery']['$inferSelect'];
type DashboardRow = CatalogDrizzleTables['dashboard']['$inferSelect'];
type RevisionRow = CatalogDrizzleTables['revision']['$inferSelect'];

/**
 * Saved queries, dashboards, their revisions and the audit trail, on Drizzle
 * and Postgres.
 *
 * Holds the same behaviour as the MikroORM `MySqlWorkspaceStore`, and the shared
 * contract in `test/workspace-store-contract.ts` runs both: the version bumps
 * only when the SQL changes, the superseded statement is archived before it is
 * overwritten, at most `CATALOG_REVISION_LIMIT` revisions are kept per subject,
 * and `recordEvent` never throws.
 *
 * Every method runs as one unit of work through the connection's runner, so a
 * host that wraps its transactions (to set row-security context, or to refuse
 * any other path) sees every statement this store issues.
 */
export class DrizzleWorkspaceStore implements CatalogWorkspaceStore {
  private readonly run: CatalogDrizzleRun;
  private readonly t: CatalogDrizzleTables;

  constructor(options: CatalogDrizzleStoreOptions) {
    this.run = catalogDrizzleRunner(options);
    this.t = catalogDrizzleTables(options);
  }

  listSavedQueries(): Promise<SavedQuery[]> {
    const q = this.t.savedQuery;
    return this.run(async (db) => {
      const rows = await db.select().from(q).orderBy(asc(q.folder), asc(q.name));
      return rows.map(toSavedQuery);
    });
  }

  listSavedQuerySummaries(): Promise<SavedQuerySummary[]> {
    const q = this.t.savedQuery;
    return this.run(async (db) => {
      const rows = await db
        .select({ id: q.id, name: q.name, description: q.description, folder: q.folder })
        .from(q)
        .orderBy(asc(q.folder), asc(q.name));
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description ?? undefined,
        folder: row.folder ?? undefined,
      }));
    });
  }

  getSavedQuery(id: string): Promise<SavedQuery | undefined> {
    return this.run(async (db) => {
      const row = await this.findSavedQuery(db, id);
      return row ? toSavedQuery(row) : undefined;
    });
  }

  async getSavedQueries(ids: readonly string[]): Promise<SavedQuery[]> {
    if (ids.length === 0) return [];
    const q = this.t.savedQuery;
    return this.run(async (db) => {
      const rows = await db
        .select()
        .from(q)
        .where(inArray(q.id, [...ids]));
      return rows.map(toSavedQuery);
    });
  }

  saveQuery(input: SaveQueryInput, createdBy: string): Promise<SavedQuery> {
    return this.run(async (db) => {
      const now = new Date();
      const [row] = await db
        .insert(this.t.savedQuery)
        .values({
          id: randomUUID(),
          name: input.name,
          description: input.description ?? null,
          sql: input.sql,
          version: 1,
          folder: input.folder ?? null,
          createdBy,
          cacheTtlSeconds: input.cacheTtlSeconds ?? 0,
          visualization: { ...(input.visualization ?? { kind: 'table' }) },
          shared: input.shared ?? false,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!row) throw new Error('The saved query insert returned no row.');
      // The first statement is a revision like any other, so a query's history
      // is complete from the moment it exists.
      await recordRevision(db, this.t, {
        subject: 'saved-query',
        subjectId: row.id,
        version: 1,
        body: input.sql,
        authoredBy: createdBy,
        authoredAt: now,
      });
      return toSavedQuery(row);
    });
  }

  /**
   * The version bumps, and the SQL is archived, only when the SQL changed. The
   * superseded statement is recorded first, because after this update it is
   * gone. `authoredBy` on both revisions is the query's `createdBy`: the store
   * is given no actor and does not invent one.
   */
  updateSavedQuery(id: string, input: Partial<SaveQueryInput>): Promise<SavedQuery | undefined> {
    const q = this.t.savedQuery;
    return this.run(async (db) => {
      const row = await this.findSavedQuery(db, id, true);
      if (!row) return undefined;

      const patch = savedQueryPatch(input);
      if (Object.keys(patch).length === 0) return toSavedQuery(row);

      const sqlChanged = input.sql !== undefined && input.sql !== row.sql;
      const now = new Date();
      if (sqlChanged) patch.version = row.version + 1;
      patch.updatedAt = now;

      if (sqlChanged && input.sql !== undefined) {
        await recordRevision(db, this.t, {
          subject: 'saved-query',
          subjectId: row.id,
          version: row.version,
          body: row.sql,
          authoredBy: row.createdBy,
          authoredAt: row.updatedAt,
        });
        await recordRevision(db, this.t, {
          subject: 'saved-query',
          subjectId: row.id,
          version: row.version + 1,
          body: input.sql,
          authoredBy: row.createdBy,
          authoredAt: now,
        });
      }

      const [updated] = await db.update(q).set(patch).where(eq(q.id, id)).returning();
      if (!updated) return undefined;
      if (sqlChanged) await pruneRevisions(db, this.t, 'saved-query', id);
      return toSavedQuery(updated);
    });
  }

  listSavedQueryRevisions(id: string): Promise<CatalogRevision[]> {
    return this.run((db) =>
      readRevisions(db, this.t, 'saved-query', id, async () => {
        const row = await this.findSavedQuery(db, id);
        return row
          ? {
              version: row.version,
              body: row.sql,
              authoredBy: row.createdBy,
              authoredAt: row.updatedAt,
            }
          : undefined;
      }),
    );
  }

  deleteSavedQuery(id: string): Promise<boolean> {
    const q = this.t.savedQuery;
    return this.run(async (db) => {
      const deleted = await db.delete(q).where(eq(q.id, id)).returning({ id: q.id });
      return deleted.length > 0;
    });
  }

  listDashboards(): Promise<Dashboard[]> {
    const d = this.t.dashboard;
    return this.run(async (db) => {
      const rows = await db.select().from(d).orderBy(asc(d.name));
      return rows.map(toDashboard);
    });
  }

  listDashboardSummaries(): Promise<DashboardSummary[]> {
    const d = this.t.dashboard;
    return this.run(async (db) => {
      const rows = await db
        .select({ id: d.id, name: d.name, description: d.description })
        .from(d)
        .orderBy(asc(d.name));
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description ?? undefined,
      }));
    });
  }

  getDashboard(id: string): Promise<Dashboard | undefined> {
    const d = this.t.dashboard;
    return this.run(async (db) => {
      const [row] = await db.select().from(d).where(eq(d.id, id)).limit(1);
      return row ? toDashboard(row) : undefined;
    });
  }

  saveDashboard(
    input: { name: string; description?: string; cards?: DashboardCard[]; shared?: boolean },
    createdBy: string,
  ): Promise<Dashboard> {
    return this.run(async (db) => {
      const now = new Date();
      const [row] = await db
        .insert(this.t.dashboard)
        .values({
          id: randomUUID(),
          name: input.name,
          description: input.description ?? null,
          createdBy,
          cards: (input.cards ?? []).map((card) => ({ ...card })),
          shared: input.shared ?? false,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!row) throw new Error('The dashboard insert returned no row.');
      return toDashboard(row);
    });
  }

  updateDashboard(
    id: string,
    input: Partial<{ name: string; description: string; cards: DashboardCard[]; shared: boolean }>,
  ): Promise<Dashboard | undefined> {
    const d = this.t.dashboard;
    return this.run(async (db) => {
      const patch: Partial<DashboardRow> = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.description !== undefined) patch.description = input.description;
      if (input.cards !== undefined) patch.cards = input.cards.map((card) => ({ ...card }));
      if (input.shared !== undefined) patch.shared = input.shared;
      if (Object.keys(patch).length === 0) {
        const [row] = await db.select().from(d).where(eq(d.id, id)).limit(1);
        return row ? toDashboard(row) : undefined;
      }
      patch.updatedAt = new Date();
      const [row] = await db.update(d).set(patch).where(eq(d.id, id)).returning();
      return row ? toDashboard(row) : undefined;
    });
  }

  deleteDashboard(id: string): Promise<boolean> {
    const d = this.t.dashboard;
    return this.run(async (db) => {
      const deleted = await db.delete(d).where(eq(d.id, id)).returning({ id: d.id });
      return deleted.length > 0;
    });
  }

  /**
   * Never throws. It is called on the path of a real load, and an audit write
   * that could fail a commit would make the trail the least reliable part of
   * the system while looking like the most.
   */
  async recordEvent(event: Omit<CatalogAuditEvent, 'id'>): Promise<void> {
    try {
      await this.run(async (db) => {
        await db.insert(this.t.auditEvent).values({
          id: randomUUID(),
          event: event.event,
          typeName: event.typeName ?? null,
          principalId: event.principalId ?? null,
          snapshotId: event.snapshotId ?? null,
          detail: event.detail ?? {},
          occurredAt: new Date(event.occurredAt),
        });
      });
    } catch {
      // Swallowed deliberately, see the docblock.
    }
  }

  listEvents(query: AuditQuery): Promise<CatalogAuditEvent[]> {
    const a = this.t.auditEvent;
    return this.run(async (db) => {
      const where: SQL[] = [];
      if (query.event) where.push(eq(a.event, query.event));
      if (query.typeName) where.push(eq(a.typeName, query.typeName));
      if (query.principalId) where.push(eq(a.principalId, query.principalId));
      if (query.since) where.push(gte(a.occurredAt, new Date(query.since)));
      const rows = await db
        .select()
        .from(a)
        .where(where.length > 0 ? and(...where) : undefined)
        .orderBy(desc(a.occurredAt))
        .limit(Math.min(Math.max(query.limit ?? 100, 1), 500));
      return rows.map((row) => ({
        id: row.id,
        event: row.event,
        typeName: row.typeName ?? undefined,
        principalId: row.principalId ?? undefined,
        snapshotId: row.snapshotId ?? undefined,
        detail: row.detail ?? {},
        occurredAt: row.occurredAt.toISOString(),
      }));
    });
  }

  private async findSavedQuery(
    db: CatalogDrizzleDatabase,
    id: string,
    forUpdate = false,
  ): Promise<SavedQueryRow | undefined> {
    const q = this.t.savedQuery;
    const select = db.select().from(q).where(eq(q.id, id)).limit(1);
    // Locked on the edit path, so two concurrent edits of one query cannot both
    // read version N and both write N + 1 with different text.
    const [row] = forUpdate ? await select.for('update') : await select;
    return row;
  }
}

/* ---------------------------------------------------------------------------
 * Revisions. Exported because the revision table holds the history of every
 * subject a person edits (saved queries here, transforms and reusable nodes in
 * the pipeline store), and one retention policy is written once.
 * ------------------------------------------------------------------------- */

export interface RevisionSubjectHead {
  version: number;
  body: string;
  authoredBy: string;
  authoredAt: Date;
}

/** Record one revision. A version already recorded is left exactly as it is. */
export async function recordRevision(
  db: CatalogDrizzleDatabase,
  tables: CatalogDrizzleTables,
  input: {
    subject: CatalogRevisionSubject;
    subjectId: string;
    version: number;
    body: string;
    authoredBy: string;
    authoredAt: Date;
  },
): Promise<void> {
  await db
    .insert(tables.revision)
    .values({
      id: catalogRevisionKey(input.subject, input.subjectId, input.version),
      subjectKind: input.subject,
      subjectId: input.subjectId,
      version: input.version,
      body: input.body,
      authoredBy: input.authoredBy,
      authoredAt: input.authoredAt,
    })
    .onConflictDoNothing({ target: tables.revision.id });
}

/** Drop what the newest revision pushed past `CATALOG_REVISION_LIMIT`. Returns how many went. */
export async function pruneRevisions(
  db: CatalogDrizzleDatabase,
  tables: CatalogDrizzleTables,
  subject: CatalogRevisionSubject,
  subjectId: string,
): Promise<number> {
  const r = tables.revision;
  const kept = await db
    .select({ version: r.version })
    .from(r)
    .where(and(eq(r.subjectKind, subject), eq(r.subjectId, subjectId)))
    .orderBy(desc(r.version))
    .limit(CATALOG_REVISION_LIMIT);
  if (kept.length < CATALOG_REVISION_LIMIT) return 0;
  const floor = kept[kept.length - 1]?.version;
  if (floor === undefined) return 0;
  const deleted = await db
    .delete(r)
    .where(and(eq(r.subjectKind, subject), eq(r.subjectId, subjectId), lt(r.version, floor)))
    .returning({ id: r.id });
  return deleted.length;
}

/**
 * A subject's revisions, newest first. A subject with nothing recorded answers
 * with its live text at its live version, synthesised and not written: the same
 * row the next save would backfill.
 */
export async function readRevisions(
  db: CatalogDrizzleDatabase,
  tables: CatalogDrizzleTables,
  subject: CatalogRevisionSubject,
  subjectId: string,
  head: () => Promise<RevisionSubjectHead | undefined>,
): Promise<CatalogRevision[]> {
  const r = tables.revision;
  const rows = await db
    .select()
    .from(r)
    .where(and(eq(r.subjectKind, subject), eq(r.subjectId, subjectId)))
    .orderBy(desc(r.version))
    .limit(CATALOG_REVISION_LIMIT);
  if (rows.length > 0) return rows.map(toRevision);

  const live = await head();
  if (!live) return [];
  return [
    {
      id: catalogRevisionKey(subject, subjectId, live.version),
      subjectId,
      version: live.version,
      body: live.body,
      authoredBy: live.authoredBy,
      authoredAt: live.authoredAt.toISOString(),
    },
  ];
}

/** The columns an edit sets: only the fields the input names. */
function savedQueryPatch(input: Partial<SaveQueryInput>): Partial<SavedQueryRow> {
  const patch: Partial<SavedQueryRow> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  if (input.sql !== undefined) patch.sql = input.sql;
  if (input.folder !== undefined) patch.folder = input.folder;
  if (input.cacheTtlSeconds !== undefined) patch.cacheTtlSeconds = input.cacheTtlSeconds;
  if (input.visualization !== undefined) patch.visualization = { ...input.visualization };
  if (input.shared !== undefined) patch.shared = input.shared;
  return patch;
}

function toRevision(row: RevisionRow): CatalogRevision {
  return {
    id: row.id,
    subjectId: row.subjectId,
    version: row.version,
    body: row.body,
    authoredBy: row.authoredBy,
    authoredAt: row.authoredAt.toISOString(),
  };
}

function toSavedQuery(row: SavedQueryRow): SavedQuery {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    sql: row.sql,
    folder: row.folder ?? undefined,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    cacheTtlSeconds: row.cacheTtlSeconds,
    shared: row.shared,
    visualization: normaliseVisualization(row.visualization),
  };
}

/** Stored as JSON, so it has to be re-checked rather than trusted. */
export function normaliseVisualization(raw: unknown): QueryVisualization {
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
    description: row.description ?? undefined,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    shared: row.shared,
    cards: (row.cards ?? []).map((card, index) => ({
      id: String(card.id ?? `card-${index}`),
      savedQueryId: String(card.savedQueryId ?? ''),
      title: typeof card.title === 'string' ? card.title : undefined,
      library: typeof card.library === 'string' ? card.library : undefined,
      width: [1, 2, 3, 4].includes(Number(card.width)) ? (Number(card.width) as 1 | 2 | 3 | 4) : 2,
      position: Number(card.position ?? index),
    })),
  };
}
