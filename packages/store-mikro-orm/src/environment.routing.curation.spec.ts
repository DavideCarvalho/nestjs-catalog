import type {
  CatalogObjectTypeDef,
  CatalogOverlay,
  CatalogSnapshot,
} from '@dudousxd/nestjs-catalog';
import { CatalogRegistry } from '@dudousxd/nestjs-catalog';
import { describe, expect, it } from 'vitest';
import { CatalogEnvironmentBundle } from './environment.bundle';
import { RoutingCatalogRegistry, runInEnvironment } from './environment.routing';

/**
 * That the curator's name survives the environment hop.
 *
 * `type.curated` and `overlay.reset` now carry `principalId`, threaded from the
 * route that resolves a principal down to the registry that emits. In a
 * single-environment deployment that is one call. In a multi-environment one it
 * goes through `RoutingCatalogRegistry`, a proxy written by hand, method by
 * method — and this is the hop where the actor would be lost.
 *
 * THE FAILURE THIS GUARDS, AND WHY IT WOULD NOT BE NOTICED
 * -------------------------------------------------------
 * A dropped *method* on one of these proxies fails loudly: the call crashes, or a
 * structural probe reads the absence as "this store cannot", which is what
 * `environment.routing.store.spec.ts` was written about. A dropped *argument*
 * fails silently and completely. The patch lands, the response is a 200 carrying
 * the renamed type, the audit row is written — and its actor says `unattributed`,
 * in the one deployment shape that has several environments and therefore a
 * governance team reading the trail. Nothing about the request looks wrong
 * afterwards, and the registry underneath is behaving perfectly, so the search
 * for the cause starts in the wrong package.
 *
 * So these assert what the registry *behind* the proxy received, not what came
 * back out of it. Every other observable — the return value, the snapshot, the
 * event count — is identical whether the actor was forwarded or not, which is
 * exactly why a test written against any of them would pass on the bug.
 */

const ANA = 'catalog-console#ana@example.com';

const TYPE: CatalogObjectTypeDef = {
  name: 'Mvr',
  displayName: 'Mvr',
  pluralDisplayName: 'Mvrs',
  tableName: 'mvr',
  group: 'Fleet',
  primaryKey: ['id'],
  enriched: false,
  properties: [],
  relations: [],
};

/**
 * The registry an environment bundle holds, reduced to a recorder.
 *
 * Extends `CatalogRegistry` rather than being a bare object, so the arguments it
 * records are the ones the abstract contract declares: a stub whose signatures
 * had drifted from the class would record whatever it liked and prove nothing
 * about what a real `StoredCatalogRegistry` is handed.
 */
class RecordingRegistry extends CatalogRegistry {
  readonly calls: Array<{ method: string; args: unknown[] }> = [];

  getSnapshot(): CatalogSnapshot {
    return {
      version: 1,
      generatedAt: new Date(0).toISOString(),
      stats: { types: 1, properties: 0, relations: 0, enrichedTypes: 0 },
      types: [TYPE],
    };
  }

  getType(): CatalogObjectTypeDef | undefined {
    return TYPE;
  }

  patchType(
    typeName: string,
    patch: Partial<CatalogOverlay['types'][string]>,
    curatedBy: string,
  ): Promise<CatalogObjectTypeDef | undefined> {
    this.calls.push({ method: 'patchType', args: [typeName, patch, curatedBy] });
    return Promise.resolve(TYPE);
  }

  patchProperty(
    typeName: string,
    propertyName: string,
    patch: NonNullable<CatalogOverlay['types'][string]['properties']>[string],
    curatedBy: string,
  ): Promise<CatalogObjectTypeDef | undefined> {
    this.calls.push({
      method: 'patchProperty',
      args: [typeName, propertyName, patch, curatedBy],
    });
    return Promise.resolve(TYPE);
  }

  /**
   * Unlike `StoredCatalogRegistry`, this one accepts a reset and records it.
   *
   * Deliberately: the shipped stored registry refuses, so a bundle holding it can
   * never show whether the proxy passed the actor along. That is the state the
   * forwarder has to be correct *in advance* of — the day a bundle holds a
   * registry that can reset is not the day to discover the argument was being
   * dropped.
   */
  resetOverlay(resetBy: string): Promise<void> {
    this.calls.push({ method: 'resetOverlay', args: [resetBy] });
    return Promise.resolve();
  }
}

