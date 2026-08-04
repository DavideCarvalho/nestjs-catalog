import { describe, expect, it } from 'vitest';
import {
  type CatalogPrincipal,
  type CatalogScope,
  PRINCIPAL_ACTOR_SEPARATOR,
  StaticKeyPrincipalResolver,
  composePrincipalId,
  delegatePrincipal,
  expandScopes,
  hasScope,
  mayRead,
  maySeeClassification,
  mayWrite,
  parsePrincipalId,
  readableObjectPage,
} from './catalog.principal';
import type { CatalogObjectPage } from './catalog.types';

function principal(overrides: Partial<CatalogPrincipal> = {}): CatalogPrincipal {
  return { id: 'console', scopes: [], ...overrides };
}

describe('hasScope', () => {
  it('grants a scope that was named', () => {
    expect(hasScope(principal({ scopes: ['catalog:read'] }), 'catalog:read')).toBe(true);
  });

  it('denies a scope that was not', () => {
    expect(hasScope(principal({ scopes: ['catalog:read'] }), 'catalog:write')).toBe(false);
  });

  // `catalog:admin` implying everything is what lets a gate ask one question.
  // A version that only compared the literal scope would lock an administrator
  // out of every route that names something more specific.
  it.each<CatalogScope>(['catalog:read', 'catalog:write', 'catalog:curate', 'catalog:embed'])(
    'treats catalog:admin as implying %s',
    (scope) => {
      expect(hasScope(principal({ scopes: ['catalog:admin'] }), scope)).toBe(true);
    },
  );

  it('denies everything to a principal holding no scopes at all', () => {
    expect(hasScope(principal(), 'catalog:read')).toBe(false);
  });
});

describe('expandScopes', () => {
  // The reason this exists at all: `hasScope` answers "admin implies read", but
  // a set intersection cannot ask it. Expanding first is what keeps the
  // delegated principal below from coming out empty.
  it('writes catalog:admin out into every scope', () => {
    expect(expandScopes(['catalog:admin']).sort()).toEqual(
      ['catalog:admin', 'catalog:curate', 'catalog:embed', 'catalog:read', 'catalog:write'].sort(),
    );
  });

  it('leaves a non-admin list alone', () => {
    expect(expandScopes(['catalog:read', 'catalog:embed'])).toEqual([
      'catalog:read',
      'catalog:embed',
    ]);
  });

  it('returns a copy, so expanding cannot edit the principal it read from', () => {
    const scopes: CatalogScope[] = ['catalog:read'];
    expandScopes(scopes).push('catalog:admin');
    expect(scopes).toEqual(['catalog:read']);
  });
});

describe('composePrincipalId / parsePrincipalId', () => {
  it('leaves the id bare when nobody is behind the application', () => {
    expect(composePrincipalId('catalog-console')).toBe('catalog-console');
  });

  // The whole compatibility argument: an id written before actors existed has
  // no separator, and must still parse as itself rather than as something with
  // an empty actor.
  it('parses a pre-actor id as an application acting alone', () => {
    expect(parsePrincipalId('nightly-publisher')).toEqual({ applicationId: 'nightly-publisher' });
  });

  it('round-trips an application acting for a person', () => {
    const id = composePrincipalId('catalog-console', 'ana@example.com');
    expect(id).toBe(`catalog-console${PRINCIPAL_ACTOR_SEPARATOR}ana@example.com`);
    expect(parsePrincipalId(id)).toEqual({
      applicationId: 'catalog-console',
      actorId: 'ana@example.com',
    });
  });

  // Splitting on the LAST separator, or on all of them, would answer this with
  // the fragment `ana` and attribute the work to an application that does not
  // exist — which is precisely what breaks "everything this application did".
  it('splits on the first separator, so a stray one stays inside the actor id', () => {
    expect(parsePrincipalId('catalog-console#ana#example.com')).toEqual({
      applicationId: 'catalog-console',
      actorId: 'ana#example.com',
    });
  });

  it('reads a trailing separator as a machine caller rather than an actor named ""', () => {
    expect(parsePrincipalId('catalog-console#')).toEqual({ applicationId: 'catalog-console' });
  });

  // Total by design. A governance query runs over every row ever written, and
  // one id that throws takes the whole report with it.
  it.each(['', '#', '##', '#ana', 'a b c', '#!@£'])('parses %o without throwing', (id) => {
    expect(() => parsePrincipalId(id)).not.toThrow();
  });

  it('attributes an id that begins with the separator to no application', () => {
    expect(parsePrincipalId('#ana')).toEqual({ applicationId: '', actorId: 'ana' });
  });
});

