import { describe, expect, it } from 'vitest';
import { SubprocessTransformRunner } from './transform-runner';

/**
 * These spawn real child processes — `process.execPath` for JavaScript and
 * TypeScript, whatever `python3` resolves to for Python.
 *
 * Not stubbed, and that is the point: what is under test here is a harness that
 * exists only as a *string of source code for another interpreter*, so a fake
 * that returned what it was told would prove nothing about the one thing that
 * can be wrong — whether the Python actually parses, whether `print` actually
 * lands in the buffer, whether `contextlib.redirect_stdout` actually unwinds
 * around a traceback. A stub asserting all three would pass against a harness
 * that does none of them.
 *
 * Node is always there, so the JavaScript half always runs. Python may not be —
 * an image without it is a supported deployment, which is why `available()`
 * reports the languages rather than assuming them — so the Python half is
 * resolved once here and skipped as a block when there is no interpreter. It is
 * skipped loudly by vitest rather than silently passing against nothing.
 */
const runner = new SubprocessTransformRunner();
const languages = await runner.available();
const hasPython = languages.includes('python');

/** Both harnesses cap at this, and the cap is the same number on purpose. */
const MAX_LOG_LINES = 500;
const MAX_LOG_LINE_CHARS = 2_000;

function run(language: 'javascript' | 'python', code: string, records: unknown[] = []) {
  return runner.run({ language, code }, records);
}

describe('available', () => {
  // Node's own type stripping, so TypeScript is available exactly when
  // JavaScript is — no compiler, no build step, nothing to probe for.
  it('always offers javascript and typescript', () => {
    expect(languages).toContain('javascript');
    expect(languages).toContain('typescript');
  });
});

describe('the JavaScript harness', () => {
  it('returns the rows the code returned', async () => {
    const result = await run('javascript', 'return records.map(r => ({ n: r.n * 2 }));', [
      { n: 1 },
      { n: 2 },
    ]);
    expect(result.rows).toEqual([{ n: 2 }, { n: 4 }]);
  });

  // The four that were always captured. Kept as a test so the day somebody
  // reshapes the override, "console.log works" is a named failure.
  it('captures the four console channels it always captured', async () => {
    const result = await run(
      'javascript',
      'console.log("l"); console.info("i"); console.warn("w"); console.error("e"); return [];',
    );
    expect(result.logs).toEqual(['l', 'i', 'w', 'e']);
  });

  // `console.debug` writes to stdout exactly as `console.log` does, and was not
  // overridden — so a transform written with it logged into the void, which is
  // the same complaint Python's `print` produced. There is no reading of
  // "anything the code logged" that excludes it.
  it('captures console.debug and console.trace as well', async () => {
    const result = await run('javascript', 'console.debug("d"); console.trace("t"); return [];');
    expect(result.logs).toEqual(['d', 't']);
  });

  it('keeps the channels in call order, in one list', async () => {
    const result = await run(
      'javascript',
      'console.log("first"); console.error("second"); console.log("third"); return [];',
    );
    expect(result.logs).toEqual(['first', 'second', 'third']);
  });

  // The original reason the console is captured at all: user output on stdout
  // would corrupt the single JSON line the harness prints, and a transform that
  // logged a `{` would break its own result parsing.
  it('is not corrupted by a transform that logs a brace', async () => {
    const result = await run('javascript', 'console.log("{"); return [{ ok: true }];');
    expect(result.rows).toEqual([{ ok: true }]);
    expect(result.logs).toEqual(['{']);
  });

  it('caps the number of lines and says how many it dropped', async () => {
    const result = await run(
      'javascript',
      'for (let i = 0; i < 620; i += 1) console.log("line " + i); return [];',
    );
    expect(result.logs).toHaveLength(MAX_LOG_LINES + 1);
    // The FIRST lines are kept, matching `capLines` downstream: a run's log is
    // read as a narrative and the beginning is where it starts.
    expect(result.logs[0]).toBe('line 0');
    expect(result.logs[MAX_LOG_LINES - 1]).toBe(`line ${MAX_LOG_LINES - 1}`);
    expect(result.logs.at(-1)).toContain('120 more line(s) were logged and dropped');
  });

  it('caps the length of one line and says how much it cut', async () => {
    const result = await run('javascript', 'console.log("x".repeat(5000)); return [];');
    const line = result.logs[0] ?? '';
    expect(line.startsWith('x'.repeat(MAX_LOG_LINE_CHARS))).toBe(true);
    expect(line).toContain(`(${5000 - MAX_LOG_LINE_CHARS} more characters)`);
  });

  it('reports what the code logged before it threw', async () => {
    await expect(
      run('javascript', 'console.log("got here"); throw new Error("boom");'),
    ).rejects.toThrow(/got here/);
  });
});

