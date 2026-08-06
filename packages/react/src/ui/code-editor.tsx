import { Editor } from '@pierre/diffs/edit';
import { EditProvider, File } from '@pierre/diffs/react';
import type { KeyboardEvent, Ref } from 'react';
import { useImperativeHandle, useRef } from 'react';
import { cn } from '../cn';
import type { CatalogCodeLanguage } from './code-languages';
import { type CodeThemeType, useCodeThemeType } from './code-theme';

/**
 * A code editor: `@pierre/diffs` in edit mode, wrapped so the rest of this
 * package can hand it a string and get one back.
 *
 * WHAT THIS REPLACED, AND THE BUG THAT ENDED IT
 * ---------------------------------------------
 * A transparent `<textarea>` over a Prism-highlighted `<pre>`, both wearing
 * `whitespace-pre-wrap break-words`. The docblock that used to be here argued
 * that a textarea is the best plain-text input the platform has — caret,
 * selection, undo, IME, accessibility, all free — and that argument was correct
 * and is why it survived so long. What it did not account for is that a
 * SOFT-WRAPPED textarea is not editing the lines you can see. `Home`, `End`,
 * `Shift+End` and the vertical arrows all work on VISUAL rows, so a SQL line
 * that wrapped after `checked_fields-` answered "select to the end of the line"
 * with `checked_fields-`: one character more than the identifier, because the
 * hyphen was the last glyph on that row. The same wrapping is why a thirteen-line
 * query put the caret on a fourteenth line. Neither is a bug in the textarea;
 * both are what soft wrap means when nothing on screen admits it is happening.
 *
 * The two layers were never the problem, which is worth recording because they
 * were the obvious suspect. Measured in Chrome against this exact CSS, the
 * `<pre>` and the `<textarea>` chose IDENTICAL break positions on 3,725 fuzzed
 * bodies across fifteen container widths, and on tabs, CJK, emoji, RTL,
 * combining marks, unbreakable runs, trailing spaces at a wrap point, blank
 * lines and a trailing newline; overlaid, their glyphs coincided to the pixel.
 * Aligning them harder would have fixed nothing.
 *
 * So the fix is {@link codeOptions}'s `overflow: 'scroll'` — real horizontal
 * scrolling, one visual row per line — plus the line numbers a gutter-less box
 * could never draw. Scrolling code well needs a document model, and that is what
 * the dependency buys.
 *
 * THE HALF THAT FIX DID NOT COVER
 * -------------------------------
 * `overflow: 'scroll'` is an option about WRAPPING, and it buys exactly one
 * axis. Inside the shadow root the dependency puts `overflow-x: scroll` on its
 * `[data-code]` element and pairs it with `overflow-y: clip`, then lets that
 * element size to the whole document — a sixty-line body makes it 1230px tall
 * inside a 224px box. Nothing in `@pierre/diffs` scrolls vertically: `File` is
 * the non-virtualised renderer and owns no vertical viewport, the only escape
 * hatch it exposes is the `--diffs-overflow-override` custom property, and that
 * substitutes into the X component alone. (Its `CodeView` is the virtualised
 * scroller, but it is a multi-item viewer rather than a taller `File`.)
 *
 * So the vertical overflow lands on the FIRST ancestor with an opinion, and
 * that was this component's own wrapper, wearing `overflow-hidden`. Measured in
 * Chrome on a 61-line body in an `h-56` box: wrapper `clientHeight` 223,
 * `scrollHeight` 1236, and walking every element from the last line up to
 * `<html>` found not one with a user-scrollable Y axis. A real wheel event
 * dispatched over the box through CDP moved `window.scrollY` from 0 to 270 and
 * left the editor on line 1 — the page scrolled, the code did not, which is the
 * report. `overflow: hidden` is defined as clipping WITHOUT offering a
 * scrolling mechanism, so no wheel, trackpad, scrollbar or `PageDown` could
 * reach line 61; only the browser's own caret-into-view scrolling could, which
 * is why typing to the bottom appeared to work and dragging never did.
 *
 * The wrapper is ours and in the light DOM, so the repair is here rather than
 * past a boundary host CSS cannot cross: `overflow-y-auto` makes it the
 * vertical viewport the dependency declines to be, and `overflow-x-hidden`
 * keeps it from becoming a SECOND horizontal scroller competing with the one
 * `overflow: 'scroll'` created — `overflow-y: auto` beside an `overflow-x:
 * visible` would compute that axis to `auto` too. Verified in Chrome after the
 * change: a wheel down moves the box and leaves the page still, a horizontal
 * wheel still scrolls the long first line, and lines stay unwrapped.
 *
 * One consequence worth knowing rather than discovering: the horizontal
 * scrollbar belongs to `[data-code]`, which is document-height, so it is drawn
 * at the bottom of the DOCUMENT and not at the bottom of the visible box. A
 * horizontal wheel or trackpad swipe works from anywhere in the box; the
 * scrollbar itself is only in view once you are scrolled to the end. Moving it
 * would mean styling inside the shadow root, which nothing out here can do.
 *
 * WHAT CONTENTEDITABLE COSTS
 * --------------------------
 * `@pierre/diffs` edits through `contentEditable`, which the old docblock
 * rejected outright. Measured rather than assumed — see `code-editor.spec.tsx`:
 *
 * - **Undo/redo, IME, selection, clipboard and word motion survive**, but as the
 *   editor's code rather than the browser's. Undo is a real edit stack, and
 *   {@link CodeEditorHandle.insertAtCursor} joins it — which the textarea's
 *   `selectionStart` splice never did, because React rewrote the whole value and
 *   the native undo stack lost its boundary.
 * - **Tab indents instead of leaving.** That is correct for a code editor and it
 *   is also a keyboard trap, because the editor's `Escape` is bound to "simplify
 *   selection" rather than to letting go. {@link CodeEditor} adds the way out —
 *   see `onWrapperKeyDown`.
 * - **Screen readers still get a labelled multiline textbox**, which is the part
 *   the old docblock feared most and is the part that turned out fine. Read out
 *   of Chrome's accessibility tree rather than guessed: the editable element is
 *   `role="textbox" aria-multiline="true" aria-label="<label>"`, and its
 *   accessible VALUE is the whole document — all six hundred lines of a
 *   six-hundred-line one, since nothing here is virtualised. That is why the
 *   label is passed as the file's `name`: the editor copies the name onto
 *   `aria-label`, and it is the element's only accessible name.
 * - **What is genuinely gone is form-control semantics.** It is a `<div>`. There
 *   is no `value` property, no form participation, no `<label>` to associate,
 *   and each line is a row of per-token `<span>`s rather than one text node, so
 *   assistive line and word navigation runs over a token grid instead of over
 *   plain text. None of that is repaired here.
 * - **The editor lives in a shadow root** (`<diffs-container>`), so nothing
 *   outside can style it, query it, or reach it with Testing Library. Specs go
 *   through {@link codeEditorRoot}.
 * - **It does not render at all without layout** — canvas text metrics, a
 *   `ResizeObserver`, a real box. Under jsdom that means polyfills; see
 *   `code-editor-test-dom.ts`.
 */