describe('delegatePrincipal', () => {
  const consoleApp = principal({
    id: 'catalog-console',
    displayName: 'Catalog Console',
    scopes: ['catalog:read', 'catalog:curate'],
    readTypes: ['Mvr', 'Subwo'],
    writeTypes: ['Mvr'],
    classifications: ['cui'],
  });

  it('records the composite id and both halves of it', () => {
    const delegated = delegatePrincipal(
      consoleApp,
      { id: 'ana@example.com', displayName: 'Ana' },
      { scopes: ['catalog:read'] },
    );
    expect(delegated.id).toBe('catalog-console#ana@example.com');
    expect(delegated.applicationId).toBe('catalog-console');
    expect(delegated.actor?.id).toBe('ana@example.com');
    expect(delegated.displayName).toBe('Ana via Catalog Console');
  });

  // Signing in must not be a way to acquire what the application could not do.
  // A union — or simply taking the actor's grants — passes every other test in
  // this file and fails this one.
  it('does not let a person exceed the application they came through', () => {
    const delegated = delegatePrincipal(
      consoleApp,
      { id: 'ana@example.com' },
      { scopes: ['catalog:read', 'catalog:write', 'catalog:admin'] },
    );
    expect(delegated.scopes).toEqual(['catalog:read', 'catalog:curate']);
    expect(hasScope(delegated, 'catalog:write')).toBe(false);
  });

  it('does not let an application exceed what the person was granted', () => {
    const delegated = delegatePrincipal(
      consoleApp,
      { id: 'ana@example.com' },
      { scopes: ['catalog:read'] },
    );
    expect(delegated.scopes).toEqual(['catalog:read']);
    expect(hasScope(delegated, 'catalog:curate')).toBe(false);
  });

  // The failure `expandScopes` exists for: a naive intersection of
  // ["catalog:admin"] with ["catalog:read"] is empty, and the person who should
  // have kept read access is locked out instead.
  it('keeps read access when the application holds only catalog:admin', () => {
    const admin = principal({ id: 'ops', scopes: ['catalog:admin'] });
    const delegated = delegatePrincipal(
      admin,
      { id: 'ana@example.com' },
      { scopes: ['catalog:read'] },
    );
    expect(delegated.scopes).toEqual(['catalog:read']);
  });

  it('keeps read access when the person holds only catalog:admin', () => {
    const delegated = delegatePrincipal(
      principal({ id: 'ops', scopes: ['catalog:read'] }),
      { id: 'ana@example.com' },
      { scopes: ['catalog:admin'] },
    );
    expect(delegated.scopes).toEqual(['catalog:read']);
  });

  it('intersects the read allow-list', () => {
    const delegated = delegatePrincipal(
      consoleApp,
      { id: 'ana@example.com' },
      { scopes: ['catalog:read'], readTypes: ['Subwo', 'Mel'] },
    );
    expect(delegated.readTypes).toEqual(['Subwo']);
    expect(mayRead(delegated, 'Subwo')).toBe(true);
    expect(mayRead(delegated, 'Mvr')).toBe(false);
    // Named by the person but not by the application: the application is a
    // ceiling, so this is denied rather than granted.
    expect(mayRead(delegated, 'Mel')).toBe(false);
  });

  // "Absent means everything" has to survive the intersection in its compact
  // form. Expanding it into a list would freeze the grant at the types that
  // existed on the day the principal was built.
  it('keeps a read grant of "everything" as undefined rather than a list', () => {
    const open = principal({ id: 'reader', scopes: ['catalog:read'] });
    const delegated = delegatePrincipal(
      open,
      { id: 'ana@example.com' },
      { scopes: ['catalog:read'] },
    );
    expect(delegated.readTypes).toBeUndefined();
    expect(mayRead(delegated, 'AnyTypePublishedTomorrow')).toBe(true);
  });

  it('treats "*" on one side of a read grant as "whatever the other side allows"', () => {
    const wildcard = principal({ id: 'reader', scopes: ['catalog:read'], readTypes: ['*'] });
    const delegated = delegatePrincipal(
      wildcard,
      { id: 'ana@example.com' },
      { scopes: ['catalog:read'], readTypes: ['Mvr'] },
    );
    expect(delegated.readTypes).toEqual(['Mvr']);
  });

  // Writes get the opposite default: an unlisted type is a denied write, so an
  // absent list on either side collapses the intersection to nothing. A shared
  // "absent means all" would let a leaked console key overwrite every type.
  it('denies every write when the application named no write types', () => {
    const reader = principal({ id: 'reader', scopes: ['catalog:read', 'catalog:write'] });
    const delegated = delegatePrincipal(
      reader,
      { id: 'ana@example.com' },
      { scopes: ['catalog:write'], writeTypes: ['*'] },
    );
    expect(delegated.writeTypes).toEqual([]);
    expect(mayWrite(delegated, 'Mvr')).toBe(false);
  });

  it('keeps "*" as an explicit wildcard when both sides write everything', () => {
    const publisher = principal({
      id: 'publisher',
      scopes: ['catalog:write'],
      writeTypes: ['*'],
    });
    const delegated = delegatePrincipal(
      publisher,
      { id: 'ana@example.com' },
      { scopes: ['catalog:write'], writeTypes: ['*'] },
    );
    // Not `undefined`: on the write axis an absent list means "none", so the
    // wildcard has to be spelled out or the grant would invert.
    expect(delegated.writeTypes).toEqual(['*']);
    expect(mayWrite(delegated, 'Mvr')).toBe(true);
  });

  it('collapses an empty allow-list to a denial rather than reading it as "all"', () => {
    const delegated = delegatePrincipal(
      principal({ id: 'app', scopes: ['catalog:read'], readTypes: [] }),
      { id: 'ana@example.com' },
      { scopes: ['catalog:read'], readTypes: ['Mvr'] },
    );
    expect(delegated.readTypes).toEqual([]);
    expect(mayRead(delegated, 'Mvr')).toBe(false);
  });

  it('intersects classifications by exact label', () => {
    const delegated = delegatePrincipal(
      consoleApp,
      { id: 'ana@example.com' },
      { scopes: ['catalog:read'], classifications: ['cui', 'secret'] },
    );
    expect(delegated.classifications).toEqual(['cui']);
    expect(maySeeClassification(delegated, 'cui')).toBe(true);
    expect(maySeeClassification(delegated, 'secret')).toBe(false);
  });

  it('gives no classifications to a person who was granted none', () => {
    const delegated = delegatePrincipal(
      consoleApp,
      { id: 'ana@example.com' },
      { scopes: ['catalog:read'] },
    );
    expect(delegated.classifications).toEqual([]);
  });

  // An actor id carrying the separator would produce an id that parses back
  // into a different application, so it is refused at the point it is minted
  // rather than escaped.
  it('refuses an actor id containing the separator', () => {
    expect(() =>
      delegatePrincipal(consoleApp, { id: 'ana#example.com' }, { scopes: ['catalog:read'] }),
    ).toThrow(/ambiguous/);
  });

  // Delegating twice must not nest: the application half is already known, so
  // the second delegation replaces the actor rather than appending one.
  it('composes against the application half, not the composite id', () => {
    const first = delegatePrincipal(
      consoleApp,
      { id: 'ana@example.com' },
      { scopes: ['catalog:read'] },
    );
    const second = delegatePrincipal(first, { id: 'bo@example.com' }, { scopes: ['catalog:read'] });
    expect(second.id).toBe('catalog-console#bo@example.com');
    expect(parsePrincipalId(second.id).applicationId).toBe('catalog-console');
  });
});

