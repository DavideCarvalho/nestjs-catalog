import { describe, expect, it } from 'vitest';
import { CODE_CONTEXT_CONTRACT, type CatalogCodeContext } from './catalog.pipeline';
import { SubprocessTransformRunner } from './transform-runner';

/**
 * Real child processes, for the reason `transform-runner.spec.ts` gives at
 * length: both harnesses exist only as strings of source for another
 * interpreter, so a stub that returned what it was told would prove nothing
 * about the one thing that can be wrong — whether the second parameter is
 * actually bound, in a language whose function signature is generated rather
 * than written.
 *
 * The Python half is skipped as a block when there is no interpreter, which is
 * a supported deployment.
 */
const runner = new SubprocessTransformRunner();
const languages = await runner.available();
const hasPython = languages.includes('python');

function context(parts: Partial<CatalogCodeContext> = {}): CatalogCodeContext {
  return {
    contract: CODE_CONTEXT_CONTRACT,
    runId: 'run-1',
    workflow: { id: 'wf-1', name: 'fleet', version: 4 },
    node: { id: 'n2', name: 'normalise' },
    environment: 'prod',
    rowCount: 0,
    inputs: [{ runId: 'run-1', nodeId: 'n1', batches: 1, rowCount: 3 }],
    env: { VENDOR_TOKEN: 'vendor-secret' },
    ...parts,
  };
}

describe('the JavaScript harness', () => {
  it('hands the code its context as a second parameter', async () => {
    const result = await runner.run(
      {
        language: 'javascript',
        code: 'return [{ token: context.env.VENDOR_TOKEN, run: context.runId, env: context.environment }];',
      },
      [],
      { context: context() },
    );

    expect(result.rows).toEqual([{ token: 'vendor-secret', run: 'run-1', env: 'prod' }]);
  });

  it('still passes the records, which is what the first parameter was always for', async () => {
    const result = await runner.run(
      { language: 'javascript', code: 'return records.map((r) => ({ n: r.n * 2 }));' },
      [{ n: 1 }, { n: 2 }],
      { context: context({ rowCount: 2 }) },
    );

    expect(result.rows).toEqual([{ n: 2 }, { n: 4 }]);
  });

  it('carries the upstream counts a predicate would branch on', async () => {
    const result = await runner.run(
      {
        language: 'javascript',
        code: 'return [{ total: context.rowCount, first: context.inputs[0].rowCount, node: context.inputs[0].nodeId }];',
      },
      [],
      { context: context({ rowCount: 3 }) },
    );

    expect(result.rows).toEqual([{ total: 3, first: 3, node: 'n1' }]);
  });

  it('gives code with no context an empty one rather than undefined', async () => {
    // A caller may legitimately have no context — a spec, a host driving the
    // runner by hand — and the one thing user code must not have to write is
    // `context?.env?.X`, because that is the spelling that silently reads
    // nothing when the caller *did* pass a context and got the shape wrong.
    const result = await runner.run(
      {
        language: 'javascript',
        code: 'return [{ token: context.env.VENDOR_TOKEN ?? null, run: context.runId ?? null, rows: context.rowCount }];',
      },
      [{ n: 1 }],
    );

    expect(result.rows).toEqual([{ token: null, run: null, rows: 1 }]);
  });

  it('refuses a write to the context rather than appearing to accept one', async () => {
    // The harness runs as an ES module, so it is strict-mode and the frozen
    // object throws rather than swallowing the assignment. Nothing propagates
    // out of the child either way — the freeze buys the honest error, not
    // safety — and the honest error is what stops somebody writing a
    // transform that "sets" a credential for the next node.
    await expect(
      runner.run(
        { language: 'javascript', code: 'context.env.VENDOR_TOKEN = "mine"; return [];' },
        [],
        { context: context() },
      ),
    ).rejects.toThrow(/read only|not extensible/i);
  });
});

describe.skipIf(!hasPython)('the Python harness', () => {
  it('hands the code its context as a second parameter', async () => {
    const result = await runner.run(
      {
        language: 'python',
        code: 'return [{"token": context["env"]["VENDOR_TOKEN"], "run": context["runId"]}]',
      },
      [],
      { context: context() },
    );

    expect(result.rows).toEqual([{ token: 'vendor-secret', run: 'run-1' }]);
  });

  it('still passes the records', async () => {
    const result = await runner.run(
      { language: 'python', code: 'return [{"n": r["n"] * 2} for r in records]' },
      [{ n: 1 }, { n: 2 }],
      { context: context({ rowCount: 2 }) },
    );

    expect(result.rows).toEqual([{ n: 2 }, { n: 4 }]);
  });

  it('runs a transform written before the parameter existed', async () => {
    // The signature is generated, not written, so every stored transform gains
    // the parameter without being edited. This is the case that would break if
    // the context had been made the *first* argument.
    const result = await runner.run({ language: 'python', code: 'return records' }, [{ n: 1 }], {
      context: context({ rowCount: 1 }),
    });

    expect(result.rows).toEqual([{ n: 1 }]);
  });
});
