/**
 * Two texts, lined up, computed in this file and nowhere else.
 *
 * WHY THIS IS HAND-ROLLED
 * -----------------------
 * The two strings this console ever diffs are a transform's code and a saved
 * query's SQL. Those are the most sensitive strings in the product: a transform
 * is executable code with the catalog's own database reachable from it, and a
 * saved query is somebody's SQL against military logistics data — the column
 * names alone describe a fleet. A diff library is a dependency that gets to see
 * both, on every render, and "it only renders locally" is a property of the
 * version you audited rather than of the package. There is no version of this
 * feature worth a supply-chain question mark on that content, so there is no
 * dependency here at all: `diffLines` is forty lines of dynamic programming with
 * no imports, and the whole of what it can do is visible on this screen.
 *
 * It is also the cheaper answer. This package already declines dependencies it
 * could plausibly justify — `charts/css.tsx` draws bars with divs, `ui/button.tsx`
 * hand-rolls what `class-variance-authority` would compile to, and `export/pdf.ts`
 * is a seam rather than a renderer — for the same reason each time: every
 * consumer pays for it whether or not they render this screen.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * No word- or character-level diff inside a changed line, and no move detection.
 * A changed line is reported as a removal and an addition, which is what a
 * unified diff has always done and what the renderer colours. Both are real
 * improvements somebody could make; neither is the question this screen exists
 * to answer, which is "which lines are different between the version that ran
 * and the version that is current".
 */

/**
 * The largest DP table this will build, in cells.
 *
 * The comparison is O(n·m) in the CHANGED region only — the common prefix and
 * suffix are trimmed first, so the ordinary case (somebody edited four lines of
 * a three-hundred-line transform) is a handful of cells regardless of file size.
 * This bound exists for the case that survives the trim: two bodies that share
 * almost nothing, which is what a rewrite looks like.
 *
 * 1.5M cells is a `Uint32Array` of 6MB and roughly a 1,200×1,200 changed region.
 * Past that the table costs more memory than the browser tab should spend on a
 * comparison nobody could read anyway, so {@link diffLines} stops computing and
 * SAYS it stopped — see `alignment`. A silent fallback would be the same failure
 * `capLines` names one package over: a truncation nobody is told about.
 */
export const DIFF_MAX_CELLS = 1_500_000;

/** What happened to one line between the two bodies. */
export type DiffOp = 'same' | 'added' | 'removed';

export interface DiffLine {
  op: DiffOp;
  /** 1-based line number in the earlier body. Null on an added line. */
  before: number | null;
  /** 1-based line number in the later body. Null on a removed line. */
  after: number | null;
  text: string;
}

export interface LineDiff {
  lines: DiffLine[];
  added: number;
  removed: number;
  /**
   * The two bodies are byte-for-byte the same.
   *
   * A separate field rather than `added === 0 && removed === 0`, because the
   * caller has to distinguish "these two versions are identical" from "there is
   * no second version to compare against", and only one of those is a statement
   * about the texts. See `RevisionDiff`, where conflating them is the exact
   * thing the empty states are written to avoid.
   */
  identical: boolean;
  /**
   * How the lines were matched up.
   *
   * `exact` means every line was lined up against its counterpart. `coarse`
   * means the changed region was past {@link DIFF_MAX_CELLS} and the whole of it
   * is reported as removed-then-added — true, but blunter than it could be, and
   * the screen says so rather than letting somebody read "everything changed" as
   * a finding about their code.
   */
  alignment: 'exact' | 'coarse';
}

/**
 * Split on `\n` alone, and keep whatever that leaves.
 *
 * A lone `\r` therefore stays inside the line text, so a body that changed from
 * CRLF to LF reports every line as changed. That is noisy and it is also true:
 * the stored bodies differ on every line, a connector pinned to the old version
 * would run different bytes, and a diff that normalised the endings away would
 * be answering a question nobody asked ("would these be the same if…") in place
 * of the one they did.
 *
 * An empty body is zero lines rather than one empty line, so writing the first
 * version of a transform reads as N additions rather than N additions and one
 * mysterious deletion. A body ending in a newline genuinely does have a trailing
 * empty line and keeps it.
 */
function splitLines(text: string): string[] {
  return text.length === 0 ? [] : text.split('\n');
}