/** A bundle that is nothing but its registry, which is all the proxy reads. */
function bundleWith(registry: CatalogRegistry): CatalogEnvironmentBundle {
  const bundle: CatalogEnvironmentBundle = Object.create(CatalogEnvironmentBundle.prototype);
  return Object.assign(bundle, { registry });
}

describe('the curation actor survives the environment hop', () => {
  it('hands the principal to the environment registry on a type patch', async () => {
    const inner = new RecordingRegistry();
    const routing = new RoutingCatalogRegistry();

    await runInEnvironment(bundleWith(inner), () =>
      routing.patchType('Mvr', { displayName: 'Vehicle' }, ANA),
    );

    expect(inner.calls).toEqual([
      { method: 'patchType', args: ['Mvr', { displayName: 'Vehicle' }, ANA] },
    ]);
  });

  it('hands it over on a property patch, where an off-by-one would land it in `patch`', async () => {
    // Four arguments now, and the actor is the last. A forwarder that passed the
    // right count in the wrong order would put the principal id where the patch
    // belongs — and `patchProperty` accepts a partial, so an object-shaped
    // argument in the wrong slot is not necessarily a type error at the call
    // site it was copied from.
    const inner = new RecordingRegistry();
    const routing = new RoutingCatalogRegistry();

    await runInEnvironment(bundleWith(inner), () =>
      routing.patchProperty('Mvr', 'acftSn', { displayName: 'Tail number' }, ANA),
    );

    expect(inner.calls).toEqual([
      {
        method: 'patchProperty',
        args: ['Mvr', 'acftSn', { displayName: 'Tail number' }, ANA],
      },
    ]);
  });

  it('hands it over on a reset, the act with the least left to reconstruct from', async () => {
    const inner = new RecordingRegistry();
    const routing = new RoutingCatalogRegistry();

    await runInEnvironment(bundleWith(inner), () => routing.resetOverlay(ANA));

    expect(inner.calls).toEqual([{ method: 'resetOverlay', args: [ANA] }]);
  });

  it('keeps the whole delegated id rather than the application half', async () => {
    // The composite `<app>#<person>` is the choice `query.shared` made and the
    // one `catalog.principal.ts` argues for: `parsePrincipalId` recovers the
    // application from it, so nothing is lost by carrying the person — while a
    // proxy that helpfully reduced it would attribute a curator's decision to the
    // console they signed into.
    const inner = new RecordingRegistry();
    const routing = new RoutingCatalogRegistry();

    await runInEnvironment(bundleWith(inner), () =>
      routing.patchType('Mvr', { group: 'Fleet' }, ANA),
    );

    expect(inner.calls[0]?.args[2]).toBe('catalog-console#ana@example.com');
  });

  it('still refuses to curate anything outside an environment scope', () => {
    // The property that makes the whole proxy safe rather than convenient, and
    // worth re-asserting on a route that now writes an audit row: a curation edit
    // served by no environment would be a governance record that cannot say which
    // world it happened in.
    //
    // Thrown rather than rejected, and asserted that way deliberately: these
    // forwarders are not `async`, so the refusal happens before any promise
    // exists. `rejects` on a call that threw synchronously fails with the
    // refusal's own message, which reads like the assertion passing.
    const routing = new RoutingCatalogRegistry();

    expect(() => routing.patchType('Mvr', { displayName: 'Vehicle' }, ANA)).toThrow(/environment/i);
    expect(() => routing.resetOverlay(ANA)).toThrow(/environment/i);
  });

  it('declares an actor parameter on every curation method it forwards', () => {
    // Arity, walked off the prototype rather than read. The recording cases above
    // prove the value arrives for the three methods they name; this is what fails
    // when a fourth curation method is added to `CatalogRegistry` and forwarded
    // here with its actor quietly left off the signature.
    const arities: Record<string, number> = {
      patchType: 3,
      patchProperty: 4,
      resetOverlay: 1,
    };

    for (const [method, expected] of Object.entries(arities)) {
      const forwarder = Reflect.get(RoutingCatalogRegistry.prototype, method);
      const arity = typeof forwarder === 'function' ? forwarder.length : -1;
      expect(`${method} takes ${arity} arguments`).toBe(`${method} takes ${expected} arguments`);
    }
  });
});
