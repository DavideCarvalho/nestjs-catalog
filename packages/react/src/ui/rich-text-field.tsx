import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Bold, Check, Code, Italic, List, ListOrdered, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Markdown, type MarkdownStorage } from 'tiptap-markdown';
import { cn } from '../cn';
import { Button } from './button';

// `tiptap-markdown` exports its storage type but does not merge it into
// TipTap's, so `editor.storage.markdown` is untyped without this. Declaration
// merging rather than a cast: a cast asserts the shape is right, this one makes
// the compiler check it against the type the library actually publishes.
declare module '@tiptap/core' {
  interface Storage {
    markdown: MarkdownStorage;
  }
}

/**
 * A curated description, edited as rich text and stored as **markdown**.
 *
 * Markdown rather than HTML, and the reason is what happens to everyone who is
 * NOT this editor. `description` is served raw in the `/catalog` snapshot to
 * whatever a host built on top of it, and those consumers were written against
 * plain text. Markdown degrades into something a person can still read —
 * `**bold**` — while HTML degrades into `<strong>bold</strong>`, which is
 * noise, and creates an XSS surface in every consumer that decides to render it
 * after all. One of those failures is cosmetic and the other is a
 * vulnerability.
 *
 * The read view is the same editor with `editable: false` rather than a second
 * markdown renderer. Two parsers for one format is two answers to "what does
 * this text mean", and they diverge on exactly the inputs nobody tests.
 */

/** Kept out of the toolbar deliberately — see the docblock on {@link RichTextField}. */
const EXTENSIONS = [
  StarterKit.configure({
    // No headings inside a field that renders in a table cell and a tooltip:
    // an `<h1>` in a 20%-wide column is a line of enormous text, and the
    // affordance would be there purely because the library offers it.
    heading: false,
    // Nor images or horizontal rules, for the same reason.
    horizontalRule: false,
  }),
  Markdown.configure({
    // Round-trip fidelity over prettiness: this text is read by other programs.
    linkify: false,
    breaks: false,
    transformPastedText: true,
  }),
];

/**
 * What the rendered markdown looks like, as utilities rather than as a class
 * the host has to define.
 *
 * A component library that references a `prose-…` class it does not ship is a
 * component library that renders unstyled in somebody else's app — bold text
 * that is not bold, list items with no bullets — and nothing errors, so it
 * reads as a broken component. Arbitrary variants keep the styling inside the
 * class strings Tailwind already scans in `dist`.
 *
 * Deliberately small. These are one-paragraph descriptions in a table cell, not
 * documents.
 */
const PROSE = cn(
  '[&_p]:my-0 [&_p+p]:mt-2',
  '[&_strong]:font-semibold',
  '[&_em]:italic',
  '[&_code]:rounded [&_code]:bg-zinc-100 [&_code]:px-1 [&_code]:font-mono [&_code]:text-[0.9em]',
  'dark:[&_code]:bg-zinc-800',
  '[&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-4',
  '[&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-4',
  '[&_li]:my-0.5',
);

export interface RichTextFieldProps {
  /** Markdown. Empty string means "nothing written yet". */
  value: string;
  onSave: (markdown: string) => void;
  /** Announced to assistive tech — this control has no visible label. */
  label: string;
  placeholder?: string;
  className?: string;
}

export function RichTextField({
  value,
  onSave,
  label,
  placeholder = '—',
  className,
}: RichTextFieldProps) {
  const [editing, setEditing] = useState(false);

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        aria-label={`Edit ${label}`}
        className={cn(
          'w-full rounded-sm px-1.5 py-0.5 text-left',
          'hover:bg-zinc-100 dark:hover:bg-zinc-800',
          className,
        )}
      >
        {value ? (
          <RichTextView value={value} />
        ) : (
          <span className="text-zinc-400 dark:text-zinc-500">{placeholder}</span>
        )}
      </button>
    );
  }

  return (
    <RichTextEditor
      value={value}
      label={label}
      className={className}
      onCancel={() => setEditing(false)}
      onSave={(markdown) => {
        setEditing(false);
        // Only when it actually changed. A save on every blur turns "I clicked
        // into this field and clicked out" into a write, an audit entry, and a
        // publisher's overlay that now shadows the declared description with an
        // identical string.
        if (markdown !== value) onSave(markdown);
      }}
    />
  );
}