describe('mayWrite / mayRead', () => {
  it('needs both the scope and the type', () => {
    const writer = principal({ scopes: ['catalog:write'], writeTypes: ['Mvr'] });
    expect(mayWrite(writer, 'Mvr')).toBe(true);
    expect(mayWrite(writer, 'Subwo')).toBe(false);
    expect(mayWrite(principal({ scopes: [], writeTypes: ['Mvr'] }), 'Mvr')).toBe(false);
  });

  it('denies a write to a principal that named no write types, even with catalog:admin', () => {
    expect(mayWrite(principal({ scopes: ['catalog:admin'] }), 'Mvr')).toBe(false);
  });

  it('reads every type when readTypes is absent, and none without the scope', () => {
    expect(mayRead(principal({ scopes: ['catalog:read'] }), 'Anything')).toBe(true);
    expect(mayRead(principal({ scopes: ['catalog:write'] }), 'Anything')).toBe(false);
  });

  it('honours "*" on both axes', () => {
    expect(mayWrite(principal({ scopes: ['catalog:write'], writeTypes: ['*'] }), 'Mvr')).toBe(true);
    expect(mayRead(principal({ scopes: ['catalog:read'], readTypes: ['*'] }), 'Mvr')).toBe(true);
  });
});

describe('maySeeClassification', () => {
  it('shows an unclassified column to everyone', () => {
    expect(maySeeClassification(principal(), undefined)).toBe(true);
  });

  // Absence is denial: a principal nobody has thought about yet must not see
  // classified columns by default.
  it('hides a classified column from a principal with no classifications', () => {
    expect(maySeeClassification(principal(), 'cui')).toBe(false);
  });

  it('does not honour "*" — the check is by exact label', () => {
    expect(maySeeClassification(principal({ classifications: ['*'] }), 'cui')).toBe(false);
  });
});

