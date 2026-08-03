import { Select as BaseSelect } from '@base-ui/react/select';
import { Check, ChevronsUpDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../cn';

/**
 * A select, vendored in the shadcn style on Base UI.
 *
 * Data-driven rather than composed at the call site. Base UI's select is eight
 * parts — root, trigger, value, icon, portal, positioner, popup, list — and the
 * screens in this package hold two dozen of them; repeating that anatomy per
 * field means the popup styling drifts field by field, and the one field
 * somebody forgot to portal is the one that clips inside a scrolling form.
 *
 * The native `<select>` this replaced was smaller still, and would have been
 * fine forever if the options had stayed one line each. They did not: choosing
 * a connection has to say what the connection *is* — its kind, its address —
 * and a native option element renders a single string with no markup at all.
 */
export interface SelectOption {
  value: string;
  label: string;
  /** A second line under the label. The reason a native option was not enough. */
  hint?: string;
  disabled?: boolean;
}

export function Select({
  value,
  onValueChange,
  options,
  ariaLabel,
  placeholder = 'Choose…',
  disabled,
  className,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  /** Required: this renders a button, and a button with only a chevron is mute. */
  ariaLabel: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}) {
  const selected = options.find((option) => option.value === value);

  return (
    <BaseSelect.Root
      value={value}
      // Base UI hands back the item's value, which is `unknown` as far as its
      // generics are concerned, and `null` when a selection is cleared. Narrowed
      // rather than asserted: a cleared select must not call back with null and
      // leave a form field holding something its own type says it cannot.
      onValueChange={(next) => {
        if (typeof next === 'string') onValueChange(next);
      }}
      disabled={disabled}
    >
      <BaseSelect.Trigger
        aria-label={ariaLabel}
        className={cn(
          'flex w-full items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-left text-xs',
          'border-zinc-200 bg-white text-zinc-900 outline-none',
          'dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100',
          'focus-visible:border-violet-500 focus-visible:ring-2 focus-visible:ring-violet-500/15',
          'disabled:opacity-40',
          className,
        )}
      >
        <BaseSelect.Value className="truncate">
          {selected ? (
            selected.label
          ) : (
            <span className="text-zinc-400 dark:text-zinc-500">{placeholder}</span>
          )}
        </BaseSelect.Value>
        <BaseSelect.Icon>
          <ChevronsUpDown size={12} className="shrink-0 text-zinc-400" />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>

      <BaseSelect.Portal>
        <BaseSelect.Positioner
          sideOffset={4}
          // Overlapping the trigger so the chosen row lands under the cursor is
          // Base UI's default and it is wrong here: these popups carry a hint
          // line per row, so the popup is much taller than the trigger and the
          // overlap puts it over the field somebody is reading.
          alignItemWithTrigger={false}
          className="z-50"
        >
          <BaseSelect.Popup
            className={cn(
              'max-h-72 min-w-[var(--anchor-width)] overflow-y-auto rounded-md border p-1 shadow-md',
              'border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900',
              'origin-[var(--transform-origin)] transition-[opacity,transform] duration-100 ease-out',
              'data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
              'data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
            )}
          >
            <BaseSelect.List>
              {options.map((option) => (
                <BaseSelect.Item
                  key={option.value}
                  value={option.value}
                  disabled={option.disabled}
                  className={cn(
                    'flex cursor-default items-start gap-2 rounded-sm px-2 py-1.5 text-xs outline-none',
                    'data-[highlighted]:bg-zinc-100 dark:data-[highlighted]:bg-zinc-800',
                    'data-[disabled]:opacity-40',
                  )}
                >
                  <BaseSelect.ItemIndicator className="mt-0.5 shrink-0">
                    <Check size={11} className="text-violet-600" />
                  </BaseSelect.ItemIndicator>
                  <span className="min-w-0 flex-1">
                    <BaseSelect.ItemText className="block truncate">
                      {option.label}
                    </BaseSelect.ItemText>
                    {option.hint && (
                      <span className="mt-0.5 block truncate font-mono text-[10px] text-zinc-400 dark:text-zinc-500">
                        {option.hint}
                      </span>
                    )}
                  </span>
                </BaseSelect.Item>
              ))}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}

/**
 * A select with a label above it, which is what every form in this package
 * actually wants.
 *
 * Separate from `Select` so a toolbar can still drop a bare one in.
 */
export function SelectField({
  label,
  hint,
  ...props
}: Parameters<typeof Select>[0] & { label: string; hint?: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-400 dark:text-zinc-500">
        {label}
      </span>
      <Select {...props} />
      {hint && (
        <span className="mt-1 block text-[11px] text-zinc-400 dark:text-zinc-500">{hint}</span>
      )}
    </label>
  );
}
