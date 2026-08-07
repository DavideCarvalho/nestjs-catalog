import { describe, expect, it } from 'vitest';
import { CODE_CONTEXT_CONTRACT, type CatalogCodeContext } from './catalog.pipeline';
import { SubprocessTransformRunner } from './transform-runner';

/**
 * Both shapes, through real child processes, for the reason
 * `transform-runner.spec.ts` gives at length: a harness that exists only as a
 * string of source for another interpreter cannot be proved correct by a stub
 * that returns what it was told.
 *
 * The half of this file that matters most is the first `describe`. The module
 * shape is new and can be re-landed if it is wrong; the bare body is what every
 * transform already stored is written in, and a regression there is a silent
 * change to somebody's production data. So the legacy shape is tested first,
 * with the second parameter, with `await`, and with the code that most looks
 * like the new shape without being it.
 */
const runner = new SubprocessTransformRunner();

function context(parts: Partial<CatalogCodeContext> = {}): CatalogCodeContext {
  return {
    contract: CODE_CONTEXT_CONTRACT,
    runId: 'run-1',
    rowCount: 2,
    inputs: [],
    env: { VENDOR_TOKEN: 'vendor-secret' },
    ...parts,
  };
}

const DPAS = [
  { 'Mgmt Cd': 'C601', 'Reg Number': '09C00014' },
  { 'Mgmt Cd': 'C602', 'Reg Number': '11C00280' },
];

describe('a bare body, which is what every stored transform is', () => {
  it('still runs, with records positional', async () => {
    const result = await runner.run(
      {
        language: 'javascript',
        code: 'return records.map((r) => ({ mgmtCd: r["Mgmt Cd"], regNumber: r["Reg Number"] }));',
      },
      DPAS,
    );
    expect(result.rows).toEqual([
      { mgmtCd: 'C601', regNumber: '09C00014' },
      { mgmtCd: 'C602', regNumber: '11C00280' },
    ]);
  });

  it('still gets context as the second parameter', async () => {
    const result = await runner.run(
      { language: 'javascript', code: 'return [{ token: context.env.VENDOR_TOKEN }];' },
      [],
      { context: context() },
    );
    expect(result.rows).toEqual([{ token: 'vendor-secret' }]);
  });

  it('still gets an await', async () => {
    const result = await runner.run(
      { language: 'javascript', code: 'const n = await Promise.resolve(7); return [{ n }];' },
      [],
    );
    expect(result.rows).toEqual([{ n: 7 }]);
  });

  it('still captures its logs', async () => {
    const result = await runner.run(
      { language: 'javascript', code: 'console.log("one"); console.error("two"); return [];' },
      [],
    );
    expect(result.logs).toEqual(['one', 'two']);
  });

  // The case that decides whether the detection rule is safe. A body may
  // perfectly well declare a helper called `transform`; a rule that matched on
  // the name would call it with `{records, context}`, and every row would come
  // out `{ mgmtCd: undefined }` with no error anywhere.
  it('still runs when it declares its own function called transform', async () => {
    const result = await runner.run(
      {
        language: 'javascript',
        code: [
          'function transform(r) { return { mgmtCd: r["Mgmt Cd"] }; }',
          'return records.map(transform);',
        ].join('\n'),
      },
      DPAS,
    );
    expect(result.rows).toEqual([{ mgmtCd: 'C601' }, { mgmtCd: 'C602' }]);
  });

  it('still runs when its code merely mentions export', async () => {
    const result = await runner.run(
      {
        language: 'javascript',
        code: '// export default is not what this does\nconst s = "export"; return [{ s }];',
      },
      [],
    );
    expect(result.rows).toEqual([{ s: 'export' }]);
  });

  it('still strips TypeScript in a body', async () => {
    const result = await runner.run(
      {
        language: 'typescript',
        code: 'type S = { "Mgmt Cd": string };\nreturn (records as S[]).map((r) => ({ mgmtCd: r["Mgmt Cd"] }));',
      },
      DPAS,
    );
    expect(result.rows).toEqual([{ mgmtCd: 'C601' }, { mgmtCd: 'C602' }]);
  });
});

