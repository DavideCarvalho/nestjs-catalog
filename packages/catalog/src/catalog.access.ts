/**
 * Where the Access screen's two lists come from.
 *
 * The screen answers one question — "which application is allowed to touch
 * what, and which person is behind it" — but the two halves of that answer have
 * very different owners.
 *
 * *Applications* are the catalog's own. `catalog_principal` is a table this
 * library defines, the grants on it are catalog grants, and no host has a
 * pre-existing notion of "may load the `Vehicle` type". The library can and does
 * serve this half itself.
 *
 * *People* are almost never the catalog's. A catalog embedded in an application
 * is embedded in an application that already knows who its users are — an IdP, a
 * session table, an OIDC provider — and standing up a second user store beside
 * it is how you get two lists of employees that disagree about who was
 * offboarded. So this half is a seam: the host implements it over whatever it
 * already has, or it does not implement it and the screen says so.
 *
 * That asymmetry is why `listPeople` and `upsertPerson` are OPTIONAL while
 * `listApplications` is not. A directory that only knows about applications is a
 * complete, expected implementation, not a half-finished one.
 */

/** A calling application, as the Access screen needs it. */
export interface CatalogApplicationSummary {
  id: string;
  displayName: string;
  scopes: string[];
  writeTypes: string[];
  /** Null means every type — a safe default for read, unlike write. */
  readTypes: string[] | null;
  classifications: string[];
  active: boolean;
  /**
   * How it authenticates. Never the credential itself — a console that can
   * display one is a console that leaks it over somebody's shoulder.
   */
  authMethod: 'key' | 'token' | 'session';
  lastSeenAt: string | null;
  /**
   * Types whose publishing this application owns.
   *
   * Distinct from `writeTypes`, which is the grant. Ownership is what actually
   * decides a re-publish, so a screen showing only the grant can show an
   * application that appears able to load a type it will be refused on.
   */
  ownedTypes: string[];
}

export type CatalogPersonRole = 'viewer' | 'curator' | 'administrator';

/** A person: signs in, and acts through an application that caps them. */
export interface CatalogPersonSummary {
  email: string;
  displayName: string;
  role: CatalogPersonRole;
  active: boolean;
  /** Exactly the string their actions land in the audit trail as. */
  principalId: string;
  /**
   * Whether they can sign in with a password *here*.
   *
   * False is the normal answer for a host-backed directory, where signing in
   * happens somewhere this library never sees. It is not "no credential".
   */
  hasPassword: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  /** Sessions the host can see. `0` from a directory that does not track them. */
  liveSessions: number;
  /**
   * The intersection with the application they sign in through, not the role in
   * the abstract. An administrator whose console has had `catalog:admin`
   * removed is not an administrator, and showing the role alone would say
   * otherwise.
   */
  effective: {
    scopes: string[];
    writeTypes: string[];
    readTypes: string[] | null;
    classifications: string[];
  };
}

/** The bound the endpoint applies before the directory is asked. */
export interface CatalogDirectoryQuery {
  /**
   * Free text over whatever identifies a person to the host — email and display
   * name, typically. Absent means no filter, NOT "match nothing".
   */
  search?: string;
  /** Always present, always capped. See {@link CATALOG_DIRECTORY_MAX_PAGE}. */
  limit: number;
  offset: number;
}

/** The default page, when the caller asks for no particular one. */
export const CATALOG_DIRECTORY_PAGE = 50;

/**
 * The ceiling, whatever a caller asks for.
 *
 * A cap rather than a default that can be overridden without limit, because the
 * caller here is a browser and `?limit=100000` would be one URL away from the
 * unbounded read this exists to prevent.
 */
export const CATALOG_DIRECTORY_MAX_PAGE = 500;

export interface CatalogPeoplePage {
  people: CatalogPersonSummary[];
  /**
   * How many match, ignoring the page. The console needs it to say "50 of 1,340"
   * — a bounded list that cannot report what it is bounding is indistinguishable
   * from a complete one, and an operator reading it as complete will conclude
   * somebody has no access when they simply were not on the page.
   */
  total: number;
  limit: number;
  offset: number;
}

export interface CatalogPersonInput {
  email: string;
  displayName?: string;
  role: CatalogPersonRole;
  active?: boolean;
  password?: string;
}

export interface CatalogPersonUpsertResult {
  email: string;
  created: boolean;
  /**
   * Whether open sessions were invalidated. Surfaced because demoting somebody
   * whose tabs keep working is the failure that makes people distrust the whole
   * session system.
   */
  sessionsRevoked: boolean;
}

/**
 * The host's answer to "who may reach this catalog".
 *
 * Implement `listPeople` over the user store you already have. The three
 * fields worth care are `principalId` — it must be the exact string that
 * person's actions are recorded under, or the Activity screen attributes their
 * work to nobody — `role`, and `effective`, which is the role capped by the
 * application they sign in through rather than the role in the abstract.
 */
export interface CatalogDirectory {
  /**
   * Unpaged, and that is a claim about the data rather than an oversight:
   * applications are rows an operator creates by hand, one per publisher, and a
   * catalog with a thousand of them has a different problem than a missing
   * `LIMIT`. People are the opposite — see {@link listPeople}.
   */
  listApplications(): Promise<CatalogApplicationSummary[]>;
  /**
   * Omit when people come from somewhere this catalog cannot see. The endpoint
   * then refuses with a message naming this seam, which is a better answer than
   * an empty list: "nobody can sign in yet" and "we did not ask" send an
   * operator to completely different places, and the first invites them to
   * create an account that already exists.
   *
   * **The query is not advisory.** It is passed so the bound reaches the
   * database, not so the implementation can slice an array it already
   * materialised — an embedded catalog's user table is the host's whole
   * directory, and `SELECT *` over it is a screen that gets slower every time
   * somebody is hired. `total` is what lets the console say how much it is not
   * showing, which is the difference between a bounded list and a silently
   * truncated one.
   */
  listPeople?(query: CatalogDirectoryQuery): Promise<CatalogPeoplePage>;
  /**
   * Omit when the host's directory is not writable from here — which is the
   * common case, and the right one. Creating a user in the IdP from a catalog
   * console is a way to create a user the IdP does not know about.
   */
  upsertPerson?(input: CatalogPersonInput): Promise<CatalogPersonUpsertResult>;
}

export const CATALOG_DIRECTORY = Symbol('CATALOG_DIRECTORY');
