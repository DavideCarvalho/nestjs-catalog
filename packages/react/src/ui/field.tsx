import type { ReactNode } from 'react';
import { cn } from '../cn';

/**
 * Labelled text inputs, in the shadcn style.
 *
 * Plain elements rather than a Base UI primitive, exactly as shadcn's own input
 * is: there is nothing about a text box that needs a headless component, and
 * wrapping one would add a layer for no behaviour.
 *
 * What these do add is a real `<label>`. The forms that moved into this package
 * leaned on placeholders, which vanish the moment somebody types — so a person
 * checking a half-filled connector form has no way to tell which box held the
 * prefix and which held the suffix.
 */
const CONTROL = cn(
  'w-full rounded-md border px-2 py-1.5 text-xs outline-none',
  'border-zinc-200 bg-white text-zinc-900 placeholder:text-zinc-400',
  'dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-600',
  'focus-visible:border-violet-500 focus-visible:ring-2 focus-visible:ring-violet-500/15',
);

function Label({ children }: { children: ReactNode }) {
  return (
    <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-400 dark:text-zinc-500">
      {children}
    </span>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return (
    <span className="mt-1 block text-[11px] leading-relaxed text-zinc-400 dark:text-zinc-500">
      {children}
    </span>
  );
}

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  hint,
  type = 'text',
  inputMode,
  autoComplete,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  hint?: ReactNode;
  type?: 'text' | 'password' | 'email';
  inputMode?: 'numeric' | 'text';
  autoComplete?: string;
  disabled?: boolean;
}) {
  return (
    <label className="block">
      <Label>{label}</Label>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        inputMode={inputMode}
        autoComplete={autoComplete}
        disabled={disabled}
        className={cn(CONTROL, 'disabled:opacity-40')}
      />
      {hint && <Hint>{hint}</Hint>}
    </label>
  );
}

export function TextAreaField({
  label,
  value,
  onChange,
  placeholder,
  hint,
  rows = 4,
  mono = false,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  hint?: ReactNode;
  rows?: number;
  mono?: boolean;
  /** Matches {@link TextField}, so a read-only form can dim every control. */
  disabled?: boolean;
}) {
  return (
    <label className="block">
      <Label>{label}</Label>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        rows={rows}
        spellCheck={false}
        disabled={disabled}
        className={cn(CONTROL, 'resize-none disabled:opacity-40', mono && 'font-mono')}
      />
      {hint && <Hint>{hint}</Hint>}
    </label>
  );
}

/** A heading for a run of fields, so a long form reads as sections. */
export function FieldGroup({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div>
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-400 dark:text-zinc-500">
          {title}
        </p>
        {hint && <Hint>{hint}</Hint>}
      </div>
      {children}
    </div>
  );
}