describe('a module, called with one object', () => {
  it('calls the default export', async () => {
    const result = await runner.run(
      {
        language: 'javascript',
        code: 'export default function transform({ records }) {\n  return records.map((r) => ({ mgmtCd: r["Mgmt Cd"] }));\n}',
      },
      DPAS,
    );
    expect(result.rows).toEqual([{ mgmtCd: 'C601' }, { mgmtCd: 'C602' }]);
  });

  it('calls a default export written as an arrow', async () => {
    const result = await runner.run(
      { language: 'javascript', code: 'export default ({ records }) => records;' },
      DPAS,
    );
    expect(result.rows).toEqual(DPAS);
  });

  it('calls a named export called transform', async () => {
    const result = await runner.run(
      {
        language: 'javascript',
        code: 'export function transform({ records }) { return records.map((r) => ({ n: r["Mgmt Cd"] })); }',
      },
      DPAS,
    );
    expect(result.rows).toEqual([{ n: 'C601' }, { n: 'C602' }]);
  });

  it('puts context on the same object', async () => {
    const result = await runner.run(
      {
        language: 'javascript',
        code: 'export default ({ context }) => [{ token: context.env.VENDOR_TOKEN, run: context.runId, rows: context.rowCount }];',
      },
      [],
      { context: context() },
    );
    expect(result.rows).toEqual([{ token: 'vendor-secret', run: 'run-1', rows: 2 }]);
  });

  it('freezes context one level down, exactly as a body sees it', async () => {
    const result = await runner.run(
      {
        language: 'javascript',
        code: [
          'export default ({ context }) => {',
          '  let threw = false;',
          '  try { "use strict"; context.env.VENDOR_TOKEN = "stolen"; } catch { threw = true; }',
          '  return [{ threw, token: context.env.VENDOR_TOKEN }];',
          '};',
        ].join('\n'),
      },
      [],
      { context: context() },
    );
    expect(result.rows).toEqual([{ threw: true, token: 'vendor-secret' }]);
  });

  it('awaits an async export', async () => {
    const result = await runner.run(
      {
        language: 'javascript',
        code: 'export default async ({ records }) => { await Promise.resolve(); return records; };',
      },
      DPAS,
    );
    expect(result.rows).toEqual(DPAS);
  });

  it('captures its logs on the same six channels', async () => {
    const result = await runner.run(
      {
        language: 'javascript',
        code: 'export default () => { console.log("l"); console.debug("d"); console.trace("t"); return []; };',
      },
      [],
    );
    expect(result.logs).toEqual(['l', 'd', 't']);
  });

  // The failure that would otherwise be indistinguishable from a source that
  // returned nothing — and a connector commits an empty snapshot on that.
  it('refuses a module that exports no function, and says what it found', async () => {
    await expect(
      runner.run({ language: 'javascript', code: 'export const rows = [];' }, DPAS),
    ).rejects.toThrow(/export default/);
  });

  it('reports a runtime error from inside the exported function', async () => {
    await expect(
      runner.run(
        { language: 'javascript', code: 'export default () => { throw new Error("boom"); };' },
        [],
      ),
    ).rejects.toThrow(/boom/);
  });
});

describe('a TypeScript module', () => {
  it('strips its types and runs', async () => {
    const result = await runner.run(
      {
        language: 'typescript',
        code: [
          'export type Source = { "Mgmt Cd": string };',
          'export default ({ records }: { records: Source[] }): Array<Record<string, unknown>> =>',
          '  records.map((r) => ({ mgmtCd: r["Mgmt Cd"] }));',
        ].join('\n'),
      },
      DPAS,
    );
    expect(result.rows).toEqual([{ mgmtCd: 'C601' }, { mgmtCd: 'C602' }]);
  });

  // The claim the editor help rests on. `import type` is erased by the
  // stripper, so the package is never resolved — which matters because a
  // transform runs in a temporary directory with no `node_modules` to resolve
  // it from. A value import of the same specifier would fail, and the docs say
  // so; this proves the type-only one does not.
  it('erases a type-only import of a package it could never resolve', async () => {
    const result = await runner.run(
      {
        language: 'typescript',
        code: [
          "import type { CatalogTransformFunction } from '@dudousxd/nestjs-catalog/client';",
          'const transform: CatalogTransformFunction<{ "Mgmt Cd": string }> = ({ records }) =>',
          '  records.map((r) => ({ mgmtCd: r["Mgmt Cd"] }));',
          'export default transform;',
        ].join('\n'),
      },
      DPAS,
    );
    expect(result.rows).toEqual([{ mgmtCd: 'C601' }, { mgmtCd: 'C602' }]);
  });

  // Node's type stripping is stripping, not checking — the comment in the
  // runner has said so since the day TypeScript was offered, and a UI that
  // implied otherwise would be lying. This is that claim, asserted rather than
  // described: the annotation says `number`, the value is a string, and the row
  // is stored.
  it('does not check them: a wrong type still runs and still stores the wrong thing', async () => {
    const result = await runner.run(
      {
        language: 'typescript',
        code: [
          'export default ({ records }: { records: Array<{ "Mgmt Cd": number }> }) =>',
          '  records.map((r) => ({ mgmtCd: r["Mgmt Cd"] }));',
        ].join('\n'),
      },
      DPAS,
    );
    expect(result.rows).toEqual([{ mgmtCd: 'C601' }, { mgmtCd: 'C602' }]);
  });
});

describe('when the shapes disagree', () => {
  // The scanner's documented limit, reproduced rather than described: a regular
  // expression at the start of a statement following `}` is read as a division
  // by the conventional rule, so the apostrophe inside it opens a string that
  // never closes and hides the `export` after it. The code then runs as a body
  // and dies on the keyword.
  //
  // Kept as a test because it is the one path where the detector is wrong, and
  // what is being asserted is that being wrong is *survivable*: the author gets
  // an error naming the rule, not a run that silently did something else.
  it('names the rule when a module it did not recognise dies on the export', async () => {
    await expect(
      runner.run(
        {
          language: 'javascript',
          code: [
            'if (records.length) { }',
            "/it's fine/.test('x');",
            'export default ({ records }) => records;',
          ].join('\n'),
        },
        [],
      ),
    ).rejects.toThrow(/bare function body/);
  });

  // Rather than a second run in the other shape, which would report a different
  // error for the same text and make neither trustworthy.
  it('reports the module parse error for a broken module, and does not retry as a body', async () => {
    await expect(
      runner.run({ language: 'javascript', code: 'export default ({ records }) => records.' }, []),
    ).rejects.toThrow(/SyntaxError/);
  });
});