/**
 * Line up two bodies.
 *
 * `before` is the earlier version, `after` the later one. The order matters to
 * the reading and not to the algorithm: swapping them turns every addition into
 * a removal, which is why the caller that pins "the version that ran" on the
 * left is the one that gets a screen answering "what changed since".
 */
export function diffLines(before: string, after: string): LineDiff {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);

  if (before === after) {
    return {
      lines: beforeLines.map((text, index) => ({
        op: 'same',
        before: index + 1,
        after: index + 1,
        text,
      })),
      added: 0,
      removed: 0,
      identical: true,
      alignment: 'exact',
    };
  }

  // The trim, which is what makes this cheap on the case that actually happens.
  // A four-line edit inside a three-hundred-line transform leaves a DP table of
  // sixteen cells; without it, ninety thousand.
  let head = 0;
  while (
    head < beforeLines.length &&
    head < afterLines.length &&
    beforeLines[head] === afterLines[head]
  ) {
    head += 1;
  }

  let tail = 0;
  while (
    tail < beforeLines.length - head &&
    tail < afterLines.length - head &&
    beforeLines[beforeLines.length - 1 - tail] === afterLines[afterLines.length - 1 - tail]
  ) {
    tail += 1;
  }

  const beforeMiddle = beforeLines.slice(head, beforeLines.length - tail);
  const afterMiddle = afterLines.slice(head, afterLines.length - tail);

  const middle =
    beforeMiddle.length * afterMiddle.length > DIFF_MAX_CELLS
      ? coarse(beforeMiddle, afterMiddle, head)
      : align(beforeMiddle, afterMiddle, head);

  const lines: DiffLine[] = [
    ...beforeLines.slice(0, head).map((text, index) => sameLine(text, index + 1, index + 1)),
    ...middle.lines,
    ...beforeLines
      .slice(beforeLines.length - tail)
      .map((text, index) =>
        sameLine(text, beforeLines.length - tail + index + 1, afterLines.length - tail + index + 1),
      ),
  ];

  return {
    lines,
    added: middle.added,
    removed: middle.removed,
    identical: false,
    alignment: middle.alignment,
  };
}

function sameLine(text: string, before: number, after: number): DiffLine {
  return { op: 'same', before, after, text };
}

interface Middle {
  lines: DiffLine[];
  added: number;
  removed: number;
  alignment: 'exact' | 'coarse';
}

/**
 * The longest common subsequence of two line arrays, walked into a diff.
 *
 * The table is filled from the end so the walk can go forwards, which is what
 * keeps the output in file order without a reversal at the end. `Uint32Array`
 * rather than nested arrays because the table is the only thing here that has a
 * size worth thinking about, and a flat typed array is one allocation.
 *
 * When neither direction is better the walk prefers the REMOVAL, which is what
 * puts every deleted line of a hunk above every added one — the unified-diff
 * order, and the order the renderer's red-then-green block depends on.
 */
function align(beforeMiddle: string[], afterMiddle: string[], offset: number): Middle {
  const m = beforeMiddle.length;
  const n = afterMiddle.length;
  const width = n + 1;
  const table = lcsTable(beforeMiddle, afterMiddle);

  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;

  while (i < m && j < n) {
    if (beforeMiddle[i] === afterMiddle[j]) {
      lines.push(sameLine(beforeMiddle[i] ?? '', offset + i + 1, offset + j + 1));
      i += 1;
      j += 1;
    } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
      lines.push(removedLine(beforeMiddle[i] ?? '', offset + i + 1));
      removed += 1;
      i += 1;
    } else {
      lines.push(addedLine(afterMiddle[j] ?? '', offset + j + 1));
      added += 1;
      j += 1;
    }
  }

  // Whatever is left when one side runs out. Removals first, again, so a hunk at
  // the very end of the file reads the same way as one in the middle.
  const tail = drain(beforeMiddle.slice(i), afterMiddle.slice(j), offset + i, offset + j);
  lines.push(...tail.lines);

  return {
    lines,
    added: added + tail.added,
    removed: removed + tail.removed,
    alignment: 'exact',
  };
}

/**
 * The remainder of one side, once the walk has exhausted the other.
 *
 * At most one of these two arrays is non-empty — the walk only stops when an
 * index reaches its end — so this is not a second comparison. It is the same
 * shape as {@link coarse}, and calling that would have been tempting; it is
 * separate because `coarse` means "we declined to line these up" and this means
 * "there was nothing left to line them up against", and a screen that reads
 * `alignment` must not be told the first when the second happened.
 */
