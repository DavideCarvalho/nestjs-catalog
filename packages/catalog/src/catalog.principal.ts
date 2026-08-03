/**
 * Who is talking to the catalog.
 *
 * Once more than one application reads and writes the same catalog, "which app
 * did this" stops being a logging concern and becomes part of the data. A
 * principal is therefore recorded onto every snapshot, not just checked at the
 * door: logs rotate, and the question "who loaded these rows" is asked months
 * later.
 *
 * There are two kinds of caller and they are not the same kind of thing. An
 * *application* acts on its own behalf — a nightly publisher has no human
 * behind it and must never be made to invent one. A *person* acts through an
 * application: someone signed into a console is still reaching the catalog as
 * that console, with that console's ceiling, and the console does not become
 * more powerful because an administrator happened to sign in. Both facts have
 * to survive into the audit trail, because "the console renamed this column" is
 * not an answer anybody accepts.
 */

export type CatalogScope =
  /** Read object metadata and rows. */
  | 'catalog:read'
  /** Load snapshots for the types this principal is granted. */
  | 'catalog:write'
  /** Edit labels, descriptions, units — the presentation layer. */
  | 'catalog:curate'
  /**
   * Fetch shared dashboards and charts through the embed API.
   *
   * Separate from `catalog:read` on purpose: an application that renders one
   * chart in its own UI needs nothing else, and giving it the whole catalog to
   * do that is the kind of over-grant nobody revisits.
   */
  | 'catalog:embed'
  /** Manage principals and grants. */
  | 'catalog:admin';

/** Every scope, in one place, so `catalog:admin` can be expanded exactly. */
const ALL_SCOPES: readonly CatalogScope[] = [
  'catalog:read',
  'catalog:write',
  'catalog:curate',
  'catalog:embed',
  'catalog:admin',
];

/**
 * The separator between the application half of a principal id and the person
 * on whose behalf it acted: `catalog-console#ana@example.com`.
 *
 * A composite string rather than a second column, because `principalId` is
 * already load-bearing in places this type cannot reach — it is a column on
 * every snapshot row, an index on the audit table, and the owner key that
 * decides which application may re-publish a type. Adding a parallel `actorId`
 * everywhere means every one of those readers has to be found and taught about
 * it, and the ones that are missed silently keep reporting a person's work as
 * the console's.
 *
 * The convention is chosen so that nothing already written has to change:
 * an id with no separator is exactly what it always was, an application acting
 * alone. Old rows parse correctly because they parse as themselves.
 *
 * `#` specifically because it cannot appear in an OIDC client id and does not
 * appear in a practical email address, so a round trip through
 * {@link composePrincipalId} and {@link parsePrincipalId} is lossless. Callers
 * that mint actor ids are expected to reject the separator rather than escape
 * it — an escaping scheme here would be a second thing to get wrong.
 */
export const PRINCIPAL_ACTOR_SEPARATOR = '#';

/**
 * The person behind a request, when there is one.
 *
 * Deliberately thin: an id and a name to show. Everything else about a human —
 * where their password lives, which directory they came from, what they are
 * allowed — is the host's business, and a library that started modelling users
 * would be a library that has opinions about your identity provider.
 */
export interface CatalogActor {
  /**
   * Stable login, e.g. an email address or an OIDC `sub`. It ends up inside
   * every `principalId` this actor's session produces, so it must be stable
   * across sessions and must not contain {@link PRINCIPAL_ACTOR_SEPARATOR}.
   */
  id: string;
  displayName?: string;
}

/** What a caller may do, independent of who the caller is. */
export interface CatalogGrants {
  scopes: CatalogScope[];
  writeTypes?: string[];
  readTypes?: string[];
  classifications?: string[];
}

/** A calling application, optionally acting for a person. */
export interface CatalogPrincipal {
  /**
   * Stable identifier, recorded onto every snapshot this principal writes.
   * With OIDC client credentials this is the token's `azp` — the client id.
   *
   * For a delegated principal this is the composite
   * `<applicationId>#<actor.id>`. Read it with {@link parsePrincipalId} rather
   * than comparing it whole: an equality check against an application id is
   * correct for machine callers and quietly false for every human one.
   */
  id: string;
  displayName?: string;
  /**
   * The application half of {@link id}, always set for a delegated principal.
   *
   * Carried explicitly as well as encoded in the id so live code never has to
   * re-parse a string it just built. Both are produced together by
   * {@link delegatePrincipal}, so they cannot drift; parsing is for rows read
   * back out of the database, where only the string survived.
   */
  applicationId?: string;
  /** The person this principal is acting for. Absent means a machine caller. */
  actor?: CatalogActor;
  scopes: CatalogScope[];
  /**
   * Object types this principal may load. `["*"]` for all.
   *
   * Per-type rather than a single global write scope on purpose: a shared write
   * path where every caller can write every type means one application can
   * quietly overwrite another's data, and the blast radius of a leaked
   * credential is the whole catalog.
   */
  writeTypes?: string[];
  /** Object types this principal may read. `["*"]` or undefined for all. */
  readTypes?: string[];
  /**
   * Classifications this principal may see. A column marked with anything
   * outside this list is dropped from its reads.
   *
   * Undefined means "no classified columns", not "all of them" — the safe
   * default for a caller nobody has thought about yet.
   */
  classifications?: string[];
}

