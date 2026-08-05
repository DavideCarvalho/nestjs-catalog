/**
 * The comparison itself, tested as the pure function it is.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A diff is the rare piece of UI whose output is a claim rather than a
 * presentation. "These four lines changed and those three hundred did not" is
 * something somebody is going to act on — reverting a transform, approving a
 * saved query, deciding a load was fine — and a diff that is subtly wrong is
 * worse than no diff, because it is confidently wrong in a format people have
 * been trained to trust.
 *
 * So the assertions here are on the WHOLE line list, not on counts. A test that
 * checked `added === 1` passes for an implementation that marks the right line
 * added and three others removed, which is the exact failure this screen must
 * not have. The first test in this file is that test, written the strict way.
 *
 * Nothing here touches the DOM: `diffLines` and `foldUnchanged` take strings and
 * arrays and have no imports at all, which is a large part of why they are
 * hand-rolled rather than a dependency. See the module header.
 */
import { describe, expect, it } from 'vitest';
import { DIFF_MAX_CELLS, type DiffLine, diffLines, foldUnchanged } from './line-diff';

/** The compact form, so a whole expected diff fits on screen and can be read. */
function shape(lines: DiffLine[]): string[] {
  return lines.map(
    (line) =>
      `${line.op === 'added' ? '+' : line.op === 'removed' ? '-' : ' '}${line.before ?? ''}/${line.after ?? ''} ${line.text}`,
  );
}

describe('diffLines', () => {
  it('names the one line that changed and claims nothing about the others', () => {
    // THE test. Two four-line bodies differing in the third line only. Asserted
    // as the complete list rather than as counts, because "1 added, 1 removed"
    // is also what you get from an implementation that picked the wrong line, or
    // that reported the whole file as replaced and happened to net out.
    const before = 'const a = 1;\nconst b = 2;\nreturn a + b;\n// done';
    const after = 'const a = 1;\nconst b = 2;\nreturn a * b;\n// done';

    const diff = diffLines(before, after);

    expect(shape(diff.lines)).toEqual([
      ' 1/1 const a = 1;',
      ' 2/2 const b = 2;',
      '-3/ return a + b;',
      '+/3 return a * b;',
      ' 4/4 // done',
    ]);
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    expect(diff.identical).toBe(false);
    expect(diff.alignment).toBe('exact');
  });

  it('numbers each side against its own body when a line is inserted', () => {
    // The half a diff gets wrong quietly. After an insertion the two sides stop
    // agreeing about line numbers, and a renderer showing one number for both
    // sends somebody to the wrong line of the file they are actually editing.
    const diff = diffLines('a\nb\nc', 'a\nNEW\nb\nc');

    expect(shape(diff.lines)).toEqual([' 1/1 a', '+/2 NEW', ' 2/3 b', ' 3/4 c']);
  });

  it('numbers each side against its own body when a line is deleted', () => {
    const diff = diffLines('a\nGONE\nb\nc', 'a\nb\nc');

    expect(shape(diff.lines)).toEqual([' 1/1 a', '-2/ GONE', ' 3/2 b', ' 4/3 c']);
  });

  it('puts every removal of a hunk above every addition', () => {
    // The unified-diff order, which the renderer's red-block-then-green-block
    // depends on. An LCS walk that breaks ties towards the addition interleaves
    // them — still a correct diff, and much harder to read, because a four-line
    // rewrite becomes eight alternating stripes.
    const diff = diffLines('head\nx1\nx2\ntail', 'head\ny1\ny2\ntail');

    expect(shape(diff.lines)).toEqual([
      ' 1/1 head',
      '-2/ x1',
      '-3/ x2',
      '+/2 y1',
      '+/3 y2',
      ' 4/4 tail',
    ]);
  });

  it('reports two identical bodies as identical, not merely as zero changes', () => {
    // A separate field, because the screen has three other kinds of nothing to
    // render — no history, one version, a version that is not recorded — and
    // only this one is allowed to say "nothing changed".
    const diff = diffLines('a\nb', 'a\nb');

    expect(diff.identical).toBe(true);
    expect(diff.added).toBe(0);
    expect(diff.removed).toBe(0);
    expect(shape(diff.lines)).toEqual([' 1/1 a', ' 2/2 b']);
  });

  it('treats an empty body as no lines rather than one empty line', () => {
    // Writing the first version of a transform should read as N additions. With
    // `''.split('\n')` — which answers `['']` — it reads as N additions and one
    // mysterious deleted blank line at the top.
    const diff = diffLines('', 'a\nb');

    expect(shape(diff.lines)).toEqual(['+/1 a', '+/2 b']);
    expect(diff.removed).toBe(0);
  });

  it('keeps the trailing empty line a trailing newline actually creates', () => {
    // `a\n` is two lines, the second empty, and it is a real difference from
    // `a`: the stored bodies differ by a byte and a connector pinned to one runs
    // different text from one pinned to the other.
    const diff = diffLines('a', 'a\n');

    expect(shape(diff.lines)).toEqual([' 1/1 a', '+/2 ']);
  });

  it('reports a line-ending change as a change, because it is one', () => {
    // Noisy and true. Normalising CRLF away would answer "would these be the
    // same if we ignored the endings" in place of the question that was asked.
    const diff = diffLines('a\r\nb\r\nc', 'a\nb\nc');

    expect(diff.added).toBe(2);
    expect(diff.removed).toBe(2);
    expect(diff.identical).toBe(false);
  });

  it('lines up a small edit inside a large body without falling back', () => {
    // The trim is what makes this cheap: three hundred lines, one changed, and
    // the DP table is a handful of cells rather than ninety thousand. The
    // observable part is that the answer is still exact and still names one line.
    const lines = Array.from({ length: 300 }, (_, index) => `line ${index}`);
    const edited = [...lines];
    edited[150] = 'line 150 // touched';

    const diff = diffLines(lines.join('\n'), edited.join('\n'));

    expect(diff.alignment).toBe('exact');
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    expect(diff.lines.filter((line) => line.op !== 'same').map((line) => line.text)).toEqual([
      'line 150',
      'line 150 // touched',
    ]);
  });

  it('says so instead of building a table it cannot afford', () => {
    // Two bodies sharing nothing, past DIFF_MAX_CELLS. The whole changed region
    // comes back as removed-then-added — true, blunter than usual — and
    // `alignment` says which of the two it is, so the screen can tell somebody
    // rather than letting them read "everything changed" as a finding.
    const side = Math.ceil(Math.sqrt(DIFF_MAX_CELLS)) + 10;
    const before = Array.from({ length: side }, (_, index) => `a${index}`).join('\n');
    const after = Array.from({ length: side }, (_, index) => `b${index}`).join('\n');

    const diff = diffLines(before, after);

    expect(diff.alignment).toBe('coarse');
    expect(diff.added).toBe(side);
    expect(diff.removed).toBe(side);
    expect(diff.lines[0]).toMatchObject({ op: 'removed', text: 'a0' });
    expect(diff.lines[side]).toMatchObject({ op: 'added', text: 'b0' });
  });
});

