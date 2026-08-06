import { Autocomplete } from '@base-ui/react/autocomplete';
import { Check, ChevronsUpDown } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { cn } from '../cn';

/**
 * A searchable select that is also a text box, vendored in the shadcn style on
 * Base UI's `Autocomplete`.
 *
 * ## Why not {@link Select}
 *
 * `Select` is a closed set: it renders a button, and every choice is one of the
 * rows. That is right for a mode or a kind, where the options are three and
 * written in this repository. It is wrong for a list a *deployment* supplies —
 * a fleet announcing three hundred workflows renders three hundred rows in a
 * popup with no way to narrow them, and a field whose only gesture is "scroll
 * until you see it" is a field people give up on.
 *
 * ## Why `Autocomplete` and not `Combobox`
 *
 * Base UI ships both, and the difference is exactly the one that matters here.
 * `Combobox` has a *selected value* — its input is a query over a closed list
 * and what you end up with is one of the items. `Autocomplete` has no selected
 * value at all: the input's text **is** the value, and the list is a set of
 * suggestions over it. So a name nobody announced can still be typed, which is
 * the property the call node cannot lose — a deployment whose workers are too
 * old announces little or nothing, and a picker that became the only path would
 * make that node unusable there.
 *
 * That is the whole reason this component exists rather than a `searchable`
 * flag on `Select`: the two differ in what they can *express*, not in how they
 * look.
 *
 * ## Picking is not typing, and the caller is told which happened
 *
 * {@link ComboboxProps.onValueChange} fires for keystrokes; {@link
 * ComboboxProps.onSelect} fires for a committed row. Base UI also fills the
 * input on an item press, which arrives as a value change with the reason
 * `item-press`, and that one is dropped on the floor here — otherwise a caller
 * that writes two fields from one row (`name` **and** `version`) would have the
 * second immediately overwritten by the keystroke-shaped event for the first.
 */
export interface ComboOption {
  /** What {@link ComboboxProps.onSelect} hands back, and the row's identity. */
  value: string;
  /** Shown, and the first thing the query matches against. */
  label: string;
  /** A second line under the label — where a row says what it *is*. */
  hint?: string;
  /**
   * Extra text the query also matches, shown nowhere.
   *
   * A workflow is looked for by its group or by what it does at least as often
   * as by the exact name somebody has half-remembered, and a search that only
   * matched the label would answer "no results" to a perfectly good query.
   */
  keywords?: string;
  /**
   * Offered, greyed, and refused.
   *
   * Never a reason to omit the row: a picker that silently drops what it cannot
   * accept is one you cannot tell apart from a picker that never heard of it.
   * A disabled row owes a reason, which is what {@link hint} is for.
   */
  disabled?: boolean;
}

const CONTROL = cn(
  'w-full rounded-md border py-1.5 pl-2 pr-7 text-xs outline-none',
  'border-zinc-200 bg-white text-zinc-900 placeholder:text-zinc-400',
  'dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-600',
  'focus-visible:border-sky-500 focus-visible:ring-2 focus-visible:ring-sky-500/15',
  'disabled:opacity-40',
);

export interface ComboboxProps {
  /** The text in the box, which IS the value. Controlled. */
  value: string;
  /** A keystroke, a paste, a clear — anything the person typed. */
  onValueChange: (value: string) => void;
  /**
   * A row was committed, by pointer or by <kbd>Enter</kbd>.
   *
   * Separate from {@link onValueChange} because a row can mean more than the
   * text it puts in the box: the call node writes a version from it as well as
   * a name, and it must write both in one update.
   */
  onSelect?: (option: ComboOption) => void;
  options: ComboOption[];
  /** Shown when the query matches nothing. Not optional in spirit: an empty popup is a dead end. */
  emptyMessage?: ReactNode;
  placeholder?: string;
  disabled?: boolean;
  /**
   * The accessible name, for a bare combobox with no `<label>` around it.
   * {@link ComboboxField} wraps one in a real label instead, and leaves this off.
   */
  ariaLabel?: string;
  className?: string;
}

