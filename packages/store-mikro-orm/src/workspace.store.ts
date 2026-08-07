import { randomUUID } from 'node:crypto';
import type {
  AuditQuery,
  CatalogAuditEvent,
  CatalogRevision,
  CatalogWorkspaceStore,
  Dashboard,
  DashboardCard,
  QueryVisualization,
  SaveQueryInput,
  SavedQuery,
} from '@dudousxd/nestjs-catalog';
import { CATALOG_REVISION_LIMIT } from '@dudousxd/nestjs-catalog';
import type { EntityManager } from '@mikro-orm/sql';
import { Inject, Injectable } from '@nestjs/common';
import { CATALOG_STORE_ENTITY_MANAGER } from './context';
import {
  AuditEventRow,
  DashboardRow,
  RevisionRow,
  type RevisionSubject,
  SavedQueryRow,
  revisionKey,
} from './entities/workspace';

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
    const now = new Date();
    const row = em.create(SavedQueryRow, {
      id: randomUUID(),
      name: input.name,
      description: input.description,
      sql: input.sql,
      version: 1,
      folder: input.folder,
      createdBy,
      cacheTtlSeconds: input.cacheTtlSeconds ?? 0,
      visualization: { ...(input.visualization ?? { kind: 'table' }) },
      shared: input.shared ?? false,
      createdAt: now,
      updatedAt: now,
    });
    em.persist(row);
    // The first statement is a revision like any other. Recorded at create
    // rather than only from the first edit onwards, so a query's history is
    // complete from the moment it exists — a list that starts at v2 would read
    // as though something had been lost.
    await recordRevision(em, {
      subject: 'saved-query',
      subjectId: row.id,
      version: 1,
      body: input.sql,
      authoredBy: createdBy,
      authoredAt: now,
    });
    await em.flush();
    return toSavedQuery(row);
  }

  /**
   * The version bumps, and the SQL is archived, only when the SQL changed.
   *
   * The same rule `saveTransform` applies to code, and it matters more under a
   * bounded archive than it did as a bare counter: a revision per save would
   * make renaming a query twenty times evict twenty statements that a report
   * actually ran.
   *
   * `authoredBy` on both revisions written here is the query's `createdBy` and
   * not whoever is editing. This method is given no actor — `CatalogService`
   * holds the one it audits with — and inventing a plausible name for a field a
   * reader will treat as evidence is worse than recording the one fact the row
   * does carry. See {@link CatalogRevision.authoredBy}.
   */
  async updateSavedQuery(
    id: string,
    input: Partial<SaveQueryInput>,
  ): Promise<SavedQuery | undefined> {
    const em = this.em.fork();
    const row = await em.findOne(SavedQueryRow, { id });
    if (!row) return undefined;

    // Read before anything is assigned: this is the statement being superseded,
    // and by the end of this method the row no longer holds it.
    const superseded = { version: row.version, sql: row.sql, at: row.updatedAt };
    const sqlChanged = input.sql !== undefined && input.sql !== row.sql;

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

    if (sqlChanged) {
      row.version = superseded.version + 1;
      // The one being replaced, first. A query that predates this table has
      // never had a revision written for it, and the only moment its live SQL is
      // still readable is this one — after the assignment above it is gone for
      // good. `recordRevision` leaves an already-recorded version alone, so on
      // every subsequent edit this call is a no-op.
      await recordRevision(em, {
        subject: 'saved-query',
        subjectId: row.id,
        version: superseded.version,
        body: superseded.sql,
        authoredBy: row.createdBy,
        authoredAt: superseded.at,
      });
      await recordRevision(em, {
        subject: 'saved-query',
        subjectId: row.id,
        version: row.version,
        body: row.sql,
        authoredBy: row.createdBy,
        authoredAt: new Date(),
      });
    }

    await em.flush();
    if (sqlChanged) await pruneRevisions(em, 'saved-query', row.id);
    return toSavedQuery(row);
  }

  listSavedQueryRevisions(id: string): Promise<CatalogRevision[]> {
    const em = this.em.fork();
    return readRevisions(em, 'saved-query', id, async () => {
      const row = await em.findOne(SavedQueryRow, { id });
      return row
        ? {
            version: row.version,
            body: row.sql,
            authoredBy: row.createdBy,
            authoredAt: row.updatedAt,
          }
        : undefined;
    });
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

/* ---------------------------------------------------------------------------
 * Revisions.
 *
 * Here, and exported, because ONE table holds the history of both things whose
 * text a person edits — a transform's code and a saved query's SQL — and it is
 * written by two stores. `MySqlPipelineStore` imports these rather than keeping
 * its own copy, which looks like an odd edge between two stores and is the point
 * of the arrangement: what a revision costs, when one is written and how many
 * are kept is a single policy, and two implementations of a policy is how one of
 * them ends up keeping fifty and the other five hundred.
 * ------------------------------------------------------------------------- */

/** What a subject's live text looks like when nothing has been recorded yet. */
export interface RevisionSubjectHead {
  version: number;
  body: string;
  authoredBy: string;
  authoredAt: Date;
}

/**
 * Stage one revision onto the caller's unit of work. Does **not** flush.
 *
 * Not flushing is the contract that matters: the caller persists the subject row
 * and this row into the same fork and flushes once, so a version and the text it
 * names are written together or not at all. A revision recorded by a second
 * transaction could be missing for the one save anybody ever asks about.
 *
 * **A version already recorded is left exactly as it is.** History that a later
 * save can rewrite is not history. The only way to reach that branch is a save
 * that did not change the text — which has nothing to record — or a backfill of
 * a version some earlier save already archived, which is the common case and is
 * meant to be a no-op.
 */
export async function recordRevision(
  em: EntityManager,
  input: {
    subject: RevisionSubject;
    subjectId: string;
    version: number;
    body: string;
    authoredBy: string;
    authoredAt: Date;
  },
): Promise<void> {
  const id = revisionKey(input.subject, input.subjectId, input.version);
  const existing = await em.findOne(RevisionRow, { id });
  if (existing) return;

  em.persist(
    em.create(RevisionRow, {
      id,
      subjectKind: input.subject,
      subjectId: input.subjectId,
      version: input.version,
      body: input.body,
      authoredBy: input.authoredBy,
      authoredAt: input.authoredAt,
    }),
  );
}

/**
 * Drop whatever the newest revision pushed past the cap. Returns how many went.
 *
 * Called **after** the caller's flush, deliberately, and not folded into
 * {@link recordRevision}: it has to count the revision that was just written, and
 * a prune inside the same unit of work would either not see it or have to guess
 * at it. If the process dies between the two, this subject sits one row over the
 * cap until its next save — which is the right failure to have, as against a
 * save that fails because a cleanup did.
 *
 * One bounded read and one delete. The read loads at most
 * `CATALOG_REVISION_LIMIT` rows to find the oldest version worth keeping, which
 * is why it asks for the version column alone: the bodies are the largest thing
 * in this table and a prune has no use for them.
 */
export async function pruneRevisions(
  em: EntityManager,
  subject: RevisionSubject,
  subjectId: string,
): Promise<number> {
  const kept = await em.find(
    RevisionRow,
    { subjectKind: subject, subjectId },
    { orderBy: { version: 'desc' }, limit: CATALOG_REVISION_LIMIT, fields: ['version'] },
  );
  // Under the cap there is nothing to drop, and the floor below would be the
  // oldest revision there is — deleting anything older than it is a no-op, but
  // asking is a statement nobody needs.
  if (kept.length < CATALOG_REVISION_LIMIT) return 0;
  const floor = kept[kept.length - 1]?.version;
  if (floor === undefined) return 0;

  return em.nativeDelete(RevisionRow, {
    subjectKind: subject,
    subjectId,
    version: { $lt: floor },
  });
}

/**
 * A subject's revisions, newest first — and what to answer with when it has
 * none.
 *
 * The second half is the upgrade path. Every transform and saved query already
 * in a database has text and no revision, so without this the feature would be
 * empty until somebody happened to edit something, and "compare this run with
 * what it ran" would answer nothing on the one deployment where somebody is
 * asking. So a subject with nothing recorded answers with its live text, at its
 * live version, **synthesised and not written**: a read that writes is a read
 * that can fail for a bookkeeping reason, which this codebase has already
 * refused once for sealed credentials.
 *
 * The synthesised revision is byte-for-byte what the backfill on the next save
 * will store — same derived id, same version, same body, same `createdBy`, same
 * `updatedAt` — so a screen does not see the list change underneath it when
 * somebody finally edits. That equivalence is pinned by a test rather than left
 * as an intention.
 */
export async function readRevisions(
  em: EntityManager,
  subject: RevisionSubject,
  subjectId: string,
  head: () => Promise<RevisionSubjectHead | undefined>,
): Promise<CatalogRevision[]> {
  const rows = await em.find(
    RevisionRow,
    { subjectKind: subject, subjectId },
    { orderBy: { version: 'desc' }, limit: CATALOG_REVISION_LIMIT },
  );
  if (rows.length > 0) return rows.map(toRevision);

  const live = await head();
  // No rows and no subject: the id names nothing. An empty list rather than a
  // 404 — the route above answers for a subject the caller already listed, and
  // "there is no history" is the same answer either way.
  if (!live) return [];
  return [
    {
      id: revisionKey(subject, subjectId, live.version),
      subjectId,
      version: live.version,
      body: live.body,
      authoredBy: live.authoredBy,
      authoredAt: live.authoredAt.toISOString(),
    },
  ];
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
