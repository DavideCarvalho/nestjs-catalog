import { Tabs as BaseTabs } from '@base-ui/react/tabs';
import type { ReactNode, Ref } from 'react';
import { cn } from '../cn';

/**
 * Tabs, vendored in the shadcn style on Base UI.
 *
 * The screens used to switch on a `useState` string and render buttons by hand,
 * which looks the same and is not the same: hand-rolled tabs are a row of
 * buttons as far as a screen reader is concerned, with no arrow-key movement
 * between them and no relationship to the panel they reveal. Base UI's Tabs
 * carries the roving tabindex and the `aria-controls` wiring, and costs a
 * wrapper.
 */
export function Tabs({
  value,
  onValueChange,
  children,
  className,
}: {
  value: string;
  onValueChange: (value: string) => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <BaseTabs.Root
      value={value}
      // Same narrowing as the select, for the same reason: Base UI allows any
      // value on a tab, including `null` for "no tab active", and this package
      // only ever names them with strings.
      onValueChange={(next) => {
        if (typeof next === 'string') onValueChange(next);
      }}
      className={className}
    >
      {children}
    </BaseTabs.Root>
  );
}

export function TabsList({
  children,
  className,
  ref,
}: {
  children: ReactNode;
  className?: string;
  /**
   * For a caller that has to MEASURE the list — a strip narrow enough to
   * scroll needs to know how far it has scrolled to say so.
   */
  ref?: Ref<HTMLDivElement>;
}) {
  return (
    <BaseTabs.List
      ref={ref}
      className={cn('flex gap-1 border-b border-zinc-200 dark:border-zinc-800', className)}
    >
      {children}
    </BaseTabs.List>
  );
}

export function TabsTab({
  value,
  children,
  className,
  ref,
}: {
  value: string;
  children: ReactNode;
  /** For a caller whose strip has its own metrics — the console nav is taller. */
  className?: string;
  /**
   * For a caller that has to bring the selected tab into view.
   *
   * Worth the prop rather than letting the caller render a marker element
   * inside the tab: a zero-size `sr-only` marker is `position: absolute`, which
   * escapes the strip's `overflow-x` clipping and reports the strip's full
   * scroll extent as the DOCUMENT's width. The page then scrolls sideways —
   * which is the bug this scrolling was introduced to fix.
   */
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <BaseTabs.Tab
      ref={ref}
      value={value}
      className={cn(
        'flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors outline-none',
        'border-transparent text-zinc-500',
        'hover:text-zinc-950 dark:hover:text-zinc-50',
        'focus-visible:ring-2 focus-visible:ring-sky-500/30',
        'data-[selected]:border-sky-600 data-[selected]:text-zinc-950',
        'dark:data-[selected]:text-zinc-50',
        className,
      )}
    >
      {children}
    </BaseTabs.Tab>
  );
}

export function TabsPanel({
  value,
  children,
  className,
}: {
  value: string;
  children: ReactNode;
  className?: string;
}) {
  // Not `keepMounted`: a panel holding a half-typed connector form should keep
  // its draft when somebody looks at another tab, but these panels each own a
  // query of their own, and keeping them all mounted means every tab polls for
  // the whole time the screen is open.
  return (
    <BaseTabs.Panel value={value} className={cn('outline-none', className)}>
      {children}
    </BaseTabs.Panel>
  );
}
