import type { CatalogPrincipal, WorkflowNode } from '@dudousxd/nestjs-catalog';
import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { assertMayWriteTypes, committedTypes, requirePrincipal } from './write-grants';

function principal(overrides: Partial<CatalogPrincipal> = {}): CatalogPrincipal {
  return { id: 'console', scopes: ['catalog:write'], writeTypes: ['Mvr'], ...overrides };
}

function sink(id: string, targetType: string): WorkflowNode {
  return { id, name: id, kind: 'sink', targetType };
}

function source(id: string): WorkflowNode {
  return { id, name: id, kind: 'source', sourceKind: 'inline', config: {} };
}

describe('committedTypes', () => {
  it('names the type a sink commits', () => {
    expect(committedTypes([source('in'), sink('out', 'Subwo')])).toEqual(['Subwo']);
  });

  // `WorkflowRow.targetType` records only the first sink found, and a graph may
  // legally carry several as long as they commit different types. Authorising
  // on the row's field would clear a two-sink graph on its first sink and let
  // the second write anywhere.
  it('names every sink of a multi-sink graph, not just the first', () => {
    const nodes = [source('in'), sink('a', 'Mvr'), sink('b', 'Subwo')];
    expect(committedTypes(nodes)).toEqual(['Mvr', 'Subwo']);
  });

  it('ignores the nodes that do not commit', () => {
    const nodes: WorkflowNode[] = [
      source('in'),
      { id: 'tx', name: 'tx', kind: 'transform', transformId: 't1' },
      sink('out', 'Mvr'),
    ];
    expect(committedTypes(nodes)).toEqual(['Mvr']);
  });

  it('names a type once even if it somehow appears twice', () => {
    expect(committedTypes([sink('a', 'Mvr'), sink('b', 'Mvr')])).toEqual(['Mvr']);
  });

  it('has nothing to say about a graph with no sink', () => {
    expect(committedTypes([source('in')])).toEqual([]);
    expect(committedTypes([])).toEqual([]);
  });
});

describe('assertMayWriteTypes', () => {
  it('says nothing when every type is granted', () => {
    expect(() =>
      assertMayWriteTypes(principal({ writeTypes: ['Mvr', 'Subwo'] }), ['Mvr', 'Subwo'], 'saving'),
    ).not.toThrow();
  });

  // The defect: `writeTypes: ["Mvr"]` and a graph whose sink commits `Subwo`.
  it('refuses a type this principal was never granted', () => {
    expect(() => assertMayWriteTypes(principal(), ['Subwo'], 'saving workflow "x"')).toThrow(
      ForbiddenException,
    );
  });

  it('refuses when only one of several types is missing', () => {
    expect(() => assertMayWriteTypes(principal(), ['Mvr', 'Subwo'], 'saving')).toThrow(
      ForbiddenException,
    );
  });

  it('names every refused type, so fixing grants takes one round trip', () => {
    let message = '';
    try {
      assertMayWriteTypes(principal(), ['Mvr', 'Subwo', 'Mel'], 'saving');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('Subwo');
    expect(message).toContain('Mel');
    // The one it *may* write is not listed as a problem.
    expect(message).not.toContain('Mvr,');
  });

  // `writeTypes` absent means nothing, never everything — the safe default for
  // a principal nobody has thought about yet. See `catalog.principal.ts`.
  it('refuses a principal with no writeTypes at all', () => {
    expect(() =>
      assertMayWriteTypes(principal({ writeTypes: undefined }), ['Mvr'], 'saving'),
    ).toThrow(ForbiddenException);
  });

  it('honours the wildcard', () => {
    expect(() =>
      assertMayWriteTypes(principal({ writeTypes: ['*'] }), ['Anything'], 'saving'),
    ).not.toThrow();
  });

  // `catalog:write` alone is not enough, which is the whole reason the grant is
  // per-type: a shared write path where every caller can write every type means
  // one application can quietly overwrite another's data.
  it('refuses a principal holding catalog:write but not this type', () => {
    expect(() =>
      assertMayWriteTypes(principal({ scopes: ['catalog:write'] }), ['Subwo'], 'saving'),
    ).toThrow(ForbiddenException);
  });

  it('refuses a principal that may read the type but not write it', () => {
    expect(() =>
      assertMayWriteTypes(
        principal({ scopes: ['catalog:read'], writeTypes: ['Mvr'] }),
        ['Mvr'],
        'saving',
      ),
    ).toThrow(ForbiddenException);
  });

  it('lets an admin through, since admin expands to every scope', () => {
    expect(() =>
      assertMayWriteTypes(principal({ scopes: ['catalog:admin'], writeTypes: ['*'] }), ['X'], 'x'),
    ).not.toThrow();
  });

  it('has nothing to refuse when a graph commits nothing', () => {
    expect(() => assertMayWriteTypes(principal(), [], 'saving')).not.toThrow();
  });
});

describe('requirePrincipal', () => {
  it('hands back the principal a guard put on the request', () => {
    const p = principal();
    expect(requirePrincipal({ principal: p })).toBe(p);
  });

  // Reaching here means the host removed the guard from a route that declares
  // `@RequireScopes`. Defaulting to an anonymous id — which is what these routes
  // used to do — is exactly how an unauthenticated caller got every grant.
  it('refuses to invent one when no guard ran', () => {
    expect(() => requirePrincipal({})).toThrow(/CatalogPrincipalGuard/);
  });
});
