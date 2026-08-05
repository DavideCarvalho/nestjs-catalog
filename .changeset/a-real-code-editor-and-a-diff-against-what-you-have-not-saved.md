---
'@dudousxd/nestjs-catalog-react': minor
---

A real code editor, and a diff against the version you have not saved yet

**The bug.** Selecting `checked_fields` in the SQL box and cutting gave back
`checked_fields-` — one character more than was selected — and the caret reported
being on "the final line + 1". The two-layer editor (a transparent `<textarea>`
over a Prism `<pre>`) was the obvious suspect and was innocent: measured in
Chrome, the two layers chose identical wrap positions on 3,725 fuzzed bodies at
fifteen widths, plus tabs, CJK, emoji, RTL, combining marks, unbreakable runs,
trailing spaces at a wrap point, blank lines and a trailing newline. The cause
was soft wrapping itself. `Home`/`End`/`Shift+End` and the vertical arrows move
by VISUAL row, the line wrapped after `checked_fields-`, and with no gutter
nothing on screen admitted that a thirteen-line query was occupying fourteen
rows.

**The change.** `ui/code-editor.tsx` is now `@pierre/diffs` in edit mode:
horizontal scrolling instead of soft wrap, line numbers, Shiki highlighting, a
real document model and a real undo stack. One component, used by the query
console, the transform editor, and the transform code sheet on the workflow
canvas. The history sheet's comparison is the same library's diff, with
word-level highlighting inside a changed line.

**New.** The history sheet can now diff the buffer in the editor against the
newest recorded revision, as `Unsaved edits` — the answer to "what have I changed
since I last saved", which this console could not give. `SavedQuery` still has no
`version` field, so the buffer is not given a number; not being nameable was
never a reason not to compare it.

**Breaking, in the 0.x sense.**

- `prism-react-renderer` is no longer a peer dependency. `@pierre/diffs`
  (`>=1.3.3`) is.
- `diffLines`, `foldUnchanged`, `DIFF_MAX_CELLS`, `DIFF_CONTEXT_LINES`,
  `DIFF_MIN_FOLD` and the `DiffLine`/`DiffOp`/`DiffSection`/`LineDiff` types are
  gone, with `diff/line-diff.ts`. Their docblock argued that a diff of somebody's
  code and SQL was not worth a supply-chain question mark, so there was no
  dependency at all; that argument does not survive the same package becoming the
  editor those strings are typed into.
- `CodeEditor` drops `textareaRef`, `padding` and `fontSize`, and gains
  `handleRef` (`focus`, `insertAtCursor`). `onKeyDown` now fires in the capture
  phase on the wrapper and takes a `KeyboardEvent<HTMLDivElement>`.
- New exports `codeEditorRoot` and `codeEditorText`: the editor renders into a
  shadow root, so Testing Library queries do not reach its content.

**What contentEditable costs.** Checked in Chrome rather than assumed. Screen
readers still get a labelled multiline textbox: the editable element is
`role="textbox" aria-multiline="true" aria-label="<label>"`, and its accessible
value is the whole document — nothing here is virtualised. What is gone is
form-control semantics: it is a `<div>`, with no `value` property, no form
participation, no `<label>` to associate, and each line is a row of per-token
`<span>`s rather than one text node. Tab indents rather than moving focus, which
was a keyboard trap until `CodeEditor` took Escape (park focus on the wrapper)
and Tab (leave for the next tab stop outside the component).

**Size.** `prism-react-renderer` was ~86 KB minified / 26 KB gzipped, in one
piece. `@pierre/diffs` brings Shiki: with code splitting the entry chunk is
~555 KB minified / ~167 KB gzipped, plus a language or theme chunk fetched on
demand (385 chunks, ~10.9 MB in total, of which a SQL console touches a
handful). Bundled without splitting it is ~10.2 MB minified. Installed, the new
subtree is about 40 MB.
