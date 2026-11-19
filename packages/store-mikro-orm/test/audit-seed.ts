import type { EntityManager } from '@mikro-orm/mysql';
import { type SeedEvent, type SeedShape, auditTrailRows } from '../../../test/audit-trail-rows';

export type { SeedShape };

/**
 * A deployment's worth of audit trail, written straight at the table.
 *
 * Not through `recordEvent`: this seeds tens of thousands of rows, and a fork
 * and a flush per row would make the fixture itself the slow part of a
 * measurement about the read path. What it does keep faithful is the *shape* —
 * the same column set, the same `detail` keys the recorder flattens payloads
 * into, the same handful of events per trace, and the same same-millisecond
 * bunching a fast load produces — because every one of those is something the
 * trace query reads.
 *
 * Deterministic: a fixed seed, so two runs of a benchmark measure the same
 * table and a difference between them is the code.
 */
export async function seedAuditTrail(em: EntityManager, shape: SeedShape): Promise<number> {
  const rows = auditTrailRows(shape);
  await insertAuditRows(em, rows);
  return rows.length;
}

/** `DATETIME(3)` text, which MySQL reads without a zone; the harness pins the session to UTC. */
function mysqlStamp(iso: string): string {
  return iso.slice(0, 23).replace('T', ' ');
}

/** Writes rows straight at the table, ids and times as given, in chunks of 500. */
export async function insertAuditRows(em: EntityManager, rows: SeedEvent[]): Promise<void> {
  const connection = em.getConnection();
  const CHUNK = 500;
  for (let at = 0; at < rows.length; at += CHUNK) {
    const chunk = rows.slice(at, at + CHUNK);
    await connection.execute(
      `INSERT INTO catalog_audit_event
         (id, event, type_name, principal_id, snapshot_id, detail, occurred_at)
       VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
      chunk.flatMap((row) => [
        row.id,
        row.event,
        row.typeName,
        row.principalId,
        row.snapshotId,
        JSON.stringify(row.detail),
        mysqlStamp(row.occurredAt),
      ]),
    );
  }
}
