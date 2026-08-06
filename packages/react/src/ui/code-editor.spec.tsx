// @vitest-environment jsdom
//
// The docblock below must stay attached to the FIRST import in source order, and that import must
// be the one Biome's `organizeImports` would sort first — otherwise the sorter moves another
// import above this line, Vitest stops finding the environment hint, and every test here fails in
// `node` with `document is not defined`.
/**
 * The code editor, and the bug that decided what it is built on.
 *
 * THE BUG
 * -------
 * Somebody selected `checked_fields` on the first line of the SQL box and cut
 * `checked_fields-` — one character more than they had selected — and reported
 * the caret landing on "the final line + 1".
 *
 * The obvious suspect was the old two-layer editor disagreeing with itself: a
 * transparent `<textarea>` over a Prism `<pre>`, both `whitespace-pre-wrap
 * break-words`, and a wrap position that differed between them would put the
 * selection somewhere other than where it looked. Measured in Chrome, they do
 * not disagree. 3,725 fuzzed bodies at fifteen container widths, plus tabs, CJK,
 * emoji, RTL, combining marks, unbreakable runs, trailing spaces at a wrap
 * point, blank lines and a trailing newline: identical break positions every
 * time, and glyphs that overlaid to the pixel.
 *
 * What actually happened is that the box SOFT-WRAPPED and said nothing about it.
 * At the width in play, `SELECT id, checked_fields-checked_fields_total AS drift
 * FROM obj_mvr` wrapped after `checked_fields-`, and `Home` then `Shift+End` in
 * a textarea select to the end of the VISUAL row — so "select to the end of the
 * line" handed back the identifier plus the hanging hyphen. Reproduced exactly:
 * caret to offset 11, `Shift+End`, selection `[11, 26)`, text `checked_fields-`.
 * The same wrapping is the "final line + 1": that thirteen-line query occupied
 * fourteen rows, and with no gutter there was nothing on screen to say so.
 *
 * So the two tests this file exists for are the two properties that make those
 * symptoms impossible — the code scrolls rather than wraps, and the lines are
 * numbered. Everything else here is the price of the dependency that provides
 * them, written down as assertions rather than as prose.
 *
 * THE SECOND BUG, AND WHY IT IS NOT REALLY TESTED HERE
 * ---------------------------------------------------
 * `overflow: 'scroll'` bought the horizontal axis and said nothing about the
 * vertical one, so a body taller than its box was clipped by the wrapper with no
 * way to reach it: a real wheel over the SQL box scrolled the PAGE and left the
 * editor on line 1. The repair is in the wrapper's classes and is described in
 * `code-editor.tsx`.
 *
 * It is worth being blunt about what the test below is: jsdom lays nothing out
 * and no Tailwind runs in it, so `scrollHeight` and `clientHeight` are both zero
 * and `getComputedStyle` knows nothing of `overflow-y-auto`. An assertion that
 * the wrapper "can scroll" would compare 0 to 0 and pass against the broken
 * component just as happily as against the fixed one. So the test pins the CLASS
 * — which is the thing a future edit would delete — and the behaviour it stands
 * for was verified in Chrome instead: with a 61-line body in an `h-56` box, a
 * CDP-dispatched wheel moved the wrapper's `scrollTop` from 0 to 1013 and left
 * `window.scrollY` at 0, a drag on the 15px scrollbar took it to 636, and
 * `Shift+End` on the 1463px-wide first line still selected the whole logical
 * line in a 657px box.
 */
import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installCodeSurfaceDom } from '../../../../test/jsdom-code-surface';
import { CodeEditor, type CodeEditorHandle, codeEditorRoot, codeEditorText } from './code-editor';
import { useCodeThemeType } from './code-theme';

declare global {
  // Not declared by @types/react, and RTL manages it around its own `act` calls;
  // setting it up front keeps React from warning on the renders below.
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

installCodeSurfaceDom();

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove('dark');
});

const SQL = 'SELECT id, checked_fields-checked_fields_total AS drift FROM obj_mvr\nFROM obj_mvr';

/**
 * Render, and wait for the editor to actually paint.
 *
 * The paint is asynchronous — highlighting resolves, then a `ResizeObserver`
 * reports a box, then rows are written. A spec that asserted straight after
 * `render` would read an empty shadow root and blame whatever it was asserting.
 */