/** What a caller can do to a live editor. */
export interface CodeEditorHandle {
  focus(): void;
  /**
   * Replace the selection with `text`, as one undoable edit.
   *
   * The relations sidebar's click-to-insert. `applyEdits` joins the undo
   * timeline, so an inserted table name comes back out with Ctrl+Z exactly like
   * a typed one.
   */
  insertAtCursor(text: string): void;
}

export interface CodeEditorProps {
  value: string;
  onChange: (next: string) => void;
  /**
   * What to highlight it as — one of the four grammars this package ships.
   *
   * Not `string`, and that is a size decision as much as a typing one. Shiki
   * knows ~240 languages and the bundle carries the ones named in
   * `CATALOG_CODE_LANGUAGES`; a `language` outside that set would render as
   * plain text with nothing on screen to say why. Narrowing the prop to
   * {@link CatalogCodeLanguage} makes it a compile error at the call site
   * instead — see `ui/code-languages.ts` for the rest of that argument.
   */
  language: CatalogCodeLanguage;
  /**
   * Required, and it is the editable element's accessible name.
   *
   * Passed through as the file's `name`, because that is the string the editor
   * copies onto `aria-label`. An unlabelled input is unusable by name, and the
   * language is given separately, so the name is free to be a human phrase
   * rather than a filename.
   */
  label: string;
  /**
   * Keydown, from the wrapper and in the CAPTURE phase.
   *
   * Two facts make this the only workable shape. The editor's keymap binds a
   * fixed set of built-in commands and "run this query" is not one of them, so a
   * host shortcut has to be caught outside it — and events cross an open shadow
   * boundary retargeted at the host, so the wrapper does see `⌘↵` typed inside
   * the editor. But the editor ALREADY binds `⌘↵`, to "insert a blank line", and
   * listening in the bubble phase would run the query and leave a blank line
   * behind. Capture runs first, so a handler that calls `preventDefault` claims
   * the key outright: {@link CodeEditor} stops propagation for it, and the
   * keystroke never reaches the editor at all.
   */
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  handleRef?: Ref<CodeEditorHandle | null>;
  /** Metrics differ by caller — the query box is roomier than a sample pane. */
  className?: string;
  readOnly?: boolean;
}

