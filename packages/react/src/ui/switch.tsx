import { Switch as BaseSwitch } from '@base-ui/react/switch';
import type { ReactNode } from 'react';
import { cn } from '../cn';

/**
 * A switch, vendored in the shadcn style on Base UI.
 *
 * A switch rather than the checkbox these forms used to carry, because every
 * one of them toggles something that takes effect immediately in meaning —
 * whether a connector runs, whether path-style addressing is used — and a
 * checkbox reads as "include this in what I am about to submit".
 */
export function Switch({
  checked,
  onCheckedChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** The label is not optional: an unlabelled switch is a mystery toggle. */
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-start gap-2.5">
      <BaseSwitch.Root
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        className={cn(
          'relative mt-0.5 h-4 w-7 shrink-0 rounded-full border transition-colors outline-none',
          'border-zinc-300 bg-zinc-200 dark:border-zinc-700 dark:bg-zinc-800',
          'data-[checked]:border-sky-600 data-[checked]:bg-sky-600',
          'focus-visible:ring-2 focus-visible:ring-sky-500/30',
          'disabled:opacity-40',
        )}
      >
        <BaseSwitch.Thumb
          className={cn(
            'block h-3 w-3 translate-x-0.5 rounded-full bg-white shadow-sm transition-transform',
            'data-[checked]:translate-x-[14px]',
          )}
        />
      </BaseSwitch.Root>
      <span className="min-w-0">
        <span className="block text-[11px] text-zinc-600 dark:text-zinc-300">{label}</span>
        {hint && <span className="block text-[11px] text-zinc-400 dark:text-zinc-500">{hint}</span>}
      </span>
    </label>
  );
}
