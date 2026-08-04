import { type CatalogPrincipal, type WorkflowNode, mayWrite } from '@dudousxd/nestjs-catalog';
import { ForbiddenException } from '@nestjs/common';

/**
 * Who may cause a type to be written, asked on the pipeline's own surface.
 *
 * `mayWrite` used to be consulted in exactly one file — `publish.service.ts`,
 * the HTTP publish protocol — and nowhere on this side. Every route here read
 * `request.principal` for its **id** and nothing else, so a principal granted
 * `writeTypes: ["Mvr"]` could author a workflow whose sink commits `Subwo`,
 * attach a connector to it, press Run, and land a snapshot over somebody else's
 * type. Nothing lied on the way through: the graph validated, the run
 * succeeded, and `catalog_snapshot.principal_id` recorded the write as
 * perfectly authorised. That is the failure `writeTypes` exists to prevent, and
 * the reason it is per-type rather than one global `catalog:write` is written
 * out in `catalog.principal.ts` — a shared write path where every caller can
 * write every type means one application can quietly overwrite another's data.
 *
 * ## Save time *and* run time, and why it has to be both
 *
 * **Save time** is the gate that actually holds, because it is the only one the
 * scheduled path passes through. A cron-fired run carries `SCHEDULER_PRINCIPAL`
 * — a synthetic id, deliberately not a real principal, with no grants to
 * consult — so by the time a schedule fires there is nobody left to ask. The
 * question has to have been answered when the graph was written down.
 *
 * **Run time** is the gate that catches the case save time cannot see: a
 * workflow saved last month by a principal that could write `Subwo`, run today
 * by one that cannot. The artifact is legitimate and the run is not, and only
 * the run knows which principal pressed the button. A `commitAsSystem` at the
 * end of that run takes a `principalId: string` and checks nothing, by design —
 * it is the connector's identity for attribution, not an authorisation — so
 * without a check here the weaker principal's run commits exactly as the
 * stronger one's would.
 *
 * ## Where the checks stop
 *
 * At the HTTP boundary, because that is the last place a `CatalogPrincipal`
 * exists. A durable step input carries `principalId` as a bare string and there
 * is no resolver on the worker side to turn one back into grants; a check
 * deeper in would have to invent an identity model this library has spent
 * `CatalogPrincipalResolver` avoiding. So: the two save routes and the two run
 * routes, and the save routes are what make the schedule safe.
 */

/**
 * Every object type a graph would commit.
 *
 * Read off the sinks, all of them, rather than off the workflow row's
 * `targetType`. A graph may legally carry several sinks as long as they commit
 * *different* types — `validateWorkflow` refuses two sinks sharing one — while
 * `WorkflowRow.targetType` records only the first one found. Checking the row's
 * field would therefore authorise a two-sink graph on the strength of its first
 * sink and let the second write anywhere.
 *
 * Deduped, so a refusal names each type once.
 */
export function committedTypes(nodes: readonly WorkflowNode[]): string[] {
  const types: string[] = [];
  for (const node of nodes) {
    if (node.kind !== 'sink') continue;
    if (!types.includes(node.targetType)) types.push(node.targetType);
  }
  return types;
}

/**
 * Refuse unless this principal may write every one of them.
 *
 * Every refused type is named, not just the first. Somebody fixing grants on a
 * six-sink graph should need one round trip, not six.
 */
export function assertMayWriteTypes(
  principal: CatalogPrincipal,
  types: readonly string[],
  subject: string,
): void {
  const refused = types.filter((type) => !mayWrite(principal, type));
  if (refused.length === 0) return;
  throw new ForbiddenException(
    `${principal.id} may not write ${refused.join(', ')}, so ${subject} is refused. A workflow is authorised against the types its sinks commit, not against the person who drew it.`,
  );
}

/**
 * The principal a guard put on the request, or a loud failure.
 *
 * Shared by both controllers in this package rather than defined twice, now
 * that the pipeline routes need a principal for something other than a name to
 * write in a log. The throw is a plain `Error` on purpose: reaching here means
 * the host removed the guard from a route that declares `@RequireScopes`, which
 * is a deployment fault and not something a caller did.
 */
export function requirePrincipal(request: {
  principal?: CatalogPrincipal;
}): CatalogPrincipal {
  if (!request.principal) {
    throw new Error('CatalogPrincipalGuard did not run on a route that requires it.');
  }
  return request.principal;
}