/**
 * The options every code surface in this package shares.
 *
 * `overflow: 'scroll'` is the fix this file's header describes and must not
 * become `'wrap'` without re-reading it. It is an option about WRAPPING, so what
 * it settles is the horizontal axis and the meaning of `End`; the vertical one
 * is the wrapper's job and is not decided here. Line numbers are the other half and are
 * conspicuously ABSENT from this object: they are on unless `disableLineNumbers`
 * turns them off, so the way to keep them is to not write it. `code-editor.spec`
 * asserts both, because "an option nobody added" is not something a reader can
 * see here.
 *
 * The file header is off because every caller draws its own — the query
 * console's toolbar, the transform editor's "Code" strip — and a second filename
 * bar inside those says nothing new.
 */
export function codeOptions(themeType: CodeThemeType) {
  return { overflow: 'scroll', disableFileHeader: true, themeType } as const;
}

export function CodeEditor({
  value,
  onChange,
  language,
  label,
  onKeyDown,
  handleRef,
  className,
  readOnly,
}: CodeEditorProps) {
  const editorRef = useRef<Editor<undefined> | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const themeType = useCodeThemeType();

  /**
   * The last text this editor and this prop agreed on, and how many times the
   * PROP has moved on its own.
   *
   * The editor owns a document once it is attached, and it substitutes its own
   * cached text for whatever `contents` it is handed — which is right for
   * typing, and wrong for the two moments a caller genuinely replaces the body:
   * opening a saved query, and switching a transform's language. Those bump the
   * revision, which keys the editor, which gives the new body a fresh document.
   * An echo of what the editor itself just reported does not, so typing never
   * remounts.
   *
   * Written during render deliberately: `contents` and `key` have to agree in
   * the SAME render, and an effect would ship one render showing the old body.
   */
  const agreed = useRef(value);
  const revision = useRef(0);
  if (agreed.current !== value) {
    agreed.current = value;
    revision.current += 1;
  }

  useImperativeHandle(
    handleRef,
    () => ({
      focus: () => editorRef.current?.focus(),
      insertAtCursor: (text: string) => {
        const editor = editorRef.current;
        const selection = editor?.getState().selections?.[0];
        if (!editor || !selection) {
          // No caret: nobody has focused the editor yet. Appending is what the
          // old implementation did in the same case, and it is the only place a
          // click on a relation name can honestly put the text.
          onChange(`${value}${text}`);
          return;
        }
        editor.applyEdits([{ range: selection, newText: text }]);
        editor.focus();
      },
    }),
    [onChange, value],
  );

  /**
   * The escape hatch, and it is not optional.
   *
   * The editor binds `Tab` to "indent", which is what a code editor should do
   * and also means Tab no longer leaves the control. Without something else that
   * does, a keyboard user who focuses this box cannot get out of it — a keyboard
   * trap, WCAG 2.1.2, and the one accessibility failure in this swap serious
   * enough to repair rather than merely record.
   *
   * Escape parks focus on the wrapper, which is `tabIndex={-1}` so it can hold
   * focus without joining the tab order, and Tab from THERE leaves. Tab has to
   * be handled too, and that is the part that was wrong the first time: focus
   * sitting on the wrapper with the editor inside it means the browser's next
   * tab stop is the editor again, so Escape-then-Tab put you straight back where
   * you started. Verified in Chrome, not assumed. So the Tab is taken over and
   * focus is moved to the first tab stop OUTSIDE this component — which is what
   * Tab was going to mean anyway.
   *
   * The cost is the editor's own Escape binding, "simplify selection", which
   * never arrives. Collapsing a multi-cursor is worth less than being able to
   * leave.
   */
  function onWrapperKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    onKeyDown?.(event);
    const wrapper = wrapperRef.current;

    if (event.key === 'Escape' && !event.defaultPrevented && wrapper) {
      event.preventDefault();
      wrapper.focus();
    } else if (
      event.key === 'Tab' &&
      !event.defaultPrevented &&
      wrapper &&
      // Only once focus has been parked. While the caret is in the editor, Tab
      // still indents — that is the behaviour the hatch exists to make safe, not
      // one to undo.
      document.activeElement === wrapper
    ) {
      event.preventDefault();
      focusOutside(wrapper, event.shiftKey ? 'backward' : 'forward');
    }

    // A host that claimed the key gets it exclusively — see `onKeyDown`.
    if (event.defaultPrevented) event.stopPropagation();
  }

  return (
    // Capture, not bubble, and on the wrapper rather than on the editable
    // element, which is not ours to attach to. See `onKeyDown`.
    //
    // `overflow-y-auto` is the vertical viewport — see this file's header for
    // why it has to live out here — and `overflow-x-hidden` is not decoration:
    // the horizontal scroller is `[data-code]` inside the shadow root, and
    // leaving this axis `visible` beside a scrolling one would compute it to
    // `auto` and stack a second, empty scrollbar on top of it.
    <div
      ref={wrapperRef}
      tabIndex={-1}
      className={cn('relative overflow-x-hidden overflow-y-auto outline-none', className)}
      onKeyDownCapture={onWrapperKeyDown}
    >
      <EditProvider createEditor={(options) => new Editor(options)}>
        <File
          key={revision.current}
          edit={!readOnly}
          file={{ name: label, contents: value, lang: language, cacheKey: label }}
          options={codeOptions(themeType)}
          editorOptions={{
            onAttach: (instance) => {
              editorRef.current = instance;
            },
            onChange: (next) => {
              agreed.current = next.contents;
              onChange(next.contents);
            },
          }}
          style={{ height: '100%' }}
        />
      </EditProvider>
    </div>
  );
}

