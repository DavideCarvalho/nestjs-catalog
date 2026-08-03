import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../cn';

/**
 * A confirmation dialog, vendored in the shadcn style on Base UI.
 *
 * This exists because the screens that moved into this package deleted things
 * on a single click of an unlabelled icon. Deleting a transform takes the code
 * a load runs; deleting a connection takes the address every connector reading
 * through it depends on. Neither is recoverable from this console, and neither
 * asked.
 *
 * Purpose-built rather than a set of exported parts, because the only dialog
 * these screens need is "are you sure, and here is what you would break", and a
 * generic Dialog would have every call site rebuild that.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
  pending,
  error,
  /** Set for anything unrecoverable. Colours the action, and nothing else. */
  destructive = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  pending?: boolean;
  error?: ReactNode;
  destructive?: boolean;
}) {
  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop
          className={cn(
            'fixed inset-0 z-50 bg-zinc-950/30 backdrop-blur-[1px] dark:bg-zinc-950/60',
            'transition-opacity duration-150',
            'data-[starting-style]:opacity-0 data-[ending-style]:opacity-0',
          )}
        />
        <BaseDialog.Popup
          className={cn(
            'fixed left-1/2 top-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2',
            'rounded-lg border p-5 shadow-lg outline-none',
            'border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900',
            'transition-[opacity,transform] duration-150 ease-out',
            'data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
            'data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
          )}
        >
          <BaseDialog.Title className="text-sm font-semibold tracking-tight">
            {title}
          </BaseDialog.Title>
          <BaseDialog.Description className="mt-1.5 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
            {description}
          </BaseDialog.Description>

          {error && (
            <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-[11px] text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
              {error}
            </p>
          )}

          <div className="mt-5 flex justify-end gap-2">
            <BaseDialog.Close
              className={cn(
                'rounded-md border px-3 py-1.5 text-xs',
                'border-zinc-200 hover:bg-zinc-50',
                'dark:border-zinc-800 dark:hover:bg-zinc-800',
              )}
            >
              Cancel
            </BaseDialog.Close>
            <button
              type="button"
              onClick={onConfirm}
              disabled={pending}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs text-white disabled:opacity-40',
                destructive
                  ? 'bg-red-600 hover:bg-red-700'
                  : 'bg-zinc-950 hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-950',
              )}
            >
              {pending && <Loader2 size={12} className="animate-spin" />}
              {confirmLabel}
            </button>
          </div>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
