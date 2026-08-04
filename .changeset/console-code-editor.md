---
"@dudousxd/nestjs-catalog-react": minor
---

One code editor, themed by the console instead of against it

The query console and the transform editor each carried their own copy of the
same overlay editor — a transparent `<textarea>` over a highlighted `<pre>` —
with the same two boxes, the same three comments, and only one of them taught
about anything but its own language. They now share `ui/CodeEditor`.

**It was unreadable.** Both copies passed `themes.github`, a light Prism theme
that paints keywords a dark red and strings a dark blue. That was invisible for
as long as the console was light and became dark-on-dark the moment the console
went dark: the editor still worked perfectly, you just could not read what you
were typing. The theme is now defined against the same `--text` / `--muted` /
`--accent` variables the shell sets, so the two cannot drift apart again.

**The sample-records pane gets highlighting too.** It was the one that stayed a
bare textarea, so the JSON you debug a transform against rendered flat grey
beside a coloured transform — and a missing brace in a sample is exactly what
highlighting finds for you.

Two smaller things found while extracting it: the theme's `plain` was never
applied, because `Highlight`'s `style` was not spread onto the `<pre>`; and
`leading-[1.5]` was being dropped by tailwind-merge, which treats a
`text-{size}` utility as able to carry a line-height and discards a `leading-*`
written before it. Both layers agreed, so the caret never drifted — the intended
line-height simply was not there.

Still a textarea rather than CodeMirror, and deliberately: the platform's
textarea already has the caret, selection, undo, IME and every accessibility
affordance, and a controlled document-model editor has to reimplement all of it
— the classic symptom being a caret that jumps to the end when the value updates
from outside. What is missing is autocomplete and bracket matching, which
nothing here asks for.
