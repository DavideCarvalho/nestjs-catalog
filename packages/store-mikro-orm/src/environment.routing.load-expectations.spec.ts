import type { StoredLoadExpectation } from '@dudousxd/nestjs-catalog';
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { CatalogEnvironmentBundle } from './environment.bundle';
import { RoutingPipelineStore, runInEnvironment } from './environment.routing';

/**
 * That the operator's load expectations route to the environment they were
 * asked about.
 *
 * The failure this guards is the one `environment.routing.store.spec.ts`
 * documents and that this proxy has now had four times: an optional member left
 * off a hand-written proxy is not a quieter "no", it is ABSENT — and
 * `supportsLoadExpectations` is a structural check, so the whole deployment would
 * report that it cannot hold operator-set expectations while every environment
 * behind it held them perfectly well. The Model screen would then show every
 * type as locked by the deployment, in the one deployment shape (several
 * environments) where a per-environment answer is most likely to be wanted.
 *
 * The type-level assertion at the bottom of `environment.routing.ts` is what
 * makes the omission fail the BUILD rather than a test. What is left for a spec
 * is what a type cannot say: that a declared method delegates rather than
 * answering something of its own, that it delegates every ARGUMENT — a dropped
 * `setByActor` succeeds, writes a row, and attributes an operator's decision to
 * nobody — and that a store which genuinely cannot do this is reported honestly
 * rather than crashed into.
 */

const STORED: StoredLoadExpectation = {
  typeName: 'Employee',
  deletes: { strategy: 'accepted', because: 'Append-only ledger; rows are never removed.' },
  rowCount: { maxShrink: 0.8 },
  setBy: 'catalog-console',
  setByActor: 'ana@example.com',
  setAt: '2026-03-04T10:00:00.000Z',
};

/** The pipeline store an environment bundle holds, reduced to a recorder. */
class RecordingStore {
  readonly saves: Array<
    [string, Pick<StoredLoadExpectation, 'deletes' | 'rowCount'>, ...string[]]
  > = [];
  readonly cleared: string[] = [];

  listLoadExpectations(): Promise<StoredLoadExpectation[]> {
    return Promise.resolve([STORED]);
  }

  getLoadExpectation(typeName: string): Promise<StoredLoadExpectation | undefined> {
    return Promise.resolve(typeName === STORED.typeName ? STORED : undefined);
  }

  saveLoadExpectation(
    typeName: string,
    expectation: Pick<StoredLoadExpectation, 'deletes' | 'rowCount'>,
    setBy: string,
    setByActor?: string,
  ): Promise<StoredLoadExpectation> {
    this.saves.push([
      typeName,
      expectation,
      setBy,
      ...(setByActor === undefined ? [] : [setByActor]),
    ]);
    return Promise.resolve({ ...STORED, typeName, setBy, setByActor });
  }

  clearLoadExpectation(typeName: string): Promise<boolean> {
    this.cleared.push(typeName);
    return Promise.resolve(true);
  }
}

/**
 * A store from a host that predates this feature, to keep the probe honest.
 *
 * None of the four methods, which is a legal `CatalogPipelineStore` and always
 * will be — the members are optional precisely so that this store keeps
 * compiling and keeps working, with the host's `CATALOG_LOAD_EXPECTATIONS`
 * object as its only policy layer.
 */
class StoreWithoutExpectations {}

/** A store with the getter and not the setter — the half-implemented case. */
class HalfImplementedStore {
  listLoadExpectations(): Promise<StoredLoadExpectation[]> {
    return Promise.resolve([STORED]);
  }
  getLoadExpectation(): Promise<StoredLoadExpectation | undefined> {
    return Promise.resolve(STORED);
  }
}

function bundleWith(pipeline: unknown): CatalogEnvironmentBundle {
  const bundle: CatalogEnvironmentBundle = Object.create(CatalogEnvironmentBundle.prototype);
  return Object.assign(bundle, { pipeline });
}

describe('RoutingPipelineStore forwards load expectations', () => {
  it('reads them from the environment in scope', async () => {
    const routing = new RoutingPipelineStore();
    const inner = new RecordingStore();

    const [all, one] = await runInEnvironment(bundleWith(inner), () =>
      Promise.all([routing.listLoadExpectations(), routing.getLoadExpectation('Employee')]),
    );

    expect(all).toEqual([STORED]);
    expect(one?.setByActor).toBe('ana@example.com');
  });

  it('carries the actor through the hop, not just the principal', async () => {
    // The argument-shaped failure, which is the one that does not announce
    // itself: the save succeeds, the response carries the expectation, the row
    // is written — and the trail cannot say which human decided that a dataset
    // may accumulate rows deleted upstream, in the deployment shape that has a
    // governance team reading it.
    const routing = new RoutingPipelineStore();
    const inner = new RecordingStore();

    await runInEnvironment(bundleWith(inner), () =>
      routing.saveLoadExpectation(
        'Mvr',
        { rowCount: { maxShrink: 0.5 } },
        'catalog-console',
        'ana@example.com',
      ),
    );

    expect(inner.saves).toEqual([
      ['Mvr', { rowCount: { maxShrink: 0.5 } }, 'catalog-console', 'ana@example.com'],
    ]);
  });

  it('clears through to the environment store', async () => {
    const routing = new RoutingPipelineStore();
    const inner = new RecordingStore();

    const dropped = await runInEnvironment(bundleWith(inner), () =>
      routing.clearLoadExpectation('Employee'),
    );

    expect(dropped).toBe(true);
    expect(inner.cleared).toEqual(['Employee']);
  });

  it('reads as empty when the environment store genuinely cannot hold them', async () => {
    // A read may answer "none". This is the honest answer for a host store that
    // predates the feature, and it is what keeps the members optional worth
    // anything.
    const routing = new RoutingPipelineStore();

    const [all, one] = await runInEnvironment(bundleWith(new StoreWithoutExpectations()), () =>
      Promise.all([routing.listLoadExpectations(), routing.getLoadExpectation('Employee')]),
    );

    expect(all).toEqual([]);
    expect(one).toBeUndefined();
  });

  it.each([
    ['no expectation methods at all', () => new StoreWithoutExpectations()],
    ['the readers but not the writers', () => new HalfImplementedStore()],
  ])('refuses a write when the environment store has %s', (_why, make) => {
    // A write may NOT quietly do nothing. `clearLoadExpectation` is the sharp
    // case: `false` already means "there was no row", so answering it here would
    // tell the caller there was nothing to clear rather than that clearing was
    // impossible.
    //
    // Thrown rather than rejected, matching `requireWorkflows` and
    // `requireStages` beside it: the refusal happens before the inner call is
    // made, so there is no promise yet. Nest turns either into the same 400.
    const routing = new RoutingPipelineStore();

    runInEnvironment(bundleWith(make()), () => {
      expect(() =>
        routing.saveLoadExpectation('Mvr', { rowCount: { maxShrink: 0.5 } }, 'catalog-console'),
      ).toThrow(BadRequestException);
      expect(() => routing.clearLoadExpectation('Mvr')).toThrow(BadRequestException);
    });
  });

  it('declares all four, so a structural probe reads the store behind it', () => {
    // The probe asks for every one of them by name — the write path and the read
    // path are used at different moments, so a proxy carrying three would narrow
    // cleanly and then fail on the save, after the screen had offered an editor.
    const declared = Object.getOwnPropertyNames(RoutingPipelineStore.prototype);

    expect(declared).toEqual(
      expect.arrayContaining([
        'listLoadExpectations',
        'getLoadExpectation',
        'saveLoadExpectation',
        'clearLoadExpectation',
      ]),
    );
  });
});