async function editor(props: Partial<Parameters<typeof CodeEditor>[0]> = {}) {
  const onChange = vi.fn();
  const view = render(
    <CodeEditor value={SQL} onChange={onChange} language="sql" label="SQL query" {...props} />,
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  const root = codeEditorRoot(view.container);
  // Thrown rather than asserted-and-cast: every caller below dereferences `root`, and a `?.` chain
  // on a null one turns "the editor did not render" into a passing `toBeNull()` somewhere else.
  if (!root) throw new Error('the editor did not render into a shadow root');
  const host = view.container.querySelector('diffs-container');
  const wrapper = view.container.firstElementChild;
  if (!(host instanceof HTMLElement) || !(wrapper instanceof HTMLElement)) {
    throw new Error('the editor did not render its host element');
  }
  return { onChange, view, root, host, wrapper };
}

/** A tab stop either side of the rendered editor, in real document order. */
function neighbours() {
  const previous = document.createElement('button');
  previous.textContent = 'previous';
  const next = document.createElement('button');
  next.textContent = 'next';
  document.body.prepend(previous);
  document.body.append(next);
  return {
    previous,
    next,
    remove: () => {
      previous.remove();
      next.remove();
    },
  };
}

describe('CodeEditor', () => {
  it('shows the code it was given', async () => {
    const { view } = await editor();

    expect(codeEditorText(view.container)).toContain('checked_fields');
  });

  describe('the bug', () => {
    it('scrolls long lines instead of wrapping them', async () => {
      // THE regression. With `overflow: wrap`, `End` and `Shift+End` stop
      // meaning "the end of this line of SQL" and start meaning "the end of
      // whatever fitted", which is how a selection of `checked_fields` came back
      // as `checked_fields-`. Asserted on the rendered attribute rather than on
      // the option object, because it is the attribute the layout reads.
      const { root } = await editor();

      expect(root.querySelector('pre')?.getAttribute('data-overflow')).toBe('scroll');
    });

    it('numbers the lines, so a row on screen is a line in the SQL', async () => {
      // The other half. A thirteen-line query rendering as fourteen rows is only
      // confusing while nothing says which line you are on; the gutter says it,
      // and it says it once per LINE rather than once per row.
      const { root } = await editor();

      const numbers = [...root.querySelectorAll('[data-line-number-content]')];
      expect(numbers.length).toBe(SQL.split('\n').length);
      // The number column can be switched off without removing the gutter nodes, so the switch is
      // asserted too — otherwise `disableLineNumbers: true` leaves this test green and the gutter
      // blank, which is exactly the state it exists to prevent.
      expect(root.querySelector('pre')?.hasAttribute('data-disable-line-numbers')).toBe(false);
    });
  });

  describe('the second bug', () => {
    it('makes the wrapper the vertical viewport, because nothing inside the editor is one', async () => {
      // `@pierre/diffs` scrolls the X axis and clips the Y one: its `[data-code]`
      // sizes to the whole document, `File` owns no vertical viewport, and the
      // only property it exposes substitutes into the X component. So the box a
      // tall query scrolls in has to be the wrapper, and `overflow-hidden` — what
      // used to be here — is defined as clipping WITHOUT offering a scrolling
      // mechanism.
      //
      // The class, not the geometry: see this file's header. jsdom reports 0 for
      // both heights and knows no Tailwind, so a geometric assertion would pass
      // on the broken component too.
      const { wrapper } = await editor();

      expect(wrapper.className).toContain('overflow-y-auto');
      // The other half, and not decoration: the horizontal scroller is inside
      // the shadow root, and an `overflow-x` left `visible` beside a scrolling Y
      // axis computes to `auto` — a second, permanently empty scrollbar stacked
      // on the real one.
      expect(wrapper.className).toContain('overflow-x-hidden');
    });
  });

  describe('what the caller still gets', () => {
    it('names the editable element after the label, which is its only accessible name', async () => {
      // A contenteditable has no `<label>` to be associated with. The editor
      // copies the file's name onto `aria-label`, which is why `label` is passed
      // as the name — see the component. Without this the box is announced as
      // nothing at all.
      const { root } = await editor({ label: 'Transform code' });

      expect(root.querySelector('[aria-label="Transform code"]')).toBeTruthy();
    });

    it('reports edits through onChange', async () => {
      // Through the handle rather than by typing: jsdom has no caret, so the
      // insert takes the no-selection path — which is itself the branch worth
      // pinning, because it is what a click on a relation name does before
      // anybody has focused the editor.
      const handleRef: { current: CodeEditorHandle | null } = { current: null };
      const { onChange } = await editor({ handleRef });

      act(() => handleRef.current?.insertAtCursor(' LIMIT 10'));

      expect(onChange).toHaveBeenCalledWith(`${SQL} LIMIT 10`);
    });
  });

  describe('the keyboard', () => {
    it('parks focus on the wrapper when Escape is pressed', async () => {
      // A keyboard trap otherwise: the editor binds Tab to "indent", and its own
      // Escape is bound to "simplify selection" rather than to letting go.
      const { wrapper } = await editor();

      fireEvent.keyDown(wrapper, { key: 'Escape' });

      expect(document.activeElement).toBe(wrapper);
    });

    it('then leaves on Tab, rather than falling back into the editor', async () => {
      // The half that was wrong first time round and only showed up in a real
      // browser: focus parked on the wrapper has the editor as its NEXT tab
      // stop, because the editor is inside the wrapper — so Escape-then-Tab put
      // you straight back where you started and the trap was still a trap.
      const { wrapper } = await editor();
      // Both neighbours, and added AFTER the render so their positions relative
      // to the editor are real. With only one candidate on the page a
      // `focusOutside` that ignored direction entirely would still pass.
      const { previous, next, remove } = neighbours();

      fireEvent.keyDown(wrapper, { key: 'Escape' });
      fireEvent.keyDown(wrapper, { key: 'Tab' });

      expect(document.activeElement).toBe(next);
      expect(document.activeElement).not.toBe(previous);
      remove();
    });

    it('leaves backwards on Shift+Tab', async () => {
      const { wrapper } = await editor();
      const { previous, next, remove } = neighbours();

      fireEvent.keyDown(wrapper, { key: 'Escape' });
      fireEvent.keyDown(wrapper, { key: 'Tab', shiftKey: true });

      expect(document.activeElement).toBe(previous);
      expect(document.activeElement).not.toBe(next);
      remove();
    });

    it('leaves Tab to the editor while the caret is still in it', async () => {
      // Tab indents. Taking it over unconditionally would break that, which is
      // the behaviour the hatch exists to make safe rather than to undo.
      const { wrapper, host } = await editor();
      const { next, remove } = neighbours();

      fireEvent.keyDown(host, { key: 'Tab' });

      expect(document.activeElement).not.toBe(next);
      expect(document.activeElement).not.toBe(wrapper);
      remove();
    });

    it('gives a host shortcut the key outright, so ⌘↵ does not also insert a blank line', async () => {
      // The editor's default keymap binds ⌘↵ to `insertBlankLine`. A host
      // handler that merely OBSERVED the key would run the query and leave a
      // blank line in it. Claiming it with `preventDefault` has to stop the
      // event before it reaches the editor, which is what the capture-phase
      // listener is for — asserted by watching for it at the editor's own host.
      const reachedEditor = vi.fn();
      const onKeyDown = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
      const { host } = await editor({ onKeyDown });
      host.addEventListener('keydown', reachedEditor, true);

      fireEvent.keyDown(host, { key: 'Enter', metaKey: true });

      expect(onKeyDown).toHaveBeenCalled();
      expect(reachedEditor).not.toHaveBeenCalled();
    });

    it('leaves a key the host did not claim to the editor', async () => {
      // The other side of the same rule. Stopping every keystroke the wrapper
      // sees would break typing, which is a bug no assertion above would catch.
      const reachedEditor = vi.fn();
      const onKeyDown = vi.fn();
      const { host } = await editor({ onKeyDown });
      host.addEventListener('keydown', reachedEditor, true);

      fireEvent.keyDown(host, { key: 'a' });

      expect(onKeyDown).toHaveBeenCalled();
      expect(reachedEditor).toHaveBeenCalled();
    });
  });
});

describe('useCodeThemeType', () => {
  it('follows a `dark` class rather than asking the OS, when a host has set one', async () => {
    // Tailwind's `class` strategy. The rest of this package is painted by
    // `dark:` variants, and a code box that asked `prefers-color-scheme` while
    // the console was dark by class is the exact failure the old Prism theme
    // shipped with: unreadable, and nothing logged.
    document.documentElement.classList.add('dark');

    const { result } = renderHook(() => useCodeThemeType());

    expect(result.current).toBe('dark');
  });

  it('defers to the OS when nothing has said otherwise', async () => {
    // Tailwind's default `media` strategy, which IS `prefers-color-scheme` —
    // so `system` is not a shrug, it is the matching answer.
    const { result } = renderHook(() => useCodeThemeType());

    expect(result.current).toBe('system');
  });

  it('notices a theme toggled after it mounted', async () => {
    // A toggle is a runtime event. An editor that kept yesterday's palette until
    // a reload is the same complaint in a slower form.
    const { result } = renderHook(() => useCodeThemeType());
    expect(result.current).toBe('system');

    await act(async () => {
      document.documentElement.classList.add('dark');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(result.current).toBe('dark');
  });
});
