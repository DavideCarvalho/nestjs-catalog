import { Highlight, type PrismTheme } from 'prism-react-renderer';
import type { KeyboardEvent, Ref } from 'react';
import { cn } from '../cn';

/**
 * A code editor: a transparent `<textarea>` over a highlighted `<pre>`.
 *
 * Written out once here because it was written out twice — the query console
 * and the transform editor each carried their own copy, with the same two boxes
 * and the same three comments, and only one of them had been taught about JSON.
 *
 * Not CodeMirror, and that is a decision rather than an omission. A textarea is
 * already the best plain-text input the platform has: it has the caret, the
 * selection, undo, IME, autofill and every accessibility affordance for free,
 * and a controlled editor built on a document model has to reimplement the lot
 * — the classic symptom being a caret that jumps to the end whenever the value
 * is updated from outside. What is missing here is autocomplete and bracket
 * matching, which nothing in this console asks for.
 */

/**
 * The palette, from the console's own surface tokens.
 *
 * The previous copies both passed `themes.github`, which is a LIGHT theme — its
 * plain text is near-black. That was invisible for as long as the console was
 * light, and turned the SQL box into dark-on-dark the day the console became
 * dark. So the theme is defined against the same variables the shell sets
 * rather than picked from a list, and the two cannot drift again.
 */
const CONSOLE_THEME: PrismTheme = {
  plain: { color: 'var(--text, #e7e7ea)', backgroundColor: 'transparent' },
  styles: [
    { types: ['comment', 'prolog', 'doctype', 'cdata'], style: { color: 'var(--muted, #76767f)' } },
    { types: ['punctuation'], style: { color: 'var(--muted, #76767f)' } },
    {
      types: ['keyword', 'operator', 'rule', 'important', 'atrule'],
      style: { color: 'var(--accent, #38bdf8)' },
    },
    { types: ['string', 'char', 'attr-value', 'regex'], style: { color: '#34d399' } },
    { types: ['number', 'boolean', 'constant', 'symbol'], style: { color: '#fbbf24' } },
    { types: ['function', 'class-name', 'builtin'], style: { color: '#a78bfa' } },
    { types: ['variable', 'attr-name', 'property', 'tag'], style: { color: '#7dd3fc' } },
    { types: ['deleted'], style: { color: '#f87171' } },
  ],
};

export interface CodeEditorProps {
  value: string;
  onChange: (next: string) => void;
  /** Anything Prism knows: `sql`, `json`, `python`, `tsx`, … */
  language: string;
  /** Required. This is an input, and an unlabelled one is unusable by name. */
  label: string;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  textareaRef?: Ref<HTMLTextAreaElement>;
  /** Metrics differ by caller — the query box is roomier than a sample pane. */
  className?: string;
  padding?: string;
  fontSize?: string;
  readOnly?: boolean;
}

export function CodeEditor({
  value,
  onChange,
  language,
  label,
  onKeyDown,
  textareaRef,
  className,
  padding = 'p-3',
  fontSize = 'text-[12px]',
  readOnly,
}: CodeEditorProps) {
  // Every property that affects where a glyph lands has to be identical on both
  // layers, or the caret drifts from the text it is supposed to be inside — one
  // character further off with every line.
  //
  // `leading` comes AFTER `fontSize` deliberately: tailwind-merge knows a
  // `text-{size}` utility can carry a line-height, so a `leading-*` written
  // before it is dropped as superseded — silently, and the browser default
  // applies to both layers instead of 1.5.
  const shared = cn(
    'm-0 font-mono whitespace-pre-wrap break-words',
    padding,
    fontSize,
    'leading-[1.5]',
  );

  return (
    // Two boxes, and the division between them is the whole point.
    //
    // The outer one is the ONLY thing that scrolls. The inner one has no height
    // of its own, so it grows to whatever the highlighted code needs — which is
    // what lets the textarea be `inset-0` and still cover every line rather than
    // only the visible ones. When both scrolled, a long query produced two
    // scrollbars and scrolling the outer one left the caret over the wrong line,
    // because the highlight moved and the input did not.
    <div className={cn('relative overflow-auto', className)}>
      <div className="relative min-h-full w-full">
        <Highlight code={value} language={language} theme={CONSOLE_THEME}>
          {({ style, tokens, getLineProps, getTokenProps }) => (
            // `style` carries the theme's `plain`, which is what anything Prism
            // did NOT tokenise falls back to. Dropping it leaves that text
            // inheriting from whatever is above, which happens to be right on
            // this console and would not be on another.
            <pre style={style} className={cn(shared, 'pointer-events-none min-h-full')} aria-hidden>
              {tokens.map((line, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: lines have no id
                <div key={i} {...getLineProps({ line })}>
                  {line.map((token, key) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: tokens have no id
                    <span key={key} {...getTokenProps({ token })} />
                  ))}
                </div>
              ))}
            </pre>
          )}
        </Highlight>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          readOnly={readOnly}
          aria-label={label}
          className={cn(
            shared,
            // `overflow-hidden`, not `auto`: this layer is as tall as the code
            // it holds, so it has nothing to scroll — and giving it the option
            // back is what produced the second scrollbar.
            'absolute inset-0 h-full w-full resize-none overflow-hidden bg-transparent',
            // Transparent text over the highlighted copy, but a VISIBLE caret
            // and a visible selection — those are the two things the `<pre>`
            // underneath cannot draw.
            'text-transparent caret-zinc-900 outline-none dark:caret-zinc-100',
            'selection:bg-sky-500/30 selection:text-transparent',
          )}
        />
      </div>
    </div>
  );
}
