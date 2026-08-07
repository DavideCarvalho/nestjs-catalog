import { describe, expect, it } from 'vitest';
import { transformDeclaresModule, transformShape, transformShapeHint } from './transform-shape';

/**
 * The detector, on its own, with no child process anywhere near it.
 *
 * Separate from the runner's specs on purpose. What is under test here is a
 * *classification*, and a classification is worth testing at the point it is
 * decided rather than through the thing it decides: a case that reaches the
 * wrong harness and then happens to produce plausible rows would pass an
 * end-to-end assertion and still be a misclassification.
 *
 * The cases that matter most are the negative ones. A body wrongly called a
 * module fails loudly, which is annoying; a module wrongly called a body, or a
 * body detected on the strength of a *name*, is the shape of failure that
 * stores 100,000 wrong rows without erroring.
 */
describe('a bare body is not a module', () => {
  it('the shape every stored transform is written in', () => {
    expect(transformDeclaresModule('return records.map((r) => ({ n: r.n }));')).toBe(false);
  });

  // The reason the rule does not look at names. This is a legitimate body that
  // declares a local helper it happens to have called `transform`; a detector
  // that matched on the declaration would call the helper with `{records,
  // context}` where a record was expected, and store a column of `undefined`
  // without a single error.
  it('even when it declares a function called transform', () => {
    const code = [
      'function transform(r) { return { mgmtCd: r["Mgmt Cd"] }; }',
      'return records.map(transform);',
    ].join('\n');
    expect(transformShape(code)).toBe('body');
  });

  it('even when the word export is in a string', () => {
    expect(transformDeclaresModule('const s = "export default x"; return [{ s }];')).toBe(false);
    expect(transformDeclaresModule("const s = 'export default x'; return [{ s }];")).toBe(false);
  });

  it('even when the word export is in a template literal, interpolation and all', () => {
    expect(
      transformDeclaresModule('const s = `export default ${records.length}`; return [{ s }];'),
    ).toBe(false);
  });

  it('even when the word export is in a comment', () => {
    expect(transformDeclaresModule('// export default nope\nreturn records;')).toBe(false);
    expect(transformDeclaresModule('/*\nexport default nope\n*/\nreturn records;')).toBe(false);
  });

  it('even when the word export is in a regular expression', () => {
    expect(transformDeclaresModule('return records.filter((r) => /export/.test(r.n));')).toBe(
      false,
    );
  });

  // The scanner's likeliest way to lose its place: an apostrophe inside a regex
  // that follows a keyword, which without the keyword list would open a string
  // literal that never closes and swallow everything after it.
  it('is not confused by an apostrophe inside a regular expression', () => {
    const code = ["const re = /don't/g;", 'return records.map((r) => ({ n: r.n.replace(re, "") }));'].join(
      '\n',
    );
    expect(transformDeclaresModule(code)).toBe(false);
  });

  it('does not read a property called export as one', () => {
    expect(transformDeclaresModule('return records.map((r) => ({ n: r.export }));')).toBe(false);
  });

  it('does not read an identifier merely starting with export as one', () => {
    expect(transformDeclaresModule('const exported = 1;\nreturn [{ exported }];')).toBe(false);
    expect(transformDeclaresModule('exports.x = 1;\nreturn [];')).toBe(false);
  });
});

describe('a module is a module', () => {
  it('export default, as a declaration', () => {
    expect(transformShape('export default function transform({ records }) { return records; }')).toBe(
      'module',
    );
  });

  it('export default, as an arrow', () => {
    expect(transformDeclaresModule('export default ({ records }) => records;')).toBe(true);
  });

  it('a named export, after other statements', () => {
    const code = [
      'const KEY = "Mgmt Cd";',
      'export function transform({ records }) {',
      '  return records.map((r) => ({ mgmtCd: r[KEY] }));',
      '}',
    ].join('\n');
    expect(transformDeclaresModule(code)).toBe(true);
  });

  // TypeScript's own export forms. They make the code a module just as much,
  // and the detector never has to know they are types.
  it('an exported type alias', () => {
    const code = [
      'export type Source = { "Mgmt Cd": string };',
      'export default ({ records }: { records: Source[] }) => records;',
    ].join('\n');
    expect(transformDeclaresModule(code)).toBe(true);
  });

  it('after a type-only import, which is the shape the editor help uses', () => {
    const code = [
      "import type { CatalogTransformFunction } from '@dudousxd/nestjs-catalog/client';",
      'const transform: CatalogTransformFunction = ({ records }) => records;',
      'export default transform;',
    ].join('\n');
    expect(transformDeclaresModule(code)).toBe(true);
  });

  it('after a comment, which does not move it off the start of a statement', () => {
    expect(transformDeclaresModule('// what this does\nexport default ({ records }) => records;')).toBe(
      true,
    );
  });

  it('after a statement that ended without a semicolon', () => {
    expect(transformDeclaresModule('const KEY = "a"\nexport default ({ records }) => records')).toBe(
      true,
    );
  });
});

describe('the hint for the case the rule and the author disagree on', () => {
  // The scanner is not a parser, so it can in principle miss an `export`. When
  // it does, the author sees a syntax error naming a keyword they believe they
  // used correctly — and no way to learn that a rule decided otherwise. The
  // hint names the rule; it does not re-run the code in the other shape, which
  // would be guessing with extra steps.
  it('names the rule when a body died on an unexpected export', () => {
    const hint = transformShapeHint('body', "SyntaxError: Unexpected token 'export'");
    expect(hint).toContain('bare function body');
    expect(hint).toContain('start of a statement');
  });

  it('says nothing about any other failure', () => {
    expect(transformShapeHint('body', 'ReferenceError: x is not defined')).toBe('');
  });

  it('says nothing at all for a module, which cannot have hit this', () => {
    expect(transformShapeHint('module', "SyntaxError: Unexpected token 'export'")).toBe('');
  });
});
