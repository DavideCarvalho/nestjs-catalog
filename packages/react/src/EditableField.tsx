import { Check, Pencil, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cn } from './cn';

interface EditableFieldProps {
  value: string;
  placeholder?: string;
  onSave: (next: string) => void;
  multiline?: boolean;
  className?: string;
  inputClassName?: string;
  label: string;
}

/**
 * Click to edit, Enter to save, Escape to cancel.
 *
 * Every field this wraps is presentation-only — a label, a description, a unit.
 * None of it reaches a migration, which is the only reason it is safe to make
 * editing this casual.
 */
export function EditableField({
  value,
  placeholder = 'Not named yet',
  onSave,
  multiline = false,
  className,
  inputClassName,
  label,
}: EditableFieldProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  // Two refs rather than one union-typed ref: React types `ref` per element, so
  // a shared `HTMLInputElement | HTMLTextAreaElement` ref satisfies neither.
  const inputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (!editing) return;
    const node = multiline ? textareaRef.current : inputRef.current;
    node?.focus();
    node?.select();
  }, [editing, multiline]);

  function commit() {
    const next = draft.trim();
    if (next !== value) onSave(next);
    setEditing(false);
  }

  function cancel() {
    setDraft(value);
    setEditing(false);
  }

  if (editing) {
    const shared = {
      value: draft,
      'aria-label': label,
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
        setDraft(e.target.value),
      onBlur: commit,
      onKeyDown: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          cancel();
        }
        if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          commit();
        }
      },
      className: cn(
        'w-full rounded-sm border border-sky-500 bg-white px-1.5 py-0.5 dark:bg-zinc-900',
        'outline-none ring-2 ring-sky-500/20',
        inputClassName,
      ),
    };

    return (
      <div className={cn('flex items-start gap-1.5', className)}>
        {multiline ? (
          <textarea {...shared} ref={textareaRef} rows={3} />
        ) : (
          <input {...shared} ref={inputRef} type="text" />
        )}
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={commit}
          aria-label={`Save ${label}`}
          className="mt-0.5 rounded-sm p-0.5 text-emerald-600 hover:bg-emerald-100 dark:hover:bg-emerald-950"
        >
          <Check size={14} />
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={cancel}
          aria-label={`Cancel editing ${label}`}
          className="mt-0.5 rounded-sm p-0.5 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          <X size={14} />
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      aria-label={`Edit ${label}`}
      className={cn(
        'group/edit flex w-full items-start gap-1.5 rounded-sm px-1.5 py-0.5 text-left',
        'border border-transparent hover:border-zinc-200 hover:bg-zinc-50',
        'dark:hover:border-zinc-800 dark:hover:bg-zinc-950',
        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-sky-500',
        className,
      )}
    >
      <span className={cn(!value && 'italic text-zinc-400 dark:text-zinc-500')}>
        {value || placeholder}
      </span>
      <Pencil
        size={12}
        className="mt-1 shrink-0 opacity-0 transition-opacity group-hover/edit:opacity-60"
      />
    </button>
  );
}
