import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { cn } from '../cn';

/**
 * Button, vendored in the shadcn style.
 *
 * Hand-rolled variants rather than `class-variance-authority`, matching how the
 * rest of `ui/` is vendored here: this package already declines the dependency
 * for `select`, `tabs` and `dialog`, and a lookup table is what cva would
 * compile to for a component with no compound variants.
 *
 * What this buys over a `<button>` with classes is the part nobody remembers to
 * write by hand every time: a real focus ring, `disabled` that also stops
 * pointer events, and one place where "what a secondary button looks like"
 * lives. Sixty of those decisions made independently is how a console ends up
 * with four greys.
 */
export type ButtonVariant = 'default' | 'secondary' | 'outline' | 'ghost' | 'destructive';
export type ButtonSize = 'sm' | 'md' | 'icon';

const BASE = cn(
  'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md',
  'font-medium transition-colors outline-none',
  'focus-visible:ring-2 focus-visible:ring-sky-500/40',
  // Both, and deliberately: `disabled` alone still fires hover styles and still
  // shows a pointer, so a dead button looks alive right up until it is clicked.
  'disabled:pointer-events-none disabled:opacity-50',
);

const VARIANTS: Record<ButtonVariant, string> = {
  default: cn(
    'bg-sky-600 text-white hover:bg-sky-500',
    'dark:bg-sky-500 dark:text-zinc-950 dark:hover:bg-sky-400',
  ),
  secondary: cn(
    'bg-zinc-100 text-zinc-900 hover:bg-zinc-200',
    'dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700',
  ),
  outline: cn(
    'border border-zinc-200 bg-white text-zinc-900 hover:bg-zinc-50',
    'dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800',
  ),
  ghost: cn(
    'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-950',
    'dark:hover:bg-zinc-800 dark:hover:text-zinc-50',
  ),
  // Not red text on a ghost: a destructive action should be identifiable
  // before the pointer reaches it, not on hover.
  destructive: cn(
    'bg-rose-600 text-white hover:bg-rose-500',
    'dark:bg-rose-600 dark:hover:bg-rose-500',
  ),
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-7 px-2 text-xs',
  md: 'h-9 px-3 text-sm',
  // Square, so a lone icon is not a lopsided rectangle and a row of them lines
  // up with the text inputs beside it.
  icon: 'h-7 w-7 p-0',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({
  variant = 'default',
  size = 'md',
  className,
  // Defaulted, because the HTML default is `submit`: a button inside any form
  // that forgets this submits it, and the symptom is a page that reloads
  // instead of doing the thing.
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(BASE, VARIANTS[variant], SIZES[size], className)}
      {...props}
    />
  );
}