/** Read-only, through the same editor, so one parser decides what the text means. */
export function RichTextView({ value, className }: { value: string; className?: string }) {
  const editor = useEditor(
    {
      extensions: EXTENSIONS,
      content: value,
      editable: false,
      immediatelyRender: false,
      editorProps: { attributes: { class: cn(PROSE, className) } },
    },
    [value],
  );

  return <EditorContent editor={editor} />;
}

function RichTextEditor({
  value,
  label,
  className,
  onSave,
  onCancel,
}: {
  value: string;
  label: string;
  className?: string;
  onSave: (markdown: string) => void;
  onCancel: () => void;
}) {
  const editor = useEditor({
    extensions: EXTENSIONS,
    content: value,
    // `false` because this renders inside an already-mounted client tree; left
    // on, TipTap renders once during the first paint and React reports a
    // hydration mismatch on any host that server-renders the console shell.
    immediatelyRender: false,
    editorProps: {
      attributes: {
        'aria-label': label,
        class: cn(
          PROSE,
          'min-h-[3lh] rounded-sm border border-sky-500 px-1.5 py-0.5 outline-none',
          'ring-2 ring-sky-500/20',
          className,
        ),
      },
    },
  });

  // Focus on open, so opening the editor and typing is one motion rather than
  // two — the plain-text field it replaces did the same.
  useEffect(() => {
    editor?.commands.focus('end');
  }, [editor]);

  if (!editor) return null;

  const markdown = () => editor.storage.markdown.getMarkdown();

  return (
    <div
      onKeyDown={(event) => {
        // Escape abandons, Cmd/Ctrl+Enter commits. Plain Enter is a paragraph
        // break here — this is a rich text field, and stealing Enter would make
        // multi-paragraph descriptions impossible to write.
        if (event.key === 'Escape') onCancel();
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) onSave(markdown());
      }}
    >
      <Toolbar editor={editor} />
      <EditorContent editor={editor} />
      <div className="mt-1 flex items-center gap-1">
        <Button size="sm" onClick={() => onSave(markdown())} aria-label={`Save ${label}`}>
          <Check size={12} /> Save
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} aria-label={`Cancel editing ${label}`}>
          <X size={12} />
        </Button>
        <span className="ml-auto font-mono text-[10px] text-zinc-400 dark:text-zinc-500">
          Stored as markdown
        </span>
      </div>
    </div>
  );
}

/** Editor type is inferred; naming it would pin this file to a TipTap minor. */
function Toolbar({ editor }: { editor: NonNullable<ReturnType<typeof useEditor>> }) {
  const marks = [
    { name: 'bold', icon: Bold, run: () => editor.chain().focus().toggleBold().run() },
    { name: 'italic', icon: Italic, run: () => editor.chain().focus().toggleItalic().run() },
    { name: 'code', icon: Code, run: () => editor.chain().focus().toggleCode().run() },
    {
      name: 'bulletList',
      icon: List,
      run: () => editor.chain().focus().toggleBulletList().run(),
    },
    {
      name: 'orderedList',
      icon: ListOrdered,
      run: () => editor.chain().focus().toggleOrderedList().run(),
    },
  ];

  return (
    <div className="mb-1 flex items-center gap-0.5">
      {marks.map(({ name, icon: Icon, run }) => (
        <Button
          key={name}
          size="icon"
          variant="ghost"
          onClick={run}
          aria-label={name}
          // `aria-pressed`, not a class: a toggle whose state is only a
          // background colour is a toggle a screen reader cannot report.
          aria-pressed={editor.isActive(name)}
          className={cn(editor.isActive(name) && 'bg-zinc-200 dark:bg-zinc-700')}
        >
          <Icon size={12} />
        </Button>
      ))}
    </div>
  );
}