export function Combobox({
  value,
  onValueChange,
  onSelect,
  options,
  emptyMessage = 'Nothing here matches that.',
  placeholder,
  disabled,
  ariaLabel,
  className,
}: ComboboxProps) {
  /**
   * The query, which is NOT the value.
   *
   * `undefined` means "nothing has been typed since this opened", and the whole
   * list shows. That distinction is the difference between a usable field and
   * an infuriating one: the box holds a committed value, so filtering by it
   * would open the popup onto the single row somebody already chose, and the
   * only way to see the other versions would be to delete what is there.
   */
  const [query, setQuery] = useState<string | undefined>(undefined);
  const filtered = query === undefined ? options : options.filter((o) => matches(o, query));

  return (
    <Autocomplete.Root
      // `items` is what `Autocomplete.Empty` counts, and `filteredItems` is
      // what the list navigates. Both are given the SAME array, because the
      // filtering above is ours: Base UI's own is a collator over the label,
      // and it cannot see `keywords`.
      items={filtered}
      filteredItems={filtered}
      value={value}
      onValueChange={(next, details) => {
        // See the docblock: Base UI fills the input on an item press, and that
        // arrives here as though somebody had typed it. `onSelect` has already
        // told the caller, in full, what the row meant.
        if (details.reason === 'item-press') return;
        setQuery(next);
        onValueChange(next);
      }}
      // Re-arm the "show everything" state on open AND on close, so the next
      // opening is not still filtered by the last thing typed into it.
      onOpenChange={() => setQuery(undefined)}
      openOnInputClick
      disabled={disabled}
    >
      <div className={cn('relative', className)}>
        <Autocomplete.Input
          aria-label={ariaLabel}
          placeholder={placeholder}
          spellCheck={false}
          className={CONTROL}
        />
        <Autocomplete.Icon className="pointer-events-none absolute inset-y-0 right-2 flex items-center">
          <ChevronsUpDown size={12} className="shrink-0 text-zinc-400" />
        </Autocomplete.Icon>
      </div>

      <Autocomplete.Portal>
        <Autocomplete.Positioner sideOffset={4} className="z-50">
          <Autocomplete.Popup
            className={cn(
              'max-h-72 w-[var(--anchor-width)] overflow-y-auto rounded-md border p-1 shadow-md',
              'border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900',
              // The house animation, and then the fallback. `motion-reduce` is
              // the ceiling for people who asked for less, not for everyone.
              'origin-[var(--transform-origin)] transition-[opacity,transform] duration-100 ease-out',
              'data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
              'data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
              'motion-reduce:transition-none motion-reduce:data-[starting-style]:scale-100 motion-reduce:data-[ending-style]:scale-100',
            )}
          >
            {/* Base UI asks that this element stay mounted so screen readers
                announce the change — hence the message inside it going empty
                rather than the element going away. */}
            <Autocomplete.Empty className="px-2 py-1.5 text-[11px] leading-relaxed text-zinc-400 dark:text-zinc-500">
              {filtered.length === 0 ? emptyMessage : null}
            </Autocomplete.Empty>
            <Autocomplete.List>
              {filtered.map((option) => (
                <Autocomplete.Item
                  key={option.value}
                  value={option}
                  disabled={option.disabled}
                  onClick={() => {
                    // The rendering says a row is disabled; this says it again
                    // at the moment of commit. A `disabled` attribute is a
                    // rendering decision and the rule about what may be
                    // committed is not one.
                    if (option.disabled) return;
                    onSelect?.(option);
                  }}
                  className={cn(
                    'flex cursor-default items-start gap-2 rounded-sm px-2 py-1.5 text-xs outline-none',
                    'data-[highlighted]:bg-zinc-100 dark:data-[highlighted]:bg-zinc-800',
                    'data-[disabled]:opacity-40',
                  )}
                >
                  <span className="mt-0.5 w-3 shrink-0">
                    {/* Never on a row that cannot be chosen, however exactly the
                        strings line up: a tick beside a refused row reads as
                        "this is what you have", which is the one thing it is
                        not. */}
                    {option.value === value && !option.disabled && (
                      <Check size={11} className="text-sky-600" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    {/* `title` because the label truncates and these are dotted,
                        namespaced names whose distinguishing half is at the
                        END — `billing.reconcile.nightly` and
                        `billing.reconcile.hourly` truncate to the same string. */}
                    <span className="block truncate" title={option.label}>
                      {option.label}
                    </span>
                    {option.hint && (
                      <span className="mt-0.5 block truncate font-mono text-[10px] text-zinc-400 dark:text-zinc-500">
                        {option.hint}
                      </span>
                    )}
                  </span>
                </Autocomplete.Item>
              ))}
            </Autocomplete.List>
          </Autocomplete.Popup>
        </Autocomplete.Positioner>
      </Autocomplete.Portal>
    </Autocomplete.Root>
  );
}

/**
 * Case-insensitive substring, over the label and whatever else the row said to
 * search.
 *
 * Substring rather than prefix on purpose: workflow names are dotted and
 * namespaced, and somebody looking for `billing.reconcile` types `reconcile`
 * about as often as they type `billing`.
 */
function matches(option: ComboOption, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  const haystack = `${option.label} ${option.keywords ?? ''}`.toLowerCase();
  return haystack.includes(needle);
}

/**
 * A {@link Combobox} with a label above it, matching `TextField` — and a real
 * `<label>`, because unlike `Select` this renders an `<input>` and a label
 * therefore names it natively.
 */
export function ComboboxField({
  label,
  hint,
  ...props
}: Omit<ComboboxProps, 'ariaLabel'> & {
  label: string;
  hint?: ReactNode;
}) {
  return (
    // `Combobox` renders a real `<input>`, so wrapping it names it natively and
    // no `aria-label` is needed — unlike `SelectField`, whose control is a
    // button. Biome cannot see the input through the component boundary.
    // biome-ignore lint/a11y/noLabelWithoutControl: see above
    <label className="block">
      <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-400 dark:text-zinc-500">
        {label}
      </span>
      <Combobox {...props} />
      {hint && (
        <span className="mt-1 block text-[11px] leading-relaxed text-zinc-400 dark:text-zinc-500">
          {hint}
        </span>
      )}
    </label>
  );
}