/**
 * Turns a request into a principal.
 *
 * An interface rather than an implementation because the right answer depends
 * on infrastructure the library cannot see. An app that already runs an OIDC
 * provider should resolve the access token's `azp` and get rotation, expiry and
 * central revocation for free; building a table of long-lived API keys beside a
 * working identity provider is strictly worse.
 */
export interface CatalogPrincipalResolver {
  resolve(request: unknown): Promise<CatalogPrincipal | null>;
}

export const CATALOG_PRINCIPAL_RESOLVER = Symbol('CATALOG_PRINCIPAL_RESOLVER');

/**
 * A header-keyed resolver, for local development and for callers that live
 * outside the identity provider.
 *
 * Explicitly the lesser option. Keys here are long-lived, revoked only by
 * redeploying, and as good as their storage — prefer a token-based resolver
 * wherever there is an IdP to resolve against.
 */
export class StaticKeyPrincipalResolver implements CatalogPrincipalResolver {
  private readonly byKey: Map<string, CatalogPrincipal>;

  constructor(
    principals: Array<CatalogPrincipal & { key: string }>,
    private readonly header = 'x-catalog-key',
  ) {
    this.byKey = new Map(principals.map(({ key, ...principal }) => [key, principal]));
  }

  async resolve(request: unknown): Promise<CatalogPrincipal | null> {
    if (!request || typeof request !== 'object') return null;
    const headers = Reflect.get(request, 'headers');
    if (!headers || typeof headers !== 'object') return null;
    const presented = Reflect.get(headers, this.header);
    if (typeof presented !== 'string') return null;
    return this.byKey.get(presented) ?? null;
  }
}

export function hasScope(principal: CatalogPrincipal, scope: CatalogScope): boolean {
  return principal.scopes.includes(scope) || principal.scopes.includes('catalog:admin');
}

/** Builds the composite id. Returns the bare application id when nobody is behind it. */
export function composePrincipalId(applicationId: string, actorId?: string): string {
  if (!actorId) return applicationId;
  return `${applicationId}${PRINCIPAL_ACTOR_SEPARATOR}${actorId}`;
}

/**
 * Splits a recorded `principalId` back into its two halves.
 *
 * Total, and lenient by design: every id ever written parses, including the
 * millions written before actors existed. This is what lets a governance query
 * keep asking "everything this application did" — it matches on `applicationId`
 * and gets both the machine's own loads and anything a person did through it.
 *
 * Splits on the *first* separator, so an actor id that somehow contains one
 * still yields the right application rather than the right-hand fragment.
 */
export function parsePrincipalId(principalId: string): {
  applicationId: string;
  actorId?: string;
} {
  const at = principalId.indexOf(PRINCIPAL_ACTOR_SEPARATOR);
  if (at < 0) return { applicationId: principalId };
  const actorId = principalId.slice(at + PRINCIPAL_ACTOR_SEPARATOR.length);
  return {
    applicationId: principalId.slice(0, at),
    // A trailing separator with nothing after it is a malformed id, not an
    // actor named "". Treating it as a machine caller is the safer reading:
    // it under-claims attribution rather than inventing a person.
    actorId: actorId.length > 0 ? actorId : undefined,
  };
}

/**
 * `catalog:admin` written out.
 *
 * {@link hasScope} treats admin as implying everything, which is convenient at
 * a gate and actively wrong when two scope lists have to be *combined*: a naive
 * set intersection of `[catalog:admin]` with `[catalog:read]` is empty, and the
 * person who should have kept read access is locked out instead. Expand first,
 * intersect second.
 */
export function expandScopes(scopes: CatalogScope[]): CatalogScope[] {
  if (scopes.includes('catalog:admin')) return [...ALL_SCOPES];
  return [...scopes];
}

/**
 * A principal for a person acting through an application.
 *
 * Every grant is the **intersection** of the two, never the union, and that is
 * the whole point of this function. Signing in must not be a way to acquire
 * what the application could not do — otherwise the console's own key stops
 * being a ceiling and becomes decoration — and using the console must not be a
 * way to acquire what the person was not granted. Both failures look identical
 * from the outside: someone reads a table they were never meant to see, and
 * the audit trail records it as perfectly authorised.
 *
 * The consequence worth stating out loud: raising what people can do in a
 * console is an operator action on the console's *application* principal, not
 * something that happens because an administrator logged in.
 */
