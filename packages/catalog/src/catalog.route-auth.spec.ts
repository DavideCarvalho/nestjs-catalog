import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { REQUIRED_SCOPES, REQUIRES_HUMAN, RequireHuman, RequireScopes } from './catalog.route-auth';

/**
 * These two keys are a contract between packages, not an implementation
 * detail: a host writes ONE guard against them and it governs every catalog
 * route it mounts, from this library or any other. Renaming one is invisible
 * here and silently stops that guard from seeing the routes it was written for
 * — which fails open, since a route with no metadata reads as "authenticated is
 * enough".
 */
describe('the metadata keys', () => {
  it('are the namespaced strings hosts key their guard off', () => {
    expect(REQUIRED_SCOPES).toBe('aviary:catalog:required-scopes');
    expect(REQUIRES_HUMAN).toBe('aviary:catalog:requires-human');
  });

  it('are distinct, so one decorator cannot overwrite the other', () => {
    expect(REQUIRED_SCOPES).not.toBe(REQUIRES_HUMAN);
  });
});

describe('RequireScopes', () => {
  it('records the scopes on the handler a guard will be given', () => {
    class Controller {
      @RequireScopes('catalog:curate')
      patch() {}
    }
    expect(Reflect.getMetadata(REQUIRED_SCOPES, Controller.prototype.patch)).toEqual([
      'catalog:curate',
    ]);
  });

  it('records every scope a route names, in order', () => {
    class Controller {
      @RequireScopes('catalog:read', 'catalog:embed')
      read() {}
    }
    expect(Reflect.getMetadata(REQUIRED_SCOPES, Controller.prototype.read)).toEqual([
      'catalog:read',
      'catalog:embed',
    ]);
  });

  it('applies to a whole controller as well as one route', () => {
    @RequireScopes('catalog:admin')
    class Controller {}
    expect(Reflect.getMetadata(REQUIRED_SCOPES, Controller)).toEqual(['catalog:admin']);
  });

  // Absence means "authenticated is enough", so an undecorated route must carry
  // no metadata at all rather than an empty list a guard might read as a denial.
  it('leaves an undecorated route with nothing recorded', () => {
    class Controller {
      open() {}
    }
    expect(Reflect.getMetadata(REQUIRED_SCOPES, Controller.prototype.open)).toBeUndefined();
    expect(Reflect.getMetadata(REQUIRES_HUMAN, Controller.prototype.open)).toBeUndefined();
  });
});

describe('RequireHuman', () => {
  // Orthogonal to scopes, and needed because a scope cannot express it: a
  // machine principal holding catalog:admin is perfectly authorised and would
  // leave an application id as the answer to "who did this".
  it('marks a route as refusing machine principals', () => {
    class Controller {
      @RequireHuman()
      approve() {}
    }
    expect(Reflect.getMetadata(REQUIRES_HUMAN, Controller.prototype.approve)).toBe(true);
  });

  it('stacks with RequireScopes rather than replacing it', () => {
    class Controller {
      @RequireHuman()
      @RequireScopes('catalog:admin')
      approve() {}
    }
    expect(Reflect.getMetadata(REQUIRES_HUMAN, Controller.prototype.approve)).toBe(true);
    expect(Reflect.getMetadata(REQUIRED_SCOPES, Controller.prototype.approve)).toEqual([
      'catalog:admin',
    ]);
  });
});