/**
 * `describe.skipIf` rather than a silent early return, so a machine with no
 * Python reports these as skipped instead of as passing.
 */
describe.skipIf(!hasPython)('the Python harness', () => {
  it('returns the rows the code returned', async () => {
    const result = await run('python', 'return [{"n": r["n"] * 2} for r in records]', [
      { n: 1 },
      { n: 2 },
    ]);
    expect(result.rows).toEqual([{ n: 2 }, { n: 4 }]);
  });

  // THE finding. `print` used to go straight to the child's real stdout, where
  // the last-line result parse discarded it — so the most obvious thing anybody
  // writes while working out what their transform is doing produced an empty
  // log panel and no explanation at all.
  it('captures print', async () => {
    const result = await run('python', 'print("hello from print")\nreturn []');
    expect(result.logs).toEqual(['hello from print']);
  });

  // `print("a", "b")` reaches the sink as four separate writes — the parts, the
  // separator and the terminator. A sink that appended each write as its own
  // entry would shred every multi-argument call into unreadable fragments.
  it('keeps a multi-argument print as one line', async () => {
    const result = await run('python', 'print("multi", "args", 1)\nreturn []');
    expect(result.logs).toEqual(['multi args 1']);
  });

  // `warnings`, a default-configured `logging` handler and a traceback the code
  // printed itself all land on stderr, and those are exactly the lines somebody
  // is looking for when a transform misbehaves.
  it('captures stderr', async () => {
    const result = await run('python', 'import sys\nsys.stderr.write("a warning\\n")\nreturn []');
    expect(result.logs).toEqual(['a warning']);
  });

  // One buffer, one ordering. Two lists — one for stdout, one for stderr —
  // would make the interleaving unrecoverable, and the sequence is the whole
  // reason a person reads a log.
  it('interleaves stdout, stderr and log() in call order', async () => {
    const result = await run(
      'python',
      [
        'import sys',
        'print("one")',
        'sys.stderr.write("two\\n")',
        'log("three")',
        'print("four")',
        'return []',
      ].join('\n'),
    );
    expect(result.logs).toEqual(['one', 'two', 'three', 'four']);
  });

  // `log()` was the only thing that ever worked, and transforms in the wild
  // call it. It is now literally `print`, so it goes through the same buffer —
  // but a `NameError` would be a worse answer than a redundant helper.
  it('still answers to log(), through the same buffer', async () => {
    const result = await run('python', 'log("from log", 42)\nreturn []');
    expect(result.logs).toEqual(['from log 42']);
  });

  // A write with no trailing newline used to be worse than lost: it landed
  // immediately before the result JSON on the same line, so the last-line parse
  // saw `no newline here{"rows": …}` and the whole run failed as unreadable.
  it('keeps a write that never ended its line, and does not corrupt the result', async () => {
    const result = await run(
      'python',
      'import sys\nsys.stdout.write("no newline here")\nreturn [{"ok": True}]',
    );
    expect(result.rows).toEqual([{ ok: true }]);
    expect(result.logs).toEqual(['no newline here']);
  });

  it('is not corrupted by a transform that prints a brace', async () => {
    const result = await run('python', 'print("{")\nreturn [{"ok": True}]');
    expect(result.rows).toEqual([{ ok: true }]);
    expect(result.logs).toEqual(['{']);
  });

  // The case logs matter most for. The redirect is a context manager around the
  // call rather than a swap held for the whole script, precisely so it unwinds
  // on the way out of a traceback with the buffer intact.
  it('reports what the code printed before it raised', async () => {
    await expect(
      run('python', 'print("before the boom")\nraise ValueError("boom")'),
    ).rejects.toThrow(/ValueError: boom[\s\S]*before the boom/);
  });

  // The LAST lines, which is the opposite of what the display caps downstream
  // do — and deliberately. Those trim a successful run's narrative, where the
  // beginning is the story; this is the approach to a traceback, where the last
  // thing printed is what says where the code got to. Counted as well as
  // trimmed, so nobody reads a tail as the whole of it.
  it('shows the last lines before the traceback, not the first, and says how many there were', async () => {
    await expect(
      run('python', 'for i in range(40):\n    print("step", i)\nraise ValueError("boom")'),
    ).rejects.toThrow(/The last 10 of 40 lines[\s\S]*step 39/);
    await expect(
      run('python', 'for i in range(40):\n    print("step", i)\nraise ValueError("boom")'),
    ).rejects.not.toThrow(/ {2}step 0$/m);
  });

  it('caps the number of lines and says how many it dropped', async () => {
    const result = await run('python', 'for i in range(620):\n    print("line", i)\nreturn []');
    expect(result.logs).toHaveLength(MAX_LOG_LINES + 1);
    expect(result.logs[0]).toBe('line 0');
    expect(result.logs.at(-1)).toContain('120 more line(s) were logged and dropped');
  });

  it('caps the length of one line and says how much it cut', async () => {
    const result = await run('python', 'print("x" * 5000)\nreturn []');
    const line = result.logs[0] ?? '';
    expect(line.startsWith('x'.repeat(MAX_LOG_LINE_CHARS))).toBe(true);
    expect(line).toContain(`(${5000 - MAX_LOG_LINE_CHARS} more characters)`);
  });

  // The sink is bounded, not only the result. A transform writing megabytes
  // with no newline in them would otherwise accumulate the lot in the child's
  // own buffer before anything got to truncate it — unbounded memory for an
  // unbounded write. Ten unterminated writes rather than one long one, because
  // a single write is truncated identically either way: it is the accumulation
  // across writes that only a sink-side bound prevents.
  it('bounds a write that never ends its line at all', async () => {
    const result = await run(
      'python',
      `import sys\nfor i in range(10):\n    sys.stdout.write("y" * ${MAX_LOG_LINE_CHARS})\nreturn []`,
    );
    expect(result.logs.length).toBeGreaterThan(1);
    for (const line of result.logs) {
      // The truncation marker adds a fixed tail; the payload itself is capped.
      expect(line.length).toBeLessThan(MAX_LOG_LINE_CHARS + 60);
    }
  });

  // A DataFrame is accepted as a return value, and the conversion happens inside
  // the redirect — a lazily-evaluated result does its printing there, not before.
  it('still accepts a DataFrame-shaped return value', async () => {
    const result = await run(
      'python',
      [
        'class Frame:',
        '    columns = ["n"]',
        '    def to_dict(self, kind):',
        '        print("converting")',
        '        return [{"n": 1}]',
        'return Frame()',
      ].join('\n'),
    );
    expect(result.rows).toEqual([{ n: 1 }]);
    expect(result.logs).toEqual(['converting']);
  });
});

/**
 * The two harnesses are separate strings of source in separate languages, which
 * is exactly the condition under which they drift. A transform behaving
 * differently because of the language it happens to be written in is a
 * difference nobody can predict from reading either harness on its own.
 */
describe.skipIf(!hasPython)('the two harnesses agree', () => {
  it('drop the same number of lines at the same ceiling', async () => {
    const [js, py] = await Promise.all([
      run('javascript', 'for (let i = 0; i < 620; i += 1) console.log("line " + i); return [];'),
      run('python', 'for i in range(620):\n    print("line", i)\nreturn []'),
    ]);
    expect(py.logs).toHaveLength(js.logs.length);
    expect(py.logs.at(-1)).toBe(js.logs.at(-1));
  });

  it('truncate a long line at the same ceiling, with the same marker', async () => {
    const [js, py] = await Promise.all([
      run('javascript', 'console.log("x".repeat(5000)); return [];'),
      run('python', 'print("x" * 5000)\nreturn []'),
    ]);
    expect(py.logs[0]).toBe(js.logs[0]);
  });
});