/**
 * Everything the browser would stop at on the way through a document.
 *
 * Deliberately a DOCUMENT query, which cannot see inside the editor's shadow
 * root — so the editor's own contenteditable is excluded for free rather than by
 * a rule that could drift. `[tabindex="-1"]` is excluded because that is exactly
 * what "focusable, but not a tab stop" means, and it is what the wrapper is.
 */
const TAB_STOPS = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'audio[controls]',
  'video[controls]',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Move focus to the tab stop before or after `wrapper`, skipping its contents.
 *
 * Document order, from `compareDocumentPosition`, rather than `tabindex` order.
 * They differ only for positive `tabindex` values, which this package never
 * produces and which are a bug wherever they appear; modelling them here would
 * be more code for a case that would be wrong anyway.
 *
 * Nothing to move to is a real answer — an editor last on the page — and it
 * leaves focus on the wrapper rather than throwing it somewhere arbitrary.
 */
function focusOutside(wrapper: HTMLElement, direction: 'forward' | 'backward') {
  const stops = [...document.querySelectorAll(TAB_STOPS)].filter(
    (node) => node instanceof HTMLElement && !wrapper.contains(node),
  );
  const after = direction === 'forward';
  const found = (after ? stops : [...stops].reverse()).find((node) => {
    const position = wrapper.compareDocumentPosition(node);
    const mask = after ? Node.DOCUMENT_POSITION_FOLLOWING : Node.DOCUMENT_POSITION_PRECEDING;
    return (position & mask) !== 0;
  });
  if (found instanceof HTMLElement) found.focus();
}

/**
 * The shadow root a code surface renders into.
 *
 * Exported from the component rather than rewritten in every spec, because the
 * boundary is a property of the dependency and not of any one test: Testing
 * Library's queries stop at the host element, so `getByLabelText` and
 * `getByText` cannot see a single line of code. Everything that asserts on
 * rendered code goes through here, and the day the tag name changes there is one
 * place to fix.
 */
export function codeEditorRoot(container: ParentNode): ShadowRoot | null {
  return container.querySelector('diffs-container')?.shadowRoot ?? null;
}

/**
 * The code a surface is showing, as text.
 *
 * `[data-content]` rather than the whole `<pre>`, which also holds the line
 * numbers — reading those back would make `'1select 1'` the expected value of a
 * one-line query, and the first person to add a line would not know why the
 * assertion moved.
 */
export function codeEditorText(container: ParentNode): string {
  return codeEditorRoot(container)?.querySelector('[data-content]')?.textContent ?? '';
}