describe('foldUnchanged', () => {
  /** `n` lines of unchanged text with one changed line at `at`. */
  function withOneChangeAt(total: number, at: number): DiffLine[] {
    return Array.from({ length: total }, (_, index) =>
      index === at
        ? { op: 'added' as const, before: null, after: index + 1, text: `line ${index}` }
        : { op: 'same' as const, before: index + 1, after: index + 1, text: `line ${index}` },
    );
  }

  it('keeps three lines either side of a change and folds the rest', () => {
    const sections = foldUnchanged(withOneChangeAt(40, 20));

    expect(sections.map((section) => `${section.kind}:${section.lines.length}`)).toEqual([
      // Lines 0–16 collapse; 17, 18, 19 are the context above.
      'folded:17',
      // The context above, the change, and the context below.
      'shown:7',
      // 24–39 collapse.
      'folded:16',
    ]);
    const shown = sections.find((section) => section.kind === 'shown');
    expect(shown?.lines.map((line) => line.text)).toEqual([
      'line 17',
      'line 18',
      'line 19',
      'line 20',
      'line 21',
      'line 22',
      'line 23',
    ]);
  });

  it('carries the folded lines rather than a count, so they can be opened', () => {
    // A diff that hides code with no way to see it is a diff you cannot trust,
    // and this is code somebody is about to make a decision about.
    const sections = foldUnchanged(withOneChangeAt(40, 20));
    const folded = sections.find((section) => section.kind === 'folded');

    expect(folded?.lines[0]?.text).toBe('line 0');
    expect(folded?.lines.at(-1)?.text).toBe('line 16');
  });

  it('shows a short unchanged run rather than putting a button on it', () => {
    // Folding two lines behind a control that says "2 unchanged lines" costs a
    // row to save two, and it costs a click.
    const lines: DiffLine[] = [
      { op: 'added', before: null, after: 1, text: 'x' },
      { op: 'same', before: 1, after: 2, text: 'a' },
      { op: 'same', before: 2, after: 3, text: 'b' },
      { op: 'added', before: null, after: 4, text: 'y' },
    ];

    expect(foldUnchanged(lines).map((section) => section.kind)).toEqual(['shown']);
  });

  it('gives a run at the very start of the file no context above it', () => {
    // There is no change up there to be in the context of, so keeping three
    // lines would be three lines of nothing at the top of every comparison.
    const sections = foldUnchanged(withOneChangeAt(40, 30));

    expect(sections[0]).toMatchObject({ kind: 'folded' });
    expect(sections[0]?.lines[0]?.text).toBe('line 0');
    expect(sections[0]?.lines.length).toBe(27);
  });

  it('folds an unchanged body away entirely, which is what identical looks like', () => {
    const sections = foldUnchanged(
      Array.from({ length: 30 }, (_, index) => ({
        op: 'same' as const,
        before: index + 1,
        after: index + 1,
        text: `line ${index}`,
      })),
    );

    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ kind: 'folded' });
    expect(sections[0]?.lines).toHaveLength(30);
  });
});
