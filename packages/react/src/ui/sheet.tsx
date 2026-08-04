import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../cn';
import { Tooltip } from './tooltip';

/**
 * A panel that slides in from the right, on Base UI's Dialog.
 *
 * This exists for one reason: the workflow canvas has to open an inspector, and
 * a code editor, *without unmounting the canvas*. Everything a person has done
 * since the last save — node positions, a half-drawn branch, the viewport they
 * panned to — lives in the canvas's own state, and swapping the canvas out for
 * an editor and back loses all of it. Rendering the editor over the canvas
 * keeps it mounted and keeps that state.
 *
 * On a Dialog rather than a plain absolutely-positioned div, because the free
 * parts are the ones that are laborious to get right and easy to skip: focus
 * moves into the panel when it opens and returns to whatever opened it when it
 * closes, Escape closes it, focus cannot Tab out into the canvas behind, and
 * the whole thing is announced as a dialog.
 *
 * That last point is the one worth spelling out. A hand-rolled panel floating
 * over a canvas leaks focus the other way: Tab walks out of the panel and onto
 * graph nodes that are visually behind it, so a keyboard user ends up operating
 * something they cannot see and did not open. Both variants here are therefore
 * modal by default — keeping the canvas *mounted* is what preserves unsaved
 * positions and the viewport, and that has nothing to do with keeping it
 * reachable while a form is open on top of it.
 *
 * `modal` remains a prop for the case where a caller genuinely wants the
 * background operable, but nothing in this package passes false.
 */
export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  width = 'narrow',
  modal = true,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  /** `wide` is for the code editor, which needs two columns to be usable. */
  width?: 'narrow' | 'wide';
  modal?: boolean;
  children: ReactNode;
}) {
  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange} modal={modal}>
      <BaseDialog.Portal>
        {modal && (
          <BaseDialog.Backdrop
            className={cn(
              'fixed inset-0 z-40 bg-zinc-950/20 dark:bg-zinc-950/50',
              'transition-opacity duration-150',
              'data-[starting-style]:opacity-0 data-[ending-style]:opacity-0',
            )}
          />
        )}
        <BaseDialog.Popup
          className={cn(
            'fixed inset-y-0 right-0 z-50 flex flex-col border-l shadow-xl outline-none',
            'border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900',
            width === 'wide'
              ? 'w-[min(64rem,calc(100vw-2rem))]'
              : 'w-[min(24rem,calc(100vw-2rem))]',
            'transition-transform duration-200 ease-out',
            'data-[starting-style]:translate-x-full data-[ending-style]:translate-x-full',
          )}
        >
          <div className="flex items-start gap-3 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
            <div className="min-w-0 flex-1">
              <BaseDialog.Title className="truncate text-sm font-semibold tracking-tight">
                {title}
              </BaseDialog.Title>
              {description && (
                <BaseDialog.Description className="mt-0.5 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                  {description}
                </BaseDialog.Description>
              )}
            </div>
            {/* An icon-only control, so it carries both a tooltip for a sighted
                pointer user and an accessible name for everybody else. */}
            <Tooltip content="Close (Esc)">
              <BaseDialog.Close
                aria-label="Close"
                className={cn(
                  'rounded-md p-1 text-zinc-400 outline-none',
                  'hover:bg-zinc-100 hover:text-zinc-900',
                  'focus-visible:ring-2 focus-visible:ring-sky-500/30',
                  'dark:hover:bg-zinc-800 dark:hover:text-zinc-100',
                )}
              >
                <X size={14} />
              </BaseDialog.Close>
            </Tooltip>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
