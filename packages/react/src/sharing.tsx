import { Lock, Share2 } from 'lucide-react';
import { cn } from './cn';
import { Button } from './ui/button';

const MUTED = 'text-zinc-400 dark:text-zinc-500';
const RULE = 'border-zinc-200 dark:border-zinc-800';

/**
 * Handing something to an application this catalog does not own.
 *
 * The copy and the control live together, in one module, because there are two
 * surfaces that perform this act — a dashboard's header and a saved query's row
 * — and the sentence describing what sharing MEANS has to be the same sentence
 * in both. Two hand-written versions drift, and the one that drifts is the one
 * somebody read before clicking.
 *
 * WHY THIS IS NOT A SWITCH
 * ------------------------
 * `ui/switch.tsx` exists and would have been one line. It is the wrong control
 * here, for a reason that is specific rather than aesthetic: a switch says
 * "setting", flips on a single click, and distinguishes its two states by the
 * position of a knob. `shared` is not a setting — it is the entire access
 * boundary of the embed API, and the server treats crossing it as an event
 * worth recording, in both directions and including by deletion (see the
 * sharing block in `catalog.service.ts`). A control for an audited act should
 * state where you are before it offers to move you: the badge is the state, the
 * sentence is what the state means for whoever else can reach this, and the
 * button names the transition rather than merely inverting a boolean.
 *
 * Both directions, everywhere. `shared` used to be settable only when a query
 * was first saved, which made a mistaken share a one-way door — the flag was
 * reachable from no screen afterwards, so the only way back was deleting the
 * query. A grant you cannot revoke from the console is worse than one you
 * cannot make there.
 */
export type ShareableKind = 'dashboard' | 'query';

/**
 * What the current state means, in the terms the server enforces it in.
 *
 * Named scopes rather than "other apps", because `catalog:embed` is the actual
 * boundary and it is what an operator would have to go and look at. "Other
 * apps" reads as "apps you have already integrated"; the truth is anything
 * holding that scope, which may be more than the person clicking has in mind.
 */
export function shareStatement(kind: ShareableKind, shared: boolean): string {
  if (kind === 'dashboard') {
    return shared
      ? 'Shared — any application with catalog:embed can fetch this board, and every shared query on it.'
      : 'Private — the embed API refuses this board. It exists only inside this console.';
  }
  return shared
    ? 'Shared — any application with catalog:embed can fetch these rows, here or as a card on a shared board.'
    : 'Private — the embed API refuses this query, and a card built on it is left out of a shared board.';
}

/** The transition, as a verb phrase. The button's whole job is to name it. */
export function shareActionLabel(kind: ShareableKind, shared: boolean): string {
  return shared ? `Stop sharing this ${kind}` : `Share this ${kind}`;
}

/**
 * The state, at a glance.
 *
 * Rendered even when private, in the panel layout: "no badge" would leave the
 * reader deducing the state from the absence of a mark, and a board nobody
 * shared and a board whose state has not loaded look identical that way. In a
 * dense list the private badge is dropped — see {@link ShareControl} — because
 * there the absence is the common case rather than an answer.
 */
export function ShareBadge({ shared, className }: { shared: boolean; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5',
        'font-mono text-[10px] uppercase tracking-[0.12em]',
        shared
          ? 'bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300'
          : cn('border', RULE, MUTED),
        className,
      )}
    >
      {shared ? <Share2 size={10} /> : <Lock size={10} />}
      {shared ? 'Shared' : 'Private'}
    </span>
  );
}

export interface ShareControlProps {
  kind: ShareableKind;
  shared: boolean;
  /** Performs the transition. The control never assumes it succeeded. */
  onChange: (shared: boolean) => void;
  /** In flight. Disables the button rather than hiding it, so the row stays put. */
  pending?: boolean;
  /**
   * A refusal, shown beside the control.
   *
   * Sharing is the one action in this console whose failure is invisible from
   * its own result: the board looks the same, and the person walks away
   * believing an outside application can now reach it. So a rejected write says
   * so here rather than only in the network tab.
   */
  error?: unknown;
  /** Names the thing, for the accessible label of a control in a list of them. */
  name?: string;
  /**
   * `'panel'` — badge, sentence and button on one bordered row, for a screen
   * with room for it. `'row'` — the button alone, for a dense list where the
   * badge is rendered separately beside the item's name and the sentence
   * arrives as the button's `title`.
   */
  layout?: 'panel' | 'row';
  className?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The change was refused.';
}

export function ShareControl({
  kind,
  shared,
  onChange,
  pending = false,
  error,
  name,
  layout = 'panel',
  className,
}: ShareControlProps) {
  const statement = shareStatement(kind, shared);
  const action = shareActionLabel(kind, shared);
  // The label carries the item's name in a list, because a screen reader
  // reaching the fourth "Stop sharing this query" of a list has been told
  // nothing about which query it would stop sharing.
  const label = name ? `${action}: ${name}` : action;

  if (layout === 'row') {
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => onChange(!shared)}
        disabled={pending}
        aria-label={label}
        // Both, and they say different things: the accessible name is the
        // ACTION, the title is the CONSEQUENCE. A tooltip is deliberately not
        // used — `ui/tooltip` needs a provider above it, and this panel is
        // mounted by hosts that may not have one.
        title={`${statement} ${action}.`}
        className={cn('px-1.5 font-mono text-[10px] uppercase tracking-[0.12em]', className)}
      >
        {shared ? 'Unshare' : 'Share'}
      </Button>
    );
  }

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <div className={cn('flex items-center gap-3 rounded-lg border px-3 py-2', RULE)}>
        <ShareBadge shared={shared} />
        <p className={cn('min-w-0 flex-1 text-[11px]', MUTED)}>{statement}</p>
        <Button
          // Sharing is the louder half of the pair, so it is the accented
          // button and un-sharing is the quiet one. Neither is destructive:
          // `destructive` is reserved for what cannot be undone, and both of
          // these are one click from being undone.
          variant={shared ? 'outline' : 'default'}
          size="sm"
          onClick={() => onChange(!shared)}
          disabled={pending}
          aria-label={label}
        >
          {action}
        </Button>
      </div>
      {error !== undefined && error !== null && (
        <p className="text-[11px] text-red-600">{errorMessage(error)}</p>
      )}
    </div>
  );
}
