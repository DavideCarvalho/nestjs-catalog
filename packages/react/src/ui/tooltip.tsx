import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip';
import { type ReactNode, isValidElement } from 'react';
import { cn } from '../cn';

/**
 * The shadcn/ui tooltip, vendored, on Base UI.
 *
 * Vendored rather than imported because that is what shadcn is: components you
 * own, not a dependency you take. A host already using shadcn gets something
 * that looks and behaves like the rest of their app; one that is not gets an
 * accessible primitive and some Tailwind, with nothing to configure either way.
 *
 * Base UI rather than Radix because that is where shadcn's primitives are
 * going, and running one generation behind in a library other people install
 * means every host inherits the migration rather than us doing it once.
 *
 * The package is `@base-ui/react`. The older `@base-ui-components/react` name is
 * deprecated on npm and its last release under that name is a release candidate,
 * so pinning it would have shipped an RC of an abandoned name — worth stating
 * here because the two look interchangeable in a search result and only one of
 * them is maintained. Everything Base-UI-shaped in this package goes through
 * these wrappers, so when its API moves, it moves here and nowhere else.
 *
 * The exported surface is deliberately identical to the Radix version it
 * replaced — `Tooltip` and `TooltipProvider`, same props — because every screen
 * in this package and in the consuming app imports it, and a primitive swap that
 * forces call sites to change is a primitive swap nobody performs.
 */
export function TooltipProvider({
  children,
  delay = 200,
  closeDelay = 0,
}: {
  children: ReactNode;
  /** Shared open delay. A per-tooltip `delay` still wins over this. */
  delay?: number;
  closeDelay?: number;
}) {
  return (
    <BaseTooltip.Provider delay={delay} closeDelay={closeDelay}>
      {children}
    </BaseTooltip.Provider>
  );
}

export function Tooltip({
  children,
  content,
  side = 'top',
  delay = 200,
}: {
  children: ReactNode;
  content: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  delay?: number;
}) {
  if (!content) return <>{children}</>;

  return (
    <BaseTooltip.Root>
      {/*
       * Base UI has no `asChild`. Its equivalent is `render`, which takes the
       * element to render *as* — but only an element, so a caller passing a
       * string or a fragment has to fall through to the default `<button>`.
       *
       * Checked at runtime rather than asserted, because the failure is silent
       * and awful otherwise: handing `render` a non-element makes Base UI throw
       * during render, and the tooltip that took down the page is the one on a
       * control somebody wrapped a bare string in.
       *
       * The explicit type argument is what lets the narrowed element satisfy
       * `render`'s prop type, which expects an element whose props are indexable.
       */}
      {isValidElement<Record<string, unknown>>(children) ? (
        <BaseTooltip.Trigger delay={delay} render={children} />
      ) : (
        <BaseTooltip.Trigger delay={delay}>{children}</BaseTooltip.Trigger>
      )}
      <BaseTooltip.Portal>
        {/*
         * Positioning lives on the Positioner, not on the popup — this is the
         * part of the Base UI anatomy with no Radix counterpart. Putting `side`
         * on the popup, as the Radix version did, silently does nothing: the
         * tooltip still renders, still reads correctly, and simply ignores where
         * you asked it to go.
         */}
        <BaseTooltip.Positioner side={side} sideOffset={6} className="z-50">
          <BaseTooltip.Popup
            className={cn(
              'max-w-xs rounded-md border border-zinc-200 bg-white px-2.5 py-1.5',
              'text-xs leading-snug text-zinc-700 shadow-md',
              'dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200',
              // Plain transition utilities driven by Base UI's own data
              // attributes, rather than the `animate-in` classes the Radix
              // version used. Those come from the `tailwindcss-animate` plugin,
              // which is a line in the host's Tailwind config — and a component
              // library that silently needs a plugin renders unstyled in half
              // the apps that install it.
              'origin-[var(--transform-origin)] transition-[opacity,transform] duration-100 ease-out',
              'data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
              'data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
              'data-[instant]:duration-0',
            )}
          >
            {/*
             * Base UI's Arrow is a positioned `<div>` with nothing inside it,
             * where Radix's drew its own triangle. The SVG is ours, and the
             * per-side rotation has to be ours too, because the element is
             * placed by the positioner but not turned to face the popup.
             */}
            <BaseTooltip.Arrow
              className={cn(
                'data-[side=bottom]:top-[-6px] data-[side=bottom]:rotate-180',
                'data-[side=top]:bottom-[-6px]',
                'data-[side=left]:right-[-9px] data-[side=left]:-rotate-90',
                'data-[side=right]:left-[-9px] data-[side=right]:rotate-90',
              )}
            >
              <svg
                width="12"
                height="6"
                viewBox="0 0 12 6"
                aria-hidden
                className="block fill-white stroke-zinc-200 dark:fill-zinc-900 dark:stroke-zinc-800"
              >
                <title>·</title>
                <path d="M0 0 L6 6 L12 0" />
              </svg>
            </BaseTooltip.Arrow>
            {content}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}