describe('readableObjectPage', () => {
  /**
   * Two classified columns and one plain one, so a partial grant is
   * distinguishable from all-or-nothing: a helper that dropped every classified
   * column the moment one was denied would pass a single-column fixture.
   */
  function page(overrides: Partial<CatalogObjectPage> = {}): CatalogObjectPage {
    return {
      type: 'Person',
      page: 1,
      size: 25,
      total: 1,
      pages: 1,
      columns: [
        { name: 'id', displayName: 'Id', type: 'uuid' },
        { name: 'name', displayName: 'Name', type: 'string', classification: 'cui' },
        { name: 'ssn', displayName: 'SSN', type: 'string', classification: 'secret' },
      ],
      rows: [{ id: 'p-1', name: 'Ana', ssn: '000-00-0000' }],
      ...overrides,
    };
  }

  const reader = principal({ scopes: ['catalog:read'], classifications: ['cui'] });

  it('refuses the whole page when the principal may not read the type', () => {
    // `null`, not an empty page: a type whose every column is hidden legitimately
    // returns no columns, and a denial that looked like one would be reported by
    // a host as "nothing to show" rather than as a refusal.
    const denied = principal({ scopes: ['catalog:read'], readTypes: ['Vehicle'] });

    expect(readableObjectPage(denied, page())).toBeNull();
    expect(readableObjectPage(reader, page())).not.toBeNull();
  });

  it('drops only the columns whose classification the principal lacks', () => {
    const visible = readableObjectPage(reader, page());

    expect(visible?.columns.map((column) => column.name)).toEqual(['id', 'name']);
  });

  it('deletes the hidden values from every row rather than blanking them', () => {
    // A key present with `null` asserts the column exists and is empty, which
    // for a classified column is the disclosure this is meant to prevent.
    const visible = readableObjectPage(reader, page());

    expect(visible?.rows[0]).toEqual({ id: 'p-1', name: 'Ana' });
    expect(Object.hasOwn(visible?.rows[0] ?? {}, 'ssn')).toBe(false);
  });

  it('does not mutate the page it was given', () => {
    // The service caches nothing here, but a host calling this per-principal on
    // one fetched page would otherwise redact the second caller's page with the
    // first caller's grants — and the more restrictive call would win silently.
    const original = page();
    readableObjectPage(reader, original);

    expect(original.columns).toHaveLength(3);
    expect(original.rows[0]).toEqual({ id: 'p-1', name: 'Ana', ssn: '000-00-0000' });
  });

  it('leaves a page alone when every column is readable', () => {
    const cleared = principal({ scopes: ['catalog:read'], classifications: ['cui', 'secret'] });

    expect(readableObjectPage(cleared, page())?.rows[0]).toEqual({
      id: 'p-1',
      name: 'Ana',
      ssn: '000-00-0000',
    });
  });

  it('hides every classified column from a principal that named none', () => {
    // The default for a caller nobody has thought about yet — see
    // `CatalogPrincipal.classifications`.
    const visible = readableObjectPage(principal({ scopes: ['catalog:read'] }), page());

    expect(visible?.columns.map((column) => column.name)).toEqual(['id']);
    expect(visible?.rows[0]).toEqual({ id: 'p-1' });
  });
});

describe('StaticKeyPrincipalResolver', () => {
  const resolver = new StaticKeyPrincipalResolver([
    { key: 'secret-key', id: 'loader', scopes: ['catalog:write'] },
  ]);

  it('resolves the principal behind a presented key', async () => {
    const resolved = await resolver.resolve({ headers: { 'x-catalog-key': 'secret-key' } });
    expect(resolved?.id).toBe('loader');
  });

  // The key is a credential and the principal is recorded onto every snapshot
  // this caller writes. Carrying it through would put the credential into the
  // audit trail.
  it('strips the key from the principal it hands back', async () => {
    const resolved = await resolver.resolve({ headers: { 'x-catalog-key': 'secret-key' } });
    expect(resolved && Object.keys(resolved)).not.toContain('key');
  });

  it('resolves nobody for an unknown key', async () => {
    await expect(resolver.resolve({ headers: { 'x-catalog-key': 'wrong' } })).resolves.toBeNull();
  });

  // Anything can arrive here: the resolver is handed a request object it does
  // not control, and a throw would become a 500 where a 401 belongs.
  it.each([undefined, null, 'a string', 42, {}, { headers: null }, { headers: { other: 'x' } }])(
    'resolves nobody for %o rather than throwing',
    async (request) => {
      await expect(resolver.resolve(request)).resolves.toBeNull();
    },
  );

  it('reads the header the caller configured', async () => {
    const custom = new StaticKeyPrincipalResolver(
      [{ key: 'k', id: 'loader', scopes: [] }],
      'authorization',
    );
    await expect(custom.resolve({ headers: { 'x-catalog-key': 'k' } })).resolves.toBeNull();
    await expect(custom.resolve({ headers: { authorization: 'k' } })).resolves.not.toBeNull();
  });
});
