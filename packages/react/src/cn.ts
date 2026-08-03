import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * The shadcn/ui `cn`, matching what a host that already uses shadcn expects.
 *
 * tailwind-merge earns its place the moment a consumer passes `className` to
 * override padding or colour: without it their class and ours both survive into
 * the DOM and the winner is whichever Tailwind emitted last, which is not
 * something a caller can reason about.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