export function delegatePrincipal(
  application: CatalogPrincipal,
  actor: CatalogActor,
  grants: CatalogGrants,
): CatalogPrincipal {
  if (actor.id.includes(PRINCIPAL_ACTOR_SEPARATOR)) {
    throw new Error(
      `Actor id "${actor.id}" contains ${PRINCIPAL_ACTOR_SEPARATOR}, which would make its principal id ambiguous.`,
    );
  }

  const applicationId = application.applicationId ?? application.id;
  const appScopes = expandScopes(application.scopes);
  const actorScopes = expandScopes(grants.scopes);

  return {
    id: composePrincipalId(applicationId, actor.id),
    applicationId,
    actor,
    displayName: actor.displayName
      ? `${actor.displayName} via ${application.displayName ?? applicationId}`
      : applicationId,
    scopes: appScopes.filter((scope) => actorScopes.includes(scope)),
    // Absent means "nothing" on both sides — an unlisted type is a denied
    // write — so `["*"]` is the only way either side says "all of them".
    writeTypes: intersectAllowList(application.writeTypes, grants.writeTypes, 'none'),
    // Absent means "everything" here, matching `mayRead`. Preserving that
    // through the intersection is what keeps a plain reader from having to
    // enumerate every type that will ever exist.
    readTypes: intersectAllowList(application.readTypes, grants.readTypes, 'all'),
    // Classifications get a plain set intersection with no wildcard, because
    // `maySeeClassification` does not honour `"*"` — it asks for the exact
    // label. Emitting `["*"]` here would produce a principal that looks
    // all-seeing and can in fact see nothing classified at all.
    classifications: (application.classifications ?? []).filter((label) =>
      (grants.classifications ?? []).includes(label),
    ),
  };
}

/**
 * Intersects two allow-lists that both use `"*"` for "all", where an absent
 * list means `whenAbsent`.
 *
 * Returns `undefined` for "all" only when absence already means all on that
 * axis, so a read intersection stays in the compact `undefined` form that
 * `mayRead` understands rather than being expanded into a list that goes stale
 * the moment a new type is published.
 */
function intersectAllowList(
  a: string[] | undefined,
  b: string[] | undefined,
  whenAbsent: 'all' | 'none',
): string[] | undefined {
  const left = normaliseAllowList(a, whenAbsent);
  const right = normaliseAllowList(b, whenAbsent);

  // "Nothing" on either side settles it before anything else is considered:
  // intersecting with an empty set is empty whatever the other side says.
  if (left === 'none' || right === 'none') return [];

  // Each remaining test compares against the *same* variable it narrows.
  // Deciding "exactly one side is all" with a compound condition reads fine and
  // does not narrow — the compiler cannot carry `right !== "all"` out of an
  // earlier `left === "all" && right === "all"`, so the branch below it still
  // has `"all"` in its type and the function stops compiling.
  if (left === 'all') {
    if (right === 'all') return whenAbsent === 'all' ? undefined : ['*'];
    return right;
  }
  if (right === 'all') return left;
  return left.filter((name) => right.includes(name));
}

function normaliseAllowList(
  list: string[] | undefined,
  whenAbsent: 'all' | 'none',
): string[] | 'all' | 'none' {
  if (list === undefined) return whenAbsent;
  if (list.includes('*')) return 'all';
  if (list.length === 0) return 'none';
  return list;
}

function matches(list: string[] | undefined, typeName: string): boolean {
  if (!list) return false;
  return list.includes('*') || list.includes(typeName);
}

export function mayWrite(principal: CatalogPrincipal, typeName: string): boolean {
  return hasScope(principal, 'catalog:write') && matches(principal.writeTypes, typeName);
}

export function mayRead(principal: CatalogPrincipal, typeName: string): boolean {
  if (!hasScope(principal, 'catalog:read')) return false;
  // Undefined readTypes means every type, which is the useful default for a
  // read-only consumer. Write grants get no such default — see `writeTypes`.
  return principal.readTypes === undefined || matches(principal.readTypes, typeName);
}

/**
 * Whether a column is visible to this principal.
 *
 * Unclassified columns are visible to everyone; a classified one requires the
 * principal to name that classification. Absence is denial.
 */
export function maySeeClassification(
  principal: CatalogPrincipal,
  classification: string | undefined,
): boolean {
  if (!classification) return true;
  return principal.classifications?.includes(classification) ?? false;
}