function drain(
  beforeRest: string[],
  afterRest: string[],
  beforeOffset: number,
  afterOffset: number,
): Omit<Middle, 'alignment'> {
  return {
    lines: [
      ...beforeRest.map((text, index) => removedLine(text, beforeOffset + index + 1)),
      ...afterRest.map((text, index) => addedLine(text, afterOffset + index + 1)),
    ],
    added: afterRest.length,
    removed: beforeRest.length,
  };
}

/**
 * `table[i * width + j]` is the length of the longest common subsequence of
 * `a.slice(i)` and `b.slice(j)`.
 *
 * Filled from the END, which is what lets {@link align} walk forwards and emit
 * lines already in file order rather than reversing at the finish.
 */
function lcsTable(a: string[], b: string[]): Uint32Array {
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);

  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[i] === b[j]
          ? (table[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
    }
  }

  return table;
}

function removedLine(text: string, before: number): DiffLine {
  return { op: 'removed', before, after: null, text };
}

function addedLine(text: string, after: number): DiffLine {
  return { op: 'added', before: null, after, text };
}

/** The whole changed region as one removal and one addition. See {@link DIFF_MAX_CELLS}. */
function coarse(beforeMiddle: string[], afterMiddle: string[], offset: number): Middle {
  return {
    lines: [
      ...beforeMiddle.map((text, index) => ({
        op: 'removed' as const,
        before: offset + index + 1,
        after: null,
        text,
      })),
      ...afterMiddle.map((text, index) => ({
        op: 'added' as const,
        before: null,
        after: offset + index + 1,
        text,
      })),
    ],
    added: afterMiddle.length,
    removed: beforeMiddle.length,
    alignment: 'coarse',
  };
}

/** Lines to keep either side of a change before folding the rest away. */
export const DIFF_CONTEXT_LINES = 3;

/**
 * The smallest run worth putting a button on.
 *
 * Folding two lines behind a control that says "2 unchanged lines" costs a row
 * to save two, and it costs a click. Below this the run is simply shown.
 */
export const DIFF_MIN_FOLD = 4;

export type DiffSection =
  | { kind: 'shown'; lines: DiffLine[] }
  | { kind: 'folded'; lines: DiffLine[] };

/**
 * Collapse the long unchanged stretches, keeping context around every change.
 *
 * A transform can be hundreds of lines and the answer to "why did Tuesday's load
 * differ from Monday's" is almost never more than a handful of them. Rendering
 * all of it puts the four lines that matter somewhere in the middle of a wall
 * and makes the reader scroll for them.
 *
 * Folded rather than dropped, and the sections carry their lines rather than a
 * count, so the renderer can expand one in place. A diff that hides code with no
 * way to see it is a diff you cannot trust, and this is code somebody is about
 * to make a decision about.
 *
 * A run at the very start or end of the file gets no context on that side —
 * there is no change up there to be in the context of.
 */
export function foldUnchanged(
  lines: DiffLine[],
  context: number = DIFF_CONTEXT_LINES,
  minFold: number = DIFF_MIN_FOLD,
): DiffSection[] {
  const sections: DiffSection[] = [];
  let shown: DiffLine[] = [];

  const flush = () => {
    if (shown.length > 0) {
      sections.push({ kind: 'shown', lines: shown });
      shown = [];
    }
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line) break;

    if (line.op !== 'same') {
      shown.push(line);
      index += 1;
      continue;
    }

    const end = runEnd(lines, index);
    const run = lines.slice(index, end);

    // No context on a side there is no change on: a run touching the start of
    // the file has nothing above it to be the context of, and neither does one
    // touching the end.
    const leading = index === 0 ? 0 : context;
    const trailing = end === lines.length ? 0 : context;

    if (run.length > leading + trailing + minFold) {
      shown.push(...run.slice(0, leading));
      flush();
      sections.push({ kind: 'folded', lines: run.slice(leading, run.length - trailing) });
      shown.push(...run.slice(run.length - trailing));
    } else {
      shown.push(...run);
    }

    index = end;
  }

  flush();
  return sections;
}

/** Where the run of unchanged lines starting at `start` stops. */
function runEnd(lines: DiffLine[], start: number): number {
  let end = start;
  while (end < lines.length && lines[end]?.op === 'same') end += 1;
  return end;
}
